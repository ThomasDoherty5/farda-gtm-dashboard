// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operationsControlSourceSchema } from "../operationsControlsSchema.ts";
import type { CheckInput, CheckSchedule, ReadCoverage, ReconciliationRow } from "./contract.ts";
import { MirrorReconciliationRepository } from "./repository.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

// All rows, scopes and versions are synthetic.
const scope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
const schedule: CheckSchedule = {
  checkId: "synthetic-orders-check", version: 1, timezone: "Europe/London", runAt: "03:00", cutoffLagMinutes: 120, coverage: { lookbackDays: 2 },
  expectedDatasets: [{ scope: "synthetic-store-a", grain: "order", amountField: "net-sales", currencies: ["GBP"] }],
};
const START = Date.parse("2027-02-12T06:00:00Z");
const DAY = "2027-02-11";
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const row = (key: string, amountMinor: number): ReconciliationRow =>
  ({ key, scope: "synthetic-store-a", grain: "order", period: DAY, currency: "GBP", amountMinor, read: "complete" });
const read = (side: ReadCoverage["side"], state: ReadCoverage["state"] = "complete"): ReadCoverage =>
  ({ side, scope: "synthetic-store-a", grain: "order", period: DAY, state, version: `synthetic-${side}-v1`, readAt: "2027-02-12T05:00:00Z" });
const input = (runId: string, extra: Partial<CheckInput> = {}): CheckInput => ({ runId, checkId: schedule.checkId, scheduleVersion: 1,
  periods: [DAY], coverage: [read("source"), read("mirror")], sourceRows: [], mirrorRows: [], ...extra });
const twoDifferences = { sourceRows: [row("order-1", 1000), row("order-2", 500)], mirrorRows: [row("order-1", 900)] };

function setup(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS capability_scope(id INTEGER PRIMARY KEY,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT OR IGNORE INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId, scope.accountId, scope.environment);
  const clock = { at: START, reads: 0 };
  const repo = new MirrorReconciliationRepository(db, scope, { now: () => { clock.reads++; return clock.at; } });
  return { db, repo, clock };
}
const count = (db: InstanceType<typeof DatabaseSync>, table: string) => Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);

