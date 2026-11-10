// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { overviewOwnersFixture } from "./overviewOwners.testkit.ts";
import { composeOverviewOwners } from "./overviewOwners.ts";
import { nativeOverviewSummarySchema, nativeAttributionSchema } from "./views.ts";
import { nativeContentSchema } from "../monitor/contract.ts";
import { financeHeadlines } from "../finance/headlines.ts";
import { financeDashboardSchema } from "../../adapter/viewSchemas/finance.ts";

const active: Awaited<ReturnType<typeof overviewOwnersFixture>>[] = [];
async function fixture() { const f = await overviewOwnersFixture(); active.push(f); return f; }
afterEach(() => { for (const f of active.splice(0)) f.close(); });
describe("overview composes canonical domain owners without a second truth store", () => {
  it("reconciles five actual readers, canonical intake and stored portfolio in one exact fictional period", async () => {
    const f = await fixture(), result = await f.read(), overview = nativeOverviewSummarySchema.parse(result.data), owners = overview.domains!;
    expect(Object.values(owners).map(owner => [owner.state, owner.synthetic])).toEqual(Array(5).fill(["ready", true]));
    const attribution = nativeAttributionSchema.parse((await f.readers.analytics.read({ ...f.analytics.request("attribution"), period: f.period }, f.principal)).data);
    expect(owners.creators.data).toMatchObject({ attributedOrders: attribution.attributedOrders, attributedNetSales: attribution.attributedNetSales, roi: attribution.creators, period: f.period });
    expect(overview.orders.value).toBe(400); expect(overview.netReceipts.value?.minorUnits).toBe(1259600);
    const filters = { startAt: f.period.startAt, endAt: f.period.endAt, timezone: f.period.timezone };
    const finance = financeDashboardSchema.omit({ datasetKey: true }).parse((await f.readers.finance.read("financeDashboard", filters, f.principal)).data);
    expect(owners.finance.data).toMatchObject(financeHeadlines(finance));
    expect(owners.finance.data).toMatchObject({ grossMargin: 90, cash: 120000, runwayMonths: 3, actualRevenue: 10000, forecastRevenue: 15000 });
    const monitor = nativeContentSchema.parse((await f.readers.monitor.read("contentMonitor", { campaign: f.readers.monitor.publicCampaignRef("fictional-qualified-cohort"), reportingPeriod: f.period }, { limit: 100, cursor: null, authorizationContext: "reader" }, f.caller)).data);
    expect(owners.activity.data).toMatchObject({ views: monitor.views, rate: monitor.rate, orders: monitor.orders, net: monitor.net, total: monitor.total, liveCount: monitor.liveCount });
    expect(owners.activity.data).toMatchObject({ views: 500, rate: 3, orders: 0, net: { minorUnits: 0, currency: "USD" }, liveCount: 1 });
    expect(owners.operations.data).toMatchObject({ shipments: 1, toShip: { state: "known", value: 0 }, timeToShipDays: { value: 2 }, shippingCostPerOrder: { value: { minorUnits: 500, currency: "USD" } }, summaryBasis: { latency: { denominator: 1 }, shippingCost: { denominator: 1 } } });
    expect(owners.portfolio.data).toMatchObject({ creators: 1, verifiedPublications: 1, matureRetainedContribution: { minorUnits: 0, currency: "USD" } });
    expect(f.readers.portfolio.latest(f.portfolioReview.reviewKey)?.reviewHash).toBe(f.portfolioReview.reviewHash);
    expect(JSON.stringify(overview)).not.toContain("fictional-policy-evidence");
    expect(JSON.stringify(overview)).not.toContain("fictional-policy-v1");
  });
  it("bounds the composed lease by the shorter actual shipping reader", async () => {
    const f = await fixture(); f.operations.shippingValidUntil = new Date(f.now() + 15_000).toISOString();
    const result = await f.read(), data = nativeOverviewSummarySchema.parse(result.data);
    expect(data.domains!.operations.validUntil).toBe(f.operations.shippingValidUntil);
    expect(data.provenance.validUntil).toBe(f.operations.shippingValidUntil);
    f.state.now += 15_000;
    expect(() => result.assertCurrent()).toThrow();
  });
  it.each(["finance", "monitor"] as const)("expires current %s evidence before its longer access grant", async owner => {
    const f = await fixture(), deadline = new Date(f.now() + 15_000).toISOString();
    if (owner === "finance") f.finance.validUntil = deadline;
    else f.monitor.snapshot.validUntil = deadline;
    const result = await f.read(), data = nativeOverviewSummarySchema.parse(result.data);
    const domain = owner === "finance" ? "finance" : "activity";
    expect(data.domains![domain]).toMatchObject({ state: "ready", validUntil: deadline });
    expect(data.provenance.validUntil).toBe(deadline);
    expect(Date.parse(f.finance.readAccessValidUntil)).toBeGreaterThan(Date.parse(deadline));
    f.state.now += 15_000;
    expect(() => result.assertCurrent()).toThrow();
    // A new read may retain explicitly stale evidence under a still-current
    // grant; the freshness cutoff must not masquerade as access revocation.
    const refreshed = nativeOverviewSummarySchema.parse((await f.read()).data);
    expect(refreshed.domains![domain].state).toBe("stale");
    expect(Date.parse(refreshed.provenance.validUntil)).toBeGreaterThan(f.now());
  });
  it.each(["finance", "operations", "monitor"] as const)("rejects a revoked %s owner at final publication", async owner => {
    const f = await fixture(), result = await f.read(); f[owner].allowed = false;
    expect(() => result.assertCurrent()).toThrow();
  });
  it("rejects caller and source revocation during awaited owner composition", async () => {
    const f = await fixture(); f.finance.afterRead = () => { f.analytics.state.allowed = false; };
    await expect(f.read()).rejects.toMatchObject({ status: 403 });
    f.analytics.state.allowed = true; f.finance.afterRead = () => { f.state.allowed = false; };
    await expect(f.read()).rejects.toMatchObject({ status: 403 });
  });
  it("holds absent source-stage proof even when the base owner is non-synthetic", async () => {
    const f = await fixture();
    const base = await f.analytics.reader.read({ ...f.analytics.request("overviewSummary"), period: f.period }, f.principal);
    base.data.provenance.synthetic = false;
    const saved = { ...f.portfolioReview }; delete saved.sourceEvidence;
    const read = await composeOverviewOwners(base, { ...f.readers, portfolio: { latest: () => saved } }, f.principal, f.caller);
    expect(nativeOverviewSummarySchema.parse(read.data).domains!.portfolio).toMatchObject({ state: "mismatch", data: null });
  });
  it("does not combine a native-stage detail with a synthetic overview", async () => {
    const f = await fixture(); f.finance.record.synthetic = false;
    (f.finance.record.provenance as { evidenceStage: string }).evidenceStage = "source";
    expect(nativeOverviewSummarySchema.parse((await f.read()).data).domains!.finance).toMatchObject({ state: "mismatch", data: null });
  });
  it("holds wrong periods and unproved logistics denominators rather than substituting totals", async () => {
    const f = await fixture();
    const context = f.finance.record.summaryContext as { period: typeof f.period }; context.period = { ...f.period, timezone: "America/Los_Angeles" };
    f.operations.overview.summaryBasis = null;
    const data = nativeOverviewSummarySchema.parse((await f.read()).data);
    expect(data.domains!.finance).toMatchObject({ state: "unavailable", reason: "SOURCE_INVALID", data: null });
    expect(data.domains!.operations.data).toMatchObject({ summaryBasis: null, timeToShipDays: { state: "unknown", value: null }, shippingCostPerOrder: { state: "unknown", value: null } });
  });
  it("refuses source arithmetic inconsistent with the exact logistics denominator", async () => {
    const f = await fixture();
    (f.operations.overview.summaryBasis as { latency: { denominator: number } }).latency.denominator = 2;
    await expect(f.readers.operations.read("operationsOverview", { home: "all", startAt: f.period.startAt, endAt: f.period.endAt, timezone: f.period.timezone }, f.principal)).rejects.toMatchObject({ status: 502, reasonCodes: ["OPERATIONS_DENOMINATOR_MISMATCH"] });
    expect(nativeOverviewSummarySchema.parse((await f.read()).data).domains!.operations).toMatchObject({ state: "unavailable", reason: "SOURCE_INVALID", data: null });
  });
  it("preserves all verified publications but never matures an immature contribution", async () => {
    const f = await fixture(), packet = structuredClone(f.portfolioPacket);
    packet.evidenceRevision = "fictional-next-v2"; packet.trigger.eventId = "fictional-next-event";
    const collaboration = packet.creators[0]!.collaborations[0]!;
    collaboration.retainedContribution.maturity = "immature";
    collaboration.posts.push({ postId: "fictional-younger-publication", publishedAt: new Date(Date.parse(f.period.endAt) - 2 * 86_400_000).toISOString() });
    const saved = await f.readers.portfolio.review({ scope: { workspaceId: f.scope.workspaceId, accountId: f.scope.accountId }, expectedVersion: 1, packet }, "fictional-next-review");
    f.analytics.state.mutate = snapshot => { f.initialMutate(snapshot); if (snapshot.viewKey === "overviewSummary") snapshot.facts.portfolio!.reviewHash = saved.reviewHash; };
    const portfolio = nativeOverviewSummarySchema.parse((await f.read()).data).domains!.portfolio.data!;
    expect(portfolio.verifiedPublications).toBe(2); expect(portfolio.matureRetainedContribution).toBeNull();
  });
  it("keeps overlapping portfolio dimensions distinct from the one-creator population", async () => {
    const f = await fixture(), packet = structuredClone(f.portfolioPacket), collaboration = packet.creators[0]!.collaborations[0]!;
    packet.evidenceRevision = "fictional-overlap-v2"; packet.trigger.eventId = "fictional-overlap-event";
    collaboration.retainedContribution.cents.value = 500; collaboration.paid.validatedPerformer.value = true;
    const saved = await f.readers.portfolio.review({ scope: { workspaceId: f.scope.workspaceId, accountId: f.scope.accountId }, expectedVersion: 1, packet }, "fictional-overlap-review");
    f.analytics.state.mutate = snapshot => { f.initialMutate(snapshot); if (snapshot.viewKey === "overviewSummary") snapshot.facts.portfolio!.reviewHash = saved.reviewHash; };
    const portfolio = nativeOverviewSummarySchema.parse((await f.read()).data).domains!.portfolio.data!;
    expect(portfolio.creators).toBe(1);
    expect(portfolio.dimensions.filter(dimension => dimension.creators === 1).map(dimension => dimension.dimension)).toEqual(
      expect.arrayContaining(["reliable-content-producer", "retained-sales-performer", "paid-creative-performer"]));
    expect(portfolio.matureRetainedContribution).toEqual({ minorUnits: 500, currency: "USD" });
  });
  it("counts verified publications only inside the exact start-inclusive, end-exclusive interval", async () => {
    const f = await fixture(), packet = structuredClone(f.portfolioPacket);
    packet.evidenceRevision = "fictional-publication-boundaries-v2"; packet.trigger.eventId = "fictional-publication-boundaries-event";
    packet.creators[0]!.collaborations[0]!.posts.push(
      { postId: "fictional-before-period", publishedAt: new Date(Date.parse(f.period.startAt) - 1).toISOString() },
      { postId: "fictional-at-period-start", publishedAt: f.period.startAt },
      { postId: "fictional-at-period-end", publishedAt: f.period.endAt },
    );
    const saved = await f.readers.portfolio.review({ scope: { workspaceId: f.scope.workspaceId, accountId: f.scope.accountId }, expectedVersion: 1, packet }, "fictional-publication-boundaries-review");
    f.analytics.state.mutate = snapshot => { f.initialMutate(snapshot); if (snapshot.viewKey === "overviewSummary") snapshot.facts.portfolio!.reviewHash = saved.reviewHash; };
    const portfolio = nativeOverviewSummarySchema.parse((await f.read()).data).domains!.portfolio.data!;
    expect(portfolio.verifiedPublications).toBe(2);
    expect(portfolio.period).toEqual(f.period);
  });
});
