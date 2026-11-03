/**
 * Evidence review fixtures (Figma source 102:364) — SYNTHETIC. Media addresses are made up and are never
 * fetched. No clip is played, so nothing here is real footage or a completed review.
 */
import type { ProvenanceValue } from "@/adapter/contract";
import type { EvidenceRecord } from "@/features/acquisition/evidenceTypes";
import { DEMO_NOW } from "./overview";

export const DEMO_EVIDENCE_PARTIAL_ID = "demo-evidence-2";
export const DEMO_MEDIA_URL = "https://www.instagram.com/reel/DEMOREEL001/";

const unknown = (reasonCode: string): ProvenanceValue<number> => ({ state: "unknown", value: null, reasonCode, evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: null, observedAt: DEMO_NOW });

const base = (evidenceRef: string, over: Partial<EvidenceRecord>): EvidenceRecord => ({
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
  ...over,
});

export const seedEvidence = (): EvidenceRecord[] => [
  base("demo-evidence-1", {}),
  base(DEMO_EVIDENCE_PARTIAL_ID, {
    version: "v3",
    mediaUrl: DEMO_MEDIA_URL,
    savedAt: DEMO_NOW,
    reviewerRole: "reviewer",
    observations: [
      { id: "obs-seed-1", category: "hook", startSec: 0, endSec: 8, text: "Opens on a morning routine at a desk.", recordedAgainst: DEMO_MEDIA_URL },
      { id: "obs-seed-2", category: "demonstration", startSec: 8, endSec: 31, text: "Shows the product being used during the routine.", recordedAgainst: DEMO_MEDIA_URL },
      { id: "obs-seed-3", category: "audio", startSec: 0, endSec: 12, text: "Voiceover over soft music.", recordedAgainst: DEMO_MEDIA_URL },
    ],
  }),
];
