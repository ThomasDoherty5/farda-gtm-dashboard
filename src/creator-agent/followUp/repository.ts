import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { reference } from "../actions/contract.ts";
import type { OperationsScope } from "../operations.ts";
import { closureEvidenceSchema, FOLLOW_UP_POLICY_VERSION, followUpConfigSchema, outreachStateSchema, postingClockEventSchema, rightsGateInputSchema,
  sendOutcomeSchema, workflowHandoffSchema, type ClosureReason, type SendPath, type WorkflowHandoff, type WorkflowOutcome, workflowOutcomeSchema, workflowRequestKeyOf, type FollowUpConfig, type FollowUpIntent, type FollowUpStep, type IntentState, type SendOutcome,
  type StoredIntent, type SupersededBy } from "./contract.ts";
import { decideClosure, decideReminder, dedupeKeyOf, localDay, type ReminderDecision, type ReminderInput } from "./policy.ts";
import { applyReviewEvent, initialReviewState, type ReviewEvent, type ReviewState } from "./reviewMachine.ts";
import { evaluatePaidReuse, type RightsGateResult } from "./rightsGate.ts";

export class FollowUpError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
export type Proposal = { intent: StoredIntent; created: boolean };
export type PlanReceipt = { decision: ReminderDecision; proposals: Proposal[] };
export type ClosureRecord = { collaborationId: string; reason: ClosureReason; evidenceRef: string; reasonCodes: string[]; closedAt: string };
export type RightsReceipt = { gate: RightsGateResult; proposal: Proposal | null };
/**
 * Something an operator must settle with the approval owner.
 * - `withdrawnWhileInJ04` / `withdrawnWhileInWorkflow`: this module withdrew an intent that J04, or the collaboration
 *   workflow, was already holding. The approval, proposal or run still needs cancelling by its owner.
 * - `withdrawnWhileUncertain`: this module withdrew an intent whose send or handoff outcome was not yet known.
 * - `outreachUnverifiedWhileLive`: outreach eligibility became unknown while a creator message was live there.
 * - `lateOutcome`: an outcome arrived for a withdrawn intent; it is kept, never applied.
 */
export type ConflictKind = "withdrawnWhileInJ04" | "withdrawnWhileInWorkflow" | "withdrawnWhileUncertain" | "outreachUnverifiedWhileLive" | "lateOutcome";
export type OutcomeConflict = { conflictRef: string; kind: ConflictKind; intentRef: string; collaborationId: string;
  outcome: SendOutcome | WorkflowHandoff | WorkflowOutcome | null; intentState: IntentState; blocking: boolean; recordedAt: string; resolvedAt: string | null; resolvedBy: string | null };
export type OutcomeReceipt = { state: "recorded"; intent: StoredIntent } | { state: "conflict"; intent: StoredIntent; conflict: OutcomeConflict };

const planInputSchema = z.object({ event: postingClockEventSchema.nullable(), collaborationId: reference, outreach: outreachStateSchema, postedVerified: z.boolean() }).strict()
  .refine(v => !v.event || v.event.collaborationId === v.collaborationId, "Event belongs to another collaboration.");
const reviewEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submitted"), contentVersion: reference, sourceRef: reference }).strict(),
  z.object({ type: z.literal("decided"), contentVersion: reference, outcome: z.enum(["approved", "revisionRequested", "rejected"]), reviewerRef: reference }).strict(),
]);
/** Not yet sent or uncertain: these can still be withdrawn locally. Withdrawing does not cancel anything held elsewhere. */
const WITHDRAWABLE: IntentState[] = ["proposed", "awaitingApproval", "approvalHeld", "dispatched", "handingOff", "handedOff", "workflowApproved", "uncertain"];
/**
 * Where an intent may still be approved or run after it is withdrawn here. A J04 hold is not terminal and can
 * resume, so a held approval with a reference is live; a hold that never reached J04 is not.
 */
