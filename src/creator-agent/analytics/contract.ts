import { z } from "zod";
import { adPlatformsSnapshotSchema, instantSchema, ordersSnapshotSchema, timezoneSchema, windowSchema } from "./sources.ts";

/** Native reads deliberately exclude customerJourney: siteTraffic is its only owner. */
export const nativeAnalyticsViewKeys = ["overviewSummary", "attribution", "paidMedia", "launchSnapshot", "launchReconciliation", "campaignFunnel", "metricDictionary"] as const;
export type NativeAnalyticsViewKey = typeof nativeAnalyticsViewKeys[number];
export const analyticsRefSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,240}$/);
export const analyticsHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const analyticsCountSchema = z.number().int().nonnegative().safe();
export const analyticsMoneySchema = z.object({ minorUnits: z.number().int().safe(), currency: z.literal("USD") }).strict();
export const analyticsDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
export const analyticsPeriodSchemaNative = z.object({ startAt: instantSchema, endAt: instantSchema, timezone: timezoneSchema, basis: z.literal("eventTime") }).strict()
  .refine(value => Date.parse(value.startAt) < Date.parse(value.endAt) && Date.parse(value.endAt) - Date.parse(value.startAt) <= 367 * 86_400_000);
export const analyticsScopeSchema = z.object({ workspaceId: analyticsRefSchema, accountId: analyticsRefSchema, environment: z.literal("sandbox") }).strict();
export const analyticsPrincipalSchema = z.object({ principalRef: analyticsRefSchema, role: z.enum(["reader", "reviewer"]) }).strict();
export const analyticsReasonCodes = ["SOURCE_MISSING", "SOURCE_UNSUPPORTED", "COVERAGE_PARTIAL", "SOURCE_STALE", "IDENTITY_UNRESOLVED", "IDENTITY_CONFLICT", "COHORT_MISMATCH", "WINDOW_MISMATCH", "CURRENCY_MISMATCH", "CURRENCY_UNSUPPORTED", "DEFINITION_MISMATCH", "ZERO_DENOMINATOR", "INPUT_UNKNOWN", "RETENTION_IMMATURE", "COST_INCOMPLETE", "ESTIMATED_COST", "ATTRIBUTION_WINDOW_UNKNOWN", "RIGHTS_UNKNOWN", "RIGHTS_EXPIRED", "NO_AUTHORITATIVE_RECEIPT", "NOT_APPLICABLE", "SOURCE_ERROR"] as const;
export const analyticsReasonSchema = z.enum(analyticsReasonCodes);
export type AnalyticsReason = z.infer<typeof analyticsReasonSchema>;
const plainFilters = z.object({}).strict();
export const nativeAnalyticsFilters = {
  overviewSummary: plainFilters, attribution: plainFilters, launchSnapshot: plainFilters, launchReconciliation: plainFilters, metricDictionary: plainFilters,
  paidMedia: z.object({ platform: z.enum(["all", "meta", "tiktok"]).default("all"), rights: z.enum(["all", "cleared", "expiring", "expired", "notGranted", "unknown"]).default("all") }).strict(),
  campaignFunnel: z.object({ campaignId: analyticsRefSchema, cohort: analyticsRefSchema }).strict(),
};
const requestBase = { period: analyticsPeriodSchemaNative.nullable().default(null), sort: z.array(z.never()).length(0).default([]), page: z.object({ cursor: z.null(), limit: z.number().int().min(1).max(500) }).strict().default({ cursor: null, limit: 50 }) };
export const nativeAnalyticsRequestSchema = z.discriminatedUnion("viewKey", [
  z.object({ ...requestBase, viewKey: z.literal("overviewSummary"), filters: nativeAnalyticsFilters.overviewSummary }).strict(),
  z.object({ ...requestBase, viewKey: z.literal("attribution"), filters: nativeAnalyticsFilters.attribution }).strict(),
  z.object({ ...requestBase, viewKey: z.literal("paidMedia"), filters: nativeAnalyticsFilters.paidMedia, page: z.object({ cursor: z.string().min(1).max(1000).nullable(), limit: z.number().int().min(1).max(500) }).strict().default({ cursor: null, limit: 50 }) }).strict(),
  z.object({ ...requestBase, viewKey: z.literal("launchSnapshot"), filters: nativeAnalyticsFilters.launchSnapshot }).strict(),
  z.object({ ...requestBase, viewKey: z.literal("launchReconciliation"), filters: nativeAnalyticsFilters.launchReconciliation }).strict(),
  z.object({ ...requestBase, viewKey: z.literal("campaignFunnel"), filters: nativeAnalyticsFilters.campaignFunnel }).strict(),
  z.object({ ...requestBase, viewKey: z.literal("metricDictionary"), filters: nativeAnalyticsFilters.metricDictionary }).strict(),
]);
export const nativeAnalyticsBindingSchema = z.object({ scope: analyticsScopeSchema, principal: analyticsPrincipalSchema, request: nativeAnalyticsRequestSchema }).strict();
export const analyticsOwnerKinds = ["commerceOrders", "adReporting", "economicCosts", "retainedCustomers", "creatorActivity", "creatorPortfolio", "launchReadiness", "campaignEvents", "sampleCapacity", "metricDefinitions", "reconciliation"] as const;
/** Outcome of a bounded source-wide check, distinct from the newest row event time.
 * An unchanged successful check may renew coverage; a failed attempt cannot do so. */
