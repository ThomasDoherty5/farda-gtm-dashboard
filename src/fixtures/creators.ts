/**
 * Social Cat and TikTok Shop fixtures (Figma sources 6:24, 9:143, 23:275, 23:440) — SYNTHETIC. Handles and
 * counts are illustrative. The operational snapshots (lifecycle, worklist, Launch cohort A) are separate cohorts
 * from the acquisition funnel in pipeline.ts and must never be added to it. Totals are always derived.
 */
import type { Money } from "@/adapter/contract";

export const OWNERS = ["Thomas", "Operations", "Creator agent", "Operator"] as const;
export type Owner = (typeof OWNERS)[number];
export type Network = "instagram" | "tiktok";
export type BadgeTone = "neutral" | "violet" | "success" | "warning";

/* ---------- Social Cat current lifecycle (6:24) ---------- */

export type LifecycleCard = { id: string; handle: string; detail: string; status: { label: string; tone: BadgeTone }; note: string; owner: Owner };
export type LifecycleStage = { key: string; title: string; note: string; byOwner: Record<Owner, number>; cards: LifecycleCard[] };

const by = (thomas: number, operations: number, agent: number, operator: number): Record<Owner, number> => ({ Thomas: thomas, Operations: operations, "Creator agent": agent, Operator: operator });

export type SocialCatBoardData = {
  datasetKey: "social-cat-board-demo";
  owner: "all" | Owner;
  stages: LifecycleStage[];
  needsDecision: Record<Owner, number>;
  contentReady: Record<Owner, number>;
  /** Cost per live video is unknown until a live post and a complete cost set exist. */
  costPerLiveVideo: { state: "unknown"; reasonCode: "NO_LIVE_POSTS" };
  nextDecision: { handle: string; subject: string; approvalId: string };
};

export const socialCatBoardDemo: SocialCatBoardData = {
  datasetKey: "social-cat-board-demo",
  owner: "all",
  stages: [
    { key: "applicants", title: "Applicants", note: "Vetting", byOwner: by(4, 2, 14, 4), cards: [
      { id: "c1", handle: "@lena.everyday", detail: "Lifestyle · 28k followers", status: { label: "Fit review", tone: "neutral" }, note: "Evaluate audience, content and fit.", owner: "Creator agent" },
      { id: "c2", handle: "@rae.routines", detail: "Wellness · 16k followers", status: { label: "Needs context", tone: "warning" }, note: "Missing audience geography.", owner: "Operator" },
    ] },
    { key: "negotiating", title: "Negotiating", note: "Approval before send", byOwner: by(6, 0, 4, 2), cards: [
      { id: "c3", handle: "@routine.with.ella", detail: "12% commission · proposed", status: { label: "Awaiting approval", tone: "warning" }, note: "Brief invitation · version 3", owner: "Thomas" },
      { id: "c4", handle: "@mira.moves", detail: "Product collaboration", status: { label: "Ready for browser", tone: "violet" }, note: "Approved exact reply · version 2", owner: "Creator agent" },
    ] },
    { key: "brief", title: "Brief & sample", note: "Tracked handoff", byOwner: by(1, 3, 3, 1), cards: [
      { id: "c5", handle: "@dailywithjo", detail: "UGC video · 30–45 seconds", status: { label: "Brief approved", tone: "success" }, note: "Browser task: send approved brief.", owner: "Creator agent" },
      { id: "c6", handle: "@wellwithalex", detail: "Sample allocation · 1 unit", status: { label: "Awaiting shipment", tone: "neutral" }, note: "Fulfilment stays in source tool.", owner: "Operations" },
    ] },
    { key: "creating", title: "Creating", note: "Review and revision", byOwner: by(2, 2, 8, 4), cards: [
      { id: "c7", handle: "@itsmarisol", detail: "Draft due · 04 Nov", status: { label: "Draft received", tone: "violet" }, note: "Review claims, quality and rights.", owner: "Operator" },
      { id: "c8", handle: "@thegoodroutine", detail: "Revision round 1", status: { label: "Awaiting creator", tone: "neutral" }, note: "Approved feedback sent · receipt saved.", owner: "Creator agent" },
    ] },
    { key: "approved", title: "Approved", note: "Payment and close", byOwner: by(3, 1, 0, 2), cards: [
      { id: "c9", handle: "@cozybyclaire", detail: "Historical fee · 1 video", status: { label: "Pay approval", tone: "warning" }, note: "Founder decision required.", owner: "Thomas" },
      { id: "c10", handle: "@oliviasunday", detail: "Rights verified · final asset", status: { label: "Ready to close", tone: "success" }, note: "Save final link and source receipt.", owner: "Operator" },
    ] },
  ],
  needsDecision: by(3, 1, 3, 1),
  contentReady: by(2, 1, 1, 2),
  costPerLiveVideo: { state: "unknown", reasonCode: "NO_LIVE_POSTS" },
  nextDecision: { handle: "@routine.with.ella", subject: "brief", approvalId: "demo-approval-042" },
};

