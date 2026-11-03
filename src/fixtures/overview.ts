/**
 * Overview fixture family (FX-01..FX-09) — SYNTHETIC. Isolated from dispatch.
 * Dataset "overview-original": global 400 orders / $12,596; five posts 240,000 views,
 * 12,000 engagements (5.0%); attributed 180 orders / $5,796.
 * Daily receipts come from the bar heights in Figma source 10:217 (height / 270 × $600).
 * Do not mix with the pilot (1,800/270), acquisition, Social Cat or TikTok datasets.
 */
import type { Money, ProvenanceValue, SourceRef } from "@/adapter/contract";
import type { PostCounters } from "@/features/overview/metrics";

export const DEMO_NOW = "2026-11-02T17:00:00.000Z";
export const DEMO_WORKSPACE = "demo-workspace";
export const DEMO_ACCOUNT = "demo-account-farda";

export type OverviewData = {
  datasetKey: "overview-original";
  orders: ProvenanceValue<number>;
  netReceipts: ProvenanceValue<Money>;
  contribution: ProvenanceValue<Money>;
  marketingSpend: Money;
  newRetainedCustomers: number;
  periodLabel: string;
  channels: { key: "shopify" | "tiktok"; label: string; netReceipts: Money; orders: number }[];
  daily: { date: string; shopify: number; tiktok: number }[];
  cohortLabel: string;
  monitorLabel: string;
  lastCheckedLabel: string;
  activity: { handle: string; note: string }[];
  attributedOrders: ProvenanceValue<number>;
  attributedNetSales: ProvenanceValue<Money>;
  posts: PostCounters[];
};

const shopify: SourceRef = {
  source: "shopify",
  accountId: DEMO_ACCOUNT,
  sourceId: null,
  canonicalId: null,
  url: null,
  identityState: "resolved",
  provenanceRef: "demo:overview-original:shopify",
};

const known = <T>(value: T, sourceRef: SourceRef = shopify): ProvenanceValue<T> => ({
  state: "known",
  value,
  reasonCode: null,
  evidenceRefs: ["demo:overview-original"],
  sourceRef,
  occurredAt: null,
  sourceUpdatedAt: DEMO_NOW,
  observedAt: DEMO_NOW,
});

/** Five posts summing to 240,000 views and 12,000 engagements. */
export const overviewPosts: PostCounters[] = [
  { postId: "demo-post-1", views: 80_000, likes: 3_200, comments: 400, shares: 400 },
  { postId: "demo-post-2", views: 60_000, likes: 2_400, comments: 300, shares: 300 },
  { postId: "demo-post-3", views: 40_000, likes: 1_600, comments: 200, shares: 200 },
  { postId: "demo-post-4", views: 35_000, likes: 1_400, comments: 175, shares: 175 },
  { postId: "demo-post-5", views: 25_000, likes: 1_000, comments: 125, shares: 125 },
];

const usd = (minorUnits: number): Money => ({ minorUnits, currency: "USD" });

/** [date, Shopify cents, TikTok Shop cents] */
const dailyReceipts: [string, number, number][] = [
  ["2026-09-30", 13371, 8840],
  ["2026-10-01", 18514, 11560],
  ["2026-10-02", 15600, 9423],
  ["2026-10-03", 20400, 10977],
  ["2026-10-04", 16629, 9131],
  ["2026-10-05", 19371, 7577],
  ["2026-10-06", 16114, 10491],
  ["2026-10-07", 19389, 11440],
  ["2026-10-08", 26846, 14960],
  ["2026-10-09", 22620, 12194],
  ["2026-10-10", 29580, 14206],
  ["2026-10-11", 24111, 11817],
  ["2026-10-12", 28089, 9806],
  ["2026-10-13", 23366, 13577],
  ["2026-10-14", 25629, 15548],
  ["2026-10-15", 35486, 20332],
  ["2026-10-16", 29900, 16573],
  ["2026-10-17", 39100, 19307],
  ["2026-10-18", 31871, 16061],
  ["2026-10-19", 37129, 13327],
  ["2026-10-20", 30886, 18453],
  ["2026-10-21", 28971, 16900],
  ["2026-10-22", 40114, 22100],
  ["2026-10-23", 33800, 18014],
  ["2026-10-24", 44200, 20986],
  ["2026-10-25", 36029, 17457],
  ["2026-10-26", 41971, 14486],
  ["2026-10-27", 34914, 20057],
  ["2026-10-28", 21974, 7381],
  ["2026-10-29", 30426, 10219]
];

export const overviewOriginal: OverviewData = {
  datasetKey: "overview-original",
  orders: known(400),
  netReceipts: known(usd(1_259_600)),
  contribution: known(usd(568_000)),
  marketingSpend: usd(700_000),
  newRetainedCustomers: 280,
  periodLabel: "Sep 30 – Oct 29, 2026",
  channels: [
    { key: "shopify", label: "Shopify", netReceipts: usd(836_400), orders: 260 },
    { key: "tiktok", label: "TikTok Shop", netReceipts: usd(423_200), orders: 140 },
  ],
  daily: dailyReceipts.map(([date, shopify, tiktok]) => ({ date, shopify, tiktok })),
  cohortLabel: "Launch cohort A · 12 creators · demo",
  monitorLabel: "Hourly planned",
  lastCheckedLabel: "Last checked · 11:00 demo snapshot",
  activity: [
    { handle: "@studio.rae", note: "New post found · verify match" },
    { handle: "@mira.moves", note: "New reply · review creator status" },
  ],
  attributedOrders: known(180),
  attributedNetSales: known({ minorUnits: 579_600, currency: "USD" }),
  posts: overviewPosts,
};

export const overviewFixtureKeys = [
  "FX-01-happy-read",
  "FX-02-known-zero",
  "FX-03-empty-filter",
  "FX-04-missing-metric",
  "FX-05-partial-coverage",
  "FX-06-stale-source",
  "FX-07-offline-read",
  "FX-08-forbidden-account",
  "FX-09-expired-session",
] as const;
export type OverviewFixtureKey = (typeof overviewFixtureKeys)[number];
