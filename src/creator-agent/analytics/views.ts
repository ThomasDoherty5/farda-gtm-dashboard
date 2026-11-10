import { z } from "zod";
import { analyticsCountSchema, analyticsDaySchema, analyticsMetricIds, analyticsMoneySchema, analyticsOwnerKinds, analyticsPeriodSchemaNative, analyticsReasonSchema, nativeAnalyticsFilters, nativeAnalyticsViewKeys } from "./contract.ts";
import { instantSchema } from "./sources.ts";

export const analyticsPublicRefSchema = z.string().regex(/^analytics-[a-z]+-[a-f0-9]{64}$/);
export const analyticsFactSchema = <T extends z.ZodTypeAny>(value: T) => z.object({ state: z.enum(["known", "unknown", "notApplicable"]), value: value.nullable(), reasonCodes: z.array(analyticsReasonSchema), evidenceRefs: z.array(analyticsPublicRefSchema).max(100),
  sourceAsOf: instantSchema.nullable(), observedAt: instantSchema, provisional: z.boolean(),
}).strict().refine(fact => (fact.state === "known") === (fact.value !== null) && (fact.state === "known" || fact.reasonCodes.length > 0));
export const analyticsCountViewSchema = analyticsFactSchema(analyticsCountSchema);
export const analyticsMoneyViewSchema = analyticsFactSchema(analyticsMoneySchema);
export const analyticsNumberViewSchema = analyticsFactSchema(z.number().finite());
export const analyticsMeasureSchema = z.object({ metricId: z.string().regex(/^[A-Za-z][A-Za-z0-9.]{0,79}$/), formulaVersion: z.literal("headline-metrics.v1"), unit: z.enum(["count", "minorUnits", "percent", "multiple"]), numerator: analyticsNumberViewSchema, denominator: analyticsNumberViewSchema.nullable(), result: analyticsNumberViewSchema }).strict();
const publicOwner = z.object({ proofRef: analyticsPublicRefSchema, owner: z.enum(analyticsOwnerKinds), accountRef: analyticsPublicRefSchema, sourceVersion: analyticsPublicRefSchema, definitionVersion: analyticsPublicRefSchema,
  cohortRef: analyticsPublicRefSchema.nullable(), period: analyticsPeriodSchemaNative.nullable(), observedAt: instantSchema, sourceAsOf: instantSchema.nullable(), validUntil: instantSchema, coverage: z.enum(["complete", "partial", "missing"]), maxAgeMs: z.number().int().positive(),
}).strict();
const header = { datasetKey: z.literal("analytics-native"), provenance: z.object({ evidenceStage: z.enum(["synthetic", "source"]), synthetic: z.boolean(), sourceVersion: analyticsPublicRefSchema, observedAt: instantSchema, validUntil: instantSchema }).strict(),
  period: analyticsPeriodSchemaNative.nullable(), cohortRef: analyticsPublicRefSchema.nullable(), sources: z.array(publicOwner).max(30), coverage: z.object({ state: z.enum(["complete", "partial", "missing"]), reasonCodes: z.array(analyticsReasonSchema) }).strict(), freshness: z.object({ state: z.enum(["current", "stale", "unknown"]), sourceAsOf: instantSchema.nullable() }).strict(),
};
const channel = z.object({ channel: z.enum(["shopify", "tiktokShop"]), orders: analyticsCountViewSchema, netReceipts: analyticsMoneyViewSchema }).strict();
const commonCommerce = { orders: analyticsCountViewSchema, netReceipts: analyticsMoneyViewSchema, contribution: analyticsMoneyViewSchema, marketingSpend: analyticsMoneyViewSchema, newRetainedCustomers: analyticsCountViewSchema, channels: z.array(channel).max(2), measures: z.array(analyticsMeasureSchema).max(50) };
export const nativeOverviewSummarySchema = z.object({ ...header, viewKey: z.literal("overviewSummary"), ...commonCommerce, attributedOrders: analyticsCountViewSchema, attributedNetSales: analyticsMoneyViewSchema,
  daily: z.array(z.object({ day: analyticsDaySchema, channels: z.array(channel).max(2) }).strict()).max(366),
  activity: z.array(z.object({ activityRef: analyticsPublicRefSchema, creatorRef: analyticsPublicRefSchema.nullable(), kind: z.enum(["reviewed", "qualified", "invitationConfirmed", "reply", "termsAccepted", "contentAccepted", "published"]), eventAt: instantSchema, evidenceRefs: z.array(analyticsPublicRefSchema).max(20) }).strict()).max(100),
  posts: z.array(z.object({ postRef: analyticsPublicRefSchema, views: analyticsCountViewSchema, likes: analyticsCountViewSchema, comments: analyticsCountViewSchema, shares: analyticsCountViewSchema }).strict()).max(100),
  postsTotal: analyticsCountViewSchema,
}).strict();
const economicEvidence = z.object({ allocationVersion: z.literal("economic-events@1"), cohortRef: analyticsPublicRefSchema, period: analyticsPeriodSchemaNative, currency: z.literal("USD"), coverage: z.enum(["complete", "partial", "missing"]), retention: z.enum(["mature", "immature", "unknown"]), landedCost: z.enum(["complete", "incomplete", "unknown"]), refundRevision: analyticsPublicRefSchema.nullable(),
  costs: z.array(z.object({ key: z.enum(["creatorCommission", "sample", "shipping", "paidMedia", "platformFee", "otherAcquisition"]), basis: z.enum(["paid", "accrued", "estimated"]), minorUnits: z.number().int().nonnegative().safe().nullable(), alsoInCash: z.boolean(), obligationRef: analyticsPublicRefSchema, evidenceRef: analyticsPublicRefSchema, cashRef: analyticsPublicRefSchema.nullable() }).strict()).max(2000),
}).strict();
export const nativeAttributionSchema = z.object({ ...header, viewKey: z.literal("attribution"), ...commonCommerce, platformReports: z.array(z.object({ platform: z.enum(["meta", "tiktok"]), attributionWindow: z.object({ clickDays: z.number().int().nonnegative(), viewDays: z.number().int().nonnegative() }).strict().nullable() }).strict()).max(2), retainedUnits: analyticsCountViewSchema,
  weeks: z.array(z.object({ startDay: analyticsDaySchema, endDayExclusive: analyticsDaySchema, channels: z.array(channel).max(2) }).strict()).max(53),
  attribution: z.array(z.object({ method: z.enum(["creatorCode", "sitewideCode", "unknownCode", "utm", "platform", "unattributed"]), orders: analyticsCountViewSchema }).strict()).max(6), economicEvidence: economicEvidence.nullable(),
  creators: z.array(z.object({ creatorRef: analyticsPublicRefSchema, roi: analyticsNumberViewSchema }).strict()).max(100),
}).strict();
const platform = z.enum(["meta", "tiktok"]);
const rights = z.enum(["cleared", "expiring", "expired", "notGranted", "unknown"]);
export const nativePaidMediaSchema = z.object({ ...header, viewKey: z.literal("paidMedia"), channels: z.array(z.object({ platform, spend: analyticsMoneyViewSchema, impressions: analyticsCountViewSchema, clicks: analyticsCountViewSchema, platformPurchaseValue: analyticsMoneyViewSchema,
  attributionWindow: z.object({ clickDays: z.number().int().nonnegative(), viewDays: z.number().int().nonnegative() }).strict().nullable(), measures: z.array(analyticsMeasureSchema).max(10) }).strict()).max(2), totals: z.object({ spend: analyticsMoneyViewSchema, impressions: analyticsCountViewSchema, clicks: analyticsCountViewSchema, measures: z.array(analyticsMeasureSchema).max(10) }).strict(), creatorSampleEconomics: analyticsMoneyViewSchema,
  assets: z.array(z.object({ assetRef: analyticsPublicRefSchema, platform, label: z.string().regex(/^(?:[A-Z]{2,6}-\d{1,6}|Asset [a-f0-9]{8})$/), clicks: analyticsCountViewSchema, impressions: analyticsCountViewSchema, ctr: analyticsNumberViewSchema, rights, expiresOn: analyticsDaySchema.nullable() }).strict()).max(1000), assetTotal: analyticsCountViewSchema,
  selection: z.object({ platform: z.enum(["all", "meta", "tiktok"]), rights: z.enum(["all", "cleared", "expiring", "expired", "notGranted", "unknown"]) }).strict(),
  pagination: z.object({ returned: analyticsCountSchema, nextCursor: z.string().max(1000).nullable() }).strict(),
}).strict();
export const nativeLaunchSnapshotSchema = z.object({ ...header, viewKey: z.literal("launchSnapshot"), launchDate: analyticsFactSchema(analyticsDaySchema), targetWindow: analyticsFactSchema(analyticsPeriodSchemaNative), stage: analyticsFactSchema(z.enum(["planning", "pilot", "launch", "monitoring"])), conversations: analyticsCountViewSchema, readyForNextStep: analyticsCountViewSchema, firstWaveSamples: analyticsCountViewSchema, budgetCeiling: analyticsMoneyViewSchema,
  momentum: z.array(z.object({ segment: z.enum(["instagram", "tiktokWebsite", "tiktokShop"]), inConversation: analyticsCountViewSchema, ready: analyticsCountViewSchema }).strict()).max(3),
  gates: z.array(z.object({ gateId: z.enum(["terms", "stock", "sampleAuthority", "content", "sourceAccess", "budget", "approval"]), state: z.enum(["ready", "held", "unknown"]), reasonCodes: z.array(analyticsReasonSchema), evidenceRefs: z.array(analyticsPublicRefSchema), relativeOffsetDays: z.number().int().nullable(), anchorEventAt: instantSchema.nullable() }).strict()).max(20),
  approvals: z.array(z.object({ approvalRef: analyticsPublicRefSchema, manifestVersion: analyticsPublicRefSchema, state: z.enum(["requested", "approved", "rejected", "expired", "canceled"]), requestedAt: instantSchema, evidenceRefs: z.array(analyticsPublicRefSchema) }).strict()).max(100),
}).strict();
export const nativeLaunchReconciliationSchema = z.object({ ...header, viewKey: z.literal("launchReconciliation"), asOf: instantSchema, matrix: z.array(z.object({ metricId: z.enum(analyticsMetricIds), definitionVersion: analyticsPublicRefSchema, unit: z.enum(["count", "minorUnits", "percent", "multiple"]), currency: z.literal("USD").nullable(),
  cells: z.array(z.object({ viewKey: z.enum([...nativeAnalyticsViewKeys, "customerJourney", "commissionLedger", "batchDetail"]), cohortRef: analyticsPublicRefSchema, period: analyticsPeriodSchemaNative, definitionVersion: analyticsPublicRefSchema, inputVersion: analyticsPublicRefSchema, value: analyticsNumberViewSchema }).strict()).min(2).max(10), comparison: z.object({ state: z.enum(["matches", "differs", "unknown"]), reasonCodes: z.array(analyticsReasonSchema) }).strict(),
}).strict()).max(100) }).strict();
const stepViews = z.object({ contacted: analyticsCountViewSchema, replied: analyticsCountViewSchema, agreed: analyticsCountViewSchema, shipped: analyticsCountViewSchema, delivered: analyticsCountViewSchema, posted: analyticsCountViewSchema }).strict();
export const nativeCampaignFunnelSchema = z.object({ ...header, viewKey: z.literal("campaignFunnel"), campaignRef: analyticsPublicRefSchema, cohortRef: analyticsPublicRefSchema, maturity: z.enum(["mature", "immature", "unknown"]), progression: z.literal("distinctOpportunityCumulative"), aggregation: z.enum(["disjointComplete", "unknown"]), totals: stepViews, giftCap: analyticsCountViewSchema, reserved: analyticsCountViewSchema, matureDelivered: analyticsCountViewSchema, maturePosted: analyticsCountViewSchema, matureNoPost: analyticsCountViewSchema, measures: z.array(analyticsMeasureSchema).max(15),
  selection: nativeAnalyticsFilters.campaignFunnel,
  channels: z.array(z.object({ channel: z.enum(["instagram", "tiktokWebsite", "tiktokShop"]), measures: z.array(analyticsMeasureSchema).max(10), contactReference: analyticsCountViewSchema, steps: stepViews, giftCap: analyticsCountViewSchema, reserved: analyticsCountViewSchema, historical: z.object({ replies: analyticsCountViewSchema, agreements: analyticsCountViewSchema }).strict() }).strict()).max(3), notYetMature: analyticsCountViewSchema,
  historicalBasis: z.object({ period: analyticsPeriodSchemaNative, cohortRef: analyticsPublicRefSchema, definitionVersion: analyticsPublicRefSchema }).strict().nullable(),
}).strict();
export const nativeMetricDictionarySchema = z.object({ ...header, viewKey: z.literal("metricDictionary"), definitionVersion: analyticsPublicRefSchema, effectiveAt: instantSchema, formulaVersion: z.literal("headline-metrics.v1"), allocationVersion: z.literal("economic-events@1"),
  entries: z.array(z.object({ metricId: z.enum(["aov", "blendedCac", "mer", "platformRoas", "contributionPerOrder"]), numerator: z.enum(["netReceipts", "includedAcquisitionCost", "platformPurchaseValue", "contribution"]), denominator: z.enum(["validOrders", "newRetainedCustomers", "marketingSpend", "platformSpend"]), unit: z.enum(["minorUnits", "multiple"]), zeroRule: z.literal("notApplicable"), missingRule: z.literal("unknown"), refundTreatment: z.literal("originalCohortRevision"), scopeRule: z.literal("sameCohortWindowCurrencyDefinition") }).strict()).length(5), economicEvidence: economicEvidence.nullable(),
}).strict();
export const nativeAnalyticsViewSchema = z.discriminatedUnion("viewKey", [nativeOverviewSummarySchema, nativeAttributionSchema, nativePaidMediaSchema, nativeLaunchSnapshotSchema, nativeLaunchReconciliationSchema, nativeCampaignFunnelSchema, nativeMetricDictionarySchema])
  .refine(value => value.provenance.synthetic === (value.provenance.evidenceStage === "synthetic"));
export type NativeAnalyticsView = z.infer<typeof nativeAnalyticsViewSchema>;
export type NativeOverviewSummary = z.infer<typeof nativeOverviewSummarySchema>;
export type NativeAttribution = z.infer<typeof nativeAttributionSchema>;
export type NativePaidMedia = z.infer<typeof nativePaidMediaSchema>;
export type NativeLaunchSnapshot = z.infer<typeof nativeLaunchSnapshotSchema>;
export type NativeLaunchReconciliation = z.infer<typeof nativeLaunchReconciliationSchema>;
export type NativeCampaignFunnel = z.infer<typeof nativeCampaignFunnelSchema>;
export type NativeMetricDictionary = z.infer<typeof nativeMetricDictionarySchema>;
export type AnalyticsFact<T> = Omit<z.infer<typeof analyticsNumberViewSchema>, "value"> & { value: T | null };
