/**
 * View models for video evidence review (THO-288). PROPOSED: the handoff lists the facts required
 * (media identity, observed intervals, separate visual and audio coverage, reviewer and version);
 * THO-283 and THO-326 freeze the real schemas.
 */
import type { ProvenanceValue } from "@/adapter/contract";

export type ObservationCategory = "hook" | "demonstration" | "framing" | "audio";
export type Modality = "visual" | "audio";
export type CheckoutRoute = "website" | "tiktok-shop";

export type Observation = {
  id: string;
  category: ObservationCategory;
  startSec: number;
  endSec: number;
  text: string;
  /** The media address this was recorded against. A different address invalidates it. */
  recordedAgainst: string;
};

export type EvidenceRecord = {
  evidenceRef: string;
  creatorHandle: string;
  version: string;
  mediaUrl: string | null;
  checkoutRoute: CheckoutRoute;
  observations: Observation[];
  savedAt: string | null;
  reviewerRole: string | null;
  modelPublication: { label: string; note: string };
  assessments: { creative: ProvenanceValue<number>; routine: ProvenanceValue<number>; commerce: ProvenanceValue<number> };
};

/** What a save sends: the full desired draft. There is no "watched" field, by design. */
export type EvidenceDraft = { mediaUrl: string | null; checkoutRoute: CheckoutRoute; observations: Observation[] };
