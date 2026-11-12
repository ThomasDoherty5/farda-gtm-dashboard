import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { reconciliationPublicIds } from "../mirrorReconciliation/comparator.ts";
import {
  MIRRORED_FIELDS, MirrorResyncError, MirrorWriteUncertainError, REASONS, applyResyncSchema, mirrorReadSchema, mirrorWriteResultSchema,
  originalMirrorAttemptSchema, sourceReadSchema, type AuthoritativeSourceReader, type MirrorRead, type MirrorRow, type MirrorWriteIdentity,
  type MirrorWriter, type MirroredFields, type OriginalMirrorAttempt, type RecordRef,
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
  /** How long one apply call holds the proposal, from its claim. Must exceed the writer's `maxWriteMs` plus `settleMarginMs`. Defaults to 2 minutes. */
  leaseMs?: number;
  /**
   * How long after a write's deadline an unacknowledged write is still treated as possibly landing, to allow for clock skew
   * and provider lag. Defaults to 10 seconds.
   */
  settleMarginMs?: number;
};
export type ResyncOutcome = { proposal: ResyncProposal; replayed: boolean; finding: FindingResolution | null };
type Ack = { state: "applied"; version: string } | { state: "uncertain"; reason: string } | null;
type ReleaseFence = (proposal: ResyncProposal, phase: "prepare" | "write" | "readback", command: MirrorWriteIdentity | null) => void;

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
  const observed = Date.parse(read.observedAt), watermark = Date.parse(read.sourceAsOf);
  if (observed > now) return { reason: REASONS.sourceFreshness };
  if (now - observed > maxAgeMs || now - watermark > maxAgeMs) return { reason: REASONS.sourceStale };
  if (watermark > observed) return { reason: REASONS.sourceFreshness };
  return { ok: { record: read.record, version: read.version, observedAt: read.observedAt, sourceAsOf: read.sourceAsOf } };
}
function certainMirror(read: MirrorRead, ref: RecordRef, now: number, maxAgeMs: number): { ok: MirrorSide } | { reason: string } {
  if (read.state === "failed") return { reason: REASONS.mirrorRead };
  const observed = Date.parse(read.observedAt), watermark = Date.parse(read.sourceAsOf);
  if (observed > now || watermark > observed || now - watermark > maxAgeMs) return { reason: "MIRROR_FRESHNESS_UNCERTAIN" };
  const timing = { observedAt: read.observedAt, sourceAsOf: read.sourceAsOf };
  if (read.state === "absent") return { ok: { row: null, version: null, ...timing } };
  if (!sameRecord(read.row, ref)) return { reason: REASONS.mirrorIdentity };
  return { ok: { row: read.row, version: read.version, ...timing } };
}

/**
 * Explicit, verified resync of one mirrored record from its authoritative source. An operator proposes it for an open
 * reconciliation finding, then applies it. Applying:
 *
 * 1. reads the source and the mirror, then, inside the lock, refuses unless every source property is certain, and detects
 *    the difference with the reconciliation comparator;
 * 2. reads both again just before writing, and refuses unless neither version moved;
 * 3. writes only the differing mirrored fields, with compare-and-set on the mirror version;
 * 4. reads both sides back and closes the finding only if the current source matches and its local fields are untouched.
 *
 * The existing approval owner must provide the current release fence. An uncertain write keeps its original key until
 * the writer proves its outcome. Every step is recorded in the audit trail.
 */
