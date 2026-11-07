import { digest } from "../config.ts";
import { commercialPolicyMaterial, rewardPolicyMaterial } from "./authority.ts";
import type { CommercialPolicySnapshot, CommercialPolicySource, CommercialScope, RewardPolicySnapshot } from "./contract.ts";

export const syntheticCommercialScope: CommercialScope = { workspaceId: "synthetic-commercial-workspace", accountId: "synthetic-commercial-account", environment: "sandbox" };
export function rewardPolicyFixture(scope = syntheticCommercialScope, now = Date.now()): RewardPolicySnapshot {
  return { scope, programmeRef: "synthetic-reward-programme", rewardVersion: "synthetic-reward-v1", sourceRef: "synthetic-reward-source", sourceVersion: "synthetic-reward-source-v1",
    observedAt: new Date(now - 1000).toISOString(), validUntil: new Date(now + 3600000).toISOString(), pausedForNewAcquisition: false,
    terms: { state: "effective", adoptionRef: "synthetic-reward-adoption", effectiveAt: new Date(now - 2000).toISOString(), fundingRef: "synthetic-reward-funding",
      economicsRef: "synthetic-reward-economics", conditionsRef: "synthetic-reward-conditions", currency: "USD", base: "matured-retained-eligible-merchandise",
      allInCaps: true, preservesEarnedObligations: true, milestones: [{ milestone: "tech", thresholdMinor: 10000, additionalCapMinor: 900 }],
      options: [{ optionId: "synthetic-option", milestone: "tech", kind: "item", label: "Fictional earned item", providerRef: "synthetic-reward-provider", deliveryRoute: "provider-direct" }] },
    execution: { state: "permitted", permissionRef: "synthetic-reward-permission", sourceVersion: "synthetic-permission-v1", observedAt: new Date(now - 1000).toISOString(), validUntil: new Date(now + 3600000).toISOString() } };
}
export function commercialPolicyFixture(scope = syntheticCommercialScope, now = Date.now()): CommercialPolicySnapshot {
  return { scope, policyId: "synthetic-commercial-policy", version: "commission-only-v1", sourceRef: "synthetic-commercial-source", sourceVersion: "synthetic-commercial-source-v1",
    ownerRef: "synthetic-policy-owner", observedAt: new Date(now - 1000).toISOString(), validUntil: new Date(now + 3600000).toISOString(),
    state: "effective", effectiveAt: new Date(now - 2000).toISOString(), approvalRef: "synthetic-commercial-adoption", compensation: "commission-only", currency: "USD",
    commission: { version: "synthetic-commission-v1", maxRateBps: 2500, maxFixedPerSaleMinor: 500, base: "retained-eligible-merchandise" },
    samples: { eligible: true, merchandiseCapMinor: 1600, shippingCapMinor: 600, unitsPerCreatorCap: 1, separateApprovalRequired: true },
    routes: [{ recruitmentSource: "social-cat", publishingNetwork: "instagram", checkoutRoute: "website", provider: "shopify-collabs", providerAccountRef:"synthetic-provider-account", collaboration: "affiliate",
      attributionOwnerRef: "synthetic-attribution-owner", payoutOwnerRef: "synthetic-payout-owner", supportsPercentage: true, supportsFixedPerSale: false, productAndShippingRequired: true }],
    claimsRefs: ["claims"], disclosureRefs: ["guide"], pricing: { version: "CEO-v1", sourceRef: "synthetic-price-source", bundles: [
      { id: "single", units: 1, merchandiseMinor: 3499, shippingMinor: 599 }, { id: "duo", units: 2, merchandiseMinor: 5598, shippingMinor: 599 }, { id: "trio", units: 3, merchandiseMinor: 8398, shippingMinor: 599 }] }, performanceReward: null };
}
/** Fictional backing source for tests: assertions read its actual current state, never echo their argument. */
export function commercialSourceFixture(initial = commercialPolicyFixture()) {
  const state = { current: initial, permitted: true, rewardVersions: new Map<string, RewardPolicySnapshot>() };
  const reward = (programmeRef: string, version: string) => state.rewardVersions.get(`${programmeRef}:${version}`) ??
    (state.current.performanceReward?.programmeRef === programmeRef && state.current.performanceReward.rewardVersion === version ? state.current.performanceReward : null);
  const source: CommercialPolicySource = {
    readCurrent: () => structuredClone(state.current),
    readRewardPolicy: input => structuredClone(reward(input.programmeRef, input.rewardVersion)),
    assertCurrent: snapshot => { if (!state.permitted || digest(commercialPolicyMaterial(snapshot)) !== digest(commercialPolicyMaterial(state.current))) throw new Error("Synthetic commercial source changed"); },
    assertRewardCurrent: snapshot => { const current = reward(snapshot.programmeRef, snapshot.rewardVersion);
      if (!state.permitted || !current || digest(rewardPolicyMaterial(snapshot)) !== digest(rewardPolicyMaterial(current))) throw new Error("Synthetic reward source changed"); },
  };
  return { state, source };
}
