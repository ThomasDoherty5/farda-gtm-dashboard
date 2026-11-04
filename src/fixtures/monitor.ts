/**
 * Demo records for the content monitor, watchlist, hourly run and post performance (THO-299). All synthetic. The five
 * posts reconcile to the Overview's shared creator cohort: 240,000 views, 12,000 interactions, 180 attributed orders and
 * $5,796 in attributed net sales. Monitoring is read-only; no result here authorizes outbound.
 */
import type { Money } from "@/adapter/contract";
import { overviewOriginal } from "./overview";

export const DEMO_RUN_HOURLY_ID = "demo-run-hourly";
export const DEMO_POST_ID = "P-001";
const usd = (dollars: number): Money => ({ minorUnits: Math.round(dollars * 100), currency: "USD" });

export type Network = "tiktok" | "instagram";
export type IntakeSource = "tiktok-affiliate" | "social-cat";
export type Interactions = { likes: number; comments: number; shares: number };

export type MonitorPost = {
  postId: string;
  handle: string;
  network: Network;
  source: IntakeSource;
  /** Counts are null when the source gave none, which is not zero. */
  views: number | null;
  interactions: Interactions | null;
  orders: number | null;
  netSales: Money | null;
  lastCheck: string;
};

const post = (postId: string, handle: string, network: Network, source: IntakeSource, views: number, likes: number, comments: number, shares: number, orders: number, sales: number): MonitorPost => ({
  postId, handle, network, source, views, interactions: { likes, comments, shares }, orders, netSales: usd(sales), lastCheck: "11:00 · demo",
});

export const monitorPosts: MonitorPost[] = [
  post("P-001", "@studio.rae", "tiktok", "tiktok-affiliate", 84_000, 4200, 420, 420, 62, 2015),
  post("P-002", "@mira.moves", "instagram", "social-cat", 60_000, 2400, 300, 300, 45, 1440),
  post("P-003", "@dailywithjo", "tiktok", "tiktok-affiliate", 42_000, 1500, 90, 90, 31, 995),
  post("P-004", "@cozybyclaire", "tiktok", "social-cat", 30_000, 1000, 100, 100, 23, 736),
  post("P-005", "@oliviasunday", "tiktok", "social-cat", 24_000, 900, 90, 90, 19, 610),
];

/** Cumulative views, one point per day from Oct 16 to Oct 29 (thousands), as drawn in Figma 23:73. */
export const viewCurve = { startDate: "Oct 16", labels: ["Oct 16", "Oct 20", "Oct 24", "Oct 29"], thousands: [3, 8, 15, 24, 35, 48, 63, 80, 99, 120, 143, 168, 200, 240] };

export type ContentMonitorData = {
  datasetKey: "monitor-demo";
  snapshotLabel: string;
  cohort: { label: string; creators: number };
  posts: MonitorPost[];
  /** Posts before any filter, so the table can state its denominator. */
  postTotal: number;
  /** The window these counts were observed over. A window with no snapshot has no counts, not zeros. */
  windowLabel: string;
  windowAvailable: boolean;
  attributedOrders: number | null;
  attributedNetSales: Money | null;
  coverage: { cohortCreators: number; verifiedPosts: number; measurable: number; unavailable: number };
  signals: { initial: string; handle: string; text: string; badge: string; tone: "violet" | "warning"; to: string }[];
  curve: typeof viewCurve;
};

export const contentMonitorDemo: ContentMonitorData = {
  datasetKey: "monitor-demo",
  snapshotLabel: "Snapshot · 29 Oct",
  cohort: { label: "Launch cohort A", creators: 12 },
  posts: monitorPosts,
  postTotal: monitorPosts.length,
  windowLabel: "Last 30 days",
  windowAvailable: true,
  attributedOrders: overviewOriginal.attributedOrders.value,
  attributedNetSales: overviewOriginal.attributedNetSales.value,
  coverage: { cohortCreators: 12, verifiedPosts: 9, measurable: 5, unavailable: 4 },
  signals: [
    { initial: "S", handle: "@studio.rae", text: "New post URL detected in the approved collaboration.", badge: "Confirm post", tone: "violet", to: "/content/P-001" },
    { initial: "M", handle: "@mira.moves", text: "New creator reply needs a status review.", badge: "Review inbox", tone: "warning", to: "/creators/watchlist" },
  ],
  curve: viewCurve,
};

