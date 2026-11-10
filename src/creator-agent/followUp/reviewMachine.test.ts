// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyReviewEvent, initialReviewState, isApprovedVersion, type ReviewEvent, type ReviewState } from "./reviewMachine.ts";

const at = "2026-11-10T00:00:00.000Z";
function run(events: ReviewEvent[], state: ReviewState = initialReviewState("synthetic-deliverable")) {
  for (const event of events) { const next = applyReviewEvent(state, event, at); if (!next.ok) throw new Error(next.code); state = next.state; }
  return state;
}
const submit = (contentVersion: string): ReviewEvent => ({ type: "submitted", contentVersion, sourceRef: "synthetic-submission-" + contentVersion });
const decide = (contentVersion: string, outcome: "approved" | "revisionRequested" | "rejected" = "approved"): ReviewEvent =>
  ({ type: "decided", contentVersion, outcome, reviewerRef: "synthetic-reviewer" });

describe("version-bound content review", () => {
  it("binds an approval to the exact content version", () => {
    const state = run([submit("v1"), decide("v1")]);
    expect(state).toMatchObject({ status: "approved", currentVersion: "v1", decision: { contentVersion: "v1", outcome: "approved" } });
    expect(isApprovedVersion(state, "v1")).toBe(true);
    expect(isApprovedVersion(state, "v2")).toBe(false);
  });
  it("needs a new review for a new version, and an approval does not carry over", () => {
    const state = run([submit("v1"), decide("v1"), submit("v2")]);
    expect(state).toMatchObject({ status: "pendingReview", currentVersion: "v2", decision: null });
    expect(isApprovedVersion(state, "v1")).toBe(false);
    expect(isApprovedVersion(state, "v2")).toBe(false);
    expect(isApprovedVersion(run([decide("v2")], state), "v2")).toBe(true);
  });
  it("refuses a decision on a version other than the current one", () => {
    const state = run([submit("v1"), submit("v2")]);
    expect(applyReviewEvent(state, decide("v1"), at)).toEqual({ ok: false, code: "REVIEW_VERSION_MISMATCH" });
  });
  it("refuses a decision before any submission, a second decision and a reused version", () => {
    expect(applyReviewEvent(initialReviewState("synthetic-deliverable"), decide("v1"), at)).toEqual({ ok: false, code: "NO_SUBMISSION" });
    expect(applyReviewEvent(run([submit("v1"), decide("v1", "revisionRequested")]), decide("v1"), at)).toEqual({ ok: false, code: "REVIEW_ALREADY_DECIDED" });
    expect(applyReviewEvent(run([submit("v1"), submit("v2")]), submit("v1"), at)).toEqual({ ok: false, code: "CONTENT_VERSION_REUSED" });
  });
  it("treats a repeated submission of the current version as no change", () => {
    const state = run([submit("v1"), decide("v1")]);
    expect(applyReviewEvent(state, submit("v1"), at)).toEqual({ ok: true, state, changed: false });
  });
});
