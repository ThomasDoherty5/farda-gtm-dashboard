// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIRROR_IDS, mirrorIncidentPayloadSchema, type MirrorId, type MirrorRun } from "./mirrorFreshness.ts";
import { MirrorFreshnessRepository, unconfiguredMirrorFreshness, type MirrorFreshnessOptions } from "./mirrorFreshnessRepository.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const scope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
const START = Date.parse("2027-02-10T12:00:00Z");
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup(options: MirrorFreshnessOptions = {}, path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS capability_scope(id INTEGER PRIMARY KEY,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT OR IGNORE INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId, scope.accountId, scope.environment);
  const clock = { at: START };
  const repo = new MirrorFreshnessRepository(db, scope, { now: () => clock.at, boundMirrors: MIRROR_IDS, ...options });
  const iso = (minutesFromStart: number) => new Date(START + minutesFromStart * 60_000).toISOString();
  let n = 0;
  const record = (mirrorId: MirrorId, outcome: MirrorRun["outcome"], finishedAt: number, extra: Partial<MirrorRun> = {}) => repo.recordRun({
    runId: `synthetic-run-${++n}`, mirrorId, startedAt: iso(finishedAt - 1), finishedAt: iso(finishedAt), outcome,
    coverageWatermark: outcome === "complete" ? iso(finishedAt) : null,
    counts: { rowsRead: 12, rowsChanged: outcome === "complete" ? 2 : null, rowsExpected: null }, reasonCode: null, ...extra }).run;
  const advance = (minutes: number) => { clock.at += minutes * 60_000; };
  return { db, repo, clock, record, advance, iso };
}
const incidentCount = (db: InstanceType<typeof DatabaseSync>, status?: string) =>
  Number(db.prepare(`SELECT COUNT(*) n FROM mirror_freshness_incidents${status ? " WHERE status=?" : ""}`).get(...(status ? [status] : []))!.n);

