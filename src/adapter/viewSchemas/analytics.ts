/**
 * Runtime schemas for the view data of the Overview summary and the analytics views
 * (launchReconciliation, launchSnapshot, launchControl, attribution, paidMedia, campaignFunnel, customerJourney).
 * They validate `ReadResponse.data` only; the envelope is `readResponseSchema(...)` in contract.ts.
 *
 * Choices:
 * - Every figure that can be missing uses `provenanceValueSchema`, so known zero, unknown and not applicable stay
 *   distinct and a known null is rejected (contract.ts). Plain counters that the type allows to be `null` (post
 *   counters) stay nullable: null means "the source gave none", and the schema never coerces it to 0.
 * - Money is whole minor units. Amounts that cannot be negative (receipts, spend, ad cost) reject negatives;
 *   `contribution` may legitimately be negative, so it uses the contract's signed `moneySchema`.
 * - Objects are not `.strict()`: these views carry display data only, so an extra key is stripped, not a risk. The
 *   `datasetKey` literals do the job that matters here, which is refusing a payload from another dataset.
 * - The helpers below are repeated in the sibling files on purpose, so each file stands alone.
 */
import { z } from "zod";
import { moneySchema, provenanceValueSchema } from "../contract";

const count = z.number().int().nonnegative();
const nonNegativeMoney = moneySchema.extend({ minorUnits: z.number().int().nonnegative() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const provenanceDisclosure = z.object({ source: z.string(), observedAt: z.string(), timezone: z.string(), coverage: z.string(), stale: z.boolean() });

/* ---------- Overview ---------- */

const postCounters = z.object({
  postId: z.string(),
  views: count.nullable(),
  likes: count.nullable(),
  comments: count.nullable(),
  shares: count.nullable(),
});

const channelKey = z.enum(["shopify", "tiktok"]);
const channelTotals = z.object({ key: channelKey, label: z.string(), netReceipts: nonNegativeMoney, orders: count });

export const overviewSummarySchema = z.object({
  datasetKey: z.literal("overview-original"),
  orders: provenanceValueSchema(count),
  netReceipts: provenanceValueSchema(nonNegativeMoney),
  contribution: provenanceValueSchema(moneySchema),
  marketingSpend: nonNegativeMoney,
  newRetainedCustomers: count,
  periodLabel: z.string(),
  channels: z.array(channelTotals),
  daily: z.array(z.object({ date, shopify: count, tiktok: count })),
  cohortLabel: z.string(),
  monitorLabel: z.string(),
  lastCheckedLabel: z.string(),
  activity: z.array(z.object({ handle: z.string(), note: z.string() })),
  attributedOrders: provenanceValueSchema(count),
  attributedNetSales: provenanceValueSchema(nonNegativeMoney),
  posts: z.array(postCounters),
});

/* ---------- Launch snapshot ---------- */

export const launchSnapshotSchema = z.object({
  datasetKey: z.literal("launch-snapshot-demo"),
  snapshotLabel: z.string(),
  stage: z.string(),
  launchDate: provenanceValueSchema(z.string()),
  targetWindow: z.string(),
  conversations: provenanceValueSchema(count),
  readyForNextStep: count,
  firstWaveSamples: provenanceValueSchema(count),
  budgetCeiling: nonNegativeMoney,
  decisionsToUnblock: z.array(z.string()),
  momentum: z.array(z.object({ label: z.string(), inConversation: count, ready: count })),
  relativeGates: z.array(z.object({ offset: z.string(), label: z.string() })),
  approvals: z.array(z.object({ initial: z.string(), handle: z.string(), context: z.string(), age: z.string() })),
  sources: z.array(z.object({ label: z.string(), source: z.string(), badge: z.string() })),
  agentNote: z.string(),
  provenance: provenanceDisclosure,
});

/* ---------- Launch control ---------- */

export const launchControlSchema = z.object({
  datasetKey: z.literal("launch-control-demo"),
  launchDate: provenanceValueSchema(z.string()),
  gates: z.array(
    z.object({
      id: z.string(),
      gate: z.string(),
      owner: z.string(),
      state: z.enum(["pass", "blocked"]),
      evidenceAction: z.string(),
      evidenceKind: z.enum(["task", "run", "proof"]),
    }),
  ),
  blockerContext: z.string(),
  firstWaveSamples: count,
  budgetCeiling: nonNegativeMoney,
  milestones: z.array(z.object({ milestone: z.string(), relative: z.string(), state: z.string() })),
  decision: z.object({ windowLabel: z.string(), recorded: z.string(), reviewOwner: z.string(), version: z.string() }),
  provenance: provenanceDisclosure,
});

/* ---------- Attribution ---------- */

const reportingWindow = z.object({ start: z.string().date(), end: z.string().date(), timezone: z.string().trim().min(1) }).strict().refine(w => w.start <= w.end, "Reversed reporting period");
const costScope = z.object({ cohortId: z.string().trim().min(1), currency: z.string().length(3), period: reportingWindow, coverage: z.enum(["complete", "partial", "unknown"]) }).strict();
const costObservation = z.object({ key: z.string(), label: z.string(), basis: z.enum(["paid", "accrued", "estimated"]),
  minorUnits: z.number().int().safe().nonnegative().nullable(), alsoInCash: z.boolean(),
  cohortId: z.string().optional(), obligationId: z.string().optional(), evidenceId: z.string().optional(), cashId: z.string().nullable().optional(),
  currency: z.string().optional(), period: reportingWindow.optional(),
});
const metricObservationScope = z.object({
  source: z.enum(["fixture", "source"]), sourceRef: z.string().trim().min(1), cohortId: z.string().trim().min(1),
  currency: z.string().length(3), period: reportingWindow,
}).strict();
const platformWindow = z.object({ label: z.string().trim().min(1), sourceRef: z.string().trim().min(1) }).strict();
const headlineEvidence = z.object({ source: z.enum(["fixture", "source"]), sourceRef: z.string().trim().min(1),
  cohortId: z.string().trim().min(1), cohortWindow: reportingWindow, costScope, costs: z.array(costObservation).max(2000),
  retention: z.enum(["mature", "immature", "unknown"]), landedCost: z.enum(["complete", "incomplete", "unknown"]),
  refundRevision: z.string().trim().min(1).nullable(),
}).strict();

export const attributionSchema = z.object({
  datasetKey: z.enum(["overview-original", "attribution-observed"]),
  periodLabel: z.string(),
  reportScope: metricObservationScope.optional(), receiptScope: metricObservationScope.optional(), retainedCustomerScope: metricObservationScope.optional(),
  netReceipts: provenanceValueSchema(nonNegativeMoney),
  orders: provenanceValueSchema(count),
  retainedUnits: count,
  contribution: provenanceValueSchema(moneySchema),
  marketingSpend: nonNegativeMoney.nullish().transform(v => v ?? null),
  newRetainedCustomers: count.nullish().transform(v => v ?? null),
  headlineEvidence: headlineEvidence.optional(), tiktokRoasWindow: platformWindow.nullish(),
  tiktokPlatformRoas: provenanceValueSchema(z.number().finite().nonnegative()),
  channels: z.array(channelTotals),
  weeks: z.array(z.object({ label: z.string(), note: z.string().nullable(), shopify: nonNegativeMoney, tiktok: nonNegativeMoney })),
  attribution: z.array(z.object({ key: z.enum(["code", "utm", "platform", "unattributed"]), label: z.string(), orders: count })),
  creators: z.array(z.object({ handle: z.string(), roi: z.number().finite() })),
  provenance: provenanceDisclosure,
}).superRefine((v, ctx) => {
  const amounts = [v.marketingSpend, v.netReceipts.value, v.contribution.value, ...v.channels.map(c => c.netReceipts), ...v.weeks.flatMap(w => [w.shopify, w.tiktok])];
  if (amounts.some(m => m && m.currency !== "USD")) ctx.addIssue({ code: "custom", message: "This report requires comparable USD amounts." });
});

/* ---------- Paid media ---------- */

const platform = z.enum(["meta", "tiktok"]);

export const paidMediaSchema = z.object({
  datasetKey: z.enum(["paid-media-demo", "paid-media-observed"]),
  periodLabel: z.string(),
  channels: z.array(z.object({ key: platform, label: z.string(), spend: nonNegativeMoney.nullish().transform(v => v ?? null), impressions: count, clicks: count, platformPurchaseValue: nonNegativeMoney.nullish().transform(v => v ?? null), attributionWindow: platformWindow.nullish() })),
  creatorSampleEconomics: nonNegativeMoney.nullish().transform(v => v ?? null),
  assets: z.array(
    z.object({
      id: z.string(),
      platform,
      label: z.string(),
      clicks: count,
      impressions: count,
      rights: z.enum(["cleared", "expiring", "notGranted", "unknown"]),
      expiresInDays: count.nullable(),
    }),
  ),
  assetTotal: count,
  provenance: provenanceDisclosure,
}).superRefine((v, ctx) => {
  const amounts = [v.creatorSampleEconomics, ...v.channels.flatMap(c => [c.spend, c.platformPurchaseValue])];
  if (amounts.some(m => m && m.currency !== "USD") || new Set(v.channels.map(c => c.key)).size !== v.channels.length)
    ctx.addIssue({ code: "custom", message: "Paid media needs distinct reporting platforms and comparable USD amounts." });
});

/* ---------- Campaign funnel ---------- */

const funnelCampaign = z.object({
  key: z.enum(["instagram", "tiktok-website", "tiktok-shop"]),
  label: z.string(),
  contactReference: count,
  steps: z.object({ contacted: count, replied: count, agreed: count, shipped: count, delivered: count, posted: count }),
  giftCap: count,
  reserved: count,
  historical: z.object({ replies: count, agreements: count }),
});

export const campaignFunnelSchema = z.object({
  datasetKey: z.literal("campaign-funnel-demo"),
  cohort: z.object({ key: z.enum(["first-wave", "launch-a"]), label: z.string() }),
  campaigns: z.array(funnelCampaign),
  notYetMature: count,
  historicalSource: z.string(),
  provenance: provenanceDisclosure,
});

/* ---------- Customer journey ---------- */

export const customerJourneySchema = z.object({
  datasetKey: z.literal("customer-journey-demo"),
  commercePeriod: z.string(),
  sessions: provenanceValueSchema(count),
  productViewed: count,
  checkoutStarted: count,
  websiteOrders: count,
  tiktokOrders: count,
  websiteNetReceipts: nonNegativeMoney,
  globalAov: nonNegativeMoney,
  globalOrders: count,
  deliveredUnits: provenanceValueSchema(count),
  tickets: z.array(z.object({ category: z.string(), count })),
  resolution: z.object({ byFin: count, byPeople: count, open: count }),
  returns: z.object({ returned: count, received: count, awaitingInspection: count, restocked: count, quarantined: count }),
  reviews: z.object({
    ratedCount: provenanceValueSchema(count),
    stars: z.array(z.object({ star: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), count })),
  }),
  cohorts: z.array(z.object({ metric: z.string(), grain: z.string(), window: z.string(), denominator: z.string(), inclusion: z.string(), version: z.string() })),
  provenance: provenanceDisclosure,
});

/* ---------- Source freshness and reconciliation ---------- */

/** One place a figure appears. Exact values (cents for money) are integers, so a fraction is refused. A null value is a figure the page does not state, which makes its row "unknown", never a match. */
const matrixCell = z.object({ page: z.string(), route: z.string(), value: z.number().int().nullable(), note: z.string().optional() });

export const launchReconciliationSchema = z.object({
  datasetKey: z.literal("reconciliation-demo"),
  asOf: z.string(),
  freshness: z.array(z.object({ sourceId: z.string(), label: z.string(), feeds: z.string(), lastSourceSuccessAt: z.string().nullable(), staleReasonCode: z.string().nullable() })),
  matrix: z.array(z.object({
    metric: z.string(),
    unit: z.enum(["usd", "count"]),
    cells: z.array(matrixCell).min(2),
    status: z.enum(["matches", "differs", "unknown"]),
    reason: z.string().nullable(),
  })),
  provenance: provenanceDisclosure,
});

/* ---------- Metric dictionary ---------- */

const caveat = z.enum(["LANDED_COST_INCOMPLETE", "RETENTION_IMMATURE"]);
const nullableCount = z.number().int().nonnegative().nullable();
const nullableMinor = z.number().int().nonnegative().nullable();
const caseInput = z.object({ netReceiptsMinor: nullableMinor, validOrders: nullableCount, acquisitionCostMinor: nullableMinor, newRetainedCustomers: nullableCount, marketingSpendMinor: nullableMinor, caveat: caveat.nullable() });

export const metricDictionarySchema = z.object({
  datasetKey: z.literal("headline-metrics-cases"),
  version: z.string(),
  effective: date,
  stage: z.literal("fixture-complete"),
  entries: z.array(z.object({ key: z.enum(["aov", "blendedCac", "mer", "platformRoas"]), label: z.string(), numerator: z.string(), denominator: z.string(), source: z.string(), currency: z.string(), window: z.string(), costBuckets: z.string(), refundTreatment: z.string() })),
  related: z.array(z.object({ label: z.string(), basis: z.string() })),
  buckets: z.array(costObservation.extend({ note: z.string() })).max(2000),
  allocationScope: costScope.optional(), allocationVersion: z.string().optional(),
  cases: z.array(z.object({ id: z.string(), label: z.string(), input: caseInput, expected: z.object({ aov: z.string(), cac: z.string(), mer: z.string() }), handCalculation: z.string() })),
  sourceNote: z.string(),
});

/** View key to the schema of `ReadResponse.data` for that view. */
export const analyticsViewSchemas: Record<string, z.ZodTypeAny> = {
  launchReconciliation: launchReconciliationSchema,
  overviewSummary: overviewSummarySchema,
  launchSnapshot: launchSnapshotSchema,
  launchControl: launchControlSchema,
  attribution: attributionSchema,
  paidMedia: paidMediaSchema,
  campaignFunnel: campaignFunnelSchema,
  customerJourney: customerJourneySchema,
  metricDictionary: metricDictionarySchema,
};
