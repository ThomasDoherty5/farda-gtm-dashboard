import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { approvalRefSchema, type ApprovalScope, type ProposeCommand } from "../approvals/contract.ts";
import {
  ACCOUNTING_POLICY_UNVERIFIED, EXTERNAL_PAYABLE_ACTION, ExternalPayableError, LIVE_STATES, accountingPolicySchema, adjustmentSchema,
  liabilitySourceSchema, lookupResultSchema, statementSchema, submitResultSchema,
  type AccountingMatch, type AccountingPolicy, type Adjustment, type CommissionPolicyObservation, type Conflict, type ExecutorChannel,
  type IntentState, type LiabilityReason, type LiabilitySource, type LookupResult, type PaymentAttempt, type PaymentIntent, type PayableStatus,
  type Ref, type SettlementReceipt, type StoredLiability,
} from "./contract.ts";
import { computeOutstanding, evaluateLiability, liabilityVersion, paymentBasis, sum } from "./ledger.ts";
import { matchStatementLines, type LineDisposition } from "./matching.ts";
import { resolveUncertainty, type Resolution } from "./paymentIntent.ts";

export type ExternalPayableOptions = {
  scope: ApprovalScope;
  now?: () => number;
  /** THO-284 effective commission-only policy, read from its owner. */
  commissionPolicy: () => CommissionPolicyObservation;
  /** Source accounts the server is configured to read. A reference outside them is a cross-account payload. */
  allowedAccounts: readonly { provider: string; accountId: string }[];
  /** The current responsible owner who may adopt an accounting policy. Null means nobody can, and matching stays held. */
  accountingOwnerRef: string | null;
  /** Wait past a submission deadline before an empty lookup counts as not applied. */
  settleMarginMs?: number;
};
type Row = Record<string, unknown>;
const body = <T>(row: Row | undefined): T => JSON.parse(String(row!.body)) as T;
const iso = (at: number) => new Date(at).toISOString();
const fail = (code: string, status = 409): never => { throw new ExternalPayableError(code, status); };
/** Transient reasons do not withdraw a reserved payment; they only hold it until the source is re-read. */
const TRANSIENT: readonly LiabilityReason[] = ["SOURCE_STALE", "COMMISSION_POLICY_UNKNOWN"];
const basisVersionOf = (source: LiabilitySource) => `basis:${digest(paymentBasis(source))}`;

/**
 * J12 ledger on the shared agent SQLite, in `external_payable_*` tables. Every write is one `BEGIN IMMEDIATE` transaction that reads the
 * clock after the lock is held and awaits nothing. Provider and source calls happen between transactions, in the bridge.
 */
