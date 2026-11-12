import { z } from "zod";
import { digestLinksSchema, digestScopeSchema } from "../dailyDigest/contract.ts";
import { weeklyTimezone } from "./schedule.ts";

const instant = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const ref = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(value => !value.includes("://"));
const currency = z.string().regex(/^[A-Z]{3}$/);
const amount = z.number().int().safe();
export const weeklySections = ["headline", "channels", "creators", "content", "cashMedia", "support"] as const;
const links = digestLinksSchema.shape.launch;
export const weeklyLinksSchema = z.object({
  headline: links, channels: links, creators: links, content: links, cashMedia: links, support: links,
}).strict();

// The source supplies versioned definitions and values, never arbitrary metric labels.
export const weeklyMetrics = {
  retainedUnits: ["headline", "Retained units", "count", "total"],
  retainedOrders: ["headline", "Retained orders", "count", "total"],
  netReceipts: ["headline", "Net receipts", "money", "total"],
  contribution: ["headline", "Contribution", "money", "total"],
  aov: ["headline", "AOV", "money", "total"],
  costPerRetainedOrder: ["headline", "Cost per retained order", "money", "total"],
  channelReceipts: ["channels", "Net receipts", "money", "channel"],
  channelContribution: ["channels", "Contribution per retained order", "money", "channel"],
  attributedOrders: ["channels", "Orders", "count", "attribution"],
  platformRoas: ["channels", "Platform-reported ROAS", "multiple", "channel"],
  contacts: ["creators", "Contacts", "count", "total"],
  agreements: ["creators", "Agreements", "count", "total"],
  samples: ["creators", "Samples", "count", "total"],
  deliveredSamples: ["creators", "Delivered", "count", "total"],
  livePosts: ["creators", "Posts live", "count", "total"],
  maturePostingEligible: ["creators", "Mature deliverables due", "count", "total"],
  maturePostingVerified: ["creators", "Mature deliverables posted", "count", "total"],
  maturePostingRate: ["creators", "Mature posting rate", "percentage", "total"],
  postViews: ["content", "Views", "count", "total"],
  postClicks: ["content", "Clicks", "count", "total"],
  adReadyAssets: ["content", "Ad-ready assets", "count", "total"],
  expiringRights: ["content", "Rights expiring in 30 days", "count", "total"],
  cashActual: ["cashMedia", "Actual", "money", "total"],
  cashCommitted: ["cashMedia", "Committed", "money", "total"],
  cashForecast: ["cashMedia", "Remaining forecast", "money", "total"],
  cashCeiling: ["cashMedia", "Approved ceiling", "money", "total"],
  budgetAlerts: ["cashMedia", "Budget alerts", "count", "total"],
  mediaSpend: ["cashMedia", "Media spend", "money", "stage"],
  mediaCap: ["cashMedia", "Stage cap", "money", "stage"],
  stock: ["cashMedia", "Stock on hand", "count", "total"],
  supportCases: ["support", "Cases", "count", "supportCategory"],
  resolutionTime: ["support", "Median resolution days", "daysHundredths", "total"],
  averageRating: ["support", "Average rating", "ratingHundredths", "platform"],
} as const;
export type WeeklyMetric = keyof typeof weeklyMetrics;
const metricKeys = Object.keys(weeklyMetrics) as [WeeklyMetric, ...WeeklyMetric[]];
const dimensions = {
  total: ["all"],
  channel: ["shopify", "tiktokShop"],
  attribution: ["discountCode", "utm", "platformReported", "unattributed", "unknown"],
  stage: ["stageOne", "stageTwo", "stageThree"],
  supportCategory: ["setup", "shipping", "returns", "product", "other", "unknown"],
  platform: ["shopify", "tiktokShop", "appStore"],
} as const;
const dimension = z.enum([...new Set(Object.values(dimensions).flat())] as [string, ...string[]]);
export const weeklyExpectedMeasures = metricKeys.flatMap(metric =>
  dimensions[weeklyMetrics[metric][3]].map(dimension => ({ metric, dimension })));
