import type { z } from "zod";
import type { OperationsScope } from "../operations.ts";
import { createNativeAnalyticsReader } from "./nativeReader.ts";
import { NativeAnalyticsError, type NativeAnalyticsSource } from "./nativeSource.ts";
import { nativeAnalyticsSnapshotSchema, type analyticsCostSchema, type AnalyticsInputFact, type AnalyticsOwnerProof, type NativeAnalyticsBinding, type NativeAnalyticsSnapshot, type NativeAnalyticsViewKey } from "./contract.ts";
import { digest } from "../config.ts";
import { adPlatformsFixture, analyticsTestScope, analyticsTestSecret, analyticsTestTime, ordersFixture } from "./fixtures.testkit.ts";

/** Fictional, explicit sandbox owners only. Nothing here qualifies a provider, account or live report. */
export function nativeAnalyticsFixture(options: { now?: () => number; principalRef?: string; scope?: OperationsScope; acquisitionCase?: boolean } = {}) {
  const state = { now: analyticsTestTime, permissionVersion: "fictional-read-grant-v1", sourceVersion: "fictional-source-v1", allowed: true, mutate: null as ((snapshot: NativeAnalyticsSnapshot) => void) | null, afterRead: null as (() => void | Promise<void>) | null };
  const clock = options.now ?? (() => state.now), principal = { principalRef: options.principalRef ?? "agent-reviewer", role: "reviewer" as const };
  const scope = options.scope ?? analyticsTestScope, referenceKey = analyticsTestSecret;
  const ownerKinds = ["commerceOrders", "adReporting", "economicCosts", "retainedCustomers", "creatorActivity", "launchReadiness", "campaignEvents", "sampleCapacity", "metricDefinitions", "reconciliation"] as const;
  const iso = (value: number) => new Date(value).toISOString();
  const input = <T>(value: T, owner: typeof ownerKinds[number]): AnalyticsInputFact<T> => ({ value, reason: null, proofRef: `fictional-proof-${owner}`, evidenceRefs: [`fictional-evidence-${owner}`] });
  const missing = <T>(): AnalyticsInputFact<T> => ({ value: null, reason: "SOURCE_MISSING", proofRef: null, evidenceRefs: [] });
  function packet(binding: NativeAnalyticsBinding): NativeAnalyticsSnapshot {
    const at = clock(), endAt = iso(Date.parse(iso(at).slice(0, 10))), startAt = iso(Date.parse(endAt) - 30 * 86_400_000);
    const period = binding.request.period ?? { startAt, endAt, timezone: "UTC", basis: "eventTime" as const };
    const window = { start: period.startAt.slice(0, 10), end: iso(Date.parse(period.endAt) - 86_400_000).slice(0, 10), timezone: period.timezone }, cohortRef = "fictional-qualified-cohort";
    const owners: AnalyticsOwnerProof[] = ownerKinds.map(owner => ({ proofRef: `fictional-proof-${owner}`, owner, scope: { ...scope }, principalRef: binding.principal.principalRef, requestDigest: digest(binding.request), accountRef: `fictional-${owner}-account`, sourceVersion: state.sourceVersion, permissionVersion: state.permissionVersion, definitionVersion: "fictional-qualified-definition-v1", cohortRef, period,
      observedAt: iso(at), sourceAsOf: iso(at - (owner === "commerceOrders" ? 5 * 60_000 : owner === "adReporting" ? 2 * 3_600_000 : 0)), validUntil: iso(at + 60_000), maxAgeMs: owner === "adReporting" ? 26 * 3_600_000 : 15 * 60_000, coverage: "complete" }));
    type Cost = z.infer<typeof analyticsCostSchema>;
    const cost = (key: Cost["key"], basis: Cost["basis"], minorUnits: number, obligation: string, evidence = obligation): Cost => ({
      key, basis, minorUnits, alsoInCash: false, obligationRef: "fictional-obligation-" + obligation,
      evidenceRef: "fictional-evidence-" + evidence, cashRef: basis === "paid" ? "fictional-cash-" + obligation : null,
    });
    const costs = options.acquisitionCase ? [
      cost("paidMedia", "paid", 500_000, "media"),
      cost("sample", "accrued", 90_000, "sample"),
      cost("shipping", "paid", 40_000, "shipping"),
      cost("creatorCommission", "accrued", 40_000, "commission"),
      cost("historicalCreatorFee", "accrued", 30_000, "accepted-fee"),
      cost("historicalCreatorFee", "paid", 30_000, "accepted-fee", "accepted-fee-settlement"),
    ] : [cost("paidMedia", "paid", 650_000, "cost")];
    const economics = { proofRef: "fictional-proof-economicCosts", cohortRef, period, currency: "USD" as const, allocationVersion: "economic-events@1" as const,
      costs, retention: "mature" as const, landedCost: "complete" as const, refundRevision: null,
      contribution: input({ minorUnits: 600000, currency: "USD" as const }, "economicCosts"), newRetainedCustomers: input(280, "retainedCustomers") };
    const orders = { proofRef: "fictional-proof-commerceOrders", snapshot: ordersFixture({ scope, window }, at) }, ads = { proofRef: "fictional-proof-adReporting", snapshot: adPlatformsFixture({ scope, window }, at) };
    if (options.acquisitionCase) {
      const purchase = orders.snapshot.feeds.find(feed => feed.channel === "shopify" && feed.origin === "native")
        ?.orders.find(row => row.recordOwner === "shopify" && row.valid && row.unitsRetained === 1);
      for (const feed of orders.snapshot.feeds) {
        for (const row of feed.orders) {
          if (purchase && row.canonicalOrderId === purchase.canonicalOrderId) row.unitsRetained = 2;
        }
      }
      for (const feed of ads.snapshot.feeds) feed.campaigns = feed.campaigns.filter(row => row.kind === "standard");
    }
    const base = { schemaVersion: "analytics-source.v1", binding: structuredClone(binding), sourceVersion: state.sourceVersion, permissionVersion: state.permissionVersion, evidenceStage: "synthetic", synthetic: true, observedAt: iso(at), validUntil: iso(at + 60_000), period, window, cohortRef, owners, viewKey: binding.request.viewKey };
    const commerce = { orders, ads, economics };
    const count = (n: number) => input(n, "campaignEvents"), stock = (n: number) => input(n, "sampleCapacity");
    const facts: Record<NativeAnalyticsViewKey, unknown> = {
      overviewSummary: { ...commerce, postsTotal: input(1, "creatorActivity"), activity: [{ activityRef: "fictional-activity", creatorRef: "fictional-creator", kind: "published", eventAt: iso(at - 1000), proofRef: "fictional-proof-creatorActivity", evidenceRefs: ["fictional-publication-receipt"] }], posts: [{ postRef: "fictional-post", views: input(500, "creatorActivity"), likes: input(12, "creatorActivity"), comments: input(3, "creatorActivity"), shares: missing<number>() }] },
      attribution: { ...commerce, creators: [{ creatorRef: "fictional-creator", roi: missing<number>() }] },
      paidMedia: { ads, creatorSampleEconomics: input({ minorUnits: options.acquisitionCase ? 200_000 : 30_000, currency: "USD" as const }, "economicCosts"),
        ...(options.acquisitionCase ? { economics } : {}) },
      launchSnapshot: { launchDate: missing<string>(), targetWindow: missing<z.infer<typeof nativeAnalyticsSnapshotSchema>["period"]>(), stage: input("pilot", "launchReadiness"), conversations: count(24), readyForNextStep: input(12, "launchReadiness"), firstWaveSamples: stock(12), budgetCeiling: input({ minorUnits: 30000, currency: "USD" as const }, "economicCosts"), momentum: [{ segment: "tiktokShop", inConversation: count(24), ready: input(12, "launchReadiness") }], gates: [{ gateId: "terms", state: "held", reasonCodes: ["NO_AUTHORITATIVE_RECEIPT"], proofRef: "fictional-proof-launchReadiness", evidenceRefs: ["fictional-terms-read"], relativeOffsetDays: null, anchorEventAt: null }], approvals: [] },
      launchReconciliation: { asOf: iso(at), matrix: [{ metricId: "orders", definitionVersion: "fictional-qualified-definition-v1", unit: "count", currency: null, cells: ["overviewSummary", "attribution"].map(viewKey => ({ viewKey, cohortRef, period, definitionVersion: "fictional-qualified-definition-v1", inputVersion: state.sourceVersion, value: input(400, "reconciliation") })) }] },
      campaignFunnel: { selection: { campaignId: "campaign-current", cohort: "first-wave" }, campaignRef: "fictional-campaign", cohortRef, maturity: "immature", progression: "distinctOpportunityCumulative", aggregation: "disjointComplete", maturePosted: missing<number>(), channels: [{ channel: "tiktokShop", contactReference: count(24), steps: { contacted: count(24), replied: count(16), agreed: count(12), shipped: count(10), delivered: count(8), posted: count(4) }, giftCap: stock(12), reserved: stock(2), historical: { replies: missing<number>(), agreements: missing<number>() } }], notYetMature: count(4), historicalBasis: null },
      metricDictionary: { proofRef: "fictional-proof-metricDefinitions", effectiveAt: iso(at - 1000), formulaVersion: "headline-metrics.v1", allocationVersion: "economic-events@1", economics },
    };
    const result = nativeAnalyticsSnapshotSchema.parse({ ...base, facts: facts[binding.request.viewKey] });
    state.mutate?.(result);
    return result;
  }
  const source: NativeAnalyticsSource = {
    async read(binding) { const result = packet(binding); await state.afterRead?.(); return result; },
    assertCurrent(snapshot, binding) {
      if (!state.allowed) throw new NativeAnalyticsError("ANALYTICS_SOURCE_DENIED", 403);
      if (snapshot.permissionVersion !== state.permissionVersion || snapshot.owners.some(owner => owner.permissionVersion !== state.permissionVersion)) throw new NativeAnalyticsError("ANALYTICS_PERMISSION_CHANGED", 409);
      if (snapshot.sourceVersion !== state.sourceVersion || snapshot.owners.some(owner => owner.sourceVersion !== state.sourceVersion) || digest(snapshot.binding) !== digest(binding)) throw new NativeAnalyticsError("ANALYTICS_SOURCE_CHANGED", 409);
    },
  };
  const reader = createNativeAnalyticsReader({ scope, referenceKey, source, now: clock });
  const request = (viewKey: NativeAnalyticsViewKey) => ({ viewKey, filters: viewKey === "paidMedia" ? { platform: "all", rights: "all" } : viewKey === "campaignFunnel" ? { campaignId: "campaign-current", cohort: "first-wave" } : {}, period: null, sort: [], page: { cursor: null, limit: 50 } });
  return { state, scope, referenceKey, principal, source, reader, request, packet, now: clock };
}
