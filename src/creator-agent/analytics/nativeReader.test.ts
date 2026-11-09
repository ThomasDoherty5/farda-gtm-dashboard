// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nativeAnalyticsFixture } from "./nativeFixtures.testkit.ts";
import { createNativeAnalyticsReader } from "./nativeReader.ts";
import { nativeAnalyticsViewKeys } from "./contract.ts";
import { nativeAnalyticsViewSchema } from "./views.ts";
import { NativeAnalyticsError } from "./nativeSource.ts";

const read = (f: ReturnType<typeof nativeAnalyticsFixture>, key: typeof nativeAnalyticsViewKeys[number] = "overviewSummary") => f.reader.read(f.request(key), f.principal);

describe("native analytics exact source authority", () => {
  it.each(nativeAnalyticsViewKeys)("serves %s through a strict synthetic native schema without demo identity", async key => {
    const f = nativeAnalyticsFixture(), result = await read(f, key);
    expect(nativeAnalyticsViewSchema.safeParse(result.data).success).toBe(true);
    expect(result.data).toMatchObject({ datasetKey: "analytics-native", viewKey: key, provenance: { synthetic: true, evidenceStage: "synthetic" } });
    expect(() => result.assertCurrent()).not.toThrow();
    expect(nativeAnalyticsViewSchema.safeParse({ ...result.data, datasetKey: "overview-original" }).success).toBe(false);
    expect(nativeAnalyticsViewSchema.safeParse({ ...result.data, provenance: { ...result.data.provenance, synthetic: false } }).success).toBe(false);
    expect(JSON.stringify(result.data)).not.toMatch(/fictional-|synthetic-shopify|cust-shopify|permissionVersion|principalRef/);
  });
  it("has no customerJourney, sessions import or unconfigured fallback", async () => {
    const f = nativeAnalyticsFixture(), unconfigured = createNativeAnalyticsReader({ scope: f.scope, referenceKey: f.referenceKey });
    await expect(unconfigured.read(f.request("overviewSummary"), f.principal)).rejects.toMatchObject({ code: "ANALYTICS_SOURCE_UNCONFIGURED", status: 503 });
    await expect(f.reader.read({ ...f.request("overviewSummary"), viewKey: "customerJourney" }, f.principal)).rejects.toMatchObject({ code: "ANALYTICS_REQUEST_INVALID" });
  });
  it.each(["permission", "source", "denial"])("refuses %s changes while the captured source read is awaited", async kind => {
    const f = nativeAnalyticsFixture();
    f.state.afterRead = () => { if (kind === "permission") f.state.permissionVersion = "changed"; else if (kind === "source") f.state.sourceVersion = "changed"; else f.state.allowed = false; };
    await expect(read(f)).rejects.toMatchObject({ code: kind === "denial" ? "ANALYTICS_SOURCE_DENIED" : kind === "permission" ? "ANALYTICS_PERMISSION_CHANGED" : "ANALYTICS_SOURCE_CHANGED", status: kind === "denial" ? 403 : 409 });
  });
  it("retains a final current assertion after projection and refuses exact lease crossover", async () => {
    const f = nativeAnalyticsFixture(), result = await read(f);
    f.state.allowed = false;
    expect(() => result.assertCurrent()).toThrowError(expect.objectContaining({ code: "ANALYTICS_SOURCE_DENIED", status: 403 }));
    f.state.allowed = true; f.state.now += 60_000;
    expect(() => result.assertCurrent()).toThrowError(expect.objectContaining({ code: "ANALYTICS_PUBLICATION_EXPIRED" }));
  });
  it.each(["scope", "principal", "filters", "owner", "future"])("refuses a %s proof mismatch", async kind => {
    const f = nativeAnalyticsFixture();
    f.state.mutate = snapshot => {
      if (kind === "scope") snapshot.binding.scope.accountId = "other";
      if (kind === "principal") snapshot.binding.principal.principalRef = "other";
      if (kind === "filters") snapshot.binding.request.page.limit = 1;
      if (kind === "owner") snapshot.owners[0]!.requestDigest = "a".repeat(64);
      if (kind === "future") snapshot.observedAt = new Date(f.state.now + 1).toISOString();
    };
    await expect(read(f)).rejects.toBeInstanceOf(NativeAnalyticsError);
  });
  it.each(["async", "value", "missing"])("rejects %s final assertions instead of trusting TypeScript void", async kind => {
    const f = nativeAnalyticsFixture();
    const assertCurrent = kind === "async" ? async () => {} : kind === "value" ? () => 1 : undefined;
    const service = createNativeAnalyticsReader({ scope: f.scope, referenceKey: f.referenceKey, now: f.now, source: { read: f.source.read, assertCurrent: assertCurrent as typeof f.source.assertCurrent } });
    await expect(service.read(f.request("overviewSummary"), f.principal)).rejects.toBeInstanceOf(NativeAnalyticsError);
  });
  it("bounds a hung source and forwards cancellation without exposing exception text", async () => {
    const f = nativeAnalyticsFixture(), service = createNativeAnalyticsReader({ scope: f.scope, referenceKey: f.referenceKey, now: f.now, timeoutMs: 1, source: { ...f.source, read: () => new Promise(() => {}) } });
    await expect(service.read(f.request("overviewSummary"), f.principal)).rejects.toMatchObject({ code: "ANALYTICS_SOURCE_TIMEOUT", status: 504 });
    const controller = new AbortController(); controller.abort();
    await expect(f.reader.read(f.request("overviewSummary"), f.principal, controller.signal)).rejects.toMatchObject({ code: "ANALYTICS_REQUEST_CANCELLED", status: 499 });
    expect(new NativeAnalyticsError("private-address@example.test", 403)).toMatchObject({ message: "ANALYTICS_SOURCE_UNAVAILABLE", code: "ANALYTICS_SOURCE_UNAVAILABLE", status: 503 });
  });
});

