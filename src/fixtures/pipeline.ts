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

export type SourceFacts = {
  source: PipelineSource;
  label: string;
  /** Opportunities that reached each stage, in `PIPELINE_STAGES` order. Null is unknown, never zero. */
  reached: (number | null)[];
  /** Median days from the previous stage among reached opportunities. Null when timestamps are missing. */
  medianDays: (number | null)[];
  current: Record<CurrentStageKey, number>;
  dispatch: { queued: number; toReconcile: number };
  closed: { waiting: number; declined: number; expired: number };
  sends: { approved: number; confirmed: number; uncertain: number; queued: number; replies: number; attempts: number; opportunities: number };
  /** The source's own word for the milestone: Social Cat creates a match, TikTok records acceptance. */
  nativeMilestone: "matched" | "accepted";
  outcomes: { posts: number; comparablePosts: number; views: number; engagements: number; orders: number; fullyRefundedOrders: number; merchandise: Money; refunds: Money };
};

export type PipelineFilters = { source: "both" | PipelineSource; network: "all" | "instagram" | "tiktok"; checkout: "all" | "website" | "tiktok-shop"; window: "sep-oct" | "sep" | "oct" };
export const DEFAULT_PIPELINE_FILTERS: PipelineFilters = { source: "both", network: "all", checkout: "all", window: "sep-oct" };

export type PipelineData = {
  datasetKey: "pipeline-demo";
  cohort: { label: string; asOf: string; timezone: string; grain: string };
  filters: PipelineFilters;
  /** Filters set to a non-default value that this demo dataset can't split. The counts don't change for them. */
  unsplit: (keyof PipelineFilters)[];
  /** The funnel's shared vertical scale: the unfiltered discovered count, so a filtered funnel stays comparable. */
  scaleMax: number;
  sources: SourceFacts[];
};

const usd = (minorUnits: number): Money => ({ minorUnits, currency: "USD" });

const medianDays = [null, 1, 1, 1, 1, 4, 1, 1, 7, 6];

const common = {
  medianDays,
  current: { videoReview: 12, evidenceHold: 12, approvalPending: 6, dispatch: 3, matchPending: 9, termsPending: 3, trackingSetup: 3, contentPending: 3, firstOrderPending: 3, generatingOrders: 6 },
  dispatch: { queued: 2, toReconcile: 1 },
  closed: { waiting: 5, declined: 2, expired: 2 },
  sends: { approved: 30, confirmed: 27, uncertain: 1, queued: 2, replies: 15, attempts: 29, opportunities: 28 },
};

export const pipelineSources: SourceFacts[] = [
  { ...common, source: "social-cat", label: "Social Cat", nativeMilestone: "matched", reached: [60, 48, 36, 30, 27, 18, 15, 12, 9, 6], outcomes: { posts: 10, comparablePosts: 6, views: 60_000, engagements: 2_400, orders: 20, fullyRefundedOrders: 1, merchandise: usd(48_000), refunds: usd(3_000) } },
  { ...common, source: "tiktok-shop", label: "TikTok Shop", nativeMilestone: "accepted", reached: [60, 48, 36, 30, 27, 18, 15, 12, 9, 6], outcomes: { posts: 10, comparablePosts: 6, views: 60_000, engagements: 2_400, orders: 20, fullyRefundedOrders: 1, merchandise: usd(72_000), refunds: usd(3_000) } },
];

export const pipelineDemo: PipelineData = {
  datasetKey: "pipeline-demo",
  cohort: { label: "Mature synthetic cohort · Sep–Oct 2026", asOf: "2026-11-02T17:00:00.000Z", timezone: "America/Los_Angeles", grain: "Opportunity: one per creator and route" },
  filters: DEFAULT_PIPELINE_FILTERS,
  unsplit: [],
  scaleMax: 120,
  sources: pipelineSources,
};

/** The demo's answer to a filtered read. Only the source facet can split this dataset; the rest are reported as unsplit. */
export function filterPipeline(filters: PipelineFilters): PipelineData {
  const unsplit = (["network", "checkout", "window"] as const).filter((key) => filters[key] !== DEFAULT_PIPELINE_FILTERS[key]);
  return { ...pipelineDemo, filters, unsplit, sources: pipelineSources.filter((s) => filters.source === "both" || s.source === filters.source) };
}
