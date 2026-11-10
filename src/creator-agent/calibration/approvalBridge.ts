import { digest } from "../config.ts";
import { ApprovalError, approvalDraftSchema, type ApprovalDraft, type ApprovalManifest, type ApprovalRegistry, type ProposeCommand } from "../approvals/contract.ts";
import { stableApprovalDraft } from "../approvals/repository.ts";
import { CALIBRATION_ACTION_KIND, CalibrationError, type CalibrationProposal } from "./contract.ts";
import type { CalibrationRepository } from "./repository.ts";

/** Deployment values for the existing J04 approval policy. No default is supplied: an unconfigured bridge is not created. */
export type CalibrationApprovalRegistration = { policyVersion: string; linearIssueRef: string };
const PROVIDER_ACCOUNT = "internal:evidence-policy-calibration";

/**
 * J04 registry for evidence-policy promotion. It describes one proposal as a `policyChange` manifest with no money,
 * creator send or stock effect. J04 then enforces founder authority and a second person distinct from the proposer.
 */
export function calibrationApprovalDraft(proposal: CalibrationProposal, registration: CalibrationApprovalRegistration): ApprovalDraft {
  const na = (reason: string) => ({ state: "notApplicable" as const, policyVersion: registration.policyVersion, reason });
  const basisRef = proposal.evidenceBasis.kind === "rollback" ? proposal.evidenceBasis.targetVersionRef : proposal.evidenceBasis.basisRef;
  const basisVersion = proposal.evidenceBasis.kind === "rollback" ? proposal.baseVersionRef : proposal.evidenceBasis.basisVersion;
  return approvalDraftSchema.parse({
    actionKind: CALIBRATION_ACTION_KIND, phase: "policyChange", providerAccountRef: PROVIDER_ACCOUNT, providerAccountVersion: proposal.baseVersionRef,
    payloadHash: proposal.proposalHash, payloadRef: proposal.proposalRef,
    productVersion: na("An evidence-policy change has no product version."), termsVersion: na("An evidence-policy change has no creator terms."),
    rightsVersion: na("An evidence-policy change has no media rights."), configVersion: proposal.baseVersionRef, policyVersion: registration.policyVersion,
    effects: { spendsMoney: false, sendsCreator: false, changesPolicy: true },
    items: [{ itemRef: proposal.proposalRef, itemVersion: proposal.proposalHash, targetRef: "evidence-policy:head", targetVersion: proposal.baseVersionRef,
      payloadHash: proposal.proposalHash, sourceRef: basisRef, units: 0, spendMinor: 0 }],
    bounds: { maxItems: 1, maxUnits: 0, maxSpendMinor: 0, currency: "USD" }, exposure: { state: "known", minor: 0, currency: "USD" },
    acquisitionTerms: null, historicalLiability: null,
    gates: { acceptedTerms: na("No creator terms are accepted."), sampleAuthority: na("No samples ship."), providerTerms: na("No provider action."),
      launchReadiness: na("Not a launch."),
      // The server-stored evidence basis is this proposal's source. It is not a provider or creator permission.
      sourcePermission: { state: "satisfied", sourceRef: basisRef, sourceVersion: basisVersion, validUntil: proposal.expiresAt } },
    sourceBasisRef: basisRef, sourceBasisVersion: basisVersion, sourceValidUntil: proposal.expiresAt,
    linearIssueRef: registration.linearIssueRef, expiresAt: proposal.expiresAt,
  });
}

function current(repository: CalibrationRepository, ref: string, now: number): CalibrationProposal {
  try { return repository.approvableProposal(ref, now); }
  catch (cause) { throw cause instanceof CalibrationError ? new ApprovalError(cause.code) : cause; }
}

export function createCalibrationApprovalRegistry(repository: CalibrationRepository, registration: CalibrationApprovalRegistration, now: () => number = Date.now): ApprovalRegistry {
  if (!registration.policyVersion || !registration.linearIssueRef) throw new CalibrationError("APPROVAL_REGISTRATION_REQUIRED", 503);
  return {
    resolvePreview: async (command: ProposeCommand, principal, scope) => {
      if (scope.workspaceId !== repository.scope.workspaceId || scope.accountId !== repository.scope.accountId) throw new ApprovalError("APPROVAL_SCOPE_MISMATCH");
      if (command.actionKind !== CALIBRATION_ACTION_KIND || command.selectionRefs.length !== 1 || command.selectionRefs[0] !== command.entityRef) throw new ApprovalError("PREVIEW_SELECTION_MISMATCH");
      const proposal = current(repository, command.entityRef, now());
      if (command.entityVersion !== proposal.proposalHash) throw new ApprovalError("APPROVAL_SOURCE_CHANGED");
      // The J04 proposer must be the proposal's author, so J04's second-person rule also bars self-approval of a calibration change.
      if (principal.principalRef !== proposal.proposedBy) throw new ApprovalError("PROPOSER_MISMATCH");
      return calibrationApprovalDraft(proposal, registration);
    },
    currentDraft: async (manifest: ApprovalManifest) => {
      const item = manifest.items[0];
      if (manifest.items.length !== 1 || !item) throw new ApprovalError("APPROVAL_BINDING_MISMATCH");
      return calibrationApprovalDraft(current(repository, item.itemRef, now()), registration);
    },
    assertCurrentDraft: (manifest, observed, at) => {
      const item = manifest.items[0];
      if (manifest.items.length !== 1 || !item) throw new ApprovalError("APPROVAL_BINDING_MISMATCH");
      const draft = calibrationApprovalDraft(current(repository, item.itemRef, at), registration);
      if (digest(stableApprovalDraft(draft)) !== digest(stableApprovalDraft(observed)) || Date.parse(draft.expiresAt) <= at) throw new ApprovalError("APPROVAL_SOURCE_CHANGED");
    },
  };
}
