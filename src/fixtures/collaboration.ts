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

/**
 * Whether the accepted terms create a posting obligation. Only a committed post has a due date and grace period.
 * A voluntary post has none: the collaboration is observed for a fixed window, then closed, and the sample cost is retained.
 */
export type PostingTerms =
  | { kind: "committed"; due: string; graceDays: number }
  | { kind: "voluntary"; sampleDelivered: string; observeDays: number; sampleCost: Money };

export type CollaborationData = {
  datasetKey: "collaboration-demo";
  /** The server's date for timing rules (YYYY-MM-DD). The page never reads the browser clock for an obligation. */
  asOf: string;
  collaborationId: string;
  ref: string;
  handle: string;
  channel: string;
  owner: string;
  stage: string;
  /** The deliverable and its accepted, historical terms. The fee is read-only and never offered again. */
  terms: { deliverable: string; agreedFee: Money | null; posting: PostingTerms; sourceRecord: string; revisionRounds: { allowed: number; used: number } };
  timeline: { title: string; note: string; state: EventState }[];
  eligibility: { current: string; suppression: string; lastDecision: string; suppressed: boolean };
  /** What the server will accept as a next action for this collaboration. */
  allowedActions: { key: string; label: string }[];
  closureOutcomes: string[];
  unresolved: string[];
  /** Null when nothing has been submitted. A voluntary collaboration may never have content, and that is not a failed review. */
  content: {
    version: string;
    title: string;
    receivedAt: string;
    checklist: { label: string; result: "Pass" | "Needs review" | "Missing license" | "Pending" }[];
    revisions: string[];
    rights: RightsRow[];
    licenseSigned: boolean;
    proposedFeedback: string;
  } | null;
  /** Requests already queued for approval. Queued is not approved, and approved is not sent. */
  requests: { id: string; kind: string; summary: string; version: string; state: "approvalPending" }[];
};

