import { digest } from "../config.ts";
import { reconciliationPublicIds } from "../mirrorReconciliation/comparator.ts";
import {
  MIRRORED_FIELDS, MirrorResyncError, MirrorWriteUncertainError, REASONS, applyResyncSchema, mirrorReadSchema, mirrorWriteResultSchema,
  sourceReadSchema, type AuthoritativeSourceReader, type MirrorRead, type MirrorRow, type MirrorWriter, type MirroredFields, type RecordRef,
  type SourceRead, type SourceRecord,
} from "./contract.ts";
import { detectRecordDifference, type MirrorSide, type SourceSide } from "./detect.ts";
import {
  resyncHold, type FindingResolution, type MirrorResyncRepository, type ResyncPlan, type ResyncProposal, type StepContext, type Transition,
} from "./repository.ts";

export type MirrorResyncOptions = {
  source: AuthoritativeSourceReader;
  writer: MirrorWriter;
  /** The same server-held secret the reconciliation repository uses, such as the operations secret. */
  secret: string;
  /** The oldest source read a resync may rely on. Defaults to 15 minutes. */
  maxSourceAgeMs?: number;
  /** How long one apply call holds the proposal. The writer's own timeout must be shorter. Defaults to 2 minutes. */
  leaseMs?: number;
};
export type ResyncOutcome = { proposal: ResyncProposal; replayed: boolean; finding: FindingResolution | null };
type Ack = { state: "applied"; version: string } | { state: "uncertain"; reason: string } | null;

const sameRecord = (r: Pick<SourceRecord, "key" | "scope" | "grain" | "period" | "currency">, ref: RecordRef) =>
  r.key === ref.recordKey && r.scope === ref.scope && r.grain === ref.grain && r.period === ref.period && r.currency === ref.currency;
const fieldsOf = (r: SourceRecord | MirrorRow): MirroredFields => ({ amountMinor: r.amountMinor, ...(r.status === undefined ? {} : { status: r.status }) });

/** AC4. A source read can back a resync only when access, completeness, version, identity and freshness are all certain. */
function certainSource(read: SourceRead, ref: RecordRef, now: number, maxAgeMs: number): { ok: SourceSide } | { reason: string } {
  if (read.access !== "granted") return { reason: REASONS.sourceAccess };
  if (!read.complete) return { reason: REASONS.sourceIncomplete };
  if (!read.version) return { reason: REASONS.sourceVersion };
  if (!read.record) return { reason: REASONS.sourceAbsent };
  if (!sameRecord(read.record, ref)) return { reason: REASONS.sourceIdentity };
  const observed = Date.parse(read.observedAt);
  if (observed > now) return { reason: REASONS.sourceFreshness };
  if (now - observed > maxAgeMs) return { reason: REASONS.sourceStale };
  return { ok: { record: read.record, version: read.version, observedAt: new Date(observed).toISOString() } };
}
function certainMirror(read: MirrorRead, ref: RecordRef): { ok: MirrorSide } | { reason: string } {
  if (read.state === "failed") return { reason: REASONS.mirrorRead };
  if (read.state === "absent") return { ok: { row: null, version: null, observedAt: read.observedAt } };
  if (!sameRecord(read.row, ref)) return { reason: REASONS.mirrorIdentity };
  return { ok: { row: read.row, version: read.version, observedAt: read.observedAt } };
}

/**
 * Explicit, verified resync of one mirrored record from its authoritative source. An operator proposes it for an open
 * reconciliation finding, then applies it. Applying:
 *
 * 1. reads the source and the mirror, then, inside the lock, refuses unless every source property is certain, and detects
 *    the difference with the reconciliation comparator;
 * 2. reads both again just before writing, and refuses unless neither version moved;
 * 3. writes only the differing mirrored fields, with compare-and-set on the mirror version;
 * 4. reads the mirror back and closes the finding only if the record now matches and its local fields are untouched.
 *
 * A write with an unknown outcome is never retried as is. The next apply call with the same key reads the mirror back and
 * settles the attempt from what it finds. Every step is recorded in the audit trail.
 */