export class MirrorResyncService {
  readonly repo: MirrorResyncRepository;
  private readonly source: AuthoritativeSourceReader; private readonly writer: MirrorWriter; private readonly secret: string;
  private readonly maxSourceAgeMs: number; private readonly leaseMs: number; private readonly settleMarginMs: number;
  constructor(repo: MirrorResyncRepository, options: MirrorResyncOptions) {
    reconciliationPublicIds(options.secret);
    this.repo = repo; this.source = options.source; this.writer = options.writer; this.secret = options.secret;
    this.maxSourceAgeMs = options.maxSourceAgeMs ?? 15 * 60_000; this.leaseMs = options.leaseMs ?? 2 * 60_000;
    this.settleMarginMs = options.settleMarginMs ?? 10_000;
    const positive = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
    if (![this.maxSourceAgeMs, this.leaseMs, this.settleMarginMs, this.writer.maxWriteMs].every(positive))
      throw new MirrorResyncError("INVALID_RESYNC_OPTIONS", 500);
    // A write must be able to finish, and its outcome settle, while the apply call that started it still holds the lease.
    if (this.writer.maxWriteMs + this.settleMarginMs >= this.leaseMs) throw new MirrorResyncError("RESYNC_LEASE_SHORTER_THAN_WRITE", 500);
  }

  propose(raw: unknown) { return this.repo.propose(raw); }
  cancel(raw: unknown) { return this.repo.cancel(raw); }

