// @vitest-environment node
import { expect, it } from "vitest";
import { loadApprovedBindings } from "./config.ts";
import { costKeys, newOfferTerms } from "./offers/contract.ts";
import { OfferRepository } from "./offers/repository.ts";
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
    t.commission.effectiveAt="2020-01-01T00:00:00Z"; t.base.orders=4; t.downside.orders=2;
    t.manifest={...t.manifest,campaignRef:"fixture-campaign",productRef:"fixture-product",productRevision:"v1",
      claimsRefs:["fixture-claims"],guidanceRefs:["fixture-guide"],contactRoute:"fixture-program"};
    for (const key of costKeys) t.costs[key]={minor:100,sourceRef:`fixture:${key}`};
    const trust={scope,creatorId:t.creatorId,provider:t.provider,programRef:t.programRef,validUntil:t.expiresAt};
    let decision:Record<string,unknown>|null=null;
    const offers=new OfferRepository(store.database,scope,{
      assessment: id => {
        const r=store.latest(id);if (!r) return null;
        return {runId:r.runId,creatorId:id,route:r.packet.checkoutRoute,modelId:r.assessment.modelId,configHash:r.assessment.config.hash,
          policyVersion:r.assessment.policyVersion,termsRevision:r.packet.termsRevision,stale:false,state:r.assessment.state};
      },
      provider: () => ({...trust,sourceRef:"fixture-provider",facts:{
        sourceRef:"fixture-provider",observedAt:"2020-02-01T00:00:00Z",validUntil:t.expiresAt,provider:t.provider,programRef:t.programRef,
        supportsPercentage:true,supportsFixedPerSale:false,actualCommission:t.commission,payoutOwner:"owner",trackingOwner:"provider",
        attributionWindowDays:30,precedence:"fixture-code", conflictRule:"fixture-last-click",holdDays:30,payoutSchedule:"monthly",
        payoutThresholdMinor:100,onboarding:"complete",feeTreatment:"per-order",fundingRule:"none",refundRule:"reverse refunded credit",
      }}),
      cost: (sourceRef) => {
        const key=costKeys.find(k=>t.costs[k].sourceRef===sourceRef)!;
        return {...trust,sourceRef,costKey:key,minor:t.costs[key].minor,currency:"USD",productRef:t.manifest.productRef,productRevision:t.manifest.productRevision};
      },decision:()=>decision,
    });
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
      decision={...trust,offerId:draft.offerId,version:draft.version,manifestHash:draft.manifestHash,decision:kind,sourceRef,occurredAt:new Date().toISOString()};
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
