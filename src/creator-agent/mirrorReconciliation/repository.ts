import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { compareMirror, reconciliationPublicIds, toOperationsControlSlice } from "./comparator.ts";
import {
  MirrorReconciliationError, checkInputSchema, checkScheduleSchema,
  type CheckResult, type CheckSchedule, type ComparisonResult, type GroupRef, type ReconciliationConflict, type ReconciliationFinding,
} from "./contract.ts";

/** `stale`: the run's reads of the group were older than those behind the finding's state, so its clear or reopen was ignored. */
export type FindingDisposition = "opened" | "repeated" | "reopened" | "cleared" | "stale";
export type StoredRun = CheckResult & { sequence: number; dispositions: Record<FindingDisposition, number>; staleComparisons: number };
export type RecordedCheck = {
  run: StoredRun;
  /** True when this run id was already recorded with the same input; nothing was written. */
  duplicate: boolean;
  /** Findings first seen, or seen again after clearing, in this run: what an alert should carry. Repeats are suppressed. */
  raised: ReconciliationFinding[];
  cleared: string[];
};
export type StoredFinding = {
  fingerprint: string; checkId: string; comparisonId: string; group: GroupRef; category: ReconciliationConflict["category"]; recordKey: string;
  status: "open" | "cleared"; occurrences: number; firstRunId: string; lastRunId: string; clearedByRunId: string | null;
  firstSeenAt: string; lastSeenAt: string; clearedAt: string | null;
  /** The newest reads, per side, behind the finding's current state. A run with older reads cannot clear or reopen it. */
  basis: Reads; conflict: ReconciliationConflict;
};
export type MirrorReconciliationOptions = {
  /** Server-held key for public ids, such as the operations secret from `loadOperationsSecret`. */
  secret: string;
  now?: () => number;
};
type Reads = ComparisonResult["reads"];
const SIDES = ["source", "mirror"] as const;
/** True when any side of `reads` is older than, or unknown against, a known side of `basis`. */
const olderThan = (reads: Reads, basis: Reads) =>
  SIDES.some(side => basis[side] !== null && (reads[side] === null || Date.parse(reads[side]!) < Date.parse(basis[side]!)));
const newest = (a: Reads, b: Reads): Reads => Object.fromEntries(SIDES.map(side =>
  [side, a[side] === null ? b[side] : b[side] === null ? a[side] : Date.parse(a[side]!) >= Date.parse(b[side]!) ? a[side] : b[side]])) as Reads;

type Row = Record<string, unknown>;
const runFrom = (r: Row): StoredRun => ({
  coverage: [], staleComparisons: 0, ...(JSON.parse(String(r.body)) as Omit<StoredRun, "sequence" | "coverage" | "staleComparisons">),
  sequence: Number(r.sequence),
});
const basisFrom = (r: Row): Reads => ({ source: r.basis_source_read_at === null ? null : String(r.basis_source_read_at),
  mirror: r.basis_mirror_read_at === null ? null : String(r.basis_mirror_read_at) });
const findingFrom = (r: Row): StoredFinding => ({
  fingerprint: String(r.fingerprint), checkId: String(r.check_id), comparisonId: String(r.comparison_id),
  group: { scope: String(r.scope), grain: String(r.grain) as GroupRef["grain"], period: String(r.period), currency: String(r.currency) },
  category: String(r.category) as StoredFinding["category"], recordKey: String(r.record_key), status: String(r.status) as StoredFinding["status"],
  occurrences: Number(r.occurrences), firstRunId: String(r.first_run_id), lastRunId: String(r.last_run_id),
  clearedByRunId: r.cleared_by_run_id === null ? null : String(r.cleared_by_run_id), firstSeenAt: String(r.first_seen_at),
  lastSeenAt: String(r.last_seen_at), clearedAt: r.cleared_at === null ? null : String(r.cleared_at),
  basis: basisFrom(r), conflict: JSON.parse(String(r.conflict)) as ReconciliationConflict,
});

