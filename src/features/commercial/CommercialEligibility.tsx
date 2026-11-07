import { useId } from "react";
import { Badge } from "@/components/Badge";
import type { CommercialEligibilityReason, CommercialEligibilityView } from "@/creator-agent/commercialPolicy/views";
import { useSourceLease } from "./useSourceLease";
import styles from "./CommercialEligibility.module.css";

const reasons: Record<CommercialEligibilityReason, string> = {
  OFFER_SELECTION_REQUIRED: "Select an exact saved offer to review commercial eligibility.",
  OFFER_VERSION_REQUIRED: "The selected offer needs an exact saved version.",
  OFFER_VERSION_MISMATCH: "The selected offer version no longer matches.",
  OFFER_NOT_FOUND: "The selected saved offer is unavailable.",
  ASSESSMENT_BASIS_REQUIRED: "A matching saved assessment is required.",
  ASSESSMENT_BASIS_STALE: "The saved assessment needs a current review.",
  ASSESSMENT_BASIS_MISMATCH: "The assessment does not match this offer basis.",
  COMMERCIAL_SOURCE_HELD: "Current commercial source evidence is unavailable or held.",
  COMMERCIAL_POLICY_UNAVAILABLE: "Current commercial policy is unavailable.",
  COMMERCIAL_POLICY_UNVERIFIED: "Commercial policy adoption is unverified.",
  COMMERCIAL_POLICY_SOURCE_HELD: "The commercial policy source is held.",
  COMMERCIAL_POLICY_PROPOSED: "Commercial policy is proposed, not effective.",
  COMMERCIAL_POLICY_REVOKED: "Commercial policy authority was withdrawn.",
  COMMERCIAL_POLICY_NOT_EFFECTIVE: "Commercial policy is not currently effective.",
  COMMERCIAL_POLICY_CHANGED: "Commercial policy changed; review a new exact preview.",
  COMMERCIAL_PRICING_CHANGED: "Source prices changed; review a new exact preview.",
  NEW_PREVIEW_REQUIRED: "A new exact preview is required.",
  COMMERCIAL_ROUTE_UNSUPPORTED: "This commercial route is unsupported.",
  COMMISSION_ROUTE_UNSUPPORTED: "The commission structure is unsupported on this route.",
  PER_SALE_FIXED_ABOVE_CAP: "The fixed amount per qualified sale exceeds its source limit.",
  PROVIDER_ACCOUNT_UNVERIFIED: "The exact affiliate provider account is unverified.",
  PROVIDER_PAYOUT_OWNER_MISMATCH: "The payout owner does not match this provider route.",
  PROVIDER_ATTRIBUTION_OWNER_MISMATCH: "The attribution owner does not match this provider route.",
  SOCIAL_CAT_AFFILIATE_SOURCE_UNVERIFIED: "The Social Cat affiliate source is unverified.",
  PRODUCT_AND_SHIPPING_REQUIRED: "Product and shipping terms are required.",
  SAMPLE_POLICY_HELD: "The separate sample policy gates are held.",
  CLAIM_POLICY_UNVERIFIED: "The claims policy is unverified.",
  DISCLOSURE_POLICY_UNVERIFIED: "The disclosure policy is unverified.",
  PRICE_BUNDLE_UNAVAILABLE: "The exact source price bundle is unavailable.",
  PERFORMANCE_REWARD_VERSION_MISMATCH: "The proposed reward version does not match.",
  PERFORMANCE_REWARD_PROPOSED: "The reward programme is proposed, not adopted.",
  PERFORMANCE_REWARD_PROGRAMME_PAUSED: "The reward programme is paused for new acquisition.",
  PERFORMANCE_REWARD_UNVERIFIED: "The reward programme is unverified.",
  PERFORMANCE_REWARD_NOT_EFFECTIVE: "The reward programme is not currently effective.",
  PERFORMANCE_REWARD_SOURCE_HELD: "Current reward source evidence is held.",
  CREATOR_FEE_REQUEST: "A creator fee request needs a verified source resolution.",
  CREATOR_SUPPRESSED: "The creator is suppressed from this commercial action.",
  SUPPRESSION_UNVERIFIED: "Current creator suppression state is unverified.",
  CURRENT_INVITATION_SCORECARD_REQUIRED: "A current invitation assessment is required.",
  OFFER_ECONOMICS_HELD: "The offer economics need review.",
  SOURCE_ACCEPTANCE_REQUIRED: "This phase requires source-confirmed acceptance.",
  OFFER_SOURCE_FENCE_UNAVAILABLE: "Current offer source authority cannot be verified.",
  OFFER_SOURCE_EXPIRED: "The offer source evidence expired.",
  UPFRONT_FEE_PROHIBITED: "New upfront content fees are not permitted.",
  GUARANTEED_FEE_PROHIBITED: "New guaranteed content fees are not permitted.",
  PAID_COMPONENT_PROHIBITED: "A new paid acquisition component is not permitted.",
  PAID_OR_HYBRID_PROHIBITED: "New paid or hybrid acquisition is not permitted.",
  GIFTED_ONLY_PROHIBITED: "New gifted-only acquisition is not permitted.",
  COMMISSION_REQUIRED: "A valid commission term is required.",
  COMMISSION_ABOVE_CAP: "The commission exceeds the current source limit.",
  RELATIONSHIP_NOT_COMMISSION_ONLY: "New acquisition must use commission-only terms.",
  SAMPLE_ABOVE_CAP: "The sample proposal exceeds its separate limit.",
  INVALID_COMMISSION_RATE: "The commission rate is invalid.",
  INVALID_AMOUNT: "A commercial amount is invalid.",
};
export const commercialReasonLabel = (code: CommercialEligibilityReason) => reasons[code];

