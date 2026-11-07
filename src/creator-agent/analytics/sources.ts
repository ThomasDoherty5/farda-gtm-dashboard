import { z } from "zod";
import type { OperationsScope } from "../operations.ts";

/**
 * Trusted, server-injected source boundaries for the THO-293 analytics reads (orders, ad platforms, storefront sessions and
 * support). Each reader is optional. An absent reader is "unconfigured", never demo data and never zero. Readers return
 * unknown JSON that is validated here; a malformed answer fails closed instead of reading as empty.
 *
 * No provider credential, customer identity or message text crosses this boundary: rows carry opaque references only.
 */
export const ANALYTICS_MAX_ORDERS = 50_000;

const ref = z.string().trim().min(1).max(240);
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
const orderRow = z.object({
  orderRef: ref, placedAt: instantSchema, currency, netReceiptsMinor: minor, valid: z.boolean(),
  /** Source-assigned attribution. Null means not evaluated, which is unknown, not unattributed. */
  attribution: z.enum(["code", "utm", "platform", "unattributed"]).nullable(),
  newRetainedCustomer: z.boolean().nullable(), unitsRetained: count.nullable(),
}).strict();
export type OrderRow = z.infer<typeof orderRow>;
const orderFeed = z.object({ ...feedHeader, channel: z.enum(orderChannels), origin: z.enum(["native", "mirror"]), orders: z.array(orderRow).max(ANALYTICS_MAX_ORDERS) })
  .strict().superRefine(headerRefine);
export type OrderFeed = z.infer<typeof orderFeed>;
export const ordersSnapshotSchema = z.object({ scope: scopeSchema, window: windowSchema, feeds: z.array(orderFeed).max(8) }).strict().superRefine((s, c) => {
  if (new Set(s.feeds.map(f => f.feedRef)).size !== s.feeds.length) c.addIssue({ code: "custom", message: "Duplicate order feed." });
  if (new Set(s.feeds.map(f => `${f.channel}/${f.origin}`)).size !== s.feeds.length) c.addIssue({ code: "custom", message: "One feed per channel and origin." });
  if (s.feeds.reduce((n, f) => n + f.orders.length, 0) > ANALYTICS_MAX_ORDERS) c.addIssue({ code: "custom", message: "Too many order rows." });
  for (const f of s.feeds) if (new Set(f.orders.map(o => o.orderRef)).size !== f.orders.length) c.addIssue({ code: "custom", message: "Duplicate order within one feed." });
});
export type OrdersSnapshot = z.infer<typeof ordersSnapshotSchema>;

/* ---------- Ad platforms (Meta and TikTok) ---------- */

const campaignRow = z.object({
  campaignRef: ref,
  /** GMV Max optimises TikTok Shop GMV that the shop would partly see anyway. Its value is never treated as incremental. */
  kind: z.enum(["standard", "gmvMax"]),
  spendMinor: minor.nullable(), impressions: count, clicks: count, platformPurchaseValueMinor: minor.nullable(),
  attributionWindow: z.string().trim().min(1).max(120).nullable(),
}).strict().refine(r => r.clicks <= r.impressions, "Clicks cannot exceed impressions.");
const assetRow = z.object({ assetRef: ref, label: z.string().trim().min(1).max(120), clicks: count, impressions: count,
  rights: z.enum(["cleared", "expiring", "notGranted", "unknown"]), expiresOn: day.nullable() }).strict()
  .refine(r => r.clicks <= r.impressions, "Clicks cannot exceed impressions.");
const adFeed = z.object({ ...feedHeader, platform: z.enum(["meta", "tiktok"]), currency, campaigns: z.array(campaignRow).max(500), assets: z.array(assetRow).max(500) })
  .strict().superRefine(headerRefine).superRefine((f, c) => {
    if (new Set(f.campaigns.map(x => x.campaignRef)).size !== f.campaigns.length) c.addIssue({ code: "custom", message: "Duplicate campaign." });
    if (new Set(f.assets.map(x => x.assetRef)).size !== f.assets.length) c.addIssue({ code: "custom", message: "Duplicate asset." });
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

const star = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export const supportSnapshotSchema = z.object({ scope: scopeSchema, window: windowSchema, feed: z.object({ ...feedHeader,
  deliveredWindowDays: z.number().int().min(1).max(90), deliveredUnits: count.nullable(),
  tickets: z.array(z.object({ category: z.string().trim().min(1).max(80), count }).strict()).max(30).nullable(),
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
