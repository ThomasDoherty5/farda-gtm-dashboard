import { z } from "zod";
import { approvalScopeSchema, principalSchema } from "../approvals/contract.ts";

// Source adapters translate private identifiers to opaque evidence identities before this boundary.
export const trafficRefSchema = z.string().regex(/^ref:[a-f0-9]{64}$/);
export const trafficHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const trafficInstantSchema = z.string().datetime({ offset: true });
export const trafficCountSchema = z.number().int().nonnegative().safe();
export const trafficReasonSchema = z.enum(["SOURCE_UNCONFIGURED", "ACCESS_UNSUPPORTED", "REPORT_UNAVAILABLE", "WINDOW_UNQUALIFIED", "IMPORT_PENDING", "PARTIAL_COVERAGE", "MISSING_DAY", "SOURCE_STALE", "COUNTER_UNAVAILABLE", "ZERO_DENOMINATOR", "ORDERS_UNAVAILABLE", "ORDER_COHORT_MISMATCH", "CLICKS_UNAVAILABLE", "CLICK_WINDOW_MISMATCH", "TRACKING_BLOCKED", "UTM_ABSENT", "SEGMENT_UNAVAILABLE", "COMPARISON_INCOMPLETE"]);
export const trafficTimezoneSchema = z.string().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; } catch { return false; }
}, "A qualified IANA timezone is required.");
export const trafficDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const stamp = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}, "Invalid calendar day.");
export function nextTrafficDay(day: string): string { const stamp = Date.parse(day + "T00:00:00Z"); return Number.isFinite(stamp) ? new Date(stamp + 86_400_000).toISOString().slice(0, 10) : ""; }
export function trafficDays(start: string, end: string): string[] {
  const result: string[] = [];
  if (!trafficDaySchema.safeParse(start).success || !trafficDaySchema.safeParse(end).success) return result;
  for (let day = start; day < end && result.length <= 366; day = nextTrafficDay(day)) result.push(day);
  return result;
}
export const trafficPeriodSchema = z.object({ startDay: trafficDaySchema, endDayExclusive: trafficDaySchema, timezone: trafficTimezoneSchema }).strict().refine(
  value => value.startDay < value.endDayExclusive && trafficDays(value.startDay, value.endDayExclusive).length <= 366, "A bounded, nonempty source-calendar window is required.");
