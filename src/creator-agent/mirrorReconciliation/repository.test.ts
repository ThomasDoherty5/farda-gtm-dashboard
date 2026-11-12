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

const SECRET = "synthetic-test-secret-0123456789abcdef";
const row = (key: string, amountMinor: number, extra: Partial<ReconciliationRow> = {}): ReconciliationRow =>
  ({ key, scope: "synthetic-store-a", grain: "order", period: DAY, currency: "GBP", amountMinor, read: "complete", ...extra });
const read = (side: ReadCoverage["side"], state: ReadCoverage["state"] = "complete", extra: Partial<ReadCoverage> = {}): ReadCoverage =>
  ({ side, scope: "synthetic-store-a", grain: "order", period: DAY, state, version: `synthetic-${side}-v1`, readAt: "2027-02-12T05:00:00Z",
    sourceAsOf: state === "complete" ? extra.readAt ?? "2027-02-12T05:00:00Z" : null, ...extra });
const input = (runId: string, extra: Partial<CheckInput> = {}): CheckInput => ({ runId, checkId: schedule.checkId, scheduleVersion: 1,
  periods: [DAY], coverage: [read("source"), read("mirror")], sourceRows: [], mirrorRows: [], ...extra });
const twoDifferences = { sourceRows: [row("order-1", 1000), row("order-2", 500)], mirrorRows: [row("order-1", 900)] };

function setup(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS capability_scope(id INTEGER PRIMARY KEY,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT OR IGNORE INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId, scope.accountId, scope.environment);
  const clock = { at: START, reads: 0 };
  const repo = new MirrorReconciliationRepository(db, scope, { secret: SECRET, now: () => { clock.reads++; return clock.at; } });
  return { db, repo, clock };
}
const count = (db: InstanceType<typeof DatabaseSync>, table: string) => Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);

