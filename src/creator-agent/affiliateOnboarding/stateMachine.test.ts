import { describe, expect, it } from "vitest";
import type { ActionResponse } from "../../adapter/contract.ts";
import { outcomeFromActionResponse } from "./actionAdapter.ts";
import { onboardingFixture, providerRef } from "./fixtures.testkit.ts";
import { activationBlockers, applySourceEvent, phaseReadiness } from "./stateMachine.ts";

describe("onboarding state machine", () => {
  it("keeps every phase separate: acceptance sets no link, payout setup or activation", () => {
    const f = onboardingFixture();
    const invited = f.invited();
    const at = new Date(f.now()).toISOString();
    const result = applySourceEvent(invited, { type: "acceptance", evidence: f.evidence("accept", { offerId: invited.offerId, offerVersion: invited.offerVersion }) }, invited.offerVersion, at);
    expect(result.ok).toBe(true);
    const accepted = result.ok ? result.record : invited;
    expect(phaseReadiness(accepted, accepted.offerVersion)).toEqual({ invitation: "sent", acceptance: "accepted", linkCode: "pending",
      checkoutTest: "notRun", payoutSetup: "notStarted", activation: "notReady" });
    expect(activationBlockers(accepted, accepted.offerVersion)).toEqual(["LINK_OR_CODE_NOT_MAPPED", "ATTRIBUTION_MATRIX_NOT_PASSED"]);
  });

  it("preserves unknown source evidence without advancing a phase", () => {
    const f = onboardingFixture();
    const invited = f.invited();
    const result = applySourceEvent(invited, { type: "acceptance", evidence: f.evidence("accept", null, "Acceptance page not readable") }, invited.offerVersion, invited.updatedAt);
    expect(result).toMatchObject({ ok: true, changed: false, reasonCodes: ["ACCEPTANCE_UNKNOWN"], record: { state: "invited", acceptance: { state: "unknown" } } });
  });

  it("an explicit acceptance of the current version resolves a fee request; a decline after it is a separate state", () => {
    const f = onboardingFixture();
    const invited = f.invited();
    const fee = applySourceEvent(invited, { type: "creatorReply", evidence: f.evidence("reply", { text: "What is your minimum fee per post?" }) }, invited.offerVersion, invited.updatedAt);
    expect(fee.ok && fee.record.state).toBe("feeRequested");
    const record = fee.ok ? fee.record : invited;
    expect(activationBlockers(record, record.offerVersion)).toContain("CREATOR_FEE_REQUEST_OPEN");
    const accepted = applySourceEvent(record, { type: "acceptance", evidence: f.evidence("accept", { offerId: record.offerId, offerVersion: record.offerVersion }) }, record.offerVersion, record.updatedAt);
    expect(accepted.ok && accepted.record.state).toBe("accepted");
  });
});

describe("action answers", () => {
  const response = (over: Partial<ActionResponse>): ActionResponse => ({ schemaVersion: "v", requestId: "r", scope: {} as ActionResponse["scope"], actionRef: "a",
    state: "succeeded", runRef: "run-1", approvalRef: "approval-1", manifestRef: "manifest-1", payloadVersion: "v1", policyVersion: "p", modelVersion: null,
    offerVersion: null, reasonCodes: [], receiptRefs: ["receipt-1"], nextAction: null, nextPollAfterMs: null, executionCertainty: "applied", ...over });

  it("a succeeded run is sent only with the provider's native receipt; approved is never sent", () => {
    const f = onboardingFixture();
    const record = f.opened();
    const intent = f.repo.proposeInvitation(record.onboardingId, "invite");
    expect(outcomeFromActionResponse(f.repo, intent.intentRef, response({}), null).kind).toBe("uncertain");
    expect(outcomeFromActionResponse(f.repo, intent.intentRef, response({}), providerRef("native")).kind).toBe("sent");
    expect(outcomeFromActionResponse(f.repo, intent.intentRef, response({ state: "approved", runRef: null }), null).kind).toBe("approvalRecorded");
    expect(outcomeFromActionResponse(f.repo, intent.intentRef, response({ state: "queued" }), null).kind).toBe("dispatchPending");
    expect(outcomeFromActionResponse(f.repo, intent.intentRef, response({ executionCertainty: "uncertain" }), providerRef("native")).kind).toBe("uncertain");
  });
});
