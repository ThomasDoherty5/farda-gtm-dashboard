import { z } from "zod";
import { digest } from "../config.ts";
import type { createFinanceReader } from "../finance/reader.ts";
import type { createOperationsReadReader } from "../operationsReads/reader.ts";
import type { createMonitorReader } from "../monitor/reader.ts";
import { nativeContentSchema } from "../monitor/contract.ts";
import { financeHeadlines } from "../finance/headlines.ts";
import { financeDashboardSchema } from "../../adapter/viewSchemas/finance.ts";
import { operationsOverviewSchema } from "../../adapter/viewSchemas/ops.ts";
import { operationsReportingScopeSchema, operationsSummaryBasisSchema } from "../../adapter/viewSchemas/nativeOperations.ts";
import { nativeAttributionSchema, overviewDomainsSchema, type OverviewDomains } from "./views.ts";
import type { NativeAnalyticsReadResult, createNativeAnalyticsReader } from "./nativeReader.ts";
import { NativeAnalyticsError } from "./nativeSource.ts";
import type { PortfolioRepository } from "../portfolioStore.ts";
import { portfolioPacketSchema, reviewPortfolio } from "../portfolio.ts";

type Readers = { finance: ReturnType<typeof createFinanceReader>; operations: ReturnType<typeof createOperationsReadReader>;
  monitor: ReturnType<typeof createMonitorReader>; analytics: ReturnType<typeof createNativeAnalyticsReader>; portfolio: Pick<PortfolioRepository, "latest"> };
type Principal = { principalRef: string; role: "reader" | "reviewer" };
type Owner = OverviewDomains[keyof OverviewDomains];
const provenance = z.object({ synthetic: z.boolean(), provenance: z.object({ observedAt: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }).optional() }),
  readAccess: z.object({ validUntil: z.string().datetime({ offset: true }) }).optional() });
const unavailable = (reason: Owner["reason"] = "SOURCE_UNAVAILABLE"): Owner => ({ state: reason === "REPORTING_SCOPE_MISMATCH" ? "mismatch" : "unavailable", reason,
  data: null, version: null, observedAt: null, validUntil: null, synthetic: null });
const contextMatches = (a: {startAt:string;endAt:string;timezone:string}, b: {startAt:string;endAt:string;timezone:string}) =>
  Date.parse(a.startAt) === Date.parse(b.startAt) && Date.parse(a.endAt) === Date.parse(b.endAt) && a.timezone === b.timezone;
const firstDeadline = (...values: (string | null | undefined)[]) => {
  const deadlines = values.filter((value): value is string => !!value).map(Date.parse);
  return deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
};

/** Compose the exact readers used by the detail screens. No second ledger,
 * provider call, source mutation, or independently calculated creator score. */
