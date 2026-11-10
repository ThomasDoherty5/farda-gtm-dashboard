import { compareMirror } from "../mirrorReconciliation/comparator.ts";
import {
  MirrorReconciliationError, type CheckInput, type CheckSchedule, type ReconciliationFinding, type ReconciliationRow,
} from "../mirrorReconciliation/contract.ts";
import { REASONS, type MirrorRow, type MirroredFields, type RecordRef, type SourceRecord } from "./contract.ts";

export type SourceSide = { record: SourceRecord; version: string; observedAt: string };
export type MirrorSide = { row: MirrorRow | null; version: string | null; observedAt: string };
export type RecordDifference =
  | { kind: "matched" }
  | { kind: "differences"; findings: ReconciliationFinding[]; set: Partial<MirroredFields> }
  /** The comparator could not prove the record either way, for example because a read finished before the period's cutoff. */
  | { kind: "incomplete"; reason: string; detail: string };

/** Stands in for the version of a mirror read that found no row, which the coverage declaration still needs. */
const ABSENT_MIRROR_VERSION = "mirror-row-absent";
const row = (r: SourceRecord | MirrorRow): ReconciliationRow => ({ key: r.key, scope: r.scope, grain: r.grain, period: r.period, currency: r.currency,
  amountMinor: r.amountMinor, ...(r.status === undefined ? {} : { status: r.status }), read: "complete" });

/**
 * AC2. Compares one record's mirrored fields with an authoritative source read, through the reconciliation comparator
 * rather than a second set of rules. Both reads are declared complete for the record's dataset; the comparator still
 * demotes a read that finished before the period's cutoff. Findings for other keys cannot arise, since only this record is
 * passed in. `set` is what a resync would write: the source values of the fields the findings name, or every mirrored
 * field when the mirror has no row.
 */
export function detectRecordDifference(schedule: CheckSchedule, ref: RecordRef, source: SourceSide, mirror: MirrorSide, atMs: number,
  secret: string, runId: string): RecordDifference {
  const declare = (side: "source" | "mirror", version: string, readAt: string) =>
    ({ side, scope: ref.scope, grain: ref.grain, period: ref.period, state: "complete" as const, version, readAt });
  const input: CheckInput = {
    runId, checkId: ref.checkId, scheduleVersion: schedule.version, periods: [ref.period],
    coverage: [declare("source", source.version, source.observedAt), declare("mirror", mirror.version ?? ABSENT_MIRROR_VERSION, mirror.observedAt)],
    sourceRows: [row(source.record)], mirrorRows: mirror.row ? [row(mirror.row)] : [],
  };
  let result;
  try { result = compareMirror(schedule, input, atMs, { secret }); }
  catch (error) {
    if (error instanceof MirrorReconciliationError) return { kind: "incomplete", reason: REASONS.reconciliationIncomplete, detail: error.code };
    throw error;
  }
  const group = result.comparisons.find(c => c.group.scope === ref.scope && c.group.grain === ref.grain && c.group.period === ref.period
    && c.group.currency === ref.currency);
  if (!group || group.comparison.coverage !== "complete") return { kind: "incomplete", reason: REASONS.reconciliationIncomplete, detail: "COVERAGE_NOT_COMPLETE" };
  const findings = result.findings.filter(f => f.recordKey === ref.recordKey);
  if (!findings.length) return { kind: "matched" };
  const set: Partial<MirroredFields> = {};
  for (const f of findings) {
    if (f.conflict.category === "missing_mirror" || f.conflict.category === "amount") set.amountMinor = source.record.amountMinor;
    if ((f.conflict.category === "missing_mirror" || f.conflict.category === "field") && source.record.status !== undefined) set.status = source.record.status;
  }
  return { kind: "differences", findings, set };
}
