// @vitest-environment node
import { describe, expect, it } from "vitest";
import { analyticsViewSchemas } from "../../adapter/viewSchemas/analytics";
import { createAnalyticsReader, resolveWindow, type AnalyticsViewKey } from "./reader";
import { freshnessOf, observed, operand, ratio, sumOperands, worstFreshness } from "./metrics";
import { AnalyticsError, CLOCK_SKEW_MS, FRESHNESS_LIMIT_MS, type AnalyticsSourceRequest, type AnalyticsSources, type OrderRow, type OrdersSnapshot } from "./sources";
import { adPlatformsFixture, analyticsTestScope, analyticsTestSecret, analyticsTestTime, analyticsTestTimezone, ordersFixture, sessionsFixture,
  supportFixture, syntheticAnalyticsSources } from "./fixtures.testkit";

const T = analyticsTestTime;
const reader = (sources: AnalyticsSources = syntheticAnalyticsSources(), now = () => T) =>
  createAnalyticsReader({ scope: analyticsTestScope, secret: analyticsTestSecret, sources, now, timezone: analyticsTestTimezone });
const measure = (data: Record<string, unknown>, key: string) => (data.measures as { key: string; state: string; value: number | null; reasonCode: string | null;
  numerator: { value: number | null }; denominator: { value: number | null } | null; window: unknown; freshnessState: string; definition: string }[]).find(m => m.key === key)!;
async function failure(promise: Promise<unknown>) {
  try { await promise; } catch (error) { if (error instanceof AnalyticsError) return { code: error.code, status: error.status }; throw error; }
  throw new Error("Expected a typed analytics failure");
}
const ctx = { window: { start: "2026-10-08", end: "2026-11-06", timezone: analyticsTestTimezone }, provenance: ["feed-a"], freshness: ["current" as const] };

describe("analytics metric arithmetic", () => {
  it("divides only known, valid inputs and keeps zero, unknown and not applicable apart", () => {
    expect(ratio("aov", "AOV", "usdMinor", operand("Net", 1_259_600), operand("Orders", 400), ctx)).toMatchObject({ state: "known", value: 3149,
      numerator: { value: 1_259_600 }, denominator: { value: 400 }, window: ctx.window, provenance: ["feed-a"], freshnessState: "current" });
    expect(ratio("mer", "MER", "multiple", operand("Net", 1_259_600), operand("Spend", 700_000), ctx).value).toBeCloseTo(1.7994, 4);
    expect(ratio("x", "X", "count", operand("Net", 0), operand("Orders", 5), ctx)).toMatchObject({ state: "known", value: 0 });
    expect(ratio("x", "X", "count", operand("Net", 10), operand("Orders", 0), ctx)).toMatchObject({ state: "notApplicable", value: null, reasonCode: "ZERO_DENOMINATOR" });
    expect(ratio("x", "X", "count", operand("Net", null, "SOURCE_A"), operand("Orders", 0), ctx)).toMatchObject({ state: "unknown", value: null, reasonCode: "SOURCE_A" });
    expect(ratio("x", "X", "count", operand("Net", 1), operand("Orders", null, "SOURCE_B"), ctx)).toMatchObject({ state: "unknown", reasonCode: "SOURCE_B" });
    for (const bad of [NaN, -1, 1.5, Infinity]) expect(ratio("x", "X", "count", operand("Net", bad), operand("Orders", 2), ctx)).toMatchObject({ state: "unknown", reasonCode: "INVALID_INPUT" });
    expect(observed("n", "N", "count", operand("N", -3), ctx)).toMatchObject({ state: "unknown", reasonCode: "INVALID_INPUT" });
  });

  it("sums only when every part is known", () => {
    expect(sumOperands("Total", [operand("a", 2), operand("b", 0)])).toEqual({ label: "Total", value: 2, reasonCode: null });
    expect(sumOperands("Total", [operand("a", 2), operand("b", null, "FEED_MISSING")])).toEqual({ label: "Total", value: null, reasonCode: "FEED_MISSING" });
    expect(sumOperands("Total", [])).toEqual({ label: "Total", value: 0, reasonCode: null });
    expect(worstFreshness(["current", "noChange", "partial"])).toBe("partial");
    expect(worstFreshness(["current", "error", "neverSynced"])).toBe("error");
  });

  it("computes D-13 freshness per source: orders 15 minutes, ad platforms 26 hours", () => {
    const feed = (ageMs: number, extra = {}) => ({ lastSuccessAt: new Date(T - ageMs).toISOString(), syncState: "ok" as const, coverage: "complete" as const, ...extra });
    expect(freshnessOf("orders", feed(14 * 60_000), T, FRESHNESS_LIMIT_MS.orders)).toEqual({ freshnessState: "current", staleReasonCode: null });
    expect(freshnessOf("orders", feed(16 * 60_000), T, FRESHNESS_LIMIT_MS.orders)).toEqual({ freshnessState: "error", staleReasonCode: "SOURCE_STALE" });
    expect(freshnessOf("adPlatforms", feed(25 * 3_600_000), T, FRESHNESS_LIMIT_MS.adPlatforms).freshnessState).toBe("current");
    expect(freshnessOf("adPlatforms", feed(27 * 3_600_000), T, FRESHNESS_LIMIT_MS.adPlatforms).staleReasonCode).toBe("SOURCE_STALE");
    expect(freshnessOf("orders", feed(60_000, { syncState: "noChange" }), T, FRESHNESS_LIMIT_MS.orders).freshnessState).toBe("noChange");
    expect(freshnessOf("orders", feed(60_000, { coverage: "partial" }), T, FRESHNESS_LIMIT_MS.orders)).toEqual({ freshnessState: "partial", staleReasonCode: "SOURCE_COVERAGE_PARTIAL" });
    expect(freshnessOf("orders", feed(60_000, { syncState: "error" }), T, FRESHNESS_LIMIT_MS.orders)).toEqual({ freshnessState: "error", staleReasonCode: "SOURCE_SYNC_FAILED" });
    expect(freshnessOf("orders", { lastSuccessAt: null, syncState: "error", coverage: "complete" }, T, 1)).toEqual({ freshnessState: "neverSynced", staleReasonCode: "SOURCE_SYNC_FAILED" });
    expect(freshnessOf("orders", null, T, 1)).toEqual({ freshnessState: "neverSynced", staleReasonCode: "SOURCE_UNCONFIGURED" });
    // A source clock up to two minutes ahead is tolerated; further ahead is unverified.
    expect(freshnessOf("orders", feed(-60_000), T, FRESHNESS_LIMIT_MS.orders)).toEqual({ freshnessState: "current", staleReasonCode: null });
    expect(freshnessOf("orders", feed(-CLOCK_SKEW_MS - 1_000), T, FRESHNESS_LIMIT_MS.orders)).toEqual({ freshnessState: "error", staleReasonCode: "SOURCE_TIME_UNVERIFIED" });
    expect(freshnessOf("orders", feed(0), NaN, FRESHNESS_LIMIT_MS.orders).staleReasonCode).toBe("SOURCE_TIME_UNVERIFIED");
  });
});