/**
 * Check schedules, runs and findings on the shared agent database, in `mirror_reconciliation_*` tables. Every write is one
 * `BEGIN IMMEDIATE` transaction that reads the injected clock after the lock is held.
 */
export class MirrorReconciliationRepository {
  readonly db: DatabaseSync; readonly now: () => number; private readonly secret: string;
  constructor(db: DatabaseSync, scope: OperationsScope, options: MirrorReconciliationOptions) {
    reconciliationPublicIds(options.secret);
    this.db = db; this.now = options.now ?? Date.now; this.secret = options.secret;
    const bound = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
    if (!bound || scope.workspaceId !== bound.workspace_id || scope.accountId !== bound.account_id || scope.environment !== bound.environment)
      throw new MirrorReconciliationError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS mirror_reconciliation_schedules(check_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,
        recorded_at TEXT NOT NULL,PRIMARY KEY(check_id,version));
      CREATE TABLE IF NOT EXISTS mirror_reconciliation_runs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT UNIQUE NOT NULL,check_id TEXT NOT NULL,
        schedule_version INTEGER NOT NULL,input_digest TEXT NOT NULL,observed_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('matched','differences','incomplete')),body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mirror_reconciliation_runs_check ON mirror_reconciliation_runs(check_id,sequence);
      CREATE TABLE IF NOT EXISTS mirror_reconciliation_findings(fingerprint TEXT PRIMARY KEY,check_id TEXT NOT NULL,comparison_id TEXT NOT NULL,
        scope TEXT NOT NULL,grain TEXT NOT NULL,period TEXT NOT NULL,currency TEXT NOT NULL,
        category TEXT NOT NULL,record_key TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','cleared')),occurrences INTEGER NOT NULL,
        first_run_id TEXT NOT NULL,last_run_id TEXT NOT NULL,cleared_by_run_id TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,
        cleared_at TEXT,basis_source_read_at TEXT,basis_mirror_read_at TEXT,conflict TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mirror_reconciliation_findings_open ON mirror_reconciliation_findings(check_id,scope,grain,period,currency,status);
      CREATE TABLE IF NOT EXISTS mirror_reconciliation_group_basis(group_key TEXT PRIMARY KEY, source_at TEXT, mirror_at TEXT);
      CREATE TABLE IF NOT EXISTS mirror_reconciliation_run_findings(run_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('opened','repeated','reopened','cleared','stale')),PRIMARY KEY(run_id,fingerprint));`);
  }

  private clock(): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new MirrorReconciliationError("INVALID_RECONCILIATION_CLOCK", 500);
    return at;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private latestSchedule(checkId: string): CheckSchedule | null {
    const row = this.db.prepare("SELECT body FROM mirror_reconciliation_schedules WHERE check_id=? ORDER BY version DESC LIMIT 1").get(checkId);
    return row ? checkScheduleSchema.parse(JSON.parse(String(row.body))) : null;
  }

  /** AC1. Stores a schedule version. Replaying it is a no-op; a different body under a recorded version, or an older version, is refused. */
  saveSchedule(raw: unknown): { schedule: CheckSchedule; changed: boolean } {
    const parsed = checkScheduleSchema.safeParse(raw);
    if (!parsed.success) throw new MirrorReconciliationError("INVALID_CHECK_SCHEDULE", 422);
    const schedule = parsed.data, body = canonicalJson(schedule);
    return this.transaction(() => {
      const at = this.clock();
      const same = this.db.prepare("SELECT body FROM mirror_reconciliation_schedules WHERE check_id=? AND version=?").get(schedule.checkId, schedule.version);
      if (same) {
        if (String(same.body) !== body) throw new MirrorReconciliationError("SCHEDULE_VERSION_REUSED", 409);
        return { schedule, changed: false };
      }
      const latest = this.latestSchedule(schedule.checkId);
      if (latest && latest.version > schedule.version) throw new MirrorReconciliationError("STALE_SCHEDULE_VERSION", 409);
      this.db.prepare("INSERT INTO mirror_reconciliation_schedules(check_id,version,body,recorded_at) VALUES(?,?,?,?)")
        .run(schedule.checkId, schedule.version, body, new Date(at).toISOString());
      return { schedule, changed: true };
    });
  }

  schedule(checkId: string): CheckSchedule | null { return this.latestSchedule(checkId); }

  /**
   * AC7. Runs one check against the current schedule and records the run, its findings and their dispositions. The same
   * run id with the same input returns the recorded run unchanged; with different input it is refused. A finding already
   * open is counted as repeated, not raised again. Groups with open findings are compared again whenever their period is
   * in the run. A finding clears only when a complete comparison shows its record matches. Changes in discrepancy
   * category or amount cannot make a mismatched record appear resolved.
   */
  recordCheck(raw: unknown, assertCurrent: () => void = () => {}): RecordedCheck {
    const parsed = checkInputSchema.safeParse(raw);
    if (!parsed.success) throw new MirrorReconciliationError("INVALID_CHECK_INPUT", 422);
    const input = parsed.data, inputDigest = digest(input);
    return this.transaction(() => {
      assertSynchronousVoid(assertCurrent);
      const at = this.clock();
      const prior = this.db.prepare("SELECT sequence,input_digest,body FROM mirror_reconciliation_runs WHERE run_id=?").get(input.runId);
      if (prior) {
        if (String(prior.input_digest) !== inputDigest) throw new MirrorReconciliationError("RUN_ID_REUSED", 409);
        return { run: runFrom(prior), duplicate: true, raised: [], cleared: [] };
      }
      const schedule = this.latestSchedule(input.checkId);
      if (!schedule) throw new MirrorReconciliationError("CHECK_SCHEDULE_NOT_FOUND", 404);
      const openGroups = this.db.prepare("SELECT DISTINCT scope,grain,period,currency FROM mirror_reconciliation_findings WHERE check_id=? AND status='open'")
        .all(input.checkId).map(r => ({ scope: String(r.scope), grain: String(r.grain) as GroupRef["grain"], period: String(r.period), currency: String(r.currency) }));
      const result = compareMirror(schedule, input, at, { secret: this.secret, openGroups });
      const observedAt = result.observedAt, groups = new Map(result.comparisons.map(c => [c.comparison.id, c]));
      const staleGroups = new Set<string>();
      for (const c of result.comparisons) {
        const key = digest([result.checkId, c.group.scope, c.group.grain, c.group.period, c.group.currency]);
        const prior = this.db.prepare("SELECT source_at,mirror_at FROM mirror_reconciliation_group_basis WHERE group_key=?").get(key);
        if (prior && olderThan(c.reads, {source: prior.source_at as string | null, mirror: prior.mirror_at as string | null})) {
          staleGroups.add(c.comparison.id);
        } else if (c.comparison.coverage === "complete") {
          this.db.prepare("INSERT OR REPLACE INTO mirror_reconciliation_group_basis VALUES(?,?,?)").run(key, c.reads.source, c.reads.mirror);
        }
      }
      const dispositions: Record<FindingDisposition, number> = { opened: 0, repeated: 0, reopened: 0, cleared: 0, stale: 0 };
      const raised: ReconciliationFinding[] = [], cleared: string[] = [];
      const mark = (fingerprint: string, disposition: FindingDisposition) => {
        dispositions[disposition]++;
        this.db.prepare("INSERT INTO mirror_reconciliation_run_findings(run_id,fingerprint,disposition) VALUES(?,?,?)").run(result.runId, fingerprint, disposition);
      };
      const stored = (fingerprint: string) => this.db.prepare("SELECT * FROM mirror_reconciliation_findings WHERE fingerprint=?").get(fingerprint);

      for (const f of result.findings) {
        if (staleGroups.has(f.comparisonId)) { mark(f.fingerprint, "stale"); continue; }
        const c = groups.get(f.comparisonId)!, reads = c.reads, existing = stored(f.fingerprint), conflict = JSON.stringify(f.conflict);
        if (!existing) {
          this.db.prepare(`INSERT INTO mirror_reconciliation_findings(fingerprint,check_id,comparison_id,scope,grain,period,currency,category,record_key,
              status,occurrences,first_run_id,last_run_id,cleared_by_run_id,first_seen_at,last_seen_at,cleared_at,basis_source_read_at,basis_mirror_read_at,conflict)
              VALUES(?,?,?,?,?,?,?,?,?,'open',1,?,?,NULL,?,?,NULL,?,?,?)`)
            .run(f.fingerprint, result.checkId, f.comparisonId, c.group.scope, c.group.grain, c.group.period, c.group.currency, f.conflict.category,
              f.recordKey, result.runId, result.runId, observedAt, observedAt, reads.source, reads.mirror, conflict);
          raised.push(f); mark(f.fingerprint, "opened");
          continue;
        }
        const basis = basisFrom(existing), older = olderThan(reads, basis);
        if (existing.status === "open") {
          // An older run confirms the finding but does not replace the newer evidence behind it. Either way the public ids
          // are refreshed, since a rotated secret changes them.
          const next = older ? basis : newest(reads, basis);
          const kept = older ? JSON.stringify({ ...(JSON.parse(String(existing.conflict)) as ReconciliationConflict), id: f.conflict.id, comparisonId: f.comparisonId })
            : conflict;
          this.db.prepare(`UPDATE mirror_reconciliation_findings SET occurrences=occurrences+1,last_run_id=?,last_seen_at=?,basis_source_read_at=?,
              basis_mirror_read_at=?,comparison_id=?,conflict=? WHERE fingerprint=?`)
            .run(result.runId, observedAt, next.source, next.mirror, f.comparisonId, kept, f.fingerprint);
          mark(f.fingerprint, "repeated");
        } else if (older) {
          mark(f.fingerprint, "stale");
        } else {
          this.db.prepare(`UPDATE mirror_reconciliation_findings SET status='open',occurrences=occurrences+1,last_run_id=?,last_seen_at=?,
              cleared_by_run_id=NULL,cleared_at=NULL,basis_source_read_at=?,basis_mirror_read_at=?,comparison_id=?,conflict=? WHERE fingerprint=?`)
            .run(result.runId, observedAt, reads.source, reads.mirror, f.comparisonId, conflict, f.fingerprint);
          raised.push(f); mark(f.fingerprint, "reopened");
        }
      }

      const seen = new Set(result.findings.map(f => f.fingerprint));
      const mismatchedRecords = new Set(result.findings.map(f => canonicalJson([f.comparisonId, f.recordKey])));
      for (const c of result.comparisons) {
        if (c.comparison.coverage !== "complete") continue;
        // Matched by group and plain fingerprint, never by the public id, which changes when the secret rotates.
        const open = this.db.prepare(`SELECT * FROM mirror_reconciliation_findings WHERE check_id=? AND scope=? AND grain=? AND period=? AND currency=?
            AND status='open'`).all(result.checkId, c.group.scope, c.group.grain, c.group.period, c.group.currency);
        for (const row of open) {
          const fingerprint = String(row.fingerprint);
          if (seen.has(fingerprint) || mismatchedRecords.has(canonicalJson([c.comparison.id, row.record_key]))) continue;
          if (staleGroups.has(c.comparison.id) || olderThan(c.reads, basisFrom(row))) { mark(fingerprint, "stale"); continue; }
          this.db.prepare(`UPDATE mirror_reconciliation_findings SET status='cleared',cleared_by_run_id=?,cleared_at=?,basis_source_read_at=?,
              basis_mirror_read_at=? WHERE fingerprint=?`).run(result.runId, observedAt, c.reads.source, c.reads.mirror, fingerprint);
          cleared.push(fingerprint); mark(fingerprint, "cleared");
        }
      }

      assertSynchronousVoid(assertCurrent);
      const evidence = { ...result, dispositions, staleComparisons: staleGroups.size };
      const inserted = this.db.prepare(`INSERT INTO mirror_reconciliation_runs(run_id,check_id,schedule_version,input_digest,observed_at,outcome,body)
          VALUES(?,?,?,?,?,?,?)`).run(result.runId, result.checkId, result.scheduleVersion, inputDigest, observedAt, result.outcome,
        JSON.stringify(evidence));
      return { run: { ...evidence, sequence: Number(inserted.lastInsertRowid) }, duplicate: false, raised, cleared };
    });
  }

  /** The audit trail of runs for a check, newest first. */
  run(runId: string): StoredRun | null {
    const row = this.db.prepare("SELECT sequence,body FROM mirror_reconciliation_runs WHERE run_id=?").get(runId);
    return row ? runFrom(row) : null;
  }

  runs(checkId: string, limit = 20): { runs: StoredRun[]; total: number; partial: boolean } {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const total = Number(this.db.prepare("SELECT COUNT(*) n FROM mirror_reconciliation_runs WHERE check_id=?").get(checkId)?.n ?? 0);
    const runs = this.db.prepare("SELECT sequence,body FROM mirror_reconciliation_runs WHERE check_id=? ORDER BY sequence DESC LIMIT ?").all(checkId, bounded)
      .map(runFrom);
    return { runs, total, partial: total > runs.length };
  }

  findings(checkId: string, status?: StoredFinding["status"]): StoredFinding[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM mirror_reconciliation_findings WHERE check_id=? AND status=? ORDER BY first_seen_at,fingerprint").all(checkId, status)
      : this.db.prepare("SELECT * FROM mirror_reconciliation_findings WHERE check_id=? ORDER BY first_seen_at,fingerprint").all(checkId);
    return rows.map(findingFrom);
  }

  /** What each run did to each finding: the per-run half of the audit trail. */
  runFindings(runId: string): { fingerprint: string; disposition: FindingDisposition }[] {
    return this.db.prepare("SELECT fingerprint,disposition FROM mirror_reconciliation_run_findings WHERE run_id=? ORDER BY fingerprint").all(runId)
      .map(r => ({ fingerprint: String(r.fingerprint), disposition: String(r.disposition) as FindingDisposition }));
  }

  /**
   * The latest run as `comparisons` and `conflicts` for an operations-control source snapshot, or null before any run.
   * Conflicts are the check's currently open findings whose group is in the slice. `coverage` is what the snapshot should
   * report: `partial` when the slice was truncated, or when any open finding was not confirmed by the latest run (its
   * period was outside the run, its group was not fully read, or the run's reads were older). `openFindings` counts every
   * open finding for the check, so a matched run cannot hide one.
   */
  latestSlice(checkId: string) {
    const [latest] = this.runs(checkId, 1).runs;
    if (!latest) return null;
    // Stored runs and conflicts may carry ids from before a secret rotation; publish them under the current secret.
    const ids = reconciliationPublicIds(this.secret), open = this.findings(checkId, "open");
    const comparisons = latest.comparisons.map(c => ({ ...c, comparison: { ...c.comparison, id: ids.comparison(checkId, c.group) } }));
    const slice = toOperationsControlSlice({ comparisons, findings: [] },
      open.map(f => ({ ...f.conflict, id: ids.conflict(f.fingerprint), comparisonId: ids.comparison(checkId, f.group) })));
    const confirmed = new Set(latest.findings.map(f => f.fingerprint));
    const unconfirmedOpenFindings = open.filter(f => !confirmed.has(f.fingerprint) || f.lastRunId !== latest.runId).length;
    const coverage: "complete" | "partial" = slice.truncated || unconfirmedOpenFindings > 0 || latest.outcome === "incomplete" ||
      latest.staleComparisons > 0 || latest.dispositions.stale > 0 ? "partial" : "complete";
    return { ...slice, coverage, observedAt: latest.observedAt, outcome: latest.outcome, runId: latest.runId, sequence: latest.sequence,
      scheduleVersion: latest.scheduleVersion, openFindings: open.length, unconfirmedOpenFindings };
  }
}
