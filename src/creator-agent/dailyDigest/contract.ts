import { z } from "zod";
import { thresholdDigestSchema } from "../operationalAlerts/presentation.ts";

export const digestTimezone = "America/Los_Angeles";
export const digestDatasets = [
  "launch", "creators", "content", "orders", "media", "support", "reviews", "stock", "freshness",
] as const;
export type DigestDataset = typeof digestDatasets[number];
export const digestSections = ["launch", "creators", "content", "commerce", "supportStock"] as const;
export type DigestSection = typeof digestSections[number];
export const digestDatasetSection: Record<DigestDataset, DigestSection> = {
  launch: "launch", creators: "creators", content: "content",
  orders: "commerce", media: "commerce",
  support: "supportStock", reviews: "supportStock", stock: "supportStock", freshness: "supportStock",
};

const ref = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(value => !value.includes("://"));
const instant = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const count = z.number().int().safe().nonnegative();
const handle = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.]{0,39}$/)
  .refine(value => !/^(here|channel|everyone)$/i.test(value));
const money = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  minorUnits: z.number().int().safe(),
  decimals: z.number().int().min(0).max(4),
}).strict();
const sourceTimezone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
  catch { return false; }
});
export const digestScopeSchema = z.object({
  workspaceId: ref, accountId: ref, environment: z.literal("sandbox"),
}).strict();
export type DigestScope = z.infer<typeof digestScopeSchema>;

export const digestCohortSchema = z.object({
  ref, version: ref, scope: digestScopeSchema,
  startsAt: instant, endsAt: instant,
}).strict().refine(value => Date.parse(value.startsAt) < Date.parse(value.endsAt));
export type DigestCohort = z.infer<typeof digestCohortSchema>;
export const digestWindowSchema = z.object({
  reportDate: z.string().date(), scheduledAt: instant, start: instant, end: instant,
  nextDayStart: instant, timezone: z.literal(digestTimezone), cohort: digestCohortSchema.nullable(),
}).strict();
export type DigestWindow = z.infer<typeof digestWindowSchema>;

const evidenceLink = z.string().url().max(180).refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || /[<>|\s]/.test(value)) return false;
  if (url.hostname === "linear.app") {
    return !url.search && /^\/[a-z0-9-]+\/(issue|document|project)\/[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?$/.test(url.pathname);
  }
  if (!["app.notion.com", "www.notion.so", "notion.so"].includes(url.hostname)) return false;
  return /[a-f0-9]{32}$|[a-f0-9-]{36}$/i.test(url.pathname) &&
    (!url.search || /^\?v=[a-f0-9-]{32,36}$/i.test(url.search));
});
export const digestLinksSchema = z.object({
  launch: evidenceLink, creators: evidenceLink, content: evidenceLink, commerce: evidenceLink, supportStock: evidenceLink,
}).strict();
export const digestSourceBindingSchema = z.object({
  sourceRef: ref, bindingVersion: ref, timezone: sourceTimezone, permissionRef: ref,
}).strict();
export type DigestSourceBinding = z.infer<typeof digestSourceBindingSchema>;

const row = z.object({ ref });
const launchRow = row.extend({
  dataset: z.literal("launch"), type: z.enum(["task", "approval"]), open: z.boolean(),
  priority: z.enum(["P0", "other"]).nullable(), ownerAssigned: z.boolean().nullable(),
  dueAt: instant.nullable(), openedAt: instant.nullable(),
}).strict();
const creatorRow = row.extend({
  dataset: z.literal("creators"), handle: handle.nullable(), followUpPending: z.boolean(),
  followUpDueAt: instant.nullable(), sampleDeliveredAt: instant.nullable(),
  postState: z.enum(["verified", "awaiting", "unknown", "notRequired"]), postingDueAt: instant.nullable(),
  dataCheck: z.boolean(),
}).strict();
const contentRow = row.extend({
  dataset: z.literal("content"), state: z.enum(["review", "live", "other"]), reviewDueAt: instant.nullable(),
  rights: z.enum(["finite", "perpetual", "none", "unknown"]), rightsExpiresAt: instant.nullable(),
  metricsAsOf: instant.nullable(),
}).strict();
const orderRow = row.extend({
  dataset: z.literal("orders"), type: z.literal("order"), placedAt: instant, validOrder: z.boolean(),
  retainedUnits: count.nullable(), netReceipts: money.nullable(),
  check: z.enum(["clear", "failed", "unattributed", "unknown"]),
}).strict();
const refundRow = row.extend({
  dataset: z.literal("orders"), type: z.literal("refund"), occurredAt: instant,
  refund: money.extend({ minorUnits: count }).nullable(),
}).strict();
const mediaRow = row.extend({
  dataset: z.literal("media"), start: instant, end: instant, spend: money.extend({ minorUnits: count }).nullable(),
  stage: z.object({ spent: money.extend({ minorUnits: count }), limit: money.extend({ minorUnits: count.positive() }) }).strict().nullable(),
  stageState: z.enum(["released", "held", "unknown", "notApplicable"]),
}).strict();
const supportRow = row.extend({ dataset: z.literal("support"), open: z.boolean(), currentOpenedAt: instant.nullable() }).strict();
const reviewRow = row.extend({ dataset: z.literal("reviews"), postedAt: instant, stars: z.number().int().min(1).max(5).nullable() }).strict();
const stockRow = row.extend({ dataset: z.literal("stock"), available: count.nullable(), low: z.boolean().nullable() }).strict();
const freshnessRow = row.extend({
  dataset: z.literal("freshness"),
  state: z.enum(["current", "noChange", "stale", "partial", "failed", "revoked", "unknown", "neverSynced"]),
  adImport: z.object({ lastSuccessAt: instant.nullable() }).strict().optional(),
}).strict();
const digestRowSchema = z.union([launchRow, creatorRow, contentRow, orderRow, refundRow, mediaRow, supportRow, reviewRow, stockRow, freshnessRow]);
export type DigestRow = z.infer<typeof digestRowSchema>;