describe("analytics period and filters (D-11)", () => {
  it("defaults to the last 30 days in the reporting timezone and accepts an explicit event-time date range", () => {
    expect(resolveWindow(null, undefined, T, analyticsTestTimezone)).toEqual({ start: "2026-10-08", end: "2026-11-06", timezone: analyticsTestTimezone });
    expect(resolveWindow(null, "last7Days", T, analyticsTestTimezone)).toEqual({ start: "2026-10-31", end: "2026-11-06", timezone: analyticsTestTimezone });
    expect(resolveWindow({ startAt: "2026-10-01", endAt: "2026-10-31", timezone: "UTC", basis: "eventTime" }, undefined, T, analyticsTestTimezone))
      .toEqual({ start: "2026-10-01", end: "2026-10-31", timezone: "UTC" });
  });

  it("refuses forged, future, reversed, overlong, ambiguous and observation-time periods", () => {
    const bad: [unknown, "last7Days" | undefined][] = [
      [{ startAt: "2026-10-01", endAt: "2026-11-07", timezone: analyticsTestTimezone, basis: "eventTime" }, undefined],
      [{ startAt: "2026-10-02", endAt: "2026-10-01", timezone: "UTC", basis: "eventTime" }, undefined],
      [{ startAt: "2025-01-01", endAt: "2026-10-01", timezone: "UTC", basis: "eventTime" }, undefined],
      [{ startAt: "2026-10-01", endAt: "2026-10-02", timezone: "UTC", basis: "observationTime" }, undefined],
      [{ startAt: "2026-02-30", endAt: "2026-03-02", timezone: "UTC", basis: "eventTime" }, undefined],
      [{ startAt: "2026-10-01", endAt: "2026-10-02", timezone: "Mars/Olympus", basis: "eventTime" }, undefined],
      [{ startAt: "2026-10-01T00:00:00Z", endAt: "2026-10-02", timezone: "UTC", basis: "eventTime" }, undefined],
      [{ startAt: "2026-10-01", endAt: "2026-10-02", timezone: "UTC", basis: "eventTime" }, "last7Days"],
      [{ startAt: "2026-10-01", endAt: "2026-10-02", timezone: "UTC", basis: "eventTime", scenario: "demo" }, undefined],
    ];
    for (const [period, preset] of bad) expect(() => resolveWindow(period, preset, T, analyticsTestTimezone)).toThrow(AnalyticsError);
  });

  it("refuses unknown filters, demo scenarios and invalid paid-media filters before any source is read", async () => {
    let reads = 0;
    const counting = Object.fromEntries(Object.entries(syntheticAnalyticsSources()).map(([k, fn]) => [k, async (r: AnalyticsSourceRequest) => { reads++; return fn(r); }]));
    const r = reader(counting);
    for (const [view, filters] of [["overviewSummary", { scenario: "happy" }], ["attribution", { fixture: "FX-01" }], ["customerJourney", { preset: "lastYear" }],
      ["paidMedia", { rights: "everything" }], ["paidMedia", { platform: "google" }], ["overviewSummary", null]] as const)
      expect(await failure(r.read(view as AnalyticsViewKey, filters, null))).toEqual({ code: "VALIDATION_FAILED", status: 400 });
    expect(reads).toBe(0);
  });
});

