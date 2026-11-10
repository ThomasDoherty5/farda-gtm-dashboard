import { evaluateTerms } from "../../adapter/commissionPolicy.ts";
import { type ApprovalDraft, type ApprovalPolicy, type TrustedHuman, type ApprovalManifest } from "./contract.ts";
import { fresh } from "./authority.ts";

export function draftPolicyReasons(draft: ApprovalDraft, policy: ApprovalPolicy | null, now: number): string[] {
  const reasons = new Set<string>();
  if (!policy) return ["APPROVAL_POLICY_UNAVAILABLE"];
  if (draft.policyVersion !== policy.version) reasons.add("APPROVAL_POLICY_CHANGED");
  if (Date.parse(draft.expiresAt) <= now || !Number.isFinite(Date.parse(draft.expiresAt))) reasons.add("APPROVAL_EXPIRED");
  if (Date.parse(draft.sourceValidUntil) <= now || !Number.isFinite(Date.parse(draft.sourceValidUntil))) reasons.add("APPROVAL_SOURCE_STALE");
  if (draft.exposure.state === "unknown") reasons.add("ECONOMIC_EXPOSURE_UNKNOWN");
  const reward = draft.phase === "rewardRedemption";
  const stage = draft.phase === "mediaStageRelease", safety = draft.phase === "mediaSafetyPause";
  if (draft.actionKind === "media.stageRelease" && !stage || draft.actionKind === "media.pause" && !safety) reasons.add("MEDIA_APPROVAL_PHASE_REQUIRED");
  if (stage) {
    const cap = draft.mediaAuthorization;
    if (draft.actionKind !== "media.stageRelease" || !cap || draft.acquisitionTerms || draft.historicalLiability ||
      draft.items.length !== 1 || draft.bounds.maxItems !== 1 || draft.bounds.maxUnits !== 0 ||
      draft.items.some(item => item.units !== 0 || item.spendMinor !== 0) ||
      draft.exposure.state !== "known" || draft.exposure.minor !== cap.capMinor || draft.bounds.maxSpendMinor !== cap.capMinor ||
      draft.effects.spendsMoney || draft.effects.sendsCreator || draft.effects.changesPolicy) reasons.add("MEDIA_STAGE_AUTHORIZATION_INVALID");
  } else if (draft.mediaAuthorization) reasons.add("MEDIA_AUTHORIZATION_OUTSIDE_STAGE");
  if (safety && (draft.actionKind !== "media.pause" || draft.acquisitionTerms || draft.historicalLiability ||
    draft.items.some(item => item.units !== 0 || item.spendMinor !== 0) || draft.bounds.maxUnits !== 0 || draft.bounds.maxSpendMinor !== 0 ||
    draft.exposure.state !== "known" || draft.exposure.minor !== 0 || draft.effects.spendsMoney || draft.effects.sendsCreator || draft.effects.changesPolicy))
    reasons.add("MEDIA_SAFETY_PAUSE_INVALID");
  if (draft.actionKind === "reward.redeem" && !reward) reasons.add("REWARD_APPROVAL_PHASE_REQUIRED");
  if (reward && draft.acquisitionTerms) reasons.add("REWARD_ACQUISITION_TERMS_NOT_APPLICABLE");
  const rewardNeedsStock = reward && draft.items.some(item => item.units > 0);
  const needsSamples = !reward && (draft.phase === "shipment" || draft.items.some(item => item.units > 0) || (draft.acquisitionTerms?.sampleCostMinor ?? 0) > 0);
  const required = { acceptedTerms: ["activation", "shipment"].includes(draft.phase), sampleAuthority: needsSamples,
    providerTerms: ["invitation", "activation"].includes(draft.phase), launchReadiness: draft.phase === "launch" || stage, sourcePermission: true, rewardStockAuthority: rewardNeedsStock };
  if (rewardNeedsStock && !draft.gates.rewardStockAuthority) reasons.add("GATE_REWARDSTOCKAUTHORITY_REQUIRED");
  for (const [name, gate] of Object.entries(draft.gates)) {
    if (!gate) continue;
    if (gate.state === "unknown") reasons.add(`GATE_${name.toUpperCase()}_UNKNOWN`);
    else if (gate.state === "notApplicable") {
      if (gate.policyVersion !== policy.version || required[name as keyof typeof required]) reasons.add(`GATE_${name.toUpperCase()}_REQUIRED`);
    } else if (Date.parse(gate.validUntil) <= now) reasons.add(`GATE_${name.toUpperCase()}_STALE`);
  }
  for (const requirement of [draft.productVersion, draft.termsVersion, draft.rightsVersion])
    if (requirement.state === "notApplicable" && requirement.policyVersion !== policy.version) reasons.add("VERSION_APPLICABILITY_CHANGED");
  if (["invitation", "activation"].includes(draft.phase) && (!draft.acquisitionTerms || draft.termsVersion.state !== "required")) reasons.add("ACQUISITION_TERMS_REQUIRED");
  if (draft.acquisitionTerms) for (const blocker of evaluateTerms(draft.acquisitionTerms, policy.commission).blockers) reasons.add(blocker.code);
  if (draft.phase === "settlement") {
    const liability = draft.historicalLiability;
    if (!liability || Date.parse(liability.validUntil) <= now || draft.exposure.state !== "known" || liability.acceptedMinor !== draft.exposure.minor || liability.acceptedMinor !== draft.bounds.maxSpendMinor || draft.acquisitionTerms || needsSamples)
      reasons.add("HISTORICAL_LIABILITY_UNVERIFIED");
  } else if (draft.historicalLiability) reasons.add("HISTORICAL_LIABILITY_OUTSIDE_SETTLEMENT");
  if (!stage && (draft.bounds.maxSpendMinor > 0 || draft.phase === "settlement") && !draft.effects.spendsMoney) reasons.add("MONEY_EFFECT_MISMATCH");
  if (draft.phase === "policyChange" && !draft.effects.changesPolicy) reasons.add("POLICY_EFFECT_MISMATCH");
  if (draft.phase === "invitation" && !draft.effects.sendsCreator) reasons.add("CREATOR_EFFECT_MISMATCH");
  return [...reasons];
}
export function actorCanPropose(human: TrustedHuman, now: number): boolean {
  return human.active && fresh(human.observedAt, human.validUntil, now) && human.roles.some(role => role === "founder" || role === "operator" || role === "reviewer" || role === "finance");
}
export function decisionAuthorityReasons(manifest: ApprovalManifest, human: TrustedHuman, policy: ApprovalPolicy, now: number): string[] {
  const reasons: string[] = [];
  const draft = manifest.draft;
  if (!actorCanPropose(human, now)) reasons.push("AUTHORITY_REQUIRED");
  if ((draft.effects.spendsMoney || draft.effects.sendsCreator || draft.effects.changesPolicy || ["invitation", "activation", "mediaStageRelease", "mediaSafetyPause"].includes(draft.phase)) && human.personRef === manifest.proposer.personRef) reasons.push("SECOND_PERSON_REQUIRED");
  // Commission commitments need founder approval even when no cash is charged now.
  // A generic phase must not downgrade an explicit programme/rate policy change.
  if ((draft.bounds.maxSpendMinor > policy.founderThresholdMinor || draft.effects.changesPolicy || ["invitation", "activation", "policyChange", "settlement", "rewardRedemption", "mediaStageRelease", "mediaSafetyPause", "launch", "productionEnable"].includes(draft.phase)) && !human.roles.includes("founder")) reasons.push("FOUNDER_REQUIRED");
  return reasons;
}