export const analyticsSyncSchema = z.object({ state: z.enum(["changed", "unchanged", "neverSynced", "partial", "error", "unknown"]),
  attemptedAt: instantSchema.nullable(), successfulCoverageAt: instantSchema.nullable(),
  expectedCount: analyticsCountSchema.nullable(), observedCount: analyticsCountSchema.nullable(),
}).strict().superRefine((s, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (s.successfulCoverageAt && (!s.attemptedAt || Date.parse(s.successfulCoverageAt) > Date.parse(s.attemptedAt))) bad("Coverage cannot follow its source attempt.");
  if (s.expectedCount !== null && s.observedCount !== null && s.observedCount > s.expectedCount) bad("Source observations exceed the bounded population.");
  if (["changed", "unchanged"].includes(s.state) && (!s.successfulCoverageAt || s.expectedCount === null || s.observedCount !== s.expectedCount)) bad("Successful source checks need complete counted coverage.");
  if (s.state === "neverSynced" && (s.successfulCoverageAt !== null || s.observedCount !== null)) bad("Never-synced coverage is unknown, not a counted zero.");
});
export const analyticsOwnerProofSchema = z.object({ proofRef: analyticsRefSchema, owner: z.enum(analyticsOwnerKinds), scope: analyticsScopeSchema, principalRef: analyticsRefSchema,
  requestDigest: analyticsHashSchema, accountRef: analyticsRefSchema, sourceVersion: analyticsRefSchema, permissionVersion: analyticsRefSchema, definitionVersion: analyticsRefSchema,
  cohortRef: analyticsRefSchema.nullable(), period: analyticsPeriodSchemaNative.nullable(), observedAt: instantSchema, sourceAsOf: instantSchema.nullable(), validUntil: instantSchema,
  maxAgeMs: z.number().int().min(1).max(26 * 3_600_000), coverage: z.enum(["complete", "partial", "missing"]), sync: analyticsSyncSchema.optional(),
}).strict().refine(value => Date.parse(value.validUntil) > Date.parse(value.observedAt) && (value.sourceAsOf === null || Date.parse(value.sourceAsOf) <= Date.parse(value.observedAt)))
  .superRefine((owner, ctx) => {
    const s = owner.sync; if (!s) return;
    const sameCoverage = s.successfulCoverageAt === null || owner.sourceAsOf === null ? s.successfulCoverageAt === owner.sourceAsOf : Date.parse(s.successfulCoverageAt) === Date.parse(owner.sourceAsOf);
    if (s.attemptedAt && Date.parse(s.attemptedAt) > Date.parse(owner.observedAt) || !sameCoverage ||
      s.state === "neverSynced" && owner.coverage !== "missing" || ["changed", "unchanged"].includes(s.state) && owner.coverage !== "complete")
      ctx.addIssue({ code: "custom", message: "Source-wide sync evidence must agree with the owner watermark and coverage." });
  });