function localBoundary(value: string, day: string, timezone: string): boolean {
  if (!Number.isFinite(Date.parse(value)) || !trafficTimezoneSchema.safeParse(timezone).success) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(Date.parse(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}` === day && parts.hour === "00" && parts.minute === "00" && parts.second === "00" && Date.parse(value) % 1000 === 0;
}
export const trafficWindowSchema = z.object({ startDay: trafficDaySchema, endDayExclusive: trafficDaySchema, timezone: trafficTimezoneSchema, startAt: trafficInstantSchema, endAt: trafficInstantSchema }).strict().superRefine((value, ctx) => {
  if (!trafficPeriodSchema.safeParse({ startDay: value.startDay, endDayExclusive: value.endDayExclusive, timezone: value.timezone }).success ||
      !localBoundary(value.startAt, value.startDay, value.timezone) || !localBoundary(value.endAt, value.endDayExclusive, value.timezone) || Date.parse(value.endAt) <= Date.parse(value.startAt))
    ctx.addIssue({ code: "custom", message: "Window instants must match the qualified source calendar, including daylight-saving boundaries." });
});
export const trafficChannelSchema = z.enum(["creator", "paidSocial", "organicSocial", "paidSearch", "organicSearch", "direct", "email", "referral", "unattributed"]);
export const trafficSegmentSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("all") }).strict(), z.object({ kind: z.literal("utm"), key: trafficHashSchema, channel: trafficChannelSchema, campaign: z.enum(["campaign", "none", "unknown"]) }).strict()]);
export const trafficFiltersSchema = z.object({ period: trafficPeriodSchema.nullable(), segment: z.discriminatedUnion("kind", [z.object({ kind: z.literal("all") }).strict(), z.object({ kind: z.literal("utm"), segmentRef: z.string().regex(/^traffic-segment-[a-f0-9]{64}$/) }).strict()]) }).strict();
export const trafficImportRequestSchema = z.object({ importRef: trafficRefSchema, requestKey: trafficRefSchema, expectedDefinitionVersion: trafficHashSchema }).strict();
export const trafficImportPrincipalSchema = z.object({ principalRef: principalSchema.shape.principalRef, kind: z.literal("machine"), bindingRef: trafficRefSchema, grantVersion: trafficHashSchema }).strict();
export const trafficRequestSchema = z.discriminatedUnion("operation", [z.object({ operation: z.literal("read"), filters: trafficFiltersSchema }).strict(), z.object({ operation: z.literal("import"), input: trafficImportRequestSchema }).strict()]);
export const trafficBindingSchema = z.object({ scope: approvalScopeSchema, principal: z.union([principalSchema, trafficImportPrincipalSchema]), request: trafficRequestSchema }).strict();
export const trafficProvenanceSchema = z.object({ evidenceStage: z.enum(["synthetic", "source"]), synthetic: z.boolean(), qualificationRef: trafficRefSchema }).strict().refine(value => value.synthetic === (value.evidenceStage === "synthetic"), "Evidence stage must be explicit.");
export const trafficAuthoritySchema = z.object({ binding: trafficBindingSchema, permissionVersion: trafficHashSchema, sourceVersion: trafficHashSchema, observedAt: trafficInstantSchema, validUntil: trafficInstantSchema, provenance: trafficProvenanceSchema }).strict();
export const trafficCounterDefinitionsSchema = z.object({ sessions: z.literal("sessions"), cartSessions: z.literal("sessions_with_cart_additions"), checkoutSessions: z.literal("sessions_that_reached_checkout"), completedCheckoutSessions: z.literal("sessions_that_completed_checkout"), sessionUnit: z.literal("uniqueSessions"), eventUnit: z.literal("events") }).strict();
export const trafficDefinitionSchema = z.object({ definitionRef: trafficRefSchema, version: trafficHashSchema, provider: z.literal("shopifyAnalytics"), sourceAccountRef: trafficRefSchema,
  transport: z.enum(["api", "reportExport"]), reportRef: trafficRefSchema, reportVersion: trafficHashSchema, timezone: trafficTimezoneSchema, measurementVersion: trafficHashSchema, filterHash: trafficHashSchema,
  botFilter: z.enum(["excluded", "included"]), dailyAggregation: z.literal("sourceQualifiedAdditiveDailyCounts"), sessionCohortRef: trafficRefSchema,
  freshnessMaxAgeMs: z.number().int().min(1).max(31 * 86_400_000),
  counters: trafficCounterDefinitionsSchema,
  segments: z.array(trafficSegmentSchema).max(100),
}).strict().superRefine((value, ctx) => {
  const keys = value.segments.map(segment => segment.kind === "all" ? "all" : segment.key);
  if (new Set(keys).size !== keys.length || !keys.includes("all")) ctx.addIssue({ code: "custom", message: "A unique approved segment taxonomy including all traffic is required." });
});
export const trafficCapabilitySchema = z.object({ authority: trafficAuthoritySchema, state: z.enum(["ready", "unsupported", "unconfigured"]), canImport: z.boolean(), definition: trafficDefinitionSchema.nullable(), currentWindow: trafficWindowSchema.nullable(), reasonCodes: z.array(trafficReasonSchema).max(12) }).strict().superRefine((value, ctx) => {
  if (value.state === "ready" && value.definition === null || value.state !== "ready" && value.canImport || value.currentWindow && value.definition?.timezone !== value.currentWindow.timezone)
    ctx.addIssue({ code: "custom", message: "Capability, import permission and source calendar must agree." });
  if (value.state === "unconfigured" && (value.definition !== null || value.currentWindow !== null)) ctx.addIssue({ code: "custom", message: "Unconfigured source account/calendar remain unknown." });
});
export const trafficCountersSchema = z.object({ sessions: trafficCountSchema.nullable(), cartSessions: trafficCountSchema.nullable(), checkoutSessions: trafficCountSchema.nullable(), completedCheckoutSessions: trafficCountSchema.nullable(), productViewEvents: trafficCountSchema.nullable(), cartAddEvents: trafficCountSchema.nullable() }).strict().superRefine((value, ctx) => {
  for (const key of ["cartSessions", "checkoutSessions", "completedCheckoutSessions"] as const) if (value.sessions !== null && value[key] !== null && value[key]! > value.sessions) ctx.addIssue({ code: "custom", message: "A unique-session subset exceeds its declared session cohort." });
  if (value.checkoutSessions !== null && value.completedCheckoutSessions !== null && value.completedCheckoutSessions > value.checkoutSessions) ctx.addIssue({ code: "custom", message: "Completed-checkout sessions exceed the same checkout cohort." });
  // Product views and repeated add-to-cart events are not session-funnel subsets.
});
export const trafficPartitionSchema = z.object({ day: trafficDaySchema, startAt: trafficInstantSchema, endAt: trafficInstantSchema, revision: z.number().int().positive().safe(), coverage: z.enum(["complete", "partial"]),
  observedThrough: trafficInstantSchema, replaceSegments: z.boolean(), sourceAsOf: trafficInstantSchema, sessionCohortRef: trafficRefSchema,
  rows: z.array(z.object({ segment: trafficSegmentSchema, counters: trafficCountersSchema }).strict()).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const keys = value.rows.map(row => row.segment.kind === "all" ? "all" : row.segment.key);
  if (new Set(keys).size !== keys.length || value.replaceSegments && value.coverage !== "complete" || Date.parse(value.observedThrough) <= Date.parse(value.startAt) || Date.parse(value.observedThrough) > Date.parse(value.endAt) || Date.parse(value.sourceAsOf) < Date.parse(value.observedThrough) || value.coverage === "complete" && Date.parse(value.observedThrough) !== Date.parse(value.endAt))
    ctx.addIssue({ code: "custom", message: "Partition coverage must be explicit and internally consistent." });
});
export const trafficReportSchema = z.object({ schemaVersion: z.literal("shopify-traffic-normalized.v1"), definition: trafficDefinitionSchema, partitions: z.array(trafficPartitionSchema).min(1).max(366) }).strict().superRefine((value, ctx) => {
  const days = value.partitions.map(partition => partition.day);
  if (new Set(days).size !== days.length) ctx.addIssue({ code: "custom", message: "Duplicate source days are ambiguous." });
  const segments = new Map(value.definition.segments.map(segment => [segment.kind === "all" ? "all" : segment.key, JSON.stringify(segment)]));
  for (const partition of value.partitions) {
    if (!trafficWindowSchema.safeParse({ startDay: partition.day, endDayExclusive: nextTrafficDay(partition.day), timezone: value.definition.timezone, startAt: partition.startAt, endAt: partition.endAt }).success || partition.sessionCohortRef !== value.definition.sessionCohortRef)
      ctx.addIssue({ code: "custom", message: "A source day and its counter cohort must match the report definition." });
    for (const row of partition.rows) if (segments.get(row.segment.kind === "all" ? "all" : row.segment.key) !== JSON.stringify(row.segment)) ctx.addIssue({ code: "custom", message: "Unapproved or inconsistent UTM taxonomy." });
  }
});
export const trafficReportEnvelopeSchema = z.object({ authority: trafficAuthoritySchema, importRef: trafficRefSchema, format: z.literal("normalized-json-v1"), body: z.string().min(1).max(1_000_000) }).strict();
export const trafficAggregateBindingSchema = z.object({ binding: trafficBindingSchema, definitionRef: trafficRefSchema, definitionVersion: trafficHashSchema, sourceAccountRef: trafficRefSchema, window: trafficWindowSchema, segment: trafficSegmentSchema, coverageThrough: trafficInstantSchema.nullable() }).strict();
export const trafficOrderAggregateSchema = z.object({ authority: trafficAuthoritySchema, request: trafficAggregateBindingSchema, origin: z.literal("shopifyStorefrontOrigin"), excludedOrigins: z.tuple([z.literal("tiktokShop"), z.literal("tiktokMirrors")]), count: trafficCountSchema, coverageThrough: trafficInstantSchema, coverage: z.enum(["complete", "partial"]) }).strict();
export const trafficClickAggregateSchema = z.object({ authority: trafficAuthoritySchema, request: trafficAggregateBindingSchema, measure: z.literal("creatorTrackedClicks"), count: trafficCountSchema.nullable(), coverage: z.enum(["complete", "partial", "unknown"]), attribution: z.enum(["sourceApprovedUtm", "allTraffic", "unattributed", "blocked"]), sourceAsOf: trafficInstantSchema, reasonCodes: z.array(trafficReasonSchema).max(12) }).strict();

export type TrafficFilters = z.infer<typeof trafficFiltersSchema>;
export type TrafficImportRequest = z.infer<typeof trafficImportRequestSchema>;
export type TrafficImportPrincipal = z.infer<typeof trafficImportPrincipalSchema>;
export type TrafficBinding = z.infer<typeof trafficBindingSchema>;
export type TrafficAuthority = z.infer<typeof trafficAuthoritySchema>;
export type TrafficDefinition = z.infer<typeof trafficDefinitionSchema>;
export type TrafficCapability = z.infer<typeof trafficCapabilitySchema>;
export type TrafficSegment = z.infer<typeof trafficSegmentSchema>;
export type TrafficCounters = z.infer<typeof trafficCountersSchema>;
export type TrafficPartition = z.infer<typeof trafficPartitionSchema>;
export type TrafficReport = z.infer<typeof trafficReportSchema>;
export type TrafficReportEnvelope = z.infer<typeof trafficReportEnvelopeSchema>;
export type TrafficWindow = z.infer<typeof trafficWindowSchema>;
export type TrafficAggregateBinding = z.infer<typeof trafficAggregateBindingSchema>;
export type TrafficOrderAggregate = z.infer<typeof trafficOrderAggregateSchema>;
export type TrafficClickAggregate = z.infer<typeof trafficClickAggregateSchema>;