export class MirrorResyncService {
  readonly repo: MirrorResyncRepository;
  private readonly source: AuthoritativeSourceReader; private readonly writer: MirrorWriter; private readonly secret: string;
  private readonly maxSourceAgeMs: number; private readonly leaseMs: number;
  constructor(repo: MirrorResyncRepository, options: MirrorResyncOptions) {
    reconciliationPublicIds(options.secret);
    this.repo = repo; this.source = options.source; this.writer = options.writer; this.secret = options.secret;
    this.maxSourceAgeMs = options.maxSourceAgeMs ?? 15 * 60_000; this.leaseMs = options.leaseMs ?? 2 * 60_000;
    if (!Number.isSafeInteger(this.maxSourceAgeMs) || this.maxSourceAgeMs <= 0 || !Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0)
      throw new MirrorResyncError("INVALID_RESYNC_OPTIONS", 500);
  }

  propose(raw: unknown) { return this.repo.propose(raw); }
  cancel(raw: unknown) { return this.repo.cancel(raw); }

  async apply(raw: unknown): Promise<ResyncOutcome> {
    const parsed = applyResyncSchema.safeParse(raw);
    if (!parsed.success) throw new MirrorResyncError("INVALID_RESYNC_APPLY", 422);
    const { idempotencyKey, operatorRef } = parsed.data;
    const claim = this.repo.claim(idempotencyKey, operatorRef, this.leaseMs);
    if (claim.kind === "replay") return this.outcome(claim.proposal, true);
    const ref = claim.proposal.ref;
    const step = (decide: (ctx: StepContext) => Transition) => {
      const result = this.repo.step(idempotencyKey, claim.token, this.leaseMs, decide);
      if (result.leaseLost) throw new MirrorResyncError(REASONS.leaseLost, 409);
      return result.proposal;
    };

    if (claim.kind === "reconcile") {
      // AC7. The last attempt may have written. Read back before anything else; this call never writes.
      const plan = claim.proposal.plan;
      if (!plan) throw new MirrorResyncError("RESYNC_PLAN_MISSING", 500);
      const back = await this.readMirror(ref, "readBack");
      return this.outcome(step(ctx => this.settle(ctx, plan, back, null)), false);
    }

    const source = await this.readSource(ref), mirror = await this.readMirror(ref, "read");
    const planned: { plan?: ResyncPlan } = {};
    let proposal = step(ctx => {
      const decided = this.plan(ctx, source, mirror);
      if ("transition" in decided) return decided.transition;
      planned.plan = decided.plan;
      return { state: ctx.proposal.state, reasonCode: ctx.proposal.reasonCode, event: "planned", plan: decided.plan, hold: true,
        detail: { ...this.planDetail(decided.plan), matchesFinding: decided.plan.detected.includes(ctx.proposal.fingerprint) } };
    });
    const plan = planned.plan;
    if (!plan) return this.outcome(proposal, false);

    // AC4. Recheck both versions immediately before the write.
    const source2 = await this.readSource(ref), mirror2 = await this.readMirror(ref, "read");
    const gate = { writing: false };
    proposal = step(ctx => {
      const stop = (state: "refused" | "conflict", reasonCode: string, extra: object = {}): Transition =>
        ({ state, reasonCode, event: state, finding: "open", detail: { attempt: plan.attempt, phase: "recheck", ...extra } });
      if (!ctx.openFinding) return stop("refused", REASONS.findingNotOpen);
      const s = certainSource(source2, ref, ctx.now, this.maxSourceAgeMs);
      if ("reason" in s) return stop("refused", s.reason);
      if (s.ok.version !== plan.source.version || digest(s.ok.record) !== digest(plan.source.record))
        return stop("conflict", REASONS.sourceVersionChanged, { planned: plan.source.version, current: s.ok.version });
      const m = certainMirror(mirror2, ref);
      if ("reason" in m) return stop("refused", m.reason);
      if (m.ok.version !== plan.mirrorBefore.version)
        return stop("conflict", REASONS.mirrorVersionChanged, { planned: plan.mirrorBefore.version, current: m.ok.version });
      gate.writing = true;
      return { state: "applying", reasonCode: null, event: "applying", hold: true,
        detail: { attempt: plan.attempt, writeKey: plan.writeKey, expectedVersion: plan.mirrorBefore.version, set: plan.set } };
    });
    if (!gate.writing) return this.outcome(proposal, false);

    let ack: Ack;
    try {
      const result = mirrorWriteResultSchema.safeParse(await this.writer.write({ ref, expectedVersion: plan.mirrorBefore.version, set: plan.set,
        writeKey: plan.writeKey }));
      if (!result.success) ack = { state: "uncertain", reason: "WRITE_RESPONSE_INVALID" };
      else if (result.data.state === "conflict") {
        const currentVersion = result.data.currentVersion;
        return this.outcome(step(() => ({ state: "conflict", reasonCode: REASONS.mirrorVersionChanged, event: "conflict", finding: "open",
          detail: { attempt: plan.attempt, phase: "write", planned: plan.mirrorBefore.version, current: currentVersion } })), false);
      } else if (result.data.state === "rejected") {
        const reason = result.data.reason;
        return this.outcome(step(() => ({ state: "refused", reasonCode: REASONS.writeRejected, event: "refused", finding: "open",
          detail: { attempt: plan.attempt, phase: "write", reason } })), false);
      } else ack = result.data;
    } catch (error) {
      ack = { state: "uncertain", reason: error instanceof MirrorWriteUncertainError ? error.reason : "WRITE_THREW" };
    }

    // AC8. Re-read the mirror whatever the acknowledgement said.
    const back = await this.readMirror(ref, "readBack");
    return this.outcome(step(ctx => this.settle(ctx, plan, back, ack)), false);
  }

