import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { reference } from "../actions/contract.ts";
import type { OperationsScope } from "../operations.ts";
import { FOLLOW_UP_POLICY_VERSION, followUpConfigSchema, outreachStateSchema, postingClockEventSchema, sendOutcomeSchema,
  type ClosureReason, type FollowUpConfig, type FollowUpIntent, type FollowUpStep, type IntentState, type StoredIntent } from "./contract.ts";
import { decideClosure, decideReminder, dedupeKeyOf, type ClosureEvidence, type ReminderDecision } from "./policy.ts";
import { applyReviewEvent, initialReviewState, type ReviewEvent, type ReviewState } from "./reviewMachine.ts";
import { evaluatePaidReuse, type RightsGateInput, type RightsGateResult } from "./rightsGate.ts";

export class FollowUpError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
export type PlanReceipt = { decision: ReminderDecision; intent: StoredIntent | null; created: boolean };
export type ClosureRecord = { collaborationId: string; reason: ClosureReason; evidenceRef: string; reasonCodes: string[]; closedAt: string };
export type RightsReceipt = { gate: RightsGateResult; intent: StoredIntent | null; created: boolean };

const planInputSchema = z.object({ event: postingClockEventSchema.nullable(), collaborationId: reference, outreach: outreachStateSchema, postedVerified: z.boolean() }).strict()
  .refine(v => !v.event || v.event.collaborationId === v.collaborationId, "Event belongs to another collaboration.");
const reviewEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submitted"), contentVersion: reference, sourceRef: reference }).strict(),
  z.object({ type: z.literal("decided"), contentVersion: reference, outcome: z.enum(["approved", "revisionRequested", "rejected"]), reviewerRef: reference }).strict(),
]);

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
  /** Inserts at most one intent per collaboration, step and due-date version. Returns the existing one otherwise. */
  private propose(collaborationId: string, step: FollowUpStep, dueVersion: string, fields: Pick<FollowUpIntent, "channel" | "localDay" | "timezone" | "reasonCodes" | "sourceRef">, at: number) {
    const existing = this.intentRow("collaboration_id=? AND step=? AND due_version=?", collaborationId, step, dueVersion);
    if (existing) return { intent: existing, created: false };
    const createdAt = new Date(at).toISOString(), key = dedupeKeyOf(collaborationId, step, dueVersion);
    const body = { collaborationId, step, dueVersion, ...fields, policyVersion: FOLLOW_UP_POLICY_VERSION, sends: false as const };
    const intent: StoredIntent = { intentRef: "follow-up-" + key.slice(0, 40), intentVersion: "fu1-" + digest([this.scope, body]), ...body, createdAt,
      state: "proposed", approvalRef: null, manifestRef: null, runRef: null, runVersion: null, receiptRefs: [], updatedAt: createdAt };
    this.db.prepare("INSERT INTO creator_follow_up_intents VALUES(?,?,?,?,?,?,?,?)")
      .run(intent.intentRef, collaborationId, step, dueVersion, intent.state, JSON.stringify(intent), createdAt, createdAt);
    return { intent, created: true };
  }
  /**
   * A proposed reminder that was never handed to J04 is superseded by a newer due-date version or a later step,
   * and every proposed intent is superseded on closure. Anything already in J04 stays as it is.
   */
  private supersede(collaborationId: string, keep: { dueVersion: string; step: FollowUpStep | null } | null, at: number) {
    const rows = this.db.prepare("SELECT body FROM creator_follow_up_intents WHERE collaboration_id=? AND state='proposed'").all(collaborationId);
    for (const row of rows) {
      const intent = JSON.parse(String(row.body)) as StoredIntent;
      if (keep && (intent.step === "rights-expiry-warning" || intent.dueVersion === keep.dueVersion && intent.step === keep.step)) continue;
      this.writeIntent({ ...intent, state: "superseded", updatedAt: new Date(at).toISOString() });
    }
  }

  planReminder(raw: unknown, idempotencyKey: string): PlanReceipt {
    const input = planInputSchema.parse(raw);
    return this.once("planReminder", idempotencyKey, input, at => {
      const uncertainSend = !!this.db.prepare("SELECT 1 FROM creator_follow_up_intents WHERE collaboration_id=? AND state='uncertain' LIMIT 1").get(input.collaborationId);
      const decision = decideReminder({ event: input.event, outreach: input.outreach, postedVerified: input.postedVerified,
        closure: this.closureOf(input.collaborationId)?.reason ?? null, uncertainSend }, this.config, at);
      if (decision.kind === "wait" || decision.kind === "remind" || decision.kind === "escalate") this.supersede(input.collaborationId, { dueVersion: decision.dueVersion, step: decision.kind === "wait" ? null : decision.step }, at);
      if (decision.kind !== "remind" && decision.kind !== "escalate") return { decision, intent: null, created: false };
      const proposed = this.propose(input.collaborationId, decision.step, decision.dueVersion, { channel: decision.kind === "remind" ? "creator-message" : "human-review",
        localDay: decision.localDay, timezone: decision.timezone, reasonCodes: decision.reasonCodes, sourceRef: input.event!.sourceRef }, at);
      return { decision, ...proposed };
    });
  }

  /** Records what the actions service reported. An uncertain send leaves only a reconciliation lookup. */
  recordSendOutcome(raw: unknown, idempotencyKey: string): StoredIntent {
    const outcome = sendOutcomeSchema.parse(raw);
    return this.once("recordSendOutcome", idempotencyKey, outcome, at => {
      const intent = this.intentRow("intent_ref=?", outcome.intentRef);
      if (!intent) throw new FollowUpError("RECORD_NOT_FOUND", 404);
      if (intent.channel !== "creator-message") throw new FollowUpError("INTENT_NOT_SENDABLE");
      if (intent.state === "sent" || intent.state === "notSent") throw new FollowUpError("INTENT_TERMINAL");
      const conflict = (field: "approvalRef" | "manifestRef" | "runRef" | "runVersion", value: string | null) => value !== null && intent[field] !== null && intent[field] !== value;
      const approvalRef = "approvalRef" in outcome ? outcome.approvalRef : null, manifestRef = "manifestRef" in outcome ? outcome.manifestRef : null;
      const runRef = "runRef" in outcome ? outcome.runRef : null, runVersion = "runVersion" in outcome ? outcome.runVersion : null;
      if (conflict("approvalRef", approvalRef) || conflict("manifestRef", manifestRef) || conflict("runRef", runRef)) throw new FollowUpError("OUTCOME_BINDING_MISMATCH");
      // Leaving uncertainty needs a reconciled lookup of the same run with a terminal receipt, never a fresh attempt.
      if (intent.state === "uncertain" && outcome.kind !== "uncertain") {
        if (outcome.kind !== "sent" && outcome.kind !== "notSent") throw new FollowUpError("UNCERTAIN_REQUIRES_RECONCILIATION");
        if (!intent.runRef || runRef !== intent.runRef || !outcome.receiptRefs.length) throw new FollowUpError("UNCERTAIN_REQUIRES_RECONCILIATION");
      }
      if (outcome.kind === "approvalRecorded" && !["proposed", "awaitingApproval", "superseded"].includes(intent.state)) throw new FollowUpError("INTENT_ALREADY_DISPATCHED");
      const state: IntentState = { approvalRecorded: "awaitingApproval", dispatchPending: "dispatched", sent: "sent", notSent: "notSent", uncertain: "uncertain" }[outcome.kind] as IntentState;
      const next: StoredIntent = { ...intent, state, approvalRef: approvalRef ?? intent.approvalRef, manifestRef: manifestRef ?? intent.manifestRef,
        runRef: runRef ?? intent.runRef, runVersion: runVersion ?? intent.runVersion,
        receiptRefs: "receiptRefs" in outcome ? [...new Set([...intent.receiptRefs, ...outcome.receiptRefs])] : intent.receiptRefs, updatedAt: new Date(at).toISOString() };
      this.writeIntent(next);
      return next;
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
  recordRightsCheck(collaborationId: string, input: RightsGateInput, idempotencyKey: string): RightsReceipt {
    reference.parse(collaborationId);
    return this.once("recordRightsCheck", idempotencyKey, [collaborationId, input], at => {
      const gate = evaluatePaidReuse(input, at, this.config.rightsWarningDays);
      if (!gate.warningKey || this.closureOf(collaborationId)) return { gate, intent: null, created: false };
      const proposed = this.propose(collaborationId, "rights-expiry-warning", gate.warningKey, { channel: "human-review", localDay: new Date(at).toISOString().slice(0, 10),
        timezone: this.config.timezone, reasonCodes: ["RIGHTS_EXPIRING"], sourceRef: input.chain[0]?.rights?.evidenceRef ?? input.asset.submission.assetId }, at);
      return { gate, ...proposed };
    });
  }

  close(collaborationId: string, evidence: ClosureEvidence, idempotencyKey: string, deliverableRef?: string): ClosureRecord {
    reference.parse(collaborationId);
    return this.once("close", idempotencyKey, [collaborationId, deliverableRef ?? null, evidence], at => {
      if (this.closureOf(collaborationId)) throw new FollowUpError("FOLLOW_UP_ALREADY_CLOSED");
      const reviewRef = evidence.reason === "posted-verified" ? evidence.delivery.deliverableRef : deliverableRef;
      const review = reviewRef ? this.reviewOf(collaborationId, reviewRef)?.state ?? null : null;
      const decision = decideClosure(collaborationId, evidence, { review, config: this.config, now: at });
      if (decision.state !== "closable") throw new FollowUpError(decision.reasonCodes[0] ?? "CLOSURE_REFUSED", 422);
      const record: ClosureRecord = { collaborationId, reason: decision.reason, evidenceRef: decision.evidenceRef, reasonCodes: decision.reasonCodes, closedAt: new Date(at).toISOString() };
      this.db.prepare("INSERT INTO creator_follow_up_closures VALUES(?,?,?,?)").run(collaborationId, record.reason, JSON.stringify(record), record.closedAt);
      this.supersede(collaborationId, null, at);
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
  /** Uncertain creator messages, oldest first. Each needs a reconciliation lookup before anything else happens. */
  pendingReconciliation(limit = 50): StoredIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FollowUpError("INVALID_LIST_LIMIT", 422);
    return this.db.prepare("SELECT body FROM creator_follow_up_intents WHERE state='uncertain' ORDER BY updated_at,intent_ref LIMIT ?").all(limit)
      .map(row => JSON.parse(String(row.body)) as StoredIntent);
  }
}
