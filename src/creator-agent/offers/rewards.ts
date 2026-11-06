import { z } from "zod";
import { TIERS, scopeSchema, type RewardRecord } from "./contract.ts";
const id=z.string().trim().min(1).max(180), minor=z.number().int().nonnegative().max(100_000_000), instant=z.string().datetime({offset:true});
const order=z.object({canonicalId:id,nativeId:id,source:z.enum(["website","tiktok-shop","mirror"]),revision:z.number().int().positive(),
  status:z.enum(["matured","pending","excluded"]),lines:z.array(z.object({lineRef:id,eligible:z.boolean(),merchandiseMinor:minor,sellerDiscountMinor:minor,
    platformDiscountMinor:minor,reimbursedMinor:minor.nullable(),refundedMinor:minor}).strict()).min(1).max(50)}).strict();
export const rewardSourceSchema=z.object({scope:scopeSchema,creatorId:id,sourceRef:id,observedAt:instant,coveredRoutes:z.array(z.enum(["website","tiktok-shop"])).max(2),
  orders:z.array(order).max(10000), paused:z.boolean(), commissionMinor:minor.nullable(),costsExcludingRewardsAndCommissionMinor:minor.nullable(),
  awards:z.array(z.object({tier:z.enum(["tech","phone","vacation"]),earnedRef:id,selection:id.nullable(),redemptionRef:id.nullable(),redeemedMinor:minor.nullable()}).strict()).max(30),
}).strict();
export type RewardSource=z.infer<typeof rewardSourceSchema>;
export function projectRewards(offerId:string,creatorId:string,version:string,source:RewardSource|null,priorAwards:RewardSource["awards"]=[]):RewardRecord {
  const unknowns:string[]=[], unique=new Map<string,RewardSource["orders"][number]>();
  let mirrors=0,matured=0,pending=0,excluded=0,refunded=0,pendingOrders=0;
  if(!source) unknowns.push("No authorized reward ledger snapshot");
  else if(new Set(source.coveredRoutes).size!==2) unknowns.push("Cross-platform coverage incomplete");
  for(const row of source?.orders??[]) {
    const prior=unique.get(row.canonicalId);
    if(prior) {
      mirrors++;
      if(prior.source!=="mirror" && row.source!=="mirror" && prior.source!==row.source) unknowns.push("Canonical order identity conflicts across native owners");
      if(row.source==="mirror" || prior.source!=="mirror" && prior.revision>row.revision) continue;
      if(prior.source===row.source && prior.revision===row.revision && JSON.stringify(prior)!==JSON.stringify(row))
        unknowns.push("Conflicting order facts at the same revision");
    }
    unique.set(row.canonicalId,row);
  }
  for(const row of unique.values()) {
    if(row.source==="mirror") {unknowns.push("Missing canonical native owner");continue;}
    if(row.status==="pending") pendingOrders++;
    if(new Set(row.lines.map(l=>l.lineRef)).size!==row.lines.length) unknowns.push("Duplicate order line");
    for(const l of row.lines) {
      if(!l.eligible) {excluded+=l.merchandiseMinor;continue;}
      if(l.reimbursedMinor===null && l.platformDiscountMinor) unknowns.push("Unverified platform coupon funding");
      const beforeRefund=l.merchandiseMinor-l.sellerDiscountMinor-l.platformDiscountMinor+(l.reimbursedMinor??0);
      if(beforeRefund<0 || l.refundedMinor>beforeRefund || (l.reimbursedMinor??0)>l.platformDiscountMinor) unknowns.push("Unreconciled line allocation");
      const net=Math.max(0,beforeRefund-l.refundedMinor);
      if(row.status==="matured") {matured+=net;refunded+=l.refundedMinor;} else if(row.status==="pending")pending+=net;else excluded+=net;
    }
  }
  const complete=!!source && !unknowns.length;
  const awards=new Map(priorAwards.map(a=>[a.tier,a]));
  for(const a of source?.awards??[]) {
    const old=awards.get(a.tier);
    if(old && old.earnedRef!==a.earnedRef) throw new Error("CONFLICTING_MILESTONE_RECEIPTS");
    if(old?.redemptionRef && (a.redemptionRef!==old.redemptionRef || a.redeemedMinor!==old.redeemedMinor)) throw new Error("CONFLICTING_REDEMPTION_RECEIPTS");
    if(a.redemptionRef===null && a.redeemedMinor!==null)throw new Error("REDEMPTION_RECEIPT_REQUIRED");
    if ((a.redeemedMinor??0)>TIERS.find(t=>t.id===a.tier)!.additionalMinor) throw new Error("REDEMPTION_EXCEEDS_EARNED");
    awards.set(a.tier,a);
  }
  const tiers=TIERS.map(t=>{const a=awards.get(t.id);return {id:t.id, earned:a?true:complete?false:null,
    redeemedMinor:a?a.redemptionRef?a.redeemedMinor:0:complete?0:null, selection:a?.selection??null};});
  const earned=tiers.some(t=>t.earned===null)?null:TIERS.reduce((n,t)=>n+(awards.has(t.id)?t.additionalMinor:0),0);
  const redeemed=tiers.every(t=>t.redeemedMinor!==null)?tiers.reduce((n,t)=>n+(t.redeemedMinor??0),0):null;
  return {kind:"agent-rewards",offerId,creatorId,version,sourceRef:source?.sourceRef??null,observedAt:source?.observedAt??null,status:source?"observed":"unobserved",
    maturedMinor:complete?matured:null,pendingMinor:complete?pending:null,excludedMinor:complete?excluded:null,refundedMinor:complete?refunded:null,duplicateMirrors:mirrors,pendingOrders:complete?pendingOrders:null,
    commissionMinor:source?.commissionMinor??null, earnedMinor:earned,redeemedMinor:redeemed,outstandingMinor:earned!==null&&redeemed!==null?earned-redeemed:null,
    contributionMinor:complete && source.commissionMinor!==null && source.costsExcludingRewardsAndCommissionMinor!==null && earned!==null ? matured-source.commissionMinor-source.costsExcludingRewardsAndCommissionMinor-earned : null,
    paused:source?.paused??null,tiers,unknowns:[...new Set(unknowns)]};
}
