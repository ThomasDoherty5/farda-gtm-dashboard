import { z } from "zod";
import { SCHEMA_VERSION, readResponseSchema, type Environment, type ReadRequest, type ReadResponse } from "./contract";
import { createDemoAdapter } from "./demoAdapter";
import { AdapterError } from "./errors";
import { selectAdapter } from "./selectAdapter";
import { overviewFixtureKeys, type OverviewData, type OverviewFixtureKey } from "@/fixtures/overview";

const request = (environment: Environment = "demo", viewKey = "overviewSummary"): ReadRequest<object> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "readView",
  viewKey,
  requestedScope: { workspaceId: "w", accountIds: ["a"], environment },
  filters: {},
  period: null,
  sort: [],
  page: { cursor: null, limit: 50 },
  requestId: "req-test",
});

const read = (fixture: OverviewFixtureKey) => createDemoAdapter({ fixture }).readView<object, OverviewData>(request());
const errorFrom = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as AdapterError);

const FAILING: OverviewFixtureKey[] = ["FX-07-offline-read", "FX-08-forbidden-account", "FX-09-expired-session"];
const READABLE = overviewFixtureKeys.filter((k) => !FAILING.includes(k));

describe("demo adapter", () => {
  it.each(READABLE)("%s matches the frozen response schema and never offers a live action", async (fixture) => {
    const res = await read(fixture);
    expect(readResponseSchema(z.unknown()).safeParse(res).success).toBe(true);
    expect(res.scope.environment).toBe("demo");
    expect(res.capabilities.every((c) => c.state === "unverified")).toBe(true);
  });

  it("keeps the overview-original dataset's arithmetic", async () => {
    const { data } = (await read("FX-01-happy-read")) as ReadResponse<OverviewData>;
    const posts = data!.posts;
    const sum = (f: (p: (typeof posts)[number]) => number | null) => posts.reduce((s, p) => s + (f(p) ?? 0), 0);
    expect(posts).toHaveLength(5);
    expect(sum((p) => p.views)).toBe(240_000);
    expect(sum((p) => p.likes) + sum((p) => p.comments) + sum((p) => p.shares)).toBe(12_000);
    expect(data!.orders.value).toBe(400);
    expect(data!.netReceipts.value).toEqual({ minorUnits: 1_259_600, currency: "USD" });
    expect(data!.attributedOrders.value).toBe(180);
    expect(data!.attributedNetSales.value).toEqual({ minorUnits: 579_600, currency: "USD" });
    const daily = data!.daily;
    expect(daily).toHaveLength(30);
    expect(daily.reduce((s, d) => s + (d.shopify ?? NaN), 0)).toBe(data!.channels[0]!.netReceipts.minorUnits);
    expect(daily.reduce((s, d) => s + (d.tiktok ?? NaN), 0)).toBe(data!.channels[1]!.netReceipts.minorUnits);
    expect(data!.channels.reduce((s, c) => s + c.orders, 0)).toBe(data!.orders.value);
  });

  it("keeps partial coverage counts reconciled to the rows it returns", async () => {
    const res = await read("FX-05-partial-coverage");
    expect(res.dataState).toBe("partial");
    expect(res.data!.posts).toHaveLength(res.coverage.observedCount!);
    expect(res.coverage.observedCount! + res.coverage.missingCount!).toBe(res.coverage.expectedCount);
    expect(res.coverage.complete).toBe(false);
  });

  it.each([
    ["FX-07-offline-read", "unavailable", true],
    ["FX-08-forbidden-account", "forbidden", false],
    ["FX-09-expired-session", "unauthenticated", false],
  ] as const)("%s fails as %s", async (fixture, category, retryable) => {
    const error = await errorFrom(read(fixture));
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.category).toBe(category);
    expect(error.body.retryable).toBe(retryable);
  });

  it("refuses a request aimed at another environment (FX-25)", async () => {
    const error = await errorFrom(createDemoAdapter().readView(request("production")));
    expect(error.category).toBe("forbidden");
  });

  it("reports a missing fixture as integration pending instead of inventing data", async () => {
    const error = await errorFrom(createDemoAdapter().readView(request("demo", "financeReport")));
    expect(error.body.code).toBe("INTEGRATION_PENDING");
  });

  it("stops waiting when the request is aborted", async () => {
    const controller = new AbortController();
    const pending = createDemoAdapter({ latencyMs: 10_000 }).readView(request(), { signal: controller.signal });
    controller.abort(new Error("aborted"));
    await expect(pending).rejects.toThrow("aborted");
  });
});

describe("selectAdapter", () => {
  it("defaults to the demo adapter", () => {
    expect(selectAdapter({}).kind).toBe("demo");
  });

  it("selects a fixture by its short ID", async () => {
    const res = await selectAdapter({}, "?fixture=FX-05").readView<object, OverviewData>(request());
    expect(res.dataState).toBe("partial");
  });

  it.each(["sandbox", "production"] as const)("%s fails honestly and never falls back to demo data", async (mode) => {
    const adapter = selectAdapter({ VITE_FARDA_ADAPTER: mode }, "?fixture=FX-01");
    expect(adapter.kind).toBe("live");
    const error = await errorFrom(adapter.readView(request(mode)));
    expect(error.body.code).toBe("INTEGRATION_PENDING");
  });

  it("throws on an unknown mode", () => {
    expect(() => selectAdapter({ VITE_FARDA_ADAPTER: "live" })).toThrow(/Unknown VITE_FARDA_ADAPTER/);
  });
});
