import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { compareMirror, toOperationsControlSlice } from "./comparator.ts";
import {
  MirrorReconciliationError, checkInputSchema, checkScheduleSchema,
  type CheckResult, type CheckSchedule, type ReconciliationConflict, type ReconciliationFinding,
} from "./contract.ts";

export type FindingDisposition = "opened" | "repeated" | "reopened" | "cleared";
export type StoredRun = CheckResult & { sequence: number; dispositions: Record<FindingDisposition, number> };
export type RecordedCheck = {
  run: StoredRun;
  /** True when this run id was already recorded with the same input; nothing was written. */
  duplicate: boolean;
  /** Findings first seen, or seen again after clearing, in this run: what an alert should carry. Repeats are suppressed. */
  raised: ReconciliationFinding[];
  cleared: string[];
};
export type StoredFinding = {
  fingerprint: string; checkId: string; comparisonId: string; category: ReconciliationConflict["category"]; recordKey: string;
  status: "open" | "cleared"; occurrences: number; firstRunId: string; lastRunId: string; clearedByRunId: string | null;
  firstSeenAt: string; lastSeenAt: string; clearedAt: string | null; conflict: ReconciliationConflict;
};
export type MirrorReconciliationOptions = { now?: () => number };

type Row = Record<string, unknown>;
const runFrom = (r: Row): StoredRun => ({ ...(JSON.parse(String(r.body)) as Omit<StoredRun, "sequence">), sequence: Number(r.sequence) });
const findingFrom = (r: Row): StoredFinding => ({
  fingerprint: String(r.fingerprint), checkId: String(r.check_id), comparisonId: String(r.comparison_id),
  category: String(r.category) as StoredFinding["category"], recordKey: String(r.record_key), status: String(r.status) as StoredFinding["status"],
  occurrences: Number(r.occurrences), firstRunId: String(r.first_run_id), lastRunId: String(r.last_run_id),
  clearedByRunId: r.cleared_by_run_id === null ? null : String(r.cleared_by_run_id), firstSeenAt: String(r.first_seen_at),
  lastSeenAt: String(r.last_seen_at), clearedAt: r.cleared_at === null ? null : String(r.cleared_at),
  conflict: JSON.parse(String(r.conflict)) as ReconciliationConflict,
});

/**
 * Check schedules, runs and findings on the shared agent database, in `mirror_reconciliation_*` tables. Every write is one
 * `BEGIN IMMEDIATE` transaction that reads the injected clock after the lock is held.
 */
