import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { reference } from "../actions/contract.ts";
import type { FoundationAction } from "../actions/wire.ts";
import { digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { previewEnvelope } from "./actionAdapter.ts";
import { evaluateAttributionMatrix, type MatrixResult } from "./attributionMatrix.ts";
import {
  ACTIVATION_ACTION_KIND, INVITATION_ACTION_KIND, approvedTermsSchema, onboardingInputSchema, payoutSetupObservationSchema,
  reconciliationSchema, refSchema, relationshipObservationSchema, sendOutcomeSchema, sourceEventSchema,
  type Blocker, type IntentKind, type IntentState, type OnboardingRecord, type SupersedeReason,
  type PreflightRecord, type Ref, type SendOutcome, type StoredIntent,
} from "./contract.ts";
import { readSafely, runPreflight, screenAcquisition, type OnboardingAuthority } from "./preflight.ts";
import { activationBlockers, activationGate, applySourceEvent, isOpen, phaseReadiness } from "./stateMachine.ts";

export class OnboardingError extends Error {
  readonly code: string; readonly status: number; readonly reasonCodes: string[];
  constructor(code: string, status = 409, reasonCodes: string[] = []) { super(code); this.code = code; this.status = status; this.reasonCodes = reasonCodes; }
}
/**
 * Something an operator must settle with the approval owner. A withdrawal never cancels anything in J04.
 * - `termsChangedWhileLive` / `closedWhileLive`: an intent J04 was holding was withdrawn here.
 * - `evidenceChangedWhileLive`: an activation J04 was holding was withdrawn because its link mapping or matrix changed.
 * - `withdrawnWhileUncertain`: an intent whose outcome was not yet known was withdrawn.
 * - `lateOutcome`: an outcome arrived for a withdrawn intent; it is kept, never applied.
 */
export type ConflictKind = "termsChangedWhileLive" | "closedWhileLive" | "evidenceChangedWhileLive" | "withdrawnWhileUncertain" | "lateOutcome";
export type Conflict = { conflictRef: string; kind: ConflictKind; onboardingId: string; intentRef: string; intentState: IntentState;
  outcome: unknown; blocking: boolean; recordedAt: string; resolvedAt: string | null; resolvedBy: string | null };
export type OutcomeReceipt = { state: "recorded"; intent: StoredIntent; record: OnboardingRecord } | { state: "conflict"; intent: StoredIntent; conflict: Conflict }
  | { state: "held"; intent: StoredIntent; reasonCode: "RUN_DEADLINE_NOT_PASSED" | "RUN_DEADLINE_UNKNOWN"; retryAfter: string | null };
/** How long after a run's deadline an unacknowledged send may still land, as in the mirror resync service. */
export const DEFAULT_SETTLE_MARGIN_MS = 10_000;
export type OnboardingOutput = {
  onboardingId: string; origin: "synthetic" | "source" | null; providerRelationshipRef: Ref | null; linkCodeRefs: Ref[];
  attributionTestEvidence: { ref: Ref; observedAt: string; sourceUpdatedAt: null; method: string; value: unknown; unknownReason: null }[];
  phaseReadiness: ReturnType<typeof phaseReadiness>; payoutSetupState: string; blockers: Blocker[]; providerReceipt: Ref | null;
};

/** J04 has the intent: reserved, awaiting or held with an approval, or dispatched. Unknown outcomes are live too. */
function liveElsewhere(intent: StoredIntent): "j04" | "uncertain" | null {
  if (intent.state === "reconciliationRequired") return "uncertain";
  return ["previewing", "awaitingApproval", "dispatched"].includes(intent.state) || intent.state === "approvalHeld" && intent.approvalRef !== null ? "j04" : null;
}
const WITHDRAWABLE: IntentState[] = ["proposed", "previewing", "awaitingApproval", "approvalHeld", "dispatched", "reconciliationRequired"];
const NEXT: Record<SendOutcome["kind"], IntentState> = { approvalRecorded: "awaitingApproval", approvalHeld: "approvalHeld", dispatchPending: "dispatched",
  sent: "sent", notSent: "notSent", uncertain: "reconciliationRequired", permissionDenied: "reconciliationRequired", loginRequired: "reconciliationRequired",
  uiDrift: "reconciliationRequired" };
const ALLOWED_FROM: Record<SendOutcome["kind"], IntentState[]> = {
  approvalRecorded: ["previewing", "awaitingApproval", "approvalHeld"], approvalHeld: ["previewing", "awaitingApproval", "approvalHeld"],
  dispatchPending: ["previewing", "awaitingApproval", "dispatched"], sent: ["previewing", "awaitingApproval", "dispatched"],
  notSent: ["previewing", "awaitingApproval", "approvalHeld", "dispatched"], uncertain: ["previewing", "awaitingApproval", "approvalHeld", "dispatched"],
  permissionDenied: ["previewing", "awaitingApproval", "approvalHeld", "dispatched"], loginRequired: ["previewing", "awaitingApproval", "approvalHeld", "dispatched"],
  uiDrift: ["previewing", "awaitingApproval", "approvalHeld", "dispatched"],
};
const HOLD_CODE: Partial<Record<SendOutcome["kind"], string>> = { uncertain: "SEND_OUTCOME_UNKNOWN", permissionDenied: "PROVIDER_PERMISSION_DENIED",
  loginRequired: "PROVIDER_LOGIN_OR_MFA_REQUIRED", uiDrift: "PROVIDER_UI_DRIFT" };
const LIVE_CONFLICT: Record<SupersedeReason, ConflictKind> = { termsChanged: "termsChangedWhileLive", closed: "closedWhileLive", evidenceChanged: "evidenceChangedWhileLive" };
/** Only an unknown send may resume under its approval after the source confirms absence. A denial, login/MFA or UI drift needs a new approval. */
const RESUMABLE_HOLD = "SEND_OUTCOME_UNKNOWN";
const ACTION_KIND: Record<IntentKind, string> = { invitation: INVITATION_ACTION_KIND, activation: ACTIVATION_ACTION_KIND };
const closeSchema = z.object({ reason: z.enum(["merchant-withdrew", "creator-suppressed", "relationship-ended", "operator-closed"]), sourceRef: refSchema }).strict();

/**
 * J10 onboarding state on the shared agent SQLite connection, in its own `affiliate_onboarding_*` tables. Every
 * mutation runs under BEGIN IMMEDIATE with an idempotency key and reads the injected clock only after the lock is held.
 * It proposes J04 intents and records what their owners report. It never sends, issues a code or activates.
 */
export class AffiliateOnboardingRepository {
  private readonly db: DatabaseSync; private readonly scope: OperationsScope;
  private readonly authority: OnboardingAuthority; private readonly now: () => number; private readonly settleMarginMs: number;
  constructor(db: DatabaseSync, scope: OperationsScope, authority: OnboardingAuthority, now: () => number = Date.now, options: { settleMarginMs?: number } = {}) {
    this.db = db; this.scope = scope; this.authority = authority; this.now = now;
    this.settleMarginMs = options.settleMarginMs ?? DEFAULT_SETTLE_MARGIN_MS;
    if (!Number.isSafeInteger(this.settleMarginMs) || this.settleMarginMs < 0) throw new OnboardingError("INVALID_SETTLE_MARGIN", 500);
    const agent = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_scope'").get()
      ? db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get() : undefined;
    if (!agent || agent.workspace_id !== scope.workspaceId || agent.account_id !== scope.accountId) throw new OnboardingError("DATABASE_SCOPE_MISMATCH", 403);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_scope'").get()) {
      const bound = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
      if (bound && (bound.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId || bound.environment !== scope.environment))
        throw new OnboardingError("DATABASE_SCOPE_MISMATCH", 403);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS affiliate_onboarding_records(onboarding_id TEXT PRIMARY KEY,creator_id TEXT NOT NULL,merchant_key TEXT NOT NULL,
        program_key TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(merchant_key,creator_id,program_key));
      CREATE TABLE IF NOT EXISTS affiliate_onboarding_revisions(onboarding_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,recorded_at TEXT NOT NULL,
        PRIMARY KEY(onboarding_id,revision));
      CREATE TABLE IF NOT EXISTS affiliate_onboarding_intents(intent_ref TEXT PRIMARY KEY,onboarding_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,
        body TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS affiliate_onboarding_intent_state ON affiliate_onboarding_intents(onboarding_id,kind,state);
      CREATE TABLE IF NOT EXISTS affiliate_onboarding_relationships(provider TEXT NOT NULL,provider_account TEXT NOT NULL,relationship_id TEXT NOT NULL,
        onboarding_id TEXT NOT NULL,terms_revision INTEGER NOT NULL,offer_version TEXT NOT NULL,creator_id TEXT NOT NULL,body TEXT NOT NULL,
        PRIMARY KEY(provider,provider_account,relationship_id,onboarding_id,terms_revision),UNIQUE(onboarding_id,terms_revision));
      CREATE TABLE IF NOT EXISTS affiliate_onboarding_link_codes(provider TEXT NOT NULL,provider_account TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,
        onboarding_id TEXT NOT NULL,terms_revision INTEGER NOT NULL,offer_version TEXT NOT NULL,creator_id TEXT NOT NULL,relationship_id TEXT NOT NULL,
        PRIMARY KEY(provider,provider_account,kind,source_id,onboarding_id,terms_revision));
      CREATE TABLE IF NOT EXISTS affiliate_onboarding_matrices(matrix_ref TEXT PRIMARY KEY,onboarding_id TEXT NOT NULL,offer_version TEXT NOT NULL,
        body TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS affiliate_onboarding_observations(observation_key TEXT PRIMARY KEY,onboarding_id TEXT NOT NULL,kind TEXT NOT NULL,
        body TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS affiliate_onboarding_conflicts(conflict_ref TEXT PRIMARY KEY,onboarding_id TEXT NOT NULL,intent_ref TEXT NOT NULL,
        blocking INTEGER NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS affiliate_onboarding_requests(request_key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt TEXT NOT NULL);`);
  }

  /** One locked, idempotent write. The clock is read inside the lock; `replay` re-validates a stored receipt in the same lock. */
  private once<T>(kind: string, key: string, input: unknown, work: (at: number) => T, replay?: (stored: T) => T): T {
    if (!reference.safeParse(key).success) throw new OnboardingError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const requestDigest = digest([this.scope, kind, input]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT request_digest,receipt FROM affiliate_onboarding_requests WHERE request_key=?").get(key);
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new OnboardingError("IDEMPOTENCY_KEY_REUSED");
        const stored = JSON.parse(String(prior.receipt)) as T, result = replay ? replay(stored) : stored;
        this.db.exec("COMMIT"); return result;
      }
      const at = this.now();
      if (!Number.isSafeInteger(at) || at < 0) throw new OnboardingError("INVALID_CLOCK", 500);
      const result = work(at);
      this.db.prepare("INSERT INTO affiliate_onboarding_requests VALUES(?,?,?)").run(key, requestDigest, JSON.stringify(result));
      this.db.exec("COMMIT"); return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  private recordOf(onboardingId: string): OnboardingRecord | null {
    const row = this.db.prepare("SELECT body FROM affiliate_onboarding_records WHERE onboarding_id=?").get(onboardingId);
    return row ? JSON.parse(String(row.body)) as OnboardingRecord : null;
  }
  private required(onboardingId: string): OnboardingRecord {
    reference.parse(onboardingId);
    const record = this.recordOf(onboardingId);
    if (!record) throw new OnboardingError("RECORD_NOT_FOUND", 404);
    return record;
  }
  private write(record: OnboardingRecord) {
    this.db.prepare("UPDATE affiliate_onboarding_records SET state=?,body=?,updated_at=? WHERE onboarding_id=?").run(record.state, JSON.stringify(record), record.updatedAt, record.onboardingId);
    this.db.prepare("INSERT INTO affiliate_onboarding_revisions VALUES(?,?,?,?)").run(record.onboardingId, record.revision, JSON.stringify(record), record.updatedAt);
  }
  private change(record: OnboardingRecord, at: number, patch: Partial<OnboardingRecord>): OnboardingRecord {
    const next = { ...record, ...patch, revision: record.revision + 1, updatedAt: new Date(at).toISOString() };
    this.write(next); return next;
  }
  private intentOf(intentRef: string): StoredIntent | null {
    const row = this.db.prepare("SELECT body FROM affiliate_onboarding_intents WHERE intent_ref=?").get(intentRef);
    return row ? JSON.parse(String(row.body)) as StoredIntent : null;
  }
  private writeIntent(intent: StoredIntent) {
    this.db.prepare("UPDATE affiliate_onboarding_intents SET state=?,body=?,updated_at=? WHERE intent_ref=?").run(intent.state, JSON.stringify(intent), intent.updatedAt, intent.intentRef);
  }
  private openConflict(onboardingId: string) {
    return !!this.db.prepare("SELECT 1 FROM affiliate_onboarding_conflicts WHERE onboarding_id=? AND blocking=1 AND resolved=0 LIMIT 1").get(onboardingId);
  }
  private recordConflict(conflict: Omit<Conflict, "conflictRef" | "resolvedAt" | "resolvedBy">): Conflict {
    const full: Conflict = { ...conflict, conflictRef: "affiliate-conflict-" + digest([conflict.kind, conflict.intentRef, conflict.outcome, conflict.recordedAt]).slice(0, 32),
      resolvedAt: null, resolvedBy: null };
    this.db.prepare("INSERT OR IGNORE INTO affiliate_onboarding_conflicts(conflict_ref,onboarding_id,intent_ref,blocking,body,recorded_at) VALUES(?,?,?,?,?,?)")
      .run(full.conflictRef, full.onboardingId, full.intentRef, full.blocking ? 1 : 0, JSON.stringify(full), full.recordedAt);
    return full;
  }
  /** Withdraws every unsettled intent. One that J04 holds, or whose outcome is unknown, opens a blocking conflict. */
  private supersede(onboardingId: string, reason: SupersedeReason, at: number, kinds: IntentKind[] = ["invitation", "activation"]): number {
    const rows = this.db.prepare(`SELECT body FROM affiliate_onboarding_intents WHERE onboarding_id=? AND state IN (${WITHDRAWABLE.map(() => "?").join(",")})`)
      .all(onboardingId, ...WITHDRAWABLE).map(row => JSON.parse(String(row.body)) as StoredIntent).filter(i => kinds.includes(i.kind));
    const updatedAt = new Date(at).toISOString();
    for (const intent of rows) {
      this.writeIntent({ ...intent, state: "superseded", supersededBy: reason, supersededFrom: intent.state, updatedAt });
      const live = liveElsewhere(intent);
      if (live) this.recordConflict({ kind: live === "uncertain" ? "withdrawnWhileUncertain" : LIVE_CONFLICT[reason],
        onboardingId, intentRef: intent.intentRef, intentState: intent.state, outcome: null, blocking: true, recordedAt: updatedAt });
    }
    return rows.length;
  }
  /** A re-recorded link mapping or matrix withdraws any unsettled activation and returns a proposed activation to not ready. */
  private withdrawActivation(record: OnboardingRecord, at: number): OnboardingRecord {
    this.supersede(record.onboardingId, "evidenceChanged", at, ["activation"]);
    return record.activation.state === "proposed" ? { ...record, activation: { state: "notReady", receipt: null, offerVersion: null } } : record;
  }
  private currentOffer(offerId: string) { return readSafely(() => this.authority.offer(offerId)); }
  private preflight(record: OnboardingRecord, at: number, phase: "invitation" | "activation", terms = record.approvedTerms): PreflightRecord {
    return runPreflight({ merchantRef: record.merchantRef, creatorRef: record.creatorRef, providerProgram: record.providerProgram, offerId: record.offerId,
      approvedTerms: terms, acquisition: record.acquisition }, this.authority, this.scope, at, phase);
  }
  /** Re-reads canonical identity: the creator must still exist and be unsuppressed. */
  private identity(creatorId: string) {
    const identity = readSafely(() => this.authority.identity(creatorId));
    if (!identity || identity.creatorId !== creatorId) throw new OnboardingError("CANONICAL_IDENTITY_UNRESOLVED");
    if (identity.suppressions.length) throw new OnboardingError("CREATOR_SUPPRESSED", 409, identity.suppressions.slice(0, 10));
    return identity;
  }
  private assertSourceRef(record: OnboardingRecord, ref: Ref) {
    if (ref.provider !== record.providerProgram.provider || ref.accountId !== record.preflight.providerAccountRef) throw new OnboardingError("EVIDENCE_ACCOUNT_MISMATCH", 422);
  }

  boundScope(): OperationsScope { return { ...this.scope }; }

  /**
   * Opens one onboarding per merchant, canonical creator and provider program. A fee, paid-hybrid or gifted-only
   * request is refused here, server-side, before anything is stored. A duplicate import returns the existing record.
   */
  open(raw: unknown, idempotencyKey: string): { record: OnboardingRecord; created: boolean } {
    const input = onboardingInputSchema.parse(raw);
    const screen = screenAcquisition(input.acquisition, input.approvedTerms, null);
    if (screen.rejected.length) throw new OnboardingError("ACQUISITION_POLICY_VIOLATION", 422, screen.rejected);
    if (input.creatorRef.provider !== "farda-creator" || input.creatorRef.accountId !== this.scope.accountId) throw new OnboardingError("CREATOR_REF_NOT_CANONICAL", 422);
    return this.once("open", idempotencyKey, input, at => {
      const creatorId = input.creatorRef.sourceId, identity = this.identity(creatorId);
      const merchantKey = digest([input.merchantRef.provider, input.merchantRef.accountId, input.merchantRef.sourceId]);
      const programKey = digest([input.providerProgram.provider, input.providerProgram.programRef?.sourceId ?? null]);
      const existing = this.db.prepare("SELECT body FROM affiliate_onboarding_records WHERE merchant_key=? AND creator_id=? AND program_key=?").get(merchantKey, creatorId, programKey);
      if (existing) return { record: JSON.parse(String(existing.body)) as OnboardingRecord, created: false };
      const createdAt = new Date(at).toISOString();
      const onboardingId = "affiliate-onboarding-" + digest([this.scope, merchantKey, creatorId, programKey]).slice(0, 32);
      const base: OnboardingRecord = { onboardingId, revision: 1, termsRevision: 1, creatorId, identityRevision: identity.revision, merchantRef: input.merchantRef, creatorRef: input.creatorRef,
        providerProgram: input.providerProgram, storefrontRoute: input.storefrontRoute, offerId: input.offerId, offerVersion: input.approvedTerms.offerVersion,
        approvedTerms: input.approvedTerms, acquisition: input.acquisition, state: "preflightBlocked", stateReasons: [], preflight: null as unknown as PreflightRecord,
        invitation: { receipt: null, sentAt: null, expiresAt: null, expiredAt: null },
        acceptance: { state: "unknown", offerVersion: null, evidenceRef: null, observedAt: null },
        linkCode: { state: "notIssued", relationshipRef: null, linkCodeRefs: [] }, checkoutTest: { state: "notRun", matrixRef: null, offerVersion: null },
        payoutSetup: { state: "notStarted", owner: null, sourceRef: null, observedAt: null, unknownReason: null },
        activation: { state: "notReady", receipt: null, offerVersion: null }, createdAt, updatedAt: createdAt };
      const preflight = this.preflight(base, at, "invitation");
      const record: OnboardingRecord = { ...base, preflight, state: preflight.state === "ready" ? "readyToInvite" : "preflightBlocked",
        stateReasons: preflight.blockers.map(b => b.code) };
      this.db.prepare("INSERT INTO affiliate_onboarding_records VALUES(?,?,?,?,?,?,?)").run(onboardingId, creatorId, merchantKey, programKey, record.state, JSON.stringify(record), createdAt);
      this.db.prepare("INSERT INTO affiliate_onboarding_revisions VALUES(?,?,?,?)").run(onboardingId, 1, JSON.stringify(record), createdAt);
      return { record, created: true };
    });
  }

  /** Re-runs the invitation preflight against current account, capability, policy and offer state. */
  refreshPreflight(onboardingId: string, idempotencyKey: string): OnboardingRecord {
    return this.once("refreshPreflight", idempotencyKey, onboardingId, at => {
      const record = this.required(onboardingId);
      if (record.state !== "preflightBlocked" && record.state !== "readyToInvite") throw new OnboardingError("PREFLIGHT_PHASE_PASSED");
      const preflight = this.preflight(record, at, "invitation");
      return this.change(record, at, { preflight, state: preflight.state === "ready" ? "readyToInvite" : "preflightBlocked", stateReasons: preflight.blockers.map(b => b.code) });
    });
  }

  private proposeIntent(record: OnboardingRecord, kind: IntentKind, at: number): StoredIntent {
    if (this.openConflict(record.onboardingId)) throw new OnboardingError("OPEN_CONFLICT");
    const open = this.intents(record.onboardingId).filter(i => i.kind === kind && WITHDRAWABLE.includes(i.state));
    if (open.some(i => i.state === "reconciliationRequired")) throw new OnboardingError("RECONCILIATION_REQUIRED");
    if (open.length) throw new OnboardingError("INTENT_ALREADY_OPEN");
    const offer = this.currentOffer(record.offerId);
    if (!offer || offer.version !== record.offerVersion) throw new OnboardingError("TERMS_CHANGED");
    const attempt = this.intents(record.onboardingId).filter(i => i.kind === kind).length;
    const createdAt = new Date(at).toISOString(), termsHash = digest(record.approvedTerms);
    const body = { kind, actionKind: ACTION_KIND[kind], onboardingId: record.onboardingId, creatorId: record.creatorId, offerId: record.offerId,
      offerVersion: record.offerVersion, manifestHash: offer.manifestHash, termsHash, sends: false as const };
    const intent: StoredIntent = { ...body, intentRef: "affiliate-intent-" + digest([this.scope, body, attempt]).slice(0, 32),
      intentVersion: "ao1-" + digest([this.scope, body, attempt]), state: "proposed", holdReasons: [], approvalRef: null, manifestRef: null, runRef: null,
      runVersion: null, runDeadline: null, receiptRefs: [], providerReceipt: null, supersededBy: null, supersededFrom: null, createdAt, updatedAt: createdAt };
    this.db.prepare("INSERT INTO affiliate_onboarding_intents VALUES(?,?,?,?,?,?,?)").run(intent.intentRef, intent.onboardingId, kind, intent.state, JSON.stringify(intent), createdAt, createdAt);
    return intent;
  }

  /** J10-02: proposes an invitation that discloses the approved commission-only terms. Proposing or sending never sets acceptance. */
  proposeInvitation(onboardingId: string, idempotencyKey: string): StoredIntent {
    return this.once("proposeInvitation", idempotencyKey, onboardingId, at => {
      const record = this.required(onboardingId);
      if (record.state !== "readyToInvite") throw new OnboardingError("NOT_READY_TO_INVITE", 409, record.stateReasons);
      const preflight = this.preflight(record, at, "invitation");
      if (preflight.state !== "ready") throw new OnboardingError("PREFLIGHT_BLOCKED", 409, preflight.blockers.map(b => b.code));
      return this.proposeIntent(record, "invitation", at);
    });
  }

  /** Proposes activation only with current accepted terms, a mapped link or code and a passing matrix for the same version. */
  proposeActivation(onboardingId: string, idempotencyKey: string): StoredIntent {
    return this.once("proposeActivation", idempotencyKey, onboardingId, at => {
      const record = this.required(onboardingId);
      const blockers = activationBlockers(record, this.currentOffer(record.offerId)?.version ?? null);
      if (blockers.length) throw new OnboardingError("ACTIVATION_NOT_READY", 409, blockers);
      const preflight = this.preflight(record, at, "activation");
      if (preflight.state !== "ready") throw new OnboardingError("PREFLIGHT_BLOCKED", 409, preflight.blockers.map(b => b.code));
      return this.proposeIntent(record, "activation", at);
    });
  }

  /**
   * Reserves a proposed intent for J04 and returns its preview, in one locked transaction. It re-reads the intent, the
   * onboarding and the current offer, re-runs the preflight, and moves the intent to `previewing`, which counts as
   * live. Another key for the same intent is refused; the same key replays only while the intent is still `previewing`.
   */
  reserve(intentRef: string, idempotencyKey: string, context: { requestId: string }): { intent: StoredIntent; action: FoundationAction } {
    reference.parse(intentRef); reference.parse(context.requestId);
    const build = (intent: StoredIntent) => ({ intent, action: previewEnvelope(intent, this.scope, context.requestId) });
    return this.once("reserve", idempotencyKey, intentRef, at => {
      const intent = this.intentOf(intentRef);
      if (!intent) throw new OnboardingError("RECORD_NOT_FOUND", 404);
      if (intent.state !== "proposed") throw new OnboardingError(intent.state === "previewing" ? "INTENT_ALREADY_RESERVED" : "INTENT_NOT_PROPOSED");
      const record = this.required(intent.onboardingId);
      const offer = this.currentOffer(record.offerId);
      if (!offer || offer.version !== intent.offerVersion || offer.manifestHash !== intent.manifestHash || record.offerVersion !== intent.offerVersion) throw new OnboardingError("TERMS_CHANGED");
      if (this.openConflict(record.onboardingId)) throw new OnboardingError("OPEN_CONFLICT");
      if (intent.kind === "invitation" && record.state !== "readyToInvite") throw new OnboardingError("NOT_READY_TO_INVITE");
      if (intent.kind === "activation") { const blockers = activationBlockers(record, offer.version); if (blockers.length) throw new OnboardingError("ACTIVATION_NOT_READY", 409, blockers); }
      const preflight = this.preflight(record, at, intent.kind);
      if (preflight.state !== "ready") throw new OnboardingError("PREFLIGHT_BLOCKED", 409, preflight.blockers.map(b => b.code));
      const next: StoredIntent = { ...intent, state: "previewing", updatedAt: new Date(at).toISOString() };
      this.writeIntent(next);
      this.change(record, at, intent.kind === "invitation" ? { state: "invitationPending", stateReasons: [] }
        : { activation: { ...record.activation, state: "proposed", offerVersion: intent.offerVersion } });
      return build(next);
    }, () => {
      const intent = this.intentOf(intentRef);
      if (!intent || intent.state !== "previewing") throw new OnboardingError("INTENT_NOT_PREVIEWING");
      return build(intent);
    });
  }

  /**
   * For the J04 registration's current-draft check. Throws unless the intent is live in J04 at this exact version and
   * the offer it discloses is still the current offer. A withdrawn or changed intent can never be approved or dispatched.
   */
  assertJ04Current(intentRef: string, intentVersion: string): void {
    const intent = this.intentOf(intentRef);
    if (!intent) throw new OnboardingError("RECORD_NOT_FOUND", 404);
    if (intent.state === "superseded") throw new OnboardingError("INTENT_WITHDRAWN");
    if (intent.intentVersion !== intentVersion) throw new OnboardingError("INTENT_VERSION_CHANGED");
    if (!["previewing", "awaitingApproval", "approvalHeld", "dispatched"].includes(intent.state)) throw new OnboardingError("INTENT_NOT_IN_J04");
    const offer = this.currentOffer(intent.offerId);
    if (!offer || offer.version !== intent.offerVersion || offer.manifestHash !== intent.manifestHash) throw new OnboardingError("TERMS_CHANGED");
    const record = this.recordOf(intent.onboardingId);
    if (!record || !isOpen(record)) throw new OnboardingError("ONBOARDING_NOT_OPEN");
    // An activation must still have current acceptance, its mapped link or code and a passing matrix for this version.
    if (intent.kind === "activation") {
      const blockers = activationGate(record, offer.version);
      if (blockers.length) throw new OnboardingError("ACTIVATION_NOT_READY", 409, blockers);
    }
  }

  private applyIntentEffect(intent: StoredIntent, record: OnboardingRecord, at: number): OnboardingRecord {
    const at_ = new Date(at).toISOString();
    if (intent.kind === "invitation") {
      if (intent.state === "sent") return this.change(record, at, { state: "invited", stateReasons: [],
        invitation: { receipt: intent.providerReceipt, sentAt: at_, expiresAt: record.invitation.expiresAt, expiredAt: null } });
      if (intent.state === "reconciliationRequired") return this.change(record, at, { state: "invitationUnknown", stateReasons: intent.holdReasons });
      if (intent.state === "notSent") return this.change(record, at, { state: "readyToInvite", stateReasons: ["INVITATION_NOT_SENT"] });
      return record;
    }
    if (intent.state === "sent") return this.change(record, at, { activation: { state: "active", receipt: intent.providerReceipt, offerVersion: intent.offerVersion } });
    if (intent.state === "notSent") return this.change(record, at, { activation: { state: "notReady", receipt: null, offerVersion: null } });
    if (intent.state === "reconciliationRequired") return this.change(record, at, { stateReasons: intent.holdReasons });
    return record;
  }

  /**
   * Records what the actions service or executor reported. Only a sent receipt advances the onboarding. An unknown
   * result, denied permission, login/MFA or UI drift keeps the approval and holds the intent for source reconciliation.
   */
  recordOutcome(raw: unknown, idempotencyKey: string): OutcomeReceipt {
    const outcome = sendOutcomeSchema.parse(raw);
    return this.once("recordOutcome", idempotencyKey, outcome, (at): OutcomeReceipt => {
      const intent = this.intentOf(outcome.intentRef);
      if (!intent) throw new OnboardingError("RECORD_NOT_FOUND", 404);
      // A native receipt from another provider account is refused, even as a late outcome.
      if (outcome.kind === "sent") this.assertSourceRef(this.required(intent.onboardingId), outcome.providerReceipt);
      const recordedAt = new Date(at).toISOString();
      if (intent.state === "superseded") {
        const conflict = this.recordConflict({ kind: "lateOutcome", onboardingId: intent.onboardingId, intentRef: intent.intentRef, intentState: intent.state,
          outcome, blocking: outcome.kind !== "notSent" && outcome.kind !== "approvalHeld", recordedAt });
        return { state: "conflict", intent, conflict };
      }
      if (intent.state === "reconciliationRequired") throw new OnboardingError("RECONCILIATION_REQUIRED");
      if (intent.state === "proposed") throw new OnboardingError("INTENT_NOT_RESERVED");
      if (!ALLOWED_FROM[outcome.kind].includes(intent.state)) throw new OnboardingError("OUTCOME_OUT_OF_ORDER");
      const value = (field: "approvalRef" | "manifestRef" | "runRef" | "runVersion") => (field in outcome ? (outcome as Record<string, string | null>)[field] ?? null : null);
      if ((["approvalRef", "manifestRef", "runRef"] as const).some(f => value(f) !== null && intent[f] !== null && intent[f] !== value(f))) throw new OnboardingError("OUTCOME_BINDING_MISMATCH");
      const next: StoredIntent = { ...intent, state: NEXT[outcome.kind], approvalRef: value("approvalRef") ?? intent.approvalRef,
        manifestRef: value("manifestRef") ?? intent.manifestRef, runRef: value("runRef") ?? intent.runRef, runVersion: intent.runVersion ?? value("runVersion"),
        // The first run's deadline stays the binding for any later source absence.
        runDeadline: intent.runDeadline ?? ("runDeadline" in outcome ? outcome.runDeadline ?? null : null),
        holdReasons: outcome.kind === "approvalHeld" ? outcome.reasonCodes : HOLD_CODE[outcome.kind] ? [HOLD_CODE[outcome.kind]!] : [],
        receiptRefs: "receiptRefs" in outcome ? [...new Set([...intent.receiptRefs, ...outcome.receiptRefs])] : intent.receiptRefs,
        providerReceipt: outcome.kind === "sent" ? outcome.providerReceipt : intent.providerReceipt, updatedAt: recordedAt };
      this.writeIntent(next);
      let record = this.required(intent.onboardingId);
      if (outcome.kind === "sent" && intent.kind === "invitation") record = { ...record, invitation: { ...record.invitation, expiresAt: outcome.expiresAt } };
      return { state: "recorded", intent: next, record: this.applyIntentEffect(next, record, at) };
    });
  }

  /**
   * Source reconciliation for an intent held after an unknown result. `found` records the native receipt. `absent`, a
   * terminal source answer, keeps the approval for a J04 fresh attempt only after an unknown send. After a denied
   * permission, login/MFA or UI drift, or without an approval, the intent is not sent and a new intent and approval are required.
   * An absence counts only once a dispatched run can no longer land: before its deadline plus the settle margin, or
   * when that deadline is unknown, the intent stays held. J04's own dispatch guard is the other backstop.
   */
  reconcile(raw: unknown, idempotencyKey: string): OutcomeReceipt {
    const answer = reconciliationSchema.parse(raw);
    return this.once("reconcile", idempotencyKey, answer, (at): OutcomeReceipt => {
      const intent = this.intentOf(answer.intentRef);
      if (!intent) throw new OnboardingError("RECORD_NOT_FOUND", 404);
      this.assertSourceRef(this.required(intent.onboardingId), answer.result === "found" ? answer.providerReceipt : answer.sourceRef);
      const recordedAt = new Date(at).toISOString();
      if (intent.state === "superseded") {
        const conflict = this.recordConflict({ kind: "lateOutcome", onboardingId: intent.onboardingId, intentRef: intent.intentRef, intentState: intent.state,
          outcome: answer, blocking: answer.result === "found", recordedAt });
        return { state: "conflict", intent, conflict };
      }
      if (intent.state !== "reconciliationRequired") throw new OnboardingError("INTENT_NOT_UNCERTAIN");
      if (answer.result === "absent" && intent.runRef) {
        if (!intent.runDeadline) return { state: "held", intent, reasonCode: "RUN_DEADLINE_UNKNOWN", retryAfter: null };
        const settled = Date.parse(intent.runDeadline) + this.settleMarginMs;
        if (at < settled) return { state: "held", intent, reasonCode: "RUN_DEADLINE_NOT_PASSED", retryAfter: new Date(settled).toISOString() };
      }
      const next: StoredIntent = answer.result === "found"
        ? { ...intent, state: "sent", holdReasons: [], providerReceipt: answer.providerReceipt, receiptRefs: [...new Set([...intent.receiptRefs, ...answer.receiptRefs])], updatedAt: recordedAt }
        : intent.approvalRef && intent.holdReasons.length === 1 && intent.holdReasons[0] === RESUMABLE_HOLD
          ? { ...intent, state: "awaitingApproval", holdReasons: [], updatedAt: recordedAt }
          : { ...intent, state: "notSent", updatedAt: recordedAt };
      this.writeIntent(next);
      let record = this.required(intent.onboardingId);
      if (answer.result === "found" && intent.kind === "invitation") record = { ...record, invitation: { ...record.invitation, expiresAt: answer.expiresAt } };
      if (next.state === "awaitingApproval")
        record = this.change(record, at, intent.kind === "invitation" ? { state: "invitationPending", stateReasons: ["SOURCE_CONFIRMED_NOT_SENT"] } : { stateReasons: ["SOURCE_CONFIRMED_NOT_SENT"] });
      return { state: "recorded", intent: next, record: this.applyIntentEffect(next, record, at) };
    });
  }

  /**
   * J10-05: records a source observation. The evidence must come from this onboarding's provider account. A fee request
   * or decline withdraws unsettled intents, and any that J04 holds open a blocking conflict.
   */
  observe(onboardingId: string, raw: unknown, idempotencyKey: string): { record: OnboardingRecord; reasonCodes: string[] } {
    const event = sourceEventSchema.parse(raw);
    return this.once("observe", idempotencyKey, [onboardingId, event], at => {
      const record = this.required(onboardingId);
      this.assertSourceRef(record, event.evidence.ref);
      const transition = applySourceEvent(record, event, this.currentOffer(record.offerId)?.version ?? null, new Date(at).toISOString());
      if (!transition.ok) throw new OnboardingError(transition.code);
      const key = digest([event.type, event.evidence.ref, event.evidence.value, event.evidence.unknownReason]);
      this.db.prepare("INSERT OR IGNORE INTO affiliate_onboarding_observations VALUES(?,?,?,?,?)").run(key, onboardingId, event.type, JSON.stringify(event), new Date(at).toISOString());
      if (!transition.changed) return { record, reasonCodes: transition.reasonCodes };
      if (transition.record.state === "declined") this.supersede(onboardingId, "closed", at);
      if (transition.record.state === "feeRequested") this.supersede(onboardingId, "termsChanged", at);
      this.write(transition.record);
      return { record: transition.record, reasonCodes: transition.reasonCodes };
    });
  }

  /**
   * Re-reads the saved offer by reference. A changed version or manifest withdraws every unsettled intent; any that J04
   * holds opens a blocking conflict. Earlier acceptance stays in history and can no longer activate.
   */
  syncTerms(onboardingId: string, idempotencyKey: string): OnboardingRecord {
    return this.once("syncTerms", idempotencyKey, onboardingId, at => {
      const record = this.required(onboardingId);
      const offer = this.currentOffer(record.offerId);
      if (offer && offer.version === record.offerVersion && offer.manifestHash === record.preflight.manifestHash) return record;
      if (!isOpen(record)) return record;
      this.supersede(onboardingId, "termsChanged", at);
      return this.change(record, at, { state: "termsChanged", stateReasons: [offer ? "OFFER_VERSION_CHANGED" : "OFFER_UNAVAILABLE"] });
    });
  }

  /** After a terms change, binds the newly approved terms and re-runs the preflight. A new invitation is required. */
  reviseTerms(onboardingId: string, rawTerms: unknown, idempotencyKey: string): OnboardingRecord {
    const terms = approvedTermsSchema.parse(rawTerms);
    return this.once("reviseTerms", idempotencyKey, [onboardingId, terms], at => {
      const record = this.required(onboardingId);
      if (record.state !== "termsChanged") throw new OnboardingError("TERMS_NOT_CHANGED");
      const screen = screenAcquisition(record.acquisition, terms, null);
      if (screen.rejected.length) throw new OnboardingError("ACQUISITION_POLICY_VIOLATION", 422, screen.rejected);
      const preflight = this.preflight(record, at, "invitation", terms);
      return this.change(record, at, { approvedTerms: terms, offerVersion: terms.offerVersion, preflight,
        state: preflight.state === "ready" ? "readyToInvite" : "preflightBlocked", stateReasons: preflight.blockers.map(b => b.code),
        invitation: { receipt: null, sentAt: null, expiresAt: null, expiredAt: null },
        acceptance: { state: "unknown", offerVersion: null, evidenceRef: null, observedAt: null },
        // The relationship and link or code mapped under the old terms must be re-observed under the new version.
        // Earlier mappings stay in the revision history and the version-keyed crosswalk tables.
        linkCode: { state: "notIssued", relationshipRef: null, linkCodeRefs: [] }, checkoutTest: { state: "notRun", matrixRef: null, offerVersion: null },
        activation: { state: "notReady", receipt: null, offerVersion: null }, termsRevision: record.termsRevision + 1 });
    });
  }

  close(onboardingId: string, raw: unknown, idempotencyKey: string): OnboardingRecord {
    const closure = closeSchema.parse(raw);
    return this.once("close", idempotencyKey, [onboardingId, closure], at => {
      const record = this.required(onboardingId);
      if (record.state === "closed") throw new OnboardingError("ONBOARDING_ALREADY_CLOSED");
      this.supersede(onboardingId, "closed", at);
      return this.change(record, at, { state: "closed", stateReasons: [closure.reason.toUpperCase().replace(/-/g, "_")] });
    });
  }

  /**
   * J10-06: maps the provider relationship and its unique link or code to the canonical creator, after verified
   * acceptance of the current offer. A recheck or duplicate import is idempotent; nothing issues a second relationship
   * or code, and an identifier mapped to another creator is refused.
   */
  mapRelationship(onboardingId: string, raw: unknown, idempotencyKey: string): { record: OnboardingRecord; created: boolean } {
    const { evidence } = relationshipObservationSchema.parse(raw);
    return this.once("mapRelationship", idempotencyKey, [onboardingId, evidence], at => {
      const record = this.required(onboardingId);
      this.assertSourceRef(record, evidence.ref);
      if (evidence.value === null) throw new OnboardingError("RELATIONSHIP_UNKNOWN", 409, [evidence.unknownReason ?? "UNKNOWN"]);
      const value = evidence.value, account = record.preflight.providerAccountRef!;
      const offer = this.currentOffer(record.offerId);
      if (record.state !== "accepted" || record.acceptance.offerVersion !== record.offerVersion || offer?.version !== record.offerVersion) throw new OnboardingError("CURRENT_ACCEPTANCE_REQUIRED");
      if (value.offerVersion !== record.offerVersion) throw new OnboardingError("RELATIONSHIP_VERSION_MISMATCH");
      for (const ref of [value.relationshipRef, ...value.linkCodeRefs.map(r => r.ref)]) this.assertSourceRef(record, ref);
      this.identity(record.creatorId);
      const keys = value.linkCodeRefs.map(r => `${r.kind}:${r.ref.sourceId}`);
      if (new Set(keys).size !== keys.length) throw new OnboardingError("LINK_CODE_DUPLICATED", 422);
      const relationshipId = value.relationshipRef.sourceId;
      const owner = this.db.prepare("SELECT 1 FROM affiliate_onboarding_relationships WHERE provider=? AND provider_account=? AND relationship_id=? AND onboarding_id!=? LIMIT 1")
        .get(record.providerProgram.provider, account, relationshipId, onboardingId);
      if (owner) throw new OnboardingError("RELATIONSHIP_CROSS_CREATOR");
      if (record.linkCode.state === "mapped") {
        if (record.linkCode.relationshipRef?.sourceId !== relationshipId) throw new OnboardingError("RELATIONSHIP_ALREADY_MAPPED");
        const known = record.linkCode.linkCodeRefs.map(r => `${r.kind}:${r.ref.sourceId}`);
        if (keys.length === known.length && keys.every(k => known.includes(k))) return { record, created: false };
        throw new OnboardingError("LINK_CODE_CHANGED_REQUIRES_REVIEW");
      }
      for (const r of value.linkCodeRefs) {
        const mapped = this.db.prepare("SELECT 1 FROM affiliate_onboarding_link_codes WHERE provider=? AND provider_account=? AND kind=? AND source_id=? AND onboarding_id!=? LIMIT 1")
          .get(record.providerProgram.provider, account, r.kind, r.ref.sourceId, onboardingId);
        if (mapped) throw new OnboardingError("LINK_CODE_CROSS_CREATOR");
      }
      // One mapping per terms revision. A re-map after a terms change, including a return to an earlier offer version,
      // adds rows for the new revision; earlier ones stay as history.
      this.db.prepare("INSERT INTO affiliate_onboarding_relationships VALUES(?,?,?,?,?,?,?,?)")
        .run(record.providerProgram.provider, account, relationshipId, onboardingId, record.termsRevision, record.offerVersion, record.creatorId, JSON.stringify(evidence));
      for (const r of value.linkCodeRefs) this.db.prepare("INSERT INTO affiliate_onboarding_link_codes VALUES(?,?,?,?,?,?,?,?,?)")
        .run(record.providerProgram.provider, account, r.kind, r.ref.sourceId, onboardingId, record.termsRevision, record.offerVersion, record.creatorId, relationshipId);
      const withdrawn = this.withdrawActivation(record, at);
      return { record: this.change(withdrawn, at, { linkCode: { state: "mapped", relationshipRef: value.relationshipRef, linkCodeRefs: value.linkCodeRefs },
        checkoutTest: { state: "notRun", matrixRef: null, offerVersion: null } }), created: true };
    });
  }

  /** J10-07 and J10-08: records a sandbox checkout matrix against the mapped identifiers and the actual storefront route. */
  recordAttributionMatrix(onboardingId: string, rawOrders: unknown, idempotencyKey: string): { record: OnboardingRecord; matrix: MatrixResult } {
    return this.once("recordAttributionMatrix", idempotencyKey, [onboardingId, rawOrders], at => {
      const record = this.required(onboardingId);
      if (record.linkCode.state !== "mapped" || !record.linkCode.relationshipRef) throw new OnboardingError("LINK_OR_CODE_NOT_MAPPED");
      if (!isOpen(record)) throw new OnboardingError("ONBOARDING_NOT_OPEN");
      const matrix = evaluateAttributionMatrix(rawOrders, { relationshipSourceId: record.linkCode.relationshipRef.sourceId, linkCodeRefs: record.linkCode.linkCodeRefs,
        storefrontRoute: record.storefrontRoute, precedence: record.preflight.attributionPrecedence, definitions: record.preflight.definitions });
      this.db.prepare("INSERT OR IGNORE INTO affiliate_onboarding_matrices VALUES(?,?,?,?,?)").run(matrix.matrixRef, onboardingId, record.offerVersion, JSON.stringify(matrix), new Date(at).toISOString());
      return { matrix, record: this.change(this.withdrawActivation(record, at), at, { checkoutTest: { state: matrix.overall, matrixRef: matrix.matrixRef, offerVersion: record.offerVersion } }) };
    });
  }

  /**
   * J10-09: payout setup is observed on its own and never inferred from link issuance, acceptance or merchant billing.
   * Unknown setup stays unknown with its reason. Waiting for the creator names the creator and links the source.
   */
  observePayoutSetup(onboardingId: string, raw: unknown, idempotencyKey: string): OnboardingRecord {
    const { evidence } = payoutSetupObservationSchema.parse(raw);
    return this.once("observePayoutSetup", idempotencyKey, [onboardingId, evidence], at => {
      const record = this.required(onboardingId);
      this.assertSourceRef(record, evidence.ref);
      if (record.acceptance.state !== "accepted") throw new OnboardingError("PAYOUT_SETUP_BEFORE_ACCEPTANCE");
      const value = evidence.value;
      return this.change(record, at, { payoutSetup: value
        ? { state: value.state, owner: value.owner, sourceRef: evidence.ref, observedAt: evidence.observedAt, unknownReason: null }
        : { state: "unknown", owner: record.payoutSetup.owner, sourceRef: evidence.ref, observedAt: evidence.observedAt, unknownReason: evidence.unknownReason } });
    });
  }

  resolveConflict(conflictRef: string, operatorRef: string, idempotencyKey: string): Conflict {
    z.tuple([reference, reference]).parse([conflictRef, operatorRef]);
    return this.once("resolveConflict", idempotencyKey, [conflictRef, operatorRef], at => {
      const row = this.db.prepare("SELECT body FROM affiliate_onboarding_conflicts WHERE conflict_ref=?").get(conflictRef);
      if (!row) throw new OnboardingError("RECORD_NOT_FOUND", 404);
      const conflict = JSON.parse(String(row.body)) as Conflict;
      if (conflict.resolvedAt) throw new OnboardingError("CONFLICT_ALREADY_RESOLVED");
      const resolved = { ...conflict, resolvedAt: new Date(at).toISOString(), resolvedBy: operatorRef };
      this.db.prepare("UPDATE affiliate_onboarding_conflicts SET resolved=1,body=? WHERE conflict_ref=?").run(JSON.stringify(resolved), conflictRef);
      return resolved;
    });
  }

  read(onboardingId: string) { return this.recordOf(reference.parse(onboardingId)); }
  history(onboardingId: string): OnboardingRecord[] {
    return this.db.prepare("SELECT body FROM affiliate_onboarding_revisions WHERE onboarding_id=? ORDER BY revision").all(onboardingId).map(r => JSON.parse(String(r.body)) as OnboardingRecord);
  }
  intent(intentRef: string) { return this.intentOf(intentRef); }
  intents(onboardingId: string): StoredIntent[] {
    return this.db.prepare("SELECT body FROM affiliate_onboarding_intents WHERE onboarding_id=? ORDER BY created_at,intent_ref").all(onboardingId).map(r => JSON.parse(String(r.body)) as StoredIntent);
  }
  conflicts(onboardingId: string): Conflict[] {
    return this.db.prepare("SELECT body FROM affiliate_onboarding_conflicts WHERE onboarding_id=? ORDER BY recorded_at,conflict_ref").all(onboardingId).map(r => JSON.parse(String(r.body)) as Conflict);
  }
  matrix(matrixRef: string): MatrixResult | null {
    const row = this.db.prepare("SELECT body FROM affiliate_onboarding_matrices WHERE matrix_ref=?").get(matrixRef);
    return row ? JSON.parse(String(row.body)) as MatrixResult : null;
  }
  /** Intents whose outcome is unknown, oldest first, including withdrawn ones while their conflict is open. */
  pendingReconciliation(limit = 50): StoredIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OnboardingError("INVALID_LIST_LIMIT", 422);
    return this.db.prepare(`SELECT i.body FROM affiliate_onboarding_intents i WHERE i.state IN ('reconciliationRequired','previewing')
        OR i.state='superseded' AND json_extract(i.body,'$.supersededFrom') IN ('reconciliationRequired','previewing')
          AND EXISTS(SELECT 1 FROM affiliate_onboarding_conflicts c WHERE c.intent_ref=i.intent_ref AND c.resolved=0)
      ORDER BY i.updated_at,i.intent_ref LIMIT ?`).all(limit).map(r => JSON.parse(String(r.body)) as StoredIntent);
  }

  /** The ticket's outputs for one onboarding. Each phase is reported separately; blockers name an owner. */
  output(onboardingId: string): OnboardingOutput {
    const record = this.required(onboardingId);
    const currentVersion = this.currentOffer(record.offerId)?.version ?? null;
    const matrix = record.checkoutTest.matrixRef ? this.matrix(record.checkoutTest.matrixRef) : null;
    const account = record.preflight.providerAccountRef ?? "unverified";
    const blockers: Blocker[] = [...record.preflight.blockers];
    if (record.state !== "readyToInvite" && record.state !== "preflightBlocked" && record.activation.state === "notReady")
      for (const code of activationBlockers(record, currentVersion)) blockers.push({ code, owner: code === "CREATOR_FEE_REQUEST_OPEN" ? "creator" : "operator", sourceRef: null });
    if (record.payoutSetup.state === "waitingForCreator") blockers.push({ code: "PAYOUT_SETUP_WAITING_FOR_CREATOR", owner: "creator", sourceRef: record.payoutSetup.sourceRef });
    if (record.payoutSetup.state === "unknown") blockers.push({ code: "PAYOUT_SETUP_UNKNOWN", owner: "provider", sourceRef: record.payoutSetup.sourceRef });
    for (const c of this.conflicts(onboardingId)) if (c.blocking && !c.resolvedAt) blockers.push({ code: "CONFLICT_" + c.kind.replace(/[A-Z]/g, x => "_" + x).toUpperCase(), owner: "operator", sourceRef: null });
    const latestSent = this.intents(onboardingId).filter(i => i.state === "sent").at(-1);
    return { onboardingId, origin: record.preflight.origin, providerRelationshipRef: record.linkCode.relationshipRef, linkCodeRefs: record.linkCode.linkCodeRefs.map(r => r.ref),
      attributionTestEvidence: (matrix?.attributionTests ?? []).map(test => ({ ref: { provider: record.providerProgram.provider, accountId: account, sourceId: test.sourceRef, url: null },
        observedAt: record.updatedAt, sourceUpdatedAt: null, method: "sandbox-checkout-matrix", value: test, unknownReason: null })),
      phaseReadiness: phaseReadiness(record, currentVersion), payoutSetupState: record.payoutSetup.state,
      blockers: [...new Map(blockers.map(b => [b.code, b])).values()], providerReceipt: latestSent?.providerReceipt ?? null };
  }
}
