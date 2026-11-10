import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest, loadApprovedBindings } from "../config.ts";
import { POLICY_VERSION } from "../assessmentSchema.ts";
import { ApprovalError, type ApprovalRead, type CurrentApprovalResult, type DispatchApprovalBinding, type VerifiedApprovalProof } from "../approvals/contract.ts";
import { BASELINE_VERSION_REF, CALIBRATION_ACTION_KIND, CALIBRATION_MODE, CALIBRATION_SCHEMA_VERSION, CalibrationError, EVIDENCE_BASIS_MINIMUMS, EVIDENCE_POLICY_PATHS,
  MAX_PROPOSAL_LIFETIME_MS, baselineEvidencePolicy, numericBindingSchema, proposalInputSchema, refSchema, rollbackInputSchema,
  type BlockedReport, type CalibrationProposal, type ConfigVersion, type EvidenceBasis, type EvidencePolicyConfig, type NumericBinding,
  type PolicyChange, type PromotionReceipt, type ProposalEvent, type ProposalRead, type ProposalState, type ProvisionalReport, type RefusedReport,
  type RollbackBasis, type Sufficiency } from "./contract.ts";
import { applyChangeSet, assessEvidenceBasis, diffConfigs, inferenceRefusals, numericCalibrationBlocked } from "./proposal.ts";
import { compareConfigs } from "./compare.ts";

type Scope = { workspaceId: string; accountId: string };
/** The J04 approval repository surface this module consumes. It must share this SQLite connection so the final fence is atomic. */
export type CalibrationApprovalAuthority = {
  resolveCurrentProof: (binding: DispatchApprovalBinding) => Promise<CurrentApprovalResult>;
  assertCurrentProof: (proof: VerifiedApprovalProof, now: number) => void;
  readApproval: (ref: string, manifestVersion?: number) => ApprovalRead | null;
};
export type CalibrationRepositoryOptions = { scope: Scope; now?: () => number; numericBindings?: NumericBinding[]; approvals?: CalibrationApprovalAuthority };
export type ProposalOutcome = { status: "proposed"; read: ProposalRead } | BlockedReport | ProvisionalReport | RefusedReport;

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const fromCode = (cause: unknown) => cause instanceof CalibrationError ? cause : cause instanceof ApprovalError ? new CalibrationError("APPROVAL_HELD", 409, [cause.code]) : cause;

/** Approved v3 numeric identity. Evidence-policy versions carry it unchanged and never edit it. */
export function approvedNumericBindings(): NumericBinding[] {
  return loadApprovedBindings().map(binding => numericBindingSchema.parse({ modelId: binding.current.modelId, version: binding.current.version, hash: binding.hash, numericHash: binding.numericHash }));
}

/**
 * Versioned evidence-policy configurations and human-reviewed proposals in the shared agent SQLite file.
 * Versions, proposals, outcomes and command receipts are append-only; only the head pointer moves, and only on promotion.
 */
export class CalibrationRepository {
  private readonly db: DatabaseSync;
  readonly scope: Scope;
  private readonly clock: () => number;
  private readonly numericBindings: NumericBinding[];
  private readonly approvals: CalibrationApprovalAuthority | null;