  private outcome(proposal: ResyncProposal, replayed: boolean): ResyncOutcome {
    return { proposal, replayed, finding: this.repo.findingResolution(proposal.fingerprint) };
  }
  private async readSource(ref: RecordRef): Promise<SourceRead> {
    try {
      const parsed = sourceReadSchema.safeParse(await this.source.read(ref));
      return parsed.success ? parsed.data : { access: "unknown", reason: "SOURCE_RESPONSE_INVALID" };
    } catch { return { access: "unknown", reason: "SOURCE_READ_THREW" }; }
  }
  private async readMirror(ref: RecordRef, how: "read" | "readBack"): Promise<MirrorRead> {
    try {
      const parsed = mirrorReadSchema.safeParse(await (how === "read" ? this.writer.read(ref) : this.writer.readBack(ref)));
      return parsed.success ? parsed.data : { state: "failed", reason: "MIRROR_RESPONSE_INVALID" };
    } catch { return { state: "failed", reason: "MIRROR_READ_THREW" }; }
  }
  private planDetail(plan: ResyncPlan) {
    return { attempt: plan.attempt, writeKey: plan.writeKey, sourceVersion: plan.source.version, sourceObservedAt: plan.source.observedAt,
      expectedVersion: plan.mirrorBefore.version, mirrorBefore: plan.mirrorBefore.fields, localDigest: plan.mirrorBefore.localDigest, set: plan.set,
      detected: plan.detected };
  }

