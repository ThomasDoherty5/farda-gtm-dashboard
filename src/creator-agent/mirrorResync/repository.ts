import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import type { ReconciliationConflict } from "../mirrorReconciliation/contract.ts";
import type { MirrorReconciliationRepository, StoredFinding } from "../mirrorReconciliation/repository.ts";
import {
  FINAL_STATES, IN_FLIGHT_STATES, MirrorResyncError, REASONS, RESYNC_STATES, cancelResyncSchema, proposeResyncSchema,
  type MirroredFields, type RecordRef, type ResyncState,
} from "./contract.ts";
import type { SourceSide } from "./detect.ts";

/** What one attempt intends to write, fixed before the write and used to judge the read-back. */
export type ResyncPlan = {
  attempt: number; writeKey: string; source: SourceSide;
  mirrorBefore: { version: string | null; fields: MirroredFields | null; localDigest: string | null };
  set: Partial<MirroredFields>;
  /** Plain fingerprints of the differences detected for this attempt. */
  detected: string[];
  /** Set when the write starts: the service-clock instant after which the write must not apply. Null before then. */
  writeDeadline: string | null;
};
export type ResyncProposal = {
  proposalId: string; idempotencyKey: string; ref: RecordRef; fingerprint: string; category: ReconciliationConflict["category"];
  operatorRef: string; reason: string; state: ResyncState; reasonCode: string | null; attempts: number; plan: ResyncPlan | null;
  createdAt: string; updatedAt: string;
};
/** This module's view of a finding: closed only by a verified read-back. The reconciliation check clears its own copy on its next complete run. */
export type FindingResolution = { fingerprint: string; checkId: string; status: "open" | "closed"; reasonCode: string; proposalId: string; updatedAt: string };
export type AuditEntry = { sequence: number; proposalId: string; attempt: number; event: string; state: ResyncState; reasonCode: string | null;
  at: string; detail: unknown };
export type Transition = {
  /** The attempt that produced this step, which the audit entry records. */
  attempt: number;
  state: ResyncState; reasonCode: string | null; event: string;
  /** Replaces the stored plan when given. */
  plan?: ResyncPlan;
  /** Keep the lease, unchanged, because the attempt continues. Otherwise the lease is released. */
  hold?: boolean;
  finding?: FindingResolution["status"];
  detail?: unknown;
};
export type StepContext = { now: number; proposal: ResyncProposal; openFinding: StoredFinding | null };
export type Claim =
  | { kind: "replay"; proposal: ResyncProposal }
  | { kind: "fresh" | "reconcile"; proposal: ResyncProposal; token: string };

/** Categories a resync can repair: the source owns the record and the mirror's copy is wrong or absent. */
const REPAIRABLE: readonly ReconciliationConflict["category"][] = ["amount", "field", "missing_mirror"];
const has = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);
const iso = (at: number) => new Date(at).toISOString();
const quoted = (list: readonly string[]) => list.map(s => `'${s}'`).join(",");

