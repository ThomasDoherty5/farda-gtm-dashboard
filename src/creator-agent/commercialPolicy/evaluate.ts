import { evaluateTerms, type AcquisitionTerms } from "../../adapter/commissionPolicy.ts";
import type { OfferTerms, ProviderFacts } from "../offers/contract.ts";
import type { CommercialPolicySnapshot } from "./contract.ts";

export const canonicalCommercialName = (value: string) => value.toLowerCase().replace(/[ _-]/g, "");
export function acquisitionTermsOf(terms: OfferTerms): AcquisitionTerms {
  const sampleCost = terms.sample.requested ? (terms.sample.merchandiseCapMinor ?? 0) + (terms.sample.shippingCapMinor ?? 0) : 0;
  return { relationship: "commissionOnly", upfrontFeeMinor: terms.upfrontFeeMinor, guaranteedFeeMinor: terms.guaranteedFeeMinor,
    paidComponentMinor: 0, commissionPct: terms.commission.type === "percentage" ? (terms.commission.standardRateBps ?? 0) / 100 : 0,
    perSaleFixedMinor: terms.commission.type === "fixed-per-sale" ? terms.commission.fixedMinor ?? 0 : 0, sampleCostMinor: sampleCost };
}
/** Eligibility is not a J04 approval, sample allocation or source acceptance. */
export function evaluateCommercialTerms(terms: OfferTerms, policy: CommercialPolicySnapshot | null, provider?:ProviderFacts|null, now?:number): string[] {
  // Unconditional structural fee restrictions are also enforced by the strict OfferTerms schema.
  if (!policy) return ["COMMERCIAL_POLICY_UNAVAILABLE"];
  const reasons = evaluateTerms(acquisitionTermsOf(terms), { version: policy.version, maxCommissionPct: policy.commission.maxRateBps / 100,
    sampleCapMinor: policy.samples.merchandiseCapMinor + policy.samples.shippingCapMinor }).blockers.map(row => row.code as string);
  if (terms.policyVersion !== policy.version) reasons.push("COMMERCIAL_POLICY_CHANGED","NEW_PREVIEW_REQUIRED");
  if (terms.pricingVersion !== policy.pricing.version) reasons.push("COMMERCIAL_PRICING_CHANGED");
  if (terms.commission.fixedMinor !== null && terms.commission.fixedMinor > policy.commission.maxFixedPerSaleMinor) reasons.push("PER_SALE_FIXED_ABOVE_CAP");
  const route = policy.routes.find(row => canonicalCommercialName(row.recruitmentSource) === canonicalCommercialName(terms.recruitmentSource) &&
    canonicalCommercialName(row.publishingNetwork) === canonicalCommercialName(terms.publishingNetwork) && row.checkoutRoute === terms.checkoutRoute && row.provider === terms.provider &&
    (!provider?.providerAccountRef || row.providerAccountRef===provider.providerAccountRef));
  if (!route) reasons.push("COMMERCIAL_ROUTE_UNSUPPORTED");
  if (route && (terms.commission.type === "percentage" ? !route.supportsPercentage : !route.supportsFixedPerSale)) reasons.push("COMMISSION_ROUTE_UNSUPPORTED");
  if(route && provider) {
    if(!provider.providerAccountRef || route.providerAccountRef!==provider.providerAccountRef)reasons.push("PROVIDER_ACCOUNT_UNVERIFIED");
    if(route.payoutOwnerRef!==provider.payoutOwner)reasons.push("PROVIDER_PAYOUT_OWNER_MISMATCH");
    if(route.attributionOwnerRef!==provider.trackingOwner)reasons.push("PROVIDER_ATTRIBUTION_OWNER_MISMATCH");
    if(canonicalCommercialName(terms.recruitmentSource)==="socialcat" && (provider.recruitment?.source!=="social-cat" || provider.recruitment.collaboration!=="affiliate" ||
      now===undefined || Date.parse(provider.recruitment.observedAt)>now || Date.parse(provider.recruitment.validUntil)<=now))reasons.push("SOCIAL_CAT_AFFILIATE_SOURCE_UNVERIFIED");
  }
  if (route?.productAndShippingRequired && !terms.sample.requested) reasons.push("PRODUCT_AND_SHIPPING_REQUIRED");
  if (terms.sample.requested && (!policy.samples.eligible || terms.sample.unitsPerCreator > policy.samples.unitsPerCreatorCap ||
    terms.sample.merchandiseCapMinor === null || terms.sample.shippingCapMinor === null || terms.sample.merchandiseCapMinor > policy.samples.merchandiseCapMinor || terms.sample.shippingCapMinor > policy.samples.shippingCapMinor)) reasons.push("SAMPLE_POLICY_HELD");
  if (policy.claimsRefs.some(ref => !terms.manifest.claimsRefs.includes(ref))) reasons.push("CLAIM_POLICY_UNVERIFIED");
  if (policy.disclosureRefs.some(ref => !terms.manifest.guidanceRefs.includes(ref))) reasons.push("DISCLOSURE_POLICY_UNVERIFIED");
  if (!policy.pricing.bundles.some(row => row.id === terms.base.bundle) || !policy.pricing.bundles.some(row => row.id === terms.downside.bundle)) reasons.push("PRICE_BUNDLE_UNAVAILABLE");
  const reward = policy.performanceReward;
  if (reward) {
    if (terms.rewardVersion !== reward.rewardVersion || terms.rewardProgrammeRef !== reward.programmeRef) reasons.push("PERFORMANCE_REWARD_VERSION_MISMATCH");
    if (reward.terms.state !== "effective") reasons.push("PERFORMANCE_REWARD_PROPOSED");
    if (reward.pausedForNewAcquisition) reasons.push("PERFORMANCE_REWARD_PROGRAMME_PAUSED");
  } else if (terms.rewardVersion !== null || terms.rewardProgrammeRef) reasons.push("PERFORMANCE_REWARD_UNVERIFIED");
  return [...new Set(reasons)];
}
