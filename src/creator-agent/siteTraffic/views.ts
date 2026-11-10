import { z } from "zod";
import { trafficChannelSchema, trafficCounterDefinitionsSchema, trafficCountSchema, trafficCountersSchema, trafficDaySchema, trafficHashSchema, trafficInstantSchema, trafficReasonSchema, trafficRefSchema, trafficWindowSchema, trafficTimezoneSchema } from "./contract.ts";

const publicRef = z.string().regex(/^traffic-[a-z]+-[a-f0-9]{64}$/);
export const trafficImportReceiptSchema = z.object({ receiptRef: publicRef, requestKey: trafficRefSchema, requestDigest: trafficHashSchema, definitionVersion: trafficHashSchema, reportDigest: trafficHashSchema,
  importedAt: trafficInstantSchema, sourceAsOf: trafficInstantSchema, evidenceStage: z.enum(["synthetic", "source"]), synthetic: z.boolean(), inserted: trafficCountSchema, replaced: trafficCountSchema, unchanged: trafficCountSchema, removed: trafficCountSchema, sourceEffect: z.literal("localAggregate") }).strict();
export const trafficImportSummarySchema = trafficImportReceiptSchema.omit({ requestKey: true, requestDigest: true, reportDigest: true, sourceEffect: true });
export const trafficCountViewSchema = z.object({ state: z.enum(["known", "unknown"]), value: trafficCountSchema.nullable(), provisional: z.boolean(), reasonCodes: z.array(trafficReasonSchema) }).strict().refine(value => (value.state === "known") === (value.value !== null));
export const trafficRateViewSchema = z.object({ state: z.enum(["known", "unknown", "notApplicable"]), percent: z.number().finite().nonnegative().nullable(), numerator: trafficCountSchema.nullable(), denominator: trafficCountSchema.nullable(), numeratorLabel: z.enum(["Shopify storefront orders", "Sessions with cart additions", "Sessions completing checkout", "Converted sessions"]), denominatorLabel: z.enum(["Storefront sessions", "Sessions reaching checkout"]), provisional: z.boolean(), reasonCodes: z.array(trafficReasonSchema) }).strict().refine(value => (value.state === "known") === (value.percent !== null));
export const trafficPublicSegmentSchema = z.object({ segmentRef: publicRef, kind: z.enum(["all", "utm"]), channel: trafficChannelSchema.nullable(), campaign: z.enum(["campaign", "none", "unknown"]).nullable() }).strict();
export const trafficDefinitionViewSchema = z.object({ definitionRef: publicRef, version: trafficHashSchema, provider: z.literal("Shopify Analytics"), accountRef: publicRef, transport: z.enum(["api", "reportExport"]), timezone: trafficTimezoneSchema,
  reportRef: publicRef, reportVersion: trafficHashSchema, measurementVersion: trafficHashSchema, filterHash: trafficHashSchema, botFilter: z.enum(["excluded", "included"]), dailyAggregation: z.literal("sourceQualifiedAdditiveDailyCounts"), freshnessMaxAgeMs: z.number().int().positive(),
  counterIds: trafficCounterDefinitionsSchema,
  sessionDefinition: z.literal("Provider unique-session counters in one declared cohort"), eventDefinition: z.literal("Repeated events; never substituted for session denominators"),
  storeOrderDefinition: z.literal("Shopify storefront-origin orders divided by matching storefront sessions"), excludedOrderOrigins: z.tuple([z.literal("TikTok Shop"), z.literal("TikTok-origin Shopify mirrors")]),
  cartDefinition: z.literal("Sessions with cart additions divided by storefront sessions"), checkoutDefinition: z.literal("Sessions completing checkout divided by sessions reaching checkout"), providerConversionDefinition: z.literal("Converted sessions divided by storefront sessions; separate from the store-order ratio"),
}).strict();
export const nativeSiteTrafficViewSchema = z.object({ datasetKey: z.literal("site-traffic-native"),
  provenance: z.object({ evidenceStage: z.enum(["unconfigured", "synthetic", "source"]), synthetic: z.boolean().nullable(), sourceVersion: trafficHashSchema.nullable(), observedAt: trafficInstantSchema.nullable(), validUntil: trafficInstantSchema.nullable() }).strict(),
  capability: z.object({ state: z.enum(["unconfigured", "unsupported", "ready"]), accountRef: publicRef.nullable(), timezone: trafficTimezoneSchema.nullable(), transport: z.enum(["api", "reportExport"]).nullable(), reasonCodes: z.array(trafficReasonSchema), definition: trafficDefinitionViewSchema.nullable() }).strict(),
  period: trafficWindowSchema.nullable(), selectedSegment: trafficPublicSegmentSchema.nullable(), segments: z.array(trafficPublicSegmentSchema).max(100),
  coverage: z.object({ state: z.enum(["missing", "partial", "complete"]), expectedDays: trafficCountSchema.nullable(), observedDays: trafficCountSchema, observedThrough: trafficInstantSchema.nullable(), reasonCodes: z.array(trafficReasonSchema) }).strict(),
  freshness: z.object({ state: z.enum(["unknown", "current", "stale"]), sourceAsOf: trafficInstantSchema.nullable(), importedAt: trafficInstantSchema.nullable(), maxAgeMs: z.number().int().positive().nullable() }).strict(),
  measures: z.object({ sessions: trafficCountViewSchema, cartSessions: trafficCountViewSchema, checkoutSessions: trafficCountViewSchema, completedCheckoutSessions: trafficCountViewSchema, convertedSessions: trafficCountViewSchema, productViewEvents: trafficCountViewSchema, cartAddEvents: trafficCountViewSchema, shopifyOrders: trafficCountViewSchema }).strict(),
  rates: z.object({ storeOrderConversion: trafficRateViewSchema, addToCart: trafficRateViewSchema, checkoutCompletion: trafficRateViewSchema, providerConversion: trafficRateViewSchema }).strict(),
  clickComparison: z.object({ state: z.enum(["unknown", "comparable", "provisional"]), creatorClicks: trafficCountViewSchema, storefrontSessions: trafficCountViewSchema, measure: z.literal("Creator clicks and storefront sessions are different measures"), attribution: z.enum(["sourceApprovedUtm", "allTraffic", "unattributed", "blocked", "unknown"]), sourceRef: publicRef.nullable(), sourceAsOf: trafficInstantSchema.nullable(), period: trafficWindowSchema.nullable(), reasonCodes: z.array(trafficReasonSchema) }).strict(),
  days: z.array(z.object({ day: trafficDaySchema, segment: trafficPublicSegmentSchema, counters: trafficCountersSchema, coverage: z.enum(["complete", "partial"]), observedThrough: trafficInstantSchema, sourceAsOf: trafficInstantSchema, importedAt: trafficInstantSchema, revision: z.number().int().positive() }).strict()).max(366),
  imports: z.object({ latest: trafficImportSummarySchema.nullable(), firstActualImport: z.object({ state: z.enum(["pending", "validated"]), receipt: trafficImportSummarySchema.nullable() }).strict() }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.provenance.synthetic !== (value.provenance.evidenceStage === "unconfigured" ? null : value.provenance.evidenceStage === "synthetic")) ctx.addIssue({ code: "custom", message: "Native evidence stage and synthetic marker must agree." });
  const first = value.imports.firstActualImport;
  if (first.state === "pending" ? first.receipt !== null : !first.receipt || first.receipt.synthetic || first.receipt.evidenceStage !== "source") ctx.addIssue({ code: "custom", message: "Only a validated actual source receipt can establish the first actual import." });
});
export type TrafficImportReceipt = z.infer<typeof trafficImportReceiptSchema>;
export type TrafficImportSummary = z.infer<typeof trafficImportSummarySchema>;
export type TrafficCountView = z.infer<typeof trafficCountViewSchema>;
export type TrafficRateView = z.infer<typeof trafficRateViewSchema>;
export type TrafficPublicSegment = z.infer<typeof trafficPublicSegmentSchema>;
export type NativeSiteTrafficView = z.infer<typeof nativeSiteTrafficViewSchema>;