export async function composeOverviewOwners(base: NativeAnalyticsReadResult, readers: Readers, principal: Principal,
  caller: { assertCurrent(): void; signal?: AbortSignal }): Promise<NativeAnalyticsReadResult> {
  if (base.data.viewKey !== "overviewSummary") return base;
  const overview = base.data, period = overview.period;
  const rawDomains = { creators: unavailable(), operations: unavailable(), finance: unavailable(), activity: unavailable(), portfolio: unavailable() };
  const fences: (() => void)[] = [base.assertCurrent, caller.assertCurrent];
  const finish = () => {
    const domains = overviewDomainsSchema.parse(rawDomains);
    const complete = Object.values(domains).every(owner => owner.state === "ready" && owner.data !== null);
    const deadlines = Object.values(domains).flatMap(owner => owner.validUntil ? [Date.parse(owner.validUntil)] : []);
    const validUntil = new Date(Math.min(Date.parse(overview.provenance.validUntil), ...deadlines)).toISOString();
    const data = { ...overview, domains, provenance: { ...overview.provenance, validUntil } };
    const missing = Object.values(domains).filter(owner => owner.state !== "ready" || owner.data === null).length;
    const assertCurrent = () => { for (const fence of fences) fence(); };
    assertCurrent();
    return { ...base, data, version: `overview-v1-${digest([base.version, domains])}`, assertCurrent,
      dataState: base.dataState === "stale" ? "stale" as const : !complete || base.dataState === "partial" ? "partial" as const : "ready" as const,
      coverage: { ...base.coverage, complete: base.coverage.complete && complete, expectedCount: base.coverage.expectedCount + 5,
        observedCount: base.coverage.observedCount + 5 - missing, missingCount: base.coverage.missingCount + missing,
        reasonCodes: [...base.coverage.reasonCodes, ...(missing ? ["OVERVIEW_OWNER_COVERAGE_PARTIAL"] : [])] } };
  };
  if (!period) {
    for (const key of Object.keys(rawDomains) as (keyof OverviewDomains)[]) rawDomains[key] = unavailable("REPORTING_SCOPE_MISSING");
    return finish();
  }
  caller.assertCurrent();
  const filters = { startAt: period.startAt, endAt: period.endAt, timezone: period.timezone };
  const check = (owner: keyof OverviewDomains, fn: () => Promise<Owner>) => fn().then(value => { rawDomains[owner] = value; }).catch((error: unknown) => {
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    // A lost grant or changed original read cannot become an innocuous missing tile.
    if (status === 401 || status === 403) throw new NativeAnalyticsError("ANALYTICS_SOURCE_DENIED", status);
    if (status === 409) throw new NativeAnalyticsError("ANALYTICS_SOURCE_CHANGED", 409);
    if (status === 499 || caller.signal?.aborted) throw new NativeAnalyticsError("ANALYTICS_REQUEST_CANCELLED", 499);
    rawDomains[owner] = unavailable(status === 502 || error instanceof z.ZodError ? "SOURCE_INVALID" : "SOURCE_UNAVAILABLE");
  });
  const results = await Promise.allSettled([
    check("portfolio", async () => {
      const binding = base.sourceContext.portfolio;
      if (!binding) return unavailable();
      const saved = readers.portfolio.latest(binding.reviewKey);
      if (!saved || saved.reviewHash !== binding.reviewHash) return unavailable("REPORTING_SCOPE_MISMATCH");
      const packet = portfolioPacketSchema.parse(saved.packet);
      if (packet.campaignId !== base.sourceContext.cohortRef || packet.currency !== "USD" ||
        Date.parse(packet.reviewWindow.start) !== Date.parse(period.startAt) || Date.parse(packet.reviewWindow.end) !== Date.parse(period.endAt) ||
        !saved.sourceEvidence || (saved.sourceEvidence.mode === "reviewer-sandbox") !== overview.provenance.synthetic) return unavailable("REPORTING_SCOPE_MISMATCH");
      // Use the existing owner's review algorithm and exact stored revision, without new scoring rules.
      const review = reviewPortfolio(packet, saved.reviewKey);
      if (digest(review) !== digest(saved.proposal)) return unavailable("SOURCE_INVALID");
      fences.push(() => { if (readers.portfolio.latest(binding.reviewKey)?.reviewHash !== saved.reviewHash) throw new NativeAnalyticsError("ANALYTICS_SOURCE_CHANGED", 409); });
      const comparable = packet.creators.flatMap(creator => {
        const rec = review.recommendations.find(row => row.creatorId === creator.creatorId);
        return creator.collaborations.filter(c => rec?.comparableCollaborationIds.includes(c.collaborationId));
      });
      const mature = comparable.length > 0 && comparable.every(c => c.retainedContribution.maturity === "mature" && c.retainedContribution.cents.value !== null);
      const cents = mature ? comparable.reduce((sum,c) => sum + BigInt(c.retainedContribution.cents.value!), 0n) : null;
      const contribution = cents !== null && cents <= BigInt(Number.MAX_SAFE_INTEGER) && cents >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(cents) : null;
      const alias = readers.analytics.publicRef;
      return { state: binding.sourceCurrent ? "ready" : "stale", reason: binding.sourceCurrent ? null : "SOURCE_STALE",
        version: alias("version", saved.reviewHash), observedAt: overview.provenance.observedAt, validUntil: binding.validUntil, synthetic: overview.provenance.synthetic,
        data: { reviewRef: alias("review", saved.reviewKey), reviewVersion: alias("version", saved.reviewHash), objective: packet.objective, period,
          creators: review.recommendations.length, verifiedPublications: new Set(packet.creators.flatMap(c => c.collaborations
            .filter(collaboration => collaboration.campaignId === packet.campaignId).flatMap(collaboration => collaboration.posts
              .filter(post => Date.parse(post.publishedAt) >= Date.parse(period.startAt) && Date.parse(post.publishedAt) < Date.parse(period.endAt))
              .map(post => post.postId)))).size,
          matureRetainedContribution: contribution === null ? null : { minorUnits: contribution, currency: "USD" as const },
          immatureCollaborations: comparable.filter(c => c.retainedContribution.maturity !== "mature").length,
          dimensions: (["reliable-content-producer", "retained-sales-performer", "paid-creative-performer", "repeat-partner"] as const).map(dimension => ({ dimension, creators: review.recommendations.filter(c => c.segments.includes(dimension)).length })),
          recommendations: review.recommendations.map(rec => ({ creatorRef: alias("creator", rec.creatorId), action: rec.action, nextReviewAt: rec.nextReviewAt, outstandingObligations: rec.outstandingObligationRefs.length, uncertainty: rec.uncertainty })) } };
    }),
    check("creators", async () => {
      const read = await readers.analytics.read({ viewKey: "attribution", filters: {}, period, sort: [], page: { cursor: null, limit: 100 } }, principal, caller.signal);
      fences.push(read.assertCurrent);
      const d = nativeAttributionSchema.parse(read.data);
      if (!d.cohortRef || d.cohortRef !== overview.cohortRef || d.provenance.synthetic !== overview.provenance.synthetic || !d.period || !contextMatches(d.period, period)) return unavailable("REPORTING_SCOPE_MISMATCH");
      if (digest([d.orders.value, d.netReceipts.value, d.attributedOrders.value, d.attributedNetSales.value]) !== digest([overview.orders.value, overview.netReceipts.value, overview.attributedOrders.value, overview.attributedNetSales.value])) return unavailable("REPORTING_SCOPE_MISMATCH");
      return { state: read.dataState, reason: read.dataState === "ready" ? null : read.dataState === "stale" ? "SOURCE_STALE" : "COVERAGE_PARTIAL",
        version: read.version, observedAt: d.provenance.observedAt, validUntil: d.provenance.validUntil, synthetic: d.provenance.synthetic,
        data: { attributedOrders: d.attributedOrders, attributedNetSales: d.attributedNetSales, roi: d.creators,
          cohortRef: d.cohortRef, period: d.period, costCoverage: d.economicEvidence?.coverage ?? "missing", retention: d.economicEvidence?.retention ?? "unknown", landedCost: d.economicEvidence?.landedCost ?? "unknown" } };
    }),
    check("operations", async () => {
      const read = await readers.operations.read("operationsOverview", { ...filters, home: "all" }, principal, caller.signal);
      fences.push(read.assertCurrent);
      if (!read.data) return unavailable();
      const meta = provenance.parse(read.data), scope = operationsReportingScopeSchema.parse((read.data as { reportingScope?: unknown }).reportingScope);
      if (!contextMatches(scope, period) || scope.home !== "all" || meta.synthetic !== overview.provenance.synthetic) return unavailable("REPORTING_SCOPE_MISMATCH");
      const d = operationsOverviewSchema.innerType().omit({ datasetKey: true }).parse(read.data);
      const shipping = await readers.operations.read("operationsShipping", { ...filters, home: "all" }, principal, caller.signal);
      fences.push(shipping.assertCurrent);
      let shipments: number | null = null;
      const deadlines = [meta.provenance.validUntil, meta.readAccess?.validUntil].filter((value): value is string => !!value);
      if (shipping.data) {
        const shippingMeta = provenance.parse(shipping.data), shippingScope = operationsReportingScopeSchema.parse((shipping.data as { reportingScope?: unknown }).reportingScope);
        deadlines.push(...[shippingMeta.provenance.validUntil, shippingMeta.readAccess?.validUntil].filter((value): value is string => !!value));
        // Count the canonical full set, never only a returned partial page.
        if (!contextMatches(shippingScope, scope) || shippingScope.home !== scope.home || shippingScope.basis !== scope.basis || shippingMeta.synthetic !== meta.synthetic) return unavailable("REPORTING_SCOPE_MISMATCH");
        const rows = z.object({ shipments: z.array(z.object({ ref: z.string() })) }).parse(shipping.data);
        if (shipping.coverage.complete && shipping.dataState === "ready") shipments = rows.shipments.length;
      }
      const state = read.dataState === "stale" || shipping.dataState === "stale" ? "stale" : read.coverage.complete && shipping.coverage.complete && shipments !== null ? "ready" : "partial";
      return { state, reason: state === "ready" ? null : state === "stale" ? "SOURCE_STALE" : "COVERAGE_PARTIAL",
        version: digest([read.version, shipping.version]), observedAt: meta.provenance.observedAt, validUntil: deadlines.length ? new Date(Math.min(...deadlines.map(Date.parse))).toISOString() : null, synthetic: meta.synthetic,
        data: { scope, summaryBasis: operationsSummaryBasisSchema.nullable().parse((read.data as { summaryBasis?: unknown }).summaryBasis ?? null),
          shipments, toShip: d.all.toShip, openIssues: d.openIssues, timeToShipDays: d.all.timeToShipDays, shippingCostPerOrder: d.health.shippingCostPerOrder } };
    }),
    check("finance", async () => {
      const read = await readers.finance.read("financeDashboard", filters, principal, caller.signal);
      fences.push(read.assertCurrent);
      if (!read.data) return unavailable();
      const d = financeDashboardSchema.omit({ datasetKey: true }).parse(read.data), meta = provenance.parse(read.data), context = d.summaryContext;
      if (!context || !contextMatches(context.period, period) || meta.synthetic !== overview.provenance.synthetic) return unavailable("REPORTING_SCOPE_MISMATCH");
      const h = financeHeadlines(d), state = read.dataState === "stale" ? "stale" : read.coverage.complete && context.policy.state === "adopted" ? "ready" : "partial";
      return { state, reason: state === "stale" ? "SOURCE_STALE" : context.policy.state !== "adopted" ? "DEFINITION_UNAPPROVED" : state === "partial" ? "COVERAGE_PARTIAL" : null,
        version: read.version, observedAt: meta.provenance.observedAt, validUntil: firstDeadline(meta.readAccess?.validUntil, read.freshUntil), synthetic: meta.synthetic, data: { context, ...h } };
    }),
    check("activity", async () => {
      if (!base.sourceContext.cohortRef) return unavailable("REPORTING_SCOPE_MISSING");
      const campaign = readers.monitor.publicCampaignRef(base.sourceContext.cohortRef);
      const read = await readers.monitor.read("contentMonitor", { source: "all", network: "all", window: "last-30", q: "", campaign, reportingPeriod: period },
        { cursor: null, limit: 100, authorizationContext: principal.role }, caller);
      fences.push(read.assertCurrent);
      const d = nativeContentSchema.parse(read.data);
      if (d.synthetic !== overview.provenance.synthetic) return unavailable("REPORTING_SCOPE_MISMATCH");
      if (d.selection?.campaign !== campaign || !d.selection.period || !contextMatches(d.selection.period, period)) return unavailable("REPORTING_SCOPE_MISMATCH");
      // The full monitor response was strictly validated above. Select only the
      // summary fields; its post rows and access grant are not overview fields.
      const data = overviewDomainsSchema.shape.activity.shape.data.unwrap().parse({
        kind: d.kind, sourceState: d.sourceState, sourceAsOf: d.sourceAsOf, observedAt: d.observedAt, sourceVersion: d.sourceVersion,
        membershipComplete: d.membershipComplete, total: d.total, views: d.views, rate: d.rate, orders: d.orders, net: d.net,
        metricBasis: d.metricBasis, selection: d.selection, liveCount: d.liveCount, networkCoverage: d.networkCoverage, window: d.window,
      });
      const state = read.stale ? "stale" : d.sourceState === "current" && d.membershipComplete ? "ready" : "partial";
      return { state, reason: state === "stale" ? "SOURCE_STALE" : state === "partial" ? "COVERAGE_PARTIAL" : null,
        version: d.sourceVersion, observedAt: d.observedAt, validUntil: firstDeadline(d.readAccess?.validUntil, read.freshUntil), synthetic: d.synthetic, data };
    }),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return finish();
}
