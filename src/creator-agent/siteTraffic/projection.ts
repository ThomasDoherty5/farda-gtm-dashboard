import type { z } from "zod";
import { trafficDays, type TrafficCapability, type TrafficClickAggregate, type TrafficCounters, type TrafficOrderAggregate, type TrafficSegment, type TrafficWindow, type trafficReasonSchema } from "./contract.ts";
import { trafficSegmentKey, type TrafficStoredPartition, type TrafficStoredRow } from "./repository.ts";
import { nativeSiteTrafficViewSchema, trafficImportSummarySchema, type NativeSiteTrafficView, type TrafficCountView, type TrafficImportReceipt, type TrafficPublicSegment, type TrafficRateView } from "./views.ts";

type Reason = z.infer<typeof trafficReasonSchema>;
export type TrafficAlias = (kind: string, value: string) => string;
export const unknownTrafficCount = (reason: Reason): TrafficCountView => ({ state: "unknown", value: null, provisional: false, reasonCodes: [reason] });
export function publicTrafficSegment(segment: TrafficSegment, alias: TrafficAlias): TrafficPublicSegment {
  return { segmentRef: alias("segment", trafficSegmentKey(segment)), kind: segment.kind, channel: segment.kind === "utm" ? segment.channel : null, campaign: segment.kind === "utm" ? segment.campaign : null };
}
export function selectTrafficRows(partitions: TrafficStoredPartition[], segment: TrafficSegment): TrafficStoredRow[] {
  return partitions.flatMap(({ partition, importedAt, rows }) => {
    const row = rows.find(candidate => trafficSegmentKey(candidate.segment) === trafficSegmentKey(segment));
    if (row) return [row];
    // Only an explicit complete segment replacement establishes an absent segment's zero population.
    if (partition.coverage !== "complete" || !partition.replaceSegments) return [];
    return [{ segment, counters: { sessions: 0, cartSessions: 0, checkoutSessions: 0, completedCheckoutSessions: 0, productViewEvents: 0, cartAddEvents: 0 }, day: partition.day, revision: partition.revision,
      coverage: partition.coverage, observedThrough: partition.observedThrough, sourceAsOf: partition.sourceAsOf, importedAt, startAt: partition.startAt, endAt: partition.endAt }];
  });
}
/** Comparison is qualified only for one contiguous observed prefix of the exact requested source-calendar window. */
export function trafficCoverageThrough(window: TrafficWindow, partitions: TrafficStoredPartition[], rows: TrafficStoredRow[]): string | null {
  const days = trafficDays(window.startDay, window.endDayExclusive);
  if (rows.length !== days.length) return null;
  for (let index = 0; index < days.length; index++) {
    const row = rows.find(value => value.day === days[index]), partition = partitions.find(value => value.partition.day === days[index])?.partition;
    if (!row || !partition || row.revision !== partition.revision || index < days.length - 1 && (row.coverage !== "complete" || partition.coverage !== "complete")) return null;
  }
  return rows.find(row => row.day === days.at(-1))?.observedThrough ?? null;
}
function rate(numerator: TrafficCountView, denominator: TrafficCountView, numeratorLabel: TrafficRateView["numeratorLabel"], denominatorLabel: TrafficRateView["denominatorLabel"], stale: boolean): TrafficRateView {
  const base = { numerator: numerator.value, denominator: denominator.value, numeratorLabel, denominatorLabel, provisional: numerator.provisional || denominator.provisional };
  if (stale || numerator.value === null || denominator.value === null) return { ...base, state: "unknown", percent: null, reasonCodes: stale ? ["SOURCE_STALE"] : [...new Set([...numerator.reasonCodes, ...denominator.reasonCodes])] };
  if (denominator.value === 0) return { ...base, state: "notApplicable", percent: null, reasonCodes: ["ZERO_DENOMINATOR"] };
  return { ...base, state: "known", percent: numerator.value / denominator.value * 100, reasonCodes: base.provisional ? ["COMPARISON_INCOMPLETE"] : [] };
}
export function projectSiteTraffic(input: { capability: TrafficCapability | null; window: TrafficWindow | null; segment: TrafficSegment | null; partitions: TrafficStoredPartition[]; orders: TrafficOrderAggregate | null; clicks: TrafficClickAggregate | null;
  orderReason?: Reason; clickReason?: Reason; latest: TrafficImportReceipt | null; firstActual: TrafficImportReceipt | null; alias: TrafficAlias; now: number }): NativeSiteTrafficView {
  const { capability, window, segment, partitions, alias } = input, definition = capability?.definition ?? null;
  const rows = segment ? selectTrafficRows(partitions, segment) : [], expectedDays = window ? trafficDays(window.startDay, window.endDayExclusive).length : null;
  const allPresent = expectedDays !== null && expectedDays === rows.length;
  const complete = allPresent && rows.every(row => row.coverage === "complete" && partitions.some(item => item.partition.day === row.day && item.partition.coverage === "complete" && item.partition.revision === row.revision));
  const stamps = rows.map(row => Date.parse(row.sourceAsOf)), stale = definition !== null && stamps.some(stamp => input.now - stamp >= definition.freshnessMaxAgeMs);
  const provisional = !complete || stale;
  const missingReason: Reason = !capability ? "SOURCE_UNCONFIGURED" : !window ? "WINDOW_UNQUALIFIED" : rows.length === 0 ? "IMPORT_PENDING" : "MISSING_DAY";
  const counter = (name: keyof TrafficCounters): TrafficCountView => {
    if (!allPresent) return unknownTrafficCount(missingReason);
    if (rows.some(row => row.counters[name] === null)) return unknownTrafficCount("COUNTER_UNAVAILABLE");
    const total = rows.reduce((sum, row) => sum + BigInt(row.counters[name]!), 0n);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) return unknownTrafficCount("COUNTER_UNAVAILABLE");
    return { state: "known", value: Number(total), provisional, reasonCodes: stale ? ["SOURCE_STALE"] : !complete ? ["PARTIAL_COVERAGE"] : [] };
  };
  const sessions = counter("sessions"), completed = counter("completedCheckoutSessions");
  const orders: TrafficCountView = input.orders ? { state: "known", value: input.orders.count, provisional: provisional || input.orders.coverage !== "complete", reasonCodes: input.orders.coverage !== "complete" ? ["PARTIAL_COVERAGE"] : [] } : unknownTrafficCount(input.orderReason ?? "ORDERS_UNAVAILABLE");
  const clicks = input.clicks, clickCount: TrafficCountView = clicks?.count === null || !clicks ? unknownTrafficCount(input.clickReason ?? "CLICKS_UNAVAILABLE") : { state: "known", value: clicks.count, provisional: clicks.coverage !== "complete", reasonCodes: clicks.reasonCodes };
  const matchedClicks = clicks !== null && clicks.count !== null && clicks.request.coverageThrough !== null && (segment?.kind === "all" ? clicks.attribution === "allTraffic" : clicks.attribution === "sourceApprovedUtm");
  const measures = { sessions, cartSessions: counter("cartSessions"), checkoutSessions: counter("checkoutSessions"), completedCheckoutSessions: completed, convertedSessions: completed, productViewEvents: counter("productViewEvents"), cartAddEvents: counter("cartAddEvents"), shopifyOrders: orders };
  const data: NativeSiteTrafficView = {
    datasetKey: "site-traffic-native", provenance: capability ? { evidenceStage: capability.authority.provenance.evidenceStage, synthetic: capability.authority.provenance.synthetic, sourceVersion: capability.authority.sourceVersion, observedAt: capability.authority.observedAt, validUntil: capability.authority.validUntil } : { evidenceStage: "unconfigured", synthetic: null, sourceVersion: null, observedAt: null, validUntil: null },
    capability: { state: capability?.state ?? "unconfigured", accountRef: definition ? alias("account", definition.sourceAccountRef) : null, timezone: definition?.timezone ?? null, transport: definition?.transport ?? null,
      reasonCodes: capability?.reasonCodes ?? ["SOURCE_UNCONFIGURED"], definition: definition ? { definitionRef: alias("definition", definition.definitionRef), version: definition.version, provider: "Shopify Analytics", accountRef: alias("account", definition.sourceAccountRef), transport: definition.transport,
        timezone: definition.timezone, reportRef: alias("report", definition.reportRef), reportVersion: definition.reportVersion, measurementVersion: definition.measurementVersion, filterHash: definition.filterHash, botFilter: definition.botFilter, dailyAggregation: definition.dailyAggregation, freshnessMaxAgeMs: definition.freshnessMaxAgeMs, counterIds: definition.counters,
        sessionDefinition: "Provider unique-session counters in one declared cohort", eventDefinition: "Repeated events; never substituted for session denominators", storeOrderDefinition: "Shopify storefront-origin orders divided by matching storefront sessions", excludedOrderOrigins: ["TikTok Shop", "TikTok-origin Shopify mirrors"],
        cartDefinition: "Sessions with cart additions divided by storefront sessions", checkoutDefinition: "Sessions completing checkout divided by sessions reaching checkout", providerConversionDefinition: "Converted sessions divided by storefront sessions; separate from the store-order ratio" } : null },
    period: window, selectedSegment: segment ? publicTrafficSegment(segment, alias) : null, segments: definition?.segments.map(value => publicTrafficSegment(value, alias)) ?? [],
    coverage: { state: complete ? "complete" : rows.length ? "partial" : "missing", expectedDays, observedDays: rows.length, observedThrough: window ? trafficCoverageThrough(window, partitions, rows) : null, reasonCodes: complete ? [] : [rows.length ? "PARTIAL_COVERAGE" : missingReason] },
    freshness: { state: !rows.length ? "unknown" : stale ? "stale" : "current", sourceAsOf: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null, importedAt: rows.length ? new Date(Math.max(...rows.map(row => Date.parse(row.importedAt)))).toISOString() : null, maxAgeMs: definition?.freshnessMaxAgeMs ?? null },
    measures, rates: { storeOrderConversion: rate(orders, sessions, "Shopify storefront orders", "Storefront sessions", stale), addToCart: rate(measures.cartSessions, sessions, "Sessions with cart additions", "Storefront sessions", stale),
      checkoutCompletion: rate(completed, measures.checkoutSessions, "Sessions completing checkout", "Sessions reaching checkout", stale), providerConversion: rate(completed, sessions, "Converted sessions", "Storefront sessions", stale) },
    clickComparison: { state: !matchedClicks || sessions.value === null || stale ? "unknown" : provisional || clicks?.coverage !== "complete" ? "provisional" : "comparable", creatorClicks: clickCount, storefrontSessions: sessions,
      measure: "Creator clicks and storefront sessions are different measures", attribution: clicks?.attribution ?? "unknown", sourceRef: clicks ? alias("clicks", clicks.authority.provenance.qualificationRef) : null, sourceAsOf: clicks?.sourceAsOf ?? null, period: clicks?.request.window ?? null,
      reasonCodes: !clicks ? [input.clickReason ?? "CLICKS_UNAVAILABLE"] : clicks.reasonCodes.length ? clicks.reasonCodes : !matchedClicks ? [clicks.attribution === "blocked" ? "TRACKING_BLOCKED" : clicks.attribution === "unattributed" ? "UTM_ABSENT" : "COMPARISON_INCOMPLETE"] : [] },
    days: rows.map(row => ({ day: row.day, segment: publicTrafficSegment(row.segment, alias), counters: row.counters, coverage: row.coverage === "complete" && partitions.some(item => item.partition.day === row.day && item.partition.revision === row.revision && item.partition.coverage === "complete") ? "complete" : "partial", observedThrough: row.observedThrough, sourceAsOf: row.sourceAsOf, importedAt: row.importedAt, revision: row.revision })),
    imports: { latest: input.latest ? trafficImportSummarySchema.strip().parse(input.latest) : null, firstActualImport: { state: input.firstActual ? "validated" : "pending", receipt: input.firstActual ? trafficImportSummarySchema.strip().parse(input.firstActual) : null } },
  };
  return nativeSiteTrafficViewSchema.parse(data);
}
