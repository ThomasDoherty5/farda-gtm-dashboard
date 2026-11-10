import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { reference } from "../actions/contract.ts";
import type { OperationsScope } from "../operations.ts";
import { closureEvidenceSchema, FOLLOW_UP_POLICY_VERSION, followUpConfigSchema, outreachStateSchema, postingClockEventSchema, rightsGateInputSchema,
  sendOutcomeSchema, type ClosureReason, type FollowUpConfig, type FollowUpIntent, type FollowUpStep, type IntentState, type SendOutcome,
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
 * Something an operator must settle in J04. `withdrawnWhileInJ04`: this module withdrew an intent that J04 was already
 * approving or running. `lateOutcome`: an outcome arrived for a withdrawn intent; it is kept, never applied.
 */
export type OutcomeConflict = { conflictRef: string; kind: "withdrawnWhileInJ04" | "lateOutcome"; intentRef: string; collaborationId: string;
  outcome: SendOutcome | null; intentState: IntentState; blocking: boolean; recordedAt: string; resolvedAt: string | null; resolvedBy: string | null };
export type OutcomeReceipt = { state: "recorded"; intent: StoredIntent } | { state: "conflict"; intent: StoredIntent; conflict: OutcomeConflict };

const planInputSchema = z.object({ event: postingClockEventSchema.nullable(), collaborationId: reference, outreach: outreachStateSchema, postedVerified: z.boolean() }).strict()
  .refine(v => !v.event || v.event.collaborationId === v.collaborationId, "Event belongs to another collaboration.");
const reviewEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submitted"), contentVersion: reference, sourceRef: reference }).strict(),
  z.object({ type: z.literal("decided"), contentVersion: reference, outcome: z.enum(["approved", "revisionRequested", "rejected"]), reviewerRef: reference }).strict(),
]);
/** Not yet sent or uncertain: these can still be withdrawn locally. Withdrawing does not cancel anything already in J04. */
const WITHDRAWABLE: IntentState[] = ["proposed", "awaitingApproval", "approvalHeld", "dispatched"];
/** States in which J04 may still approve or run the message after it is withdrawn here. */
const LIVE_IN_J04: IntentState[] = ["awaitingApproval", "dispatched"];
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
  /** The strongest hold from earlier creator messages: an open outcome conflict, an unreconciled send, then one in flight. */
  private priorSend(collaborationId: string): ReminderInput["priorSend"] {
    if (this.db.prepare("SELECT 1 FROM creator_follow_up_outcome_conflicts WHERE collaboration_id=? AND blocking=1 AND resolved=0 LIMIT 1").get(collaborationId)) return "conflict";
    const states = new Set(this.db.prepare("SELECT DISTINCT state FROM creator_follow_up_intents WHERE collaboration_id=? AND state IN ('uncertain','dispatched')")
      .all(collaborationId).map(row => String(row.state)));
    return states.has("uncertain") ? "uncertain" : states.has("dispatched") ? "inFlight" : "none";
  }
  private recordConflict(conflict: Omit<OutcomeConflict, "conflictRef" | "resolvedAt" | "resolvedBy">): OutcomeConflict {
    const full: OutcomeConflict = { ...conflict, conflictRef: "follow-up-conflict-" + digest([conflict.kind, conflict.intentRef, conflict.outcome, conflict.recordedAt]).slice(0, 32),
      resolvedAt: null, resolvedBy: null };
    this.db.prepare("INSERT INTO creator_follow_up_outcome_conflicts(conflict_ref,intent_ref,collaboration_id,blocking,body,recorded_at) VALUES(?,?,?,?,?,?)")
      .run(full.conflictRef, full.intentRef, full.collaborationId, full.blocking ? 1 : 0, JSON.stringify(full), full.recordedAt);
    return full;
  }
  /** Inserts at most one intent per collaboration, step and due-date version. Returns the existing one otherwise. */
  private propose(collaborationId: string, step: FollowUpStep, dueVersion: string, fields: Pick<FollowUpIntent, "channel" | "localDay" | "timezone" | "reasonCodes" | "sourceRef">, at: number): Proposal {
    const existing = this.intentRow("collaboration_id=? AND step=? AND due_version=?", collaborationId, step, dueVersion);
    if (existing) return { intent: existing, created: false };
    const createdAt = new Date(at).toISOString(), key = dedupeKeyOf(collaborationId, step, dueVersion);
    const body = { collaborationId, step, dueVersion, ...fields, policyVersion: FOLLOW_UP_POLICY_VERSION, sends: false as const };
    const intent: StoredIntent = { intentRef: "follow-up-" + key.slice(0, 40), intentVersion: "fu1-" + digest([this.scope, body]), ...body, createdAt,
      state: "proposed", supersededBy: null, supersededFrom: null, approvalRef: null, manifestRef: null, runRef: null, runVersion: null,
      receiptRefs: [], holdReasons: [], updatedAt: createdAt };
    this.db.prepare("INSERT INTO creator_follow_up_intents VALUES(?,?,?,?,?,?,?,?)")
      .run(intent.intentRef, collaborationId, step, dueVersion, intent.state, JSON.stringify(intent), createdAt, createdAt);
    return { intent, created: true };
  }
  /**
   * Withdraws intents that are not sent or uncertain, including those already awaiting approval or dispatched.
   * Withdrawing one that J04 is approving or running opens a blocking conflict, because the approval or run still
   * needs cancelling by its owner. Later outcomes for withdrawn intents become conflicts too.
   */
  private supersede(collaborationId: string, reason: SupersededBy, select: (intent: StoredIntent) => boolean, at: number) {
    const rows = this.db.prepare(`SELECT body FROM creator_follow_up_intents WHERE collaboration_id=? AND state IN (${WITHDRAWABLE.map(() => "?").join(",")})`)
      .all(collaborationId, ...WITHDRAWABLE);
    for (const row of rows) {
      const intent = JSON.parse(String(row.body)) as StoredIntent;
      if (!select(intent)) continue;
      const updatedAt = new Date(at).toISOString();
      this.writeIntent({ ...intent, state: "superseded", supersededBy: reason, supersededFrom: intent.state, updatedAt });
      if (LIVE_IN_J04.includes(intent.state)) this.recordConflict({ kind: "withdrawnWhileInJ04", intentRef: intent.intentRef, collaborationId,
        outcome: null, intentState: intent.state, blocking: true, recordedAt: updatedAt });
    }
  }

  planReminder(raw: unknown, idempotencyKey: string): PlanReceipt {
    if (!this.config.reminderPolicy) throw new FollowUpError("REMINDER_POLICY_UNSET");
    const input = planInputSchema.parse(raw);
    return this.once("planReminder", idempotencyKey, input, at => {
      const id = input.collaborationId;
      if (input.outreach === "suppressed") this.supersede(id, "outreachSuppressed", i => i.channel === "creator-message", at);
      const decide = () => decideReminder({ event: input.event, outreach: input.outreach, postedVerified: input.postedVerified,
        closure: this.closureOf(id)?.reason ?? null, priorSend: this.priorSend(id) }, this.config, at);
      const first = decide();
      if (first.kind !== "wait" && first.kind !== "remind" && first.kind !== "escalate") return { decision: first, proposals: [] };
      const reminder = (i: StoredIntent) => i.step !== "rights-expiry-warning";
      // A changed due date withdraws everything from older versions, then the decision is retaken: a withdrawn
      // message that J04 was already handling holds new creator reminders until an operator settles it.
      this.supersede(id, "dueDateChanged", i => reminder(i) && i.dueVersion !== first.dueVersion, at);
      const decision = decide();
      if (decision.kind !== "wait" && decision.kind !== "remind" && decision.kind !== "escalate") return { decision, proposals: [] };
      const steps: FollowUpStep[] = decision.kind === "wait" ? [] : decision.kind === "remind" ? [decision.step] : [decision.step, ...(decision.reminder ? [decision.reminder] : [])];
      // A later step withdraws only proposals that were never handed to J04.
      this.supersede(id, "stepAdvanced", i => reminder(i) && i.state === "proposed" && !steps.includes(i.step), at);
      const fields = { localDay: decision.localDay, timezone: decision.timezone, reasonCodes: decision.reasonCodes, sourceRef: input.event!.sourceRef };
      const proposals = steps.map(step => this.propose(id, step, decision.dueVersion, { ...fields, channel: step === "past-grace" ? "human-review" : "creator-message" }, at));
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
      if (intent.channel !== "creator-message") throw new FollowUpError("INTENT_NOT_SENDABLE");
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
      const proposal = this.propose(collaborationId, "rights-expiry-warning", gate.warningKey, { channel: "human-review", localDay: localDay(at, this.config.timezone),
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
  /** Uncertain creator messages, oldest first. Each needs a reconciliation lookup before anything else happens. */
  pendingReconciliation(limit = 50): StoredIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FollowUpError("INVALID_LIST_LIMIT", 422);
    return this.db.prepare("SELECT body FROM creator_follow_up_intents WHERE state='uncertain' ORDER BY updated_at,intent_ref LIMIT ?").all(limit)
      .map(row => JSON.parse(String(row.body)) as StoredIntent);
  }
}
