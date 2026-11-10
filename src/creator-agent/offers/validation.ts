import { offerTermsSchema, type OfferTerms } from "./contract.ts";
import { OfferPolicyError } from "./policy.ts";

/** Identify known prohibited compensation without projecting away unknown or malformed fields. */
export function parseOfferTerms(input:unknown):OfferTerms {
  if(input!==null && typeof input==="object" && !Array.isArray(input)) {
    const value=input as Record<string,unknown>,reasons:string[]=[];
    for(const [field,reason] of [["upfrontFeeMinor","UPFRONT_FEE_PROHIBITED"],["guaranteedFeeMinor","GUARANTEED_FEE_PROHIBITED"],["paidComponentMinor","PAID_COMPONENT_PROHIBITED"]])
      if(typeof value[field!]==="number" && Number.isSafeInteger(value[field!]) && Number(value[field!])>0)reasons.push(reason!);
    if(typeof value.relationship==="string" && value.relationship!=="commission-only")reasons.push(
      value.relationship==="gifted" || value.relationship==="gifted-only"?"GIFTED_ONLY_PROHIBITED":
      ["paid","hybrid","paid-hybrid"].includes(value.relationship)?"PAID_OR_HYBRID_PROHIBITED":"RELATIONSHIP_NOT_COMMISSION_ONLY");
    if(reasons.length)throw new OfferPolicyError("POLICY_VIOLATION",{status:422,reasonCodes:[...new Set(reasons)]});
  }
  return offerTermsSchema.parse(input);
}
