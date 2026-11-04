/**
 * Evidence review fixtures (Figma source 102:364) — SYNTHETIC. Media addresses are made up and are never
 * fetched. No clip is played, so nothing here is real footage or a completed review.
 */
import type { ProvenanceValue } from "@/adapter/contract";
import type { Dispute, EvidenceRecord, FirstReview } from "@/features/acquisition/evidenceTypes";
import { readinessOf } from "@/features/acquisition/evidenceRules";
import { DEMO_NOW } from "./overview";

const withReadiness = (r: EvidenceRecord): EvidenceRecord => ({ ...r, readiness: readinessOf(r) });

export const DEMO_EVIDENCE_PARTIAL_ID = "demo-evidence-2";
/** A reviewed record with one override already on file, so the dispute log can be read without making one. */
export const DEMO_EVIDENCE_DISPUTED_ID = "demo-evidence-3";
export const DEMO_MEDIA_URL = "https://www.instagram.com/reel/DEMOREEL001/";

const unknown = (reasonCode: string): ProvenanceValue<number> => ({ state: "unknown", value: null, reasonCode, evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: null, observedAt: DEMO_NOW });

const base = (evidenceRef: string, over: Partial<EvidenceRecord>): EvidenceRecord => withReadiness({
  evidenceRef,
  creatorHandle: "@demo.creator",
  version: "v1",
  mediaUrl: null,
  checkoutRoute: "website",
  observations: [],
  savedAt: null,
  reviewerRole: null,
  modelPublication: { label: "Pending", note: "No approved numerical v3 weights." },
  assessments: { creative: unknown("NO_COMPLETE_REVIEW"), routine: unknown("NO_COMPLETE_REVIEW"), commerce: unknown("NO_ATTRIBUTED_OUTCOMES") },
  firstReview: null,
  disputes: [],
  readiness: { state: "notReady", reasonCodes: ["NO_COMPLETE_REVIEW"] },
  ...over,
});

const firstOf = (r: EvidenceRecord): FirstReview => ({ version: r.version, recordedAt: DEMO_NOW, reviewerRole: "reviewer", mediaUrl: r.mediaUrl, checkoutRoute: r.checkoutRoute, observations: structuredClone(r.observations) });

const partial = (id: string): EvidenceRecord => {
  const record = base(id, {
    version: "v3",
    mediaUrl: DEMO_MEDIA_URL,
    savedAt: DEMO_NOW,
    reviewerRole: "reviewer",
    observations: [
      { id: "obs-seed-1", category: "hook", startSec: 0, endSec: 8, text: "Opens on a morning routine at a desk.", recordedAgainst: DEMO_MEDIA_URL },
      { id: "obs-seed-2", category: "demonstration", startSec: 8, endSec: 31, text: "Shows the product being used during the routine.", recordedAgainst: DEMO_MEDIA_URL },
      { id: "obs-seed-3", category: "audio", startSec: 0, endSec: 12, text: "Voiceover over soft music.", recordedAgainst: DEMO_MEDIA_URL },
    ],
  });
  return withReadiness({ ...record, firstReview: firstOf(record) });
};

export const seedEvidence = (): EvidenceRecord[] => {
  const disputed = partial(DEMO_EVIDENCE_DISPUTED_ID);
  const dispute: Dispute = {
    id: "dispute-seed-1",
    observationId: "obs-seed-3",
    stance: "override",
    reason: "The audio is music only; there is no voiceover in the first twelve seconds.",
    proposed: { category: "audio", startSec: 0, endSec: 12, text: "Music only, no speech." },
    prior: structuredClone(disputed.observations[2]!),
    reviewerRole: "second reviewer",
    recordedAt: DEMO_NOW,
    recordedAgainst: DEMO_MEDIA_URL,
    recordedRoute: disputed.checkoutRoute,
  };
  return [base("demo-evidence-1", {}), partial(DEMO_EVIDENCE_PARTIAL_ID), withReadiness({ ...disputed, version: "v4", disputes: [dispute] })];
};
