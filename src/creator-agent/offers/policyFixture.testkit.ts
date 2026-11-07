import { AgentStore } from "../store.ts";
import { digest } from "../config.ts";
import { commercialPolicyFixture, commercialSourceFixture, syntheticCommercialScope } from "../commercialPolicy/fixtures.testkit.ts";
import { costKeys, newOfferTerms, type AssessmentBasis } from "./contract.ts";
import { OfferRepository, type OfferAuthority } from "./repository.ts";
import { type OfferReply } from "./policy.ts";

/** Fictional scoped source/cache and actual SQLite, without provider actions or commercial adoption. */
export function offerPolicyFixture(databasePath=":memory:",scope=syntheticCommercialScope) {
  let now = Date.parse("2026-11-07T00:00:00Z");
  const source=commercialSourceFixture(commercialPolicyFixture(scope,now));
  const store=new AgentStore(databasePath,{workspaceId:scope.workspaceId,accountId:scope.accountId});
  const terms=newOfferTerms("synthetic-creator","website","synthetic-brief");
  terms.rewardVersion=null;terms.programRef="synthetic-program";terms.recruitmentSource="Social Cat";terms.publishingNetwork="Instagram";
  terms.expiresAt=new Date(now+3600000).toISOString();terms.commission.effectiveAt=new Date(now-1000).toISOString();
  terms.manifest={...terms.manifest,campaignRef:"synthetic-campaign",productRef:"synthetic-product",productRevision:"synthetic-product-v1",claimsRefs:["claims"],guidanceRefs:["guide"],contactRoute:"synthetic-inbox"};
  terms.sample={requested:true,seededCreators:2,unitsPerCreator:1,merchandiseCapMinor:1600,shippingCapMinor:600};
  for(const key of costKeys)terms.costs[key]={minor:({landedUnit:1000,fulfillmentPerOrder:500,providerFeePerOrder:100,returnDefectPerOrder:50,samplePostagePerCreator:500,recruitment:0,advertising:0,earnedRewards:0,commissionAlreadyPaid:0})[key],sourceRef:`synthetic-cost-${key}`};
  terms.base={...terms.base,orders:20};terms.downside={...terms.base,orders:10};
  let basis:AssessmentBasis|null=null,suppressed=false,sourceCurrent=true;
  const replies=new Map<string,OfferReply>();
  const decisions=new Map<string,unknown>();
  const auth:OfferAuthority={commercialPolicy:source.source,assessment:()=>basis,provider:t=>({scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},creatorId:t.creatorId,provider:t.provider,programRef:t.programRef,
    sourceRef:"synthetic-provider",validUntil:terms.expiresAt,facts:{sourceRef:"synthetic-provider",observedAt:new Date(now-1000).toISOString(),validUntil:terms.expiresAt,provider:t.provider,programRef:t.programRef,
      providerAccountRef:"synthetic-provider-account",supportsPercentage:true,supportsFixedPerSale:t.provider==="external-affiliate",actualCommission:t.commission,payoutOwner:"synthetic-payout-owner",trackingOwner:"synthetic-attribution-owner",recruitment:{source:"social-cat",campaignRef:"synthetic-campaign",campaignVersion:"v1",collaboration:"affiliate",sourceRef:"synthetic-campaign-source",observedAt:new Date(now-1000).toISOString(),validUntil:terms.expiresAt},attributionWindowDays:30,precedence:"synthetic-precedence",conflictRule:"synthetic-rule",holdDays:30,payoutSchedule:"synthetic-schedule",payoutThresholdMinor:0,onboarding:"synthetic-onboarding",feeTreatment:"synthetic-fees",fundingRule:"synthetic-funding",refundRule:"synthetic-refunds"}}),
    cost:ref=>{const key=costKeys.find(key=>terms.costs[key].sourceRef===ref)!;return {scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},creatorId:terms.creatorId,provider:terms.provider,programRef:terms.programRef,sourceRef:ref,
      validUntil:terms.expiresAt,costKey:key,minor:terms.costs[key].minor,currency:"USD",productRef:terms.manifest.productRef,productRevision:terms.manifest.productRevision};},
    suppression:()=>({scope,creatorId:terms.creatorId,sourceRef:"synthetic-suppression",sourceVersion:suppressed?"v2":"v1",state:suppressed?"suppressed":"clear",observedAt:new Date(now-1000).toISOString(),validUntil:terms.expiresAt}),
    assertCurrent:proof=>{if(!sourceCurrent || digest(proof.assessment)!==digest(basis) || proof.suppression?.state!==(suppressed?"suppressed":"clear"))throw new Error("Synthetic source changed");},
    reply:ref=>replies.get(ref),assertReplyCurrent:proof=>{if(!sourceCurrent || digest(replies.get(proof.sourceRef))!==digest(proof))throw new Error("Synthetic reply changed");},decision:ref=>decisions.get(ref)};
  const repo=new OfferRepository(store.database,{workspaceId:scope.workspaceId,accountId:scope.accountId},auth,{now:()=>now});
  function save(offerId="synthetic-offer",t=terms,key="synthetic-save") {
    const saved=repo.saveFromAdapter(offerId,null,t,key);
    basis={creatorId:t.creatorId,route:t.checkoutRoute,modelId:"WEBSITE-AFFILIATE-v3",configHash:"synthetic-model-version",policyVersion:"synthetic-score-policy",termsRevision:saved.manifestHash,stale:false,state:"prospectiveInviteEligible",runId:"synthetic-assessment"};
    return repo.readOffer(offerId)!;
  }
  function reply(record=repo.readOffer("synthetic-offer")!,over:Partial<OfferReply>={}) {
    const value:OfferReply={scope,sourceRef:"synthetic-fee-reply",sourceVersion:"v1",eventRef:"synthetic-event",creatorId:terms.creatorId,provider:terms.provider,providerAccountRef:"synthetic-provider-account",programRef:terms.programRef!,offerId:record.offerId,offerVersion:record.version,
      manifestHash:record.manifestHash,occurredAt:new Date(now).toISOString(),observedAt:new Date(now).toISOString(),validUntil:terms.expiresAt!,contentHash:"c".repeat(64),classification:"fee-request",reason:"Source requested a content fee",excerpt:"Fictional fee request",resolvesSourceRefs:[],acceptanceRef:null,...over};
    replies.set(value.sourceRef,value);return value;
  }
  return {repo,store,terms,source,auth,save,reply,replies,decisions,now:()=>now,advance:(ms:number)=>{now+=ms;},suppress:()=>{suppressed=true;},revoke:()=>{sourceCurrent=false;}};
}
