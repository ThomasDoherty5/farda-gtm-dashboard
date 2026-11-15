import { z } from "zod";
import type { OperationsScope } from "../operations.ts";

/**
 * Trusted, server-injected source boundaries for the THO-293 analytics reads (orders, ad platforms, storefront sessions and
 * support). Each reader is optional. An absent reader is "unconfigured", never demo data and never zero. Readers return
 * unknown JSON that is validated here; a malformed answer makes that source "invalid" (its figures unknown), never empty.
 *
 * No provider credential, customer identity or free text crosses this boundary. References are opaque tokens (no spaces,
 * "@" or "+", so an email address or formatted phone number is refused); windows, categories and rights are enumerated
 * codes; an asset label is a short code such as "AD-01" or is replaced by an opaque alias.
 */
export const ANALYTICS_MAX_ORDERS = 50_000;
/** Tolerated difference between a source clock and this service's clock. Beyond it, an observation is unverified. */
export const CLOCK_SKEW_MS = 2 * 60_000;

const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,240}$/, "An opaque reference without free text is required.");
const realDay = (v: string) => {
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
/**
 * A finite ISO instant with an offset. `Date.parse` must agree and its calendar date must exist: V8 rolls "09-31" over to
 * 1 October, so an impossible date fails closed instead of landing in another day (no NaN or shifted timestamps).
 */
export const instantSchema = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)) && realDay(v.slice(0, 10)), "A finite, real timestamp is required.");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDay, "A real calendar date is required.");
export const timezoneSchema = z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "Unknown timezone.");
const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** The calendar day of an instant in a reporting timezone (YYYY-MM-DD). */
export function localDay(instant: number, timezone: string) {
  let format = dayFormats.get(timezone);
  if (!format) dayFormats.set(timezone, format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }));
  return format.format(new Date(instant));
}
/** Inclusive calendar window in one reporting timezone. */
export const windowSchema = z.object({ start: day, end: day, timezone: timezoneSchema }).strict().refine(w => w.start <= w.end, "Reversed reporting window.");
export type ReportingWindow = z.infer<typeof windowSchema>;
const count = z.number().int().nonnegative().safe();
const minor = z.number().int().nonnegative().safe();
const currency = z.string().regex(/^[A-Z]{3}$/);
const scopeSchema = z.object({ workspaceId: ref, accountId: ref, environment: z.literal("sandbox") }).strict();

/** What every feed says about its own sync. `noChange` is a successful sync that found nothing new. */
const feedHeader = {
  feedRef: ref, observedAt: instantSchema, lastSuccessAt: instantSchema.nullable(),
  syncState: z.enum(["ok", "noChange", "error"]), coverage: z.enum(["complete", "partial"]),
};
const headerRefine = (f: { observedAt: string; lastSuccessAt: string | null; syncState: string }, c: z.RefinementCtx) => {
  if (f.lastSuccessAt && Date.parse(f.lastSuccessAt) > Date.parse(f.observedAt)) c.addIssue({ code: "custom", message: "A success cannot postdate its observation." });
  if (f.syncState !== "error" && f.lastSuccessAt === null) c.addIssue({ code: "custom", message: "A successful sync needs its success time." });
};

/* ---------- Orders (Shopify and TikTok Shop; native source or a mirror of it) ---------- */

