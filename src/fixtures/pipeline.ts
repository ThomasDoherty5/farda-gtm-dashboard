/**
 * Full acquisition pipeline fixture (Figma source 102:74) — SYNTHETIC. One illustrative completed cohort
 * of 120 opportunities, split evenly between the two sources. It is not a sourcing result, and it must
 * not be mixed with the daily-sourcing batch in discovery.ts. Totals are always derived by summing sources.
 */
import type { Money } from "@/adapter/contract";

export type PipelineSource = "social-cat" | "tiktok-shop";

/** The stages in funnel order. `medianDays` is the elapsed time from the previous stage; the first stage has none. */
export const PIPELINE_STAGES = [
  { key: "discovered", label: "Discovered" },
  { key: "videoReviewed", label: "Video reviewed" },
  { key: "qualified", label: "Qualified" },
  { key: "approved", label: "Approved" },
  { key: "confirmedSent", label: "Confirmed sent" },
  { key: "matched", label: "Matched / accepted" },
  { key: "terms", label: "Terms confirmed" },
  { key: "tracking", label: "Tracking active" },
  { key: "published", label: "Published creator" },
  { key: "retained", label: "Retained-order creator" },
] as const;
export type StageKey = (typeof PIPELINE_STAGES)[number]["key"];

/** Exclusive current-stage buckets. Each opportunity sits in exactly one, so they add up to the cohort. */
export const CURRENT_STAGES = [
  { key: "videoReview", label: "Video review", next: "Open the original clip" },
  { key: "evidenceHold", label: "Evidence / fit hold", next: "Resolve missing evidence" },
  { key: "approvalPending", label: "Approval pending", next: "Review exact terms" },
  { key: "dispatch", label: "Dispatch", next: null },
  { key: "matchPending", label: "Match pending / closed", next: null },
  { key: "termsPending", label: "Terms pending", next: "Inspect source acceptance" },
  { key: "trackingSetup", label: "Tracking setup", next: "Test issued link/code" },
  { key: "contentPending", label: "Content pending", next: "Use actual agreed due dates" },
  { key: "firstOrderPending", label: "First order pending", next: "Check attribution coverage" },
  { key: "generatingOrders", label: "Generating orders", next: "Monitor retained outcomes" },
] as const;
export type CurrentStageKey = (typeof CURRENT_STAGES)[number]["key"];

export type SendFacts = { approved: number; confirmed: number; uncertain: number; queued: number; replies: number; attempts: number; opportunities: number };
export type SourceFacts = {
  source: PipelineSource;
  label: string;
  /** Opportunities that reached each stage, in `PIPELINE_STAGES` order. Null is unknown or not applicable, never zero. */
  reached: (number | null)[];
  /** Median days from the previous stage among reached opportunities. Null when timestamps are missing. */
  medianDays: (number | null)[];
  /** Null where the bucket does not exist for the route (an inbound application has no outbound dispatch). */
  current: Record<CurrentStageKey, number | null>;
  /** Null where the route has no outbound dispatch (an inbound application): N/A, never a zero. */
  dispatch: { queued: number; toReconcile: number } | null;
  closed: { waiting: number; declined: number; expired: number };
  /** Null where the route has no outbound send (an inbound application): N/A, never a zero. */
  sends: SendFacts | null;
  /** The source's own word for the milestone: Social Cat creates a match, TikTok records acceptance. */
  nativeMilestone: "matched" | "accepted";
  outcomes: { posts: number; comparablePosts: number; views: number; engagements: number; orders: number; fullyRefundedOrders: number; merchandise: Money; refunds: Money };
};

