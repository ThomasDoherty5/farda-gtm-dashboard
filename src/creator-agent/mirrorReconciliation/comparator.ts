import { createHmac } from "node:crypto";
import { canonicalJson, digest } from "../config.ts";
import {
  MirrorReconciliationError, SOURCE_SLICE_LIMIT, checkInputSchema, reconciliationComparisonSchema, reconciliationConflictSchema,
  type CheckInput, type CheckResult, type CheckSchedule, type ComparisonOutcome, type ComparisonResult, type ExpectedDataset, type GroupRef,
  type ReadCoverage, type ReconciliationComparison, type ReconciliationConflict, type ReconciliationCoverage, type ReconciliationFinding,
  type ReconciliationGrain, type ReconciliationRow,
} from "./contract.ts";
import { periodWindow } from "./schedule.ts";

type Side = "source" | "mirror";
type Group = { scope: string; grain: ReconciliationGrain; period: string; currency: string; dataset: ExpectedDataset | null;
  source: ReconciliationRow[]; mirror: ReconciliationRow[] };
type Value = ReconciliationConflict["sourceValue"];

const sep = "\u0000";
const datasetKey = (scope: string, grain: string) => scope + sep + grain;
const coverageKey = (side: Side, scope: string, grain: string, period: string) => [side, scope, grain, period].join(sep);
const groupKey = (scope: string, grain: string, period: string, currency: string) => [scope, grain, period, currency].join(sep);
const iso = (at: number) => new Date(at).toISOString();
/** Worst first. A missing read is unknown; unknown is never treated as complete or as zero. */
const COVERAGE_RANK: Record<ReconciliationCoverage, number> = { complete: 0, partial: 1, unknown: 2, failed: 3 };
const worst = (...states: ReconciliationCoverage[]) => states.reduce((a, b) => (COVERAGE_RANK[b] > COVERAGE_RANK[a] ? b : a), "complete");
const presence = (value: "present" | "missing" | "duplicate" | "unknown"): Value => ({ kind: "presence", value });