/* ---------- Watchlist (Figma 25:166) ---------- */

export type MonitoringState = "active" | "identity-review" | "excluded";
export type WatchRow = {
  id: string;
  handle: string;
  network: "TikTok" | "Instagram";
  intake: IntakeSource;
  signup: string;
  state: MonitoringState;
  lastCheck: string;
  next: { label: string; kind: "post" | "message" | "deliverable" | "identity" | "reconnect" | "exclusion" };
  cohort: "launch-a" | "other";
  note: string;
};
export type WatchlistData = {
  datasetKey: "watchlist-demo";
  totals: { tracked: number; socialCat: number; tiktok: number; active: number; identityReview: number; excluded: number };
  rows: WatchRow[];
  cohortCreators: number;
  scheduleLabel: string;
};

export const watchlistDemo: WatchlistData = {
  datasetKey: "watchlist-demo",
  totals: { tracked: 40, socialCat: 24, tiktok: 16, active: 32, identityReview: 5, excluded: 3 },
  cohortCreators: 12,
  scheduleLabel: "hourly schedule not enabled",
  rows: [
    { id: "w1", handle: "@studio.rae", network: "TikTok", intake: "tiktok-affiliate", signup: "TikTok affiliate joined", state: "active", lastCheck: "10:04 AM", next: { label: "View post performance →", kind: "post" }, cohort: "launch-a", note: "" },
    { id: "w2", handle: "@mira.moves", network: "Instagram", intake: "social-cat", signup: "Social Cat application", state: "active", lastCheck: "10:03 AM", next: { label: "Review new message →", kind: "message" }, cohort: "launch-a", note: "" },
    { id: "w3", handle: "@cozybyclaire", network: "TikTok", intake: "social-cat", signup: "Social Cat application", state: "active", lastCheck: "10:02 AM", next: { label: "Verify deliverable →", kind: "deliverable" }, cohort: "launch-a", note: "" },
    { id: "w4", handle: "@move.with.ana", network: "TikTok", intake: "tiktok-affiliate", signup: "TikTok affiliate joined", state: "identity-review", lastCheck: "Not checked", next: { label: "Match the correct profile →", kind: "identity" }, cohort: "other", note: "Two profiles share this handle across accounts; the match is quarantined until reviewed." },
    { id: "w5", handle: "@everyday.lee", network: "TikTok", intake: "tiktok-affiliate", signup: "TikTok affiliate joined", state: "active", lastCheck: "Yesterday", next: { label: "Reconnect source session →", kind: "reconnect" }, cohort: "other", note: "" },
    { id: "w6", handle: "@calm.with.jo", network: "Instagram", intake: "social-cat", signup: "Social Cat application", state: "excluded", lastCheck: "Oct 26", next: { label: "View exclusion reason →", kind: "exclusion" }, cohort: "other", note: "Suppressed after an opt-out on Oct 26; tracking ended and stays ended." },
  ],
};

/* ---------- Hourly run (Figma 25:307) ---------- */

export type RunStage = { n: string; title: string; detail: string; state: "complete" | "partial" };
export type HourlyRunData = {
  datasetKey: "hourly-run-demo";
  runId: string;
  runLabel: string;
  context: string;
  version: string;
  profiles: { checked: number; total: number; failed: { handle: string; network: string; reason: string } | null };
  newPostLinks: number;
  inboxChanges: number;
  statusReviews: number;
  stages: RunStage[];
  policy: { schedule: string; scheduleNote: string; nextRun: string; nextRunNote: string; retry: string; retryNote: string };
  evidence: { evidence: string; source: string; result: string; action: string; kind: "post" | "suggestion" | "delivery" | "reconnect" }[];
};

