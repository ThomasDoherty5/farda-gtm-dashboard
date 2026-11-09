import type { OperationsScope } from "../operations.ts";
import { daysOf } from "./reader.ts";
import type { AdPlatformsSnapshot, AnalyticsSourceRequest, AnalyticsSources, OrderRow, OrdersSnapshot, SessionsSnapshot, SupportSnapshot } from "./sources.ts";

/**
 * Fictional analytics sources for tests only. No real customer, order, provider account or credential.
 * Hand-checked headline (the original example, never mixed with the pilot 1,800 / 270 data):
 *   Shopify 259 × $32.17 + 1 × $31.97 = $8,364.00 over 260 orders; TikTok Shop 139 × $30.23 + 1 × $30.03 = $4,232.00 over 140 orders.
 *   Total $12,596.00 over 400 valid orders, so AOV = 1,259,600 ÷ 400 = 3,149 cents ($31.49).
 *   Attribution: discount code 180 (Shopify 100 creator + 20 sitewide; TikTok Shop 60 creator), UTM 120, platform 60, unattributed 40.
 *   Creator-code orders 160; creator-code net receipts 100 × 3,217 + 60 × 3,023 = 503,080 cents (sitewide promotions excluded).
 *   290 orders are flagged new-retained, from 280 distinct customers (10 Shopify customers ordered twice); retained units 400 − 22 = 378.
 *   Prior-period refund corrections: Shopify 3 refunds, 9,000 cents; TikTok Shop 0. They are not subtracted from this period's net receipts.
 *   Meta ROAS 630,000 ÷ 300,000 = 2.1. TikTok standard ROAS 480,000 ÷ 200,000 = 2.4 (GMV Max $1,500 spend reported apart, never in ROAS).
 *   Paid media spend 300,000 + 200,000 + 150,000 = 650,000 cents. Conversion 260 ÷ 16,000 = 1.625%. Support 22 ÷ 380 × 100 ≈ 5.79.
 */
export const analyticsTestScope: OperationsScope = { workspaceId: "synthetic-analytics-workspace", accountId: "synthetic-analytics-account", environment: "sandbox" };
export const analyticsTestTime = Date.parse("2026-11-06T20:00:00Z");
export const analyticsTestTimezone = "America/Los_Angeles";
export const analyticsTestSecret = "synthetic-analytics-private-key-0000000000000000000";

