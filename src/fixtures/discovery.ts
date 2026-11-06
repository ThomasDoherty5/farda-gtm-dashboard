/**
 * Daily sourcing fixture (Figma source 102:555) — SYNTHETIC. The 50-prospect batch is illustrative and
 * is not a sourcing result or a cohort funnel. Do not mix its numbers with other datasets.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import { BASE_POLICY, type AcquisitionTerms } from "@/adapter/commissionPolicy";
import { DEMO_NOW } from "./overview";

export type CapacityRow = { id: "social-cat" | "tiktok-shop" | "shared"; source: string; evidence: string; meaning: string; next: string };

/** One step of the daily plan, with the person who owns it, the evidence behind its count and the next action. A null count is unknown. */
export type PlanStep = { title: string; count: number | null; countLabel: string; owner: string; evidence: string; next: string };

/** From profiles surfaced to the batch's 50 selected. Each stage removes a named reason, so the numbers reconcile. */
export type IdentityFunnel = {
  surfaced: number;
  /** Profiles merged into an identity already counted: the same creator on both networks or under a changed handle. */
  mergedDuplicates: number;
  suppressed: { optedOut: number; declinedRecently: number; existingRelationship: number };
  selected: number;
};

export type PlanVersions = {
  /** The source account the plan reads from. Unknown until an authorized read. */
  sourceAccount: ProvenanceValue<string>;
  icpVersion: string;
  policyVersion: string;
  accessStatus: string;
  /** Draft until a schedule, timezone and source account are all configured. Never "active" while any is missing. */
  scheduleStatus: "draft" | "active";
};

export type DiscoveryData = {
  datasetKey: "discovery-demo";
  schedule: { label: string; context: string };
  liveCapacity: ProvenanceValue<number>;
  liveCapacityContext: string;
  model: { label: string; context: string };
  upfrontFee: ProvenanceValue<Money>;
  phases: { title: string; note: string }[];
  /** Index into `phases` of the phase this plan is currently on. */
  currentPhase: number;
  capacityRows: CapacityRow[];
  versions: PlanVersions;
  steps: PlanStep[];
  identity: IdentityFunnel;
  batch: { batchId: string; selected: number; eligible: number; sampleUnits: number; sampleUnitCost: Money; rateLabel: string };
};

const base = { evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: DEMO_NOW, observedAt: DEMO_NOW };

/** The synthetic plan names the economic terms independently of their display label. */
export const discoveryCommission = {
  relationship: "commissionOnly", commissionPct: 12, perSaleFixedMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0,
} satisfies Pick<AcquisitionTerms, "relationship" | "commissionPct" | "perSaleFixedMinor" | "guaranteedFeeMinor" | "paidComponentMinor">;

export const discoveryDemo: DiscoveryData = {
  datasetKey: "discovery-demo",
  schedule: { label: "Draft", context: "Daily cadence · timezone to confirm" },
  liveCapacity: { ...base, state: "unknown", value: null, reasonCode: "CAPACITY_NOT_READ" },
  liveCapacityContext: "Read current account units and reset",
  model: { label: "Pending", context: "Evidence review and validation required" },
  upfrontFee: { ...base, state: "known", value: { minorUnits: 0, currency: "USD" }, reasonCode: null },
  phases: [
    { title: "Discover", note: "Permitted source search" },
    { title: "Watch", note: "Actual lifestyle footage" },
    { title: "Qualify", note: "Evidence + current model" },
    { title: "Draft", note: "Commission-only terms" },
    { title: "Approve", note: "Finite recipients + terms" },
    { title: "Confirm", note: "Native source receipts" },
  ],
  currentPhase: 1,
  capacityRows: [
    { id: "social-cat", source: "Social Cat · invitations / matches", evidence: "Unverified", meaning: "Read native plan, remaining units and reset", next: "Validate platform authorization" },
    { id: "tiktok-shop", source: "TikTok Shop · invitations", evidence: "Unverified", meaning: "Read account/action-specific limits", next: "Validate native/API route" },
    { id: "shared", source: "Product and shipping", evidence: "Separate approval", meaning: "Approved units/cost; never an earned-commission cap", next: "Check available stock" },
    { id: "shared", source: "Account action permission", evidence: "Unverified", meaning: "Missing API is different from denied authority", next: "Authorized owner handoff" },
  ],
  versions: {
    sourceAccount: { ...base, state: "unknown", value: null, reasonCode: "ACCOUNT_NOT_READ" },
    icpVersion: "ICP draft v0 · not approved",
    policyVersion: BASE_POLICY.version,
    accessStatus: "Unverified",
    scheduleStatus: "draft",
  },
  steps: [
    { title: "Discover", count: 80, countLabel: "profiles surfaced", owner: "Creator agent", evidence: "Permitted source search · demo", next: "Merge duplicate identities" },
    { title: "Watch", count: 50, countLabel: "selected for video review", owner: "Operator", evidence: "Lifestyle footage required", next: "Open the original clips" },
    { title: "Qualify", count: 24, countLabel: "eligible, 26 held", owner: "Thomas", evidence: "Evidence + current model (pending)", next: "Resolve held reasons" },
    { title: "Draft", count: 24, countLabel: "commission-only drafts", owner: "Creator agent", evidence: "Exact terms · $0 upfront fee", next: "Review exact terms" },
    { title: "Approve", count: 0, countLabel: "approved · none requested yet", owner: "Thomas", evidence: "Finite recipients + terms", next: "Request approval for the batch" },
    { title: "Confirm", count: null, countLabel: "confirmed · N/A until a send", owner: "Operations", evidence: "Native source receipts", next: "Wait for an approved send" },
  ],
  identity: { surfaced: 80, mergedDuplicates: 18, suppressed: { optedOut: 3, declinedRecently: 5, existingRelationship: 4 }, selected: 50 },
  batch: { batchId: "BATCH-TT-DEMO-024", selected: 50, eligible: 24, sampleUnits: 12, sampleUnitCost: { minorUnits: 2_500, currency: "USD" }, rateLabel: `${discoveryCommission.commissionPct}% standard-rate` },
};

/** What each run state means for the sample batch and what happens next. A state with no item reads 0 because the batch's items are known. */
export type RunStateRow = { key: string; label: string; meaning: string; next: string; batchState: "confirmed" | "queued" | "running" | "reconcile" | "login" | "paused" | null };
export const RUN_STATES: RunStateRow[] = [
  { key: "queued", label: "Queued", meaning: "Approved and waiting for a source slot", next: "Revalidate the source before sending", batchState: "queued" },
  { key: "running", label: "Running", meaning: "A source action is in progress", next: "Wait for the native result", batchState: "running" },
  { key: "deferred", label: "Deferred", meaning: "Held back by a quota or rate limit", next: "Resume after the source resets", batchState: null },
  { key: "login", label: "Login / MFA", meaning: "The account needs a person to sign in", next: "Human takeover", batchState: "login" },
  { key: "denied", label: "Denied", meaning: "The source refused the action", next: "Owner handoff; never retried blindly", batchState: null },
  { key: "paused", label: "Paused", meaning: "New work stopped; unsent items wait", next: "Resume or cancel the unsent items", batchState: "paused" },
  { key: "confirmed", label: "Confirmed", meaning: "A source receipt exists", next: "No further dispatch", batchState: "confirmed" },
  { key: "failed", label: "Failed", meaning: "The source reported an error", next: "Review the cause, then retry", batchState: null },
  { key: "uncertain", label: "Uncertain", meaning: "No receipt and no refusal", next: "Reconcile before any retry", batchState: "reconcile" },
];