  async apply(raw: unknown, release?: ReleaseFence): Promise<ResyncOutcome> {
    const parsed = applyResyncSchema.safeParse(raw);
    if (!parsed.success) throw new MirrorResyncError("INVALID_RESYNC_APPLY", 422);
    if (!release) throw new MirrorResyncError("RESYNC_APPROVAL_UNVERIFIED", 403);
    const { idempotencyKey, operatorRef } = parsed.data;
    const authorize = (proposal: ResyncProposal, phase: Parameters<ReleaseFence>[1], command: MirrorWriteIdentity | null = null) =>
      assertSynchronousVoid(() => release(structuredClone(proposal), phase, command ? structuredClone(command) : null));
    const claim = this.repo.claim(idempotencyKey, operatorRef, this.leaseMs, (proposal, kind) =>
      authorize(proposal, kind === "fresh" ? "prepare" : "readback", proposal.plan?.writeDeadline ? this.command(proposal.ref, proposal.plan) : null));
    if (claim.kind === "replay") return this.outcome(claim.proposal, true);
    const ref = claim.proposal.ref;
    const step = (decide: (ctx: StepContext) => Transition) => {
      const result = this.repo.step(idempotencyKey, claim.token, decide);
      if (result.leaseLost) throw new MirrorResyncError(REASONS.leaseLost, 409);
      return result.proposal;
    };

    if (claim.kind === "reconcile") {
      // AC7. The last attempt may have written. Read back before anything else; this call never writes.
      const plan = claim.proposal.plan;
      if (!plan) throw new MirrorResyncError("RESYNC_PLAN_MISSING", 500);
      const observed = await this.readAfter(ref, plan, null);
      return this.outcome(step(ctx => {
        authorize(ctx.proposal, "readback", this.command(ref, plan));
        return this.settle(ctx, plan, observed, null);
      }), false);
    }

    const source = await this.readSource(ref), mirror = await this.readMirror(ref, "read");
    const planned: { plan?: ResyncPlan } = {};
    let proposal = step(ctx => {
      const decided = this.plan(ctx, source, mirror);
      if ("transition" in decided) return decided.transition;
      planned.plan = decided.plan;
      return { attempt: decided.plan.attempt, state: ctx.proposal.state, reasonCode: ctx.proposal.reasonCode, event: "planned", plan: decided.plan, hold: true,
        detail: { ...this.planDetail(decided.plan), matchesFinding: decided.plan.detected.includes(ctx.proposal.fingerprint) } };
    });
    if (!planned.plan) return this.outcome(proposal, false);
    const plan = planned.plan;

    // AC4. Recheck both versions immediately before the write.
    const mirror2 = await this.readMirror(ref, "read"), source2 = await this.readSource(ref);
    const gate: { writing?: ResyncPlan } = {};
    proposal = step(ctx => {
      const stop = (state: "refused" | "conflict", reasonCode: string, extra: object = {}): Transition =>
        ({ attempt: plan.attempt, state, reasonCode, event: state, finding: "open", detail: { attempt: plan.attempt, phase: "recheck", ...extra } });
      if (!ctx.openFinding) return stop("refused", REASONS.findingNotOpen);
      const s = certainSource(source2, ref, ctx.now, this.maxSourceAgeMs);
      if ("reason" in s) return stop("refused", s.reason);
      if (s.ok.version !== plan.source.version || digest(s.ok.record) !== digest(plan.source.record))
        return stop("conflict", REASONS.sourceVersionChanged, { planned: plan.source.version, current: s.ok.version });
      const m = certainMirror(mirror2, ref, ctx.now, this.maxSourceAgeMs);
      if ("reason" in m) return stop("refused", m.reason);
      if (m.ok.version !== plan.mirrorBefore.version ||
          digest(m.ok.row ? fieldsOf(m.ok.row) : null) !== digest(plan.mirrorBefore.fields) ||
          (m.ok.row ? digest(m.ok.row.local) : null) !== plan.mirrorBefore.localDigest)
        return stop("conflict", REASONS.mirrorVersionChanged, { planned: plan.mirrorBefore.version, current: m.ok.version });
      // The deadline is fixed on the service clock inside the lock, and stored before the write starts.
      gate.writing = { ...plan, writeStartedAt: new Date(ctx.now).toISOString(),
        writeDeadline: new Date(ctx.now + this.writer.maxWriteMs).toISOString() };
      authorize(ctx.proposal, "write", this.command(ref, gate.writing));
      return { attempt: plan.attempt, state: "applying", reasonCode: null, event: "applying", hold: true, plan: gate.writing,
        detail: { attempt: plan.attempt, writeKey: plan.writeKey, expectedVersion: plan.mirrorBefore.version, set: plan.set,
          deadline: gate.writing.writeDeadline } };
    });
    if (!gate.writing) return this.outcome(proposal, false);
    const writing = gate.writing;

    // Only the provider call is guarded: an error from a later step, such as a lost lease, must not read as an uncertain write.
    const command = this.command(ref, writing);
    try { authorize(proposal, "write", command); }
    catch {
      return this.outcome(step(() => ({ attempt: writing.attempt, state: "refused", reasonCode: "RESYNC_APPROVAL_REVOKED",
        event: "refused", finding: "open" })), false);
    }
    const written = await (async () => this.writer.write({ ...command, signal: AbortSignal.timeout(this.writer.maxWriteMs) }))()
      .then(response => {
        const result = mirrorWriteResultSchema.safeParse(response);
        return result.success ? result.data : { state: "uncertain" as const, reason: "WRITE_RESPONSE_INVALID" };
      }, (error: unknown) => ({ state: "uncertain" as const, reason: error instanceof MirrorWriteUncertainError ? error.reason : "WRITE_THREW" }));
    if (written.state === "conflict") {
      const current = written.currentVersion;
      return this.outcome(step(() => ({ attempt: writing.attempt, state: "conflict", reasonCode: REASONS.mirrorVersionChanged, event: "conflict",
        finding: "open", detail: { attempt: writing.attempt, phase: "write", planned: writing.mirrorBefore.version, current } })), false);
    }
    if (written.state === "rejected") {
      const reason = written.reason;
      return this.outcome(step(() => ({ attempt: writing.attempt, state: "refused", reasonCode: REASONS.writeRejected, event: "refused",
        finding: "open", detail: { attempt: writing.attempt, phase: "write", reason } })), false);
    }
    const ack: Ack = written;

    const observed = await this.readAfter(ref, writing, ack);
    return this.outcome(step(ctx => {
      authorize(ctx.proposal, "readback", this.command(ref, writing));
      return this.settle(ctx, writing, observed, ack);
    }), false);
  }