export const orderChannels = ["shopify", "tiktokShop"] as const;
export type OrderChannel = typeof orderChannels[number];
export const attributionReviewReasons = ["noMatchingSignal", "conflictingSignals", "unrecognizedCode", "missingTracking", "notEvaluated", "sourceUnresolved"] as const;
const orderRow = z.object({
  orderRef: ref,
  /**
   * The order's identity across channel systems, resolved by the order source (for example, a TikTok Shop order that an
   * integration also writes into Shopify carries one canonical ID). Null means identity is not established.
   */
  canonicalOrderId: ref.nullable(),
  /** The channel that owns the order. A row in another channel's feed is a copy and is never counted there. */
  recordOwner: z.enum(orderChannels),
  placedAt: instantSchema, currency,
  /** Net of refunds and cancellations posted to date for this order. Refunds of orders placed before the period are reported per feed, not here. */
  netReceiptsMinor: minor, valid: z.boolean(),
  /** Source-assigned attribution. Null means not evaluated, which is unknown, not unattributed. */
  attribution: z.enum(["code", "utm", "platform", "unattributed"]).nullable(),
  /** Who issued the discount code: a creator's code, a sitewide promotion, or not known. Present only for code attribution. */
  codeOwner: z.enum(["creator", "sitewide", "unknown"]).nullable(),
  /** Optional source explanation for an unresolved classification. Its absence is never filled with an inferred cause. */
  attributionEvidence: z.object({ reason: z.enum(attributionReviewReasons), sourceVersion: ref, observedAt: instantSchema,
    evidenceRefs: z.array(ref).min(1).max(20).refine(values => new Set(values).size === values.length),
  }).strict().nullable().optional(),
  /** Opaque, source-pseudonymous customer reference used only to count distinct customers. It is never returned. */
  customerRef: ref.nullable(),
  newRetainedCustomer: z.boolean().nullable(), unitsRetained: count.nullable(),
}).strict().refine(o => (o.attribution === "code") === (o.codeOwner !== null), "A code owner belongs only to code-attributed orders.")
  .refine(o => !o.attributionEvidence || Date.parse(o.attributionEvidence.observedAt) >= Date.parse(o.placedAt) && (
    o.attribution === null ? ["notEvaluated", "sourceUnresolved"].includes(o.attributionEvidence.reason)
      : o.attribution === "code" && o.codeOwner === "unknown" ? ["unrecognizedCode", "conflictingSignals", "sourceUnresolved"].includes(o.attributionEvidence.reason)
        : o.attribution === "unattributed" && ["noMatchingSignal", "conflictingSignals", "missingTracking", "sourceUnresolved"].includes(o.attributionEvidence.reason)
  ), "The source reason must describe this unresolved order classification.");
export type OrderRow = z.infer<typeof orderRow>;
/** Refunds posted in the period for orders placed before it. They correct the earlier period and never reduce this period's cohort. */
const priorPeriodRefunds = z.object({ count, amountMinor: minor, currency }).strict();
const orderFeed = z.object({ ...feedHeader, channel: z.enum(orderChannels), origin: z.enum(["native", "mirror"]), orders: z.array(orderRow).max(ANALYTICS_MAX_ORDERS),
  priorPeriodRefunds: priorPeriodRefunds.nullable() })
  .strict().superRefine(headerRefine).superRefine((f, c) => {
    const ids = f.orders.map(o => o.canonicalOrderId).filter((v): v is string => v !== null);
    if (new Set(ids).size !== ids.length) c.addIssue({ code: "custom", message: "Duplicate canonical order within one feed." });
    if (f.orders.some(o => o.attributionEvidence && Date.parse(o.attributionEvidence.observedAt) > Date.parse(f.observedAt))) c.addIssue({ code: "custom", message: "An order reason cannot postdate its source observation." });
  });
export type OrderFeed = z.infer<typeof orderFeed>;
export const ordersSnapshotSchema = z.object({ scope: scopeSchema, window: windowSchema, feeds: z.array(orderFeed).max(8) }).strict().superRefine((s, c) => {
  if (new Set(s.feeds.map(f => f.feedRef)).size !== s.feeds.length) c.addIssue({ code: "custom", message: "Duplicate order feed." });
  if (new Set(s.feeds.map(f => `${f.channel}/${f.origin}`)).size !== s.feeds.length) c.addIssue({ code: "custom", message: "One feed per channel and origin." });
  if (s.feeds.reduce((n, f) => n + f.orders.length, 0) > ANALYTICS_MAX_ORDERS) c.addIssue({ code: "custom", message: "Too many order rows." });
  for (const f of s.feeds) if (new Set(f.orders.map(o => o.orderRef)).size !== f.orders.length) c.addIssue({ code: "custom", message: "Duplicate order within one feed." });
});
export type OrdersSnapshot = z.infer<typeof ordersSnapshotSchema>;

/* ---------- Ad platforms (Meta and TikTok) ---------- */

