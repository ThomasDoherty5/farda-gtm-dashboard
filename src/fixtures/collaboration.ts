/**
 * Collaboration fixture (Figma sources 9:299 and 9:436) — SYNTHETIC. COL-SC-042 is an existing collaboration
 * with an accepted historical fee, so it is the one place a $150 fee is allowed to appear, read-only.
 * Handles, dates and rights are illustrative. Nothing here is sent or accepted.
 */
import type { Money } from "@/adapter/contract";

export const COLLABORATION_ID = "demo-collaboration-1";
export const COLLABORATION_REF = "COL-SC-042";

export type EventState = "Completed" | "Running" | "Pending";
export type RightsRow = { key: string; label: string; value: string };

export type CollaborationData = {
  datasetKey: "collaboration-demo";
  collaborationId: string;
  ref: string;
  handle: string;
  channel: string;
  owner: string;
  stage: string;
  /** The deliverable and its accepted, historical terms. The fee is read-only and never offered again. */
  terms: { deliverable: string; agreedFee: Money; postingDue: string; graceDays: number; sourceRecord: string; revisionRounds: { allowed: number; used: number } };
  timeline: { title: string; note: string; state: EventState }[];
  eligibility: { current: string; suppression: string; lastDecision: string; suppressed: boolean };
  /** What the server will accept as a next action for this collaboration. */
  allowedActions: { key: string; label: string }[];
  closureOutcomes: string[];
  unresolved: string[];
  content: {
    version: string;
    title: string;
    receivedAt: string;
    checklist: { label: string; result: "Pass" | "Needs review" | "Missing license" | "Pending" }[];
    revisions: string[];
    rights: RightsRow[];
    licenseSigned: boolean;
    proposedFeedback: string;
  };
  /** Requests already queued for approval. Queued is not approved, and approved is not sent. */
  requests: { id: string; kind: string; summary: string; version: string; state: "approvalPending" }[];
};

export const collaborationDemo: CollaborationData = {
  datasetKey: "collaboration-demo",
  collaborationId: COLLABORATION_ID,
  ref: COLLABORATION_REF,
  handle: "@routine.with.ella",
  channel: "Social Cat",
  owner: "Thomas",
  stage: "Creating",
  terms: { deliverable: "30–45 second video", agreedFee: { minorUnits: 15_000, currency: "USD" }, postingDue: "2026-11-04", graceDays: 3, sourceRecord: `Notion · ${COLLABORATION_REF}`, revisionRounds: { allowed: 2, used: 1 } },
  timeline: [
    { title: "Applicant vetted", note: "Audience fit reviewed; source profile linked.", state: "Completed" },
    { title: "Terms agreed", note: "Approved brief accepted in Social Cat.", state: "Completed" },
    { title: "Sample delivered", note: "Shipment reference linked to source ledger.", state: "Completed" },
    { title: "Draft under review", note: "Draft v2 received; one revision round remains.", state: "Running" },
    { title: "Direct fee and close", note: "Founder approval, settlement and ledger reconciliation.", state: "Pending" },
  ],
  eligibility: { current: "Eligible · demo state", suppression: "No active suppression", lastDecision: "Operator review required", suppressed: false },
  allowedActions: [{ key: "reviewDraft", label: "Review draft v2" }, { key: "remindCreator", label: "Remind the creator about the posting due date" }, { key: "recordNote", label: "Record a note in the source" }],
  closureOutcomes: ["Declined", "No response", "Opted out", "Canceled", "Completed"],
  unresolved: ["Draft v2 is under review", "The agreed fee has no settlement yet", "The signed usage license is missing"],
  content: {
    version: "v2",
    title: "Everyday routine / draft v2",
    receivedAt: "29 Oct, 11:20 PT",
    checklist: [
      { label: "Matches agreed brief", result: "Pass" },
      { label: "Product statements and claims", result: "Needs review" },
      { label: "Audio and visual quality", result: "Pass" },
      { label: "Usage rights attached", result: "Missing license" },
      { label: "Final asset link captured", result: "Pending" },
    ],
    revisions: ["v1 · Revision requested · feedback approved and sent", "v2 · Received · current review", "Final · Not approved yet"],
    rights: [
      { key: "organic", label: "Organic use", value: "Agreed scope" },
      { key: "paid", label: "Paid advertising", value: "Not granted" },
      { key: "whitelisting", label: "Whitelisting", value: "Not granted" },
      { key: "expiry", label: "License expiry", value: "31 Jan 2027 · example" },
      { key: "license", label: "Signed license", value: "Missing" },
    ],
    licenseSigned: false,
    proposedFeedback: "Please update the opening to match the agreed brief and attach the signed usage license. The rest of the draft looks ready for final review.",
  },
  requests: [],
};

/** Review is due after the posting due date plus the grace period. Derived, so it can't disagree with its inputs. */
export function reviewAfter(postingDue: string, graceDays: number): string {
  const d = new Date(`${postingDue}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + graceDays);
  return d.toISOString().slice(0, 10);
}

export const revisionsRemaining = (r: CollaborationData["terms"]["revisionRounds"]) => Math.max(0, r.allowed - r.used);
export const approvalBlocker = (c: CollaborationData): string | null => (c.content.licenseSigned ? null : "Acceptance remains blocked while the required license is missing.");
