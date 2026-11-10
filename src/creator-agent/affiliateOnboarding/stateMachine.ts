import { routeCreatorReply } from "../../adapter/commissionPolicy.ts";
import type { OnboardingRecord, OnboardingState, PhaseReadiness, Ref, SourceEvent } from "./contract.ts";

/**
 * Pure onboarding transitions. Each phase keeps its own state: sending an invitation never sets acceptance, acceptance
 * never sets a link or code, and neither link issuance, acceptance nor merchant billing sets payout setup or activation.
 */
export type Transition = { ok: true; record: OnboardingRecord; changed: boolean; reasonCodes: string[] } | { ok: false; code: string };

const OPEN: OnboardingState[] = ["preflightBlocked", "readyToInvite", "invitationPending", "invitationUnknown", "invited", "invitationExpired", "feeRequested", "accepted"];
export const isOpen = (record: OnboardingRecord) => OPEN.includes(record.state);

const next = (record: OnboardingRecord, at: string, patch: Partial<OnboardingRecord>): OnboardingRecord =>
  ({ ...record, ...patch, revision: record.revision + 1, updatedAt: at });

/**
 * Applies one source observation. `currentOfferVersion` is the offer version the server just re-read; acceptance of
 * any other version, including the one this onboarding was opened with when the offer has since changed, is refused.
 */
export function applySourceEvent(record: OnboardingRecord, event: SourceEvent, currentOfferVersion: string | null, at: string): Transition {
  const evidence = event.evidence;
  // Unknown evidence is preserved with its reason and never advances a phase.
  if (evidence.value === null) return { ok: true, record, changed: false, reasonCodes: [`${event.type.replace(/[A-Z]/g, c => "_" + c).toUpperCase()}_UNKNOWN`] };
  const ref: Ref = evidence.ref;
  switch (event.type) {
    case "invitationExpired":
      if (record.state !== "invited") return { ok: false, code: "INVITATION_NOT_OUTSTANDING" };
      return { ok: true, changed: true, reasonCodes: ["INVITATION_EXPIRED"], record: next(record, at, { state: "invitationExpired", stateReasons: ["INVITATION_EXPIRED"],
        invitation: { ...record.invitation, expiredAt: event.evidence.value!.expiredAt } }) };
    case "creatorDeclined":
      if (!["invited", "feeRequested", "invitationExpired"].includes(record.state)) return { ok: false, code: "INVITATION_NOT_OUTSTANDING" };
      return { ok: true, changed: true, reasonCodes: ["CREATOR_DECLINED"], record: next(record, at, { state: "declined", stateReasons: ["CREATOR_DECLINED"],
        acceptance: { state: "declined", offerVersion: event.evidence.value!.offerVersion, evidenceRef: ref, observedAt: evidence.observedAt } }) };
    case "creatorReply": {
      const route = routeCreatorReply(event.evidence.value!.text, ref.sourceId);
      if (route.kind !== "feeRequest") return { ok: true, record, changed: false, reasonCodes: [] };
      // A fee request is a terms mismatch for a person; there is no automatic counteroffer, and it blocks activation.
      if (!["invited", "accepted", "feeRequested"].includes(record.state)) return { ok: false, code: "INVITATION_NOT_OUTSTANDING" };
      return { ok: true, changed: true, reasonCodes: route.reasonCodes, record: next(record, at, { state: "feeRequested", stateReasons: route.reasonCodes,
        acceptance: { state: "feeRequested", offerVersion: record.acceptance.offerVersion, evidenceRef: ref, observedAt: evidence.observedAt } }) };
    }
    case "acceptance": {
      const value = event.evidence.value!;
      if (value.offerId !== record.offerId) return { ok: false, code: "ACCEPTANCE_OFFER_MISMATCH" };
      if (value.offerVersion !== record.offerVersion || value.offerVersion !== currentOfferVersion) return { ok: false, code: "ACCEPTED_VERSION_NOT_CURRENT" };
      if (record.state === "invitationExpired") return { ok: false, code: "INVITATION_EXPIRED" };
      // An explicit acceptance of the exact current version resolves an earlier fee request; it never bypasses J04.
      if (record.state !== "invited" && record.state !== "feeRequested") return { ok: false, code: "INVITATION_NOT_OUTSTANDING" };
      return { ok: true, changed: true, reasonCodes: ["ACCEPTED_CURRENT_VERSION"], record: next(record, at, { state: "accepted", stateReasons: [],
        acceptance: { state: "accepted", offerVersion: value.offerVersion, evidenceRef: ref, observedAt: evidence.observedAt } }) };
    }
  }
}

/**
 * J10-05 and J10-09: the blockers to proposing activation. Activation needs current accepted terms, a mapped
 * relationship and link or code, and a passing attribution matrix for the same offer version. Payout setup is a later,
 * separate state and is not inferred here.
 */
export function activationBlockers(record: OnboardingRecord, currentOfferVersion: string | null): string[] {
  const out: string[] = [];
  if (record.state !== "accepted") out.push(record.state === "feeRequested" ? "CREATOR_FEE_REQUEST_OPEN" : "ACCEPTANCE_REQUIRED");
  if (record.acceptance.state !== "accepted" || record.acceptance.offerVersion !== record.offerVersion || record.offerVersion !== currentOfferVersion)
    out.push("CURRENT_ACCEPTED_TERMS_REQUIRED");
  if (record.linkCode.state !== "mapped") out.push("LINK_OR_CODE_NOT_MAPPED");
  if (record.checkoutTest.state !== "passed" || record.checkoutTest.offerVersion !== record.offerVersion) out.push("ATTRIBUTION_MATRIX_NOT_PASSED");
  if (record.activation.state !== "notReady") out.push("ACTIVATION_ALREADY_PROPOSED");
  return [...new Set(out)];
}
/** What must still hold for an activation already proposed or live in J04: everything except the proposal itself. */
export const activationGate = (record: OnboardingRecord, currentOfferVersion: string | null) =>
  activationBlockers(record, currentOfferVersion).filter(code => code !== "ACTIVATION_ALREADY_PROPOSED");

const INVITATION: Record<OnboardingState, string> = { preflightBlocked: "blocked", readyToInvite: "ready", invitationPending: "pending",
  invitationUnknown: "reconciliationRequired", invited: "sent", invitationExpired: "expired", declined: "sent", feeRequested: "sent",
  termsChanged: "termsChanged", accepted: "sent", closed: "closed" };

/** The ticket's phaseReadiness. Each phase is reported on its own, so none can be read as another. */
export function phaseReadiness(record: OnboardingRecord, currentOfferVersion: string | null): PhaseReadiness {
  const a = record.acceptance;
  const acceptance = a.state === "accepted" ? (a.offerVersion === currentOfferVersion && a.offerVersion === record.offerVersion ? "accepted" : "staleVersion")
    : a.state !== "unknown" ? a.state : record.state === "invited" ? "awaitingCreator" : "notStarted";
  const linkCode = record.linkCode.state === "mapped" ? "mapped" : record.state === "accepted" ? "pending" : "notStarted";
  const checkoutTest = record.checkoutTest.state === "passed" && record.checkoutTest.offerVersion !== record.offerVersion ? "staleVersion" : record.checkoutTest.state;
  const activation = record.activation.state === "active" ? "active" : record.activation.state === "proposed" ? "pending"
    : activationBlockers(record, currentOfferVersion).length ? "notReady" : "ready";
  return { origin: record.preflight.origin, invitation: INVITATION[record.state], acceptance, linkCode, checkoutTest, payoutSetup: record.payoutSetup.state, activation };
}