export const collaborationDemo: CollaborationData = {
  datasetKey: "collaboration-demo",
  asOf: "2026-11-04",
  collaborationId: COLLABORATION_ID,
  ref: COLLABORATION_REF,
  handle: "@routine.with.ella",
  channel: "Social Cat",
  owner: "Thomas",
  stage: "Creating",
  terms: { deliverable: "30–45 second video", agreedFee: { minorUnits: 15_000, currency: "USD" }, posting: { kind: "committed", due: "2026-11-04", graceDays: 3 }, sourceRecord: `Notion · ${COLLABORATION_REF}`, revisionRounds: { allowed: 2, used: 1 } },
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

export const VOLUNTARY_COLLABORATION_ID = "demo-collaboration-2";
export const VOLUNTARY_COLLABORATION_REF = "COL-SC-051";

/**
 * A gifted sample whose accepted terms commit the creator to nothing. A post would be voluntary, so no posting date,
 * grace period or reminder applies; it is observed for a window and then closed, and the sample cost stays on record.
 */
export const voluntaryCollaborationDemo: CollaborationData = {
  datasetKey: "collaboration-demo",
  asOf: "2026-11-04",
  collaborationId: VOLUNTARY_COLLABORATION_ID,
  ref: VOLUNTARY_COLLABORATION_REF,
  handle: "@quiet.mornings.ivy",
  channel: "Social Cat",
  owner: "Thomas",
  stage: "Observing",
  terms: { deliverable: "None committed · a post would be voluntary", agreedFee: null, posting: { kind: "voluntary", sampleDelivered: "2026-10-14", observeDays: 30, sampleCost: { minorUnits: 1_840, currency: "USD" } }, sourceRecord: `Notion · ${VOLUNTARY_COLLABORATION_REF}`, revisionRounds: { allowed: 0, used: 0 } },
  timeline: [
    { title: "Applicant vetted", note: "Audience fit reviewed; source profile linked.", state: "Completed" },
    { title: "Sample accepted", note: "Gifted sample accepted. The terms ask for no post.", state: "Completed" },
    { title: "Sample delivered", note: "Shipment reference linked to source ledger.", state: "Completed" },
    { title: "Observing for voluntary content", note: "Read-only checks of the linked profile. No reminder is sent.", state: "Running" },
    { title: "Close at the end of the window", note: "Close as No response, or as Completed if content appears.", state: "Pending" },
  ],
  eligibility: { current: "Eligible · demo state", suppression: "No active suppression", lastDecision: "Observation window open", suppressed: false },
  allowedActions: [{ key: "recordNote", label: "Record a note in the source" }],
  closureOutcomes: ["No response", "Opted out", "Canceled", "Completed"],
  unresolved: ["The sample cost is retained", "No posting is owed under the accepted terms"],
  content: null,
  requests: [],
};

export const collaborationFixtures: Record<string, CollaborationData> = {
  [COLLABORATION_ID]: collaborationDemo,
  [VOLUNTARY_COLLABORATION_ID]: voluntaryCollaborationDemo,
};

const MS_PER_DAY = 86_400_000;
const utcDay = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const addDays = (iso: string, days: number) => new Date(utcDay(iso) + days * MS_PER_DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((utcDay(to) - utcDay(from)) / MS_PER_DAY);

export type PostingTiming =
  | { obligation: "committed"; due: string; reviewAfter: string; phase: "before-due" | "due-today" | "in-grace" | "past-grace"; daysRemaining: number; label: string; /** A few words for a table row. */ short: string }
  | { obligation: "voluntary"; observeUntil: string; phase: "observing" | "window-ended"; daysRemaining: number; label: string; sampleCost: Money };

/**
 * Posting timing applies only when the accepted terms create the obligation. A committed post has a due date, a grace
 * period and a review date. A voluntary post never becomes late: it has an observation window that ends in a close.
 */
export function postingTiming(terms: CollaborationData["terms"], asOf: string): PostingTiming {
  const p = terms.posting;
  if (p.kind === "voluntary") {
    const observeUntil = addDays(p.sampleDelivered, p.observeDays);
    const left = daysBetween(asOf, observeUntil);
    return left >= 0
      ? { obligation: "voluntary", observeUntil, phase: "observing", daysRemaining: left, sampleCost: p.sampleCost, label: `Observing until ${observeUntil} · ${left} ${left === 1 ? "day" : "days"} left` }
      : { obligation: "voluntary", observeUntil, phase: "window-ended", daysRemaining: 0, sampleCost: p.sampleCost, label: `Observation ended ${observeUntil} · ready to close` };
  }
  const review = reviewAfter(p.due, p.graceDays);
  const toDue = daysBetween(asOf, p.due);
  if (toDue > 0) return { obligation: "committed", due: p.due, reviewAfter: review, phase: "before-due", daysRemaining: toDue, label: `Due in ${toDue} ${toDue === 1 ? "day" : "days"}`, short: `Due in ${toDue} ${toDue === 1 ? "day" : "days"}` };
  if (toDue === 0) return { obligation: "committed", due: p.due, reviewAfter: review, phase: "due-today", daysRemaining: p.graceDays, label: `Due today · ${p.graceDays} grace days follow`, short: "Due today" };
  const toReview = daysBetween(asOf, review);
  if (toReview >= 0) return { obligation: "committed", due: p.due, reviewAfter: review, phase: "in-grace", daysRemaining: toReview, label: `Past due · in the grace period until ${review}`, short: "In grace period" };
  return { obligation: "committed", due: p.due, reviewAfter: review, phase: "past-grace", daysRemaining: 0, label: `Past the grace period · review since ${review}`, short: "Past grace period" };
}

/** Review is due after the posting due date plus the grace period. Derived, so it can't disagree with its inputs. */
export function reviewAfter(postingDue: string, graceDays: number): string {
  const d = new Date(`${postingDue}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + graceDays);
  return d.toISOString().slice(0, 10);
}

export const revisionsRemaining = (r: CollaborationData["terms"]["revisionRounds"]) => Math.max(0, r.allowed - r.used);
export const approvalBlocker = (c: CollaborationData): string | null => (c.content === null ? "There is no submission to approve." : c.content.licenseSigned ? null : "Acceptance remains blocked while the required license is missing.");
