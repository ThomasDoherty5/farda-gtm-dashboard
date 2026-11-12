// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freshnessStateOf, staleReasonText, type SourceFreshness } from "../adapter/freshness.ts";
import { FRESHNESS_WORDS } from "../features/analytics/freshness.ts";
import {
  MIRROR_FRESHNESS_STATES, MIRROR_FRESHNESS_WORDS, MIRROR_IDS, PROPOSED_DEFAULT_MIRROR_POLICIES, classifyMirrorFreshness, evidenceFrom,
  mirrorFreshnessBadge, mirrorFreshnessDetail, mirrorFreshnessStateOf, mirrorRunSchema, planMirrorIncidents, resolveMirrorPolicies,
  summarizeMirrorFreshness, toD13SourceFreshness, type MirrorFreshnessState, type MirrorId, type MirrorRun,
} from "./mirrorFreshness.ts";

const NOW = Date.parse("2027-02-10T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const policies = resolveMirrorPolicies({}, MIRROR_IDS);
let n = 0;
function run(mirrorId: MirrorId, outcome: MirrorRun["outcome"], finishedMinutesAgo: number, extra: Partial<MirrorRun> = {}): MirrorRun {
  return mirrorRunSchema.parse({ runId: `synthetic-run-${++n}`, mirrorId, startedAt: ago(finishedMinutesAgo + 2), finishedAt: ago(finishedMinutesAgo), outcome,
    coverageWatermark: outcome === "complete" ? ago(finishedMinutesAgo + 1) : null,
    counts: { rowsRead: 40, rowsChanged: outcome === "complete" ? 3 : null, rowsExpected: null }, reasonCode: null, ...extra });
}
const classify = (mirrorId: MirrorId, latest: MirrorRun | null, complete: MirrorRun | null, policy = policies[mirrorId]) =>
  classifyMirrorFreshness(policy, evidenceFrom(latest, complete), NOW);

/** One row per state, used by the classifier tests and by the AC7 parity checks below. */
function matrix(): { name: string; mirrorId: MirrorId; latest: MirrorRun | null; complete: MirrorRun | null; state: MirrorFreshnessState; configured?: boolean }[] {
  const current = run("orders", "complete", 10), quiet = run("shipments", "complete", 10, { counts: { rowsRead: 40, rowsChanged: 0, rowsExpected: 40 } });
  const old = run("stock", "complete", 120), lagging = run("support", "complete", 5, { coverageWatermark: ago(180) });
  const beforePartial = run("orders", "complete", 30), beforeFailure = run("finance", "complete", 600), beforeRevoked = run("stock", "complete", 30);
  const ledger = run("finance", "complete", 25 * 60), oldLedger = run("finance", "complete", 27 * 60), registry = run("content", "complete", 10);
  return [
    { name: "never synced", mirrorId: "orders", latest: null, complete: null, state: "neverSynced" },
    { name: "complete run with changes", mirrorId: "orders", latest: current, complete: current, state: "current" },
    { name: "complete run that found nothing new", mirrorId: "shipments", latest: quiet, complete: quiet, state: "noChange" },
    { name: "complete run past the Sheets threshold", mirrorId: "stock", latest: old, complete: old, state: "stale" },
    { name: "recent run whose coverage watermark lags", mirrorId: "support", latest: lagging, complete: lagging, state: "stale" },
    { name: "partial run after a complete one", mirrorId: "orders", latest: run("orders", "partial", 5), complete: beforePartial, state: "partial" },
    { name: "failed run", mirrorId: "finance", latest: run("finance", "failed", 5, { reasonCode: "SOURCE_TIMEOUT" }), complete: beforeFailure, state: "error" },
    { name: "access revoked", mirrorId: "stock", latest: run("stock", "accessRevoked", 5), complete: beforeRevoked, state: "accessRevoked" },
    { name: "QuickBooks ledger inside 26 hours", mirrorId: "finance", latest: ledger, complete: ledger, state: "current" },
    { name: "QuickBooks ledger past 26 hours", mirrorId: "finance", latest: oldLedger, complete: oldLedger, state: "stale" },
    { name: "registry without an approved threshold", mirrorId: "content", latest: registry, complete: registry, state: "unknown" },
    { name: "thresholds set but no run recorder bound", mirrorId: "orders", latest: current, complete: current, state: "unknown", configured: false },
  ];
}
const summaryOf = (row: ReturnType<typeof matrix>[number]) =>
  summarizeMirrorFreshness(row.configured === false ? resolveMirrorPolicies({}, [])[row.mirrorId] : policies[row.mirrorId], evidenceFrom(row.latest, row.complete), NOW);

describe("mirror freshness configuration (AC1)", () => {
  it("covers every mirror with proposed defaults: Sheets 1 hour, QuickBooks 26 hours, registries unset", () => {
    expect(Object.keys(PROPOSED_DEFAULT_MIRROR_POLICIES)).toEqual([...MIRROR_IDS]);
    for (const id of ["orders", "shipments", "stock", "support"] as const) expect(policies[id]).toMatchObject({ provider: "google-sheets", staleAfterMinutes: 60, basis: "proposed-default" });
    expect(policies.finance).toMatchObject({ provider: "quickbooks", staleAfterMinutes: 26 * 60, basis: "proposed-default" });
    expect(policies.content).toMatchObject({ provider: "notion", staleAfterMinutes: null });
    expect(policies.collaborations).toMatchObject({ provider: "notion", staleAfterMinutes: null });
  });
  it("takes owner overrides and marks them configured", () => {
    const configured = resolveMirrorPolicies({ orders: { staleAfterMinutes: 90 }, content: { staleAfterMinutes: 240, checkEveryMinutes: 30 } });
    expect(configured.orders).toMatchObject({ staleAfterMinutes: 90, checkEveryMinutes: 15, basis: "configured" });
    expect(configured.content).toMatchObject({ staleAfterMinutes: 240, checkEveryMinutes: 30, basis: "configured" });
    expect(configured.stock.basis).toBe("proposed-default");
  });
  it("refuses unknown mirrors, unknown fields, bad numbers and a check slower than its threshold", () => {
    expect(() => resolveMirrorPolicies({ invented: {} } as never)).toThrow("INVALID_MIRROR_POLICY");
    expect(() => resolveMirrorPolicies({ orders: { staleAfterMinutes: 0 } })).toThrow("INVALID_MIRROR_POLICY");
    expect(() => resolveMirrorPolicies({ orders: { staleAfterMinutes: 30, extra: 1 } as never })).toThrow("INVALID_MIRROR_POLICY");
    expect(() => resolveMirrorPolicies({ orders: { staleAfterMinutes: 10, checkEveryMinutes: 15 } })).toThrow("MIRROR_CHECK_SLOWER_THAN_THRESHOLD");
    expect(() => resolveMirrorPolicies({}, ["orders", "orders"])).toThrow("INVALID_MIRROR_RUN_BINDING");
    expect(() => resolveMirrorPolicies({}, ["invented"] as never)).toThrow("INVALID_MIRROR_RUN_BINDING");
  });
  it("binds run recorders explicitly: thresholds alone leave a mirror unknown, never never-synced", () => {
    const thresholdsOnly = resolveMirrorPolicies({ orders: { staleAfterMinutes: 90 } });
    for (const id of MIRROR_IDS) expect(thresholdsOnly[id].runsBound).toBe(false);
    expect(classifyMirrorFreshness(thresholdsOnly.orders, evidenceFrom(null, null), NOW)).toEqual({ state: "unknown", reasonCodes: ["MIRROR_RUNS_NOT_BOUND"], ageMinutes: null, valuesAreCurrent: false });
    const some = resolveMirrorPolicies({}, ["orders", "finance"]);
    expect(MIRROR_IDS.filter(id => some[id].runsBound)).toEqual(["orders", "finance"]);
  });
});

describe("mirror freshness classification (AC2, AC3)", () => {
  it.each(matrix().map(row => [row.name, row] as const))("%s", (_name, row) => {
    expect(summaryOf(row).state).toBe(row.state);
  });

  it("uses complete-run coverage plus the watermark, never the newest row", () => {
    // A run cannot carry a newest-row time at all.
    const base = run("orders", "complete", 10);
    expect(mirrorRunSchema.safeParse({ ...base, newestRowAt: ago(1) }).success).toBe(false);
    expect(mirrorRunSchema.safeParse({ ...base, counts: { ...base.counts, newestRowAt: ago(1) } }).success).toBe(false);
    // A partial run, however recent and however many rows it read, cannot advance freshness.
    const old = run("orders", "complete", 300);
    expect(mirrorRunSchema.safeParse({ ...run("orders", "partial", 1), coverageWatermark: ago(1) }).success).toBe(false);
    expect(classify("orders", run("orders", "partial", 1, { counts: { rowsRead: 9_999, rowsChanged: null, rowsExpected: null } }), old))
      .toMatchObject({ state: "partial", reasonCodes: expect.arrayContaining(["MIRROR_STALE"]) });
    // A run that just finished but only proved coverage to three hours ago is stale; a quiet complete run is current.
    expect(classify("support", run("support", "complete", 1, { coverageWatermark: ago(180) }), null).state).toBe("unknown");
    const lag = run("support", "complete", 1, { coverageWatermark: ago(180) });
    expect(classify("support", lag, lag)).toMatchObject({ state: "stale", ageMinutes: 180 });
    // A complete run must say how far its coverage reaches and how many rows changed.
    expect(mirrorRunSchema.safeParse({ ...base, coverageWatermark: null }).success).toBe(false);
    expect(mirrorRunSchema.safeParse({ ...base, counts: { ...base.counts, rowsChanged: null } }).success).toBe(false);
    expect(mirrorRunSchema.safeParse({ ...base, counts: { rowsRead: 3, rowsChanged: 0, rowsExpected: 4 } }).success).toBe(false);
  });

  it("reads the highest watermark when overlapping complete runs finish out of order", () => {
    // B started earlier and finished later than A, so its proven coverage is older. A's coverage still counts.
    const a = run("orders", "complete", 20, { coverageWatermark: ago(25) });
    const b = run("orders", "complete", 10, { startedAt: ago(90), coverageWatermark: ago(90) });
    expect(classify("orders", b, a)).toMatchObject({ state: "current", ageMinutes: 25 });
    expect(classify("orders", b, b)).toMatchObject({ state: "stale", ageMinutes: 90 });
  });

  it("treats a successful complete run that found nothing new as current, not stale", () => {
    const quiet = run("orders", "complete", 50, { counts: { rowsRead: 0, rowsChanged: 0, rowsExpected: 0 } });
    expect(classify("orders", quiet, quiet)).toEqual({ state: "noChange", reasonCodes: ["MIRROR_NO_CHANGE"], ageMinutes: 51, valuesAreCurrent: true });
  });

  it("keeps never-synced, failed and revoked distinct, and failure before any success is not never-synced", () => {
    const failed = run("orders", "failed", 5);
    expect(classify("orders", failed, null)).toMatchObject({ state: "error", reasonCodes: ["MIRROR_SYNC_FAILED", "MIRROR_NO_COMPLETE_RUN"] });
    expect(classify("orders", run("orders", "accessRevoked", 5), null).state).toBe("accessRevoked");
    expect(classify("orders", null, null)).toMatchObject({ state: "neverSynced", ageMinutes: null, valuesAreCurrent: false });
  });

  it("never treats unknown as healthy or zero", () => {
    const future = { ...run("orders", "complete", 10), finishedAt: new Date(NOW + 60_000).toISOString() };
    for (const c of [
      classify("orders", future, future),
      classify("orders", run("orders", "partial", 5), run("orders", "complete", 1)), // complete newer than latest
      classifyMirrorFreshness(policies.orders, evidenceFrom(null, null), Number.NaN),
      classify("content", run("content", "complete", 1), null),
    ]) expect(c).toMatchObject({ state: "unknown", valuesAreCurrent: false, ageMinutes: null });
    expect(MIRROR_FRESHNESS_WORDS.unknown).toMatchObject({ valuesAreCurrent: false, tone: "neutral" });
  });
});

describe("one derivation for the badge, the detail and D-13 (AC7)", () => {
  it.each(matrix().map(row => [row.name, row] as const))("%s: badge, detail and server state agree", (_name, row) => {
    const summary = summaryOf(row);
    const badge = mirrorFreshnessBadge(summary), detail = mirrorFreshnessDetail(summary);
    expect(badge.state).toBe(row.state);
    expect(detail.state).toBe(badge.state);
    expect(mirrorFreshnessStateOf(summary)).toBe(summary.state);
    expect([badge.label, badge.tone]).toEqual([detail.label, detail.tone]);
    expect(detail.valuesAreCurrent).toBe(summary.valuesAreCurrent);
    // The viewer's clock never changes the verdict: a serialized summary reads the same later.
    expect(mirrorFreshnessBadge(JSON.parse(JSON.stringify(summary)))).toEqual(badge);
  });

  it.each(matrix().map(row => [row.name, row] as const))("%s: the D-13 client path reads the same state", (_name, row) => {
    const summary = summaryOf(row), projected = toD13SourceFreshness(summary);
    const expected: Record<MirrorFreshnessState, ReturnType<typeof freshnessStateOf>> = {
      current: "current", noChange: "noChange", partial: "partial", error: "error", neverSynced: "neverSynced", stale: "error", accessRevoked: "error", unknown: null };
    const entry: SourceFreshness | null = projected && { sourceRef: { source: summary.mirrorId, accountId: "synthetic-account", sourceId: null, canonicalId: null, url: null,
      identityState: "unresolved", provenanceRef: "synthetic" }, observedAt: summary.checkedAt, mirroredAt: null, ...projected };
    expect(freshnessStateOf(entry)).toBe(expected[row.state]);
    // Without the explicit state, the D-13 fallback still never reads an unhealthy mirror as current.
    if (entry && !summary.valuesAreCurrent && row.state !== "neverSynced") {
      const fallback: SourceFreshness = { ...entry, freshnessState: undefined };
      expect(freshnessStateOf(fallback)).toBe("error");
    }
    if (row.state === "stale") expect(staleReasonText(entry)).toBe("MIRROR_STALE");
    if (row.state === "accessRevoked") expect(staleReasonText(entry)).toBe("MIRROR_ACCESS_REVOKED");
  });

  it("a summary whose state disagrees with its own evidence is unknown on every surface", () => {
    const row = matrix().find(r => r.state === "stale")!;
    const forged = { ...summaryOf(row), state: "current" as const, valuesAreCurrent: true };
    expect(mirrorFreshnessBadge(forged).state).toBe("unknown");
    expect(mirrorFreshnessDetail(forged)).toMatchObject({ state: "unknown", reasonCodes: ["MIRROR_STATE_UNVERIFIED"], lastCompleteRunAt: null });
    expect(toD13SourceFreshness(forged)).toBeNull();
    expect(planMirrorIncidents(forged, [{ incidentId: "mfi-" + "a".repeat(32), mirrorId: row.mirrorId, state: "stale", openedAfterRunSequence: 0 }], 9).clear).toEqual([]);
    expect(mirrorFreshnessBadge(null).state).toBe("unknown");
    // A malformed wire summary reads as unknown instead of throwing.
    const { policy: _policy, ...noPolicy } = summaryOf(row);
    void _policy;
    expect(mirrorFreshnessDetail(noPolicy as never)).toMatchObject({ state: "unknown", staleAfterMinutes: null });
    expect(mirrorFreshnessBadge({ ...summaryOf(row), evidence: { latestRun: 7, lastComplete: "x" } } as never).state).toBe("unknown");
  });

  it("reuses the analytics freshness words where the states overlap", () => {
    for (const state of ["noChange", "stale", "partial", "error", "neverSynced"] as const) expect(MIRROR_FRESHNESS_WORDS[state]).toEqual(FRESHNESS_WORDS[state]);
    expect(MIRROR_FRESHNESS_WORDS.current).toMatchObject({ tone: FRESHNESS_WORDS.fresh.tone, valuesAreCurrent: true });
    expect(Object.keys(MIRROR_FRESHNESS_WORDS).sort()).toEqual([...MIRROR_FRESHNESS_STATES].sort());
  });

  it("stays client-safe: the classifier imports no Node, storage or provider module", () => {
    const source = readFileSync(new URL("./mirrorFreshness.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1])).toEqual(["zod", "../adapter/contract.ts"]);
    expect(source).toMatch(/^import type \{ FreshnessState \} from "\.\.\/adapter\/contract\.ts";$/m);
  });
});


describe("independent freshness regressions", () => {
  it("turns stale immediately after the threshold, without rounding away 59 seconds", () => {
    const r = run("orders", "complete", 60, {coverageWatermark: ago(60)}), evidence = evidenceFrom(r, r);
    expect(classifyMirrorFreshness(policies.orders, evidence, NOW - 1).state).toBe("current");
    expect(classifyMirrorFreshness(policies.orders, evidence, NOW).state).toBe("current");
    expect(classifyMirrorFreshness(policies.orders, evidence, NOW + 1).state).toBe("stale");
  });
  it("does not trust altered ages, reasons or healthy flags even when the state string matches", () => {
    const summary = summaryOf(matrix().find(r => r.state === "stale")!);
    for (const patch of [{ageMinutes:0}, {reasonCodes:[]}, {valuesAreCurrent:true}, {label:"Private customer note"}]) {
      const forged = {...summary,...patch};
      expect(mirrorFreshnessStateOf(forged)).toBe("unknown");
      expect(mirrorFreshnessDetail(forged)).toMatchObject({ageMinutes:null,lastCompleteRunAt:null,reasonCodes:["MIRROR_STATE_UNVERIFIED"]});
    }
  });
});