export const analyticsInputFact = <T extends z.ZodTypeAny>(value: T) => z.object({ value: value.nullable(), reason: analyticsReasonSchema.nullable(), proofRef: analyticsRefSchema.nullable(), evidenceRefs: z.array(analyticsRefSchema).max(100) }).strict()
  .refine(input => input.value === null ? input.reason !== null : input.reason === null && input.proofRef !== null && input.evidenceRefs.length > 0);
export const countInput = analyticsInputFact(analyticsCountSchema);
export const moneyInput = analyticsInputFact(analyticsMoneySchema.refine(value => value.minorUnits >= 0));
export const analyticsCostKindSchema = z.enum(["creatorCommission", "historicalCreatorFee", "sample", "shipping", "paidMedia", "platformFee", "otherAcquisition"]);
export const analyticsCostSchema = z.object({ key: analyticsCostKindSchema, basis: z.enum(["paid", "accrued", "estimated"]), minorUnits: z.number().int().nonnegative().safe().nullable(),
  alsoInCash: z.boolean(), obligationRef: analyticsRefSchema, evidenceRef: analyticsRefSchema, cashRef: analyticsRefSchema.nullable() }).strict()
  .refine(value => value.key !== "historicalCreatorFee" || value.basis !== "estimated", "Historical fees require an existing accepted obligation.");
export const analyticsEconomicsSchema = z.object({ proofRef: analyticsRefSchema, cohortRef: analyticsRefSchema, period: analyticsPeriodSchemaNative, currency: z.literal("USD"), allocationVersion: z.literal("economic-events@1"),
  costs: z.array(analyticsCostSchema).max(2000), retention: z.enum(["mature", "immature", "unknown"]), landedCost: z.enum(["complete", "incomplete", "unknown"]), refundRevision: analyticsRefSchema.nullable(),
  contribution: analyticsInputFact(analyticsMoneySchema), newRetainedCustomers: countInput,
}).strict();
const orders = z.object({ proofRef: analyticsRefSchema, snapshot: ordersSnapshotSchema }).strict().nullable();
const ads = z.object({ proofRef: analyticsRefSchema, snapshot: adPlatformsSnapshotSchema }).strict().nullable();
const commerceFacts = { orders, ads, economics: analyticsEconomicsSchema.nullable() };
const activity = z.object({ activityRef: analyticsRefSchema, creatorRef: analyticsRefSchema.nullable(), kind: z.enum(["reviewed", "qualified", "invitationConfirmed", "reply", "termsAccepted", "contentAccepted", "published"]), eventAt: instantSchema, proofRef: analyticsRefSchema, evidenceRefs: z.array(analyticsRefSchema).min(1).max(20) }).strict();
const post = z.object({ postRef: analyticsRefSchema, views: countInput, likes: countInput, comments: countInput, shares: countInput }).strict();
export const overviewFactsSchema = z.object({ ...commerceFacts, activity: z.array(activity).max(100), posts: z.array(post).max(100), postsTotal: countInput,
  portfolio: z.object({ proofRef: analyticsRefSchema, reviewKey: analyticsHashSchema, reviewHash: analyticsHashSchema }).strict().nullable().optional(),
}).strict();
export const attributionFactsSchema = z.object({ ...commerceFacts, creators: z.array(z.object({ creatorRef: analyticsRefSchema, roi: analyticsInputFact(z.number().finite()) }).strict()).max(100) }).strict();
export const paidMediaFactsSchema = z.object({ ads, creatorSampleEconomics: moneyInput,
  economics: analyticsEconomicsSchema.nullable().optional() }).strict();
const gate = z.object({ gateId: z.enum(["terms", "stock", "sampleAuthority", "content", "sourceAccess", "budget", "approval"]), state: z.enum(["ready", "held", "unknown"]), reasonCodes: z.array(analyticsReasonSchema).max(20), proofRef: analyticsRefSchema, evidenceRefs: z.array(analyticsRefSchema).min(1).max(20), relativeOffsetDays: z.number().int().min(-366).max(366).nullable(), anchorEventAt: instantSchema.nullable() }).strict()
  .refine(value => value.relativeOffsetDays === null || value.anchorEventAt !== null);