  private command(ref: RecordRef, plan: ResyncPlan): MirrorWriteIdentity {
    if (!plan.writeDeadline) throw new MirrorResyncError("RESYNC_PLAN_MISSING", 500);
    return { ref, expectedVersion: plan.mirrorBefore.version, expectedSourceVersion: plan.source.version, set: plan.set,
      writeKey: plan.writeKey, deadline: plan.writeDeadline };
  }

  private async readAfter(ref: RecordRef, plan: ResyncPlan, ack: Ack) {
    let original: OriginalMirrorAttempt = { state: "unknown" };
    if (ack?.state !== "applied") {
      const command = this.command(ref, plan);
      try {
        const parsed = originalMirrorAttemptSchema.safeParse(await this.writer.lookupOriginal(structuredClone(command)));
        if (parsed.success && parsed.data.state !== "unknown" && parsed.data.writeKey === command.writeKey &&
            parsed.data.commandHash === digest(command)) original = parsed.data;
      } catch { /* The exact attempt remains uncertain until its source can answer. */ }
    }
    const back = await this.readMirror(ref, "readBack"), source = await this.readSource(ref);
    return { back, source, original };
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
      ({ transition: { attempt: p.attempts, state: "refused" as const, reasonCode, event: "refused", finding: "open" as const,
        detail: { attempt: p.attempts, phase: "plan", ...extra } } });
    if (!ctx.openFinding) return refuse(REASONS.findingNotOpen);
    const hold = resyncHold(ctx.openFinding.conflict);
    if (hold) return refuse(hold);
    const s = certainSource(sourceRead, ref, ctx.now, this.maxSourceAgeMs);
    if ("reason" in s) return refuse(s.reason);
    const m = certainMirror(mirrorRead, ref, ctx.now, this.maxSourceAgeMs);
    if ("reason" in m) return refuse(m.reason);
    const schedule = this.repo.reconciliation.schedule(ref.checkId);
    if (!schedule) return refuse(REASONS.reconciliationIncomplete, { detail: "CHECK_SCHEDULE_NOT_FOUND" });
    const diff = detectRecordDifference(schedule, ref, s.ok, m.ok, ctx.now, this.secret, `${p.proposalId}.a${p.attempts}`);
    if (diff.kind === "incomplete") return refuse(diff.reason, { detail: diff.detail });
    if (diff.kind === "matched") return { transition: { attempt: p.attempts, state: "already_matched", reasonCode: REASONS.alreadyMatched, event: "already_matched",
      finding: "closed", detail: { attempt: p.attempts, sourceVersion: s.ok.version, mirrorVersion: m.ok.version } } };
    // Differences no field write can repair, such as a duplicate, stay with their owner.
    if (!diff.findings.some(f => f.fingerprint === p.fingerprint)) return refuse(REASONS.findingNotOpen);
    const set = p.category === "amount" ? { amountMinor: diff.set.amountMinor } : p.category === "field" ? { status: diff.set.status } : diff.set;
    if (!Object.values(set).some(value => value !== undefined)) return refuse(REASONS.ownershipHeld);
    return { plan: { attempt: p.attempts, writeKey: `${p.proposalId}.a${p.attempts}`, source: s.ok, set,
      mirrorBefore: { version: m.ok.version, fields: m.ok.row ? fieldsOf(m.ok.row) : null, localDigest: m.ok.row ? digest(m.ok.row.local) : null },
      detected: diff.findings.map(f => f.fingerprint), writeDeadline: null, writeStartedAt: null } };
  }