  constructor(db: DatabaseSync, options: CalibrationRepositoryOptions) {
    this.db = db; this.scope = { workspaceId: options.scope.workspaceId, accountId: options.scope.accountId }; this.clock = options.now ?? Date.now;
    this.approvals = options.approvals ?? null;
    this.numericBindings = (options.numericBindings ?? approvedNumericBindings()).map(binding => numericBindingSchema.parse(binding));
    if (this.numericBindings.length === 0 || new Set(this.numericBindings.map(b => b.modelId)).size !== this.numericBindings.length) throw new CalibrationError("NUMERIC_BASELINE_REQUIRED", 500);
    const bound = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (bound?.workspace_id !== this.scope.workspaceId || bound.account_id !== this.scope.accountId) throw new CalibrationError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS calibration_versions(version_ref TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, config_hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calibration_head(id INTEGER PRIMARY KEY CHECK(id=1), version_ref TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS calibration_proposals(proposal_ref TEXT PRIMARY KEY, proposal_hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calibration_outcomes(proposal_ref TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calibration_commands(key TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS calibration_versions_immutable_u BEFORE UPDATE ON calibration_versions BEGIN SELECT RAISE(ABORT,'CALIBRATION_VERSION_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS calibration_versions_immutable_d BEFORE DELETE ON calibration_versions BEGIN SELECT RAISE(ABORT,'CALIBRATION_VERSION_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS calibration_proposals_immutable_u BEFORE UPDATE ON calibration_proposals BEGIN SELECT RAISE(ABORT,'CALIBRATION_PROPOSAL_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS calibration_proposals_immutable_d BEFORE DELETE ON calibration_proposals BEGIN SELECT RAISE(ABORT,'CALIBRATION_PROPOSAL_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS calibration_outcomes_immutable_u BEFORE UPDATE ON calibration_outcomes BEGIN SELECT RAISE(ABORT,'CALIBRATION_OUTCOME_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS calibration_outcomes_immutable_d BEFORE DELETE ON calibration_outcomes BEGIN SELECT RAISE(ABORT,'CALIBRATION_OUTCOME_IMMUTABLE'); END;`);
    this.tx(() => this.seedBaseline());
  }

  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value)) throw new CalibrationError("INVALID_CLOCK", 500); return value; }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }
  private seedBaseline() {
    const config = baselineEvidencePolicy(), configHash = digest(config), numericBindingsHash = digest(this.numericBindings);
    const row = this.db.prepare("SELECT body FROM calibration_versions WHERE seq=1").get();
    if (row) {
      const stored = parse<ConfigVersion>(row.body);
      if (stored.versionRef !== BASELINE_VERSION_REF || stored.configHash !== configHash || digest(stored.config) !== configHash) throw new CalibrationError("BASELINE_CHANGED", 500);
      if (stored.numericBindingsHash !== numericBindingsHash) throw new CalibrationError("NUMERIC_BASELINE_CHANGED", 500);
      return;
    }
    const version: ConfigVersion = { schemaVersion: CALIBRATION_SCHEMA_VERSION, versionRef: BASELINE_VERSION_REF, seq: 1, parentVersionRef: null, config, configHash,
      numericBindings: this.numericBindings, numericBindingsHash, origin: { kind: "baseline", source: "policy.ts launch gates and ratingPolicy anchors", policyVersion: POLICY_VERSION },
      createdAt: new Date(this.now()).toISOString() };
    this.db.prepare("INSERT INTO calibration_versions VALUES(?,?,?,?)").run(version.versionRef, version.seq, configHash, JSON.stringify(version));
    this.db.prepare("INSERT INTO calibration_head VALUES(1,?,1)").run(version.versionRef);
  }
  private commandKey(operation: string, principalRef: string | null, key: string) {
    if (!KEY.test(key)) throw new CalibrationError("INVALID_IDEMPOTENCY_KEY", 422);
    if (principalRef !== null && !refSchema.safeParse(principalRef).success) throw new CalibrationError("VALIDATION_FAILED", 422);
    return digest({ scope: this.scope, operation, principalRef, key });
  }
  private replay<T>(key: string, input: unknown): T | null {
    const row = this.db.prepare("SELECT hash,result FROM calibration_commands WHERE key=?").get(key);
    if (!row) return null;
    if (row.hash !== digest(input)) throw new CalibrationError("IDEMPOTENCY_KEY_REUSED", 409);
    return parse<T>(row.result);
  }
  private saveCommand(key: string, input: unknown, result: unknown) { this.db.prepare("INSERT INTO calibration_commands VALUES(?,?,?)").run(key, digest(input), JSON.stringify(result)); }

  head(): ConfigVersion { const row = this.db.prepare("SELECT version_ref FROM calibration_head WHERE id=1").get(); return this.version(String(row!.version_ref))!; }
  version(ref: string): ConfigVersion | null { const row = this.db.prepare("SELECT body FROM calibration_versions WHERE version_ref=?").get(ref); return row ? parse<ConfigVersion>(row.body) : null; }
  history(): ConfigVersion[] { return this.db.prepare("SELECT body FROM calibration_versions ORDER BY seq").all().map(row => parse<ConfigVersion>(row.body)); }
  private proposal(ref: string): CalibrationProposal | null { const row = this.db.prepare("SELECT body FROM calibration_proposals WHERE proposal_ref=?").get(ref); return row ? parse<CalibrationProposal>(row.body) : null; }
  private outcome(ref: string): ProposalEvent | null { const row = this.db.prepare("SELECT body FROM calibration_outcomes WHERE proposal_ref=?").get(ref); return row ? parse<ProposalEvent>(row.body) : null; }
  private state(proposal: CalibrationProposal, now: number): ProposalState {
    const outcome = this.outcome(proposal.proposalRef);
    if (outcome) return outcome.kind;
    if (now >= Date.parse(proposal.expiresAt)) return "expired";
    return this.head().versionRef === proposal.baseVersionRef ? "open" : "stale";
  }
  readProposal(ref: string): ProposalRead | null {
    const proposal = this.proposal(ref); if (!proposal) return null;
    const outcome = this.outcome(ref);
    return { proposal, events: outcome ? [outcome] : [], state: this.state(proposal, this.now()) };
  }

  /** Any request for numeric weight, band or outcome calibration returns a structured block in this mode. */
  requestNumericCalibration(): BlockedReport { return numericCalibrationBlocked(); }

  createProposal(raw: unknown, actor: { principalRef: string }, idempotencyKey: string): ProposalOutcome {
    if (raw && typeof raw === "object" && (raw as { mode?: unknown }).mode === "numericCalibration") return numericCalibrationBlocked();
    const parsed = proposalInputSchema.safeParse(raw);
    if (!parsed.success) throw new CalibrationError("VALIDATION_FAILED", 422);
    const input = parsed.data, key = this.commandKey("propose", actor.principalRef, idempotencyKey);
    const prior = this.replay<ProposalOutcome>(key, input); if (prior) return this.refreshed(prior);
    const base = this.version(input.baseVersionRef); if (!base) throw new CalibrationError("BASE_VERSION_NOT_FOUND", 404);
    const changes: PolicyChange[] = input.changes.map(change => ({ path: change.path, before: change.before, after: change.after, rationale: change.rationale }));
    const applied = applyChangeSet(base.config, changes);
    if (applied.status === "refused") return this.finish(key, input, applied);
    const refusals = inferenceRefusals([input.rationale, ...changes.map(c => c.rationale), ...changes.filter(c => c.path.startsWith("anchors.")).map(c => String(c.after))]);
    if (refusals.length) return this.finish(key, input, { status: "refused", mode: CALIBRATION_MODE, reasonCodes: refusals, detail: ["Proposals may not rest on or introduce demographic, diagnosis or sales inference."] });
    const sufficiency = assessEvidenceBasis(input.evidenceBasis, changes);
    if (sufficiency.status !== "sufficient") return this.finish(key, input, sufficiency);
    return this.persist(key, input, { kind: "change", base, rationale: input.rationale, changes, config: applied.config, basis: input.evidenceBasis,
      sufficiency: { status: "sufficient", minimums: EVIDENCE_BASIS_MINIMUMS, observed: sufficiency.observed }, candidateSet: input.candidateSet,
      expiresAt: input.expiresAt, actor: actor.principalRef, rollbackTarget: null });
  }

  /** Rollback is an ordinary human-approved proposal whose after-values are an earlier version's config. */
  proposeRollback(raw: unknown, actor: { principalRef: string }, idempotencyKey: string): ProposalOutcome {
    const parsed = rollbackInputSchema.safeParse(raw);
    if (!parsed.success) throw new CalibrationError("VALIDATION_FAILED", 422);
    const input = parsed.data, key = this.commandKey("rollback", actor.principalRef, idempotencyKey);
    const prior = this.replay<ProposalOutcome>(key, input); if (prior) return this.refreshed(prior);
    const base = this.version(input.baseVersionRef), target = this.version(input.basis.targetVersionRef);
    if (!base || !target) throw new CalibrationError("BASE_VERSION_NOT_FOUND", 404);
    if (target.seq >= base.seq) return this.finish(key, input, { status: "refused", mode: CALIBRATION_MODE, reasonCodes: ["ROLLBACK_TARGET_INVALID"], detail: ["A rollback targets an earlier version in history."] });
    const changes = diffConfigs(base.config, target.config, EVIDENCE_POLICY_PATHS).map(change => ({ ...change, rationale: `Restore ${target.versionRef}: ${input.basis.reason}` }));
    if (!changes.length) return this.finish(key, input, { status: "refused", mode: CALIBRATION_MODE, reasonCodes: ["NO_OP_ROLLBACK"], detail: ["The target config equals the base config."] });
    const refusals = inferenceRefusals([input.basis.reason]);
    if (refusals.length) return this.finish(key, input, { status: "refused", mode: CALIBRATION_MODE, reasonCodes: refusals, detail: ["Proposals may not rest on or introduce demographic, diagnosis or sales inference."] });
    const applied = applyChangeSet(base.config, changes);
    if (applied.status === "refused") return this.finish(key, input, applied);
    return this.persist(key, input, { kind: "rollback", base, rationale: `Rollback to ${target.versionRef}: ${input.basis.reason}`, changes, config: applied.config, basis: input.basis,
      sufficiency: { status: "notRequired", reason: "ROLLBACK_TO_APPROVED_VERSION" }, candidateSet: input.candidateSet, expiresAt: input.expiresAt,
      actor: actor.principalRef, rollbackTarget: target.versionRef });
  }

  private refreshed(outcome: ProposalOutcome): ProposalOutcome {
    return outcome.status === "proposed" ? { status: "proposed", read: this.readProposal(outcome.read.proposal.proposalRef)! } : outcome;
  }
  private finish(key: string, input: unknown, report: BlockedReport | ProvisionalReport | RefusedReport): ProposalOutcome {
    return this.tx(() => { const prior = this.replay<ProposalOutcome>(key, input); if (prior) return prior; this.saveCommand(key, input, report); return report; });
  }
  private persist(key: string, input: unknown, p: { kind: "change" | "rollback"; base: ConfigVersion; rationale: string; changes: PolicyChange[]; config: EvidencePolicyConfig;
    basis: EvidenceBasis | RollbackBasis; sufficiency: Sufficiency; candidateSet: Parameters<typeof compareConfigs>[3]; expiresAt: string; actor: string; rollbackTarget: string | null }): ProposalOutcome {
    const comparison = compareConfigs(p.base.config, p.config, p.changes, p.candidateSet);
    const now = this.now(), expires = Date.parse(p.expiresAt);
    if (expires <= now || expires - now > MAX_PROPOSAL_LIFETIME_MS) throw new CalibrationError("EXPIRY_INVALID", 422);
    const body: Omit<CalibrationProposal, "proposalHash"> = { schemaVersion: CALIBRATION_SCHEMA_VERSION, mode: CALIBRATION_MODE, kind: p.kind,
      proposalRef: `calibration:proposal:${randomUUID()}`, scope: this.scope, baseVersionRef: p.base.versionRef, baseConfigHash: p.base.configHash,
      rollbackTargetVersionRef: p.rollbackTarget, rationale: p.rationale, changes: p.changes, evidenceBasis: p.basis, sufficiency: p.sufficiency, comparison,
      proposedConfig: p.config, proposedConfigHash: digest(p.config), numericBindingsHash: p.base.numericBindingsHash, proposedBy: p.actor,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString() };
    const proposal: CalibrationProposal = { ...body, proposalHash: digest(body) };
    return this.tx(() => {
      const prior = this.replay<ProposalOutcome>(key, input); if (prior) return this.refreshed(prior);
      if (this.head().versionRef !== p.base.versionRef) throw new CalibrationError("BASE_NOT_CURRENT", 409);
      this.db.prepare("INSERT INTO calibration_proposals VALUES(?,?,?)").run(proposal.proposalRef, proposal.proposalHash, JSON.stringify(proposal));
      const outcome: ProposalOutcome = { status: "proposed", read: { proposal, events: [], state: "open" } };
      this.saveCommand(key, input, outcome);
      return outcome;
    });
  }

  /** Synchronous current-proposal fence for the J04 registry. Throws when the proposal can no longer be approved. */
  approvableProposal(ref: string, now: number): CalibrationProposal {
    const proposal = this.proposal(ref); if (!proposal) throw new CalibrationError("PROPOSAL_NOT_FOUND", 404);
    const state = this.state(proposal, now);
    if (state !== "open") throw new CalibrationError(state === "stale" ? "BASE_NOT_CURRENT" : `PROPOSAL_${state.toUpperCase()}`, 409);
    return proposal;
  }

  /** Records a verified J04 rejection or cancellation. An approval is never recorded here; it is applied only by `promote`. */
  recordDecision(proposalRef: string, approvalRef: string, manifestVersion?: number): ProposalRead {
    if (!this.approvals) throw new CalibrationError("APPROVAL_AUTHORITY_UNCONFIGURED", 503);
    const proposal = this.proposal(proposalRef); if (!proposal) throw new CalibrationError("PROPOSAL_NOT_FOUND", 404);
    const read = this.approvals.readApproval(approvalRef, manifestVersion), item = read?.manifest.items[0];
    if (!read || read.manifest.draft.actionKind !== CALIBRATION_ACTION_KIND || read.manifest.items.length !== 1 || item!.itemRef !== proposalRef || item!.payloadHash !== proposal.proposalHash
      || read.manifest.scope.workspaceId !== this.scope.workspaceId || read.manifest.scope.accountId !== this.scope.accountId) throw new CalibrationError("APPROVAL_BINDING_MISMATCH", 409);
    const receipt = read.decisionReceipt;
    if (!receipt || (receipt.decision !== "rejected" && receipt.decision !== "canceled")) throw new CalibrationError("DECISION_NOT_TERMINAL", 409);
    const event: ProposalEvent = { kind: receipt.decision === "rejected" ? "rejected" : "withdrawn", at: new Date(this.now()).toISOString(), approvalRef: receipt.approvalRef,
      manifestVersion: receipt.manifestVersion, receiptRef: receipt.receiptRef, principalRef: receipt.principalRef, personRef: receipt.personRef, decidedAt: receipt.decidedAt };
    this.tx(() => {
      const existing = this.outcome(proposalRef);
      if (existing) { if (existing.kind !== event.kind || !("receiptRef" in existing) || existing.receiptRef !== event.receiptRef) throw new CalibrationError("PROPOSAL_ALREADY_CLOSED", 409); return; }
      this.db.prepare("INSERT INTO calibration_outcomes VALUES(?,?)").run(proposalRef, JSON.stringify(event));
    });
    return this.readProposal(proposalRef)!;
  }

  /** Records expiry for every unresolved proposal whose deadline has passed. */
  expireDue(): string[] {
    return this.tx(() => {
      const now = this.now(), expired: string[] = [];
      for (const row of this.db.prepare("SELECT p.body FROM calibration_proposals p LEFT JOIN calibration_outcomes o ON o.proposal_ref=p.proposal_ref WHERE o.proposal_ref IS NULL ORDER BY p.rowid").all()) {
        const proposal = parse<CalibrationProposal>(row.body);
        if (now < Date.parse(proposal.expiresAt)) continue;
        this.recordExpiry(proposal, now); expired.push(proposal.proposalRef);
      }
      return expired;
    });
  }
  private recordExpiry(proposal: CalibrationProposal, now: number) {
    const event: ProposalEvent = { kind: "expired", at: new Date(now).toISOString(), expiresAt: proposal.expiresAt };
    this.db.prepare("INSERT INTO calibration_outcomes VALUES(?,?)").run(proposal.proposalRef, JSON.stringify(event));
  }

  /**
   * Applies an approved proposal. Requires a current J04 policy-change proof naming this exact proposal; the proof is
   * re-asserted inside the final transaction. Creates a new immutable version; the base version is never modified.
   */
  async promote(input: { proposalRef: string; approval: DispatchApprovalBinding }, idempotencyKey: string): Promise<PromotionReceipt> {
    const key = this.commandKey("promote", null, idempotencyKey);
    const prior = this.replay<PromotionReceipt>(key, input); if (prior) return prior;
    if (!this.approvals) throw new CalibrationError("APPROVAL_AUTHORITY_UNCONFIGURED", 503);
    const proposal = this.proposal(input.proposalRef); if (!proposal) throw new CalibrationError("PROPOSAL_NOT_FOUND", 404);
    const binding = input.approval;
    if (binding.actionKind !== CALIBRATION_ACTION_KIND || binding.phase !== "policyChange" || binding.itemRef !== proposal.proposalRef || binding.payloadHash !== proposal.proposalHash
      || binding.itemVersion !== proposal.proposalHash || binding.scope.workspaceId !== this.scope.workspaceId || binding.scope.accountId !== this.scope.accountId)
      throw new CalibrationError("APPROVAL_BINDING_MISMATCH", 409);
    let current: CurrentApprovalResult;
    try { current = await this.approvals.resolveCurrentProof(binding); } catch (cause) { throw fromCode(cause); }
    if (current.state !== "verified") throw new CalibrationError("APPROVAL_HELD", 409, current.reasonCodes);
    const proof = current.proof;
    let result: PromotionReceipt | "expired";
    try {
      result = this.tx(() => {
        const now = this.now();
        const repeated = this.replay<PromotionReceipt>(key, input); if (repeated) return repeated;
        if (this.outcome(proposal.proposalRef)) throw new CalibrationError("PROPOSAL_ALREADY_CLOSED", 409);
        if (now >= Date.parse(proposal.expiresAt)) { this.recordExpiry(proposal, now); return "expired" as const; }
        const head = this.head();
        if (head.versionRef !== proposal.baseVersionRef) throw new CalibrationError("BASE_NOT_CURRENT", 409);
        const reapplied = applyChangeSet(head.config, proposal.changes);
        if (reapplied.status !== "ok" || digest(reapplied.config) !== proposal.proposedConfigHash || head.configHash !== proposal.baseConfigHash) throw new CalibrationError("PROPOSAL_INTEGRITY_FAILED", 409);
        const baseline = this.version(BASELINE_VERSION_REF)!;
        if (head.numericBindingsHash !== baseline.numericBindingsHash || proposal.numericBindingsHash !== baseline.numericBindingsHash) throw new CalibrationError("NUMERIC_BASELINE_CHANGED", 409);
        this.approvals!.assertCurrentProof(proof, now);
        const receipt = proof.decisionReceipt, seq = head.seq + 1, versionRef = `evidence-policy.rev-${seq}`;
        const approval = { approvalRef: receipt.approvalRef, manifestVersion: receipt.manifestVersion, manifestHash: receipt.manifestHash, receiptRef: receipt.receiptRef,
          principalRef: receipt.principalRef, personRef: receipt.personRef, decidedAt: receipt.decidedAt, verificationRef: proof.verificationRef };
        const version: ConfigVersion = { schemaVersion: CALIBRATION_SCHEMA_VERSION, versionRef, seq, parentVersionRef: head.versionRef, config: reapplied.config,
          configHash: proposal.proposedConfigHash, numericBindings: head.numericBindings, numericBindingsHash: head.numericBindingsHash,
          origin: { kind: "promotion", proposalRef: proposal.proposalRef, proposalHash: proposal.proposalHash, proposalKind: proposal.kind, rollbackOf: proposal.rollbackTargetVersionRef, approval },
          createdAt: new Date(now).toISOString() };
        this.db.prepare("INSERT INTO calibration_versions VALUES(?,?,?,?)").run(versionRef, seq, version.configHash, JSON.stringify(version));
        this.db.prepare("UPDATE calibration_head SET version_ref=?, seq=? WHERE id=1").run(versionRef, seq);
        const event: ProposalEvent = { kind: "promoted", at: version.createdAt, versionRef, approvalRef: receipt.approvalRef, receiptRef: receipt.receiptRef, principalRef: receipt.principalRef, personRef: receipt.personRef };
        this.db.prepare("INSERT INTO calibration_outcomes VALUES(?,?)").run(proposal.proposalRef, JSON.stringify(event));
        const promotion: PromotionReceipt = { status: "promoted", versionRef, seq, parentVersionRef: head.versionRef, configHash: version.configHash, proposalRef: proposal.proposalRef, approval, promotedAt: version.createdAt };
        this.saveCommand(key, input, promotion);
        return promotion;
      });
    } catch (cause) { throw fromCode(cause); }
    if (result === "expired") throw new CalibrationError("PROPOSAL_EXPIRED", 409);
    return result;
  }
}