export const launchSnapshotFactsSchema = z.object({ launchDate: analyticsInputFact(analyticsDaySchema), targetWindow: analyticsInputFact(analyticsPeriodSchemaNative), stage: analyticsInputFact(z.enum(["planning", "pilot", "launch", "monitoring"])), conversations: countInput, readyForNextStep: countInput, firstWaveSamples: countInput, budgetCeiling: moneyInput,
  momentum: z.array(z.object({ segment: z.enum(["instagram", "tiktokWebsite", "tiktokShop"]), inConversation: countInput, ready: countInput }).strict()).max(3), gates: z.array(gate).max(20),
  approvals: z.array(z.object({ approvalRef: analyticsRefSchema, manifestVersion: analyticsRefSchema, state: z.enum(["requested", "approved", "rejected", "expired", "canceled"]), requestedAt: instantSchema, proofRef: analyticsRefSchema, evidenceRefs: z.array(analyticsRefSchema).min(1).max(20) }).strict()).max(100),
}).strict();
export const analyticsMetricIds = ["netReceipts", "orders", "contribution", "marketingSpend", "newRetainedCustomers", "aov", "blendedCac", "mer", "platformRoas", "sessions", "confirmedInvitations", "sampleShipped"] as const;
const reconciliationCell = z.object({ viewKey: z.enum([...nativeAnalyticsViewKeys, "customerJourney", "commissionLedger", "batchDetail"]), cohortRef: analyticsRefSchema, period: analyticsPeriodSchemaNative, definitionVersion: analyticsRefSchema, inputVersion: analyticsRefSchema, value: analyticsInputFact(z.number().finite()) }).strict();
export const reconciliationFactsSchema = z.object({ asOf: instantSchema, matrix: z.array(z.object({ metricId: z.enum(analyticsMetricIds), definitionVersion: analyticsRefSchema, unit: z.enum(["count", "minorUnits", "percent", "multiple"]), currency: z.literal("USD").nullable(), cells: z.array(reconciliationCell).min(2).max(10) }).strict()
  .refine(value => (value.unit === "minorUnits") === (value.currency !== null))).max(100) }).strict();
