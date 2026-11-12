import { describe, expect, it } from "vitest";
import { AgentStore } from "../store.ts";
import { previewActionFor, reconciliationFor } from "./actionAdapter.ts";
import { INVITATION_ACTION_KIND } from "./contract.ts";
import { accountFixture, onboardingFixture, onboardingScope, providerRef } from "./fixtures.testkit.ts";
import { AffiliateOnboardingRepository, DEFAULT_SETTLE_MARGIN_MS } from "./repository.ts";

const code = (code: string) => expect.objectContaining({ code });

describe("J10-02 invitation before acceptance", () => {
  it("an approved invitation discloses commission-only terms before acceptance, and sending never sets accepted or active", () => {
    const f = onboardingFixture();
    const record = f.opened();
    expect(record.acceptance.state).toBe("unknown");
    const intent = f.repo.proposeInvitation(record.onboardingId, "invite-1");
    expect(intent).toMatchObject({ kind: "invitation", actionKind: INVITATION_ACTION_KIND, state: "proposed", sends: false, offerVersion: record.offerVersion });
    const { action } = f.repo.reserve(intent.intentRef, "reserve-1", { requestId: "request-1" });
    expect(action).toMatchObject({ operation: "previewAction", actionKind: INVITATION_ACTION_KIND, expectedVersion: intent.intentVersion,
      payload: { entityRef: record.onboardingId, entityVersion: intent.intentVersion, selectionRefs: [intent.intentRef] } });
    // Approved is not sent: an approval and a queued run leave the invitation pending.
    f.repo.recordOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1" }, "approved-1");
    expect(f.repo.read(record.onboardingId)!.state).toBe("invitationPending");
    f.repo.recordOutcome({ kind: "dispatchPending", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1" }, "dispatched-1");
    const sent = f.repo.recordOutcome({ kind: "sent", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1",
      receiptRefs: ["receipt-1"], providerReceipt: providerRef("native-invite-receipt"), expiresAt: null }, "sent-1");
    expect(sent.state).toBe("recorded");
    const out = f.repo.output(record.onboardingId);
    expect(out.origin).toBe("synthetic");
    expect(out.phaseReadiness).toEqual({ origin: "synthetic", invitation: "sent", acceptance: "awaitingCreator", linkCode: "notStarted", checkoutTest: "notRun", payoutSetup: "notStarted", activation: "notReady" });
    expect(out.providerReceipt).toEqual(providerRef("native-invite-receipt"));
    expect(f.repo.read(record.onboardingId)!.acceptance.state).toBe("unknown");
  });
});

describe("J10-05 separate invitation states and version-bound acceptance", () => {
  it("expiration, rejection, fee request and changed terms produce separate states", () => {
    const expired = onboardingFixture(), e = expired.invited();
    expired.repo.observe(e.onboardingId, { type: "invitationExpired", evidence: expired.evidence("synthetic-expiry", { expiredAt: new Date(expired.now()).toISOString() }) }, "expire");
    expect(expired.repo.read(e.onboardingId)!.state).toBe("invitationExpired");
    expect(() => expired.repo.observe(e.onboardingId, { type: "acceptance", evidence: expired.evidence("late-accept", { offerId: e.offerId, offerVersion: e.offerVersion }) }, "late"))
      .toThrow(code("INVITATION_EXPIRED"));

    const declined = onboardingFixture(), d = declined.invited();
    declined.repo.observe(d.onboardingId, { type: "creatorDeclined", evidence: declined.evidence("synthetic-decline", { offerVersion: d.offerVersion }) }, "decline");
    expect(declined.repo.read(d.onboardingId)!).toMatchObject({ state: "declined", acceptance: { state: "declined" } });

    const fee = onboardingFixture(), r = fee.invited();
    const reply = fee.repo.observe(r.onboardingId, { type: "creatorReply", evidence: fee.evidence("synthetic-reply", { text: "Happy to join if you pay a flat fee upfront" }) }, "reply");
    expect(reply.reasonCodes).toEqual(["TERMS_MISMATCH", "CREATOR_FEE_REQUEST"]);
    expect(fee.repo.read(r.onboardingId)!.state).toBe("feeRequested");
    const neutral = onboardingFixture(), n = neutral.invited();
    neutral.repo.observe(n.onboardingId, { type: "creatorReply", evidence: neutral.evidence("synthetic-reply", { text: "Thanks, looking at it" }) }, "reply");
    expect(neutral.repo.read(n.onboardingId)!.state).toBe("invited");

    const changed = onboardingFixture(), c = changed.invited();
    changed.setOffer(changed.offer.current!.terms, "synthetic-offer-v2");
    expect(changed.repo.syncTerms(c.onboardingId, "sync").state).toBe("termsChanged");
    expect(new Set(["invitationExpired", "declined", "feeRequested", "termsChanged"]).size).toBe(4);
  });

  it("acceptance of an older version cannot activate a changed current offer", () => {
    const f = onboardingFixture();
    const record = f.invited();
    f.setOffer(f.offer.current!.terms, "synthetic-offer-v2");
    expect(() => f.repo.observe(record.onboardingId, { type: "acceptance", evidence: f.evidence("old-accept", { offerId: record.offerId, offerVersion: "synthetic-offer-v1" }) }, "accept-old"))
      .toThrow(code("ACCEPTED_VERSION_NOT_CURRENT"));

    // Accepted first, then the offer changes: the old acceptance stays in history and cannot activate.
    const g = onboardingFixture();
    const linked = g.linked();
    g.repo.recordAttributionMatrix(linked.onboardingId, g.passingOrders(), "matrix");
    g.setOffer(g.offer.current!.terms, "synthetic-offer-v2");
    expect(g.repo.output(linked.onboardingId).phaseReadiness).toMatchObject({ acceptance: "staleVersion", activation: "notReady" });
    expect(() => g.repo.proposeActivation(linked.onboardingId, "activate")).toThrow(code("ACTIVATION_NOT_READY"));
    g.repo.syncTerms(linked.onboardingId, "sync");
    const input = g.input();
    const revised = g.repo.reviseTerms(linked.onboardingId, { ...input.approvedTerms, offerVersion: "synthetic-offer-v2" }, "revise");
    expect(revised).toMatchObject({ state: "readyToInvite", offerVersion: "synthetic-offer-v2", acceptance: { state: "unknown" }, activation: { state: "notReady" } });
    expect(g.repo.history(linked.onboardingId).some(r => r.acceptance.state === "accepted" && r.acceptance.offerVersion === "synthetic-offer-v1")).toBe(true);
  });
});

describe("J10-06 relationship and link or code crosswalk", () => {
  it("maps the provider relationship and unique link or code to the canonical creator once", () => {
    const f = onboardingFixture();
    const record = f.accepted();
    const first = f.repo.mapRelationship(record.onboardingId, f.relationship(record.offerVersion), "map-1");
    expect(first.created).toBe(true);
    expect(first.record.linkCode).toMatchObject({ state: "mapped", relationshipRef: { sourceId: "synthetic-relationship" } });
    // A recheck under a new key and a duplicate import of the onboarding do not issue anything new.
    expect(f.repo.mapRelationship(record.onboardingId, f.relationship(record.offerVersion), "map-2").created).toBe(false);
    expect(f.repo.open(f.input(), "open-again")).toMatchObject({ created: false, record: { onboardingId: record.onboardingId } });
    const rows = f.store.database.prepare("SELECT creator_id FROM affiliate_onboarding_link_codes").all();
    expect(rows.map(r => r.creator_id)).toEqual(["synthetic-creator", "synthetic-creator"]);
    expect(f.store.database.prepare("SELECT COUNT(*) AS n FROM affiliate_onboarding_relationships").get()!.n).toBe(1);
    expect(() => f.repo.mapRelationship(record.onboardingId, f.relationship(record.offerVersion, "second-relationship"), "map-3")).toThrow(code("RELATIONSHIP_ALREADY_MAPPED"));
    expect(() => f.repo.mapRelationship(record.onboardingId, f.relationship(record.offerVersion, "synthetic-relationship", "synthetic-link", "NEWCODE"), "map-4"))
      .toThrow(code("LINK_CODE_CHANGED_REQUIRES_REVIEW"));
  });

  it("refuses mapping before current acceptance, from another account or for a suppressed or unknown creator", () => {
    const f = onboardingFixture();
    const invited = f.invited();
    expect(() => f.repo.mapRelationship(invited.onboardingId, f.relationship(invited.offerVersion), "early")).toThrow(code("CURRENT_ACCEPTANCE_REQUIRED"));
    f.repo.observe(invited.onboardingId, { type: "acceptance", evidence: f.evidence("accept", { offerId: invited.offerId, offerVersion: invited.offerVersion }) }, "accept");
    const crossAccount = f.relationship(invited.offerVersion);
    crossAccount.evidence.ref = { ...crossAccount.evidence.ref, accountId: "another-provider-account" };
    expect(() => f.repo.mapRelationship(invited.onboardingId, crossAccount, "cross")).toThrow(code("EVIDENCE_ACCOUNT_MISMATCH"));
    f.state.identity = { creatorId: "synthetic-creator", revision: 2, suppressions: ["opt-out"] };
    expect(() => f.repo.mapRelationship(invited.onboardingId, f.relationship(invited.offerVersion), "suppressed")).toThrow(code("CREATOR_SUPPRESSED"));
    f.state.identity = null;
    expect(() => f.repo.mapRelationship(invited.onboardingId, f.relationship(invited.offerVersion), "unknown")).toThrow(code("CANONICAL_IDENTITY_UNRESOLVED"));
  });
});

describe("J10-07 matrix gates activation", () => {
  it("activation needs a passing matrix on the actual storefront route; an exception blocks it", () => {
    const f = onboardingFixture();
    const record = f.linked();
    const failing = f.repo.recordAttributionMatrix(record.onboardingId, f.passingOrders().map(o => o.case === "conflicting"
      ? { ...o, providerCredit: { state: "unknown" as const, relationshipSourceId: null, via: null } } : o), "matrix-1");
    expect(failing.record.checkoutTest.state).toBe("exception");
    expect(() => f.repo.proposeActivation(record.onboardingId, "activate-1")).toThrow(code("ACTIVATION_NOT_READY"));
    const passing = f.repo.recordAttributionMatrix(record.onboardingId, f.passingOrders(), "matrix-2");
    expect(passing.record.checkoutTest).toMatchObject({ state: "passed", offerVersion: record.offerVersion });
    expect(f.repo.proposeActivation(record.onboardingId, "activate-2")).toMatchObject({ kind: "activation", state: "proposed" });
    expect(f.repo.output(record.onboardingId).attributionTestEvidence).toHaveLength(6);
  });
});

describe("J10-09 payout setup and activation are distinct later states", () => {
  it("never infers payout setup from link issuance, acceptance, activation or merchant billing", () => {
    const f = onboardingFixture();
    const record = f.linked();
    f.repo.recordAttributionMatrix(record.onboardingId, f.passingOrders(), "matrix");
    expect(f.repo.output(record.onboardingId).phaseReadiness).toMatchObject({ acceptance: "accepted", linkCode: "mapped", checkoutTest: "passed",
      payoutSetup: "notStarted", activation: "ready" });
    f.sendIntent(f.repo.proposeActivation(record.onboardingId, "activate"));
    const out = f.repo.output(record.onboardingId);
    expect(out.phaseReadiness).toMatchObject({ activation: "active", payoutSetup: "notStarted" });
    expect(out.payoutSetupState).toBe("notStarted");
  });

  it("waiting for creator setup has a creator owner and a source link; unknown setup stays unknown", () => {
    const f = onboardingFixture();
    const record = f.accepted();
    expect(() => f.repo.observePayoutSetup(record.onboardingId, { evidence: f.evidence("setup", { state: "waitingForCreator", owner: "creator" }) }, "no-link")).toThrow();
    const waiting = f.repo.observePayoutSetup(record.onboardingId,
      { evidence: f.evidence("setup", { state: "waitingForCreator", owner: "creator" }, null, "https://synthetic-collabs.example/payout-setup") }, "waiting");
    expect(waiting.payoutSetup).toMatchObject({ state: "waitingForCreator", owner: "creator", sourceRef: { url: "https://synthetic-collabs.example/payout-setup" } });
    expect(f.repo.output(record.onboardingId).blockers).toContainEqual({ code: "PAYOUT_SETUP_WAITING_FOR_CREATOR", owner: "creator", sourceRef: waiting.payoutSetup.sourceRef });
    const unknown = f.repo.observePayoutSetup(record.onboardingId, { evidence: f.evidence("setup-2", null, "Setup page not readable") }, "unknown");
    expect(unknown.payoutSetup).toMatchObject({ state: "unknown", unknownReason: "Setup page not readable" });
    expect(unknown.state).toBe("accepted");
    expect(unknown.activation.state).toBe("notReady");
  });
});

describe("J10-10 unknown results are reconciled, never replayed", () => {
  for (const kind of ["uncertain", "permissionDenied", "loginRequired", "uiDrift"] as const) {
    it(`${kind} preserves the approved action and blocks replay until source reconciliation`, () => {
      const f = onboardingFixture();
      const record = f.opened();
      const intent = f.repo.proposeInvitation(record.onboardingId, "invite");
      f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
      f.repo.recordOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1" }, "approved");
      f.repo.recordOutcome({ kind: "dispatchPending", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1",
        runDeadline: new Date(f.now() + 60_000).toISOString() }, "dispatched");
      f.repo.recordOutcome({ kind, intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1" }, "unknown");
      const held = f.repo.intent(intent.intentRef)!;
      expect(held).toMatchObject({ state: "reconciliationRequired", approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1" });
      expect(f.repo.read(record.onboardingId)!.state).toBe("invitationUnknown");
      expect(f.repo.output(record.onboardingId).phaseReadiness.invitation).toBe("reconciliationRequired");
      // No replay: no new intent, no second reservation, no direct outcome.
      expect(() => f.repo.proposeInvitation(record.onboardingId, "invite-again")).toThrow(code("NOT_READY_TO_INVITE"));
      expect(() => f.repo.reserve(intent.intentRef, "reserve-again", { requestId: "request-2" })).toThrow(code("INTENT_NOT_PROPOSED"));
      expect(() => f.repo.recordOutcome({ kind: "sent", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1",
        receiptRefs: ["r"], providerReceipt: providerRef("x"), expiresAt: null }, "sent-direct")).toThrow(code("RECONCILIATION_REQUIRED"));
      expect(f.repo.pendingReconciliation().map(i => i.intentRef)).toEqual([intent.intentRef]);
      expect(reconciliationFor(f.repo, intent.intentRef, { requestId: "lookup", idempotencyKey: "lookup-1" })).toMatchObject({ kind: "action",
        action: { operation: "reconcileRun", actionKind: "lookup", runRef: "run-1" } });
      // The first run could still land until its deadline plus the settle margin, so an earlier absence is held.
      const absentInput = { result: "absent", intentRef: intent.intentRef, sourceRef: providerRef("synthetic-no-invite"), terminal: true };
      const early = f.repo.reconcile(absentInput, "absent-early");
      expect(early).toMatchObject({ state: "held", reasonCode: "RUN_DEADLINE_NOT_PASSED", retryAfter: new Date(f.now() + 60_000 + DEFAULT_SETTLE_MARGIN_MS).toISOString() });
      expect(f.repo.intent(intent.intentRef)!.state).toBe("reconciliationRequired");
      f.advance(60_000 + DEFAULT_SETTLE_MARGIN_MS - 1);
      expect(f.repo.reconcile(absentInput, "absent-margin").state).toBe("held");
      f.advance(1);
      const absent = f.repo.reconcile(absentInput, "absent");
      if (kind === "uncertain") {
        // Only an unknown send resumes under its approval, through a J04 fresh attempt; no new invitation is created.
        expect(absent.state === "recorded" && absent.intent).toMatchObject({ state: "awaitingApproval", approvalRef: "approval-1" });
        expect(f.repo.read(record.onboardingId)!.state).toBe("invitationPending");
        expect(f.repo.intents(record.onboardingId)).toHaveLength(1);
        return;
      }
      // A denial, login/MFA or UI drift never resumes under the same approval: it needs a new intent and a new J04 approval.
      expect(absent.state === "recorded" && absent.intent).toMatchObject({ state: "notSent", approvalRef: "approval-1" });
      expect(() => f.repo.assertJ04Current(intent.intentRef, intent.intentVersion)).toThrow(code("INTENT_NOT_IN_J04"));
      expect(() => f.repo.recordOutcome({ kind: "dispatchPending", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1",
        runRef: "run-1", runVersion: "v1" }, "dispatch-again")).toThrow(code("OUTCOME_OUT_OF_ORDER"));
      expect(f.repo.read(record.onboardingId)!.state).toBe("readyToInvite");
      const fresh = f.repo.proposeInvitation(record.onboardingId, "invite-new");
      expect(fresh.intentRef).not.toBe(intent.intentRef);
      expect(fresh).toMatchObject({ state: "proposed", approvalRef: null });
    });
  }

  it("refuses a reconciliation or native receipt from another provider account", () => {
    const f = onboardingFixture();
    const record = f.opened();
    const intent = f.repo.proposeInvitation(record.onboardingId, "invite");
    f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
    f.repo.recordOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1" }, "approved");
    f.repo.recordOutcome({ kind: "dispatchPending", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1" }, "dispatched");
    const foreign = { ...providerRef("foreign-receipt"), accountId: "another-provider-account" };
    expect(() => f.repo.recordOutcome({ kind: "sent", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1",
      receiptRefs: ["r"], providerReceipt: foreign, expiresAt: null }, "sent-foreign")).toThrow(code("EVIDENCE_ACCOUNT_MISMATCH"));
    expect(f.repo.intent(intent.intentRef)!.state).toBe("dispatched");
    f.repo.recordOutcome({ kind: "uncertain", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1" }, "unknown");
    expect(() => f.repo.reconcile({ result: "found", intentRef: intent.intentRef, providerReceipt: foreign, receiptRefs: ["r"], expiresAt: null }, "found-foreign"))
      .toThrow(code("EVIDENCE_ACCOUNT_MISMATCH"));
    expect(() => f.repo.reconcile({ result: "absent", intentRef: intent.intentRef, sourceRef: { ...foreign, provider: "external-affiliate" }, terminal: true }, "absent-foreign"))
      .toThrow(code("EVIDENCE_ACCOUNT_MISMATCH"));
    expect(f.repo.intent(intent.intentRef)!.state).toBe("reconciliationRequired");
  });

  it("a found invitation is recorded from the source receipt", () => {
    const f = onboardingFixture();
    const record = f.opened();
    const intent = f.repo.proposeInvitation(record.onboardingId, "invite");
    f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
    f.repo.recordOutcome({ kind: "uncertain", intentRef: intent.intentRef, approvalRef: null, manifestRef: null, runRef: null, runVersion: null }, "unknown");
    expect(reconciliationFor(f.repo, intent.intentRef, { requestId: "lookup", idempotencyKey: "lookup-1" })).toEqual({ kind: "hold", reasonCode: "SOURCE_RECONCILIATION_REQUIRED" });
    f.repo.reconcile({ result: "found", intentRef: intent.intentRef, providerReceipt: providerRef("native-invite"), receiptRefs: ["source-receipt"], expiresAt: null }, "found");
    expect(f.repo.read(record.onboardingId)!.state).toBe("invited");
    expect(f.repo.output(record.onboardingId).providerReceipt).toEqual(providerRef("native-invite"));
  });

  it("final synthetic evidence proves every onboarding phase without a live invitation", () => {
    const f = onboardingFixture();
    const record = f.linked();
    f.repo.recordAttributionMatrix(record.onboardingId, f.passingOrders(), "matrix");
    f.sendIntent(f.repo.proposeActivation(record.onboardingId, "activate"));
    f.repo.observePayoutSetup(record.onboardingId, { evidence: f.evidence("setup", { state: "complete", owner: "creator" }) }, "setup");
    const out = f.repo.output(record.onboardingId);
    expect(out).toMatchObject({ providerRelationshipRef: { sourceId: "synthetic-relationship" }, payoutSetupState: "complete", blockers: [],
      phaseReadiness: { invitation: "sent", acceptance: "accepted", linkCode: "mapped", checkoutTest: "passed", payoutSetup: "complete", activation: "active" } });
    expect(f.repo.read(record.onboardingId)!.preflight.origin).toBe("synthetic");
    expect(f.repo.intents(record.onboardingId).every(i => i.sends === false)).toBe(true);
  });
});

describe("reserve-then-submit and conflicts", () => {
  it("a terms change while an invitation is live opens a blocking conflict, and the J04 current-draft check refuses it", () => {
    const f = onboardingFixture();
    const record = f.opened();
    const intent = f.repo.proposeInvitation(record.onboardingId, "invite");
    f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
    const check = () => f.repo.assertJ04Current(intent.intentRef, intent.intentVersion);
    expect(check).not.toThrow();
    f.setOffer(f.offer.current!.terms, "synthetic-offer-v2");
    expect(check).toThrow(code("TERMS_CHANGED"));
    f.repo.syncTerms(record.onboardingId, "sync");
    expect(check).toThrow(code("INTENT_WITHDRAWN"));
    expect(() => previewActionFor(f.repo, intent.intentRef, { requestId: "retry" })).toThrow(code("INTENT_NOT_RESERVED"));
    expect(f.repo.conflicts(record.onboardingId)).toEqual([expect.objectContaining({ kind: "termsChangedWhileLive", blocking: true, intentState: "previewing" })]);
    // A same-key replay of the reservation re-reads state and refuses the withdrawn intent.
    expect(() => f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" })).toThrow(code("INTENT_NOT_PREVIEWING"));
    // A late real receipt is kept for audit but never applied.
    const late = f.repo.recordOutcome({ kind: "sent", intentRef: intent.intentRef, approvalRef: "a", manifestRef: "m", runRef: "r", runVersion: "v",
      receiptRefs: ["late"], providerReceipt: providerRef("late"), expiresAt: null }, "late");
    expect(late.state).toBe("conflict");
    expect(f.repo.read(record.onboardingId)!.state).toBe("termsChanged");
  });

  it("a closure while an activation is live opens a blocking conflict that holds new intents", () => {
    const f = onboardingFixture();
    const record = f.linked();
    f.repo.recordAttributionMatrix(record.onboardingId, f.passingOrders(), "matrix");
    const intent = f.repo.proposeActivation(record.onboardingId, "activate");
    f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
    f.repo.close(record.onboardingId, { reason: "merchant-withdrew", sourceRef: providerRef("synthetic-closure") }, "close");
    const [conflict] = f.repo.conflicts(record.onboardingId);
    expect(conflict).toMatchObject({ kind: "closedWhileLive", blocking: true });
    expect(() => f.repo.assertJ04Current(intent.intentRef, intent.intentVersion)).toThrow(code("INTENT_WITHDRAWN"));
    expect(f.repo.output(record.onboardingId).blockers).toContainEqual({ code: "CONFLICT_CLOSED_WHILE_LIVE", owner: "operator", sourceRef: null });
  });

  it("refuses a second reservation key and keeps one open intent per kind", () => {
    const f = onboardingFixture();
    const record = f.opened();
    const intent = f.repo.proposeInvitation(record.onboardingId, "invite");
    expect(f.repo.proposeInvitation(record.onboardingId, "invite")).toEqual(intent);
    expect(() => f.repo.proposeInvitation(record.onboardingId, "invite-2")).toThrow(code("INTENT_ALREADY_OPEN"));
    const first = f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
    expect(f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" })).toEqual(first);
    expect(() => f.repo.reserve(intent.intentRef, "reserve-2", { requestId: "request" })).toThrow(code("INTENT_ALREADY_RESERVED"));
  });
});

describe("repository conventions", () => {
  it("binds the shared agent database scope and refuses a reused idempotency key with another request", () => {
    const f = onboardingFixture();
    const other = new AgentStore(":memory:", { workspaceId: "another-workspace", accountId: onboardingScope.accountId });
    expect(() => new AffiliateOnboardingRepository(other.database, onboardingScope, f.authority)).toThrow(code("DATABASE_SCOPE_MISMATCH"));
    const record = f.opened();
    expect(() => f.repo.refreshPreflight(record.onboardingId, "open-1")).toThrow(code("IDEMPOTENCY_KEY_REUSED"));
    const tables = f.store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'affiliate_onboarding_%'").all().map(r => r.name);
    expect(tables.length).toBeGreaterThan(5);
  });

  it("reads the clock inside the lock and keeps a blocked preflight blocked until refreshed", () => {
    const f = onboardingFixture();
    f.state.capability.set("invite", f.readiness({ allowed: false, state: "Unverified" }));
    const record = f.opened();
    expect(record.state).toBe("preflightBlocked");
    expect(() => f.repo.proposeInvitation(record.onboardingId, "invite")).toThrow(code("NOT_READY_TO_INVITE"));
    f.state.capability.delete("invite");
    f.advance(60_000);
    const refreshed = f.repo.refreshPreflight(record.onboardingId, "refresh");
    expect(refreshed).toMatchObject({ state: "readyToInvite", preflight: { checkedAt: new Date(f.now()).toISOString() } });
  });
});

describe("review follow-ups", () => {
  it("an activation live in J04 is refused by the current-draft check once its matrix fails, and is withdrawn with a blocking conflict", () => {
    const f = onboardingFixture();
    const record = f.linked();
    f.repo.recordAttributionMatrix(record.onboardingId, f.passingOrders(), "matrix-pass");
    const intent = f.repo.proposeActivation(record.onboardingId, "activate");
    f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
    f.repo.recordOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "approval-a", manifestRef: "manifest-a" }, "approved");
    expect(() => f.repo.assertJ04Current(intent.intentRef, intent.intentVersion)).not.toThrow();
    const failing = f.passingOrders().map(o => o.case === "untracked"
      ? { ...o, providerCredit: { state: "credited" as const, relationshipSourceId: "synthetic-relationship", via: "link" as const } } : o);
    const result = f.repo.recordAttributionMatrix(record.onboardingId, failing, "matrix-fail");
    expect(result.record.checkoutTest.state).toBe("failed");
    expect(result.record.activation.state).toBe("notReady");
    expect(() => f.repo.assertJ04Current(intent.intentRef, intent.intentVersion)).toThrow(code("INTENT_WITHDRAWN"));
    expect(f.repo.conflicts(record.onboardingId)).toEqual([expect.objectContaining({ kind: "evidenceChangedWhileLive", blocking: true, intentState: "awaitingApproval" })]);
    expect(() => f.repo.proposeActivation(record.onboardingId, "activate-again")).toThrow(code("ACTIVATION_NOT_READY"));
  });

  it("the current-draft check re-runs the activation gate even before a withdrawal is recorded", () => {
    const f = onboardingFixture();
    const record = f.linked();
    f.repo.recordAttributionMatrix(record.onboardingId, f.passingOrders(), "matrix-pass");
    const intent = f.repo.proposeActivation(record.onboardingId, "activate");
    f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
    // A failing matrix written directly to the record, as a concurrent writer might leave it, still blocks approval.
    const stored = f.repo.read(record.onboardingId)!;
    f.store.database.prepare("UPDATE affiliate_onboarding_records SET body=? WHERE onboarding_id=?")
      .run(JSON.stringify({ ...stored, checkoutTest: { ...stored.checkoutTest, state: "failed" } }), record.onboardingId);
    expect(() => f.repo.assertJ04Current(intent.intentRef, intent.intentVersion)).toThrow(expect.objectContaining({ code: "ACTIVATION_NOT_READY", reasonCodes: ["ATTRIBUTION_MATRIX_NOT_PASSED"] }));
  });

  it("after a terms change the relationship is re-observed and re-mapped under the new version before activation", () => {
    const f = onboardingFixture();
    const v1 = f.linked();
    f.repo.recordAttributionMatrix(v1.onboardingId, f.passingOrders(), "matrix-v1");
    f.setOffer(f.offer.current!.terms, "synthetic-offer-v2");
    f.repo.syncTerms(v1.onboardingId, "sync");
    const revised = f.repo.reviseTerms(v1.onboardingId, { ...f.input().approvedTerms, offerVersion: "synthetic-offer-v2" }, "revise");
    expect(revised).toMatchObject({ state: "readyToInvite", linkCode: { state: "notIssued", relationshipRef: null }, checkoutTest: { state: "notRun" } });
    expect(f.repo.history(v1.onboardingId).some(r => r.linkCode.state === "mapped" && r.offerVersion === "synthetic-offer-v1")).toBe(true);
    expect(() => f.repo.proposeActivation(v1.onboardingId, "activate-early")).toThrow(code("ACTIVATION_NOT_READY"));
    // New invitation and acceptance under v2.
    f.sendIntent(f.repo.proposeInvitation(v1.onboardingId, "invite-v2"));
    expect(() => f.repo.mapRelationship(v1.onboardingId, f.relationship("synthetic-offer-v2"), "map-before-accept")).toThrow(code("CURRENT_ACCEPTANCE_REQUIRED"));
    f.repo.observe(v1.onboardingId, { type: "acceptance", evidence: f.evidence("accept-v2", { offerId: v1.offerId, offerVersion: "synthetic-offer-v2" }) }, "accept-v2");
    expect(() => f.repo.mapRelationship(v1.onboardingId, f.relationship("synthetic-offer-v1"), "map-old")).toThrow(code("RELATIONSHIP_VERSION_MISMATCH"));
    // The same provider relationship and code re-map cleanly under v2.
    const remapped = f.repo.mapRelationship(v1.onboardingId, f.relationship("synthetic-offer-v2"), "map-v2");
    expect(remapped).toMatchObject({ created: true, record: { linkCode: { state: "mapped", relationshipRef: { sourceId: "synthetic-relationship" } } } });
    expect(f.repo.mapRelationship(v1.onboardingId, f.relationship("synthetic-offer-v2"), "map-v2-again").created).toBe(false);
    expect(f.store.database.prepare("SELECT offer_version FROM affiliate_onboarding_relationships ORDER BY offer_version").all().map(r => r.offer_version))
      .toEqual(["synthetic-offer-v1", "synthetic-offer-v2"]);
    expect(() => f.repo.proposeActivation(v1.onboardingId, "activate-no-matrix")).toThrow(code("ACTIVATION_NOT_READY"));
    f.repo.recordAttributionMatrix(v1.onboardingId, f.passingOrders(), "matrix-v2");
    const activation = f.repo.proposeActivation(v1.onboardingId, "activate-v2");
    expect(activation).toMatchObject({ kind: "activation", offerVersion: "synthetic-offer-v2" });
    f.sendIntent(activation);
    expect(f.repo.output(v1.onboardingId).phaseReadiness).toMatchObject({ acceptance: "accepted", linkCode: "mapped", checkoutTest: "passed", activation: "active" });
  });

  it("a synthetic account record is not ready unless the authority explicitly allows it for tests", () => {
    const f = onboardingFixture();
    const strict = new AffiliateOnboardingRepository(f.store.database, onboardingScope, { ...f.authority, allowSyntheticAccounts: undefined }, f.now);
    const record = strict.open(f.input(), "open-strict").record;
    expect(record.state).toBe("preflightBlocked");
    expect(record.preflight.blockers).toContainEqual({ code: "SYNTHETIC_ACCOUNT_NOT_ALLOWED", owner: "operator", sourceRef: null });
    expect(strict.output(record.onboardingId)).toMatchObject({ origin: "synthetic", phaseReadiness: { origin: "synthetic", invitation: "blocked" } });
    expect(() => strict.proposeInvitation(record.onboardingId, "invite-strict")).toThrow(code("NOT_READY_TO_INVITE"));
    f.state.account = { ...(f.state.account as object), origin: "source" };
    const sourced = new AffiliateOnboardingRepository(f.store.database, onboardingScope, { ...f.authority, allowSyntheticAccounts: undefined }, f.now)
      .refreshPreflight(record.onboardingId, "refresh-source");
    expect(sourced).toMatchObject({ state: "readyToInvite", preflight: { origin: "source" } });
  });
});

describe("P3 follow-ups", () => {
  it("an absence for a dispatched run with an unknown deadline holds for an operator", () => {
    const f = onboardingFixture();
    const record = f.opened();
    const intent = f.repo.proposeInvitation(record.onboardingId, "invite");
    f.repo.reserve(intent.intentRef, "reserve", { requestId: "request" });
    f.repo.recordOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1" }, "approved");
    f.repo.recordOutcome({ kind: "dispatchPending", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1" }, "dispatched");
    f.repo.recordOutcome({ kind: "uncertain", intentRef: intent.intentRef, approvalRef: "approval-1", manifestRef: "manifest-1", runRef: "run-1", runVersion: "v1" }, "unknown");
    f.advance(30 * 86_400_000);
    const held = f.repo.reconcile({ result: "absent", intentRef: intent.intentRef, sourceRef: providerRef("synthetic-no-invite"), terminal: true }, "absent");
    expect(held).toMatchObject({ state: "held", reasonCode: "RUN_DEADLINE_UNKNOWN", retryAfter: null });
    expect(f.repo.intent(intent.intentRef)).toMatchObject({ state: "reconciliationRequired", approvalRef: "approval-1" });
    expect(f.repo.pendingReconciliation().map(i => i.intentRef)).toEqual([intent.intentRef]);
    // The first run's deadline stays the binding: a later answer cannot move it.
    expect(f.repo.reconcile({ result: "found", intentRef: intent.intentRef, providerReceipt: providerRef("native-invite"), receiptRefs: ["r"], expiresAt: null }, "found").state).toBe("recorded");
  });

  it("returning to an earlier offer version re-maps under a new terms revision without a storage conflict", () => {
    const f = onboardingFixture();
    const record = f.linked();
    const cycle = (version: string, n: number) => {
      f.setOffer(f.offer.current!.terms, version);
      f.repo.syncTerms(record.onboardingId, `cycle-sync-${n}`);
      f.repo.reviseTerms(record.onboardingId, { ...f.input().approvedTerms, offerVersion: version }, `cycle-revise-${n}`);
      f.sendIntent(f.repo.proposeInvitation(record.onboardingId, `cycle-invite-${n}`));
      f.repo.observe(record.onboardingId, { type: "acceptance", evidence: f.evidence(`accept-${n}`, { offerId: record.offerId, offerVersion: version }) }, `cycle-accept-${n}`);
      return f.repo.mapRelationship(record.onboardingId, f.relationship(version), `cycle-map-${n}`);
    };
    expect(cycle("synthetic-offer-v2", 2).created).toBe(true);
    const back = cycle("synthetic-offer-v1", 3);
    expect(back).toMatchObject({ created: true, record: { offerVersion: "synthetic-offer-v1", termsRevision: 3, linkCode: { state: "mapped" } } });
    expect(f.repo.mapRelationship(record.onboardingId, f.relationship("synthetic-offer-v1"), "cycle-map-3-again").created).toBe(false);
    expect(f.store.database.prepare("SELECT terms_revision,offer_version FROM affiliate_onboarding_relationships ORDER BY terms_revision").all()
      .map(r => [r.terms_revision, r.offer_version])).toEqual([[1, "synthetic-offer-v1"], [2, "synthetic-offer-v2"], [3, "synthetic-offer-v1"]]);
    expect(() => f.repo.mapRelationship(record.onboardingId, f.relationship("synthetic-offer-v1", "another-relationship"), "cycle-map-other"))
      .toThrow(code("RELATIONSHIP_ALREADY_MAPPED"));
  });

  it("refuses a relationship or a link or code already mapped to another creator", () => {
    const f = onboardingFixture();
    f.linked();
    // A second synthetic creator, with its own identity, account record and approved offer.
    const other = "synthetic-creator-b";
    const creatorRef = { provider: "farda-creator", accountId: onboardingScope.accountId, sourceId: other, url: null };
    f.state.identity = { creatorId: other, revision: 1, suppressions: [] };
    f.state.account = accountFixture(f.now(), { creatorRef });
    f.setOffer({ ...f.offer.current!.terms, creatorId: other }, "synthetic-offer-v1");
    const b = f.repo.open(f.input({ creatorRef }), "open-b").record;
    expect(b.state).toBe("readyToInvite");
    f.sendIntent(f.repo.proposeInvitation(b.onboardingId, "invite-b"));
    f.repo.observe(b.onboardingId, { type: "acceptance", evidence: f.evidence("accept-b", { offerId: b.offerId, offerVersion: b.offerVersion }) }, "accept-b");
    expect(() => f.repo.mapRelationship(b.onboardingId, f.relationship(b.offerVersion), "map-b-relationship")).toThrow(code("RELATIONSHIP_CROSS_CREATOR"));
    expect(() => f.repo.mapRelationship(b.onboardingId, f.relationship(b.offerVersion, "relationship-b", "link-b", "SYNTHETICCODE"), "map-b-code"))
      .toThrow(code("LINK_CODE_CROSS_CREATOR"));
    expect(() => f.repo.mapRelationship(b.onboardingId, f.relationship(b.offerVersion, "relationship-b", "synthetic-link", "CODEB"), "map-b-link"))
      .toThrow(code("LINK_CODE_CROSS_CREATOR"));
    expect(f.repo.mapRelationship(b.onboardingId, f.relationship(b.offerVersion, "relationship-b", "link-b", "CODEB"), "map-b").created).toBe(true);
  });
});
