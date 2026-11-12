import { digest } from "../config.ts";
import { ApprovalError, approvalDraftSchema, type ApprovalDraft, type ApprovalManifest, type ApprovalRegistry, type ProposeCommand } from "../approvals/contract.ts";
import { stableApprovalDraft } from "../approvals/repository.ts";
import { CALIBRATION_ACTION_KIND, CalibrationError, type BasisObservation, type CalibrationProposal } from "./contract.ts";
import type { CalibrationRepository } from "./repository.ts";

/** Deployment values for the existing J04 approval policy. No default is supplied: an unconfigured bridge is not created. */
export type CalibrationApprovalRegistration = { policyVersion: string; linearIssueRef: string };
const PROVIDER_ACCOUNT = "internal:evidence-policy-calibration";

/**
 * J04 registry for evidence-policy promotion. It describes one proposal as a `policyChange` manifest with no money,
 * creator send or stock effect. J04 then enforces founder authority and a second person distinct from the proposer.
 *
 * The J04 `sourcePermission` gate is satisfied only by a fresh resolver observation of the evidence basis, never by the
 * author's claimed counts. Its version is bound to the resolved counts and it is valid only for the observation TTL.
 * A rollback's source is the target version in this module's own immutable version table.
 */
export function calibrationApprovalDraft(proposal: CalibrationProposal, observation: BasisObservation | null, registration: CalibrationApprovalRegistration): ApprovalDraft {
  const na = (reason: string) => ({ state: "notApplicable" as const, policyVersion: registration.policyVersion, reason });
  let source: { ref: string; version: string; basisVersion: string; validUntil: string };
  if (proposal.evidenceBasis.kind === "rollback") {
    source = { ref: proposal.evidenceBasis.targetVersionRef, version: `config-${proposal.proposedConfigHash.slice(0, 40)}`, basisVersion: proposal.baseVersionRef, validUntil: proposal.expiresAt };
  } else {
    if (!observation || observation.proposalRef !== proposal.proposalRef || observation.countsHash !== proposal.verifiedBasis?.countsHash) throw new ApprovalError("EVIDENCE_BASIS_UNVERIFIED");
    source = { ref: proposal.evidenceBasis.basisRef, version: `counts-${observation.countsHash.slice(0, 40)}`, basisVersion: proposal.evidenceBasis.basisVersion, validUntil: observation.validUntil };
  }
  return approvalDraftSchema.parse({
    actionKind: CALIBRATION_ACTION_KIND, phase: "policyChange", providerAccountRef: PROVIDER_ACCOUNT, providerAccountVersion: proposal.baseVersionRef,
    payloadHash: proposal.proposalHash, payloadRef: proposal.proposalRef,
    productVersion: na("An evidence-policy change has no product version."), termsVersion: na("An evidence-policy change has no creator terms."),
    rightsVersion: na("An evidence-policy change has no media rights."), configVersion: proposal.baseVersionRef, policyVersion: registration.policyVersion,
    effects: { spendsMoney: false, sendsCreator: false, changesPolicy: true },
    items: [{ itemRef: proposal.proposalRef, itemVersion: proposal.proposalHash, targetRef: "evidence-policy:head", targetVersion: proposal.baseVersionRef,
      payloadHash: proposal.proposalHash, sourceRef: source.ref, units: 0, spendMinor: 0 }],
    bounds: { maxItems: 1, maxUnits: 0, maxSpendMinor: 0, currency: "USD" }, exposure: { state: "known", minor: 0, currency: "USD" },
    acquisitionTerms: null, historicalLiability: null,
    gates: { acceptedTerms: na("No creator terms are accepted."), sampleAuthority: na("No samples ship."), providerTerms: na("No provider action."),
      launchReadiness: na("Not a launch."),
      // A verified review-record observation, not a provider or creator permission.
      sourcePermission: { state: "satisfied", sourceRef: source.ref, sourceVersion: source.version, validUntil: source.validUntil } },
    sourceBasisRef: source.ref, sourceBasisVersion: source.basisVersion, sourceValidUntil: source.validUntil,
    linearIssueRef: registration.linearIssueRef, expiresAt: proposal.expiresAt,
  });
}

const asApproval = (cause: unknown) => cause instanceof CalibrationError ? new ApprovalError(cause.code) : cause;
function current(repository: CalibrationRepository, ref: string, now: number): CalibrationProposal {
  try { return repository.approvableProposal(ref, now); } catch (cause) { throw asApproval(cause); }
}
async function refreshed(repository: CalibrationRepository, ref: string, now: () => number) {
  current(repository, ref, now());
  let observation: BasisObservation | null;
  try { observation = await repository.observeBasis(ref); } catch (cause) { throw asApproval(cause); }
  return { proposal: current(repository, ref, now()), observation };
}

export function createCalibrationApprovalRegistry(repository: CalibrationRepository, registration: CalibrationApprovalRegistration, now: () => number = Date.now): ApprovalRegistry {
  if (!registration.policyVersion || !registration.linearIssueRef) throw new CalibrationError("APPROVAL_REGISTRATION_REQUIRED", 503);
  const single = (manifest: ApprovalManifest) => {
    const item = manifest.items[0];
    if (manifest.items.length !== 1 || !item) throw new ApprovalError("APPROVAL_BINDING_MISMATCH");
    return item.itemRef;
  };
  return {
    resolvePreview: async (command: ProposeCommand, principal, scope) => {
      if (scope.workspaceId !== repository.scope.workspaceId || scope.accountId !== repository.scope.accountId) throw new ApprovalError("APPROVAL_SCOPE_MISMATCH");
      if (command.actionKind !== CALIBRATION_ACTION_KIND || command.selectionRefs.length !== 1 || command.selectionRefs[0] !== command.entityRef) throw new ApprovalError("PREVIEW_SELECTION_MISMATCH");
      const { proposal, observation } = await refreshed(repository, command.entityRef, now);
      if (command.entityVersion !== proposal.proposalHash) throw new ApprovalError("APPROVAL_SOURCE_CHANGED");
      // The J04 proposer must be the proposal's author, so J04's second-person rule also bars self-approval of a calibration change.
      if (principal.principalRef !== proposal.proposedBy) throw new ApprovalError("PROPOSER_MISMATCH");
      return calibrationApprovalDraft(proposal, observation, registration);
    },
    currentDraft: async (manifest: ApprovalManifest) => {
      const { proposal, observation } = await refreshed(repository, single(manifest), now);
      return calibrationApprovalDraft(proposal, observation, registration);
    },
    assertCurrentDraft: (manifest, observed, at) => {
      const ref = single(manifest), proposal = current(repository, ref, at);
      const observation = proposal.evidenceBasis.kind === "rollback" ? null : repository.latestBasisObservation(ref);
      if (proposal.evidenceBasis.kind !== "rollback" && (!observation || Date.parse(observation.validUntil) <= at)) throw new ApprovalError("EVIDENCE_BASIS_UNVERIFIED");
      const draft = calibrationApprovalDraft(proposal, observation, registration);
      if (digest(stableApprovalDraft(draft)) !== digest(stableApprovalDraft(observed)) || Date.parse(draft.expiresAt) <= at) throw new ApprovalError("APPROVAL_SOURCE_CHANGED");
    },
  };
}