  /** AC5, AC7 and AC8: judge an attempt from the read-back alone. Only a matching record with untouched local fields closes the finding. */
  private settle(ctx: StepContext, plan: ResyncPlan, observed: Awaited<ReturnType<MirrorResyncService["readAfter"]>>, ack: Ack): Transition {
    const ref = ctx.proposal.ref;
    const { back, source, original } = observed;
    const detail = (extra: object = {}) => ({ attempt: plan.attempt, writeKey: plan.writeKey, ack, expectedVersion: plan.mirrorBefore.version, ...extra });
    const open = (state: "uncertain" | "not_applied" | "mismatch", reasonCode: string, extra: object = {}): Transition =>
      ({ attempt: plan.attempt, state, reasonCode, event: state, finding: "open", detail: detail(extra) });
    const started = plan.writeStartedAt === null ? NaN : Date.parse(plan.writeStartedAt);
    const validOriginal = original.state !== "unknown" && Date.parse(original.observedAt) >= started &&
      Date.parse(original.observedAt) <= ctx.now && ctx.now - Date.parse(original.observedAt) <= this.maxSourceAgeMs;
    if (original.state === "notApplied" && validOriginal) return open("not_applied", REASONS.writeNotApplied, { receiptRef: original.receiptRef });
    const appliedVersion = ack?.state === "applied" ? ack.version : original.state === "applied" && validOriginal ? original.version : null;
    if (back.state === "failed") return open("uncertain", REASONS.readBackFailed, { readBack: back.reason });
    if (!appliedVersion) return open("uncertain", REASONS.writeOutcomePending);
    const versionAfter = back.state === "found" ? back.version : null;
    if (versionAfter === plan.mirrorBefore.version) {
      return open("uncertain", REASONS.readBackContradictsAck, { versionAfter });
    }
    if (back.state === "absent") return open("mismatch", REASONS.mirrorRowRemoved, { versionAfter });
    if (!sameRecord(back.row, ref)) return open("mismatch", REASONS.mirrorIdentity, { versionAfter });
    const localAfter = digest(back.row.local), fieldsAfter = fieldsOf(back.row);
    const seen = { versionAfter, fieldsAfter, localDigestBefore: plan.mirrorBefore.localDigest, localDigestAfter: localAfter };
    if (plan.mirrorBefore.localDigest !== null && localAfter !== plan.mirrorBefore.localDigest) return open("mismatch", REASONS.localFieldsChanged, seen);
    const mirrorNow = certainMirror(back, ref, ctx.now, this.maxSourceAgeMs);
    if ("reason" in mirrorNow) return open("uncertain", mirrorNow.reason, seen);
    if (back.version !== appliedVersion || !(Date.parse(back.sourceAsOf) >= started))
      return open("uncertain", REASONS.readBackContradictsAck, seen);
    const current = certainSource(source, ref, ctx.now, this.maxSourceAgeMs);
    if ("reason" in current) return open("uncertain", current.reason, seen);
    if (!(Date.parse(current.ok.sourceAsOf) >= started)) return open("uncertain", REASONS.sourceStale, seen);
    const evidence = { ...seen, sourceReadbackVersion: current.ok.version, sourceReadbackAt: current.ok.observedAt };
    if (current.ok.version !== plan.source.version || digest(current.ok.record) !== digest(plan.source.record))
      return open("mismatch", REASONS.sourceVersionChanged, evidence);
    const schedule = this.repo.reconciliation.schedule(ref.checkId);
    if (!schedule) return open("uncertain", REASONS.reconciliationIncomplete, seen);
    const diff = detectRecordDifference(schedule, ref, current.ok, mirrorNow.ok, ctx.now,
      this.secret, `${ctx.proposal.proposalId}.a${plan.attempt}.readback`);
    if (diff.kind === "matched") return { attempt: plan.attempt, state: "verified", reasonCode: REASONS.verified, event: "verified", finding: "closed", detail: detail(evidence) };
    if (diff.kind === "incomplete") return open("uncertain", diff.reason, { ...seen, detail: diff.detail });
    const keys = MIRRORED_FIELDS.filter(k => k in plan.set), landed = keys.filter(k => back.row[k] === plan.set[k]);
    return open("mismatch", landed.length > 0 && landed.length < keys.length ? REASONS.partialApply : REASONS.readBackMismatch,
      { ...seen, landed, remaining: diff.findings.map(f => f.conflict.category) });
  }
}