export function liveElsewhere(intent: StoredIntent): "j04" | "workflow" | "uncertain" | null {
  if (intent.state === "uncertain") return "uncertain";
  if (intent.state === "awaitingApproval" || intent.state === "dispatched" || intent.state === "approvalHeld" && intent.approvalRef !== null) return "j04";
  // A reserved handoff counts from before its submission, so a withdrawal during submission is never silent.
  return intent.state === "handingOff" || intent.state === "handedOff" || intent.state === "workflowApproved" ? "workflow" : null;
}
const WITHDRAWN_CONFLICT = { j04: "withdrawnWhileInJ04", workflow: "withdrawnWhileInWorkflow", uncertain: "withdrawnWhileUncertain" } as const;
const SEND_PATH: Record<FollowUpStep, SendPath> = { "due-minus-2": "j04Preview", "within-grace": "j04Preview", "post-grace": "workflowReminder",
  "past-grace": "workflowHandoff", "rights-expiry-warning": "workflowHandoff" };
const NEXT_STATE: Record<SendOutcome["kind"], IntentState> = { approvalRecorded: "awaitingApproval", approvalHeld: "approvalHeld",
  dispatchPending: "dispatched", sent: "sent", notSent: "notSent", uncertain: "uncertain" };
const ALLOWED_FROM: Record<SendOutcome["kind"], IntentState[]> = {
  approvalRecorded: ["proposed", "awaitingApproval", "approvalHeld"],
  approvalHeld: ["proposed", "awaitingApproval", "approvalHeld"],
  dispatchPending: ["proposed", "awaitingApproval", "dispatched"],
  sent: ["proposed", "awaitingApproval", "dispatched", "uncertain"],
  notSent: ["proposed", "awaitingApproval", "approvalHeld", "dispatched", "uncertain"],
  uncertain: ["proposed", "awaitingApproval", "approvalHeld", "dispatched", "uncertain"],
};

/**
 * Follow-up state on the shared agent SQLite connection. Every mutation runs under BEGIN IMMEDIATE with an
 * idempotency key, and reads the injected clock only after the write lock is held. Proposes intents; never sends.
 */