export const POLICY_VERSIONS = ["policy-2026-09", "policy-2026-10"] as const;
export type PolicyVersion = (typeof POLICY_VERSIONS)[number];
export type PipelineFilters = {
  source: "both" | PipelineSource;
  /** Outbound invitation or inbound application. The two are separate cohorts: an applicant has no invented outbound invitation. */
  route: "outbound" | "inbound";
  network: "all" | "instagram" | "tiktok";
  checkout: "all" | "website" | "tiktok-shop";
  window: "sep-oct" | "sep" | "oct";
  policy: "all" | PolicyVersion;
};
export const DEFAULT_PIPELINE_FILTERS: PipelineFilters = { source: "both", route: "outbound", network: "all", checkout: "all", window: "sep-oct", policy: "all" };

export type PipelineData = {
  datasetKey: "pipeline-demo";
  cohort: { label: string; asOf: string; timezone: string; grain: string };
  filters: PipelineFilters;
  /** Filters this dataset can't split. Empty now that every facet slices the cells; kept so the contract can report a partial split. */
  unsplit: (keyof PipelineFilters)[];
  /** The funnel's shared vertical scale: the unfiltered discovered count, so a filtered funnel stays comparable. */
  scaleMax: number;
  sources: SourceFacts[];
};

const usd = (minorUnits: number): Money => ({ minorUnits, currency: "USD" });
const zeroMoney = usd(0);

/** One synthetic slice of the cohort. Filters pick cells, and a source's facts are the sum of its matching cells. */
type Cell = {
  id: string;
  source: PipelineSource;
  route: PipelineFilters["route"];
  network: "instagram" | "tiktok";
  checkout: "website" | "tiktok-shop";
  window: "sep" | "oct";
  policy: PolicyVersion;
  facts: Omit<SourceFacts, "source" | "label" | "nativeMilestone">;
};

const medianDays = [null, 1, 1, 1, 1, 4, 1, 1, 7, 6];
const CURRENT_FROM: Record<CurrentStageKey, number> = { videoReview: 0, evidenceHold: 1, approvalPending: 2, dispatch: 3, matchPending: 4, termsPending: 5, trackingSetup: 6, contentPending: 7, firstOrderPending: 8, generatingOrders: 9 };

/** An outbound cell. Exclusive current-stage counts are the opportunities that stopped at each stage, so they reconcile to the cell. */
function outbound(reached: number[], x: { uncertain: number; queued: number; replies: number; extraAttempts: number; closed: [number, number, number]; outcomes: [posts: number, comparable: number, views: number, engagements: number, orders: number, fullyRefunded: number, merchandise: number, refunds: number] }): Cell["facts"] {
  const current = Object.fromEntries(CURRENT_STAGES.map((s) => {
    const i = CURRENT_FROM[s.key];
    return [s.key, reached[i]! - (i === 9 ? 0 : reached[i + 1]!)];
  })) as Record<CurrentStageKey, number>;
  const opportunities = reached[4]! + x.uncertain;
  const [posts, comparablePosts, views, engagements, orders, fullyRefundedOrders, merchandise, refunds] = x.outcomes;
  return {
    reached,
    medianDays,
    current,
    dispatch: { queued: x.queued, toReconcile: x.uncertain },
    closed: { waiting: x.closed[0], declined: x.closed[1], expired: x.closed[2] },
    sends: { approved: reached[3]!, confirmed: reached[4]!, uncertain: x.uncertain, queued: x.queued, replies: x.replies, attempts: opportunities + x.extraAttempts, opportunities },
    outcomes: { posts, comparablePosts, views, engagements, orders, fullyRefundedOrders, merchandise: usd(merchandise), refunds: usd(refunds) },
  };
}

/**
 * Four outbound cells per source. Each source's cells add up to the original 60-opportunity cohort, so the default view is unchanged.
 * Window and policy are not the same thing: an October cohort can still run under the September policy.
 * The inbound cohort is separate (Social Cat applications only): it has no confirmed outbound send, so that stage is N/A, not zero.
 */