const funnelCounts = z.object({ contacted: countInput, replied: countInput, agreed: countInput, shipped: countInput, delivered: countInput, posted: countInput }).strict();
/** Read-only sample owner evidence; this packet cannot reserve, release or ship stock. */
export const campaignReservationsSchema = z.object({ proofRef: analyticsRefSchema, campaignRef: analyticsRefSchema, cohortRef: analyticsRefSchema,
  period: analyticsPeriodSchemaNative, coverage: z.enum(["complete", "partial"]), total: analyticsCountSchema.nullable(),
  rows: z.array(z.object({ reservationRef: analyticsRefSchema, home: z.enum(["H1", "H2", "H3"]), itemRef: analyticsRefSchema,
    itemLabel: z.string().trim().min(1).max(160), units: analyticsCountSchema.positive(), state: z.enum(["active", "released", "fulfilled"]),
    cost: moneyInput, approval: z.object({ state: z.enum(["approved", "pending", "rejected", "expired", "unknown"]),
      evidenceRef: analyticsRefSchema.nullable(), version: analyticsRefSchema.nullable() }).strict()
      .refine(v => v.state !== "approved" || !!v.evidenceRef && !!v.version),
    sourceVersion: analyticsRefSchema, evidenceRef: analyticsRefSchema, observedAt: instantSchema,
  }).strict()).max(100),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.rows.map(r => r.reservationRef)).size !== v.rows.length || v.total !== null && v.total < v.rows.length || v.coverage === "complete" && v.total !== v.rows.length)
    ctx.addIssue({ code: "custom", message: "Reservation coverage must be unique and counted." });
});
export const campaignFactsSchema = z.object({ campaignRef: analyticsRefSchema, cohortRef: analyticsRefSchema, maturity: z.enum(["mature", "immature", "unknown"]), progression: z.literal("distinctOpportunityCumulative"), aggregation: z.enum(["disjointComplete", "unknown"]), maturePosted: countInput,
  /** Public route selectors explicitly mapped by this source revision; never an echoed arbitrary request. */
  selection: nativeAnalyticsFilters.campaignFunnel,
  channels: z.array(z.object({ channel: z.enum(["instagram", "tiktokWebsite", "tiktokShop"]), contactReference: countInput, steps: funnelCounts, giftCap: countInput, reserved: countInput, historical: z.object({ replies: countInput, agreements: countInput }).strict() }).strict()).max(3), notYetMature: countInput,
  historicalBasis: z.object({ period: analyticsPeriodSchemaNative, cohortRef: analyticsRefSchema, definitionVersion: analyticsRefSchema }).strict().nullable(),
  reservations: campaignReservationsSchema.nullable().optional(),
}).strict();
/** Definitions are versioned application facts. No caller-provided formula or prose is evaluated. */
export const dictionaryFactsSchema = z.object({ proofRef: analyticsRefSchema, effectiveAt: instantSchema, formulaVersion: z.literal("headline-metrics.v1"), allocationVersion: z.literal("economic-events@1"), economics: analyticsEconomicsSchema.nullable() }).strict();
const snapshotBase = { schemaVersion: z.literal("analytics-source.v1"), binding: nativeAnalyticsBindingSchema, sourceVersion: analyticsRefSchema, permissionVersion: analyticsRefSchema,
  evidenceStage: z.enum(["synthetic", "source"]), synthetic: z.boolean(), observedAt: instantSchema, validUntil: instantSchema, period: analyticsPeriodSchemaNative.nullable(), window: windowSchema.nullable(), cohortRef: analyticsRefSchema.nullable(),
  owners: z.array(analyticsOwnerProofSchema).min(1).max(30),
};
export const nativeAnalyticsSnapshotSchema = z.discriminatedUnion("viewKey", [
  z.object({ ...snapshotBase, viewKey: z.literal("overviewSummary"), facts: overviewFactsSchema }).strict(),
  z.object({ ...snapshotBase, viewKey: z.literal("attribution"), facts: attributionFactsSchema }).strict(),
  z.object({ ...snapshotBase, viewKey: z.literal("paidMedia"), facts: paidMediaFactsSchema }).strict(),
  z.object({ ...snapshotBase, viewKey: z.literal("launchSnapshot"), facts: launchSnapshotFactsSchema }).strict(),
  z.object({ ...snapshotBase, viewKey: z.literal("launchReconciliation"), facts: reconciliationFactsSchema }).strict(),
  z.object({ ...snapshotBase, viewKey: z.literal("campaignFunnel"), facts: campaignFactsSchema }).strict(),
  z.object({ ...snapshotBase, viewKey: z.literal("metricDictionary"), facts: dictionaryFactsSchema }).strict(),
]).superRefine((value, ctx) => {
  if (value.viewKey !== value.binding.request.viewKey || value.synthetic !== (value.evidenceStage === "synthetic")) ctx.addIssue({ code: "custom", message: "Snapshot identity is inconsistent." });
  if (Date.parse(value.validUntil) <= Date.parse(value.observedAt)) ctx.addIssue({ code: "custom", message: "Invalid snapshot lease." });
  if (new Set(value.owners.map(owner => owner.proofRef)).size !== value.owners.length) ctx.addIssue({ code: "custom", message: "Duplicate owner proof." });
});
export type NativeAnalyticsRequest = z.infer<typeof nativeAnalyticsRequestSchema>;
export type NativeAnalyticsBinding = z.infer<typeof nativeAnalyticsBindingSchema>;
export type NativeAnalyticsSnapshot = z.infer<typeof nativeAnalyticsSnapshotSchema>;
export type AnalyticsOwnerProof = z.infer<typeof analyticsOwnerProofSchema>;
export type AnalyticsInputFact<T> = { value: T | null; reason: AnalyticsReason | null; proofRef: string | null; evidenceRefs: string[] };