export class FollowUpRepository {
  private readonly db: DatabaseSync; private readonly scope: OperationsScope;
  private readonly config: FollowUpConfig; private readonly now: () => number;
  constructor(db: DatabaseSync, scope: OperationsScope, config: FollowUpConfig, now: () => number = Date.now) {
    this.db = db; this.scope = scope; this.config = followUpConfigSchema.parse(config); this.now = now;
    const bound = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
    if (!bound || bound.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId || bound.environment !== scope.environment)
      throw new FollowUpError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS creator_follow_up_intents(intent_ref TEXT PRIMARY KEY,collaboration_id TEXT NOT NULL,step TEXT NOT NULL,
        due_version TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(collaboration_id,step,due_version));
      CREATE INDEX IF NOT EXISTS creator_follow_up_intent_state ON creator_follow_up_intents(state,collaboration_id);
      CREATE TABLE IF NOT EXISTS creator_follow_up_reviews(collaboration_id TEXT NOT NULL,deliverable_ref TEXT NOT NULL,revision INTEGER NOT NULL,
        body TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(collaboration_id,deliverable_ref,revision));
      CREATE TABLE IF NOT EXISTS creator_follow_up_closures(collaboration_id TEXT PRIMARY KEY,reason TEXT NOT NULL,body TEXT NOT NULL,closed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creator_follow_up_outcome_conflicts(conflict_ref TEXT PRIMARY KEY,intent_ref TEXT NOT NULL,collaboration_id TEXT NOT NULL,
        blocking INTEGER NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creator_follow_up_requests(request_key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt TEXT NOT NULL);`);
  }

  /** One locked, idempotent write. The clock is read inside the lock, so a waiting writer cannot use a stale time. */
  private once<T>(kind: string, key: string, input: unknown, work: (at: number) => T): T {
    if (!reference.safeParse(key).success) throw new FollowUpError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const requestDigest = digest([this.scope, kind, input]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT request_digest,receipt FROM creator_follow_up_requests WHERE request_key=?").get(key);
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new FollowUpError("IDEMPOTENCY_KEY_REUSED");
        this.db.exec("COMMIT"); return JSON.parse(String(prior.receipt)) as T;
      }
      const at = this.now();
      if (!Number.isFinite(at)) throw new FollowUpError("INVALID_CLOCK", 500);
      const result = work(at);
      this.db.prepare("INSERT INTO creator_follow_up_requests VALUES(?,?,?)").run(key, requestDigest, JSON.stringify(result));
      this.db.exec("COMMIT"); return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  private closureOf(collaborationId: string): ClosureRecord | null {
    const row = this.db.prepare("SELECT body FROM creator_follow_up_closures WHERE collaboration_id=?").get(collaborationId);
    return row ? JSON.parse(String(row.body)) as ClosureRecord : null;
  }
  private reviewOf(collaborationId: string, deliverableRef: string): { state: ReviewState; revision: number } | null {
    const row = this.db.prepare("SELECT body,revision FROM creator_follow_up_reviews WHERE collaboration_id=? AND deliverable_ref=? ORDER BY revision DESC LIMIT 1")
      .get(collaborationId, deliverableRef);
    return row ? { state: JSON.parse(String(row.body)) as ReviewState, revision: Number(row.revision) } : null;
  }
  private intentRow(where: string, ...values: string[]): StoredIntent | null {
    const row = this.db.prepare(`SELECT body FROM creator_follow_up_intents WHERE ${where}`).get(...values);
    return row ? JSON.parse(String(row.body)) as StoredIntent : null;
  }
  private writeIntent(intent: StoredIntent) {
    this.db.prepare("UPDATE creator_follow_up_intents SET state=?,body=?,updated_at=? WHERE intent_ref=?").run(intent.state, JSON.stringify(intent), intent.updatedAt, intent.intentRef);
  }
  /** Holds that apply to any reminder: an open blocking conflict, then an unreconciled send. */
  private priorHold(collaborationId: string): ReminderInput["priorSend"] {
    if (this.db.prepare("SELECT 1 FROM creator_follow_up_outcome_conflicts WHERE collaboration_id=? AND blocking=1 AND resolved=0 LIMIT 1").get(collaborationId)) return "conflict";
    return this.db.prepare("SELECT 1 FROM creator_follow_up_intents WHERE collaboration_id=? AND state='uncertain' LIMIT 1").get(collaborationId) ? "uncertain" : "none";
  }
  /** Creator messages live in J04 or the workflow, other than the ones this decision would propose again. */
  private liveCreatorMessages(collaborationId: string, except?: { dueVersion: string; steps: FollowUpStep[] }): StoredIntent[] {
    return this.intents(collaborationId).filter(i => i.channel === "creator-message" && liveElsewhere(i) !== null &&
      !(except && i.dueVersion === except.dueVersion && except.steps.includes(i.step)));
  }
  private recordConflict(conflict: Omit<OutcomeConflict, "conflictRef" | "resolvedAt" | "resolvedBy">): OutcomeConflict {
    // One open conflict per intent and kind when nothing new arrived with it.
    if (conflict.outcome === null) {
      const open = this.conflicts(conflict.collaborationId).find(c => !c.resolvedAt && c.intentRef === conflict.intentRef && c.kind === conflict.kind);
      if (open) return open;
    }
    const full: OutcomeConflict = { ...conflict, conflictRef: "follow-up-conflict-" + digest([conflict.kind, conflict.intentRef, conflict.outcome, conflict.recordedAt]).slice(0, 32),
      resolvedAt: null, resolvedBy: null };
    this.db.prepare("INSERT INTO creator_follow_up_outcome_conflicts(conflict_ref,intent_ref,collaboration_id,blocking,body,recorded_at) VALUES(?,?,?,?,?,?)")
      .run(full.conflictRef, full.intentRef, full.collaborationId, full.blocking ? 1 : 0, JSON.stringify(full), full.recordedAt);
    return full;
  }
  /** Inserts at most one intent per collaboration, step and due-date version. Returns the existing one otherwise. */
  private propose(collaborationId: string, step: FollowUpStep, dueVersion: string, fields: Pick<FollowUpIntent, "localDay" | "timezone" | "reasonCodes" | "sourceRef">, at: number): Proposal {
    const existing = this.intentRow("collaboration_id=? AND step=? AND due_version=?", collaborationId, step, dueVersion);
    if (existing) return { intent: existing, created: false };
    const createdAt = new Date(at).toISOString(), key = dedupeKeyOf(collaborationId, step, dueVersion);
    const sendPath = SEND_PATH[step], channel = sendPath === "workflowHandoff" ? "human-review" as const : "creator-message" as const;
    const body = { collaborationId, step, dueVersion, channel, sendPath, ...fields, policyVersion: FOLLOW_UP_POLICY_VERSION, sends: false as const };
    const intent: StoredIntent = { intentRef: "follow-up-" + key.slice(0, 40), intentVersion: "fu1-" + digest([this.scope, body]), ...body, createdAt,
      state: "proposed", supersededBy: null, supersededFrom: null, approvalRef: null, manifestRef: null, runRef: null, runVersion: null,
      workflowProposalRef: null, receiptRefs: [], holdReasons: [], updatedAt: createdAt };
    this.db.prepare("INSERT INTO creator_follow_up_intents VALUES(?,?,?,?,?,?,?,?)")
      .run(intent.intentRef, collaborationId, step, dueVersion, intent.state, JSON.stringify(intent), createdAt, createdAt);
    return { intent, created: true };
  }
  /**
   * Withdraws intents that are not sent or uncertain, including those already awaiting approval, held, dispatched or
   * handed to the workflow. Withdrawing one that is live elsewhere opens a blocking conflict, because the approval,
   * proposal or run still needs cancelling by its owner. Later outcomes for withdrawn intents become conflicts too.
   */
  private supersede(collaborationId: string, reason: SupersededBy, select: (intent: StoredIntent) => boolean, at: number) {
    const rows = this.db.prepare(`SELECT body FROM creator_follow_up_intents WHERE collaboration_id=? AND state IN (${WITHDRAWABLE.map(() => "?").join(",")})`)
      .all(collaborationId, ...WITHDRAWABLE);
    for (const row of rows) {
      const intent = JSON.parse(String(row.body)) as StoredIntent;
      if (!select(intent)) continue;
      const updatedAt = new Date(at).toISOString();
      this.writeIntent({ ...intent, state: "superseded", supersededBy: reason, supersededFrom: intent.state, updatedAt });
      const live = liveElsewhere(intent);
      if (live) this.recordConflict({ kind: WITHDRAWN_CONFLICT[live], intentRef: intent.intentRef, collaborationId,
        outcome: null, intentState: intent.state, blocking: true, recordedAt: updatedAt });
    }
  }

  planReminder(raw: unknown, idempotencyKey: string): PlanReceipt {
    if (!this.config.reminderPolicy) throw new FollowUpError("REMINDER_POLICY_UNSET");
    const input = planInputSchema.parse(raw);
    return this.once("planReminder", idempotencyKey, input, at => {
      const id = input.collaborationId;
      if (input.outreach === "suppressed") this.supersede(id, "outreachSuppressed", i => i.channel === "creator-message", at);
      // Unknown eligibility keeps live messages (a lookup failure must not burn the reminder slot) but opens a blocking conflict.
      if (input.outreach === "unknown") for (const intent of this.liveCreatorMessages(id))
        this.recordConflict({ kind: "outreachUnverifiedWhileLive", intentRef: intent.intentRef, collaborationId: id, outcome: null, intentState: intent.state,
          blocking: true, recordedAt: new Date(at).toISOString() });
      const decide = (priorSend = this.priorHold(id), outreach = input.outreach) => decideReminder({ event: input.event, outreach, postedVerified: input.postedVerified,
        closure: this.closureOf(id)?.reason ?? null, priorSend }, this.config, at);
      // The current due-date version, found without the holds, so a held decision still withdraws older versions.
      const first = decide("none", "clear");
      if (first.kind !== "wait" && first.kind !== "remind" && first.kind !== "escalate") return { decision: decide(), proposals: [] };
      const reminder = (i: StoredIntent) => i.step !== "rights-expiry-warning";
      // A changed due date withdraws everything from older versions, then the decision is retaken: a withdrawn
      // message that J04 was already handling holds new creator reminders until an operator settles it.
      this.supersede(id, "dueDateChanged", i => reminder(i) && i.dueVersion !== first.dueVersion, at);
      const stepsOf = (d: ReminderDecision): FollowUpStep[] => d.kind === "remind" ? [d.step] : d.kind === "escalate" ? [d.step, ...(d.reminder ? [d.reminder] : [])] : [];
      let decision = decide();
      // An earlier creator message still awaiting approval, held, dispatched or handed off holds the next step's reminder.
      if ((decision.kind === "remind" || decision.kind === "escalate") &&
        this.liveCreatorMessages(id, { dueVersion: decision.dueVersion, steps: stepsOf(decision) }).length) decision = decide("inFlight");
      if (decision.kind !== "wait" && decision.kind !== "remind" && decision.kind !== "escalate") return { decision, proposals: [] };
      const steps = stepsOf(decision);
      // A later step withdraws only proposals that were never handed to J04.
      this.supersede(id, "stepAdvanced", i => reminder(i) && i.state === "proposed" && !steps.includes(i.step), at);
      const fields = { localDay: decision.localDay, timezone: decision.timezone, reasonCodes: decision.reasonCodes, sourceRef: input.event!.sourceRef };
      const dueVersion = decision.dueVersion;
      const proposals = steps.map(step => this.propose(id, step, dueVersion, fields, at));
      return { decision, proposals };
    });
  }

  /**
   * Records what the actions service reported. An uncertain send leaves only a reconciliation lookup. Any outcome
   * for a withdrawn intent is kept as an operator conflict and never moves that intent.
   */
  recordSendOutcome(raw: unknown, idempotencyKey: string): OutcomeReceipt {
    const outcome = sendOutcomeSchema.parse(raw);
    return this.once("recordSendOutcome", idempotencyKey, outcome, (at): OutcomeReceipt => {
      const intent = this.intentRow("intent_ref=?", outcome.intentRef);
      if (!intent) throw new FollowUpError("RECORD_NOT_FOUND", 404);
      if (intent.sendPath !== "j04Preview") throw new FollowUpError("INTENT_NOT_ON_J04_PATH");
      const recordedAt = new Date(at).toISOString();
      if (intent.state === "superseded") {
        // A late `sent` receipt is real and stays in the audit log, but the withdrawn intent never becomes sent.
        const conflict = this.recordConflict({ kind: "lateOutcome", intentRef: intent.intentRef, collaborationId: intent.collaborationId, outcome,
          intentState: intent.state, blocking: outcome.kind !== "notSent", recordedAt });
        return { state: "conflict", intent, conflict };
      }
      if (intent.state === "sent" || intent.state === "notSent") throw new FollowUpError("INTENT_TERMINAL");
      const value = <K extends "approvalRef" | "manifestRef" | "runRef" | "runVersion">(field: K) => (field in outcome ? (outcome as Record<K, string | null>)[field] : null);
      const bound = (["approvalRef", "manifestRef", "runRef", "runVersion"] as const).every(field => value(field) === null || intent[field] === null || intent[field] === value(field));
      if (!bound) throw new FollowUpError("OUTCOME_BINDING_MISMATCH");
      // Leaving uncertainty needs a reconciled lookup of the same run with a terminal receipt, never a fresh attempt.
      if (intent.state === "uncertain" && outcome.kind !== "uncertain" &&
        (!intent.runRef || value("runRef") !== intent.runRef || !("receiptRefs" in outcome) || !outcome.receiptRefs.length))
        throw new FollowUpError("UNCERTAIN_REQUIRES_RECONCILIATION");
      if (!ALLOWED_FROM[outcome.kind].includes(intent.state)) throw new FollowUpError("OUTCOME_OUT_OF_ORDER");
      const next: StoredIntent = { ...intent, state: NEXT_STATE[outcome.kind],
        approvalRef: value("approvalRef") ?? intent.approvalRef, manifestRef: value("manifestRef") ?? intent.manifestRef,
        runRef: value("runRef") ?? intent.runRef, runVersion: intent.runVersion ?? value("runVersion"),
        holdReasons: outcome.kind === "approvalHeld" ? outcome.reasonCodes : [],
        receiptRefs: "receiptRefs" in outcome ? [...new Set([...intent.receiptRefs, ...outcome.receiptRefs])] : intent.receiptRefs, updatedAt: recordedAt };
      this.writeIntent(next);
      return { state: "recorded", intent: next };
    });
  }

  /**
   * Reserves a workflow-path intent before its proposal is submitted, in its own locked transaction. The intent moves
   * to `handingOff`, which counts as live, so a closure during submission opens a conflict, and a second reservation
   * is refused. A reservation that is never answered is reconciled with the returned key and held for an operator.
   */
  reserveWorkflowHandoff(intentRef: string, idempotencyKey: string): { intent: StoredIntent; requestKey: string } {
    reference.parse(intentRef);
    return this.once("reserveWorkflowHandoff", idempotencyKey, intentRef, at => {
      const intent = this.intentRow("intent_ref=?", intentRef);
      if (!intent) throw new FollowUpError("RECORD_NOT_FOUND", 404);
      if (intent.sendPath === "j04Preview") throw new FollowUpError("INTENT_NOT_ON_WORKFLOW_PATH");
      if (intent.state !== "proposed") throw new FollowUpError(intent.state === "handingOff" ? "INTENT_ALREADY_RESERVED" : "INTENT_NOT_PROPOSED");
      const next: StoredIntent = { ...intent, state: "handingOff", updatedAt: new Date(at).toISOString() };
      this.writeIntent(next);
      return { intent: next, requestKey: workflowRequestKeyOf(intentRef) };
    });
  }

  /**
   * Records the collaboration workflow's answer for a reserved intent. A recorded proposal moves it to `handedOff`;
   * an uncertain answer waits for the workflow's own key lookup. Answers for a withdrawn intent become conflicts.
   */
  recordWorkflowHandoff(raw: unknown, idempotencyKey: string): OutcomeReceipt {
    const handoff = workflowHandoffSchema.parse(raw);
    return this.once("recordWorkflowHandoff", idempotencyKey, handoff, (at): OutcomeReceipt => {
      const intent = this.intentRow("intent_ref=?", handoff.intentRef);
      if (!intent) throw new FollowUpError("RECORD_NOT_FOUND", 404);
      if (intent.sendPath === "j04Preview") throw new FollowUpError("INTENT_NOT_ON_WORKFLOW_PATH");
      const recordedAt = new Date(at).toISOString();
      if (intent.state === "superseded") {
        const conflict = this.recordConflict({ kind: "lateOutcome", intentRef: intent.intentRef, collaborationId: intent.collaborationId,
          outcome: handoff, intentState: intent.state, blocking: handoff.result !== "notApplied", recordedAt });
        return { state: "conflict", intent, conflict };
      }
      if (intent.state === "proposed") throw new FollowUpError("INTENT_NOT_RESERVED");
      if (intent.state !== "handingOff" && intent.state !== "uncertain") throw new FollowUpError("OUTCOME_OUT_OF_ORDER");
      if (intent.workflowProposalRef && handoff.result === "recorded" && handoff.proposalRef !== intent.workflowProposalRef) throw new FollowUpError("OUTCOME_BINDING_MISMATCH");
      const state: IntentState = handoff.result === "recorded" ? "handedOff" : handoff.result === "notApplied" ? "notSent" : "uncertain";
      const next: StoredIntent = { ...intent, state, workflowProposalRef: handoff.result === "recorded" ? handoff.proposalRef : intent.workflowProposalRef, updatedAt: recordedAt };
      this.writeIntent(next);
      return { state: "recorded", intent: next };
    });
  }

  /** Settles a handed-off intent from the workflow's detail read. Approved stays live; rejected and sent are terminal. */
  recordWorkflowOutcome(raw: unknown, idempotencyKey: string): OutcomeReceipt {
    const outcome = workflowOutcomeSchema.parse(raw);
    return this.once("recordWorkflowOutcome", idempotencyKey, outcome, (at): OutcomeReceipt => {
      const intent = this.intentRow("intent_ref=?", outcome.intentRef);
      if (!intent) throw new FollowUpError("RECORD_NOT_FOUND", 404);
      if (intent.sendPath === "j04Preview") throw new FollowUpError("INTENT_NOT_ON_WORKFLOW_PATH");
      const recordedAt = new Date(at).toISOString();
      if (intent.state === "superseded") {
        const conflict = this.recordConflict({ kind: "lateOutcome", intentRef: intent.intentRef, collaborationId: intent.collaborationId,
          outcome, intentState: intent.state, blocking: outcome.result !== "rejected", recordedAt });
        return { state: "conflict", intent, conflict };
      }
      if (intent.state !== "handedOff" && intent.state !== "workflowApproved") throw new FollowUpError("OUTCOME_OUT_OF_ORDER");
      if (outcome.proposalRef !== intent.workflowProposalRef) throw new FollowUpError("OUTCOME_BINDING_MISMATCH");
      const state: IntentState = outcome.result === "approved" ? "workflowApproved" : outcome.result === "rejected" ? "notSent" : "sent";
      const next: StoredIntent = { ...intent, state, updatedAt: recordedAt,
        receiptRefs: outcome.result === "sent" ? [...new Set([...intent.receiptRefs, outcome.receiptRef])] : intent.receiptRefs };
      this.writeIntent(next);
      return { state: "recorded", intent: next };
    });
  }

  resolveConflict(conflictRef: string, operatorRef: string, idempotencyKey: string): OutcomeConflict {
    z.tuple([reference, reference]).parse([conflictRef, operatorRef]);
    return this.once("resolveConflict", idempotencyKey, [conflictRef, operatorRef], at => {
      const row = this.db.prepare("SELECT body FROM creator_follow_up_outcome_conflicts WHERE conflict_ref=?").get(conflictRef);
      if (!row) throw new FollowUpError("RECORD_NOT_FOUND", 404);
      const conflict = JSON.parse(String(row.body)) as OutcomeConflict;
      if (conflict.resolvedAt) throw new FollowUpError("CONFLICT_ALREADY_RESOLVED");
      const resolved = { ...conflict, resolvedAt: new Date(at).toISOString(), resolvedBy: operatorRef };
      this.db.prepare("UPDATE creator_follow_up_outcome_conflicts SET resolved=1,body=? WHERE conflict_ref=?").run(JSON.stringify(resolved), conflictRef);
      return resolved;
    });
  }

  recordReviewEvent(collaborationId: string, deliverableRef: string, raw: unknown, idempotencyKey: string): ReviewState {
    const ids = z.tuple([reference, reference]).parse([collaborationId, deliverableRef]);
    const event: ReviewEvent = reviewEventSchema.parse(raw);
    return this.once("recordReviewEvent", idempotencyKey, [ids, event], at => {
      const current = this.reviewOf(collaborationId, deliverableRef);
      const result = applyReviewEvent(current?.state ?? initialReviewState(deliverableRef), event, new Date(at).toISOString());
      if (!result.ok) throw new FollowUpError(result.code);
      if (result.changed) this.db.prepare("INSERT INTO creator_follow_up_reviews VALUES(?,?,?,?,?)")
        .run(collaborationId, deliverableRef, (current?.revision ?? 0) + 1, JSON.stringify(result.state), new Date(at).toISOString());
      return result.state;
    });
  }

  /** Evaluates paid reuse at the locked clock and raises at most one expiry warning per rights binding. */
  recordRightsCheck(collaborationId: string, raw: unknown, idempotencyKey: string): RightsReceipt {
    reference.parse(collaborationId);
    const input = rightsGateInputSchema.parse(raw);
    return this.once("recordRightsCheck", idempotencyKey, [collaborationId, input], at => {
      const gate = evaluatePaidReuse(input, at, this.config.rightsWarningDays);
      if (!gate.warningKey || this.closureOf(collaborationId)) return { gate, proposal: null };
      const proposal = this.propose(collaborationId, "rights-expiry-warning", gate.warningKey, { localDay: localDay(at, this.config.timezone),
        timezone: this.config.timezone, reasonCodes: ["RIGHTS_EXPIRING"], sourceRef: input.chain[0]?.rights?.evidenceRef ?? input.asset.submission.assetId }, at);
      return { gate, proposal };
    });
  }

  close(collaborationId: string, raw: unknown, idempotencyKey: string, deliverableRef?: string): ClosureRecord {
    reference.parse(collaborationId);
    if (deliverableRef !== undefined) reference.parse(deliverableRef);
    const evidence = closureEvidenceSchema.parse(raw);
    return this.once("close", idempotencyKey, [collaborationId, deliverableRef ?? null, evidence], at => {
      if (this.closureOf(collaborationId)) throw new FollowUpError("FOLLOW_UP_ALREADY_CLOSED");
      const reviewRef = evidence.reason === "posted-verified" ? evidence.delivery.deliverableRef : deliverableRef;
      const review = reviewRef ? this.reviewOf(collaborationId, reviewRef)?.state ?? null : null;
      const decision = decideClosure(collaborationId, evidence, { review, config: this.config, now: at });
      if (decision.state !== "closable") throw new FollowUpError(decision.reasonCodes[0] ?? "CLOSURE_REFUSED", 422);
      const record: ClosureRecord = { collaborationId, reason: decision.reason, evidenceRef: decision.evidenceRef, reasonCodes: decision.reasonCodes, closedAt: new Date(at).toISOString() };
      this.db.prepare("INSERT INTO creator_follow_up_closures VALUES(?,?,?,?)").run(collaborationId, record.reason, JSON.stringify(record), record.closedAt);
      this.supersede(collaborationId, "closure", () => true, at);
      return record;
    });
  }

  intent(intentRef: string) { return this.intentRow("intent_ref=?", intentRef); }
  closure(collaborationId: string) { return this.closureOf(collaborationId); }
  review(collaborationId: string, deliverableRef: string) { return this.reviewOf(collaborationId, deliverableRef)?.state ?? null; }
  intents(collaborationId: string): StoredIntent[] {
    return this.db.prepare("SELECT body FROM creator_follow_up_intents WHERE collaboration_id=? ORDER BY created_at,intent_ref").all(collaborationId)
      .map(row => JSON.parse(String(row.body)) as StoredIntent);
  }
  /** Every outcome conflict for a collaboration, resolved or not. This is the audit log for late outcomes. */
  conflicts(collaborationId: string): OutcomeConflict[] {
    return this.db.prepare("SELECT body FROM creator_follow_up_outcome_conflicts WHERE collaboration_id=? ORDER BY recorded_at,conflict_ref").all(collaborationId)
      .map(row => JSON.parse(String(row.body)) as OutcomeConflict);
  }
  /**
   * Intents whose outcome is unknown, oldest first: uncertain, reserved but unanswered, or withdrawn from either state
   * while its conflict is open. Each needs a reconciliation lookup before anything else happens.
   */
  pendingReconciliation(limit = 50): StoredIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FollowUpError("INVALID_LIST_LIMIT", 422);
    return this.db.prepare(`SELECT i.body FROM creator_follow_up_intents i WHERE i.state IN ('uncertain','handingOff')
        OR i.state='superseded' AND json_extract(i.body,'$.supersededFrom') IN ('uncertain','handingOff')
          AND EXISTS(SELECT 1 FROM creator_follow_up_outcome_conflicts c WHERE c.intent_ref=i.intent_ref AND c.resolved=0)
      ORDER BY i.updated_at,i.intent_ref LIMIT ?`).all(limit).map(row => JSON.parse(String(row.body)) as StoredIntent);
  }
}
