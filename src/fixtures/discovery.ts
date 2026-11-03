/**
 * Daily sourcing fixture (Figma source 102:555) — SYNTHETIC. The 50-prospect batch is illustrative and
 * is not a sourcing result or a cohort funnel. Do not mix its numbers with other datasets.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import { DEMO_NOW } from "./overview";

export type CapacityRow = { id: "social-cat" | "tiktok-shop" | "shared"; source: string; evidence: string; meaning: string; next: string };

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
  batch: { batchId: string; selected: number; eligible: number; sampleUnits: number; sampleUnitCost: Money; rateLabel: string };
};

const base = { evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: DEMO_NOW, observedAt: DEMO_NOW };

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
  batch: { batchId: "BATCH-TT-DEMO-024", selected: 50, eligible: 24, sampleUnits: 12, sampleUnitCost: { minorUnits: 2_500, currency: "USD" }, rateLabel: "12% standard-rate" },
};
