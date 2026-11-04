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

/**
 * The first reviewer's record, frozen when the first observations are saved. Later drafts, disagreements and overrides
 * never change it (VE-08): it is what the first reviewer recorded, kept so a dispute is always read beside it.
 */
export type FirstReview = {
  version: string;
  recordedAt: string;
  reviewerRole: string;
  mediaUrl: string | null;
  checkoutRoute: CheckoutRoute;
  observations: Observation[];
};

export type DisputeStance = "disagree" | "override";
export type ProposedObservation = Pick<Observation, "category" | "startSec" | "endSec" | "text">;

/**
 * A second reviewer's disagreement or override of one observation in the first record. It is added beside the original with a
 * reason and a copy of what it disputes; it never replaces it, does not change coverage and does not authorize anything.
 */
export type Dispute = {
  id: string;
  observationId: string;
  stance: DisputeStance;
  reason: string;
  /** What the reviewer says it should be: a replacement, "remove", or nothing for a plain disagreement. */
  proposed: ProposedObservation | "remove" | null;
  /** The first reviewer's observation exactly as it was when disputed. */
  prior: Observation;
  reviewerRole: string;
  recordedAt: string;
  /** The video the first record described. If the draft's video later differs, this dispute no longer applies. */
  recordedAgainst: string | null;
};

/** Why this evidence is not ready. There is no completed-review path, so "no complete review" is always a reason. */
export type Readiness = { state: "notReady"; reasonCodes: string[] };

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
  firstReview: FirstReview | null;
  disputes: Dispute[];
  readiness: Readiness;
};

/** What a save sends: the full desired draft. There is no "watched" field, by design. */
export type EvidenceDraft = { mediaUrl: string | null; checkoutRoute: CheckoutRoute; observations: Observation[] };

/** What a dispute sends. The server rechecks every rule; `proposed` is null for a plain disagreement. */
export type DisputeDraft = { kind: "dispute"; observationId: string; stance: DisputeStance; reason: string; proposed: ProposedObservation | "remove" | null };