export class ExternalPayableRepository {
  readonly db: DatabaseSync; readonly scope: ApprovalScope; readonly settleMarginMs: number;
  private readonly options: ExternalPayableOptions; private readonly now: () => number;
  constructor(db: DatabaseSync, options: ExternalPayableOptions) {
    this.db = db; this.options = options; this.scope = options.scope; this.now = options.now ?? Date.now; this.settleMarginMs = options.settleMarginMs ?? 10_000;
    const bound = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (!bound || bound.workspace_id !== this.scope.workspaceId || bound.account_id !== this.scope.accountId || this.scope.environment !== "sandbox") fail("DATABASE_SCOPE_MISMATCH", 403);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_scope'").get() &&
      db.prepare("SELECT environment FROM capability_scope WHERE id=1").get()?.environment !== this.scope.environment) fail("DATABASE_SCOPE_MISMATCH", 403);
    if (!Number.isSafeInteger(this.settleMarginMs) || this.settleMarginMs < 0) fail("INVALID_SETTLE_MARGIN", 500);
    db.exec(`CREATE TABLE IF NOT EXISTS external_payable_liabilities(liability_ref TEXT PRIMARY KEY,version TEXT NOT NULL,eligible INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_payable_liability_history(liability_ref TEXT NOT NULL,version TEXT NOT NULL,recorded_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(liability_ref,version));
      CREATE TABLE IF NOT EXISTS external_payable_intents(intent_ref TEXT PRIMARY KEY,liability_ref TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS external_payable_intents_liability ON external_payable_intents(liability_ref,state);
      CREATE TABLE IF NOT EXISTS external_payable_attempts(intent_ref TEXT NOT NULL,attempt_number INTEGER NOT NULL,attempt_ref TEXT UNIQUE NOT NULL,body TEXT NOT NULL,PRIMARY KEY(intent_ref,attempt_number));
      CREATE TABLE IF NOT EXISTS external_payable_receipts(receipt_ref TEXT PRIMARY KEY,intent_ref TEXT NOT NULL,liability_ref TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_payable_adjustments(adjustment_ref TEXT PRIMARY KEY,receipt_ref TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_payable_conflicts(conflict_ref TEXT PRIMARY KEY,liability_ref TEXT NOT NULL,state TEXT NOT NULL,blocking INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_payable_commands(command_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_payable_accounting_policies(seq INTEGER PRIMARY KEY AUTOINCREMENT,version TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_payable_statement_lines(line_ref TEXT PRIMARY KEY,statement_ref TEXT NOT NULL,disposition TEXT NOT NULL,receipt_ref TEXT,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_payable_matches(match_ref TEXT PRIMARY KEY,receipt_ref TEXT UNIQUE NOT NULL,line_ref TEXT UNIQUE NOT NULL,body TEXT NOT NULL);`);
  }

  private clock(): number { const at = this.now(); if (!Number.isSafeInteger(at) || at < 0) fail("INVALID_CLOCK", 500); return at; }
  private tx<T>(work: (now: number) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(this.clock()); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Idempotency: a replayed key returns the stored result; the same key with a different request is refused. */
  private command<T>(kind: string, key: string, request: unknown, work: (now: number) => T): T {
    approvalRefSchema.parse(key);
    return this.tx(now => {
      const commandKey = digest({ scope: this.scope, kind, key }), hash = digest(request);
      const prior = this.db.prepare("SELECT request_hash,result FROM external_payable_commands WHERE command_key=?").get(commandKey);
      if (prior) { if (prior.request_hash !== hash) fail("IDEMPOTENCY_KEY_REUSED"); return JSON.parse(String(prior.result)) as T; }
      const result = work(now);
      this.db.prepare("INSERT INTO external_payable_commands VALUES(?,?,?)").run(commandKey, hash, JSON.stringify(result));
      return result;
    });
  }
  private assertAccounts(refs: readonly Ref[]) {
    for (const ref of refs) if (!this.options.allowedAccounts.some(a => a.provider === ref.provider && a.accountId === ref.accountId)) fail("CROSS_ACCOUNT_PAYLOAD", 403);
  }

  // ---- reads (no transaction; callers inside a transaction see their own writes) ----
  liability(ref: string): StoredLiability | null { const row = this.db.prepare("SELECT body FROM external_payable_liabilities WHERE liability_ref=?").get(ref); return row ? body(row) : null; }
  liabilities(): StoredLiability[] { return this.db.prepare("SELECT body FROM external_payable_liabilities ORDER BY liability_ref").all().map(r => body<StoredLiability>(r)); }
  /** The external payable queue: only eligible liabilities with a positive balance. */
  queue(): StoredLiability[] { return this.liabilities().filter(l => l.eligible); }
  intent(ref: string): PaymentIntent | null { const row = this.db.prepare("SELECT body FROM external_payable_intents WHERE intent_ref=?").get(ref); return row ? body(row) : null; }
  intents(liabilityRef: string): PaymentIntent[] { return this.db.prepare("SELECT body FROM external_payable_intents WHERE liability_ref=? ORDER BY json_extract(body,'$.createdAt'),intent_ref").all(liabilityRef).map(r => body<PaymentIntent>(r)); }
  attempts(intentRef: string): PaymentAttempt[] { return this.db.prepare("SELECT body FROM external_payable_attempts WHERE intent_ref=? ORDER BY attempt_number").all(intentRef).map(r => body<PaymentAttempt>(r)); }
  receipts(filter: { intentRef?: string; liabilityRef?: string } = {}): SettlementReceipt[] {
    const rows = filter.intentRef ? this.db.prepare("SELECT body FROM external_payable_receipts WHERE intent_ref=? ORDER BY receipt_ref").all(filter.intentRef)
      : filter.liabilityRef ? this.db.prepare("SELECT body FROM external_payable_receipts WHERE liability_ref=? ORDER BY receipt_ref").all(filter.liabilityRef)
        : this.db.prepare("SELECT body FROM external_payable_receipts ORDER BY receipt_ref").all();
    return rows.map(r => body<SettlementReceipt>(r));
  }
  adjustments(liabilityRef: string): Adjustment[] {
    return this.db.prepare("SELECT a.body FROM external_payable_adjustments a JOIN external_payable_receipts r ON r.receipt_ref=a.receipt_ref WHERE r.liability_ref=? ORDER BY a.adjustment_ref")
      .all(liabilityRef).map(r => body<Adjustment>(r));
  }
  conflicts(liabilityRef: string): Conflict[] { return this.db.prepare("SELECT body FROM external_payable_conflicts WHERE liability_ref=? ORDER BY json_extract(body,'$.createdAt'),conflict_ref").all(liabilityRef).map(r => body<Conflict>(r)); }
  accountingPolicy(): AccountingPolicy | null { const row = this.db.prepare("SELECT body FROM external_payable_accounting_policies ORDER BY seq DESC LIMIT 1").get(); return row ? body(row) : null; }
  matches(): AccountingMatch[] { return this.db.prepare("SELECT body FROM external_payable_matches ORDER BY match_ref").all().map(r => body<AccountingMatch>(r)); }
  outstanding(liabilityRef: string): ReturnType<typeof computeOutstanding> {
    const l = this.liability(liabilityRef); return l ? computeOutstanding(l.source, this.receipts({ liabilityRef }), this.adjustments(liabilityRef)) : null;
  }

  private saveIntent(intent: PaymentIntent) {
    this.db.prepare("INSERT INTO external_payable_intents VALUES(?,?,?,?) ON CONFLICT(intent_ref) DO UPDATE SET state=excluded.state,body=excluded.body")
      .run(intent.intentRef, intent.liabilityRef, intent.state, JSON.stringify(intent));
  }
  private move(intent: PaymentIntent, state: IntentState, now: number, patch: Partial<PaymentIntent> = {}): PaymentIntent {
    const next = { ...intent, ...patch, state, updatedAt: iso(now) }; this.saveIntent(next); return next;
  }
  private saveAttempt(attempt: PaymentAttempt) {
    this.db.prepare("INSERT INTO external_payable_attempts VALUES(?,?,?,?) ON CONFLICT(intent_ref,attempt_number) DO UPDATE SET body=excluded.body")
      .run(attempt.intentRef, attempt.attemptNumber, attempt.attemptRef, JSON.stringify(attempt));
  }
  private openConflict(now: number, c: Omit<Conflict, "conflictRef" | "state" | "createdAt" | "resolvedAt" | "resolvedBy">): Conflict {
    const conflictRef = `xpay-conflict:${digest({ scope: this.scope, ...c })}`;
    const prior = this.db.prepare("SELECT body FROM external_payable_conflicts WHERE conflict_ref=?").get(conflictRef);
    if (prior) return body(prior);
    const conflict: Conflict = { ...c, conflictRef, state: "open", createdAt: iso(now), resolvedAt: null, resolvedBy: null };
    this.db.prepare("INSERT INTO external_payable_conflicts VALUES(?,?,?,?,?)").run(conflictRef, c.liabilityRef, "open", c.blocking ? 1 : 0, JSON.stringify(conflict));
    return conflict;
  }
  private blocked(liabilityRef: string) { return Boolean(this.db.prepare("SELECT 1 FROM external_payable_conflicts WHERE liability_ref=? AND state='open' AND blocking=1").get(liabilityRef)); }
  private openAttempt(liabilityRef: string) {
    return this.intents(liabilityRef).some(i => this.attempts(i.intentRef).some(a => a.outcome === "open" || a.outcome === "unknown"));
  }

  /**
   * Records one trusted source observation. Content-idempotent. Malformed or cross-account payloads are refused and stored nowhere.
   * A changed payment basis, or a reserved payment the liability no longer covers, withdraws the live payment and opens a blocking conflict.
   */
  registerLiability(raw: unknown): { liability: StoredLiability; withdrawn: string[] } {
    const parsed = liabilitySourceSchema.safeParse(raw);
    if (!parsed.success) fail("MALFORMED_PAYLOAD", 422);
    const source = parsed.data!;
    this.assertAccounts([source.payee.ref, source.acceptedObligation.contractRef, source.invoiceRef, source.deliverableRef, source.route.account,
      ...Object.values(source.evidence).map(e => e.ref), ...source.priorPayments.map(p => p.ref)]);
    return this.tx(now => {
      const version = liabilityVersion(source), previous = this.liability(source.liabilityRef);
      const reasons = evaluateLiability(source, { policy: this.options.commissionPolicy(), now, others: this.liabilities(),
        receipts: this.receipts({ liabilityRef: source.liabilityRef }), adjustments: this.adjustments(source.liabilityRef) });
      const liability: StoredLiability = { liabilityRef: source.liabilityRef, version, source, eligible: reasons.length === 0, reasons, recordedAt: iso(now) };
      this.db.prepare("INSERT INTO external_payable_liabilities VALUES(?,?,?,?) ON CONFLICT(liability_ref) DO UPDATE SET version=excluded.version,eligible=excluded.eligible,body=excluded.body")
        .run(liability.liabilityRef, version, liability.eligible ? 1 : 0, JSON.stringify(liability));
      this.db.prepare("INSERT OR IGNORE INTO external_payable_liability_history VALUES(?,?,?,?)").run(liability.liabilityRef, version, iso(now), JSON.stringify(source));
      const withdrawn: string[] = [], basis = basisVersionOf(source);
      const outstanding = computeOutstanding(source, this.receipts({ liabilityRef: source.liabilityRef }), this.adjustments(source.liabilityRef));
      for (const intent of this.intents(source.liabilityRef).filter(i => LIVE_STATES.includes(i.state))) {
        const preSubmission = intent.state === "proposed" || intent.state === "reserved";
        const lasting = reasons.filter(r => !TRANSIENT.includes(r));
        const cause = intent.basisVersion !== basis ? "BASIS_CHANGED"
          : preSubmission && lasting.length ? lasting[0]!
            : preSubmission && (!outstanding || outstanding.minorUnits < intent.amount.minorUnits) ? "BALANCE_BELOW_PAYMENT" : null;
        if (!cause) continue;
        this.move(intent, "withdrawn", now, { reasonCode: cause });
        this.openConflict(now, { liabilityRef: intent.liabilityRef, intentRef: intent.intentRef, kind: "basisChanged", blocking: true,
          detail: { cause, fromState: intent.state, fromBasis: intent.basisVersion, toBasis: basis, fromVersion: previous?.version ?? null, toVersion: version } });
        withdrawn.push(intent.intentRef);
      }
      return { liability, withdrawn };
    });
  }

  /** A payment intent for the full current outstanding balance, bound to the current liability version. */
  proposeIntent(liabilityRef: string, key: string): PaymentIntent {
    return this.command("propose", key, { liabilityRef }, now => {
      const l = this.liability(liabilityRef) ?? fail("LIABILITY_NOT_FOUND", 404);
      if (!l.eligible) fail(l.reasons[0] ?? "LIABILITY_INELIGIBLE");
      if (Date.parse(l.source.validUntil) <= now) fail("SOURCE_STALE");
      if (l.source.amount.currency !== "USD") fail("CURRENCY_UNSUPPORTED");
      if (this.blocked(liabilityRef)) fail("PAYABLE_CONFLICT_OPEN");
      if (this.intents(liabilityRef).some(i => LIVE_STATES.includes(i.state)) || this.openAttempt(liabilityRef)) fail("PAYMENT_ALREADY_LIVE");
      const outstanding = computeOutstanding(l.source, this.receipts({ liabilityRef }), this.adjustments(liabilityRef));
      if (!outstanding || outstanding.minorUnits <= 0) fail("COMPONENT_ALREADY_SETTLED");
      const policy = this.options.commissionPolicy();
      if (policy.state !== "effective") fail("COMMISSION_POLICY_UNKNOWN");
      const intentRef = `xpay-intent:${digest({ scope: this.scope, liabilityRef, key })}`;
      const intent: PaymentIntent = { intentRef, version: 1, liabilityRef, liabilityVersion: l.version, basisVersion: basisVersionOf(l.source), state: "proposed", reasonCode: null,
        payee: l.source.payee, amount: outstanding!, componentKey: l.source.acceptedObligation.componentKey, termsVersion: l.source.acceptedObligation.termsVersion,
        route: l.source.route, policyVersion: policy.state === "effective" ? policy.policyVersion : "", providerKey: `xpay-key:${digest({ scope: this.scope, intentRef })}`,
        submissionRef: null, createdAt: iso(now), updatedAt: iso(now), reservedAt: null };
      this.saveIntent(intent);
      return intent;
    });
  }

  /**
   * Reserve before submitting to J04. The reservation is live from here, so a basis change during approval withdraws it. A replay of the same
   * key is idempotent only while the reservation stands; another key is refused.
   */
  reserveApproval(intentRef: string, key: string): ProposeCommand {
    approvalRefSchema.parse(key);
    const commandKey = digest({ scope: this.scope, kind: "reserve", key });
    return this.tx(now => {
      const intent = this.intent(intentRef) ?? fail("INTENT_NOT_FOUND", 404);
      const prior = this.db.prepare("SELECT request_hash,result FROM external_payable_commands WHERE command_key=?").get(commandKey);
      if (prior) {
        if (prior.request_hash !== digest({ intentRef })) fail("IDEMPOTENCY_KEY_REUSED");
        if (intent.state !== "reserved") fail("INTENT_NOT_RESERVED");
        return JSON.parse(String(prior.result)) as ProposeCommand;
      }
      if (intent.state === "reserved") fail("INTENT_ALREADY_RESERVED");
      if (intent.state !== "proposed") fail("INTENT_NOT_PROPOSED");
      this.submittable(intent, now, "proposed");
      const next = this.move(intent, "reserved", now, { reservedAt: iso(now) });
      const command: ProposeCommand = { actionKind: EXTERNAL_PAYABLE_ACTION, entityRef: next.intentRef, entityVersion: String(next.version), selectionRefs: [next.intentRef], expectedVersion: 0 };
      this.db.prepare("INSERT INTO external_payable_commands VALUES(?,?,?)").run(commandKey, digest({ intentRef }), JSON.stringify(command));
      return command;
    });
  }

  private submittable(intent: PaymentIntent, now: number, state: IntentState = "reserved") {
    if (intent.state === "withdrawn") fail("INTENT_WITHDRAWN");
    if (intent.state !== state) fail(intent.state === "uncertain" || intent.state === "submitting" ? "PAYMENT_OUTCOME_UNCERTAIN" : "INTENT_NOT_SUBMITTABLE");
    const l = this.liability(intent.liabilityRef) ?? fail("LIABILITY_NOT_FOUND", 404);
    if (basisVersionOf(l.source) !== intent.basisVersion) fail("INTENT_BASIS_CHANGED");
    if (!l.eligible) fail(l.reasons[0] ?? "LIABILITY_INELIGIBLE");
    if (Date.parse(l.source.validUntil) <= now) fail("SOURCE_STALE");
    if (this.blocked(intent.liabilityRef)) fail("PAYABLE_CONFLICT_OPEN");
    const outstanding = computeOutstanding(l.source, this.receipts({ liabilityRef: l.liabilityRef }), this.adjustments(l.liabilityRef));
    if (!outstanding || outstanding.currency !== intent.amount.currency || outstanding.minorUnits < intent.amount.minorUnits) fail("BALANCE_BELOW_PAYMENT");
    return l;
  }
  /** Synchronous re-read by reference for the J04 current-draft fence. Never trusts a caller's copy of the intent. */
  assertSubmittable(intentRef: string, version: number, now: number): { intent: PaymentIntent; liability: StoredLiability } {
    const intent = this.intent(intentRef) ?? fail("INTENT_NOT_FOUND", 404);
    if (intent.version !== version) fail("INTENT_VERSION_CHANGED");
    return { intent, liability: this.submittable(intent, now) };
  }

  /**
   * Durable record of a submission before the provider is called. `assert` runs inside this transaction, so approval, lease and grants are
   * fenced together with the reservation. The provider is called only after this commits; a crash before it means nothing was sent.
   */
  beginSubmission(intentRef: string, attempt: { attemptRef: string; attemptNumber: number; channel: ExecutorChannel }, maxSubmitMs: number, assert: () => void): { intent: PaymentIntent; deadlineAt: string } {
    if (!Number.isSafeInteger(maxSubmitMs) || maxSubmitMs <= 0) fail("INVALID_SUBMIT_DEADLINE", 500);
    return this.tx(now => {
      const intent = this.intent(intentRef) ?? fail("INTENT_NOT_FOUND", 404);
      if (this.attempts(intentRef).some(a => a.outcome === "open" || a.outcome === "unknown" || a.outcome === "accepted")) fail("PAYMENT_ALREADY_SUBMITTED");
      if (this.db.prepare("SELECT 1 FROM external_payable_attempts WHERE attempt_ref=?").get(attempt.attemptRef)) fail("PAYMENT_ATTEMPT_REUSED");
      this.submittable(intent, now);
      assert();
      const deadlineAt = iso(now + maxSubmitMs);
      this.saveAttempt({ intentRef, attemptNumber: this.attempts(intentRef).length + 1, attemptRef: attempt.attemptRef, channel: attempt.channel, startedAt: iso(now), deadlineAt, outcome: "open" });
      return { intent: this.move(intent, "submitting", now), deadlineAt };
    });
  }
  attemptByRef(attemptRef: string): PaymentAttempt | null { const row = this.db.prepare("SELECT body FROM external_payable_attempts WHERE attempt_ref=?").get(attemptRef); return row ? body(row) : null; }

  /** The provider's direct answer to a submission. Malformed answers and thrown errors arrive here as unknown. */
  recordSubmitResult(intentRef: string, attemptRef: string, raw: unknown): { intent: PaymentIntent; outcome: PaymentAttempt["outcome"] } {
    const parsed = submitResultSchema.safeParse(raw);
    return this.tx(now => {
      let intent = this.intent(intentRef) ?? fail("INTENT_NOT_FOUND", 404);
      const attempt = this.attemptByRef(attemptRef);
      if (!attempt || attempt.intentRef !== intentRef) fail("PAYMENT_ATTEMPT_UNKNOWN");
      const result = parsed.success && parsed.data.providerKey === intent.providerKey ? parsed.data : null;
      if (!result) {
        if (attempt!.outcome === "open") this.saveAttempt({ ...attempt!, outcome: "unknown" });
        if (intent.state === "submitting") intent = this.move(intent, "uncertain", now, { reasonCode: "PAYMENT_OUTCOME_UNCERTAIN" });
        return { intent, outcome: "unknown" as const };
      }
      if (result.state === "rejected") {
        if (attempt!.outcome === "open" || attempt!.outcome === "unknown") this.saveAttempt({ ...attempt!, outcome: "rejected" });
        if (intent.state === "submitting" || intent.state === "uncertain") intent = this.move(intent, "failed", now, { reasonCode: result.reasonCode });
        return { intent, outcome: "rejected" as const };
      }
      this.saveAttempt({ ...attempt!, outcome: "accepted" });
      intent = this.acceptSubmission(intent, result.submissionRef, now);
      return { intent, outcome: "accepted" as const };
    });
  }
  private acceptSubmission(intent: PaymentIntent, submissionRef: string, now: number): PaymentIntent {
    if (intent.submissionRef && intent.submissionRef !== submissionRef) {
      this.openConflict(now, { liabilityRef: intent.liabilityRef, intentRef: intent.intentRef, kind: "receiptIdentity", blocking: true, detail: { expected: intent.submissionRef, observed: submissionRef } });
      return intent;
    }
    if (intent.state === "withdrawn") {
      this.openConflict(now, { liabilityRef: intent.liabilityRef, intentRef: intent.intentRef, kind: "lateOutcome", blocking: true, detail: { submissionRef } });
      return this.move(intent, "withdrawn", now, { submissionRef });
    }
    if (intent.state === "submitting" || intent.state === "uncertain") return this.move(intent, "submitted", now, { submissionRef, reasonCode: null });
    return intent.submissionRef ? intent : this.move(intent, intent.state, now, { submissionRef });
  }

  /**
   * Provider lookup by the original key: resolves an uncertain submission and records source-confirmed settlement. Receipts are facts and
   * are never deleted; a late or excessive one opens a blocking conflict instead of changing a withdrawn payment.
   */
  recordLookup(intentRef: string, raw: unknown): { intent: PaymentIntent; resolution: Resolution } {
    const parsed = lookupResultSchema.safeParse(raw);
    const lookup: LookupResult = parsed.success ? parsed.data : { state: "unknown", reasonCode: "PROVIDER_LOOKUP_MALFORMED" };
    return this.tx(now => {
      let intent = this.intent(intentRef) ?? fail("INTENT_NOT_FOUND", 404);
      const attempts = this.attempts(intentRef), latest = attempts.at(-1);
      if (lookup.state !== "unknown" && lookup.providerKey !== intent.providerKey) {
        this.openConflict(now, { liabilityRef: intent.liabilityRef, intentRef, kind: "receiptIdentity", blocking: true, detail: { reason: "PROVIDER_KEY_MISMATCH" } });
        return { intent, resolution: "pending" as const };
      }
      if (lookup.state === "found") {
        for (const a of attempts) if (a.outcome === "open" || a.outcome === "unknown") this.saveAttempt({ ...a, outcome: "accepted" });
        intent = this.acceptSubmission(intent, lookup.submissionRef, now);
        if (intent.submissionRef !== lookup.submissionRef) return { intent, resolution: "pending" as const };
        for (const s of lookup.settlements) {
          const receipt: SettlementReceipt = { receiptRef: s.receiptRef, intentRef, liabilityRef: intent.liabilityRef, submissionRef: lookup.submissionRef,
            amount: s.amount, settledAt: s.settledAt, observedAt: lookup.observedAt };
          const prior = this.db.prepare("SELECT body FROM external_payable_receipts WHERE receipt_ref=?").get(s.receiptRef);
          if (prior) {
            const p = body<SettlementReceipt>(prior);
            if (p.intentRef !== intentRef || digest(p.amount) !== digest(s.amount) || p.settledAt !== s.settledAt)
              this.openConflict(now, { liabilityRef: intent.liabilityRef, intentRef, kind: "receiptIdentity", blocking: true, detail: { receiptRef: s.receiptRef } });
            continue;
          }
          if (s.amount.currency !== intent.amount.currency || s.amount.minorUnits <= 0) {
            this.openConflict(now, { liabilityRef: intent.liabilityRef, intentRef, kind: "currencyMismatch", blocking: true, detail: { receiptRef: s.receiptRef, currency: s.amount.currency } });
            continue;
          }
          this.db.prepare("INSERT INTO external_payable_receipts VALUES(?,?,?,?)").run(s.receiptRef, intentRef, intent.liabilityRef, JSON.stringify(receipt));
        }
        const settled = sum(intent.amount.currency, this.receipts({ intentRef }).map(r => r.amount)) ?? 0;
        if (settled > intent.amount.minorUnits)
          this.openConflict(now, { liabilityRef: intent.liabilityRef, intentRef, kind: "overSettlement", blocking: true, detail: { settledMinor: settled, approvedMinor: intent.amount.minorUnits } });
        if (intent.state === "withdrawn") {
          if (settled > 0) this.openConflict(now, { liabilityRef: intent.liabilityRef, intentRef, kind: "lateOutcome", blocking: true, detail: { settledMinor: settled } });
          return { intent, resolution: "found" as const };
        }
        if (["submitted", "settled", "partial"].includes(intent.state)) {
          // A pending submission stays live even with some receipts: more may still settle, so no second payment can start.
          const state: IntentState = settled >= intent.amount.minorUnits ? "settled"
            : lookup.status === "pending" ? "submitted"
              : settled > 0 ? "partial" : lookup.status === "failed" ? "failed" : "submitted";
          intent = this.move(intent, state, now, { reasonCode: state === "failed" || state === "partial" ? lookup.reasonCode : null });
        }
        return { intent, resolution: "found" as const };
      }
      const resolution: Resolution = !latest ? "notApplied" : resolveUncertainty(latest, lookup, now, this.settleMarginMs);
      if (resolution === "notApplied") {
        for (const a of attempts) if (a.outcome === "open" || a.outcome === "unknown") this.saveAttempt({ ...a, outcome: "notApplied" });
        // Conclusive non-application. A retry still needs the same J04 proof and a renewed preflight, under the same provider key.
        if (intent.state === "submitting" || intent.state === "uncertain") intent = this.move(intent, "reserved", now, { reasonCode: "PAYMENT_NOT_APPLIED" });
      } else if (intent.state === "submitting") intent = this.move(intent, "uncertain", now, { reasonCode: "PAYMENT_OUTCOME_PENDING" });
      return { intent, resolution };
    });
  }

  /** Links a return of funds to its original receipt. The receipt stays; the balance rises by the returned amount. */
  recordAdjustment(raw: unknown, key: string): Adjustment {
    const parsed = adjustmentSchema.safeParse(raw);
    if (!parsed.success) fail("MALFORMED_PAYLOAD", 422);
    const adjustment = parsed.data!;
    this.assertAccounts([adjustment.evidence]);
    return this.command("adjust", key, adjustment, () => {
      const receiptRow = this.db.prepare("SELECT body FROM external_payable_receipts WHERE receipt_ref=?").get(adjustment.receiptRef) ?? fail("RECEIPT_NOT_FOUND", 404);
      const receipt = body<SettlementReceipt>(receiptRow);
      const prior = this.db.prepare("SELECT body FROM external_payable_adjustments WHERE adjustment_ref=?").get(adjustment.adjustmentRef);
      if (prior) { if (digest(body(prior)) !== digest(adjustment)) fail("ADJUSTMENT_REFERENCE_REUSED"); return adjustment; }
      if (adjustment.amount.currency !== receipt.amount.currency) fail("CURRENCY_MISMATCH");
      const existing = this.db.prepare("SELECT body FROM external_payable_adjustments WHERE receipt_ref=?").all(receipt.receiptRef).map(r => body<Adjustment>(r).amount);
      const total = sum(receipt.amount.currency, [...existing, adjustment.amount]);
      if (total === null || total > receipt.amount.minorUnits) fail("ADJUSTMENT_EXCEEDS_RECEIPT");
      this.db.prepare("INSERT INTO external_payable_adjustments VALUES(?,?,?)").run(adjustment.adjustmentRef, adjustment.receiptRef, JSON.stringify(adjustment));
      return adjustment;
    });
  }

  resolveConflict(conflictRef: string, resolverRef: string, key: string): Conflict {
    approvalRefSchema.parse(resolverRef);
    return this.command("resolve", key, { conflictRef, resolverRef }, now => {
      const row = this.db.prepare("SELECT body FROM external_payable_conflicts WHERE conflict_ref=?").get(conflictRef) ?? fail("CONFLICT_NOT_FOUND", 404);
      const conflict = body<Conflict>(row);
      if (conflict.state === "resolved") return conflict;
      const next: Conflict = { ...conflict, state: "resolved", resolvedAt: iso(now), resolvedBy: resolverRef };
      this.db.prepare("UPDATE external_payable_conflicts SET state='resolved',body=? WHERE conflict_ref=?").run(JSON.stringify(next), conflictRef);
      return next;
    });
  }

  /** Only the configured responsible owner can adopt a policy. Its mapping is stored as adopted; nothing here invents an account or rule. */
  adoptAccountingPolicy(raw: unknown, key: string): AccountingPolicy {
    const parsed = accountingPolicySchema.safeParse(raw);
    if (!parsed.success) fail("MALFORMED_PAYLOAD", 422);
    const policy = parsed.data!;
    if (!this.options.accountingOwnerRef || policy.adoptedBy !== this.options.accountingOwnerRef) fail("ACCOUNTING_OWNER_UNVERIFIED", 403);
    this.assertAccounts([policy.documentRef, ...Object.values(policy.mapping)]);
    return this.command("adopt-policy", key, policy, () => {
      if (this.db.prepare("SELECT 1 FROM external_payable_accounting_policies WHERE version=?").get(policy.version)) fail("ACCOUNTING_POLICY_VERSION_REUSED");
      this.db.prepare("INSERT INTO external_payable_accounting_policies(version,body) VALUES(?,?)").run(policy.version, JSON.stringify(policy));
      return policy;
    });
  }

  /**
   * J12-09. Matches settled receipts to statement lines once, under the adopted policy. Held with ACCOUNTING_POLICY_UNVERIFIED, storing nothing,
   * while no policy is adopted. Ingestion is local bookkeeping: it has no provider and cannot start a payment or touch native settlement.
   */
  ingestStatement(raw: unknown, key: string): { state: "held"; reasonCode: typeof ACCOUNTING_POLICY_UNVERIFIED } | { state: "recorded"; dispositions: LineDisposition[]; matches: AccountingMatch[] } {
    const parsed = statementSchema.safeParse(raw);
    if (!parsed.success) fail("MALFORMED_PAYLOAD", 422);
    const statement = parsed.data!;
    this.assertAccounts([statement.account]);
    if (!this.accountingPolicy()) return { state: "held", reasonCode: ACCOUNTING_POLICY_UNVERIFIED };
    return this.command("statement", key, statement, now => {
      const policy = this.accountingPolicy() ?? fail(ACCOUNTING_POLICY_UNVERIFIED);
      const receipts = new Map(this.receipts().map(r => [r.receiptRef, r]));
      const matched = new Set(this.matches().map(m => m.receiptRef));
      const seen = new Set(this.db.prepare("SELECT line_ref FROM external_payable_statement_lines").all().map(r => String(r.line_ref)));
      const dispositions = matchStatementLines(statement, receipts, matched, seen), matches: AccountingMatch[] = [];
      for (const d of dispositions) {
        const line = statement.lines.find(l => l.lineRef === d.lineRef)!;
        if (d.disposition !== "duplicateLine")
          this.db.prepare("INSERT INTO external_payable_statement_lines VALUES(?,?,?,?,?)").run(d.lineRef, statement.statementRef, d.disposition, d.receiptRef, JSON.stringify(line));
        if (d.disposition !== "matched") continue;
        const receipt = receipts.get(d.receiptRef)!;
        const match: AccountingMatch = { matchRef: `xpay-match:${digest({ scope: this.scope, receiptRef: receipt.receiptRef })}`, receiptRef: receipt.receiptRef,
          liabilityRef: receipt.liabilityRef, statementRef: statement.statementRef, lineRef: d.lineRef, amount: receipt.amount,
          policyRef: policy.policyRef, policyVersion: policy.version, mapping: policy.mapping, matchedAt: iso(now) };
        this.db.prepare("INSERT INTO external_payable_matches VALUES(?,?,?,?)").run(match.matchRef, match.receiptRef, match.lineRef, JSON.stringify(match));
        matches.push(match);
      }
      return { state: "recorded" as const, dispositions, matches };
    });
  }

  /** The ticket's output for one liability. Approval state comes from J04; approved is not submitted, and submitted is not settled. */
  status(liabilityRef: string, approval: "approved" | "pending" | "held" = "pending"): PayableStatus {
    const l = this.liability(liabilityRef) ?? fail("LIABILITY_NOT_FOUND", 404);
    const intent = this.intents(liabilityRef).at(-1) ?? null, receipts = this.receipts({ liabilityRef });
    const lastReceipt = receipts.sort((a, b) => a.settledAt.localeCompare(b.settledAt) || a.receiptRef.localeCompare(b.receiptRef)).at(-1) ?? null;
    const match = lastReceipt ? this.matches().find(m => m.receiptRef === lastReceipt.receiptRef) ?? null : null;
    const conflict = this.conflicts(liabilityRef).find(c => c.state === "open" && c.blocking);
    const base = { liabilityRef, submissionRef: intent?.submissionRef ?? null, settlementReceipt: lastReceipt?.receiptRef ?? null,
      outstandingBalance: computeOutstanding(l.source, receipts, this.adjustments(liabilityRef)), accountingMatch: match?.matchRef ?? null };
    if (conflict) return { ...base, paymentState: "blocked", exceptionReason: `CONFLICT_${conflict.kind.toUpperCase()}` };
    const state = intent?.state;
    if (state === "settled" || state === "partial" || state === "failed" || state === "submitted") return { ...base, paymentState: state, exceptionReason: state === "submitted" ? null : intent!.reasonCode };
    if (state === "uncertain" || state === "submitting") return { ...base, paymentState: "uncertain", exceptionReason: intent!.reasonCode ?? "PAYMENT_IN_FLIGHT" };
    if (!l.eligible) return { ...base, paymentState: "blocked", exceptionReason: l.reasons[0] ?? "LIABILITY_INELIGIBLE" };
    if (state === "reserved" && approval === "approved") return { ...base, paymentState: "approved", exceptionReason: null };
    return { ...base, paymentState: "blocked", exceptionReason: state === "withdrawn" ? intent!.reasonCode : state ? "APPROVAL_PENDING" : "PAYMENT_NOT_PROPOSED" };
  }
}