export const hourlyRunDemo: HourlyRunData = {
  datasetKey: "hourly-run-demo",
  runId: DEMO_RUN_HOURLY_ID,
  runLabel: "RUN-MON-1029-1000",
  context: "Oct 29, 2026 · started 10:00 AM PT · schedule is a draft",
  version: "run-1",
  profiles: { checked: 31, total: 32, failed: { handle: "@everyday.lee", network: "TikTok", reason: "Session expired" } },
  newPostLinks: 4,
  inboxChanges: 9,
  statusReviews: 2,
  stages: [
    { n: "01", title: "Read the watchlist", detail: "32 active profiles selected; 5 identity reviews and 3 exclusions skipped.", state: "complete" },
    { n: "02", title: "Open authenticated source sessions", detail: "Social Cat ready. One TikTok session expired; no access bypass attempted.", state: "partial" },
    { n: "03", title: "Discover linked Farda content", detail: "Match known profiles, campaign references and linked product posts.", state: "complete" },
    { n: "04", title: "Read post snapshots", detail: "Capture only available counts, observation time and source evidence.", state: "complete" },
    { n: "05", title: "Read conversation changes", detail: "Record message event IDs and suggested status; preserve source links.", state: "complete" },
    { n: "06", title: "Reconcile order attribution", detail: "Join verified attribution with authoritative orders, discounts and refunds.", state: "complete" },
    { n: "07", title: "Publish the run result", detail: "31 profiles refreshed; one retains its last known snapshot and stale label.", state: "partial" },
  ],
  policy: {
    schedule: "Every hour, on the hour",
    scheduleNote: "Draft · starts only after connection testing",
    nextRun: "11:00 AM PT",
    nextRunNote: "A running job prevents overlapping execution",
    retry: "Resume from checkpoint",
    retryNote: "Completed events never replay as new activity",
  },
  evidence: [
    { evidence: "New post URL verified", source: "@studio.rae · TikTok", result: "Content live; post ID recorded", action: "Open post detail →", kind: "post" },
    { evidence: "Creator says a draft is ready", source: "@mira.moves · Social Cat inbox", result: "Suggested: ready for review", action: "Review status suggestion →", kind: "suggestion" },
    { evidence: "Creator says a sample arrived", source: "@cozybyclaire · Social Cat inbox", result: "Suggested: delivered; shipment not reconciled", action: "Compare delivery evidence →", kind: "delivery" },
    { evidence: "Session expired", source: "@everyday.lee · TikTok", result: "No fresh data; previous snapshot retained", action: "Reconnect source →", kind: "reconnect" },
  ],
};

/* ---------- Post performance (Figma 25:481) ---------- */

export type PostGmv =
  | { state: "reported"; amount: Money; window: string; definition: string }
  | { state: "not-reported" }
  | { state: "not-applicable" };

export type PostPerformanceData = {
  datasetKey: "post-demo";
  postId: string;
  handle: string;
  network: "TikTok" | "Instagram";
  cohort: string;
  publishedLabel: string;
  context: string;
  views: number | null;
  interactions: (Interactions & { saves: null; uniqueReach: null }) | null;
  orders: number | null;
  netSales: Money | null;
  /** TikTok-reported GMV is a platform figure before discounts and refunds. It is never retained net sales and is never summed into it. */
  gmv: PostGmv;
  dailyDeltas: { label: string; thousands: number }[];
  details: { creatorId: string; contentId: string; intake: string; metricSource: string; salesSource: string };
  collaborationId: string;
};

const deltas = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 17];
export const postPerformanceDemo: PostPerformanceData = {
  datasetKey: "post-demo",
  postId: "P-001",
  handle: "@studio.rae",
  network: "TikTok",
  cohort: "Launch cohort A",
  publishedLabel: "published Oct 19, 2026",
  context: "Views since publication · order attribution Sep 30–Oct 29 · last example check 10:04 AM PT",
  views: 84_000,
  interactions: { likes: 4200, comments: 420, shares: 420, saves: null, uniqueReach: null },
  orders: 62,
  netSales: usd(2015),
  gmv: { state: "reported", amount: usd(3100), window: "Sep 30–Oct 29, 2026", definition: "TikTok Shop order value before discounts and refunds" },
  dailyDeltas: deltas.map((d, i) => ({ label: String(19 + i), thousands: d })),
  details: { creatorId: "CR-010", contentId: "TT-DEMO-001", intake: "TikTok affiliate", metricSource: "Linked post snapshot", salesSource: "Reconciled orders" },
  collaborationId: "COL-010",
};
