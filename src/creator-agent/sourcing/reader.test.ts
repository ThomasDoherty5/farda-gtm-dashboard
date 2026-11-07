// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../store.ts";
import { createSourcingPlanReader, isSourcingPlanRead } from "./reader.ts";
import { SourcingError, sourcingSnapshotSchema, type SourcingPlanSourceReader, type SourcingSnapshot } from "./source.ts";
import { sourcingPlanSchema } from "./contract.ts";
import { sourcingSourceFixture, sourcingTestScope as scope, sourcingTestSecret as secret, sourcingTestTime } from "./fixtures.testkit.ts";

const stores: AgentStore[] = [];
function setup(reader?: SourcingPlanSourceReader | null, options: { timeoutMs?: number } = {}) {
  const store = new AgentStore(":memory:", scope); stores.push(store);
  let clock = sourcingTestTime;
  const source = sourcingSourceFixture();
  const service = createSourcingPlanReader({ db: store.database, scope, secret, now: () => clock, sourceTimeoutMs: options.timeoutMs,
    source: reader === null ? undefined : reader ?? (async () => structuredClone(source)) });
  return { store, service, source, setTime: (value: number) => { clock = value; } };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const withSource = (mutate: (s: SourcingSnapshot) => void) => { const s = sourcingSourceFixture(); mutate(s); return async () => s; };
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a refusal"); }, (e: unknown) => e as SourcingError);

describe("the J19 source boundary", () => {
  it.each(["recipients", "creatorHandle", "providerToken", "sessionCookie"])("rejects the undeclared source field %s", (field) => {
    expect(sourcingSnapshotSchema.safeParse({ ...sourcingSourceFixture(), [field]: "not-permitted" }).success).toBe(false);
  });
  it.each([
    ["an ISO-shaped impossible date", (s: SourcingSnapshot) => { s.observedAt = "2026-02-30T00:00:00Z"; }],
    ["a capacity unit that is not native to its kind", (s: SourcingSnapshot) => { s.capacity[0]!.unit = "units"; }],
    ["a cost without a currency", (s: SourcingSnapshot) => { s.capacity[3]!.currency = null; }],
    ["used and remaining above the limit", (s: SourcingSnapshot) => { s.capacity[0]!.used = { value: 40, missingReason: null }; }],
    ["a known capacity without a receipt", (s: SourcingSnapshot) => { s.capacity[0]!.receipt = null; }],
    ["video review above identity resolution", (s: SourcingSnapshot) => { s.steps[2]!.count = { value: 32, missingReason: null }; }],
    ["invitation planning above the last known step", (s: SourcingSnapshot) => { s.steps[4]!.count = { value: 13, missingReason: null }; }],
    ["a selection that ignores suppression", (s: SourcingSnapshot) => { s.identity.suppressedExistingRelationship = { value: 20, missingReason: null }; }],
    ["confirmed invitations without one receipt each", (s: SourcingSnapshot) => { s.latestRun!.receiptRefs = ["synthetic-invite-receipt-1"]; }],
    ["confirmed above distinct opportunities", (s: SourcingSnapshot) => { s.latestRun!.distinctOpportunities = { value: 1, missingReason: null }; }],
    ["an unknown value with no reason", (s: SourcingSnapshot) => { s.steps[3]!.count = { value: null, missingReason: null }; }],
    ["a zero standing in for unknown with a reason", (s: SourcingSnapshot) => { s.steps[3]!.count = { value: 0, missingReason: "J20_REVIEW_INCOMPLETE" }; }],
    ["verified access with no account", (s: SourcingSnapshot) => { s.sources[0]!.accountRef = null; }],
    ["an unconfigured schedule with a timezone", (s: SourcingSnapshot) => { s.schedule.state = "unconfigured"; s.schedule.cadence = null; s.schedule.nextRunAt = null; s.schedule.scheduleRef = null; }],
    ["evidence after the snapshot", (s: SourcingSnapshot) => { s.capacity[0]!.observedAt = new Date(sourcingTestTime + 1000).toISOString(); }],
    ["steps out of order", (s: SourcingSnapshot) => { s.steps.reverse(); }],
  ])("refuses %s", (_name, mutate) => {
    const s = sourcingSourceFixture(); mutate(s);
    expect(sourcingSnapshotSchema.safeParse(s).success).toBe(false);
  });
});

describe("the daily sourcing plan reader", () => {
  it("projects a current plan with aliased references, native units and unknowns kept unknown", async () => {
    const { service } = setup();
    const result = await service.read({}, "reviewer");
    expect(sourcingPlanSchema.parse(result.data)).toEqual(result.data);
    const plan = result.data.plan!;
    expect(result.data).toMatchObject({ sourceState: "current", freshness: "current", coverage: "complete", missingReason: null });
    expect(plan.schedule).toMatchObject({ declaredState: "active", effectiveState: "active", holdReasons: [], timezone: "America/Los_Angeles" });
    expect(plan.steps.map((s) => s.step)).toEqual(["discovery", "identityResolution", "videoReview", "qualification", "invitationPlanning"]);
    expect(plan.steps[3]!.count).toEqual({ value: null, missingReason: "J20_REVIEW_INCOMPLETE" });
    expect(plan.steps[4]!.count).toEqual({ value: 0, missingReason: null });
    expect(plan.identity.suppressedExistingRelationship.value).toBeNull();
    const tiktok = plan.capacity.find((r) => r.source === "tiktok-shop")!;
    expect(tiktok).toMatchObject({ state: "unknown", dispatchBlocked: true, blockReason: "CAPACITY_UNKNOWN", remaining: { value: null } });
    expect(plan.capacity.find((r) => r.kind === "authorizedCost")).toMatchObject({ unit: "minorUnits", currency: "USD", state: "current", dispatchBlocked: false });
    expect(plan.dispatchHoldReasons).toEqual(expect.arrayContaining(["READ_ONLY_PLAN", "DISPATCH_NOT_CONNECTED", "CAPACITY_UNKNOWN:tiktok-shop:invitations"]));
    expect(plan.latestRun!.states.uncertain.value).toBeNull();
    expect(result.dataState).toBe("partial");
    expect(result.coverage).toMatchObject({ complete: false, reasonCodes: ["PLAN_VALUES_UNKNOWN_OR_STALE"] });
    const text = JSON.stringify(result.data);
    for (const raw of ["synthetic-social-cat-account", "synthetic-daily-plan", "synthetic-run-1", "synthetic-invite-receipt-1", "synthetic-sc-quota-receipt", "synthetic-plan-source-v1"]) expect(text).not.toContain(raw);
    expect(plan.latestRun!.receiptRefs).toHaveLength(2);
  });

  it("answers an honest unconfigured state without a source, never a demo plan", async () => {
    const { service } = setup(null);
    const result = await service.read({}, "reader");
    expect(result.data).toMatchObject({ sourceState: "unconfigured", plan: null, freshness: "unknown", missingReason: "SOURCING_SOURCE_UNCONFIGURED" });
    expect(result.dataState).toBe("unavailable");
    expect(result.coverage).toEqual({ expectedCount: null, observedCount: null, missingCount: null, complete: false, reasonCodes: ["SOURCING_SOURCE_UNCONFIGURED"] });
    expect(result.capabilities).toEqual([
      { actionKind: "startLiveDiscovery", state: "held", reasonCodes: ["SOURCE_AUTOMATION_NOT_CONNECTED"] },
      { actionKind: "requestBatchApproval", state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] },
    ]);
  });

  it("treats a null, failing or hanging source as unavailable, and a denial as a denial", async () => {
    for (const reader of [async () => null, async () => { throw new Error("network"); }, () => new Promise<never>(() => undefined)]) {
      const result = await setup(reader, { timeoutMs: 20 }).service.read({}, "reviewer");
      expect(result.data).toMatchObject({ sourceState: "unavailable", plan: null, missingReason: "SOURCING_SOURCE_UNAVAILABLE" });
    }
    const denied = await failure(setup(async () => { throw new SourcingError("UPSTREAM_FORBIDDEN", 403); }).service.read({}, "reviewer"));
    expect(denied).toMatchObject({ code: "SOURCE_AUTHORITY_DENIED", status: 403 });
  });

  it("fails closed on a malformed, foreign-scope or future snapshot instead of reading it as empty", async () => {
    expect(await failure(setup(async () => ({ ...sourcingSourceFixture(), steps: [] })).service.read({}, "reviewer"))).toMatchObject({ code: "SOURCE_RESPONSE_INVALID", status: 502 });
    expect(await failure(setup(async () => "not a plan").service.read({}, "reviewer"))).toMatchObject({ code: "SOURCE_RESPONSE_INVALID", status: 502 });
    const foreign = sourcingSourceFixture({ ...scope, accountId: "synthetic-foreign-account" });
    expect(await failure(setup(async () => foreign).service.read({}, "reviewer"))).toMatchObject({ code: "SOURCE_SCOPE_DENIED", status: 403 });
    expect(await failure(setup(async () => sourcingSourceFixture(scope, sourcingTestTime + 60_000)).service.read({}, "reviewer"))).toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  });

  it("never shows a schedule as active with a closed session, unverified access, no timezone or an overdue run", async () => {
    const cases: [(s: SourcingSnapshot) => void, string][] = [
      [(s) => { s.sources[1]!.session = "closed"; }, "BROWSER_SESSION_CLOSED:tiktok-shop"],
      [(s) => { s.sources[0]!.access = "loginRequired"; }, "SOURCE_ACCESS_LOGINREQUIRED:social-cat"],
      [(s) => { s.schedule.timezone = null; }, "SCHEDULE_TIMEZONE_UNSET"],
      [(s) => { s.schedule.nextRunAt = new Date(sourcingTestTime - 1).toISOString(); s.schedule.lastRunAt = new Date(sourcingTestTime - 86_400_000).toISOString(); s.latestRun!.startedAt = s.schedule.lastRunAt; }, "SCHEDULE_NEXT_RUN_OVERDUE"],
      [(s) => { s.coverage = "partial"; }, "SOURCE_COVERAGE_PARTIAL"],
    ];
    for (const [mutate, reason] of cases) {
      const plan = (await setup(withSource(mutate)).service.read({}, "reviewer")).data.plan!;
      expect(plan.schedule.effectiveState).toBe("draft");
      expect(plan.schedule.holdReasons).toContain(reason);
      expect(plan.dispatchHoldReasons).toContain(reason);
    }
  });

  it("marks a lapsed lease stale and a capacity read before its reset as stale, both blocking dispatch", async () => {
    const lapsed = setup();
    lapsed.setTime(sourcingTestTime + 2 * 3600_000);
    const stale = await lapsed.service.read({}, "reviewer");
    expect(stale.data).toMatchObject({ sourceState: "expired", freshness: "stale", missingReason: "SOURCE_STALE" });
    expect(stale.dataState).toBe("stale");
    expect(stale.data.plan!.schedule.effectiveState).toBe("draft");
    expect(stale.data.plan!.capacity.filter((r) => r.state === "current")).toEqual([]);
    expect(stale.data.plan!.capacity.every((r) => r.dispatchBlocked)).toBe(true);

    const reset = await setup(withSource((s) => { s.capacity[0]!.resetAt = new Date(sourcingTestTime - 60_000).toISOString(); })).service.read({}, "reviewer");
    expect(reset.data.plan!.capacity[0]).toMatchObject({ state: "stale", blockReason: "CAPACITY_RESET_STALE", remaining: { value: 30 } });
  });

  it("keeps a known zero distinct from unknown, and reports missing source capacity as unknown", async () => {
    const result = await setup(withSource((s) => {
      s.capacity[0]!.used = { value: 50, missingReason: null }; s.capacity[0]!.remaining = { value: 0, missingReason: null };
      s.capacity.splice(1, 1);
    })).service.read({}, "reviewer");
    const [social, ...rest] = result.data.plan!.capacity;
    expect(social).toMatchObject({ state: "current", remaining: { value: 0, missingReason: null }, blockReason: "CAPACITY_EXHAUSTED" });
    expect(rest.find((r) => r.source === "tiktok-shop")).toMatchObject({ kind: "invitations", state: "unknown", blockReason: "CAPACITY_NOT_REPORTED", limit: { value: null } });
  });

  it("refuses a reused source version with changed facts and a regressed snapshot", async () => {
    let snapshot = sourcingSourceFixture();
    const { service, setTime } = setup(async () => structuredClone(snapshot));
    const first = await service.read({}, "reviewer");
    expect((await service.read({}, "reviewer")).version).toBe(first.version);
    snapshot = { ...snapshot, planRef: "synthetic-other-plan" };
    expect(await failure(service.read({}, "reviewer"))).toMatchObject({ code: "SOURCE_VERSION_CHANGED", status: 409 });
    setTime(sourcingTestTime + 120_000);
    snapshot = { ...sourcingSourceFixture(scope, sourcingTestTime + 60_000), version: "synthetic-plan-source-v2" };
    await service.read({}, "reviewer");
    snapshot = { ...sourcingSourceFixture(), version: "synthetic-plan-source-v3" };
    expect(await failure(service.read({}, "reviewer"))).toMatchObject({ code: "SOURCE_VERSION_CHANGED", status: 409 });
  });

  it("refuses forged filters before reading the source", async () => {
    let reads = 0;
    const { service } = setup(async () => { reads++; return sourcingSourceFixture(); });
    for (const filters of [{ fixture: "demo" }, { scenario: "ready" }, { sourceAccount: "synthetic-other" }, null, "plan"])
      expect(await failure(service.read(filters, "reviewer"))).toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
    expect(reads).toBe(0);
  });

  it("routes only the sourcing plan view key", () => {
    expect(isSourcingPlanRead({ viewKey: "sourcingPlan" })).toBe(true);
    for (const raw of [{ viewKey: "discoverySummary" }, null, "sourcingPlan", []]) expect(isSourcingPlanRead(raw)).toBe(false);
  });
});
