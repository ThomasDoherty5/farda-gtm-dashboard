// @vitest-environment node
import { expect, it } from "vitest";
import { digest, loadApprovedBindings } from "./config.ts";
import { costKeys, newOfferTerms } from "./offers/contract.ts";
import { OfferRepository, type OfferAuthority } from "./offers/repository.ts";
import { commercialPolicyFixture, commercialSourceFixture } from "./commercialPolicy/fixtures.testkit.ts";
import { assessCreator } from "./policy.ts";
import { resolveScorecardEvidence } from "./routeEvidence.ts";
import { AgentStore } from "./store.ts";
import { syntheticPacket, syntheticSourceSnapshot, SYNTHETIC_SCOPE, withActivationEvidence } from "./testFixtures.ts";

it("uses one immutable offer through reviewed invitation, actual acceptance and activation reassessment", async () => {
  const scope = {workspaceId:SYNTHETIC_SCOPE.workspaceId,accountId:SYNTHETIC_SCOPE.accountIds[0]!};
  const store = new AgentStore(":memory:",scope);
  try {
    const packet = withActivationEvidence(syntheticPacket());
    const t = newOfferTerms(packet.creatorId,"website",packet.briefId);
    t.provider="external-affiliate"; t.programRef="fixture-program"; t.expiresAt="2098-01-01T00:00:00Z";
    t.recruitmentSource="manual";t.publishingNetwork="Instagram";t.rewardVersion=null;
    t.commission.effectiveAt="2020-01-01T00:00:00Z"; t.base.orders=4; t.downside.orders=2;
    t.manifest={...t.manifest,campaignRef:"fixture-campaign",productRef:"fixture-product",productRevision:"v1",
      claimsRefs:["fixture-claims"],guidanceRefs:["fixture-guide"],contactRoute:"fixture-program"};
    for (const key of costKeys) t.costs[key]={minor:100,sourceRef:`fixture:${key}`};
    const trust={scope,creatorId:t.creatorId,provider:t.provider,programRef:t.programRef,validUntil:t.expiresAt};
    const commercialScope={...scope,environment:"sandbox" as const};
    const policy=commercialPolicyFixture(commercialScope,Date.now());
    policy.claimsRefs=["fixture-claims"];policy.disclosureRefs=["fixture-guide"];
    policy.routes=[{...policy.routes[0]!,recruitmentSource:"manual",publishingNetwork:"instagram",provider:"external-affiliate",
      providerAccountRef:"fixture-native-account",payoutOwnerRef:"owner",attributionOwnerRef:"provider",productAndShippingRequired:false}];
    const commercial=commercialSourceFixture(policy),decisions=new Map<string,Record<string,unknown>>();
    const authority:OfferAuthority={
      commercialPolicy:commercial.source,
      assessment: id => {
        const r=store.latest(id);if (!r) return null;
        return {runId:r.runId,creatorId:id,route:r.packet.checkoutRoute,modelId:r.assessment.modelId,configHash:r.assessment.config.hash,
          policyVersion:r.assessment.policyVersion,termsRevision:r.packet.termsRevision,stale:false,state:r.assessment.state};
      },
      provider: () => ({...trust,sourceRef:"fixture-provider",facts:{
        sourceRef:"fixture-provider",observedAt:"2020-02-01T00:00:00Z",validUntil:t.expiresAt,provider:t.provider,programRef:t.programRef,
        providerAccountRef:"fixture-native-account",supportsPercentage:true,supportsFixedPerSale:false,actualCommission:t.commission,payoutOwner:"owner",trackingOwner:"provider",
        attributionWindowDays:30,precedence:"fixture-code", conflictRule:"fixture-last-click",holdDays:30,payoutSchedule:"monthly",
        payoutThresholdMinor:100,onboarding:"complete",feeTreatment:"per-order",fundingRule:"none",refundRule:"reverse refunded credit",
      }}),
      cost: (sourceRef) => {
        const key=costKeys.find(k=>t.costs[k].sourceRef===sourceRef)!;
        return {...trust,sourceRef,costKey:key,minor:t.costs[key].minor,currency:"USD",productRef:t.manifest.productRef,productRevision:t.manifest.productRevision};
      },decision:ref=>decisions.get(ref),
      suppression:()=>({scope:commercialScope,creatorId:t.creatorId,sourceRef:"fixture-suppression",sourceVersion:"v1",
        state:"clear",observedAt:"2020-01-01T00:00:00Z",validUntil:t.expiresAt}),
    };
    authority.assertCurrent=fence=>{
      const provider=authority.provider!(t,scope) as {facts:unknown};
      if(digest(fence.assessment)!==digest(authority.assessment!(t.creatorId)) || digest(fence.provider)!==digest(provider.facts) ||
        digest(fence.suppression)!==digest(authority.suppression!(t.creatorId,commercialScope)) || fence.decisionRefs.some(ref=>!decisions.has(ref)))
        throw new Error("Fictional source changed");
    };
    const offers=new OfferRepository(store.database,scope,authority);
    const draft=offers.saveFromAdapter("fixture-offer",null,t,"draft");
    expect(draft.blockers).toEqual([]);
    expect(draft.assessmentCurrent).toBe(false);
    packet.termsRevision=draft.manifestHash;
    packet.ratings={routine:4,demo:4};
    packet.criterionRatings={verifiedCommerce:4,audienceAlignment:4,reliability:4,offerEconomics:4};
    packet.criterionEvidenceRefs=Object.fromEntries(Object.keys(packet.criterionRatings).map(id=>[id,[`synthetic:criterion-proof:${id}`]]));
    const s=syntheticSourceSnapshot(packet,packet.criterionRatings);
    Object.assign(s.terms!,{origin:"saved-offer",offerId:draft.offerId,version:draft.version,manifestHash:draft.manifestHash,
      eligibleBase:t.commission.base,acceptedRef:"fixture-creator-decision"});
    const config=loadApprovedBindings().find(b=>b.current.modelId==="WEBSITE-AFFILIATE-v3")!;
    const assess=async ()=>{
      const proof=await resolveScorecardEvidence({resolve:()=>s},scope,packet,Date.now(),id=>offers.acceptedTerms(id));
      return assessCreator(packet,config,proof);
    };
    const provisional=await assess();
    expect(provisional.state).toBe("prospectiveInviteEligible");
    store.save(packet,provisional,0,"reviewed-before-acceptance");
    expect(offers.readOffer(draft.offerId)?.assessmentCurrent).toBe(true);
    for(const [kind,sourceRef] of [["owner-approved","fixture-owner-decision"],["creator-accepted","fixture-creator-decision"]] as const){
      decisions.set(sourceRef,{...trust,providerAccountRef:"fixture-native-account",offerId:draft.offerId,version:draft.version,manifestHash:draft.manifestHash,decision:kind,sourceRef,occurredAt:new Date().toISOString()});
      offers.decision(draft.offerId,{kind,sourceRef,version:draft.version},sourceRef);
    }
    const active=await assess();
    expect(active).toMatchObject({state:"activationReady",score:{total:80},termsRevision:draft.manifestHash});
    const saved=store.save(packet,active,1,"reviewed-after-acceptance");
    expect(offers.readOffer(draft.offerId)).toMatchObject({version:draft.version,assessmentCurrent:true,assessment:{runId:saved.runId},state:"accepted"});
    const revised=offers.saveFromAdapter(draft.offerId,draft.version,{...t,manifest:{...t.manifest,briefVersion:"v2"}},"material-edit");
    expect(revised.manifestHash).not.toBe(draft.manifestHash);
    expect(offers.matchesOfferVersion(draft.offerId,draft.version,draft.manifestHash)).toBe(false);
    expect((await assess()).state).toBe("prospectiveInviteEligible");
  } finally { store.close(); }
});