export const attributionWindowSchema = z.object({ clickDays: z.number().int().min(0).max(28), viewDays: z.number().int().min(0).max(7) }).strict()
  .refine(w => w.clickDays + w.viewDays > 0, "An attribution window needs a click or view duration.");
export type AttributionWindow = z.infer<typeof attributionWindowSchema>;
export const assetRights = ["cleared", "expiring", "expired", "notGranted", "unknown"] as const;
/** Source-declared uses for one exact asset/platform/account. Reading these never authorizes reuse. */
export const adAssetUsageScopes = ["paidAdvertising", "creatorHandleAdvertising", "organicRepost"] as const;
export const adAssetRightsGrantSchema = z.object({
  assetRef: ref, platform: z.enum(["meta", "tiktok"]), accountRef: ref, sourceVersion: ref,
  usageScope: z.array(z.enum(adAssetUsageScopes)).min(1).max(3).refine(values => new Set(values).size === values.length),
  agreementRef: ref, agreementVersion: ref, grantVersion: ref,
  evidenceRefs: z.array(ref).min(1).max(20).refine(values => new Set(values).size === values.length),
  observedAt: instantSchema,
  /** Null means no recorded expiry; it is not an inferred perpetual grant. */
  expiresOn: day.nullable(),
}).strict();
export type AdAssetRightsGrant = z.infer<typeof adAssetRightsGrantSchema>;
const campaignRow = z.object({
  campaignRef: ref,
  /** GMV Max optimises TikTok Shop GMV that the shop would partly see anyway. Its value is never treated as incremental. */
  kind: z.enum(["standard", "gmvMax"]),
  spendMinor: minor.nullable(), impressions: count, clicks: count, platformPurchaseValueMinor: minor.nullable(),
  /** The platform's attribution window as a structured duration; null when the platform did not state it. */
  attributionWindow: attributionWindowSchema.nullable(),
}).strict().refine(r => r.clicks <= r.impressions, "Clicks cannot exceed impressions.");
/** An asset label is a short code ("AD-01"), never a caption, handle or name; without one the asset is shown by an opaque alias. */
const assetRow = z.object({ assetRef: ref, label: z.string().regex(/^[A-Z]{2,6}-\d{1,6}$/).nullable(), clicks: count, impressions: count,
  rights: z.enum(assetRights), expiresOn: day.nullable(), rightsGrant: adAssetRightsGrantSchema.nullable().optional() }).strict()
  .refine(r => r.clicks <= r.impressions, "Clicks cannot exceed impressions.")
  .refine(r => !r.rightsGrant || r.rightsGrant.assetRef === r.assetRef && r.rightsGrant.expiresOn === r.expiresOn && r.rights !== "notGranted", "A grant must describe this exact asset and recorded expiry.");
const adFeed = z.object({ ...feedHeader, platform: z.enum(["meta", "tiktok"]), currency, campaigns: z.array(campaignRow).max(500), assets: z.array(assetRow).max(500) })
  .strict().superRefine(headerRefine).superRefine((f, c) => {
    if (new Set(f.campaigns.map(x => x.campaignRef)).size !== f.campaigns.length) c.addIssue({ code: "custom", message: "Duplicate campaign." });
    if (new Set(f.assets.map(x => x.assetRef)).size !== f.assets.length) c.addIssue({ code: "custom", message: "Duplicate asset." });
    for (const asset of f.assets) if (asset.rightsGrant && (asset.rightsGrant.platform !== f.platform || Date.parse(asset.rightsGrant.observedAt) > Date.parse(f.observedAt)))
      c.addIssue({ code: "custom", message: "A grant must belong to the observed asset platform." });
  });
export type AdFeed = z.infer<typeof adFeed>;
export const adPlatformsSnapshotSchema = z.object({ scope: scopeSchema, window: windowSchema, feeds: z.array(adFeed).max(4) }).strict().superRefine((s, c) => {
  if (new Set(s.feeds.map(f => f.platform)).size !== s.feeds.length) c.addIssue({ code: "custom", message: "One feed per ad platform; a second copy would double count spend." });
});
export type AdPlatformsSnapshot = z.infer<typeof adPlatformsSnapshotSchema>;

