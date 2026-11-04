/**
 * Terminal paths and optional branches of the acquisition pipeline (CF-05, CF-07) — SYNTHETIC. The counts belong to the same
 * 120-opportunity demo cohort as pipeline.ts and must reconcile with it. Null is unknown or not applicable, never zero.
 */
import type { PipelineSource } from "./pipeline";

export type TerminalKind = "declined" | "optOut" | "expired";
export type RepeatCase = {
  /** A synthetic placeholder handle, never a real creator. */
  handle: string;
  prior: TerminalKind;
  source: PipelineSource;
  /** Whether a new opportunity may be opened at all. An opt-out never can. */
  repeatAllowed: boolean;
  suppression: "preserved" | "permanent";
};

export type BranchSource = {
  source: PipelineSource;
  label: string;
  terminal: Record<TerminalKind, number>;
  /** Accepted or matched opportunities, split by whether a sample was requested. A sample is optional. */
  sample: { accepted: number; requested: number; notRequested: number; stockCostApproved: number; shipped: number; delivered: number | null };
  /** Terms confirmed, split by whether the terms create a content obligation. */
  content: { terms: number; withObligation: number; withoutObligation: number; posted: number; due: number; overdue: number; postedVoluntarily: number; noneYet: number; trackingActive: number };
};

export type BranchesData = {
  datasetKey: "pipeline-branches-demo";
  cohort: string;
  sources: BranchSource[];
  repeatCases: RepeatCase[];
};

export const branchesDemo: BranchesData = {
  datasetKey: "pipeline-branches-demo",
  cohort: "Mature synthetic cohort · Sep–Oct 2026",
  sources: [
    {
      source: "social-cat", label: "Social Cat",
      terminal: { declined: 2, optOut: 1, expired: 2 },
      sample: { accepted: 18, requested: 12, notRequested: 6, stockCostApproved: 8, shipped: 6, delivered: 5 },
      content: { terms: 15, withObligation: 9, withoutObligation: 6, posted: 4, due: 3, overdue: 2, postedVoluntarily: 2, noneYet: 4, trackingActive: 12 },
    },
    {
      source: "tiktok-shop", label: "TikTok Shop",
      terminal: { declined: 2, optOut: 1, expired: 2 },
      sample: { accepted: 18, requested: 9, notRequested: 9, stockCostApproved: 6, shipped: 5, delivered: null },
      content: { terms: 15, withObligation: 6, withoutObligation: 9, posted: 3, due: 2, overdue: 1, postedVoluntarily: 3, noneYet: 6, trackingActive: 12 },
    },
  ],
  repeatCases: [
    { handle: "@demo.creator.07", prior: "declined", source: "social-cat", repeatAllowed: true, suppression: "preserved" },
    { handle: "@demo.creator.12", prior: "expired", source: "tiktok-shop", repeatAllowed: true, suppression: "preserved" },
    { handle: "@demo.creator.19", prior: "optOut", source: "social-cat", repeatAllowed: false, suppression: "permanent" },
  ],
};