export function filterSocialCatBoard(owner: SocialCatBoardData["owner"]): SocialCatBoardData {
  if (owner === "all") return socialCatBoardDemo;
  const count = (r: Record<Owner, number>) => ({ ...by(0, 0, 0, 0), [owner]: r[owner] }) as Record<Owner, number>;
  return {
    ...socialCatBoardDemo,
    owner,
    stages: socialCatBoardDemo.stages.map((s) => ({ ...s, byOwner: count(s.byOwner), cards: s.cards.filter((c) => c.owner === owner) })),
    needsDecision: count(socialCatBoardDemo.needsDecision),
    contentReady: count(socialCatBoardDemo.contentReady),
  };
}

/* ---------- TikTok current funnel (9:143) ---------- */

export type TikTokWorkRow = { id: string; handle: string; stage: string; next: string; due: string; owner: Owner };
export type TikTokBoardData = {
  datasetKey: "tiktok-board-demo";
  query: string;
  stages: { key: string; label: string; count: number }[];
  awaitingApproval: number;
  /** Posted and first-sale stages both mean a post exists. */
  postsPublishedStages: string[];
  rows: TikTokWorkRow[];
  attributedSales: { state: "unknown"; reasonCode: "ATTRIBUTION_NOT_VERIFIED" };
};

export const tiktokBoardDemo: TikTokBoardData = {
  datasetKey: "tiktok-board-demo",
  query: "",
  stages: [
    { key: "shortlist", label: "Shortlist", count: 24 }, { key: "contacted", label: "Contacted", count: 12 }, { key: "replied", label: "Replied", count: 8 },
    { key: "agreed", label: "Agreed", count: 6 }, { key: "sampleApproved", label: "Sample approved", count: 4 }, { key: "shipped", label: "Shipped", count: 3 },
    { key: "delivered", label: "Delivered", count: 2 }, { key: "posted", label: "Posted", count: 2 }, { key: "firstSale", label: "First sale", count: 1 },
  ],
  awaitingApproval: 7,
  postsPublishedStages: ["posted", "firstSale"],
  rows: [
    { id: "t1", handle: "@mira.moves", stage: "Contacted", next: "Reply proposal needs approval", due: "Today", owner: "Thomas" },
    { id: "t2", handle: "@dailywithjo", stage: "Agreed", next: "Request sample reservation", due: "Today", owner: "Operations" },
    { id: "t3", handle: "@wellwithalex", stage: "Delivered", next: "Pre-due check-in", due: "Due − 2 days", owner: "Creator agent" },
    { id: "t4", handle: "@lena.everyday", stage: "Delivered", next: "Review after posting due + grace", due: "Due + grace", owner: "Operator" },
    { id: "t5", handle: "@cozybyclaire", stage: "Posted", next: "Verify attribution + archive receipt", due: "After post", owner: "Operator" },
  ],
  attributedSales: { state: "unknown", reasonCode: "ATTRIBUTION_NOT_VERIFIED" },
};

export function searchTikTokBoard(query: string): TikTokBoardData {
  const q = query.trim().toLowerCase();
  if (!q) return tiktokBoardDemo;
  return { ...tiktokBoardDemo, query, rows: tiktokBoardDemo.rows.filter((r) => [r.handle, r.stage, r.next, r.due, r.owner].some((v) => v.toLowerCase().includes(q))) };
}

/* ---------- Dashboards (23:275, 23:440) ---------- */

/** Cumulative share of the final total at each day, Oct 16 to Oct 29: the demo curve from Figma's chart. */
export const CUMULATIVE_SHARE = [0.0125, 0.0333, 0.0625, 0.1, 0.1459, 0.2, 0.2625, 0.3333, 0.4125, 0.5, 0.5958, 0.7, 0.8333, 1];
export const CUMULATIVE_DAYS = ["Oct 16", "Oct 17", "Oct 18", "Oct 19", "Oct 20", "Oct 21", "Oct 22", "Oct 23", "Oct 24", "Oct 25", "Oct 26", "Oct 27", "Oct 28", "Oct 29"];