const version = z.string().regex(/^v[1-9]\d{0,6}$/);
const value = z.object({
  amount: amount.nullable(), currency: currency.nullable(), decimals: z.number().int().min(0).max(4).nullable(),
  coverage: z.enum(["complete", "notApplicable", "partial", "unavailable"]), sourceRef: ref, sourceVersion: ref, asOf: instant.nullable(),
}).strict();
export const weeklyMeasureSchema = z.object({
  metric: z.enum(metricKeys), dimension, definition: ref, actual: value,
  forecast: value.extend({ scenario: ref, definition: ref }).strict().nullable(),
}).strict().superRefine((measure, ctx) => {
  const [, , unit, group] = weeklyMetrics[measure.metric];
  const permitted: readonly string[] = dimensions[group];
  for (const measurement of [measure.actual, measure.forecast]) {
    if (!measurement) continue;
    if ((measurement.amount !== null) !== (measurement.coverage === "complete") ||
        (["complete", "notApplicable"].includes(measurement.coverage) && !measurement.asOf) ||
        (measurement.currency === null) !== (measurement.decimals === null)) {
      ctx.addIssue({ code: "custom", message: "A known amount requires complete evidence and a source observation time." });
    }
    if ((measurement.currency !== null && unit !== "money") || (measurement.amount !== null && unit === "money" && !measurement.currency) ||
        (measurement.amount !== null && unit !== "money" && (measurement.amount < 0 ||
          (unit === "percentage" && measurement.amount > 10_000) ||
          (unit === "ratingHundredths" && (measurement.amount < 100 || measurement.amount > 500))))) {
      ctx.addIssue({ code: "custom", message: "Weekly measurement units and bounds must match the metric." });
    }
  }
  if (!permitted.includes(measure.dimension)) ctx.addIssue({ code: "custom", message: "Unsupported weekly metric dimension." });
});
export type WeeklyMeasure = z.infer<typeof weeklyMeasureSchema>;

export const weeklyWindowSchema = z.object({
  reportDate: z.string().date(), timezone: z.literal(weeklyTimezone), start: instant, end: instant, scheduledAt: instant,
}).strict();
const ranked = z.object({ label: z.string().regex(/^[a-f0-9]{12}$/), rank: z.number().int().min(1).max(5) }).strict();
const releaseDecision = z.object({
  stage: z.enum(dimensions.stage), state: z.enum(["held", "reviewDue", "released", "unknown"]),
  dueAt: instant.nullable(), sourceVersion: ref,
}).strict().refine(decision => decision.state !== "reviewDue" || decision.dueAt !== null);
export const weeklyFactsSchema = z.object({
  scope: digestScopeSchema, window: weeklyWindowSchema, version, capturedAt: instant,
  sourceVersion: ref, coverage: z.enum(["complete", "partial"]),
  measures: z.array(weeklyMeasureSchema).max(weeklyExpectedMeasures.length),
  rankings: z.object({
    collaborations: z.array(ranked).max(5), postsByViews: z.array(ranked).max(3), postsByCtr: z.array(ranked).max(3),
  }).strict(),
  mediaDecisions: z.array(releaseDecision).max(3),
  correction: z.object({ priorVersion: version, priorDigest: z.string().regex(/^[a-f0-9]{64}$/), receiptRef: ref }).strict().nullable(),
}).strict().superRefine((facts, ctx) => {
  const measureKeys = facts.measures.map(measure => measure.metric + "/" + measure.dimension);
  const start = Date.parse(facts.window.start), end = Date.parse(facts.window.end), capture = Date.parse(facts.capturedAt);
  if (start >= end || end > capture || new Set(measureKeys).size !== measureKeys.length ||
      new Set(facts.mediaDecisions.map(decision => decision.stage)).size !== facts.mediaDecisions.length ||
      (facts.coverage === "complete" && (facts.measures.length !== weeklyExpectedMeasures.length ||
        facts.measures.some(measure => !["complete", "notApplicable"].includes(measure.actual.coverage)))) ||
      facts.measures.some(({ actual, forecast }) =>
        (actual.asOf && (Date.parse(actual.asOf) > capture ||
          (["complete", "notApplicable"].includes(actual.coverage) && Date.parse(actual.asOf) < end))) ||
        (forecast?.asOf && Date.parse(forecast.asOf) > capture))) {
    ctx.addIssue({ code: "custom", message: "Weekly evidence must cover the exact completed window without duplicate measurements." });
  }
  const mature = facts.measures.find(measure => measure.metric === "maturePostingEligible")?.actual.amount;
  const posted = facts.measures.find(measure => measure.metric === "maturePostingVerified")?.actual.amount;
  const rate = facts.measures.find(measure => measure.metric === "maturePostingRate")?.actual.amount;
  if ((posted != null && mature != null && posted > mature) ||
      (rate != null && (mature == null || mature === 0 || posted == null || rate !== Math.round(posted / mature * 10_000)))) {
    ctx.addIssue({ code: "custom", message: "Mature posting rates require the corresponding verified numerator and denominator." });
  }
  for (const group of Object.values(facts.rankings)) {
    if (group.some((entry, index) => entry.rank !== index + 1) ||
        new Set(group.map(entry => entry.label.toLowerCase())).size !== group.length) {
      ctx.addIssue({ code: "custom", message: "Rankings require unique ordered source evidence." });
    }
  }
});
export type WeeklyFacts = z.infer<typeof weeklyFactsSchema>;