/** Read-only projection. It never computes policy or treats content qualification as agreement. */
export function CommercialEligibility({ data, compact = false, current = true }: {
  data?: CommercialEligibilityView; compact?: boolean; current?: boolean;
}) {
  const id = useId();
  const Heading = compact ? "h3" : "h2";
  const leaseCurrent = useSourceLease(data?.validity?.validUntil);
  const effectiveCurrent = current && (data?.validity ? leaseCurrent : data?.state !== "eligible");
  const phase = data?.phase ?? "unknown phase";
  const label = !effectiveCurrent ? "Current commercial eligibility unavailable" : !data ? "Commercial eligibility unknown" :
    data.state === "eligible" ? `Commercially eligible for ${phase}` : data.state === "unbound" ? "No exact offer selected" : `Commercial ${phase} held`;
  return <section aria-labelledby={id} className={`${styles.panel} ${compact ? styles.compact : ""}`}>
    <Heading id={id} className={styles.heading}>Commercial eligibility</Heading>
    <Badge tone={effectiveCurrent && data?.state === "eligible" ? "success" : "warning"}>{label}</Badge>
    {!data ? <p>The service has not returned a current exact-offer result.</p> : <>
      <p>{data.selected ? `Saved offer ${data.selected.version ?? "version unknown"}` : "Selection unbound"} · Phase: {phase} · Basis: {data.basisStatus}</p>
      {!effectiveCurrent && <p role="status">The values below are retained read evidence, not current eligibility. Refresh source evidence before reviewing new work.</p>}
      {data.state === "eligible" && !data.validity && <p>Current source timing is unavailable; this older result cannot establish current eligibility.</p>}
      {!!data.reasonCodes.length && <ul className={styles.reasons}>{data.reasonCodes.map(code => <li key={code}>{commercialReasonLabel(code)} <code>{code}</code></li>)}</ul>}
      <details><summary>Exact commercial basis</summary><dl className={styles.basis}>
        {[["Offer", data.selected?.offerRef], ["Offer version", data.selected?.version], ["Policy", data.policyVersion], ["Model", data.modelVersion], ["Configuration", data.configVersion],
          ["Reward basis", data.rewardBasis === "notApplicable" ? "Not applicable" : data.rewardBasis], ["Reward version", data.rewardVersion ?? (data.rewardBasis === "notApplicable" ? "Not applicable" : null)], ["Verified at",data.validity?.observedAt],["Valid until",data.validity?.validUntil],["Basis hash", data.basisHash]]
          .map(([name,value]) => <div key={name}><dt>{name}</dt><dd>{value ?? "Unknown"}</dd></div>)}
      </dl></details>
    </>}
    <p className={styles.note}>This check grants no approval and performs no source action. Saved content qualification and historical obligations remain separate.</p>
  </section>;
}

export function CommercialItemEligibility({ applicability, data, current = true }: {
  applicability?: "required" | "notApplicable"; data?: CommercialEligibilityView; current?: boolean;
}) {
  if (applicability === "notApplicable") return <p className={styles.note}>Commercial acquisition checks: not applicable to this recorded item.</p>;
  if (applicability === undefined) return <p className={styles.note}>Commercial applicability unknown. This older projection does not establish a current acquisition check.</p>;
  return <CommercialEligibility data={data} compact current={current}/>;
}