export class MirrorReconciliationRepository {
  readonly db: DatabaseSync; readonly now: () => number;
  constructor(db: DatabaseSync, scope: OperationsScope, options: MirrorReconciliationOptions = {}) {
    this.db = db; this.now = options.now ?? Date.now;
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
        category TEXT NOT NULL,record_key TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','cleared')),occurrences INTEGER NOT NULL,
        first_run_id TEXT NOT NULL,last_run_id TEXT NOT NULL,cleared_by_run_id TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,
        cleared_at TEXT,conflict TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mirror_reconciliation_findings_open ON mirror_reconciliation_findings(check_id,comparison_id,status);
      CREATE TABLE IF NOT EXISTS mirror_reconciliation_run_findings(run_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('opened','repeated','reopened','cleared')),PRIMARY KEY(run_id,fingerprint));`);
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
   * open is counted as repeated, not raised again. An open finding clears only when a later run compares its group with
   * complete coverage and no longer sees it; an incomplete or unknown group leaves it open.
   */
  recordCheck(raw: unknown): RecordedCheck {
    const parsed = checkInputSchema.safeParse(raw);
    if (!parsed.success) throw new MirrorReconciliationError("INVALID_CHECK_INPUT", 422);
    const input = parsed.data, inputDigest = digest(input);
    return this.transaction(() => {
      const at = this.clock();
      const prior = this.db.prepare("SELECT sequence,input_digest,body FROM mirror_reconciliation_runs WHERE run_id=?").get(input.runId);
      if (prior) {
        if (String(prior.input_digest) !== inputDigest) throw new MirrorReconciliationError("RUN_ID_REUSED", 409);
        return { run: runFrom(prior), duplicate: true, raised: [], cleared: [] };
      }
      const schedule = this.latestSchedule(input.checkId);
      if (!schedule) throw new MirrorReconciliationError("CHECK_SCHEDULE_NOT_FOUND", 404);
      const result = compareMirror(schedule, input, at);
      const observedAt = result.observedAt, dispositions: Record<FindingDisposition, number> = { opened: 0, repeated: 0, reopened: 0, cleared: 0 };
      const raised: ReconciliationFinding[] = [], cleared: string[] = [];
      const mark = this.db.prepare("INSERT INTO mirror_reconciliation_run_findings(run_id,fingerprint,disposition) VALUES(?,?,?)");

      for (const f of result.findings) {
        const existing = this.db.prepare("SELECT status FROM mirror_reconciliation_findings WHERE fingerprint=?").get(f.fingerprint);
        const conflict = JSON.stringify(f.conflict);
        let disposition: FindingDisposition;
        if (!existing) {
          this.db.prepare(`INSERT INTO mirror_reconciliation_findings(fingerprint,check_id,comparison_id,category,record_key,status,occurrences,
              first_run_id,last_run_id,cleared_by_run_id,first_seen_at,last_seen_at,cleared_at,conflict) VALUES(?,?,?,?,?,'open',1,?,?,NULL,?,?,NULL,?)`)
            .run(f.fingerprint, result.checkId, f.comparisonId, f.conflict.category, f.recordKey, result.runId, result.runId, observedAt, observedAt, conflict);
          disposition = "opened";
        } else {
          disposition = existing.status === "open" ? "repeated" : "reopened";
          this.db.prepare(`UPDATE mirror_reconciliation_findings SET status='open',occurrences=occurrences+1,last_run_id=?,last_seen_at=?,
              cleared_by_run_id=NULL,cleared_at=NULL,conflict=? WHERE fingerprint=?`).run(result.runId, observedAt, conflict, f.fingerprint);
        }
        if (disposition !== "repeated") raised.push(f);
        dispositions[disposition]++;
        mark.run(result.runId, f.fingerprint, disposition);
      }

      const seen = new Set(result.findings.map(f => f.fingerprint));
      const clear = this.db.prepare("UPDATE mirror_reconciliation_findings SET status='cleared',cleared_by_run_id=?,cleared_at=? WHERE fingerprint=?");
      for (const c of result.comparisons) {
        if (c.comparison.coverage !== "complete") continue;
        const open = this.db.prepare("SELECT fingerprint FROM mirror_reconciliation_findings WHERE check_id=? AND comparison_id=? AND status='open'")
          .all(result.checkId, c.comparison.id);
        for (const { fingerprint } of open) {
          if (seen.has(String(fingerprint))) continue;
          clear.run(result.runId, observedAt, String(fingerprint));
          mark.run(result.runId, String(fingerprint), "cleared");
          cleared.push(String(fingerprint));
          dispositions.cleared++;
        }
      }

      const inserted = this.db.prepare(`INSERT INTO mirror_reconciliation_runs(run_id,check_id,schedule_version,input_digest,observed_at,outcome,body)
          VALUES(?,?,?,?,?,?,?)`).run(result.runId, result.checkId, result.scheduleVersion, inputDigest, observedAt, result.outcome,
        JSON.stringify({ ...result, dispositions }));
      return { run: { ...result, dispositions, sequence: Number(inserted.lastInsertRowid) }, duplicate: false, raised, cleared };
    });
  }

  /** The audit trail of runs for a check, newest first. */
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

  /** The latest run as `comparisons` and `conflicts` for an operations-control source snapshot, or null before any run. */
  latestSlice(checkId: string) {
    const [latest] = this.runs(checkId, 1).runs;
    return latest ? { ...toOperationsControlSlice(latest), observedAt: latest.observedAt, outcome: latest.outcome } : null;
  }
}
