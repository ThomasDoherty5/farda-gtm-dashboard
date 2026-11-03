/**
 * Overview fixture family (FX-01..FX-09) — SYNTHETIC. Isolated from dispatch.
 * Dataset "overview-original": global 400 orders / $12,596; five posts 240,000 views,
 * 12,000 engagements (5.0%); attributed 180 orders / $5,796.
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
  storeSales: ProvenanceValue<Money>;
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

export const overviewOriginal: OverviewData = {
  datasetKey: "overview-original",
  orders: known(400),
  storeSales: known({ minorUnits: 1_259_600, currency: "USD" }),
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