describe("mirror reconciliation repository", () => {
  it("keeps a finding open when a later poll presents an older matching snapshot", () => {
    const { repo, clock } = setup();
    repo.saveSchedule(schedule);
    repo.recordCheck(input("synthetic-initial", { sourceRows: [row("order-1", 400)], mirrorRows: [row("order-1", 500)] }));
    clock.at += 3_600_000;
    const sameRows = { sourceRows: [row("order-1", 400)], mirrorRows: [row("order-1", 400)] };
    const delayed = repo.recordCheck(input("synthetic-delayed", { ...sameRows, coverage: [
      read("source", "complete", { readAt: "2027-02-12T06:30:00Z", sourceAsOf: "2027-02-12T04:30:00Z" }),
      read("mirror", "complete", { readAt: "2027-02-12T06:30:00Z" }),
    ] }));
    expect(delayed).toMatchObject({ cleared: [], run: { dispositions: { stale: 1 } } });
    expect(repo.findings(schedule.checkId, "open")).toHaveLength(1);
    const fresh = repo.recordCheck(input("synthetic-fresh", { ...sameRows, coverage: [
      read("source", "complete", { readAt: "2027-02-12T06:31:00Z" }),
      read("mirror", "complete", { readAt: "2027-02-12T06:31:00Z" }),
    ] }));
    expect(fresh.run.dispositions.cleared).toBe(1);
    expect(repo.findings(schedule.checkId, "open")).toHaveLength(0);
  });

  it("refuses a database bound to another scope", () => {
    const { db } = setup();
    expect(() => new MirrorReconciliationRepository(db, { ...scope, accountId: "synthetic-other" }, { secret: SECRET })).toThrow("DATABASE_SCOPE_MISMATCH");
    expect(() => new MirrorReconciliationRepository(db, scope, { secret: "" })).toThrow("INVALID_RECONCILIATION_SECRET");
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
    expect(slice).toMatchObject({ outcome: "differences", truncated: false, coverage: "complete", openFindings: 2, unconfirmedOpenFindings: 0 });
    expect(slice.conflicts).toHaveLength(2);
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
    const repo = new MirrorReconciliationRepository(db, scope, { secret: SECRET, now: () => Number.NaN });
    expect(() => repo.saveSchedule(schedule)).toThrow("INVALID_RECONCILIATION_CLOCK");
  });

  it("clears an orphan once a complete mirror read no longer has it", () => {
    const { repo, clock } = setup();
    repo.saveSchedule(schedule);
    const retiredRead = read("mirror", "complete", { scope: "synthetic-retired-store" });
    const o1 = repo.recordCheck(input("o1", { coverage: [read("source"), read("mirror"), retiredRead],
      mirrorRows: [row("X1", 10, { scope: "synthetic-retired-store" })] }));
    expect(o1.raised.map(f => f.conflict.category)).toEqual(["orphan"]);
    clock.at += 60_000;
    const o2 = repo.recordCheck(input("o2", { coverage: [read("source"), read("mirror"), retiredRead] }));
    expect(o2).toMatchObject({ cleared: [o1.raised[0]!.fingerprint], run: { outcome: "matched", dispositions: { cleared: 1 } } });
    expect(repo.findings(schedule.checkId, "open")).toEqual([]);
    expect(repo.latestSlice(schedule.checkId)).toMatchObject({ coverage: "complete", openFindings: 0 });
  });

  it("does not let a run with older reads clear or reopen a finding, whatever order runs are recorded in", () => {
    const { repo, clock } = setup();
    repo.saveSchedule(schedule);
    const at = (readAt: string) => [read("source", "complete", { readAt }), read("mirror", "complete", { readAt })];
    const n1 = repo.recordCheck(input("n1", { coverage: at("2027-02-12T05:30:00Z"), ...twoDifferences }));
    expect(n1.raised).toHaveLength(2);
    clock.at += 60_000;
    const n0 = repo.recordCheck(input("n0", { coverage: at("2027-02-12T05:00:00Z"), sourceRows: [row("order-1", 1000)], mirrorRows: [row("order-1", 1000)] }));
    expect(n0).toMatchObject({ cleared: [], run: { outcome: "matched", dispositions: { cleared: 0, stale: 2 } } });
    expect(repo.findings(schedule.checkId, "open").map(f => f.basis)).toEqual([
      { source: "2027-02-12T05:30:00.000Z", mirror: "2027-02-12T05:30:00.000Z" }, { source: "2027-02-12T05:30:00.000Z", mirror: "2027-02-12T05:30:00.000Z" }]);
    expect(repo.runFindings("n0").map(f => f.disposition)).toEqual(["stale", "stale"]);
    // The matched but older run is the latest recorded; the slice still shows the open findings and is not complete.
    expect(repo.latestSlice(schedule.checkId)).toMatchObject({ outcome: "matched", coverage: "partial", openFindings: 2, unconfirmedOpenFindings: 2 });
    expect(repo.latestSlice(schedule.checkId)!.conflicts).toHaveLength(2);

    clock.at += 60_000;
    const n2 = repo.recordCheck(input("n2", { coverage: at("2027-02-12T05:45:00Z"), sourceRows: [row("order-1", 1000)], mirrorRows: [row("order-1", 1000)] }));
    expect(n2.cleared).toHaveLength(2);
    clock.at += 60_000;
    // An even older run that still sees the differences cannot reopen what a newer read cleared.
    const late = repo.recordCheck(input("late", { coverage: at("2027-02-12T05:10:00Z"), ...twoDifferences }));
    expect(late).toMatchObject({ raised: [], run: { dispositions: { reopened: 0, stale: 2 } } });
    expect(repo.findings(schedule.checkId, "open")).toEqual([]);
  });

  it("keeps findings from a period outside the latest run open and counted in the slice", () => {
    const { repo, clock } = setup();
    repo.saveSchedule(schedule);
    repo.recordCheck(input("synthetic-run-1", twoDifferences));
    clock.at += 24 * 3_600_000;
    const next = "2027-02-12";
    const later = (side: ReadCoverage["side"]) => read(side, "complete", { period: next, readAt: "2027-02-13T05:00:00Z" });
    const run = repo.recordCheck(input("synthetic-run-2", { periods: [next], coverage: [later("source"), later("mirror")] }));
    expect(run.run).toMatchObject({ outcome: "matched", dispositions: { cleared: 0 } });
    expect(repo.findings(schedule.checkId, "open")).toHaveLength(2);
    const slice = repo.latestSlice(schedule.checkId)!;
    expect(slice).toMatchObject({ outcome: "matched", coverage: "partial", openFindings: 2, unconfirmedOpenFindings: 2, conflicts: [] });
  });
  it("keeps tracking and clearing open findings after the secret rotates", () => {
    const { db, repo, clock } = setup();
    repo.saveSchedule(schedule);
    const r1 = repo.recordCheck(input("r1", twoDifferences));
    const idsA = r1.run.findings.map(f => f.conflict.id).sort();
    // Restart with another secret.
    const now = () => clock.at;
    const rotated = new MirrorReconciliationRepository(db, scope, { secret: "synthetic-rotated-secret-fedcba9876543210", now });
    clock.at += 60_000;
    const before = rotated.latestSlice(schedule.checkId)!;
    expect(before.conflicts.map(c => c.id).sort()).not.toEqual(idsA);
    expect(before.conflicts.map(c => c.comparisonId)).toEqual([before.comparisons[0]!.id, before.comparisons[0]!.id]);
    expect(operationsControlSourceSchema.safeParse({ scope: { ...scope }, revision: "synthetic-revision-1", observedAt: before.observedAt,
      coverage: before.coverage, roles: [], tasks: [], takeovers: [], permissions: [], reports: [], attribution: [], handoffs: [],
      comparisons: before.comparisons, conflicts: before.conflicts }).error?.issues).toBeUndefined();
    const r2 = rotated.recordCheck(input("r2", twoDifferences));
    expect(r2.run.dispositions).toMatchObject({ opened: 0, repeated: 2 });
    const idsB = r2.run.findings.map(f => f.conflict.id).sort();
    expect(idsB).not.toEqual(idsA);
    expect(rotated.findings(schedule.checkId, "open").map(f => f.conflict.id).sort()).toEqual(idsB);
    expect(new Set(rotated.findings(schedule.checkId, "open").map(f => f.comparisonId))).toEqual(new Set(r2.run.findings.map(f => f.comparisonId)));
    clock.at += 60_000;
    const r3 = rotated.recordCheck(input("r3", { sourceRows: [row("order-1", 1000)], mirrorRows: [row("order-1", 1000)] }));
    expect(r3).toMatchObject({ run: { outcome: "matched", dispositions: { cleared: 2 } } });
    expect(rotated.findings(schedule.checkId, "open")).toEqual([]);
    expect(rotated.latestSlice(schedule.checkId)).toMatchObject({ coverage: "complete", openFindings: 0 });
  });

  it("clears a finding opened under an earlier secret even without a repeat in between", () => {
    const { db, repo, clock } = setup();
    repo.saveSchedule(schedule);
    repo.recordCheck(input("r1", twoDifferences));
    const rotated = new MirrorReconciliationRepository(db, scope, { secret: "synthetic-rotated-secret-fedcba9876543210", now: () => clock.at });
    clock.at += 60_000;
    const r2 = rotated.recordCheck(input("r2", { sourceRows: [row("order-1", 1000)], mirrorRows: [row("order-1", 1000)] }));
    expect(r2.cleared).toHaveLength(2);
  });
});