describe("mirror freshness repository", () => {
  it("refuses a database bound to another scope", () => {
    const { db } = setup();
    expect(() => new MirrorFreshnessRepository(db, { ...scope, accountId: "another" })).toThrow("DATABASE_SCOPE_MISMATCH");
  });

  it("records runs idempotently and refuses reuse, future runs and an impossible watermark", () => {
    const { repo, record, iso } = setup();
    const first = record("orders", "complete", -30);
    expect(repo.recordRun(first)).toEqual({ run: first, duplicate: true });
    expect(() => repo.recordRun({ ...first, counts: { ...first.counts, rowsChanged: 9 } })).toThrow("MIRROR_RUN_ID_REUSED");
    expect(() => record("orders", "complete", 5)).toThrow("MIRROR_RUN_IN_FUTURE");
    // Coverage past the run's own finish is the one impossible watermark.
    expect(() => record("orders", "complete", -20, { coverageWatermark: iso(-10) })).toThrow("INVALID_MIRROR_RUN");
    // An earlier run recorded late is stored.
    expect(record("orders", "complete", -50).outcome).toBe("complete");
    expect(repo.evaluate().find(s => s.mirrorId === "orders")).toMatchObject({ state: "current", evidence: { lastComplete: { runId: first.runId } } });
  });

  it("stores an overlapping complete run with an older watermark and classifies from the highest", () => {
    const { db, repo, record, iso } = setup();
    // A proves coverage to 30 minutes ago. B started earlier, finished later, and proves coverage only to 90 minutes ago.
    const a = record("orders", "complete", -20, { startedAt: iso(-30), coverageWatermark: iso(-30) });
    const b = record("orders", "complete", -10, { startedAt: iso(-90), coverageWatermark: iso(-90) });
    expect(Number(db.prepare("SELECT COUNT(*) n FROM mirror_freshness_runs WHERE mirror_id='orders'").get()!.n)).toBe(2);
    expect(repo.evaluate().find(s => s.mirrorId === "orders")).toMatchObject({ state: "current", ageMinutes: 30,
      evidence: { latestRun: { runId: b.runId }, lastComplete: { runId: a.runId, coverageWatermark: a.coverageWatermark } } });
    // A run that finishes later and proves more coverage takes over.
    const c = record("orders", "complete", -2, { startedAt: iso(-5), coverageWatermark: iso(-5) });
    expect(repo.evaluate().find(s => s.mirrorId === "orders")).toMatchObject({ ageMinutes: 5, evidence: { lastComplete: { runId: c.runId } } });
  });

  it("reads the clock inside the write lock, and evaluates from one read snapshot", () => {
    const { db } = setup();
    const seen: boolean[] = [];
    const repo = new MirrorFreshnessRepository(db, scope, { boundMirrors: MIRROR_IDS, now: () => { seen.push(db.isTransaction); return START; } });
    repo.recordRun({ runId: "synthetic-lock", mirrorId: "orders", startedAt: new Date(START - 120_000).toISOString(), finishedAt: new Date(START - 60_000).toISOString(),
      outcome: "failed", coverageWatermark: null, counts: { rowsRead: null, rowsChanged: null, rowsExpected: null }, reasonCode: null });
    repo.sweep({ force: true });
    repo.evaluate();
    expect(seen).toEqual([true, true, true]);
    expect(() => new MirrorFreshnessRepository(db, scope, { now: () => Number.NaN }).sweep()).toThrow("INVALID_MIRROR_CLOCK");
    expect(() => new MirrorFreshnessRepository(db, scope, { now: () => Number.NaN }).evaluate()).toThrow("INVALID_MIRROR_CLOCK");
    expect(db.isTransaction).toBe(false);
  });

  it("opens one incident per mirror and state and suppresses repeats (AC6)", () => {
    const { repo, record, advance } = setup();
    record("orders", "complete", -20);
    record("orders", "failed", -5, { reasonCode: "SOURCE_TIMEOUT" });
    const first = repo.sweep({ force: true });
    expect(first.incidents.opened.map(i => [i.mirrorId, i.state])).toEqual(expect.arrayContaining([["orders", "error"]]));
    const opened = first.incidents.opened.find(i => i.mirrorId === "orders")!;
    advance(15);
    record("orders", "failed", 14);
    const second = repo.sweep();
    expect(second.incidents.opened.filter(i => i.mirrorId === "orders")).toEqual([]);
    expect(second.incidents.suppressed.find(i => i.mirrorId === "orders")).toMatchObject({ event: "suppressed", incidentId: opened.incidentId, occurrences: 2, openedAt: opened.openedAt });
    // A different unhealthy state is its own incident; the first stays open.
    advance(15);
    record("orders", "partial", 29);
    const third = repo.sweep();
    expect(third.incidents.opened.find(i => i.mirrorId === "orders")).toMatchObject({ state: "partial" });
    expect(repo.openIncidents().filter(i => i.mirrorId === "orders").map(i => i.state).sort()).toEqual(["error", "partial"]);
  });

  it("checks each mirror at its configured cadence", () => {
    const { repo, advance } = setup({ policies: { finance: { checkEveryMinutes: 60 } } });
    expect(repo.sweep().skipped).toEqual([]);
    advance(14);
    expect(repo.sweep().skipped).toHaveLength(7);
    advance(1);
    expect(repo.sweep().skipped).toEqual(["finance"]);
    advance(45);
    expect(repo.sweep().skipped).toEqual([]);
  });

  it("clears only after a later complete, healthy check (AC6)", () => {
    const { db, repo, record, advance } = setup();
    const old = record("stock", "complete", -120);
    const stale = repo.sweep({ force: true }).incidents.opened.find(i => i.mirrorId === "stock")!;
    expect(stale).toMatchObject({ state: "stale", ageMinutes: 120, staleAfterMinutes: 60 });
    // Raising the threshold makes the same old run healthy, but nothing new ran, so the incident stays open.
    const relaxed = new MirrorFreshnessRepository(db, scope, { boundMirrors: MIRROR_IDS, now: () => START + 60_000, policies: { stock: { staleAfterMinutes: 240 } } });
    const sameRun = relaxed.sweep({ force: true });
    expect(sameRun.summaries.find(s => s.mirrorId === "stock")!.state).toBe("current");
    expect(sameRun.incidents.cleared).toEqual([]);
    // A later partial or failed run never clears it.
    advance(5);
    record("stock", "partial", 4);
    expect(repo.sweep({ force: true }).incidents.cleared).toEqual([]);
    // A later complete run that is still past the threshold does not clear it either.
    advance(5);
    const lagging = record("stock", "complete", 9, { coverageWatermark: new Date(Date.parse(old.coverageWatermark!) + 60_000).toISOString() });
    expect(repo.sweep({ force: true }).incidents.cleared).toEqual([]);
    expect(lagging.outcome).toBe("complete");
    // A later complete, healthy run clears both open incidents for the mirror and names the run.
    advance(5);
    const healthy = record("stock", "complete", 14, { counts: { rowsRead: 12, rowsChanged: 0, rowsExpected: 12 } });
    const cleared = repo.sweep({ force: true }).incidents.cleared;
    expect(cleared.map(i => i.state).sort()).toEqual(["partial", "stale"]);
    expect(cleared.find(i => i.state === "stale")).toMatchObject({ incidentId: stale.incidentId, event: "cleared", clearedByRunId: healthy.runId, clearReason: "healthyCompleteRun" });
    expect(repo.openIncidents().filter(i => i.mirrorId === "stock")).toEqual([]);
    expect(incidentCount(db, "cleared")).toBe(2);
    // The same state can open a fresh incident later.
    advance(120);
    expect(repo.sweep({ force: true }).incidents.opened.find(i => i.mirrorId === "stock")).toMatchObject({ state: "stale" });
    expect(repo.openIncidents().find(i => i.mirrorId === "stock")!.incidentId).not.toBe(stale.incidentId);
  });

  it("raises no incident for a mirror waiting on an owner threshold, whatever its state, and never calls unknown healthy", () => {
    const { repo, record } = setup();
    record("content", "complete", -5);
    const sweep = repo.sweep({ force: true });
    expect(sweep.summaries.find(s => s.mirrorId === "content")).toMatchObject({ state: "unknown", valuesAreCurrent: false, reasonCodes: ["MIRROR_THRESHOLD_NOT_CONFIGURED"] });
    expect(sweep.summaries.find(s => s.mirrorId === "collaborations")).toMatchObject({ state: "neverSynced", valuesAreCurrent: false });
    expect(sweep.incidents.opened.map(i => i.mirrorId)).not.toContain("content");
    expect(sweep.incidents.opened.map(i => i.mirrorId)).not.toContain("collaborations");
    // A bound mirror with a threshold that has never synced does raise one.
    expect(sweep.incidents.opened.find(i => i.mirrorId === "orders")).toMatchObject({ state: "neverSynced", latestRunId: null, counts: null });
    for (const summary of unconfiguredMirrorFreshness(START)) expect(summary).toMatchObject({ state: "unknown", valuesAreCurrent: false, reasonCodes: ["MIRROR_RUNS_NOT_BOUND"] });
  });

  it("reviewer repro: sweep, record complete runs for content and orders, sweep again, and both clear", () => {
    // The incidents below were opened while content still had a threshold, as an earlier build allowed.
    const { db, repo, record, advance } = setup({ policies: { content: { staleAfterMinutes: 120 } } });
    const first = repo.sweep({ force: true }).incidents.opened;
    expect(first.filter(i => i.mirrorId === "orders" || i.mirrorId === "content").map(i => [i.mirrorId, i.state]))
      .toEqual([["orders", "neverSynced"], ["content", "neverSynced"]]);
    // Same database, now with the proposed defaults: content has no threshold and waits on its owner.
    const pending = new MirrorFreshnessRepository(db, scope, { boundMirrors: MIRROR_IDS, now: () => START + 60_000 });
    advance(1);
    const orders = record("orders", "complete", 0), content = record("content", "complete", 0);
    const second = pending.sweep({ force: true });
    expect(second.incidents.opened.filter(i => i.mirrorId === "orders" || i.mirrorId === "content")).toEqual([]);
    expect(second.incidents.cleared.filter(i => i.mirrorId === "orders" || i.mirrorId === "content").map(i => [i.mirrorId, i.clearReason, i.clearedByRunId]))
      .toEqual([["orders", "healthyCompleteRun", orders.runId], ["content", "ownerThresholdPending", content.runId]]);
    expect(pending.openIncidents().filter(i => i.mirrorId === "orders" || i.mirrorId === "content")).toEqual([]);
    // The default build, from a fresh database, never opens the content incident in the first place.
    const fresh = setup();
    expect(fresh.repo.sweep({ force: true }).incidents.opened.map(i => i.mirrorId)).not.toContain("content");
    fresh.record("orders", "complete", 0); fresh.record("content", "complete", 0);
    fresh.advance(1);
    expect(fresh.repo.sweep({ force: true }).incidents.cleared.map(i => i.mirrorId)).toEqual(["orders"]);
    expect(fresh.repo.openIncidents().filter(i => i.mirrorId === "orders" || i.mirrorId === "content")).toEqual([]);
  });

  it("binds run recorders explicitly: an unbound mirror is unknown and raises no incident", () => {
    const { repo, record } = setup({ boundMirrors: ["orders"], policies: { stock: { staleAfterMinutes: 90 } } });
    record("stock", "failed", -1);
    const sweep = repo.sweep({ force: true });
    expect(sweep.incidents.opened.map(i => i.mirrorId)).toEqual(["orders"]);
    for (const summary of sweep.summaries.filter(s => s.mirrorId !== "orders"))
      expect(summary).toMatchObject({ state: "unknown", reasonCodes: ["MIRROR_RUNS_NOT_BOUND"], valuesAreCurrent: false, policy: { runsBound: false } });
    expect(() => setup({ boundMirrors: ["orders", "orders"] })).toThrow("INVALID_MIRROR_RUN_BINDING");
  });

  it("carries no sensitive data in run records or incident payloads (AC5)", () => {
    const { db, repo, record } = setup();
    const sensitive = ["Jane Example", "jane@example.com", "+1 555 0100", "12 Synthetic Street", "https://example.com/order/1"];
    const base = { runId: "synthetic-private", mirrorId: "support", startedAt: new Date(START - 120_000).toISOString(), finishedAt: new Date(START - 60_000).toISOString(),
      outcome: "failed", coverageWatermark: null, counts: { rowsRead: 1, rowsChanged: null, rowsExpected: null }, reasonCode: null };
    for (const leak of [{ customerEmail: sensitive[1] }, { rows: [{ name: sensitive[0] }] }, { counts: { ...base.counts, name: sensitive[0] } },
      { runId: sensitive[1] }, { runId: sensitive[4] }, { reasonCode: sensitive[2] }, { reasonCode: "Customer Jane Example complained" }])
      expect(() => repo.recordRun({ ...base, ...leak })).toThrow("INVALID_MIRROR_RUN");
    record("support", "accessRevoked", -1, { reasonCode: "PROVIDER_TOKEN_REVOKED" });
    const sweep = repo.sweep({ force: true });
    const payloads = [...sweep.incidents.opened, ...sweep.incidents.suppressed, ...sweep.incidents.cleared];
    expect(payloads.length).toBeGreaterThan(0);
    const allowed = new Set(Object.keys(mirrorIncidentPayloadSchema.shape));
    for (const payload of payloads) {
      expect(Object.keys(payload).every(key => allowed.has(key))).toBe(true);
      const text = JSON.stringify(payload);
      for (const value of sensitive) expect(text).not.toContain(value);
      expect(text).not.toMatch(/@|https?:/);
    }
    expect(payloads.find(p => p.mirrorId === "support")).toMatchObject({ state: "accessRevoked", reasonCodes: ["MIRROR_ACCESS_REVOKED", "MIRROR_NO_COMPLETE_RUN", "PROVIDER_TOKEN_REVOKED"] });
    expect(() => mirrorIncidentPayloadSchema.parse({ ...payloads[0], note: sensitive[0] })).toThrow();
    expect(String(db.prepare("SELECT group_concat(body) b FROM mirror_freshness_incidents").get()!.b)).not.toMatch(/@|Jane/);
  });

  it("keeps runs and open incidents across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "farda-mirror-freshness-")); dirs.push(dir);
    const path = join(dir, "state.sqlite");
    const first = setup({}, path);
    first.record("orders", "failed", -1);
    const opened = first.repo.sweep({ force: true }).incidents.opened.find(i => i.mirrorId === "orders")!;
    first.db.close();
    const second = setup({}, path);
    expect(second.repo.openIncidents().find(i => i.mirrorId === "orders")!.incidentId).toBe(opened.incidentId);
    expect(second.repo.sweep({ force: true }).incidents.suppressed.find(i => i.mirrorId === "orders")).toMatchObject({ occurrences: 2 });
    second.db.close();
  });
});
