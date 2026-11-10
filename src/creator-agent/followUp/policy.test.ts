// @vitest-environment node
import { describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import type { AssetRights, StoredAsset } from "../assets.ts";
import { assetTestNow, assetTestScope, syntheticAsset, syntheticChecksum, syntheticRights, syntheticUse } from "../assetTestFixtures.ts";
import { postingClockEventSchema, type ClosureEvidence } from "./contract.ts";
import { decideClosure, decideReminder, dueVersionOf, reviewCreatorTerms, type ReminderInput } from "./policy.ts";
import { applyReviewEvent, initialReviewState } from "./reviewMachine.ts";
import { clockEvent, collaborationId, deliveryEvidence, followUpConfig, laNoon, postGraceConfig, unsetConfig } from "./fixtures.testkit.ts";

const input = (overrides: Partial<ReminderInput> = {}): ReminderInput =>
  ({ event: clockEvent(), outreach: "clear", postedVerified: false, closure: null, priorSend: "none", ...overrides });
const commissionTerms = { relationship: "commissionOnly", upfrontFeeMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0, commissionPct: 10, perSaleFixedMinor: 0, sampleCostMinor: 0 };

describe("reminder policy switch", () => {
  it("refuses to plan creator reminders until the owner sets a reminder policy", () => {
    expect(decideReminder(input(), unsetConfig, laNoon("2026-11-10"))).toEqual({ kind: "refused", reasonCodes: ["REMINDER_POLICY_UNSET"] });
  });
  it.each([
    ["2026-11-10", "wait", null],
    ["2026-11-14", "wait", null],
    ["2026-11-15", "escalate", "post-grace"],
  ])("postGraceOnly on local day %s decides %s with reminder %s", (day, kind, reminder) => {
    const decision = decideReminder(input(), postGraceConfig, laNoon(day));
    expect(decision.kind).toBe(kind);
    if (decision.kind === "wait") expect(decision).toMatchObject({ reasonCodes: ["REMINDER_POLICY_POST_GRACE_ONLY"], opensOn: "2026-11-15" });
    if (decision.kind === "escalate") expect(decision).toMatchObject({ step: "past-grace", reminder, suggestedClosure: "expired" });
  });
  it("postGraceOnly still escalates past grace but holds the reminder on suppression or an earlier send", () => {
    expect(decideReminder(input({ outreach: "suppressed" }), postGraceConfig, laNoon("2026-11-15")))
      .toMatchObject({ kind: "escalate", reminder: null, reasonCodes: ["POSTING_GRACE_ELAPSED", "OUTREACH_SUPPRESSED"] });
    expect(decideReminder(input({ priorSend: "inFlight" }), postGraceConfig, laNoon("2026-11-15")))
      .toMatchObject({ kind: "escalate", reminder: null, reasonCodes: ["POSTING_GRACE_ELAPSED", "PRIOR_SEND_IN_FLIGHT"] });
  });
  it("preDue escalates past grace without a creator reminder", () => {
    expect(decideReminder(input(), followUpConfig, laNoon("2026-11-15"))).toMatchObject({ kind: "escalate", reminder: null, reasonCodes: ["POSTING_GRACE_ELAPSED"] });
  });
});

describe("reminder branches on the posting deadline (preDue)", () => {
  it.each([
    ["2026-11-09", "wait", undefined],
    ["2026-11-10", "remind", "due-minus-2"],
    ["2026-11-12", "remind", "due-minus-2"],
    ["2026-11-13", "remind", "within-grace"],
    ["2026-11-14", "remind", "within-grace"],
    ["2026-11-15", "escalate", "past-grace"],
  ])("on local day %s decides %s %s", (day, kind, step) => {
    const decision = decideReminder(input(), followUpConfig, laNoon(day));
    expect(decision.kind).toBe(kind);
    if (step) expect(decision).toMatchObject({ step, localDay: day, timezone: "America/Los_Angeles" });
  });
  it("counts the day in the configured timezone, not in UTC", () => {
    // 07:30 UTC on 10 November is still 9 November in Los Angeles.
    const decision = decideReminder(input(), followUpConfig, Date.parse("2026-11-10T07:30:00.000Z"));
    expect(decision).toMatchObject({ kind: "wait", localDay: "2026-11-09", opensOn: "2026-11-10" });
  });
  it("proposes closure as expired past grace instead of another creator message", () => {
    expect(decideReminder(input(), followUpConfig, laNoon("2026-11-15"))).toMatchObject({ kind: "escalate", suggestedClosure: "expired", reasonCodes: ["POSTING_GRACE_ELAPSED"] });
  });
  it.each([
    [{ dueDate: null }, "POSTING_DEADLINE_MISSING"],
    [{ graceDays: null }, "POSTING_GRACE_MISSING"],
    [{ posting: "unknown" as const }, "POSTING_OBLIGATION_UNVERIFIED"],
    [{ timezone: null }, "POSTING_TIMEZONE_MISSING"],
    [{ timezone: "Europe/London" }, "POSTING_TIMEZONE_CONFLICT"],
    [{ timezone: "Not/AZone" }, "POSTING_TIMEZONE_CONFLICT"],
  ])("sends %j to human review and never guesses a deadline", (override, code) => {
    for (const config of [followUpConfig, postGraceConfig]) {
      const decision = decideReminder(input({ event: clockEvent(override) }), config, laNoon("2026-11-13"));
      expect(decision).toEqual({ kind: "humanReview", reasonCodes: [code] });
    }
  });
  it("never fills a missing source timezone from the configured one", () => {
    expect(decideReminder(input({ event: clockEvent({ timezone: null }) }), followUpConfig, laNoon("2026-11-15"))).toEqual({ kind: "humanReview", reasonCodes: ["POSTING_TIMEZONE_MISSING"] });
  });
  it("sends a missing posting clock to human review", () => {
    expect(decideReminder(input({ event: null }), followUpConfig, laNoon("2026-11-13"))).toEqual({ kind: "humanReview", reasonCodes: ["POSTING_CLOCK_MISSING"] });
  });
  it("accepts only synthetic posting clock events until the source clock is connected", () => {
    expect(postingClockEventSchema.safeParse({ ...clockEvent(), origin: "notion" }).success).toBe(false);
    expect(postingClockEventSchema.safeParse(clockEvent({ posting: "voluntary" })).success).toBe(false);
  });
  it("treats a changed due date as a new due-date version, but not a new source revision", () => {
    const first = decideReminder(input(), followUpConfig, laNoon("2026-11-10"));
    const revised = decideReminder(input({ event: clockEvent({ sourceRef: "synthetic-posting-clock-v2" }) }), followUpConfig, laNoon("2026-11-10"));
    const moved = decideReminder(input({ event: clockEvent({ dueDate: "2026-11-13" }) }), followUpConfig, laNoon("2026-11-11"));
    expect(first.kind === "remind" && revised.kind === "remind" && first.dueVersion === revised.dueVersion).toBe(true);
    expect(moved).toMatchObject({ kind: "remind", step: "due-minus-2", dueVersion: dueVersionOf("2026-11-13", 2, "America/Los_Angeles") });
    expect(first.kind === "remind" && moved.kind === "remind" && first.dueVersion !== moved.dueVersion).toBe(true);
  });
  it.each([
    [{ outreach: "suppressed" as const }, "OUTREACH_SUPPRESSED"],
    [{ outreach: "unknown" as const }, "SUPPRESSION_UNVERIFIED"],
    [{ priorSend: "uncertain" as const }, "PRIOR_SEND_UNCERTAIN"],
    [{ priorSend: "inFlight" as const }, "PRIOR_SEND_IN_FLIGHT"],
    [{ priorSend: "conflict" as const }, "OUTCOME_CONFLICT_OPEN"],
  ])("holds creator reminders for %j but still escalates past grace", (override, code) => {
    expect(decideReminder(input(override), followUpConfig, laNoon("2026-11-13"))).toEqual({ kind: "humanReview", reasonCodes: [code] });
    expect(decideReminder(input(override), followUpConfig, laNoon("2026-11-15")).kind).toBe("escalate");
  });
  it("stops after closure or verified posting, and never reminds voluntary posting", () => {
    expect(decideReminder(input({ closure: "declined" }), followUpConfig, laNoon("2026-11-13")).kind).toBe("notApplicable");
    expect(decideReminder(input({ postedVerified: true }), followUpConfig, laNoon("2026-11-13"))).toMatchObject({ suggestedClosure: "posted-verified" });
    expect(decideReminder(input({ event: clockEvent({ posting: "voluntary", dueDate: null, graceDays: null }) }), followUpConfig, laNoon("2026-11-13")).kind).toBe("notApplicable");
  });
});

describe("creator fee requests", () => {
  it("routes a fee request in a reply to human review as a terms mismatch", () => {
    const review = reviewCreatorTerms({ kind: "reply", text: "Happy to post, but my rate is a flat fee per video.", sourceRef: "synthetic-reply-1" });
    expect(review).toMatchObject({ state: "termsMismatch", queue: "humanReview", autoAccept: false });
    expect(review.reasonCodes).toEqual(expect.arrayContaining(["TERMS_MISMATCH", "CREATOR_FEE_REQUEST"]));
  });
  it("routes proposed paid terms to human review and never auto-accepts commission-only terms either", () => {
    const paid = reviewCreatorTerms({ kind: "terms", terms: { ...commissionTerms, upfrontFeeMinor: 20_000 }, sourceRef: "synthetic-terms-1" });
    const hybrid = reviewCreatorTerms({ kind: "terms", terms: { ...commissionTerms, relationship: "hybrid" }, sourceRef: "synthetic-terms-2" });
    const commission = reviewCreatorTerms({ kind: "terms", terms: commissionTerms, sourceRef: "synthetic-terms-3" });
    expect(paid).toMatchObject({ state: "termsMismatch", queue: "humanReview", autoAccept: false });
    expect(paid.reasonCodes).toContain("UPFRONT_FEE_PROHIBITED");
    expect(hybrid.state).toBe("termsMismatch");
    expect(commission).toMatchObject({ state: "noMismatchFound", autoAccept: false });
  });
});

const storedAsset = (): StoredAsset => ({ submission: syntheticAsset(), version: 1, recordedAt: assetTestNow, submissionHash: digest(syntheticAsset()), storageIdentity: "synthetic-storage",
  sourceEvidence: { scope: assetTestScope, submissionHash: digest(syntheticAsset()), observedAt: assetTestNow, authorizationRef: "synthetic-source", availability: "available", checksum: syntheticChecksum } });
function rightsEvidence(rights: Partial<AssetRights> | null): Extract<ClosureEvidence, { reason: "rights-unavailable" }> {
  const asset = storedAsset();
  return { reason: "rights-unavailable", sourceRef: "synthetic-rights-check", rights: { scope: assetTestScope, asset, use: syntheticUse(),
    chain: [{ asset, rights: rights === null ? null : syntheticRights(asset, { validUntil: "2026-12-31T00:00:00.000Z", ...rights }) }] } };
}

describe("closure reasons", () => {
  const context = (review = initialReviewState("synthetic-deliverable"), now = laNoon("2026-11-15")) => ({ review, config: followUpConfig, now });
  const approved = () => {
    let state = initialReviewState("synthetic-deliverable");
    for (const event of [{ type: "submitted" as const, contentVersion: "content-v2", sourceRef: "synthetic-submission" },
      { type: "decided" as const, contentVersion: "content-v2", outcome: "approved" as const, reviewerRef: "synthetic-reviewer" }]) {
      const next = applyReviewEvent(state, event, "2026-11-10T00:00:00.000Z"); if (!next.ok) throw new Error(next.code); state = next.state;
    }
    return state;
  };
  it("keeps six distinct reasons, each with its own evidence", () => {
    const reasons = [
      decideClosure(collaborationId, { reason: "posted-verified", delivery: deliveryEvidence() }, context(approved())),
      decideClosure(collaborationId, { reason: "declined", sourceRef: "synthetic-decline" }, context()),
      decideClosure(collaborationId, { reason: "expired", event: clockEvent() }, context()),
      decideClosure(collaborationId, { reason: "terms-mismatch", terms: { kind: "reply", text: "I need an upfront payment first", sourceRef: "synthetic-reply-2" } }, context()),
      decideClosure(collaborationId, rightsEvidence(null), context()),
      decideClosure(collaborationId, { reason: "cancelled", sourceRef: "synthetic-cancel" }, context()),
    ].map(d => d.state === "closable" ? d.reason : d.reasonCodes[0]);
    expect(reasons).toEqual(["posted-verified", "declined", "expired", "terms-mismatch", "rights-unavailable", "cancelled"]);
  });
  it("refuses posted-and-verified unless the posted version is the approved one", () => {
    expect(decideClosure(collaborationId, { reason: "posted-verified", delivery: deliveryEvidence({ contentVersion: "content-v3" }) }, context(approved())))
      .toEqual({ state: "refused", reasonCodes: ["POSTED_VERSION_NOT_APPROVED"] });
    const scheduled = deliveryEvidence({ publication: { ...deliveryEvidence().publication, state: "scheduled", confirmedSlot: "2026-11-12T20:00:00.000Z", nativePostRef: null, publishedAt: null } });
    expect(decideClosure(collaborationId, { reason: "posted-verified", delivery: scheduled }, context(approved()))).toEqual({ state: "refused", reasonCodes: ["PUBLICATION_UNVERIFIED"] });
  });
  it("refuses expiry within grace and recomputes terms rather than trusting a verdict", () => {
    expect(decideClosure(collaborationId, { reason: "expired", event: clockEvent() }, context(undefined, laNoon("2026-11-14"))).state).toBe("refused");
    expect(decideClosure(collaborationId, { reason: "terms-mismatch", terms: { kind: "terms", terms: commissionTerms, sourceRef: "synthetic-terms-4" } }, context()))
      .toEqual({ state: "refused", reasonCodes: ["TERMS_MISMATCH_UNVERIFIED"] });
    expect(decideClosure(collaborationId, { reason: "terms-mismatch", terms: { kind: "terms", terms: { ...commissionTerms, guaranteedFeeMinor: 5_000 }, sourceRef: "synthetic-terms-5" } }, context()))
      .toMatchObject({ state: "closable", reasonCodes: expect.arrayContaining(["GUARANTEED_FEE_PROHIBITED"]) });
  });
  it.each([
    [null, "closable"], [{ status: "revoked" as const }, "closable"], [{ status: "expired" as const }, "closable"],
    [{ status: "unknown" as const }, "refused"], [{ validUntil: assetTestNow }, "refused"], [{}, "refused"],
  ])("closes as rights unavailable only on definite unavailability: %j is %s", (rights, state) => {
    expect(decideClosure(collaborationId, rightsEvidence(rights), context(undefined, Date.parse(assetTestNow))).state).toBe(state);
  });
});
