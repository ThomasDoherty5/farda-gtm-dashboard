/**
 * Bulk batch fixture (Figma source 66:821) — SYNTHETIC. One finite 24-recipient TikTok batch drawn from the
 * 50-prospect example in discovery.ts. Nothing here dispatches. Counts are derived from the items.
 */
import type { Owner } from "./creators";

export const BATCH_ID = "demo-batch-tt-024";
export const BATCH_LABEL = "BATCH-TT-DEMO-024";

/** confirmed, queued and running; the first two kinds of "reconcile" and "login" need a person. */
export type ItemState = "confirmed" | "queued" | "running" | "reconcile" | "login" | "paused" | "canceled";
export type BatchItem = { id: string; handle: string; terms: string; evidence: string; next: string; state: ItemState };
export type HeldReason = { key: string; label: string; byOwner: Record<Owner, number> };

/** A creator's request for a TikTok Shop sample. A decision counts only once TikTok's own API acknowledges it with a receipt. */
export type SampleDecision = "pending" | "approved" | "declined" | "handoff";
export type SampleRequest = {
  id: string;
  handle: string;
  product: string;
  units: number;
  /** "api" is a route verified for this account. "authorityDenied" is a route TikTok refuses for this account's scope. */
  route: "api" | "authorityDenied";
  state: SampleDecision;
  receiptRef: string | null;
  /** Who takes over when the API route is denied. */
  ownerRef: string | null;
};

export const seedSamples = (): SampleRequest[] => [
  { id: "SR-001", handle: "@pilot.creator.17", product: "Demo carry set", units: 1, route: "api", state: "pending", receiptRef: null, ownerRef: null },
  { id: "SR-002", handle: "@pilot.creator.18", product: "Demo carry set", units: 1, route: "api", state: "pending", receiptRef: null, ownerRef: null },
  { id: "SR-003", handle: "@pilot.creator.19", product: "Demo carry set", units: 1, route: "authorityDenied", state: "pending", receiptRef: null, ownerRef: null },
];

export type BatchData = {
  datasetKey: "batch-demo";
  batchId: string;
  version: string;
  paused: boolean;
  items: BatchItem[];
  held: HeldReason[];
  samples: SampleRequest[];
  filters: { source: "tiktok" | "all"; deal: "affiliate" | "all"; owner: "all" | Owner };
  model: { label: string; status: "pending" };
  capacity: { nativeInvitations: number | null; sampleUnits: number; sampleCostMinor: number; collaborationSlots: null };
};

const no = (n: number) => String(n).padStart(3, "0");
const id = (n: number) => `DEMO-${no(n)}`;

/** Order and wording per state, from Figma's example rows. */
const WORDS: Record<"confirmed" | "queued" | "running" | "reconcile" | "login", Pick<BatchItem, "terms" | "evidence" | "next">> = {
  confirmed: { terms: "12% standard · no new sample", evidence: "Complete demo", next: "No further dispatch" },
  queued: { terms: "12% standard · sample $25", evidence: "Complete demo", next: "Revalidate source before send" },
  running: { terms: "12% standard · sample reserved", evidence: "Complete demo", next: "Wait for native result" },
  reconcile: { terms: "12% standard · sample $25", evidence: "Receipt missing", next: "Native reconciliation before retry" },
  login: { terms: "12% standard · no new sample", evidence: "Access needs renewal", next: "Human login / MFA takeover" },
};

const plan: [number, keyof typeof WORDS][] = [[16, "confirmed"], [3, "queued"], [2, "running"], [2, "reconcile"], [1, "login"]];

export const seedItems = (): BatchItem[] => {
  let n = 0;
  return plan.flatMap(([count, state]) =>
    Array.from({ length: count }, () => {
      n += 1;
      return { id: id(n), handle: `@pilot.creator.${String(n).padStart(2, "0")}`, state, ...WORDS[state] };
    }),
  );
};

const by = (thomas: number, operations: number, agent: number, operator: number): Record<Owner, number> => ({ Thomas: thomas, Operations: operations, "Creator agent": agent, Operator: operator });

/** The 26 prospects held by one exclusive primary reason each. */
export const heldReasons: HeldReason[] = [
  { key: "evidence", label: "Missing evidence", byOwner: by(3, 1, 2, 2) },
  { key: "duplicate", label: "Duplicate offer", byOwner: by(1, 1, 3, 1) },
  { key: "budget", label: "Budget", byOwner: by(2, 2, 0, 1) },
  { key: "inventory", label: "Sample inventory", byOwner: by(0, 4, 0, 0) },
  { key: "quota", label: "Native quota", byOwner: by(1, 0, 1, 1) },
];

export const DEFAULT_BATCH_FILTERS: BatchData["filters"] = { source: "tiktok", deal: "affiliate", owner: "all" };
export const UNSENT: ItemState[] = ["queued", "paused"];
export const isUnsent = (s: ItemState) => UNSENT.includes(s);