export const digestPageSchema = z.object({
  scope: digestScopeSchema, dataset: z.enum(digestDatasets), binding: digestSourceBindingSchema,
  start: instant, end: instant, scheduledAt: instant, snapshotRef: ref, sourceVersion: ref,
  sourceAsOf: instant, observedAt: instant, coverage: z.enum(["complete", "partial"]),
  rows: z.array(digestRowSchema).max(100),
  nextCursor: z.string().min(1).max(1024).nullable(), exhausted: z.boolean(),
}).strict();
export type DigestPage = z.infer<typeof digestPageSchema>;
export const digestCoverageSchema = digestPageSchema.pick({
  binding: true, snapshotRef: true, sourceVersion: true, sourceAsOf: true, observedAt: true,
}).extend({ pages: count.positive(), rows: count, exhausted: z.literal(true) }).strict();
export type DigestCoverage = z.infer<typeof digestCoverageSchema>;

export const digestCountLabels = {
  overdueP0: "Overdue P0", nextP0: "P0 due in 48h", ownerless: "Unassigned due in 7d",
  pendingApprovals: "Approvals waiting over 24h", followUps: "Follow-ups due today",
  noPost: "Past posting deadline", awaitingPost: "Delivered, awaiting post", creatorChecks: "Creator data checks",
  overdueReview: "Overdue reviews", expiringRights: "Rights expiring in 7d", staleMetrics: "Stale post metrics",
  orders: "Orders", retainedUnits: "Retained units", orderChecks: "Orders needing attention",
  capWarnings: "Stage cap warnings", agedSupport: "Open support over 48h", lowReviews: "New reviews ≤2 stars",
  availableStock: "Available stock", lowStock: "Low-stock positions", staleSources: "Stale or failed syncs",
  missedAdImports: "Missed ad imports",
} as const;
export type DigestCount = keyof typeof digestCountLabels;
const digestCountKeys = Object.keys(digestCountLabels) as [DigestCount, ...DigestCount[]];
export const digestAmountLabels = {
  netReceipts: "Net receipts", refunds: "Refunds", adSpend: "Ad spend", stageSpent: "Stage spent", stageLimit: "Stage cap",
} as const;
export type DigestAmount = keyof typeof digestAmountLabels;
const amountKeys = Object.keys(digestAmountLabels) as [DigestAmount, ...DigestAmount[]];

export const digestResultSchema = z.object({
  dataset: z.enum(digestDatasets), state: z.enum(["complete", "partial", "unavailable"]),
  reason: z.enum(["unconfigured", "readFailed", "permissionDenied", "partialCoverage", "unknownFields"]).nullable(),
  coverage: digestCoverageSchema.nullable(), exceptions: count,
  counts: z.array(z.object({ key: z.enum(digestCountKeys), value: count }).strict()).max(6),
  amounts: z.array(money.extend({ key: z.enum(amountKeys) }).strict()).max(8),
  handles: z.array(handle).max(3),
  exceptionLastSuccessAt: instant.nullable().optional(),
}).strict().superRefine((result, ctx) => {
  if ((result.state === "complete") !== (result.reason === null) ||
      (result.state === "complete" && !result.coverage) ||
      (result.coverage === null && (result.counts.length || result.amounts.length || result.handles.length || result.exceptions))) {
    ctx.addIssue({ code: "custom", message: "Digest results require consistent source coverage." });
  }
  if (result.exceptionLastSuccessAt !== undefined &&
      (!result.coverage || result.exceptions === 0 || !["content", "freshness"].includes(result.dataset) ||
        (result.dataset === "content" && result.exceptionLastSuccessAt === null) ||
        (result.exceptionLastSuccessAt !== null && Date.parse(result.exceptionLastSuccessAt) > Date.parse(result.coverage.sourceAsOf)))) {
    ctx.addIssue({ code: "custom", message: "Exception success times require observed source coverage." });
  }
});
export type DigestResult = z.infer<typeof digestResultSchema>;
export const dailyDigestContextSchema = z.object({
  window: digestWindowSchema, links: digestLinksSchema, results: z.array(digestResultSchema).length(digestDatasets.length),
  thresholdAlerts: thresholdDigestSchema.optional(),
}).strict().refine(value => digestDatasets.every((dataset, index) => value.results[index]?.dataset === dataset));
export type DailyDigestContext = z.infer<typeof dailyDigestContextSchema>;

export function digestAllClear(context: DailyDigestContext): boolean {
  const thresholds = context.thresholdAlerts;
  return context.results.every(result => result.state === "complete" && result.exceptions === 0) &&
    (!thresholds || thresholds.state === "complete" && thresholds.active === 0 && thresholds.activeRed === 0 && thresholds.incomplete === 0);
}
