/**
 * Version-bound content review. A decision applies only to the exact content version it names.
 * A new submission resets the state to pending review; no earlier decision carries over.
 */
export type ReviewOutcome = "approved" | "revisionRequested" | "rejected";
export type ReviewState = {
  deliverableRef: string;
  currentVersion: string | null;
  status: "awaitingSubmission" | "pendingReview" | ReviewOutcome;
  decision: { contentVersion: string; outcome: ReviewOutcome; reviewerRef: string; decidedAt: string } | null;
  /** Every version ever submitted, oldest first. A version is never resubmitted. */
  submittedVersions: string[];
};
export type ReviewEvent =
  | { type: "submitted"; contentVersion: string; sourceRef: string }
  | { type: "decided"; contentVersion: string; outcome: ReviewOutcome; reviewerRef: string };
export type ReviewTransition = { ok: true; state: ReviewState; changed: boolean } | { ok: false; code: string };

const MAX_VERSIONS = 200;
export const initialReviewState = (deliverableRef: string): ReviewState =>
  ({ deliverableRef, currentVersion: null, status: "awaitingSubmission", decision: null, submittedVersions: [] });

export function applyReviewEvent(state: ReviewState, event: ReviewEvent, at: string): ReviewTransition {
  if (event.type === "submitted") {
    if (event.contentVersion === state.currentVersion) return { ok: true, state, changed: false };
    if (state.submittedVersions.includes(event.contentVersion)) return { ok: false, code: "CONTENT_VERSION_REUSED" };
    if (state.submittedVersions.length >= MAX_VERSIONS) return { ok: false, code: "CONTENT_VERSION_LIMIT" };
    return { ok: true, changed: true, state: { ...state, currentVersion: event.contentVersion, status: "pendingReview", decision: null,
      submittedVersions: [...state.submittedVersions, event.contentVersion] } };
  }
  if (state.currentVersion === null) return { ok: false, code: "NO_SUBMISSION" };
  if (event.contentVersion !== state.currentVersion) return { ok: false, code: "REVIEW_VERSION_MISMATCH" };
  if (state.status !== "pendingReview") return { ok: false, code: "REVIEW_ALREADY_DECIDED" };
  return { ok: true, changed: true, state: { ...state, status: event.outcome,
    decision: { contentVersion: event.contentVersion, outcome: event.outcome, reviewerRef: event.reviewerRef, decidedAt: at } } };
}

/** True only when this exact version is the current one and was approved. */
export function isApprovedVersion(state: ReviewState | null, contentVersion: string): boolean {
  return !!state && state.status === "approved" && state.currentVersion === contentVersion && state.decision?.contentVersion === contentVersion;
}