/** A total outside the safe-integer range is unknown, not wrapped or rounded. */
function total(rows: ReconciliationRow[]): number | null {
  let sum = 0;
  for (const row of rows) {
    sum += row.amountMinor;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

export type CompareOptions = {
  /** Server-held key for the public comparison and conflict ids, such as the operations secret. */
  secret: string;
  /** Groups with open findings. Each one in the run's periods is compared even with no rows, so its findings can clear. */
  openGroups?: readonly GroupRef[];
};

function byKey(rows: ReconciliationRow[]) {
  const keys = new Map<string, ReconciliationRow[]>();
  for (const row of rows) keys.set(row.key, [...(keys.get(row.key) ?? []), row]);
  return keys;
}

/**
 * Compares typed source and mirror rows for one check run. Pure: the run's observation time is passed in, and the output
 * validates against the operations-control `comparison` and `conflict` schemas.
 *
 * Rows are grouped by scope, grain, period and currency; currencies never share a group or a total. A finding is raised
 * only when the reads prove it: a key missing from one side needs that side's read to be complete, and an amount
 * difference needs both reads and both rows complete. A group whose reads are not complete is `incomplete` or `unknown`
 * with null counts and totals for the unread side, never `matched`.
 */
export function compareMirror(schedule: CheckSchedule, raw: CheckInput | unknown, observedAtMs: number, options: CompareOptions): CheckResult {
  if (typeof options.secret !== "string" || options.secret.length < 32) throw new MirrorReconciliationError("INVALID_RECONCILIATION_SECRET", 500);
  // Record keys are guessable, so a plain digest of one could be reversed by trial; public ids are keyed.
  const publicId = (prefix: string, material: unknown) =>
    prefix + createHmac("sha256", options.secret).update(canonicalJson(["mirror-reconciliation", prefix, material])).digest("hex").slice(0, 40);
  const parsed = checkInputSchema.safeParse(raw);
  if (!parsed.success) throw new MirrorReconciliationError("INVALID_CHECK_INPUT", 422);
  const input = parsed.data;
  if (input.checkId !== schedule.checkId) throw new MirrorReconciliationError("CHECK_SCHEDULE_MISMATCH", 409);
  if (input.scheduleVersion !== schedule.version) throw new MirrorReconciliationError("STALE_SCHEDULE_VERSION", 409);

  const windows = new Map(input.periods.map(p => [p, periodWindow(schedule, p)]));
  for (const w of windows.values()) if (w.cutoff > observedAtMs) throw new MirrorReconciliationError("PERIOD_NOT_DUE", 409);
  const datasets = new Map(schedule.expectedDatasets.map(d => [datasetKey(d.scope, d.grain), d]));

  const reads = new Map<string, ReadCoverage>();
  for (const read of input.coverage) {
    if (!windows.has(read.period)) throw new MirrorReconciliationError("COVERAGE_PERIOD_OUTSIDE_RUN", 422);
    if (read.side === "source" && !datasets.has(datasetKey(read.scope, read.grain))) throw new MirrorReconciliationError("SOURCE_DATASET_NOT_EXPECTED", 422);
    if (Date.parse(read.readAt) > observedAtMs) throw new MirrorReconciliationError("READ_IN_FUTURE", 422);
    reads.set(coverageKey(read.side, read.scope, read.grain, read.period), read);
  }
  /** A read that finished before the cutoff may have missed late rows, so it cannot prove completeness. */
  const readState = (side: Side, g: Group): ReconciliationCoverage => {
    const read = reads.get(coverageKey(side, g.scope, g.grain, g.period));
    if (!read) return "unknown";
    if (read.state === "complete" && Date.parse(read.readAt) < windows.get(g.period)!.cutoff) return "partial";
    return read.state;
  };

  const groups = new Map<string, Group>();
  const group = (scope: string, grain: ReconciliationGrain, period: string, currency: string) => {
    const key = groupKey(scope, grain, period, currency);
    let g = groups.get(key);
    if (!g) {
      g = { scope, grain, period, currency, dataset: datasets.get(datasetKey(scope, grain)) ?? null, source: [], mirror: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const d of schedule.expectedDatasets) for (const p of input.periods) for (const c of d.currencies) group(d.scope, d.grain, p, c);
  for (const o of options.openGroups ?? []) if (windows.has(o.period)) group(o.scope, o.grain, o.period, o.currency);
  for (const [side, rows] of [["source", input.sourceRows], ["mirror", input.mirrorRows]] as const) {
    for (const row of rows) {
      if (!windows.has(row.period)) throw new MirrorReconciliationError("ROW_PERIOD_OUTSIDE_RUN", 422);
      if (side === "source" && !datasets.has(datasetKey(row.scope, row.grain))) throw new MirrorReconciliationError("SOURCE_DATASET_NOT_EXPECTED", 422);
      group(row.scope, row.grain, row.period, row.currency)[side].push(row);
    }
  }

  const observedAt = iso(observedAtMs), evidenceRef = `mirror-reconciliation/${input.runId}`;
  // The schedule version is the evidence for which source datasets exist.
  const ownershipVersion = `${schedule.checkId}/schedule/v${schedule.version}`;
  const comparisons: ComparisonResult[] = [], findings: ReconciliationFinding[] = [];

  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)!, window = windows.get(g.period)!;
    const sourceRead = g.dataset ? reads.get(coverageKey("source", g.scope, g.grain, g.period)) : undefined;
    const mirrorRead = reads.get(coverageKey("mirror", g.scope, g.grain, g.period));
    const mirrorState = readState("mirror", g);
    // No expected source dataset owns an orphan's scope and grain, so the source side is a known empty set once the mirror is fully read.
    const sourceState = g.dataset ? readState("source", g) : mirrorState === "complete" ? "complete" : "unknown";
    let overflow = false;
    const amount = (state: ReconciliationCoverage, rows: ReconciliationRow[]) => {
      if (state !== "complete" || rows.some(r => r.read !== "complete")) return null;
      const minorUnits = total(rows);
      if (minorUnits === null) { overflow = true; return null; }
      return { minorUnits, currency: g.currency };
    };
    const sourceAmount = amount(sourceState, g.source), mirrorAmount = amount(mirrorState, g.mirror);
    const rowsPartial = [...g.source, ...g.mirror].some(r => r.read === "partial");
    const coverage = worst(sourceState, mirrorState, rowsPartial || overflow ? "partial" : "complete");
    const comparisonId = publicId("mr-", { checkId: schedule.checkId, scope: g.scope, grain: g.grain, period: g.period, currency: g.currency });
    const sourceVersion = g.dataset ? sourceRead?.version ?? "source-unread" : ownershipVersion;
    const comparison: ReconciliationComparison = {
      id: comparisonId, label: `${g.scope} ${g.grain} ${g.period} ${g.currency}`, grain: g.grain,
      period: { startAt: iso(window.startAt), endAt: iso(window.endAt), timezone: schedule.timezone }, currency: g.currency,
      sourceCount: sourceState === "complete" ? g.source.length : null, mirrorCount: mirrorState === "complete" ? g.mirror.length : null,
      sourceAmount, mirrorAmount,
      coverage, cutoff: iso(window.cutoff), sourceVersion, evidenceRef, observedAt,
    };

    const raised: ReconciliationFinding[] = [];
    const raise = (recordKey: string, side: ReconciliationFinding["side"], category: ReconciliationConflict["category"],
      field: ReconciliationConflict["field"], sourceValue: Value, mirrorValue: Value) => {
      const fingerprint = digest({ checkId: schedule.checkId, scope: g.scope, grain: g.grain, period: g.period, currency: g.currency,
        recordKey, side, category, field, sourceValue, mirrorValue });
      raised.push({ fingerprint, comparisonId, recordKey, side, conflict: {
        id: publicId("mrf-", fingerprint), comparisonId, category, field,
        // Source owns records of an expected source dataset; a record the source cannot vouch for has unknown ownership.
        ownership: g.dataset && category !== "missing_source" && category !== "orphan" ? "source" : "unknown",
        sourceValue, mirrorValue, authoritativeVersion: sourceRead?.version ?? null, mirrorVersion: mirrorRead?.version ?? null,
        ownershipVersion, repairAllowed: false, state: "open", receiptRef: null, sourceVersion, evidenceRef, observedAt } });
    };

    const source = byKey(g.source), mirror = byKey(g.mirror);
    for (const [side, keys] of [["source", source], ["mirror", mirror]] as const) {
      for (const [k, rows] of keys) if (rows.length > 1) {
        const count: Value = { kind: "count", value: rows.length };
        raise(k, side, "duplicate", "record-count", side === "source" ? count : null, side === "mirror" ? count : null);
      }
    }
    if (!g.dataset) {
      for (const k of mirror.keys()) raise(k, "mirror", "orphan", "record-key", presence("unknown"), presence("present"));
    } else {
      for (const k of source.keys()) if (!mirror.has(k) && mirrorState === "complete")
        raise(k, "mirror", "missing_mirror", "record-key", presence("present"), presence("missing"));
      for (const k of mirror.keys()) if (!source.has(k) && sourceState === "complete")
        raise(k, "source", "missing_source", "record-key", presence("missing"), presence("present"));
      if (sourceState === "complete" && mirrorState === "complete") {
        for (const [k, [s, ...moreSource]] of source) {
          const [m, ...moreMirror] = mirror.get(k) ?? [];
          if (!s || !m || moreSource.length || moreMirror.length || s.read !== "complete" || m.read !== "complete") continue;
          if (s.amountMinor !== m.amountMinor) raise(k, "both", "amount", g.dataset.amountField,
            { kind: "money", minorUnits: s.amountMinor, currency: g.currency }, { kind: "money", minorUnits: m.amountMinor, currency: g.currency });
        }
      }
    }

    const unique = [...new Map(raised.map(f => [f.fingerprint, f])).values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    const outcome: ComparisonOutcome = coverage === "complete" ? (unique.length ? "differences" : "matched")
      : coverage === "partial" ? "incomplete" : "unknown";
    if (outcome === "matched" && (comparison.sourceCount !== comparison.mirrorCount || comparison.sourceAmount?.minorUnits !== comparison.mirrorAmount?.minorUnits))
      throw new MirrorReconciliationError("COMPARATOR_INVARIANT", 500);
    comparisons.push({ comparison, group: { scope: g.scope, grain: g.grain, period: g.period, currency: g.currency, expected: g.dataset !== null },
      outcome, reads: { source: sourceRead ? iso(Date.parse(sourceRead.readAt)) : null, mirror: mirrorRead ? iso(Date.parse(mirrorRead.readAt)) : null },
      findingFingerprints: unique.map(f => f.fingerprint) });
    findings.push(...unique);
  }

  // The output is the existing operations-control shape; refuse to return anything that shape would reject.
  for (const c of comparisons) if (!reconciliationComparisonSchema.safeParse(c.comparison).success) throw new MirrorReconciliationError("COMPARISON_SHAPE_INVALID", 500);
  for (const f of findings) if (!reconciliationConflictSchema.safeParse(f.conflict).success) throw new MirrorReconciliationError("CONFLICT_SHAPE_INVALID", 500);

  const outcome = comparisons.some(c => c.outcome === "incomplete" || c.outcome === "unknown") ? "incomplete"
    : comparisons.some(c => c.outcome === "differences") ? "differences" : "matched";
  return { runId: input.runId, checkId: input.checkId, scheduleVersion: input.scheduleVersion, observedAt, outcome, comparisons, findings };
}

/**
 * The `comparisons` and `conflicts` arrays for an operations-control source snapshot. The snapshot holds at most 100 of
 * each, so groups with differences or gaps go first. `extraConflicts` are still-open conflicts from earlier runs; those
 * whose group is in the slice are included. `truncated` means the snapshot must report partial coverage.
 */
export function toOperationsControlSlice(result: Pick<CheckResult, "comparisons" | "findings">, extraConflicts: readonly ReconciliationConflict[] = []) {
  const rank: Record<ComparisonOutcome, number> = { differences: 0, unknown: 1, incomplete: 2, matched: 3 };
  const ordered = [...result.comparisons].sort((a, b) => rank[a.outcome] - rank[b.outcome] || a.comparison.id.localeCompare(b.comparison.id));
  const kept = ordered.slice(0, SOURCE_SLICE_LIMIT), ids = new Set(kept.map(c => c.comparison.id));
  // This run's view of a conflict replaces an earlier one with the same id.
  const all = [...new Map([...extraConflicts, ...result.findings.map(f => f.conflict)].map(c => [c.id, c])).values()];
  const eligible = all.filter(c => ids.has(c.comparisonId)), conflicts = eligible.slice(0, SOURCE_SLICE_LIMIT);
  return { comparisons: kept.map(c => c.comparison), conflicts, truncated: kept.length < ordered.length || conflicts.length < eligible.length };
}