describe("mirror reconciliation repository", () => {
  it("refuses a database bound to another scope", () => {
    const { db } = setup();
    expect(() => new MirrorReconciliationRepository(db, { ...scope, accountId: "synthetic-other" })).toThrow("DATABASE_SCOPE_MISMATCH");
  });

  it("AC1: stores the schedule record by version, replays it and refuses reuse or an older version", () => {
    const { db, repo } = setup();
    expect(repo.saveSchedule(schedule).changed).toBe(true);
    expect(repo.saveSchedule(schedule).changed).toBe(false);
    expect(() => repo.saveSchedule({ ...schedule, cutoffLagMinutes: 60 })).toThrow("SCHEDULE_VERSION_REUSED");
    expect(repo.saveSchedule({ ...schedule, version: 2, timezone: "America/New_York" }).changed).toBe(true);
    expect(() => repo.saveSchedule(schedule)).not.toThrow();
    expect(() => repo.saveSchedule({ ...schedule, version: 0 })).toThrow("INVALID_CHECK_SCHEDULE");
    expect(repo.schedule(schedule.checkId)).toMatchObject({ version: 2, timezone: "America/New_York", cutoffLagMinutes: 120,
      coverage: { lookbackDays: 2 }, expectedDatasets: schedule.expectedDatasets });
    expect(count(db, "mirror_reconciliation_schedules")).toBe(2);
    // Runs bind to the current schedule version.
    expect(() => repo.recordCheck(input("synthetic-run-1"))).toThrow("STALE_SCHEDULE_VERSION");
  });

  it("refuses a run with no schedule and leaves nothing behind", () => {
    const { db, repo } = setup();
    expect(() => repo.recordCheck(input("synthetic-run-1"))).toThrow("CHECK_SCHEDULE_NOT_FOUND");
    expect(count(db, "mirror_reconciliation_runs")).toBe(0);
  });

  it("AC7: replays the same run id without writing and refuses the id with different input", () => {
    const { db, repo, clock } = setup();
    repo.saveSchedule(schedule);
    const first = repo.recordCheck(input("synthetic-run-1", twoDifferences));
    expect(first).toMatchObject({ duplicate: false, run: { outcome: "differences", dispositions: { opened: 2, repeated: 0, reopened: 0, cleared: 0 } } });
    expect(first.raised.map(f => f.conflict.category).sort()).toEqual(["amount", "missing_mirror"]);
    clock.at += 3_600_000;
    const replay = repo.recordCheck(input("synthetic-run-1", twoDifferences));
    expect(replay).toEqual({ ...first, duplicate: true, raised: [], cleared: [] });
    expect([count(db, "mirror_reconciliation_runs"), count(db, "mirror_reconciliation_findings"), count(db, "mirror_reconciliation_run_findings")]).toEqual([1, 2, 2]);
    expect(() => repo.recordCheck(input("synthetic-run-1", { sourceRows: [row("order-1", 1000)] }))).toThrow("RUN_ID_REUSED");
  });

  it("AC7: suppresses identical findings on recheck and keeps an audit trail of runs and dispositions", () => {
    const { db, repo, clock } = setup();
    repo.saveSchedule(schedule);
    const first = repo.recordCheck(input("synthetic-run-1", twoDifferences));
    clock.at += 3_600_000;
    const second = repo.recordCheck(input("synthetic-run-2", twoDifferences));
    expect(second).toMatchObject({ duplicate: false, raised: [], run: { dispositions: { opened: 0, repeated: 2 } } });
    expect(second.run.findings.map(f => f.conflict.id)).toEqual(first.run.findings.map(f => f.conflict.id));
    expect(count(db, "mirror_reconciliation_findings")).toBe(2);
    const open = repo.findings(schedule.checkId, "open");
    expect(open.map(f => [f.occurrences, f.firstRunId, f.lastRunId, f.lastSeenAt])).toEqual([
      [2, "synthetic-run-1", "synthetic-run-2", "2027-02-12T07:00:00.000Z"], [2, "synthetic-run-1", "synthetic-run-2", "2027-02-12T07:00:00.000Z"]]);
    expect(repo.runFindings("synthetic-run-2").map(f => f.disposition)).toEqual(["repeated", "repeated"]);
    const trail = repo.runs(schedule.checkId);
    expect(trail).toMatchObject({ total: 2, partial: false });
    expect(trail.runs.map(r => [r.runId, r.observedAt, r.outcome])).toEqual([
      ["synthetic-run-2", "2027-02-12T07:00:00.000Z", "differences"], ["synthetic-run-1", "2027-02-12T06:00:00.000Z", "differences"]]);
    expect(repo.runs(schedule.checkId, 1)).toMatchObject({ total: 2, partial: true });
  });

  it("AC4/AC7: clears a finding only on a complete recheck, never on an incomplete one, and reopens it if it returns", () => {
    const { repo, clock } = setup();
    repo.saveSchedule(schedule);
    repo.recordCheck(input("synthetic-run-1", twoDifferences));
    clock.at += 60_000;
    // The source read is partial: nothing is cleared, nothing is called clean.
    const partial = repo.recordCheck(input("synthetic-run-2", { coverage: [read("source", "partial"), read("mirror")], sourceRows: [], mirrorRows: [] }));
    expect(partial).toMatchObject({ cleared: [], run: { outcome: "incomplete", dispositions: { cleared: 0 } } });
    expect(repo.findings(schedule.checkId, "open")).toHaveLength(2);
    clock.at += 60_000;
    const fixed = repo.recordCheck(input("synthetic-run-3", { sourceRows: [row("order-1", 1000)], mirrorRows: [row("order-1", 1000)] }));
    expect(fixed).toMatchObject({ run: { outcome: "matched", dispositions: { cleared: 2 } } });
    expect(repo.findings(schedule.checkId, "open")).toEqual([]);
    expect(repo.findings(schedule.checkId, "cleared").map(f => f.clearedByRunId)).toEqual(["synthetic-run-3", "synthetic-run-3"]);
    clock.at += 60_000;
    const back = repo.recordCheck(input("synthetic-run-4", twoDifferences));
    expect(back.raised).toHaveLength(2);
    expect(back.run.dispositions).toMatchObject({ opened: 0, reopened: 2 });
    expect(repo.findings(schedule.checkId, "open").map(f => [f.occurrences, f.clearedAt])).toEqual([[2, null], [2, null]]);
  });

  it("AC4: records an unread dataset as an incomplete run with unknown counts, never a clean zero", () => {
    const { repo } = setup();
    repo.saveSchedule(schedule);
    const { run } = repo.recordCheck(input("synthetic-run-1", { coverage: [] }));
    expect(run.outcome).toBe("incomplete");
    expect(run.comparisons[0]).toMatchObject({ outcome: "unknown", comparison: { sourceCount: null, mirrorCount: null, sourceAmount: null, mirrorAmount: null } });
    expect(repo.runs(schedule.checkId).runs[0]!.outcome).toBe("incomplete");
  });

  it("serves the latest run as a slice that parses into an operations-control source snapshot", () => {
    const { repo } = setup();
    repo.saveSchedule(schedule);
    expect(repo.latestSlice(schedule.checkId)).toBeNull();
    repo.recordCheck(input("synthetic-run-1", twoDifferences));
    const slice = repo.latestSlice(schedule.checkId)!;
    expect(slice).toMatchObject({ outcome: "differences", truncated: false });
    const parsed = operationsControlSourceSchema.safeParse({ scope: { ...scope }, revision: "synthetic-revision-1", observedAt: slice.observedAt,
      coverage: "complete", roles: [], tasks: [], takeovers: [], permissions: [], reports: [], attribution: [], handoffs: [],
      comparisons: slice.comparisons, conflicts: slice.conflicts });
    expect(parsed.error?.issues).toBeUndefined();
  });

  it("reads the clock only inside the write lock and writes nothing when the lock or the check fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-reconciliation-")); dirs.push(dir);
    const path = join(dir, "agent.sqlite");
    const { repo, clock } = setup(path);
    repo.saveSchedule(schedule);
    const other = new DatabaseSync(path);
    other.exec("BEGIN IMMEDIATE");
    const before = clock.reads;
    expect(() => repo.recordCheck(input("synthetic-run-1", twoDifferences))).toThrow(/locked|busy/i);
    expect(clock.reads).toBe(before);
    other.exec("ROLLBACK"); other.close();

    // The clock is before the period's cutoff: the check is refused inside the transaction and rolled back.
    clock.at = Date.parse("2027-02-12T01:00:00Z");
    expect(() => repo.recordCheck(input("synthetic-run-1", twoDifferences))).toThrow("PERIOD_NOT_DUE");
    expect(clock.reads).toBe(before + 1);
    expect([count(repo.db, "mirror_reconciliation_runs"), count(repo.db, "mirror_reconciliation_findings")]).toEqual([0, 0]);
    clock.at = START;
    expect(repo.recordCheck(input("synthetic-run-1", twoDifferences)).duplicate).toBe(false);
  });

  it("refuses an invalid clock", () => {
    const { db } = setup();
    const repo = new MirrorReconciliationRepository(db, scope, { now: () => Number.NaN });
    expect(() => repo.saveSchedule(schedule)).toThrow("INVALID_RECONCILIATION_CLOCK");
  });
});