describe("source-owned analytics facts and arithmetic", () => {
  it("preserves original 400-order/$12,596 arithmetic and distinct attribution, excluding mirrored copies", async () => {
    const f = nativeAnalyticsFixture();
    f.state.mutate = snapshot => {
      if (snapshot.viewKey !== "attribution") return;
      const orders = snapshot.facts.orders!.snapshot;
      const tiktok = orders.feeds.find(feed => feed.channel === "tiktokShop")!;
      const shopify = orders.feeds.find(feed => feed.channel === "shopify")!;
      shopify.orders.push({ ...structuredClone(tiktok.orders[0]!), orderRef: "fictional-shopify-copy" });
      snapshot.facts.economics!.costs.push(structuredClone(snapshot.facts.economics!.costs[0]!));
    };
    const { data } = await read(f, "attribution");
    if (data.viewKey !== "attribution") throw new Error("wrong view");
    expect(data.orders.value).toBe(400); expect(data.netReceipts.value?.minorUnits).toBe(1259600);
    expect(data.measures.find(row => row.metricId === "aov")?.result.value).toBe(3149);
    expect(data.marketingSpend.value?.minorUnits).toBe(650000);
    expect(data.attribution.find(row => row.method === "creatorCode")?.orders.value).toBe(160);
    expect(data.attribution.find(row => row.method === "sitewideCode")?.orders.value).toBe(20);
    expect(data.measures.find(row => row.metricId === "mer")?.result.value).toBeCloseTo(1259600 / 650000);
    expect(data.measures.find(row => row.metricId === "contributionMargin")?.result.value).toBeCloseTo(600000 / 1259600 * 100);
    expect(data.measures.find(row => row.metricId === "shareOrders.shopify")?.result.value).toBe(65);
  });
  it("keeps complete zero distinct from partial or stale observed zero", async () => {
    for (const mode of ["complete", "partial", "stale"] as const) {
      const f = nativeAnalyticsFixture();
      f.state.mutate = snapshot => {
        if (snapshot.viewKey !== "overviewSummary") return;
        for (const feed of snapshot.facts.orders!.snapshot.feeds) { feed.orders = []; if (mode === "partial") feed.coverage = "partial"; if (mode === "stale") feed.lastSuccessAt = new Date(f.state.now - 16 * 60_000).toISOString(); }
        const owner = snapshot.owners.find(row => row.owner === "commerceOrders")!;
        if (mode === "partial") owner.coverage = "partial";
        if (mode === "stale") owner.sourceAsOf = new Date(f.state.now - 16 * 60_000).toISOString();
      };
      const { data } = await read(f);
      if (data.viewKey !== "overviewSummary") throw new Error("wrong view");
      expect(data.orders.value).toBe(mode === "complete" ? 0 : null);
      expect(data.measures.find(row => row.metricId === "aov")?.result.state).toBe(mode === "complete" ? "notApplicable" : "unknown");
    }
  });
  it("rejects unsupported currencies for money while preserving independently known counts", async () => {
    const f = nativeAnalyticsFixture(); f.state.mutate = snapshot => { if (snapshot.viewKey === "overviewSummary") snapshot.facts.orders!.snapshot.feeds[0]!.orders[0]!.currency = "JPY"; };
    const { data } = await read(f); if (data.viewKey !== "overviewSummary") throw new Error("wrong view");
    expect(data.orders.value).toBe(400); expect(data.netReceipts.state).toBe("unknown");
  });
  it("computes overview margin/shares and qualified post totals on the server", async () => {
    const f = nativeAnalyticsFixture();
    f.state.mutate = snapshot => { if (snapshot.viewKey === "overviewSummary") snapshot.facts.posts[0]!.shares = { ...snapshot.facts.posts[0]!.likes, value: 5 }; };
    const { data } = await read(f); if (data.viewKey !== "overviewSummary") throw new Error("wrong view");
    const metric = (id: string) => data.measures.find(row => row.metricId === id)!;
    expect(metric("contributionMargin").result.value).toBeCloseTo(600000 / 1259600 * 100);
    expect(metric("shareOrders.shopify").result.value).toBe(65);
    expect(metric("shareNetReceipts.tiktokShop").result.value).toBeCloseTo(423200 / 1259600 * 100);
    expect(metric("creatorViews").result.value).toBe(500);
    expect(metric("creatorEngagementRate")).toMatchObject({ numerator: { value: 20 }, denominator: { value: 500 }, result: { value: 4 } });
  });
  it("never makes an empty post list zero without a complete exact zero source proof", async () => {
    for (const mode of ["missing", "partial", "zero"] as const) {
      const f = nativeAnalyticsFixture(); f.state.mutate = snapshot => {
        if (snapshot.viewKey !== "overviewSummary") return;
        snapshot.facts.posts = [];
        snapshot.facts.postsTotal = mode === "missing" ? { value: null, proofRef: null, reason: "SOURCE_MISSING", evidenceRefs: [] } : { ...snapshot.facts.postsTotal, value: 0 };
        if (mode === "partial") snapshot.owners.find(owner => owner.owner === "creatorActivity")!.coverage = "partial";
      };
      const { data } = await read(f); if (data.viewKey !== "overviewSummary") throw new Error("wrong view");
      expect(data.measures.find(row => row.metricId === "creatorViews")?.result.value).toBe(mode === "zero" ? 0 : null);
      expect(data.measures.find(row => row.metricId === "creatorEngagementRate")?.result.state).toBe(mode === "zero" ? "notApplicable" : "unknown");
    }
  });
  it("uses the exact filtered asset set and keeps the original GMV Max separation", async () => {
    const f = nativeAnalyticsFixture(), request = { ...f.request("paidMedia"), filters: { platform: "tiktok", rights: "notGranted" } };
    const { data } = await f.reader.read(request, f.principal); if (data.viewKey !== "paidMedia") throw new Error("wrong view");
    expect(data.assets).toHaveLength(1); expect(data.assetTotal.value).toBe(1);
    expect(data.channels[0]!.spend.value?.minorUnits).toBe(350000);
    expect(data.channels[0]!.measures.find(row => row.metricId === "platformRoas.tiktok")?.result.value).toBe(2.4);
  });
  it("keeps GMV Max spend separate from standard paired rates and ranks assets before pagination", async () => {
    const f = nativeAnalyticsFixture();
    const { data } = await read(f, "paidMedia"); if (data.viewKey !== "paidMedia") throw new Error("wrong view");
    expect(data.totals.spend.value?.minorUnits).toBe(650000);
    expect(data.totals.impressions.value).toBe(800000); expect(data.totals.clicks.value).toBe(16000);
    expect(data.totals.measures.find(row => row.metricId === "ctr")?.result.value).toBe(2);
    expect(data.totals.measures.find(row => row.metricId === "cpc")?.result.value).toBe(31);
    expect(data.channels.find(row => row.platform === "tiktok")?.measures.find(row => row.metricId === "cpc.tiktok")?.result.value).toBe(33);
    expect(data.assets.map(row => row.ctr.value)).toEqual([2.8, 2, 1.6]);
    const attributed = await read(f, "attribution"); if (attributed.data.viewKey !== "attribution") throw new Error("wrong view");
    expect(attributed.data.measures.find(row => row.metricId === "platformRoas.tiktok")?.result.value).toBe(2.4);
  });
  it("holds rates and paid rights for incomplete observations, and reviews grants expiring within30 days", async () => {
    const f = nativeAnalyticsFixture(); f.state.mutate = packet => {
      if (packet.viewKey !== "paidMedia") return;
      packet.facts.ads!.snapshot.feeds[0]!.assets[0]!.expiresOn = new Date(f.now() + 10 * 86400000).toISOString().slice(0, 10);
    };
    let result = await read(f, "paidMedia"); if (result.data.viewKey !== "paidMedia") throw new Error("wrong view");
    expect(result.data.assets[0]!.rights).toBe("expiring");
    f.state.mutate = packet => { if (packet.viewKey === "paidMedia") { packet.facts.ads!.snapshot.feeds[0]!.coverage = "partial"; packet.owners.find(owner => owner.owner === "adReporting")!.coverage = "partial"; } };
    result = await read(f, "paidMedia"); if (result.data.viewKey !== "paidMedia") throw new Error("wrong view");
    expect(result.data.assets[0]!.rights).toBe("unknown");
    expect(result.data.totals.measures.find(row => row.metricId === "ctr")?.result.state).toBe("unknown");
  });
  it("never substitutes all posts for mature recipient posts or sums unqualified channel partitions", async () => {
    const f = nativeAnalyticsFixture();
    let result = await read(f, "campaignFunnel"); if (result.data.viewKey !== "campaignFunnel") throw new Error("wrong view");
    expect(result.data.totals.contacted.value).toBe(24); expect(result.data.matureDelivered.value).toBe(4);
    expect(result.data.maturePosted.state).toBe("unknown"); expect(result.data.matureNoPost.state).toBe("unknown");
    f.state.mutate = packet => { if (packet.viewKey === "campaignFunnel") packet.facts.maturePosted = { ...packet.facts.notYetMature, value: 2 }; };
    result = await read(f, "campaignFunnel"); if (result.data.viewKey !== "campaignFunnel") throw new Error("wrong view");
    expect(result.data.matureNoPost.value).toBe(2); expect(result.data.measures.find(row => row.metricId === "maturePostingRate")?.result.value).toBe(50);
    f.state.mutate = packet => { if (packet.viewKey === "campaignFunnel") packet.facts.aggregation = "unknown"; };
    result = await read(f, "campaignFunnel"); if (result.data.viewKey !== "campaignFunnel") throw new Error("wrong view");
    expect(result.data.totals.contacted.state).toBe("unknown"); expect(result.data.channels[0]!.steps.contacted.value).toBe(24);
  });
  it("rejects mature published counts larger than all published opportunities", async () => {
    const f = nativeAnalyticsFixture(); f.state.mutate = packet => {
      if (packet.viewKey !== "campaignFunnel") return;
      packet.facts.channels[0]!.steps.posted.value = 1;
      packet.facts.maturePosted = { ...packet.facts.notYetMature, value: 3 };
    };
    await expect(read(f, "campaignFunnel")).rejects.toMatchObject({ code: "ANALYTICS_SOURCE_INVALID" });
  });
  it("binds pagination to the original principal, filters, source and permission versions", async () => {
    const f = nativeAnalyticsFixture(), request = { ...f.request("paidMedia"), page: { cursor: null as string | null, limit: 1 } };
    const first = await f.reader.read(request, f.principal);
    if (first.data.viewKey !== "paidMedia") throw new Error("wrong view");
    expect(first.data.assets).toHaveLength(1); expect(first.data.assetTotal.value).toBe(3); expect(first.page.hasMore).toBe(true);
    request.page.cursor = first.page.nextCursor;
    const second = await f.reader.read(request, f.principal);
    if (second.data.viewKey !== "paidMedia") throw new Error("wrong view");
    expect(second.data.assets[0]!.assetRef).not.toBe(first.data.assets[0]!.assetRef);
    await expect(f.reader.read({ ...request, filters: { platform: "tiktok", rights: "all" } }, f.principal)).rejects.toMatchObject({ code: "ANALYTICS_CURSOR_STALE" });
    await expect(f.reader.read(request, { principalRef: "agent-reader", role: "reader" })).rejects.toMatchObject({ code: "ANALYTICS_CURSOR_STALE" });
    f.state.sourceVersion = "fictional-source-v2";
    await expect(f.reader.read(request, f.principal)).rejects.toMatchObject({ code: "ANALYTICS_CURSOR_STALE" });
  });
  it("refuses arbitrary campaign identity and cumulative/capacity contradictions", async () => {
    const f = nativeAnalyticsFixture();
    await expect(f.reader.read({ ...f.request("campaignFunnel"), filters: { campaignId: "guessed", cohort: "guessed" } }, f.principal)).rejects.toMatchObject({ code: "ANALYTICS_BINDING_MISMATCH" });
    f.state.mutate = snapshot => { if (snapshot.viewKey === "campaignFunnel") snapshot.facts.channels[0]!.steps.posted.value = 25; };
    await expect(read(f, "campaignFunnel")).rejects.toMatchObject({ code: "ANALYTICS_SOURCE_INVALID" });
  });
  it("does not declare reconciliation matches when one compared observation is partial", async () => {
    const f = nativeAnalyticsFixture(); f.state.mutate = snapshot => { snapshot.owners.find(owner => owner.owner === "reconciliation")!.coverage = "partial"; };
    const { data } = await read(f, "launchReconciliation"); if (data.viewKey !== "launchReconciliation") throw new Error("wrong view");
    expect(data.matrix[0]!.comparison.state).toBe("unknown");
  });
});
