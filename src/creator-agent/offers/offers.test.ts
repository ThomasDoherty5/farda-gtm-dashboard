// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "../store";
import { type AssessmentBasis, BUNDLES, costKeys, newOfferTerms, offerTermsSchema, type OfferScope, type OfferTerms } from "./contract";
import { offerInputHash } from "./job";
import { offerScenario } from "./economics";
import { OfferRepository, type OfferAuthority } from "./repository";
import { handleOfferRoute } from "./routes";
import { projectRewards, type RewardSource } from "./rewards";

const scope:OfferScope={workspaceId:"fictional-workspace",accountId:"fictional-account"};
const tmp:string[]=[];
afterEach(()=>{for(const p of tmp.splice(0))rmSync(p,{recursive:true,force:true});});
function proposal() {
  const t=newOfferTerms("creator-example","website","brief-test");
  t.programRef="program-example";t.recruitmentSource="Social Cat";t.publishingNetwork="Instagram";t.expiresAt="2098-02-01T00:00:00Z";
  t.commission.effectiveAt="2020-01-01T00:00:00Z";
  t.manifest={...t.manifest,campaignRef:"campaign-example",productRef:"bottle",productRevision:"r1",guidanceRefs:["guide"],claimsRefs:["claims"],contactRoute:"program inbox"};
  t.sample={requested:true,seededCreators:2,unitsPerCreator:1,merchandiseCapMinor:1600,shippingCapMinor:600};
  for(const key of costKeys)t.costs[key]={minor:({landedUnit:1200,fulfillmentPerOrder:599,providerFeePerOrder:100,returnDefectPerOrder:50,
    samplePostagePerCreator:500,recruitment:900,advertising:1000,earnedRewards:0,commissionAlreadyPaid:900})[key],sourceRef:`source-${key}`};
  t.base={...t.base,orders:10};
  t.downside={...t.base,orders:7,refundPerOrderMinor:100};
  return t;
}
function eligibleBasis(t:OfferTerms,termsRevision:string,state:AssessmentBasis["state"]="prospectiveInviteEligible",runId="run-two"):AssessmentBasis {
  return {creatorId:t.creatorId,route:t.checkoutRoute,modelId:t.checkoutRoute==="website"?"WEBSITE-AFFILIATE-v3":"TIKTOK-SHOP-AFFILIATE-v3",
    configHash:"bound-config",policyVersion:"2026-11-04",termsRevision,state,runId,stale:false};
}
function provider(t:OfferTerms) {
  return {scope,creatorId:t.creatorId,provider:t.provider,programRef:t.programRef,sourceRef:"program-source",validUntil:"2099-01-01T00:00:00Z",facts:{
    provider:t.provider,programRef:t.programRef,sourceRef:"program-source",observedAt:"2020-01-01T00:00:00Z",validUntil:"2099-01-01T00:00:00Z",
    supportsPercentage:true,supportsFixedPerSale:false,actualCommission:t.commission,payoutOwner:"native billing",trackingOwner:"provider",
    attributionWindowDays:30,precedence:"code before link",conflictRule:"eligible last click",holdDays:30,payoutSchedule:"matured next cycle",payoutThresholdMinor:1000,
    onboarding:"granted",feeTreatment:"per order quote",refundRule:"line-level retained merchandise",fundingRule:"verified reimbursements only"}};
}
function authority(t:OfferTerms):OfferAuthority {
  return {provider,cost:(ref:string)=>{const key=costKeys.find(k=>t.costs[k].sourceRef===ref)!;return {scope,creatorId:t.creatorId,provider:t.provider,programRef:t.programRef,
    sourceRef:ref,validUntil:"2099-01-01T00:00:00Z",costKey:key,minor:t.costs[key].minor,currency:"USD",productRef:t.manifest.productRef,productRevision:t.manifest.productRevision};}};
}
const route=(repo:OfferRepository,body:unknown,over:Partial<Parameters<typeof handleOfferRoute>[0]>={})=>handleOfferRoute({method:"POST",path:"/v1/offers/offer-a",role:"reviewer",idempotencyKey:"request-1",body,...over},repo);
describe("immutable scoped offer proposals and forecasts",()=>{
  it("separates delivered price, cost scenarios, paid cash and reserve from earned liability",()=>{
    expect(BUNDLES.map(b=>b.merchandiseMinor+b.shippingMinor)).toEqual([4098,6197,8997]);
    const t=proposal(), base=offerScenario(t,"base");
    // 10 × ($34.99 + $5.99 − $12 − $5.99 − $1 − $.50 − $7) less $53 fixed costs and $17.50 reserve.
    expect(base).toMatchObject({merchandiseMinor:34990,shippingRevenueMinor:5990,commissionMinor:7000,sampleMinor:3400,fixedCostsMinor:5300,contributionMinor:7440,breakEvenOrders:5});
    t.costs.landedUnit.minor=1500;
    expect(offerScenario(t,"base").contributionMinor).toBe(3840);
    t.costs.commissionAlreadyPaid.minor=0;expect(offerScenario(t,"base").contributionMinor).toBe(3840);
    t.costs.earnedRewards.minor=2000;expect(offerScenario(t,"base").contributionMinor).toBe(3590);
    t.downside={...t.base,orders:0};expect(offerScenario(t,"downside")).toMatchObject({zeroSaleSeededCreatorsMinimum:2,contributionMinor:-7900});
    t.base.sellerDiscountMinor=1500;expect(offerScenario(t,"base").contributionMinor).toBeLessThan(0);
  });
  it("processes a reviewer-authorized J03 proposal envelope once and binds it to scope, input and deadline",()=>{
    const store=new AgentStore(":memory:",scope),repo=new OfferRepository(store.database,scope);
    const terms=proposal(), key="job-test", envelope={jobId:"J03",jobVersion:"creator-offer.v1",mode:"propose",actor:{id:"agent-reviewer",role:"reviewer"},
      accountRef:scope,policyVersion:"commission-only-v1",inputHash:offerInputHash("offer-a",null,terms),idempotencyKey:key,correlationId:"job-trace",
      requestedAt:"2020-01-01T00:00:00Z",deadline:null,checkpoint:null};
    const post=(e:typeof envelope)=>route(repo,{envelope:e,terms,expectedVersion:null},{path:"/v1/offers/offer-a/proposals",idempotencyKey:key});
    expect(post({...envelope,accountRef:{...scope,workspaceId:"other"}})?.status).toBe(409);
    expect(post({...envelope,mode:"executeApproved"})?.status).toBe(422);
    expect(post({...envelope,inputHash:"0".repeat(64)})?.status).toBe(409);
    const result=post(envelope);
    expect(result).toMatchObject({status:200,body:{draftOfferRef:"offer-a",offerVersion:"v1",envelope:{correlationId:"job-trace"},economicsScenarios:expect.any(Array),
      proposedManifest:{creatorId:"creator-example"},missingInputs:expect.arrayContaining(["Provider terms and program entitlement unverified"]),
      componentOwners:expect.arrayContaining([{component:"approval",owner:"J04"}]),sourceEffects:"none",reserved:false,submitted:false,funded:false,activated:false}});
    expect(post(envelope)).toEqual(result);
    expect(handleOfferRoute({method:"GET",path:"/v1/offers/offer-a/proposals?correlationId=job-trace",role:"reader"},repo)).toEqual(result);
    const second={...envelope,idempotencyKey:"expired",deadline:"2020-01-02T00:00:00Z"};
    expect(route(repo,{envelope:second,terms,expectedVersion:null},{path:"/v1/offers/offer-a/proposals",idempotencyKey:"expired"})).toMatchObject({status:409,body:{code:"JOB_OUTSIDE_EXECUTION_WINDOW"}});
    store.close();
  });
  it("keeps platform funding, partial line refunds, native standard and Shop Ads rate distinct",()=>{
    const t=proposal();t.checkoutRoute="tiktok-shop";t.provider="tiktok-shop";t.base={...t.base,bundle:"duo",orders:3,shopAdsOrders:1,sellerDiscountMinor:100,refundPerOrderMinor:200,platformCouponMinor:300,fundedCouponMinor:null};
    expect(offerScenario(t,"base")).toMatchObject({commissionMinor:null,contributionMinor:null,missing:expect.arrayContaining(["platformCouponFunding","shopAdsRate"])});
    t.base.fundedCouponMinor=300;t.commission.shopAdsRateBps=500;
    expect(offerScenario(t,"base")).toMatchObject({merchandiseMinor:15894,commissionMinor:2385});
    expect(offerTermsSchema.safeParse({...t,offerCodeAddsDiscount:true}).success).toBe(false);
    expect(offerTermsSchema.safeParse({...t,base:{...t.base,refundPerOrderMinor:5598}}).success).toBe(false);
    expect(offerTermsSchema.safeParse({...t,manifest:{...t.manifest,claims:["proof-of-ingestion"]}}).success).toBe(false);
  });
  it("preserves proposals over restart, rejects fees, conflicts and unauthorized source decisions",()=>{
    const dir=mkdtempSync(join(tmpdir(),"offer-test-"));tmp.push(dir);
    const path=join(dir,"agent.sqlite"),t=proposal();let db=new AgentStore(path,scope),repo=new OfferRepository(db.database,scope);
    expect(route(repo,{expectedVersion:null,terms:t},{role:"reader"})?.status).toBe(403);
    for(const invalid of [{relationship:"paid-hybrid"},{guaranteedFeeMinor:25000},{upfrontFeeMinor:25},{paidComponent:10}])
      expect(route(repo,{expectedVersion:null,terms:{...t,...invalid}})?.status).toBe(422);
    const receipt=repo.saveFromAdapter("offer-a",null,t,"k1");
    expect(receipt).toMatchObject({version:"v1",state:"proposed",assessment:null,provider:null,blockers:expect.arrayContaining(["Provider terms and program entitlement unverified"])});
    db.close();db=new AgentStore(path,scope);repo=new OfferRepository(db.database,scope);
    expect(repo.saveFromAdapter("offer-a",null,t,"k1")).toEqual(receipt);
    expect(()=>repo.saveFromAdapter("offer-a",null,{...t,counterofferRef:"reply"},"k1")).toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(()=>repo.saveFromAdapter("offer-a","v0",t,"k2")).toThrow("VERSION_CONFLICT");
    expect(route(repo,{version:"v1",kind:"creator-accepted",sourceRef:"user-supplied"},{path:"/v1/offers/offer-a/decisions",idempotencyKey:"fake"})?.status).toBe(503);
    const v2=repo.saveFromAdapter("offer-a","v1",{...t,counterofferRef:"reply",historicalObligationRefs:["legacy-payable"]},"k3");
    expect(v2.state).toBe("proposed");expect(v2.manifestHash).not.toBe(receipt.manifestHash);expect(repo.readOffer("offer-a",1)).toEqual(receipt);
    expect(repo.readRewards("offer-a")).toMatchObject({status:"unobserved",maturedMinor:null,earnedMinor:null});
    expect(repo.onboarding("offer-a")).toBeNull();db.close();
  });
  it("allows exact owner and creator receipts, invalidates material terms and preserves prior obligations",()=>{
    const db=new AgentStore(":memory:",scope),t=proposal(),auth=authority(t),repo=new OfferRepository(db.database,scope,auth);
    const v1=repo.saveFromAdapter("offer-a",null,t,"k1");expect(v1.blockers).toEqual([]);
    const decision=(kind:"owner-approved"|"creator-accepted",sourceRef:string)=>{
      auth.decision=()=>({scope,creatorId:t.creatorId,provider:t.provider,programRef:t.programRef,sourceRef,offerId:"offer-a",version:"v1",
        manifestHash:v1.manifestHash,decision:kind,occurredAt:new Date().toISOString(),validUntil:"2099-01-01T00:00:00Z"});
      return repo.decision("offer-a",{version:"v1",kind,sourceRef},sourceRef);
    };
    expect(()=>decision("owner-approved","unscored")).toThrow("CURRENT_INVITATION_SCORECARD_REQUIRED");
    auth.assessment=()=>eligibleBasis(t,v1.manifestHash,"hold");
    expect(()=>decision("owner-approved","held")).toThrow("CURRENT_INVITATION_SCORECARD_REQUIRED");
    auth.assessment=()=>({...eligibleBasis(t,v1.manifestHash),stale:true});
    expect(()=>decision("owner-approved","stale")).toThrow("CURRENT_INVITATION_SCORECARD_REQUIRED");
    auth.assessment=()=>eligibleBasis(t,v1.manifestHash);
    expect(()=>decision("creator-accepted","premature")).toThrow("OWNER_APPROVAL_REQUIRED");
    expect(decision("owner-approved","founder").state).toBe("approved");expect(decision("creator-accepted","native").state).toBe("accepted");
    expect(repo.onboarding("offer-a")).toMatchObject({handoffs:["J07","J15"],postingObligations:[],dispatched:false});
    auth.assessment=()=>eligibleBasis(t,v1.manifestHash,"activationReady","run-three");
    expect(repo.saveFromAdapter("offer-a","v1",t,"same")).toMatchObject({version:"v1",state:"accepted",assessmentCurrent:true,assessment:{runId:"run-three"}});
    expect(repo.acceptedTerms("offer-a")).toMatchObject({version:"v1",acceptedRef:"native"});
    const revised=repo.saveFromAdapter("offer-a","v1",{...t,expiresAt:"2098-03-01T00:00:00Z"},"k2");
    expect(revised.state).toBe("proposed");expect(repo.matchesOfferVersion("offer-a","v1",v1.manifestHash)).toBe(false);
    expect(repo.acceptedTerms("offer-a")).toBeNull();expect(repo.readOffer("offer-a",1)?.acceptedRef).toBe("native");db.close();
  });
  it("holds an unsupported platform subsidy and keeps affiliate acceptance separate from posting consent",()=>{
    const db=new AgentStore(":memory:",scope),t=proposal(),auth=authority(t);
    t.base={...t.base,platformCouponMinor:100,fundedCouponMinor:100,platformFundingRef:"promotion-1"};
    t.manifest.deliverables=[{id:"clip",quantity:1,network:"Instagram",format:"Reel",concept:"Morning routine",dueAt:null,
      deadlineAnchor:null,timezone:null,disclosure:null,cta:null,previewAgreed:null,revisionLimit:null,rights:null}];
    const repo=new OfferRepository(db.database,scope,auth);
    const held=repo.saveFromAdapter("offer-a",null,t,"held");
    expect(held.blockers).toContain("Platform subsidy unverified: base");
    auth.funding=()=>({scope,creatorId:t.creatorId,provider:t.provider,programRef:t.programRef,sourceRef:"promotion-1",
      validUntil:"2099-01-01T00:00:00Z",scenario:"base",bundle:"single",currency:"USD",advertisedDiscountMinor:100,reimbursedMinor:100,feeTreatment:"standard"});
    const v=repo.saveFromAdapter("offer-a",held.version,t,"refresh");expect(v.blockers).toEqual([]);expect(v.manifestHash).not.toBe(held.manifestHash);
    auth.assessment=()=>eligibleBasis(t,v.manifestHash);
    for(const kind of ["owner-approved","creator-accepted"] as const) {
      auth.decision=()=>({scope,creatorId:t.creatorId,provider:t.provider,programRef:t.programRef,sourceRef:kind,offerId:"offer-a",version:v.version,
        manifestHash:v.manifestHash,decision:kind,occurredAt:new Date().toISOString(),validUntil:"2090-01-01T01:00:00+01:00"});
      repo.decision("offer-a",{version:v.version,kind,sourceRef:kind},kind);
    }
    expect(repo.onboarding("offer-a")).toMatchObject({postingObligations:[],accepted:{validUntil:"2090-01-01T00:00:00.000Z"}});
    db.close();
  });
  it("does not trust wrong-account facts, incompatible fixed commissions, Social Cat omissions or unfounded bundle claims",()=>{
    const store=new AgentStore(":memory:",scope), t=proposal();t.sample={requested:false,seededCreators:0,unitsPerCreator:0,shippingCapMinor:null,merchandiseCapMinor:null};
    t.commission={...t.commission,type:"fixed-per-sale",fixedMinor:299,standardRateBps:null};t.manifest.claims=["separate-routines"];
    const repo=new OfferRepository(store.database,scope,{provider:terms=>({...provider(terms),scope:{...scope,accountId:"other"}})});
    expect(repo.saveFromAdapter("offer-a",null,t,"k").blockers).toEqual(expect.arrayContaining([
      "Provider terms and program entitlement unverified","Fixed-per-sale requires a verified compatible external provider",
      "Social Cat Affiliate needs product and shipping allocation bounds","Multipack use must specify one medication product per vial"]));
    store.close();
  });
});
function reward():RewardSource{
  const line={lineRef:"line",eligible:true,merchandiseMinor:620000,sellerDiscountMinor:0,platformDiscountMinor:0,reimbursedMinor:0,refundedMinor:1000};
  const order={canonicalId:"canonical-order",nativeId:"native-order",source:"website" as const,revision:1,status:"matured" as const,lines:[line]};
  return {scope,creatorId:"creator-example",sourceRef:"reward-source-1",observedAt:"2020-01-02T00:00:00Z",coveredRoutes:["website","tiktok-shop"],
    orders:[order,{...order,source:"mirror",nativeId:"mirror-native"}, {...order,canonicalId:"pending",nativeId:"pending-native",status:"pending"}],
    paused:false,commissionMinor:123800,costsExcludingRewardsAndCommissionMinor:200000,awards:[{tier:"tech",earnedRef:"award",redemptionRef:null,redeemedMinor:null,selection:null}]};
}
it("keeps canonical orders, late refunds, repeated claims, delayed redemption and incurred liability independent",()=>{
  const db=new AgentStore(":memory:",scope),src=reward(),repo=new OfferRepository(db.database,scope,{reward:()=>src});
  repo.saveFromAdapter("offer-a",null,proposal(),"offer");
  const r=repo.recordReward("offer-a",src.sourceRef,"r1");expect(r).toMatchObject({maturedMinor:619000,pendingMinor:619000,refundedMinor:1000,duplicateMirrors:1,earnedMinor:30000,outstandingMinor:30000});
  expect(repo.recordReward("offer-a",src.sourceRef,"r1")).toEqual(r);
  src.sourceRef="reward-2";src.observedAt="2020-02-01T01:00:00+01:00";src.orders[0]!.lines[0]!.refundedMinor=600000;src.paused=true;src.awards=[];
  expect(repo.recordReward("offer-a",src.sourceRef,"r2")).toMatchObject({maturedMinor:20000,earnedMinor:30000,outstandingMinor:30000,paused:true});
  src.observedAt="2019-01-01T00:00:00Z";expect(()=>repo.recordReward("offer-a",src.sourceRef,"stale")).toThrow("STALE_REWARD_SNAPSHOT");
  src.sourceRef="reward-3";src.observedAt="2020-03-01T00:00:00Z";src.awards=[{tier:"tech",earnedRef:"award",redemptionRef:"redeem",redeemedMinor:25000,selection:"earbuds"}];
  expect(repo.recordReward("offer-a",src.sourceRef,"r3")).toMatchObject({redeemedMinor:25000,outstandingMinor:5000});
  src.coveredRoutes=["website"];expect(projectRewards("offer-a",src.creatorId,"v1",src).maturedMinor).toBeNull();
  db.close();
});