type Row = Record<string, unknown>;
const proposalFrom = (r: Row): ResyncProposal => ({
  proposalId: String(r.proposal_id), idempotencyKey: String(r.idempotency_key),
  ref: { checkId: String(r.check_id), scope: String(r.scope), grain: String(r.grain) as RecordRef["grain"], period: String(r.period),
    currency: String(r.currency), recordKey: String(r.record_key) },
  fingerprint: String(r.fingerprint), category: String(r.category) as ResyncProposal["category"], operatorRef: String(r.operator_ref),
  reason: String(r.reason), state: String(r.state) as ResyncState, reasonCode: r.reason_code === null ? null : String(r.reason_code),
  attempts: Number(r.attempts), plan: r.plan === null ? null : JSON.parse(String(r.plan)) as ResyncPlan,
  createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

/**
 * Hold reasons for a stored finding, mirroring the repair hold in `operationsControls.ts`: the source must own the record,
 * the category must be one a resync can repair, and the finding must name both read versions.
 */
export function resyncHold(conflict: ReconciliationConflict): string | null {
  if (conflict.ownership !== "source" || !REPAIRABLE.includes(conflict.category)) return REASONS.ownershipHeld;
  if (!conflict.authoritativeVersion || !conflict.mirrorVersion || conflict.state !== "open") return REASONS.reconciliationIncomplete;
  return null;
}

/**
 * Resync proposals, attempts and the audit trail on the shared agent database, in `mirror_resync_*` tables. It reads the
 * reconciliation repository's findings and schedule but never writes its tables. Every write is one `BEGIN IMMEDIATE`
 * transaction that reads the clock after the lock is held. No transaction awaits anything: the service resolves its
 * reads and writes first, and each step re-asserts its lease and the finding inside the transaction.
 */
export class MirrorResyncRepository {
  readonly db: DatabaseSync; readonly now: () => number; readonly reconciliation: MirrorReconciliationRepository;
  constructor(reconciliation: MirrorReconciliationRepository, options: { now?: () => number } = {}) {
    this.reconciliation = reconciliation; this.db = reconciliation.db; this.now = options.now ?? reconciliation.now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS mirror_resync_proposals(proposal_id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE NOT NULL,
        request_digest TEXT NOT NULL,check_id TEXT NOT NULL,fingerprint TEXT NOT NULL,scope TEXT NOT NULL,grain TEXT NOT NULL,period TEXT NOT NULL,
        currency TEXT NOT NULL,record_key TEXT NOT NULL,category TEXT NOT NULL,operator_ref TEXT NOT NULL,reason TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (${quoted(RESYNC_STATES)})),reason_code TEXT,attempts INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER,
        plan TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mirror_resync_proposals_finding ON mirror_resync_proposals(fingerprint,state);
      CREATE TABLE IF NOT EXISTS mirror_resync_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,proposal_id TEXT NOT NULL,attempt INTEGER NOT NULL,
        event TEXT NOT NULL,state TEXT NOT NULL,reason_code TEXT,at TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mirror_resync_audit_proposal ON mirror_resync_audit(proposal_id,sequence);
      CREATE TABLE IF NOT EXISTS mirror_resync_findings(fingerprint TEXT PRIMARY KEY,check_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','closed')),reason_code TEXT NOT NULL,proposal_id TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  }

  private clock(): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new MirrorResyncError("INVALID_RESYNC_CLOCK", 500);
    return at;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private row(idempotencyKey: string) {
    return this.db.prepare("SELECT * FROM mirror_resync_proposals WHERE idempotency_key=?").get(idempotencyKey);
  }
  private openFinding(checkId: string, fingerprint: string) {
    return this.reconciliation.findings(checkId, "open").find(f => f.fingerprint === fingerprint) ?? null;
  }
  private audit(p: ResyncProposal, attempt: number, event: string, state: ResyncState, reasonCode: string | null, at: number, detail: unknown = {}) {
    this.db.prepare("INSERT INTO mirror_resync_audit(proposal_id,attempt,event,state,reason_code,at,detail) VALUES(?,?,?,?,?,?,?)")
      .run(p.proposalId, attempt, event, state, reasonCode, iso(at), JSON.stringify(detail));
  }
  private resolve(p: ResyncProposal, status: FindingResolution["status"], reasonCode: string, at: number) {
    this.db.prepare(`INSERT INTO mirror_resync_findings(fingerprint,check_id,status,reason_code,proposal_id,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(fingerprint) DO UPDATE SET status=excluded.status,reason_code=excluded.reason_code,proposal_id=excluded.proposal_id,
        updated_at=excluded.updated_at`).run(p.fingerprint, p.ref.checkId, status, reasonCode, p.proposalId, iso(at));
  }

  /**
   * Records an operator's explicit intent to resync one open finding. It reads and writes nothing outside this database.
   * Replaying the same key with the same request returns the stored proposal; a different request under the key is refused.
   */
  propose(raw: unknown): { proposal: ResyncProposal; duplicate: boolean } {
    const parsed = proposeResyncSchema.safeParse(raw);
    if (!parsed.success) throw new MirrorResyncError("INVALID_RESYNC_PROPOSAL", 422);
    const request = parsed.data, requestDigest = digest(request);
    return this.transaction(() => {
      const at = this.clock();
      const prior = this.row(request.idempotencyKey);
      if (prior) {
        if (String(prior.request_digest) !== requestDigest) throw new MirrorResyncError("IDEMPOTENCY_KEY_REUSED", 409);
        return { proposal: proposalFrom(prior), duplicate: true };
      }
      const finding = this.openFinding(request.checkId, request.fingerprint);
      if (!finding) throw new MirrorResyncError(REASONS.findingNotOpen, 409);
      const hold = resyncHold(finding.conflict);
      if (hold) throw new MirrorResyncError(hold, 409);
      const active = this.db.prepare(`SELECT 1 FROM mirror_resync_proposals WHERE fingerprint=? AND state NOT IN (${quoted(FINAL_STATES)})`)
        .get(request.fingerprint);
      if (active) throw new MirrorResyncError("RESYNC_ALREADY_PROPOSED", 409);
      const proposalId = "mrs-" + digest(["mirror-resync", request.idempotencyKey]).slice(0, 40);
      this.db.prepare(`INSERT INTO mirror_resync_proposals(proposal_id,idempotency_key,request_digest,check_id,fingerprint,scope,grain,period,currency,
          record_key,category,operator_ref,reason,state,reason_code,attempts,lease_token,lease_until,plan,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',NULL,0,NULL,NULL,NULL,?,?)`)
        .run(proposalId, request.idempotencyKey, requestDigest, request.checkId, request.fingerprint, finding.group.scope, finding.group.grain,
          finding.group.period, finding.group.currency, finding.recordKey, finding.category, request.intent.operatorRef, request.intent.reason,
          iso(at), iso(at));
      const proposal = proposalFrom(this.row(request.idempotencyKey)!);
      this.audit(proposal, 0, "proposed", "proposed", null, at, { category: finding.category, authoritativeVersion: finding.conflict.authoritativeVersion,
        mirrorVersion: finding.conflict.mirrorVersion });
      this.resolve(proposal, "open", "RESYNC_PROPOSED", at);
      return { proposal, duplicate: false };
    });
  }

  /** Withdraws a proposal that has not written anything. One that may have written must be read back first. */
  cancel(raw: unknown): ResyncProposal {
    const parsed = cancelResyncSchema.safeParse(raw);
    if (!parsed.success) throw new MirrorResyncError("INVALID_RESYNC_CANCEL", 422);
    return this.transaction(() => {
      const at = this.clock(), row = this.row(parsed.data.idempotencyKey);
      if (!row) throw new MirrorResyncError("RESYNC_PROPOSAL_NOT_FOUND", 404);
      const p = proposalFrom(row);
      if (p.operatorRef !== parsed.data.operatorRef) throw new MirrorResyncError("RESYNC_OPERATOR_MISMATCH", 403);
      if (p.state === "cancelled") return p;
      if (has(FINAL_STATES, p.state)) throw new MirrorResyncError("RESYNC_ALREADY_FINAL", 409);
      if (has(IN_FLIGHT_STATES, p.state) || (row.lease_until !== null && Number(row.lease_until) > at))
        throw new MirrorResyncError("RESYNC_IN_PROGRESS", 409);
      this.db.prepare("UPDATE mirror_resync_proposals SET state='cancelled',reason_code=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE proposal_id=?")
        .run(REASONS.cancelled, iso(at), p.proposalId);
      this.audit(p, p.attempts, "cancelled", "cancelled", REASONS.cancelled, at);
      this.resolve(p, "open", REASONS.cancelled, at);
      return proposalFrom(this.row(p.idempotencyKey)!);
    });
  }

  /**
   * Takes the proposal's lease for one apply call. A final proposal is returned as a replay with nothing written. One that
   * may already have written (`applying` or `uncertain`) is claimed for reconciliation, which only reads back. Anything else
   * starts a new attempt.
   */
  claim(idempotencyKey: string, operatorRef: string, leaseMs: number): Claim {
    return this.transaction(() => {
      const at = this.clock(), row = this.row(idempotencyKey);
      if (!row) throw new MirrorResyncError("RESYNC_PROPOSAL_NOT_FOUND", 404);
      const p = proposalFrom(row);
      if (p.operatorRef !== operatorRef) throw new MirrorResyncError("RESYNC_OPERATOR_MISMATCH", 403);
      if (has(FINAL_STATES, p.state)) return { kind: "replay", proposal: p };
      if (row.lease_until !== null && Number(row.lease_until) > at) throw new MirrorResyncError("RESYNC_IN_PROGRESS", 409);
      const kind = has(IN_FLIGHT_STATES, p.state) ? "reconcile" as const : "fresh" as const, token = randomUUID();
      this.db.prepare(`UPDATE mirror_resync_proposals SET lease_token=?,lease_until=?,attempts=attempts+?,updated_at=? WHERE proposal_id=?`)
        .run(token, at + leaseMs, kind === "fresh" ? 1 : 0, iso(at), p.proposalId);
      return { kind, proposal: proposalFrom(this.row(idempotencyKey)!), token };
    });
  }

  /**
   * Applies one decided transition under the lease. The clock, the proposal and the reconciliation finding are read inside
   * the lock and handed to `decide`, so its checks see current state. If the lease was lost to another caller, the
   * proposal is left as it is, and what this attempt saw is recorded as a `late_result` under its own attempt number.
   */
  step(idempotencyKey: string, token: string, decide: (ctx: StepContext) => Transition): { proposal: ResyncProposal; leaseLost: boolean } {
    return this.transaction(() => {
      const at = this.clock(), row = this.row(idempotencyKey);
      if (!row) throw new MirrorResyncError("RESYNC_PROPOSAL_NOT_FOUND", 404);
      const p = proposalFrom(row);
      const t = decide({ now: at, proposal: p, openFinding: this.openFinding(p.ref.checkId, p.fingerprint) });
      if (row.lease_token !== token) {
        this.audit(p, t.attempt, "late_result", p.state, REASONS.leaseLost, at,
          { intended: { event: t.event, state: t.state, reasonCode: t.reasonCode }, detail: t.detail ?? {} });
        return { proposal: p, leaseLost: true };
      }
      this.db.prepare(`UPDATE mirror_resync_proposals SET state=?,reason_code=?,plan=COALESCE(?,plan),lease_token=?,
          lease_until=CASE WHEN ? THEN lease_until ELSE NULL END,updated_at=? WHERE proposal_id=?`)
        .run(t.state, t.reasonCode, t.plan ? JSON.stringify(t.plan) : null, t.hold ? token : null, t.hold ? 1 : 0, iso(at), p.proposalId);
      this.audit(p, t.attempt, t.event, t.state, t.reasonCode, at, t.detail ?? {});
      if (t.finding) this.resolve(p, t.finding, t.reasonCode ?? t.event, at);
      return { proposal: proposalFrom(this.row(idempotencyKey)!), leaseLost: false };
    });
  }

  proposal(idempotencyKey: string): ResyncProposal | null {
    const row = this.row(idempotencyKey);
    return row ? proposalFrom(row) : null;
  }

  /** AC5. Every recorded step of every attempt for a proposal, oldest first. */
  auditTrail(proposalId: string): AuditEntry[] {
    return this.db.prepare("SELECT * FROM mirror_resync_audit WHERE proposal_id=? ORDER BY sequence").all(proposalId).map(r => ({
      sequence: Number(r.sequence), proposalId: String(r.proposal_id), attempt: Number(r.attempt), event: String(r.event),
      state: String(r.state) as ResyncState, reasonCode: r.reason_code === null ? null : String(r.reason_code), at: String(r.at),
      detail: JSON.parse(String(r.detail)) as unknown }));
  }

  findingResolution(fingerprint: string): FindingResolution | null {
    const r = this.db.prepare("SELECT * FROM mirror_resync_findings WHERE fingerprint=?").get(fingerprint);
    return r ? { fingerprint: String(r.fingerprint), checkId: String(r.check_id), status: String(r.status) as FindingResolution["status"],
      reasonCode: String(r.reason_code), proposalId: String(r.proposal_id), updatedAt: String(r.updated_at) } : null;
  }
}