/* ---------- Storefront sessions (one selected source, so traffic is not double counted) ---------- */

export const sessionsSnapshotSchema = z.object({ scope: scopeSchema, window: windowSchema, feed: z.object({ ...feedHeader, storefront: z.literal("shopify"),
  sessions: count.nullable(), productViewed: count.nullable(), checkoutStarted: count.nullable() }).strict().superRefine(headerRefine).superRefine((f, c) => {
  if (f.sessions !== null && f.productViewed !== null && f.productViewed > f.sessions || f.productViewed !== null && f.checkoutStarted !== null && f.checkoutStarted > f.productViewed)
    c.addIssue({ code: "custom", message: "Funnel stages must narrow." });
}) }).strict();
export type SessionsSnapshot = z.infer<typeof sessionsSnapshotSchema>;

/* ---------- Support, returns and reviews ---------- */

export const ticketCategories = ["setup", "delivery", "returns", "product", "billing", "account", "other"] as const;
const star = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export const supportSnapshotSchema = z.object({ scope: scopeSchema, window: windowSchema, feed: z.object({ ...feedHeader,
  deliveredWindowDays: z.number().int().min(1).max(90), deliveredUnits: count.nullable(),
  tickets: z.array(z.object({ category: z.enum(ticketCategories), count }).strict()).max(30).nullable(),
  resolution: z.object({ byAutomation: count, byPeople: count, open: count }).strict().nullable(),
  returns: z.object({ returned: count, received: count, awaitingInspection: count, restocked: count, quarantined: count }).strict().nullable(),
  reviews: z.object({ ratedCount: count.nullable(), stars: z.array(z.object({ star, count }).strict()).length(5).nullable() }).strict(),
}).strict().superRefine(headerRefine).superRefine((f, c) => {
  if (f.tickets && new Set(f.tickets.map(t => t.category)).size !== f.tickets.length) c.addIssue({ code: "custom", message: "Duplicate ticket category." });
  if (f.reviews.stars && new Set(f.reviews.stars.map(s => s.star)).size !== 5) c.addIssue({ code: "custom", message: "One row per star." });
  const rated = f.reviews.stars?.reduce((n, s) => n + s.count, 0);
  if (rated !== undefined && f.reviews.ratedCount !== null && rated !== f.reviews.ratedCount) c.addIssue({ code: "custom", message: "Star rows must sum to the rated count." });
  if (f.returns && (f.returns.received > f.returns.returned || f.returns.restocked + f.returns.quarantined + f.returns.awaitingInspection > f.returns.received))
    c.addIssue({ code: "custom", message: "Return stages must narrow." });
}) }).strict();
export type SupportSnapshot = z.infer<typeof supportSnapshotSchema>;

/* ---------- Readers and errors ---------- */

export type AnalyticsSourceRequest = { scope: OperationsScope; window: ReportingWindow };
export type AnalyticsSourceReader = (request: AnalyticsSourceRequest) => Promise<unknown>;
export type AnalyticsSources = { orders?: AnalyticsSourceReader; adPlatforms?: AnalyticsSourceReader; sessions?: AnalyticsSourceReader; support?: AnalyticsSourceReader };
export type AnalyticsSourceKey = keyof AnalyticsSources;
export const analyticsSourceKeys = ["orders", "adPlatforms", "sessions", "support"] as const satisfies readonly AnalyticsSourceKey[];

/**
 * D-13 allowed age before a successful sync counts as stale. Orders and ad platforms are the decided values. Sessions and
 * support are not named in D-13; 24 hours is a proposed default that the backend owner may change.
 */
export const FRESHNESS_LIMIT_MS: Record<AnalyticsSourceKey, number> = {
  orders: 15 * 60_000, adPlatforms: 26 * 3_600_000, sessions: 24 * 3_600_000, support: 24 * 3_600_000,
};

/** A typed failure carried as a canonical D-14 error body by the server. */
export class AnalyticsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, status: number, message: string, retryable = false) {
    super(message); this.code = code; this.status = status; this.retryable = retryable;
  }
}