  /** AC2 and AC4, inside the lock: refuse on any uncertainty, otherwise detect the difference and fix what the attempt will write. */
  private plan(ctx: StepContext, sourceRead: SourceRead, mirrorRead: MirrorRead): { plan: ResyncPlan } | { transition: Transition } {
    const p = ctx.proposal, ref = p.ref;
    const refuse = (reasonCode: string, extra: object = {}) =>
      ({ transition: { state: "refused" as const, reasonCode, event: "refused", finding: "open" as const, detail: { attempt: p.attempts, phase: "plan", ...extra } } });
    if (!ctx.openFinding) return refuse(REASONS.findingNotOpen);
    const hold = resyncHold(ctx.openFinding.conflict);
    if (hold) return refuse(hold);
    const s = certainSource(sourceRead, ref, ctx.now, this.maxSourceAgeMs);
    if ("reason" in s) return refuse(s.reason);
    const m = certainMirror(mirrorRead, ref);
    if ("reason" in m) return refuse(m.reason);
    const schedule = this.repo.reconciliation.schedule(ref.checkId);
    if (!schedule) return refuse(REASONS.reconciliationIncomplete, { detail: "CHECK_SCHEDULE_NOT_FOUND" });
    const diff = detectRecordDifference(schedule, ref, s.ok, m.ok, ctx.now, this.secret, `${p.proposalId}.a${p.attempts}`);
    if (diff.kind === "incomplete") return refuse(diff.reason, { detail: diff.detail });
    if (diff.kind === "matched") return { transition: { state: "already_matched", reasonCode: REASONS.alreadyMatched, event: "already_matched",
      finding: "closed", detail: { attempt: p.attempts, sourceVersion: s.ok.version, mirrorVersion: m.ok.version } } };
    // Differences no field write can repair, such as a duplicate, stay with their owner.
    if (!Object.keys(diff.set).length) return refuse(REASONS.ownershipHeld, { detected: diff.findings.map(f => f.conflict.category) });
    return { plan: { attempt: p.attempts, writeKey: `${p.proposalId}.a${p.attempts}`, source: s.ok, set: diff.set,
      mirrorBefore: { version: m.ok.version, fields: m.ok.row ? fieldsOf(m.ok.row) : null, localDigest: m.ok.row ? digest(m.ok.row.local) : null },
      detected: diff.findings.map(f => f.fingerprint) } };
  }

  /** AC5, AC7 and AC8: judge an attempt from the read-back alone. Only a matching record with untouched local fields closes the finding. */
  private settle(ctx: StepContext, plan: ResyncPlan, back: MirrorRead, ack: Ack): Transition {
    const ref = ctx.proposal.ref;
    const detail = (extra: object = {}) => ({ attempt: plan.attempt, writeKey: plan.writeKey, ack, expectedVersion: plan.mirrorBefore.version, ...extra });
    const open = (state: "uncertain" | "not_applied" | "mismatch", reasonCode: string, extra: object = {}): Transition =>
      ({ state, reasonCode, event: state, finding: "open", detail: detail(extra) });
    if (back.state === "failed") return open("uncertain", REASONS.readBackFailed, { readBack: back.reason });
    const versionAfter = back.state === "found" ? back.version : null;
    if (versionAfter === plan.mirrorBefore.version) {
      // Unchanged. With no acknowledgement this proves the write did not land, so a later explicit apply may try again.
      return ack?.state === "applied" ? open("uncertain", REASONS.readBackContradictsAck, { versionAfter })
        : open("not_applied", REASONS.writeNotApplied, { versionAfter });
    }
    if (back.state === "absent") return open("mismatch", REASONS.mirrorRowRemoved, { versionAfter });
    if (!sameRecord(back.row, ref)) return open("mismatch", REASONS.mirrorIdentity, { versionAfter });
    const localAfter = digest(back.row.local), fieldsAfter = fieldsOf(back.row);
    const seen = { versionAfter, fieldsAfter, localDigestBefore: plan.mirrorBefore.localDigest, localDigestAfter: localAfter };
    if (plan.mirrorBefore.localDigest !== null && localAfter !== plan.mirrorBefore.localDigest) return open("mismatch", REASONS.localFieldsChanged, seen);
    const schedule = this.repo.reconciliation.schedule(ref.checkId);
    if (!schedule) return open("uncertain", REASONS.reconciliationIncomplete, seen);
    const diff = detectRecordDifference(schedule, ref, plan.source, { row: back.row, version: back.version, observedAt: back.observedAt }, ctx.now,
      this.secret, `${ctx.proposal.proposalId}.a${plan.attempt}.readback`);
    if (diff.kind === "matched") return { state: "verified", reasonCode: REASONS.verified, event: "verified", finding: "closed", detail: detail(seen) };
    if (diff.kind === "incomplete") return open("uncertain", diff.reason, { ...seen, detail: diff.detail });
    const keys = MIRRORED_FIELDS.filter(k => k in plan.set), landed = keys.filter(k => back.row[k] === plan.set[k]);
    return open("mismatch", landed.length > 0 && landed.length < keys.length ? REASONS.partialApply : REASONS.readBackMismatch,
      { ...seen, landed, remaining: diff.findings.map(f => f.conflict.category) });
  }
}