describe("overview and attribution from synthetic order and ad readers", () => {
  it("reproduces the hand-checked $12,596 / 400-order example exactly", async () => {
    const result = await reader().read("overviewSummary", {}, null);
    const d = result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(result.dataState).toBe("ready");
    expect(d.orders).toMatchObject({ state: "known", value: 400 });
    expect(d.netReceipts).toMatchObject({ state: "known", value: { minorUnits: 1_259_600, currency: "USD" } });
    expect(d.channels).toEqual([{ key: "shopify", label: "Shopify", netReceipts: { minorUnits: 836_400, currency: "USD" }, orders: 260 },
      { key: "tiktok", label: "TikTok Shop", netReceipts: { minorUnits: 423_200, currency: "USD" }, orders: 140 }]);
    expect(d.daily).toHaveLength(30);
    expect(d.daily.reduce((n: number, x: { shopify: number }) => n + x.shopify, 0)).toBe(836_400);
    expect(d.daily.reduce((n: number, x: { tiktok: number }) => n + x.tiktok, 0)).toBe(423_200);
    // Creator orders are creator-marked codes only: 180 discount-code orders include 20 sitewide-promotion orders.
    expect(d.attributedOrders.value).toBe(160);
    expect(d.attributedNetSales.value).toEqual({ minorUnits: 503_080, currency: "USD" });
    expect(measure(d, "discountCodeOrders").value).toBe(180);
    // Distinct customers: 290 flagged orders come from 280 customers.
    expect(d.newRetainedCustomers).toBe(280);
    expect(measure(d, "zeroNetValidOrders")).toMatchObject({ state: "known", value: 0 });
    // Earlier-period refunds are a separate correction, never subtracted from this cohort's net receipts.
    expect(measure(d, "priorPeriodRefundCorrections")).toMatchObject({ state: "known", value: 9_000 });
    expect(measure(d, "netReceipts").definition).toMatch(/Refunds of orders placed before the period are corrections/);
    expect(measure(d, "aov").definition).toMatch(/\$0 net after refunds stay in the denominator/);
    expect(d.sources).toEqual([{ source: "orders", state: "current", reasonCode: null }, { source: "adPlatforms", state: "current", reasonCode: null }]);
    expect(measure(d, "aov")).toMatchObject({ state: "known", value: 3149, numerator: { value: 1_259_600 }, denominator: { value: 400 } });
    expect(measure(d, "paidMediaSpend")).toMatchObject({ state: "known", value: 650_000 });
    expect(measure(d, "platformRoas.meta").value).toBeCloseTo(2.1, 10);
    // GMV Max spend and value never enter platform ROAS: 480,000 ÷ 200,000, not (480,000 + 900,000) ÷ 350,000.
    expect(measure(d, "platformRoas.tiktok").value).toBeCloseTo(2.4, 10);
    expect(measure(d, "gmvMaxSpend.tiktok")).toMatchObject({ state: "known", value: 150_000 });
    // MER and CAC need total marketing spend, which includes creator costs that this service does not read. Unknown, not media-only.
    expect(measure(d, "mer")).toMatchObject({ state: "unknown", value: null, reasonCode: "CREATOR_COST_SOURCE_UNCONFIGURED", numerator: { value: 1_259_600 } });
    expect(measure(d, "blendedCac")).toMatchObject({ state: "unknown", reasonCode: "CREATOR_COST_SOURCE_UNCONFIGURED", denominator: { value: 280 } });
    expect(d.contribution).toMatchObject({ state: "unknown", value: null, reasonCode: "LANDED_COST_SOURCE_UNCONFIGURED" });
    expect(d.marketingSpend).toBeNull();
    expect(d.posts).toEqual([]);
    expect(result.coverage).toEqual({ expectedCount: 4, observedCount: 4, missingCount: 0, complete: true, reasonCodes: ["GMV_MAX_NOT_INCREMENTAL"] });
    expect(result.sourceFreshness.map(f => [f.sourceRef.source, f.freshnessState])).toEqual([["orders.shopify.native", "current"], ["orders.tiktokShop.native", "current"],
      ["adPlatforms.meta", "current"], ["adPlatforms.tiktok", "current"]]);
    expect(analyticsViewSchemas.overviewSummary!.safeParse(d).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-(shopify|tiktok|meta)-(orders|ads|order|campaign|asset)/);
  });

  it("states attribution buckets that sum to the orders and binds the report scope for the client headline checks", async () => {
    const result = await reader().read("attribution", {}, null);
    const d = result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.attribution.map((a: { key: string; orders: number }) => [a.key, a.orders])).toEqual([["code", 180], ["utm", 120], ["platform", 60], ["unattributed", 40]]);
    expect(d.retainedUnits).toBe(378);
    expect(d.weeks).toHaveLength(5);
    expect(d.weeks.reduce((n: number, w: { shopify: { minorUnits: number }; tiktok: { minorUnits: number } }) => n + w.shopify.minorUnits + w.tiktok.minorUnits, 0)).toBe(1_259_600);
    expect(d.weeks[4].note).toBe("*");
    expect(d.tiktokPlatformRoas).toMatchObject({ state: "known" });
    expect(d.tiktokPlatformRoas.value).toBeCloseTo(2.4, 10);
    expect(d.tiktokRoasWindow.label).toBe("7-day click");
    expect(d.reportScope).toMatchObject({ source: "source", currency: "USD", period: { start: "2026-10-08", end: "2026-11-06" } });
    expect(d.headlineEvidence).toBeUndefined();
    expect(d.creators).toEqual([]);
    expect(result.dataState).toBe("ready");
    expect(analyticsViewSchemas.attribution!.safeParse(d).success).toBe(true);
  });

  it("reports an unconfigured or unavailable source as its own state, while every available source still renders", async () => {
    // No readers at all: a 200 read whose sources say unconfigured and never synced, with every figure unknown, not zero.
    const none = await reader({}).read("overviewSummary", {}, null);
    const n = none.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(none.dataState).toBe("partial");
    expect(n.sources).toEqual([{ source: "orders", state: "unconfigured", reasonCode: "SOURCE_UNCONFIGURED" }, { source: "adPlatforms", state: "unconfigured", reasonCode: "SOURCE_UNCONFIGURED" }]);
    expect(none.sourceFreshness.map(f => [f.sourceRef.source, f.freshnessState, f.staleReasonCode])).toEqual([["orders", "neverSynced", "SOURCE_UNCONFIGURED"], ["adPlatforms", "neverSynced", "SOURCE_UNCONFIGURED"]]);
    expect([n.orders.state, n.netReceipts.state, n.attributedOrders.state]).toEqual(["unknown", "unknown", "unknown"]);
    expect(n.orders.reasonCode).toBe("ORDERS_SOURCE_UNCONFIGURED");
    expect(n.daily.every((x: { shopify: unknown; tiktok: unknown }) => x.shopify === null && x.tiktok === null)).toBe(true);
    expect(none.coverage).toMatchObject({ observedCount: 0, complete: false });
    expect(analyticsViewSchemas.overviewSummary!.safeParse(n).success).toBe(true);
    // Ad platforms present, orders missing: media spend and ROAS still render.
    const adsOnly = await reader({ adPlatforms: syntheticAnalyticsSources().adPlatforms }).read("overviewSummary", {}, null);
    expect(measure(adsOnly.data, "paidMediaSpend")).toMatchObject({ state: "known", value: 650_000 });
    expect(measure(adsOnly.data, "aov")).toMatchObject({ state: "unknown", reasonCode: "ORDERS_SOURCE_UNCONFIGURED" });
    for (const [orders, state] of [[async () => null, "unavailable"], [async () => { throw new Error("socket"); }, "unavailable"]] as const) {
      const result = await reader({ ...syntheticAnalyticsSources(), orders }).read("attribution", {}, null);
      expect((result.data as Record<string, any>).sources[0]).toEqual({ source: "orders", state, reasonCode: "SOURCE_UNAVAILABLE" }); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(analyticsViewSchemas.attribution!.safeParse(result.data).success).toBe(true);
    }
    for (const view of ["paidMedia", "customerJourney", "attribution"] as const) {
      const result = await reader({}).read(view, {}, null);
      expect(result.dataState).toBe("partial");
      expect(analyticsViewSchemas[view]!.safeParse(result.data).success, view).toBe(true);
    }
    const { orders } = syntheticAnalyticsSources();
    const result = await reader({ orders }).read("overviewSummary", {}, null);
    const d = result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(result.dataState).toBe("partial");
    expect(measure(d, "paidMediaSpend")).toMatchObject({ state: "unknown", value: null, reasonCode: "AD_PLATFORM_SOURCE_UNCONFIGURED" });
    expect(measure(d, "mer")).toMatchObject({ state: "unknown", reasonCode: "AD_PLATFORM_SOURCE_UNCONFIGURED" });
    expect(d.netReceipts.value.minorUnits).toBe(1_259_600);
    expect(result.sourceFreshness.at(-1)).toMatchObject({ sourceRef: { source: "adPlatforms" }, freshnessState: "neverSynced", staleReasonCode: "SOURCE_UNCONFIGURED", lastSourceSuccessAt: null });
    expect(result.coverage).toMatchObject({ expectedCount: 4, observedCount: 2, missingCount: 2, complete: false });
    expect(result.coverage.reasonCodes).toContain("AD_PLATFORM_SOURCE_UNCONFIGURED");
  });

  it("marks stale, partial and never-synced feeds without turning missing channels into zero", async () => {
    const base = syntheticAnalyticsSources();
    const stale = await reader({ ...base, orders: async r => { const s = ordersFixture(r); s.feeds[0]!.lastSuccessAt = new Date(T - 20 * 60_000).toISOString(); return s; } }).read("overviewSummary", {}, null);
    expect(stale.dataState).toBe("stale");
    expect(stale.sourceFreshness[0]).toMatchObject({ freshnessState: "error", staleReasonCode: "SOURCE_STALE" });
    expect(measure(stale.data, "aov").freshnessState).toBe("error");

    const partial = await reader({ ...base, orders: async r => { const s = ordersFixture(r); s.feeds[1]!.coverage = "partial"; return s; } }).read("overviewSummary", {}, null);
    expect(partial.dataState).toBe("partial");
    expect(partial.sourceFreshness[1]).toMatchObject({ freshnessState: "partial", staleReasonCode: "SOURCE_COVERAGE_PARTIAL" });

    const never = await reader({ ...base, orders: async r => { const s = ordersFixture(r); s.feeds[1] = { ...s.feeds[1]!, lastSuccessAt: null, syncState: "error", orders: [] }; return s; } }).read("overviewSummary", {}, null);
    const d = never.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(never.dataState).toBe("partial");
    expect(d.orders).toMatchObject({ state: "unknown", value: null, reasonCode: "ORDER_FEED_NEVER_SYNCED" });
    expect(d.netReceipts.state).toBe("unknown");
    expect(d.channels.map((c: { key: string }) => c.key)).toEqual(["shopify"]);
    expect(d.daily.every((x: { tiktok: number | null; shopify: number | null }) => x.tiktok === null && x.shopify !== null)).toBe(true);
    expect(measure(d, "aov")).toMatchObject({ state: "unknown", reasonCode: "ORDER_FEED_NEVER_SYNCED" });
    expect(never.sourceFreshness[1]).toMatchObject({ freshnessState: "neverSynced", staleReasonCode: "SOURCE_SYNC_FAILED" });
    expect(analyticsViewSchemas.overviewSummary!.safeParse(d).success).toBe(true);

    const missing = await reader({ ...base, orders: async r => { const s = ordersFixture(r); s.feeds.pop(); return s; } }).read("attribution", {}, null);
    const a = missing.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(a.orders).toMatchObject({ state: "unknown", reasonCode: "ORDER_FEED_MISSING" });
    expect([a.channels, a.weeks, a.attribution]).toEqual([[], [], []]);
    expect(a.reportScope).toBeUndefined();
    expect(missing.sourceFreshness[1]).toMatchObject({ sourceRef: { source: "orders.tiktokShop" }, freshnessState: "neverSynced", staleReasonCode: "SOURCE_FEED_MISSING" });
    expect(analyticsViewSchemas.attribution!.safeParse(a).success).toBe(true);
  });

  it("keeps not-yet-attributed and retention-unknown orders unknown rather than unattributed or zero", async () => {
    const r = reader({ ...syntheticAnalyticsSources(), orders: async req => { const s = ordersFixture(req);
      Object.assign(s.feeds[0]!.orders[0]!, { attribution: null, codeOwner: null }); s.feeds[0]!.orders[1]!.newRetainedCustomer = null; s.feeds[0]!.orders[2]!.unitsRetained = null; return s; } });
    const d = (await r.read("attribution", {}, null)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.attribution.reduce((n: number, b: { orders: number }) => n + b.orders, 0)).toBe(399);
    expect(d.newRetainedCustomers).toBeNull();
    expect(d.retainedUnits).toBeNull();
    expect(d.retainedCustomerScope).toBeUndefined();
    expect(measure(d, "creatorCodeOrders")).toMatchObject({ state: "unknown", reasonCode: "ATTRIBUTION_NOT_EVALUATED" });
    expect(d.provenance.coverage).toContain("1 not yet attributed");
  });

  it("counts distinct customers, keeps sitewide codes out of creator orders, and keeps $0-net orders in the AOV cohort", async () => {
    const r = (mutate: (rows: OrderRow[]) => void) => reader({ ...syntheticAnalyticsSources(), orders: async req => { const s = ordersFixture(req); mutate(s.feeds[0]!.orders); return s; } });
    const missingCustomer = (await r(rows => { rows[0]!.customerRef = null; }).read("overviewSummary", {}, null)).data;
    expect(missingCustomer.newRetainedCustomers).toBeNull();
    expect(measure(missingCustomer, "newRetainedCustomers")).toMatchObject({ state: "unknown", reasonCode: "CUSTOMER_IDENTITY_UNAVAILABLE" });
    const unverifiedOwner = (await r(rows => { rows[0]!.codeOwner = "unknown"; }).read("overviewSummary", {}, null)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(unverifiedOwner.attributedOrders).toMatchObject({ state: "unknown", reasonCode: "CODE_OWNER_UNVERIFIED" });
    expect(measure(unverifiedOwner, "discountCodeOrders").value).toBe(180);
    const refunded = (await r(rows => { rows[0]!.netReceiptsMinor = 0; }).read("overviewSummary", {}, null)).data;
    expect(measure(refunded, "aov")).toMatchObject({ numerator: { value: 1_259_600 - 3217 }, denominator: { value: 400 } });
    expect(measure(refunded, "zeroNetValidOrders").value).toBe(1);
    const noRefundReport = await reader({ ...syntheticAnalyticsSources(), orders: async req => { const s = ordersFixture(req); s.feeds[1]!.priorPeriodRefunds = null; return s; } }).read("overviewSummary", {}, null);
    expect(measure(noRefundReport.data, "priorPeriodRefundCorrections")).toMatchObject({ state: "unknown", reasonCode: "PRIOR_PERIOD_REFUNDS_NOT_REPORTED" });
    expect(measure(noRefundReport.data, "netReceipts").value).toBe(1_259_600);
  });

  it("counts an order once across Shopify and TikTok Shop, and does not claim ready without canonical identity", async () => {
    const r = (mutate: (s: OrdersSnapshot) => void) => reader({ ...syntheticAnalyticsSources(), orders: async req => { const s = ordersFixture(req); mutate(s); return s; } });
    // A copy of a Shopify order inside the TikTok Shop feed, owned by Shopify, is dropped there.
    const copy = await r(s => { s.feeds[1]!.orders.push({ ...s.feeds[0]!.orders[0]!, orderRef: s.feeds[0]!.orders[0]!.orderRef }); }).read("overviewSummary", {}, null);
    expect(copy.data.orders).toMatchObject({ value: 400 });
    expect(copy.dataState).toBe("ready");
    expect(copy.coverage.reasonCodes).toContain("CROSS_CHANNEL_COPY_DROPPED");
    // Both feeds claim the same canonical order: counted once, and the read is partial.
    const conflict = await r(s => { s.feeds[1]!.orders.push({ ...s.feeds[0]!.orders[0]!, recordOwner: "tiktokShop" }); }).read("overviewSummary", {}, null);
    expect(conflict.data.orders).toMatchObject({ value: 400 });
    expect(conflict.dataState).toBe("partial");
    expect(conflict.coverage.reasonCodes).toContain("ORDER_IDENTITY_CONFLICT");
    // The same order reference in both feeds without canonical identity cannot be proven distinct.
    const unresolved = await r(s => { for (const f of s.feeds) for (const o of f.orders) o.canonicalOrderId = null; s.feeds[1]!.orders[0]!.orderRef = s.feeds[0]!.orders[0]!.orderRef; }).read("overviewSummary", {}, null);
    expect(unresolved.dataState).toBe("partial");
    expect(unresolved.coverage.reasonCodes).toContain("ORDER_IDENTITY_UNRESOLVED");
  });

  it("never double counts a mirror: identical rows add nothing, differing rows mark the read partial, a mirror alone is disclosed", async () => {
    const withMirror = (mutate: (rows: ReturnType<typeof ordersFixture>["feeds"][number]) => void) => reader({ ...syntheticAnalyticsSources(), orders: async r => {
      const s = ordersFixture(r);
      const mirror = { ...structuredClone(s.feeds[0]!), feedRef: "synthetic-shopify-mirror", origin: "mirror" as const };
      mutate(mirror); s.feeds.push(mirror); return s;
    } });
    const same = await withMirror(() => undefined).read("overviewSummary", {}, null);
    expect((same.data as Record<string, any>).orders.value).toBe(400); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(same.dataState).toBe("ready");
    expect(same.sourceFreshness.find(f => f.sourceRef.source === "orders.shopify.mirror")?.mirroredAt).not.toBeNull();
    const differs = await withMirror(m => { m.orders[0]!.netReceiptsMinor = 1; m.orders.pop(); }).read("overviewSummary", {}, null);
    expect((differs.data as Record<string, any>).netReceipts.value.minorUnits).toBe(1_259_600); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(differs.dataState).toBe("partial");
    expect(differs.coverage.reasonCodes).toContain("NATIVE_MIRROR_MISMATCH");
    const staleMirror = await withMirror(m => { m.lastSuccessAt = new Date(T - 3_600_000).toISOString(); }).read("overviewSummary", {}, null);
    expect(staleMirror.dataState).toBe("ready");

    const mirrorOnly = await reader({ ...syntheticAnalyticsSources(), orders: async r => { const s = ordersFixture(r); s.feeds[0]!.origin = "mirror"; return s; } }).read("overviewSummary", {}, null);
    expect((mirrorOnly.data as Record<string, any>).orders.value).toBe(400); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(mirrorOnly.coverage.reasonCodes).toContain("ORDERS_FROM_MIRROR");
    expect(mirrorOnly.sourceFreshness[0]!.sourceRef.source).toBe("orders.shopify.mirror");
  });

  it("degrades a malformed, mis-dated or future source to its own state, and refuses a foreign scope outright", async () => {
    const base = syntheticAnalyticsSources();
    const orders = (mutate: (s: any) => void) => reader({ ...base, orders: async r => { const s: any = ordersFixture(r); mutate(s); return s; } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const ads = (mutate: (s: any) => void) => reader({ ...base, adPlatforms: async r => { const s: any = adPlatformsFixture(r); mutate(s); return s; } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    type Expect = { source: "orders" | "adPlatforms"; state: string; reason: string } | { status: number } | "ready";
    const cases: [ReturnType<typeof reader>, Expect][] = [
      [orders(s => { s.feeds[0].orders[0].placedAt = "2026-02-30T10:00:00Z"; }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(s => { s.feeds[0].orders[0].placedAt = "not-a-time"; }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(s => { s.feeds[0].orders[0].netReceiptsMinor = -5; }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(s => { s.feeds[0].orders[0].netReceiptsMinor = "3217"; }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(s => { s.feeds[0].orders[1].orderRef = s.feeds[0].orders[0].orderRef; }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(s => { s.feeds[0].orders[0].placedAt = "2026-09-01T10:00:00Z"; }), { source: "orders", state: "error", reason: "ORDER_OUTSIDE_PERIOD" }],
      // Within the two-minute clock tolerance a source slightly ahead is accepted; beyond it the source is unverified.
      [orders(s => { s.feeds[0].observedAt = new Date(T + 60_000).toISOString(); s.feeds[0].lastSuccessAt = new Date(T + 30_000).toISOString(); }), "ready"],
      [orders(s => { s.feeds[0].observedAt = new Date(T + CLOCK_SKEW_MS + 60_000).toISOString(); }), { source: "orders", state: "invalid", reason: "SOURCE_TIME_UNVERIFIED" }],
      [orders(s => { s.feeds[0].orders[0].placedAt = new Date(T + 60_000).toISOString(); }), "ready"],
      [orders(s => { s.feeds[0].orders[0].placedAt = new Date(T + 5 * 60_000).toISOString(); }), { source: "orders", state: "error", reason: "ORDER_TIME_UNVERIFIED" }],
      [orders(s => { s.feeds[0].lastSuccessAt = new Date(T).toISOString(); s.feeds[0].observedAt = new Date(T - 60_000).toISOString(); }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(s => { s.window.start = "2026-10-01"; }), { source: "orders", state: "invalid", reason: "SOURCE_PERIOD_MISMATCH" }],
      [orders(s => { s.feeds.push({ ...s.feeds[0], feedRef: "second-native" }); }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(s => { s.feeds[0].extra = true; }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(() => undefined), "ready"],
      [reader({ ...base, orders: async () => [] }), { source: "orders", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [ads(s => { s.feeds.push({ ...s.feeds[0], feedRef: "copy" }); }), { source: "adPlatforms", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [ads(s => { s.feeds[0].campaigns[0].clicks = 10_000_000; }), { source: "adPlatforms", state: "invalid", reason: "SOURCE_RESPONSE_INVALID" }],
      [orders(s => { s.scope.accountId = "foreign-account"; }), { status: 403 }],
      [reader({ ...base, orders: async () => { throw new AnalyticsError("FORBIDDEN", 403, "denied"); } }), { status: 403 }],
    ];
    // V8 reads 31 September as 1 October; inside a period that includes 1 October it must still be refused.
    const september = { startAt: "2026-09-01", endAt: "2026-10-31", timezone: analyticsTestTimezone, basis: "eventTime" };
    const rolled = await orders(s => { s.feeds[0].orders[0].placedAt = "2026-09-31T20:00:00Z"; }).read("overviewSummary", {}, september);
    expect((rolled.data as Record<string, any>).sources[0]).toMatchObject({ state: "invalid" }); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const [r, expected] of cases) {
      if (typeof expected === "object" && "status" in expected) { expect(await failure(r.read("overviewSummary", {}, null))).toEqual({ code: "SOURCE_SCOPE_DENIED", status: 403 }); continue; }
      const result = await r.read("overviewSummary", {}, null);
      const d = result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (expected === "ready") { expect(result.dataState).toBe("ready"); continue; }
      expect(result.dataState).toBe("partial");
      expect(d.sources.find((x: { source: string }) => x.source === expected.source)).toEqual({ source: expected.source, state: expected.state, reasonCode: expected.reason });
      // The other source still renders: a broken ad feed leaves orders known, and a broken order feed leaves media spend known.
      if (expected.source === "orders") { expect(d.orders.state).toBe("unknown"); expect(measure(d, "paidMediaSpend").value).toBe(650_000); }
      else { expect(d.orders.value).toBe(400); expect(measure(d, "paidMediaSpend").state).toBe("unknown"); }
      expect(analyticsViewSchemas.overviewSummary!.safeParse(d).success).toBe(true);
    }
  });

  it("refuses personal-looking free text from sources, and emits only enumerated or opaque values", async () => {
    const personal = ["jane.doe@example.com", "+1 555 010 0199", "@janedoe_creator", "Jane Doe GRWM"];
    const base = syntheticAnalyticsSources();
    for (const text of personal) {
      const variants: [AnalyticsSources, AnalyticsViewKey, "orders" | "adPlatforms" | "support"][] = [
        [{ ...base, adPlatforms: async r => { const s: any = adPlatformsFixture(r); s.feeds[0].assets[0].label = text; return s; } }, "paidMedia", "adPlatforms"], // eslint-disable-line @typescript-eslint/no-explicit-any
        [{ ...base, adPlatforms: async r => { const s: any = adPlatformsFixture(r); s.feeds[0].campaigns[0].attributionWindow = text; return s; } }, "paidMedia", "adPlatforms"], // eslint-disable-line @typescript-eslint/no-explicit-any
        [{ ...base, support: async r => { const s: any = supportFixture(r); s.feed.tickets[0].category = text; return s; } }, "customerJourney", "support"], // eslint-disable-line @typescript-eslint/no-explicit-any
        [{ ...base, orders: async r => { const s: any = ordersFixture(r); s.feeds[0].orders[0].customerRef = text; return s; } }, "customerJourney", "orders"], // eslint-disable-line @typescript-eslint/no-explicit-any
      ];
      for (const [sources, view, source] of variants) {
        const result = await reader(sources).read(view, {}, null);
        expect((result.data as Record<string, any>).sources.find((x: { source: string }) => x.source === source).state).toBe("invalid"); // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(JSON.stringify(result)).not.toContain(text);
      }
    }
    const clean = await reader().read("paidMedia", {}, null);
    const d = clean.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.assets.map((a: { label: string }) => a.label)).toEqual(["AD-01 · Meta", "AD-03 · TikTok", expect.stringMatching(/^Asset [a-f0-9]{6} · TikTok$/)]);
    expect(d.channels.map((c: { attributionWindow: { label: string } | null }) => c.attributionWindow?.label)).toEqual(["7-day click, 1-day view", "7-day click"]);
    const journey = (await reader().read("customerJourney", {}, null)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(journey.tickets.map((t: { category: string }) => t.category)).toEqual(["Setup", "Delivery", "Returns"]);
  });
});

describe("paid media and customer journey", () => {
  it("keeps platform ROAS per platform, GMV Max apart, and filters assets with their denominator", async () => {
    const result = await reader().read("paidMedia", { rights: "all", platform: "all" }, null);
    const d = result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.channels).toEqual([
      expect.objectContaining({ key: "meta", spend: { minorUnits: 300_000, currency: "USD" }, platformPurchaseValue: { minorUnits: 630_000, currency: "USD" }, impressions: 500_000, clicks: 10_000 }),
      expect.objectContaining({ key: "tiktok", spend: { minorUnits: 200_000, currency: "USD" }, platformPurchaseValue: { minorUnits: 480_000, currency: "USD" }, impressions: 300_000, clicks: 6_000 }),
    ]);
    expect(d.creatorSampleEconomics).toBeNull();
    expect(measure(d, "ctr.meta").value).toBeCloseTo(2, 10);
    expect(measure(d, "gmvMaxSpend.tiktok").value).toBe(150_000);
    expect(d.assetTotal).toBe(3);
    expect(d.assets.find((a: { rights: string }) => a.rights === "expiring").expiresInDays).toBe(12);
    // Lapsed rights are expired, never "expires in 0 days".
    const lapsed = (await reader({ adPlatforms: async r => { const s = adPlatformsFixture(r); s.feeds[1]!.assets[0]!.expiresOn = "2026-11-01"; return s; } }).read("paidMedia", {}, null)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(lapsed.assets.find((a: { label: string }) => a.label.startsWith("AD-03"))).toMatchObject({ rights: "expired", expiresInDays: null });
    expect(((await reader({ adPlatforms: async r => { const s = adPlatformsFixture(r); s.feeds[1]!.assets[0]!.expiresOn = "2026-11-06"; return s; } }).read("paidMedia", {}, null)).data as Record<string, any>).assets[1]).toMatchObject({ rights: "expiring", expiresInDays: 0 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(analyticsViewSchemas.paidMedia!.safeParse(d).success).toBe(true);
    const filtered = (await reader().read("paidMedia", { rights: "notGranted", platform: "tiktok" }, null)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect([filtered.assets.length, filtered.assetTotal]).toEqual([1, 3]);
    const noAds = await reader({ orders: syntheticAnalyticsSources().orders }).read("paidMedia", {}, null);
    expect((noAds.data as Record<string, any>).sources).toEqual([{ source: "adPlatforms", state: "unconfigured", reasonCode: "SOURCE_UNCONFIGURED" }]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((noAds.data as Record<string, any>).channels).toEqual([]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const nullSpend = await reader({ adPlatforms: async r => { const s = adPlatformsFixture(r); s.feeds[0]!.campaigns[0]!.spendMinor = null; return s; } }).read("paidMedia", {}, null);
    expect((nullSpend.data as Record<string, any>).channels[0].spend).toBeNull(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(measure(nullSpend.data, "platformRoas.meta")).toMatchObject({ state: "unknown", reasonCode: "SPEND_NOT_REPORTED" });
  });

  it("states conversion, support load, returns and rating with their own cohorts", async () => {
    const result = await reader().read("customerJourney", {}, null);
    const d = result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect([d.websiteOrders, d.tiktokOrders, d.globalOrders, d.globalAov]).toEqual([260, 140, 400, { minorUnits: 3149, currency: "USD" }]);
    expect(measure(d, "storeConversion")).toMatchObject({ state: "known", value: 1.625, numerator: { value: 260 }, denominator: { value: 16_000 } });
    expect(measure(d, "supportLoad").value).toBeCloseTo(2200 / 380, 10);
    expect(measure(d, "supportLoad").window).toMatchObject({ start: "2026-10-24", end: "2026-11-06" });
    expect(measure(d, "averageRating").value).toBeCloseTo(4.36, 10);
    expect(d.resolution).toEqual({ byFin: 9, byPeople: 11, open: 2 });
    expect(result.dataState).toBe("ready");
    expect(analyticsViewSchemas.customerJourney!.safeParse(d).success).toBe(true);
  });

  it("reads missing sessions and support as N/A, a known zero as zero, and a zero denominator as not applicable", async () => {
    const { orders } = syntheticAnalyticsSources();
    const bare = await reader({ orders }).read("customerJourney", {}, null);
    const d = bare.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.sessions).toMatchObject({ state: "unknown", value: null, reasonCode: "SESSIONS_SOURCE_UNCONFIGURED" });
    expect([d.productViewed, d.checkoutStarted, d.tickets, d.returns, d.resolution]).toEqual([null, null, null, null, null]);
    expect(d.reviews.stars).toEqual([]);
    expect(measure(d, "storeConversion")).toMatchObject({ state: "unknown", reasonCode: "SESSIONS_SOURCE_UNCONFIGURED" });
    expect(bare.dataState).toBe("partial");
    expect(analyticsViewSchemas.customerJourney!.safeParse(d).success).toBe(true);

    const zero = await reader({ orders, sessions: async r => { const s = sessionsFixture(r); Object.assign(s.feed, { sessions: 0, productViewed: 0, checkoutStarted: 0 }); return s; },
      support: async r => { const s = supportFixture(r); Object.assign(s.feed, { deliveredUnits: 0, tickets: [], reviews: { ratedCount: null, stars: null } }); return s; } }).read("customerJourney", {}, null);
    const z = zero.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(z.sessions).toMatchObject({ state: "known", value: 0 });
    expect(z.tickets).toEqual([]);
    expect(measure(z, "storeConversion")).toMatchObject({ state: "notApplicable", reasonCode: "ZERO_DENOMINATOR" });
    expect(measure(z, "supportLoad")).toMatchObject({ state: "notApplicable", reasonCode: "ZERO_DENOMINATOR", numerator: { value: 0 } });
    expect(measure(z, "averageRating")).toMatchObject({ state: "unknown" });
    expect(z.reviews.ratedCount).toMatchObject({ state: "unknown", value: null });
  });
});

describe("time rules are judged at projection time, after the source awaits", () => {
  /** An injected clock that a synthetic source advances while the read is awaiting it. */
  function steppingClock() {
    let t = T;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }
  type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("marks an orders feed stale when its 15-minute limit passes while the orders reader is answering", async () => {
    const clock = steppingClock();
    const orders = async (r: AnalyticsSourceRequest) => {
      const s = ordersFixture(r);
      for (const f of s.feeds) f.lastSuccessAt = new Date(T - 14 * 60_000).toISOString(); // current when the read starts
      clock.advance(2 * 60_000); // 16 minutes old by the time the answer is projected
      return s;
    };
    const result = await reader({ ...syntheticAnalyticsSources(), orders }, clock.now).read("overviewSummary", {}, null);
    expect(result.dataState).toBe("stale");
    const ordersFreshness = result.sourceFreshness.filter(f => f.sourceRef.source.startsWith("orders."));
    expect(ordersFreshness.map(f => [f.freshnessState, f.staleReasonCode])).toEqual([["error", "SOURCE_STALE"], ["error", "SOURCE_STALE"]]);
    expect((result.data as Data).sources[0]).toEqual({ source: "orders", state: "stale", reasonCode: "SOURCE_STALE" });
    // Figures still render, but their observation stamp is the projection time, not the request time.
    expect((result.data as Data).orders.observedAt).toBe(new Date(T + 2 * 60_000).toISOString());
  });

  it("marks ad platforms stale when their 26-hour limit passes during the await", async () => {
    const clock = steppingClock();
    const adPlatforms = async (r: AnalyticsSourceRequest) => {
      const s = adPlatformsFixture(r);
      for (const f of s.feeds) f.lastSuccessAt = new Date(T - 25.5 * 3_600_000).toISOString();
      clock.advance(3_600_000);
      return s;
    };
    const result = await reader({ ...syntheticAnalyticsSources(), adPlatforms }, clock.now).read("paidMedia", {}, null);
    expect(result.dataState).toBe("stale");
    expect(result.sourceFreshness.every(f => f.freshnessState === "error" && f.staleReasonCode === "SOURCE_STALE")).toBe(true);
    expect((result.data as Data).sources).toEqual([{ source: "adPlatforms", state: "stale", reasonCode: "SOURCE_STALE" }]);
  });

  it("keeps sessions and support on the same projection time in the customer journey", async () => {
    const clock = steppingClock();
    const support = async (r: AnalyticsSourceRequest) => {
      const s = supportFixture(r);
      s.feed.lastSuccessAt = new Date(T - 23.5 * 3_600_000).toISOString();
      clock.advance(3_600_000);
      return s;
    };
    const result = await reader({ ...syntheticAnalyticsSources(), support }, clock.now).read("customerJourney", {}, null);
    expect(result.dataState).toBe("stale");
    expect((result.data as Data).sources.find((x: { source: string }) => x.source === "support")).toEqual({ source: "support", state: "stale", reasonCode: "SOURCE_STALE" });
  });

  it("shows rights that lapse during the await as expired, and counts the remaining days from projection time", async () => {
    const clock = steppingClock();
    const adPlatforms = async (r: AnalyticsSourceRequest) => {
      const s = adPlatformsFixture(r);
      s.feeds[1]!.assets[0]!.expiresOn = "2026-11-06"; // expiring today (America/Los_Angeles) when the read starts
      s.feeds[1]!.assets.push({ assetRef: "synthetic-tiktok-asset-3", label: "AD-04", clicks: 10, impressions: 500, rights: "expiring", expiresOn: "2026-11-18" });
      clock.advance(13 * 3_600_000); // 2026-11-07 01:00 in Los Angeles
      return s;
    };
    const result = await reader({ ...syntheticAnalyticsSources(), adPlatforms }, clock.now).read("paidMedia", {}, null);
    const assets = (result.data as Data).assets as { label: string; rights: string; expiresInDays: number | null }[];
    expect(assets.find(a => a.label.startsWith("AD-03"))).toMatchObject({ rights: "expired", expiresInDays: null });
    expect(assets.find(a => a.label.startsWith("AD-04"))).toMatchObject({ rights: "expiring", expiresInDays: 11 });
    expect(analyticsViewSchemas.paidMedia!.safeParse(result.data).success).toBe(true);
  });

  it("applies the 2-minute skew allowance against projection time, not request time", async () => {
    const clock = steppingClock();
    const orders = async (r: AnalyticsSourceRequest) => {
      const s = ordersFixture(r);
      // Three minutes ahead of the request time, but only one minute ahead of the time the answer is projected.
      s.feeds[0]!.observedAt = new Date(T + 3 * 60_000).toISOString();
      s.feeds[0]!.lastSuccessAt = new Date(T + 3 * 60_000).toISOString();
      s.feeds[0]!.orders[0]!.placedAt = new Date(T + 3 * 60_000).toISOString();
      clock.advance(2 * 60_000);
      return s;
    };
    const result = await reader({ ...syntheticAnalyticsSources(), orders }, clock.now).read("overviewSummary", {}, null);
    expect(result.dataState).toBe("ready");
    expect((result.data as Data).sources[0]).toEqual({ source: "orders", state: "current", reasonCode: null });
  });

  it("never judges a read fresher than its request time when the clock steps back during the await", async () => {
    const clock = steppingClock();
    const orders = async (r: AnalyticsSourceRequest) => {
      const s = ordersFixture(r);
      for (const f of s.feeds) f.lastSuccessAt = new Date(T - 16 * 60_000).toISOString(); // already stale at request time
      clock.advance(-10 * 60_000);
      return s;
    };
    const result = await reader({ ...syntheticAnalyticsSources(), orders }, clock.now).read("overviewSummary", {}, null);
    expect(result.dataState).toBe("stale");
    expect((result.data as Data).orders.observedAt).toBe(new Date(T).toISOString());
  });
});