const iso = (t: number) => new Date(t).toISOString();
function placedDays(request: AnalyticsSourceRequest) {
  const days = daysOf(request.window);
  return days.length > 1 ? days.slice(0, -1) : days;
}
function orderRows(request: AnalyticsSourceRequest, channel: "shopify" | "tiktokShop"): OrderRow[] {
  const days = placedDays(request);
  const n = channel === "shopify" ? 260 : 140;
  return Array.from({ length: n }, (_, i): OrderRow => {
    const amount = channel === "shopify" ? (i === n - 1 ? 3197 : 3217) : (i === n - 1 ? 3003 : 3023);
    const attribution = channel === "shopify" ? (i < 120 ? "code" : i < 220 ? "utm" : "unattributed") : (i < 60 ? "code" : i < 80 ? "utm" : "platform");
    const codeOwner = attribution !== "code" ? null : channel === "shopify" && i >= 100 ? "sitewide" : "creator";
    const flagged = channel === "shopify" ? i < 200 : i < 90;
    // Ten Shopify customers place a second first-period order, so 290 flagged orders come from 280 distinct customers.
    const customerRef = flagged ? `cust-${channel}-${channel === "shopify" && i >= 190 ? i - 190 : i}` : `cust-${channel}-other-${i}`;
    return { orderRef: `synthetic-${channel}-order-${i}`, canonicalOrderId: `canon-${channel}-${i}`, recordOwner: channel, placedAt: `${days[i % days.length]}T20:00:00Z`,
      currency: "USD", netReceiptsMinor: amount, valid: true, attribution, codeOwner, customerRef, newRetainedCustomer: flagged,
      unitsRetained: channel === "shopify" ? (i >= 240 ? 0 : 1) : (i === 130 || i === 131 ? 0 : 1) };
  });
}
export function ordersFixture(request: AnalyticsSourceRequest, now = analyticsTestTime): OrdersSnapshot {
  const header = { observedAt: iso(now - 60_000), lastSuccessAt: iso(now - 5 * 60_000), syncState: "ok" as const, coverage: "complete" as const };
  return { scope: { ...request.scope }, window: { ...request.window }, feeds: [
    { ...header, feedRef: "synthetic-shopify-orders", channel: "shopify", origin: "native", orders: orderRows(request, "shopify"), priorPeriodRefunds: { count: 3, amountMinor: 9_000, currency: "USD" } },
    { ...header, feedRef: "synthetic-tiktok-shop-orders", channel: "tiktokShop", origin: "native", orders: orderRows(request, "tiktokShop"), priorPeriodRefunds: { count: 0, amountMinor: 0, currency: "USD" } },
  ] };
}
export function adPlatformsFixture(request: AnalyticsSourceRequest, now = analyticsTestTime): AdPlatformsSnapshot {
  const header = { observedAt: iso(now - 60_000), lastSuccessAt: iso(now - 2 * 3_600_000), syncState: "ok" as const, coverage: "complete" as const, currency: "USD" };
  return { scope: { ...request.scope }, window: { ...request.window }, feeds: [
    { ...header, feedRef: "synthetic-meta-ads", platform: "meta",
      campaigns: [{ campaignRef: "synthetic-meta-campaign", kind: "standard", spendMinor: 300_000, impressions: 500_000, clicks: 10_000, platformPurchaseValueMinor: 630_000, attributionWindow: { clickDays: 7, viewDays: 1 } }],
      assets: [{ assetRef: "synthetic-meta-asset-1", label: "AD-01", clicks: 280, impressions: 10_000, rights: "cleared", expiresOn: null }] },
    { ...header, feedRef: "synthetic-tiktok-ads", platform: "tiktok",
      campaigns: [
        { campaignRef: "synthetic-tiktok-campaign", kind: "standard", spendMinor: 200_000, impressions: 300_000, clicks: 6_000, platformPurchaseValueMinor: 480_000, attributionWindow: { clickDays: 7, viewDays: 0 } },
        { campaignRef: "synthetic-tiktok-gmv-max", kind: "gmvMax", spendMinor: 150_000, impressions: 100_000, clicks: 2_000, platformPurchaseValueMinor: 900_000, attributionWindow: null },
      ],
      assets: [
        { assetRef: "synthetic-tiktok-asset-1", label: "AD-03", clicks: 120, impressions: 6_000, rights: "expiring", expiresOn: "2026-11-18" },
        { assetRef: "synthetic-tiktok-asset-2", label: null, clicks: 64, impressions: 4_000, rights: "notGranted", expiresOn: null },
      ] },
  ] };
}
export function sessionsFixture(request: AnalyticsSourceRequest, now = analyticsTestTime): SessionsSnapshot {
  return { scope: { ...request.scope }, window: { ...request.window }, feed: { feedRef: "synthetic-storefront-sessions", observedAt: iso(now - 60_000), lastSuccessAt: iso(now - 3_600_000),
    syncState: "ok", coverage: "complete", storefront: "shopify", sessions: 16_000, productViewed: 2_400, checkoutStarted: 980 } };
}
export function supportFixture(request: AnalyticsSourceRequest, now = analyticsTestTime): SupportSnapshot {
  return { scope: { ...request.scope }, window: { ...request.window }, feed: { feedRef: "synthetic-support-desk", observedAt: iso(now - 60_000), lastSuccessAt: iso(now - 3_600_000),
    syncState: "ok", coverage: "complete", deliveredWindowDays: 14, deliveredUnits: 380,
    tickets: [{ category: "setup", count: 12 }, { category: "delivery", count: 6 }, { category: "returns", count: 4 }],
    resolution: { byAutomation: 9, byPeople: 11, open: 2 }, returns: { returned: 9, received: 7, awaitingInspection: 2, restocked: 4, quarantined: 1 },
    reviews: { ratedCount: 50, stars: [{ star: 1, count: 1 }, { star: 2, count: 2 }, { star: 3, count: 5 }, { star: 4, count: 12 }, { star: 5, count: 30 }] } } };
}
/** All four synthetic readers, echoing the requested scope and window. `now` lets a browser test use the wall clock. */
export function syntheticAnalyticsSources(now: () => number = () => analyticsTestTime): Required<AnalyticsSources> {
  return {
    orders: async request => ordersFixture(request, now()), adPlatforms: async request => adPlatformsFixture(request, now()),
    sessions: async request => sessionsFixture(request, now()), support: async request => supportFixture(request, now()),
  };
}