const SPLIT: { id: string; network: Cell["network"]; checkout: Cell["checkout"]; window: Cell["window"]; policy: PolicyVersion; facts: Cell["facts"] }[] = [
  { id: "a", network: "instagram", checkout: "website", window: "sep", policy: "policy-2026-09", facts: outbound([24, 20, 15, 12, 11, 8, 6, 5, 4, 3], { uncertain: 1, queued: 0, replies: 6, extraAttempts: 1, closed: [2, 1, 0], outcomes: [4, 3, 26_000, 1_040, 9, 1, 0, 3_000] }) },
  { id: "b", network: "tiktok", checkout: "website", window: "oct", policy: "policy-2026-10", facts: outbound([18, 14, 10, 9, 8, 5, 5, 4, 3, 2], { uncertain: 0, queued: 1, replies: 4, extraAttempts: 0, closed: [1, 1, 1], outcomes: [3, 2, 18_000, 720, 6, 0, 0, 0] }) },
  { id: "c", network: "instagram", checkout: "tiktok-shop", window: "oct", policy: "policy-2026-09", facts: outbound([12, 9, 7, 6, 5, 3, 2, 2, 1, 1], { uncertain: 0, queued: 1, replies: 3, extraAttempts: 0, closed: [1, 0, 1], outcomes: [2, 1, 10_000, 400, 4, 0, 0, 0] }) },
  { id: "d", network: "tiktok", checkout: "tiktok-shop", window: "sep", policy: "policy-2026-09", facts: outbound([6, 5, 4, 3, 3, 2, 2, 1, 1, 0], { uncertain: 0, queued: 0, replies: 2, extraAttempts: 0, closed: [1, 0, 0], outcomes: [1, 0, 6_000, 240, 1, 0, 0, 0] }) },
];
/** Merchandise by cell and source, so each source's total matches the original cohort ($480 Social Cat, $720 TikTok Shop). */
const MERCHANDISE: Record<PipelineSource, number[]> = { "social-cat": [20_000, 14_000, 9_000, 5_000], "tiktok-shop": [30_000, 21_000, 13_000, 8_000] };

const SOURCES: { source: PipelineSource; label: string; nativeMilestone: SourceFacts["nativeMilestone"] }[] = [
  { source: "social-cat", label: "Social Cat", nativeMilestone: "matched" },
  { source: "tiktok-shop", label: "TikTok Shop", nativeMilestone: "accepted" },
];

export const pipelineCells: Cell[] = [
  ...SOURCES.flatMap((s) =>
    SPLIT.map((c, i): Cell => ({
      id: `${s.source}-${c.id}`, source: s.source, route: "outbound", network: c.network, checkout: c.checkout, window: c.window, policy: c.policy,
      facts: { ...c.facts, outcomes: { ...c.facts.outcomes, merchandise: usd(MERCHANDISE[s.source][i]!) } },
    })),
  ),
  {
    id: "social-cat-inbound", source: "social-cat", route: "inbound", network: "instagram", checkout: "website", window: "oct", policy: "policy-2026-10",
    facts: {
      reached: [24, 20, 14, 12, null, 10, 8, 6, 4, 2],
      medianDays: [null, 1, 2, 1, null, 2, 1, 1, 7, 6],
      current: { videoReview: 4, evidenceHold: 6, approvalPending: 2, dispatch: null, matchPending: 2, termsPending: 2, trackingSetup: 2, contentPending: 2, firstOrderPending: 2, generatingOrders: 2 },
      dispatch: null,
      closed: { waiting: 1, declined: 1, expired: 0 },
      sends: null,
      outcomes: { posts: 4, comparablePosts: 3, views: 18_000, engagements: 540, orders: 6, fullyRefundedOrders: 0, merchandise: usd(12_000), refunds: zeroMoney },
    },
  },
];

function addNullable(a: number | null, b: number | null) {
  return a === null || b === null ? null : a + b;
}

