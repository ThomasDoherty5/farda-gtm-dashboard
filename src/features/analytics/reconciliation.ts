import type { AttributionData, CustomerJourneyData, PaidMediaData } from "@/fixtures/analytics";
import type { MonitorPost } from "@/fixtures/monitor";
import type { OverviewData } from "@/fixtures/overview";

/** One place a figure appears. `value` is the exact number (cents for money), so cells compare without rounding. */
export type MatrixCell = { page: string; route: string; value: number | null; note?: string };
export type MatrixRow = { metric: string; unit: "usd" | "count"; cells: MatrixCell[]; status: "matches" | "differs" | "unknown"; reason: string | null };

export type ReconciliationInputs = {
  overview: OverviewData;
  attribution: AttributionData;
  paidMedia: PaidMediaData;
  journey: CustomerJourneyData;
  posts: MonitorPost[];
};

const known = <T,>(v: { state: string; value: T | null }) => (v.state === "known" ? v.value : null);
const sumNullable = (values: (number | null)[]) => (values.some((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0));

/**
 * The overview-to-detail reconciliation matrix (GTM275-06/09). Each row is one metric and every page that states it. A row matches
 * only when all known cells are equal; a cell that is unknown makes the row unknown, never a silent match.
 */
export function buildMatrix(i: ReconciliationInputs): MatrixRow[] {
  const money = (m: { minorUnits: number }) => m.minorUnits;
  const weeks = (pick: "shopify" | "tiktok") => i.attribution.weeks.reduce((a, w) => a + money(w[pick]), 0);
  const channel = (key: "shopify" | "tiktok", from: { channels: { key: string; netReceipts: { minorUnits: number } }[] }) => money(from.channels.find((c) => c.key === key)!.netReceipts);
  const ovNet = known<{ minorUnits: number }>(i.overview.netReceipts);
  const attrNet = known<{ minorUnits: number }>(i.attribution.netReceipts);
  const ovOrders = known<number>(i.overview.orders);
  const attrOrders = known<number>(i.attribution.orders);
  const mediaSpend = i.paidMedia.channels.reduce((a, c) => a + money(c.spend), 0);
  const acquisitionCost = mediaSpend + money(i.paidMedia.creatorSampleEconomics);
  const postOrders = sumNullable(i.posts.map((p) => p.orders));
  const postSales = i.posts.some((p) => p.netSales === null) ? null : i.posts.reduce((a, p) => a + p.netSales!.minorUnits, 0);
  const postViews = sumNullable(i.posts.map((p) => p.views));

  const rows: Omit<MatrixRow, "status" | "reason">[] = [
    { metric: "Net receipts", unit: "usd", cells: [
      { page: "Overview", route: "/overview", value: ovNet ? money(ovNet) : null },
      { page: "Performance attribution", route: "/analytics/attribution", value: attrNet ? money(attrNet) : null },
      { page: "Attribution weekly buckets", route: "/analytics/attribution", value: weeks("shopify") + weeks("tiktok") },
    ] },
    { metric: "Valid orders", unit: "count", cells: [
      { page: "Overview", route: "/overview", value: ovOrders },
      { page: "Performance attribution", route: "/analytics/attribution", value: attrOrders },
      { page: "Attribution methods", route: "/analytics/attribution", value: i.attribution.attribution.reduce((a, m) => a + m.orders, 0) },
      { page: "Commerce, support and reviews", route: "/analytics/customer-journey", value: i.journey.globalOrders },
      { page: "Website + TikTok Shop orders", route: "/analytics/customer-journey", value: i.journey.websiteOrders + i.journey.tiktokOrders },
    ] },
    { metric: "Shopify receipts", unit: "usd", cells: [
      { page: "Overview", route: "/overview", value: channel("shopify", i.overview) },
      { page: "Performance attribution", route: "/analytics/attribution", value: channel("shopify", i.attribution) },
      { page: "Attribution weekly buckets", route: "/analytics/attribution", value: weeks("shopify") },
      { page: "Commerce, support and reviews", route: "/analytics/customer-journey", value: money(i.journey.websiteNetReceipts) },
    ] },
    { metric: "TikTok Shop receipts", unit: "usd", cells: [
      { page: "Overview", route: "/overview", value: channel("tiktok", i.overview) },
      { page: "Performance attribution", route: "/analytics/attribution", value: channel("tiktok", i.attribution) },
      { page: "Attribution weekly buckets", route: "/analytics/attribution", value: weeks("tiktok") },
    ] },
    { metric: "Marketing spend", unit: "usd", cells: [
      { page: "Overview", route: "/overview", value: money(i.overview.marketingSpend) },
      { page: "Performance attribution", route: "/analytics/attribution", value: money(i.attribution.marketingSpend) },
      { page: "Paid media: media + creator and sample economics", route: "/analytics/paid-media", value: acquisitionCost },
    ] },
    { metric: "Attributed orders", unit: "count", cells: [
      { page: "Overview", route: "/overview", value: known<number>(i.overview.attributedOrders) },
      { page: "Content monitor posts", route: "/content", value: postOrders },
    ] },
    { metric: "Attributed net sales", unit: "usd", cells: [
      { page: "Overview", route: "/overview", value: (() => { const v = known<{ minorUnits: number }>(i.overview.attributedNetSales); return v ? money(v) : null; })() },
      { page: "Content monitor posts", route: "/content", value: postSales },
    ] },
    { metric: "Post views", unit: "count", cells: [
      { page: "Overview creator activity", route: "/overview", value: sumNullable(i.overview.posts.map((p) => p.views)) },
      { page: "Content monitor posts", route: "/content", value: postViews },
    ] },
  ];

  return rows.map((r) => {
    const unknownCell = r.cells.find((c) => c.value === null);
    if (unknownCell) return { ...r, status: "unknown" as const, reason: `${unknownCell.page} has no value, so this metric is not reconciled.` };
    const first = r.cells[0]!.value;
    const odd = r.cells.find((c) => c.value !== first);
    return odd
      ? { ...r, status: "differs" as const, reason: `${odd.page} states ${odd.value}, but ${r.cells[0]!.page} states ${first}.` }
      : { ...r, status: "matches" as const, reason: null };
  });
}