export type NetworkFacts = { posts: number; measurablePosts: number; views: number; interactions: number; orders: number; net: Money };
const usd = (minorUnits: number): Money => ({ minorUnits, currency: "USD" });

export type SocialCatDashboardData = {
  datasetKey: "social-cat-dashboard-demo";
  network: "all" | Network;
  cohort: { label: string; creators: number };
  networks: Record<Network, NetworkFacts>;
  actions: { count: number; label: string }[];
  queue: { label: string; count: number }[];
  upcoming: { id: string; handle: string; deliverable: string; status: string; due: string }[];
  samples: { total: number; inTransit: number; delivered: number };
  /** Affiliate pilot: a separate synthetic cohort B. Its values are never added to Launch cohort A. */
  pilot: { netEligibleSales: Money; refunds: Money; grossCommission: Money; reversedCommission: Money; cashCommissionPaid: Money; estimatedContribution: Money };
};

export const socialCatDashboardDemo: SocialCatDashboardData = {
  datasetKey: "social-cat-dashboard-demo",
  network: "all",
  cohort: { label: "Launch cohort A", creators: 7 },
  networks: {
    instagram: { posts: 2, measurablePosts: 1, views: 50_000, interactions: 2_500, orders: 40, net: usd(129_600) },
    tiktok: { posts: 2, measurablePosts: 1, views: 40_000, interactions: 1_700, orders: 28, net: usd(88_000) },
  },
  actions: [{ count: 3, label: "Briefs awaiting approval" }, { count: 2, label: "Creator replies to review" }, { count: 1, label: "Draft needs a revision" }],
  queue: [{ label: "New applications", count: 6 }, { label: "Vetting", count: 8 }, { label: "Brief agreed", count: 4 }, { label: "Creating", count: 3 }, { label: "Content ready", count: 3 }],
  upcoming: [
    { id: "u1", handle: "@routine.with.ella", deliverable: "1 video · draft v2", status: "Review needed", due: "Today" },
    { id: "u2", handle: "@cozybyclaire", deliverable: "1 video · final", status: "License pending", due: "Tomorrow" },
    { id: "u3", handle: "@mira.moves", deliverable: "Approved brief", status: "Sample in transit", due: "04 Nov" },
  ],
  samples: { total: 8, inTransit: 5, delivered: 3 },
  pilot: { netEligibleSales: usd(180_000), refunds: usd(20_000), grossCommission: usd(30_000), reversedCommission: usd(3_000), cashCommissionPaid: usd(9_000), estimatedContribution: usd(46_217) },
};

export type TikTokDashboardData = {
  datasetKey: "tiktok-dashboard-demo";
  cohort: { label: string; creators: number; posts: number; measurablePosts: number };
  views: number;
  interactions: number;
  orders: number;
  net: Money;
  /** All TikTok Shop orders in the demo, of which the measured creators drive `orders`. */
  shopOrders: number;
  actions: { count: number; label: string }[];
  watchlist: { label: string; count: number }[];
  posts: { id: string; handle: string; views: number; orders: number; net: Money }[];
};

export const tiktokDashboardDemo: TikTokDashboardData = {
  datasetKey: "tiktok-dashboard-demo",
  cohort: { label: "Launch cohort A", creators: 5, posts: 5, measurablePosts: 3 },
  views: 150_000,
  interactions: 7_800,
  orders: 112,
  net: usd(362_000),
  shopOrders: 140,
  actions: [{ count: 3, label: "Replies ready for review" }, { count: 2, label: "Sample approvals waiting" }, { count: 1, label: "Attribution match needs help" }],
  watchlist: [{ label: "New profiles", count: 4 }, { label: "Vetted / invited", count: 5 }, { label: "Agreed", count: 3 }, { label: "Sample stage", count: 2 }, { label: "Live creators", count: 2 }],
  posts: [
    { id: "p1", handle: "@studio.rae", views: 84_000, orders: 62, net: usd(201_500) },
    { id: "p2", handle: "@dailywithjo", views: 42_000, orders: 31, net: usd(99_500) },
    { id: "p3", handle: "@oliviasunday", views: 24_000, orders: 19, net: usd(61_000) },
  ],
};

/** The Social Cat dashboard for a publishing network, or both. Unknown networks fall back to "all" in the caller. */
export function filterSocialCatDashboard(network: SocialCatDashboardData["network"]): SocialCatDashboardData {
  return { ...socialCatDashboardDemo, network };
}