/** Sums cells into one source's facts. A median is pooled only when every cell agrees; otherwise it is unknown. */
function aggregate(meta: (typeof SOURCES)[number], cells: Cell[]): SourceFacts {
  const first = cells[0]!.facts;
  const sum = (pick: (f: Cell["facts"]) => number) => cells.reduce((a, c) => a + pick(c.facts), 0);
  const money = (pick: (f: Cell["facts"]) => Money) => usd(cells.reduce((a, c) => a + pick(c.facts).minorUnits, 0));
  return {
    ...meta,
    reached: first.reached.map((_, i) => cells.reduce<number | null>((a, c) => addNullable(a, c.facts.reached[i] ?? null), 0)),
    medianDays: first.medianDays.map((m, i) => (cells.every((c) => (c.facts.medianDays[i] ?? null) === m) ? m : null)),
    current: Object.fromEntries(CURRENT_STAGES.map((s) => [s.key, cells.reduce<number | null>((a, c) => addNullable(a, c.facts.current[s.key]), 0)])) as Record<CurrentStageKey, number | null>,
    dispatch: cells.some((c) => c.facts.dispatch === null) ? null : { queued: sum((f) => f.dispatch!.queued), toReconcile: sum((f) => f.dispatch!.toReconcile) },
    closed: { waiting: sum((f) => f.closed.waiting), declined: sum((f) => f.closed.declined), expired: sum((f) => f.closed.expired) },
    sends: cells.some((c) => c.facts.sends === null) ? null : { approved: sum((f) => f.sends!.approved), confirmed: sum((f) => f.sends!.confirmed), uncertain: sum((f) => f.sends!.uncertain), queued: sum((f) => f.sends!.queued), replies: sum((f) => f.sends!.replies), attempts: sum((f) => f.sends!.attempts), opportunities: sum((f) => f.sends!.opportunities) },
    outcomes: {
      posts: sum((f) => f.outcomes.posts), comparablePosts: sum((f) => f.outcomes.comparablePosts), views: sum((f) => f.outcomes.views), engagements: sum((f) => f.outcomes.engagements),
      orders: sum((f) => f.outcomes.orders), fullyRefundedOrders: sum((f) => f.outcomes.fullyRefundedOrders),
      merchandise: money((f) => f.outcomes.merchandise), refunds: money((f) => f.outcomes.refunds),
    },
  };
}

export const pipelineSources: SourceFacts[] = SOURCES.map((s) => aggregate(s, pipelineCells.filter((c) => c.source === s.source && c.route === "outbound")));

const cohortLabel = (route: PipelineFilters["route"]) => (route === "inbound" ? "Synthetic inbound applications · Sep–Oct 2026" : "Mature synthetic cohort · Sep–Oct 2026");
export const pipelineDemo: PipelineData = {
  datasetKey: "pipeline-demo",
  cohort: { label: cohortLabel("outbound"), asOf: "2026-11-02T17:00:00.000Z", timezone: "America/Los_Angeles", grain: "Opportunity: one per creator and route" },
  filters: DEFAULT_PIPELINE_FILTERS,
  unsplit: [],
  scaleMax: 120,
  sources: pipelineSources,
};

/** The demo's answer to a filtered read: every facet picks cells. An empty selection returns no sources, which the page shows as empty rather than zero. */
export function filterPipeline(filters: PipelineFilters): PipelineData {
  const pick = (c: Cell) =>
    c.route === filters.route &&
    (filters.source === "both" || c.source === filters.source) &&
    (filters.network === "all" || c.network === filters.network) &&
    (filters.checkout === "all" || c.checkout === filters.checkout) &&
    (filters.window === "sep-oct" || c.window === filters.window) &&
    (filters.policy === "all" || c.policy === filters.policy);
  const matching = pipelineCells.filter(pick);
  const sources = SOURCES.flatMap((s) => {
    const cells = matching.filter((c) => c.source === s.source);
    return cells.length ? [aggregate(s, cells)] : [];
  });
  return { ...pipelineDemo, cohort: { ...pipelineDemo.cohort, label: cohortLabel(filters.route) }, filters, unsplit: [], sources };
}
