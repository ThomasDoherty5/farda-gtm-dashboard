// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../store.ts";
import { rewardPolicyFixture, syntheticCommercialScope as scope } from "../commercialPolicy/fixtures.testkit.ts";
import { OfferRepository } from "./repository.ts";
import { offerPolicyFixture } from "./policyFixture.testkit.ts";
import { handleOfferRoute } from "./routes.ts";
import { parseOfferTerms } from "./validation.ts";
import { projectRewards, type RewardSource } from "./rewards.ts";

const stores: AgentStore[] = [];
const directories:string[]=[];
afterEach(() => { for(const store of stores.splice(0))store.close();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true}); });
function setup(databasePath=":memory:") { const fixture=offerPolicyFixture(databasePath);stores.push(fixture.store);return fixture; }
describe("native current commission-only policy",()=>{
  it("permits an invitation before acceptance, but never confers J04 or shipment authority",()=>{
    const h=setup();h.save();const invite=h.repo.resolvePolicyProof("synthetic-offer","invitation");
    expect(invite).toMatchObject({state:"eligible",confersApproval:false,proof:{policyVersion:"commission-only-v1",modelVersion:"synthetic-model-version"}});
    expect(h.repo.readEligibility("synthetic-offer","activation")?.reasonCodes).toContain("SOURCE_ACCEPTANCE_REQUIRED");
    expect(h.repo.onboarding("synthetic-offer")).toBeNull();expect(h.store.database.prepare("SELECT COUNT(*) n FROM offer_decisions").get()?.n).toBe(0);
  });
  it("keeps proposed and missing policy explicit, even with a high score and provider facts",()=>{
    const h=setup();h.source.state.current.state="proposed";h.source.state.current.approvalRef=null;h.save();
    expect(h.repo.readEligibility("synthetic-offer")?.reasonCodes).toContain("COMMERCIAL_POLICY_PROPOSED");
    h.auth.commercialPolicy=undefined;expect(h.repo.readOffer("synthetic-offer")?.commercial?.state).toBe("unknown");
  });
  it("rechecks current policy and source expiry on a receipt replay without changing the immutable offer",()=>{
    const h=setup(),saved=h.save(),proof=h.repo.resolvePolicyProof(saved.offerId,"invitation")!.proof!;
    h.source.state.current.commission.maxRateBps=1500;
    expect(()=>h.repo.assertPolicyProof(proof,h.now())).toThrow("OFFER_POLICY_PROOF_STALE");
    const replay=h.repo.saveFromAdapter(saved.offerId,null,h.terms,"synthetic-save");
    expect(replay.manifestHash).toBe(saved.manifestHash);expect(replay.commercial?.reasonCodes).toContain("COMMISSION_ABOVE_CAP");
    expect(h.repo.readOffer(saved.offerId,1)?.terms.commission.standardRateBps).toBe(2000);
    h.advance(3600001);expect(h.repo.readEligibility(saved.offerId)?.state).toBe("held");
  });
  it("does not issue a current proof if source changes between projection and final source fence",()=>{
    const h=setup();h.save();h.auth.assertCurrent=()=>{h.source.state.current.state="revoked";};
    expect(h.repo.readEligibility("synthetic-offer")?.state).toBe("held");
  });
  it("holds suppression and independent source authority loss at the final fence",()=>{
    const h=setup();h.save();const proof=h.repo.resolvePolicyProof("synthetic-offer","invitation")!.proof!;
    h.suppress();expect(h.repo.readEligibility("synthetic-offer")?.reasonCodes).toContain("CREATOR_SUPPRESSED");
    expect(()=>h.repo.assertPolicyProof(proof,h.now())).toThrow();h.revoke();expect(h.repo.readEligibility("synthetic-offer")?.reasonCodes).toContain("OFFER_SOURCE_FENCE_UNAVAILABLE");
  });
  it("does not let a copied proof cross account or extend source expiry with a stale clock",()=>{
    const h=setup();h.save();const proof=h.repo.resolvePolicyProof("synthetic-offer","invitation")!.proof!;
    expect(()=>h.repo.assertPolicyProof({...proof,scope:{...scope,accountId:"other"}},h.now())).toThrow();
    const before=h.now();h.advance(3600001);expect(()=>h.repo.assertPolicyProof(proof,before)).toThrow();
  });
  it("keeps an unchanged native source lease renewal distinct from a material terms change",()=>{
    const h=setup();const record=h.save(),proof=h.repo.resolvePolicyProof(record.offerId,"invitation")!.proof!;h.advance(10);
    h.source.state.current.observedAt=new Date(h.now()).toISOString();h.source.state.current.validUntil=new Date(h.now()+3600000).toISOString();
    expect(()=>h.repo.assertPolicyProof(proof,h.now())).not.toThrow();
    expect(h.repo.saveFromAdapter(record.offerId,record.version,h.terms,"same-material").version).toBe(record.version);
  });
  it("requires a native Affiliate campaign and exact payout/attribution owners on Social Cat",()=>{
    const h=setup(),provider=h.auth.provider!;h.auth.provider=(terms,owner)=>{
      const original=provider(terms,owner) as {facts:{recruitment:{collaboration:string};payoutOwner:string}};
      original.facts.recruitment.collaboration="gifted";original.facts.payoutOwner="other-owner";return original;
    };
    h.save();expect(h.repo.readEligibility("synthetic-offer")?.reasonCodes).toEqual(expect.arrayContaining(["SOCIAL_CAT_AFFILIATE_SOURCE_UNVERIFIED","PROVIDER_PAYOUT_OWNER_MISMATCH"]));
  });
  it("returns the exact frozen source price catalogue even after current source pricing changes",()=>{
    const h=setup(),record=h.save(),original=structuredClone(h.source.state.current.pricing.bundles);
    expect(record.commercial?.bundles).toEqual(original);
    h.source.state.current.pricing.version="synthetic-pricing-v2";
    h.source.state.current.pricing.bundles[0]!.merchandiseMinor+=100;
    const historical=h.repo.readOffer(record.offerId,record.revision)!;
    expect(historical.commercial?.bundles).toEqual(original);
    expect(historical.scenarios).toEqual(record.scenarios);
    expect(historical.commercial?.reasonCodes).toContain("COMMERCIAL_POLICY_CHANGED");
  });
  it("requires exact native account and a final source fence for new decision receipts",()=>{
    const h=setup(),record=h.save();
    const proof={scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},creatorId:h.terms.creatorId,provider:h.terms.provider,programRef:h.terms.programRef,
      sourceRef:"synthetic-decision",offerId:record.offerId,version:record.version,manifestHash:record.manifestHash,decision:"owner-approved",providerAccountRef:"another-provider-account",
      occurredAt:new Date(h.now()).toISOString(),validUntil:new Date(h.now()+1000).toISOString()};
    h.decisions.set(proof.sourceRef,proof);
    const command={version:record.version,sourceRef:proof.sourceRef,kind:"owner-approved" as const};
    expect(()=>h.repo.decision(record.offerId,command,"wrong-account")).toThrow("EXACT_VERSION_DECISION_UNVERIFIED");
    proof.providerAccountRef="synthetic-provider-account";
    const originalFence=h.auth.assertCurrent!;
    h.auth.assertCurrent=(fence,now)=>{originalFence(fence,now);if(fence.decisionRefs.includes(proof.sourceRef))throw new Error("Synthetic source withdrew decision");};
    expect(()=>h.repo.decision(record.offerId,command,"withdrawn-decision")).toThrow("EXACT_VERSION_DECISION_UNVERIFIED");
    expect(h.store.database.prepare("SELECT COUNT(*) n FROM offer_decisions").get()?.n).toBe(0);
  });
  it("redacts upstream reply failures into a held safe error without inserting a receipt",()=>{
    const h=setup(),record=h.save();h.auth.reply=()=>{throw new Error("private synthetic upstream details");};
    expect(()=>h.repo.observeReply(record.offerId,record.version,"synthetic-reply","missing-reply","synthetic-reviewer")).toThrow("CREATOR_REPLY_SOURCE_UNVERIFIED");
    expect(h.store.database.prepare("SELECT COUNT(*) n FROM offer_reply_requests").get()?.n).toBe(0);
  });
  it("renews current exact acceptance leases without rewriting historical decision receipts",()=>{
    const h=setup(),record=h.save();
    for(const kind of ["owner-approved","creator-accepted"] as const){
      h.decisions.set(kind,{scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},creatorId:h.terms.creatorId,provider:h.terms.provider,programRef:h.terms.programRef,sourceRef:kind,
        offerId:record.offerId,version:record.version,providerAccountRef:"synthetic-provider-account",manifestHash:record.manifestHash,decision:kind,occurredAt:new Date(h.now()).toISOString(),validUntil:new Date(h.now()+10).toISOString()});
      h.repo.decision(record.offerId,{version:record.version,sourceRef:kind,kind},kind);
    }
    const immutable=h.store.database.prepare("SELECT body FROM offer_decisions ORDER BY kind").all();
    h.advance(11);
    expect(h.repo.acceptedTerms(record.offerId)).toBeNull();
    for(const [ref,value] of h.decisions)h.decisions.set(ref,{...value as object,validUntil:new Date(h.now()+1000).toISOString()});
    expect(h.repo.readEligibility(record.offerId,"activation")?.state).toBe("eligible");
    expect(h.repo.acceptedTerms(record.offerId)?.validUntil).toBe(new Date(h.now()+1000).toISOString());
    expect(h.repo.onboarding(record.offerId)).not.toBeNull();
    expect(h.store.database.prepare("SELECT body FROM offer_decisions ORDER BY kind").all()).toEqual(immutable);
    h.decisions.delete("owner-approved");expect(h.repo.acceptedTerms(record.offerId)).toBeNull();
  });
  it.each([true,false])("uses source event ordering, independent of acceptance-first delivery=%s",acceptanceFirst=>{
    const h=setup(),record=h.save(),fee=h.reply(record);
    h.advance(1);
    const accepted=h.reply(record,{sourceRef:"later-acceptance",eventRef:"later-acceptance-event",classification:"commission-only-accepted",acceptanceRef:"source-terms-acceptance",resolvesSourceRefs:[fee.sourceRef]});
    for(const reply of acceptanceFirst?[accepted,fee]:[fee,accepted])h.repo.observeReply(record.offerId,record.version,reply.sourceRef,reply.sourceRef,"synthetic-reviewer");
    expect(h.repo.readEligibility(record.offerId)?.state).toBe("eligible");
    expect(h.store.database.prepare("SELECT COUNT(*) n FROM offer_reply_observations").get()?.n).toBe(2);
  });
  it("does not resolve a fee at an equal source instant, even with an equivalent offset",()=>{
    const h=setup(),record=h.save(),fee=h.reply(record),accepted=h.reply(record,{sourceRef:"equal-acceptance",eventRef:"equal-acceptance-event",classification:"commission-only-accepted",acceptanceRef:"source-terms-acceptance",resolvesSourceRefs:[fee.sourceRef],occurredAt:"2026-11-06T16:00:00-08:00"});
    for(const reply of [accepted,fee])h.repo.observeReply(record.offerId,record.version,reply.sourceRef,reply.sourceRef,"synthetic-reviewer");
    expect(h.repo.readEligibility(record.offerId)?.reasonCodes).toContain("CREATOR_FEE_REQUEST");
  });
  it.each(["reclassified","withdrawn","final-fence"])("invalidates fee clearance and prior proof when its source is %s",kind=>{
    const h=setup(),record=h.save(),fee=h.reply(record);h.repo.observeReply(record.offerId,record.version,fee.sourceRef,"fee","synthetic-reviewer");
    h.advance(1);
    const accepted=h.reply(record,{sourceRef:"later-acceptance",eventRef:"later-acceptance-event",classification:"commission-only-accepted",acceptanceRef:"source-terms-acceptance",resolvesSourceRefs:[fee.sourceRef]});
    h.repo.observeReply(record.offerId,record.version,accepted.sourceRef,"resolution","synthetic-reviewer");
    const proof=h.repo.resolvePolicyProof(record.offerId,"invitation")!.proof!;expect(proof).not.toBeNull();
    const history=h.store.database.prepare("SELECT body FROM offer_reply_observations ORDER BY revision").all();
    const change=()=>h.replies.set(accepted.sourceRef,{...accepted,sourceVersion:"v2",classification:"unknown",acceptanceRef:null,resolvesSourceRefs:[]});
    let finalResolutionSeen=false;
    if(kind==="reclassified")change();
    if(kind==="withdrawn")h.replies.delete(accepted.sourceRef);
    if(kind==="final-fence"){const original=h.auth.assertCurrent!;h.auth.assertCurrent=(fence,now)=>{original(fence,now);if(fence.resolvedReplies.some(reply=>reply.sourceRef===accepted.sourceRef)){finalResolutionSeen=true;change();}};}
    expect(()=>h.repo.assertPolicyProof(proof,h.now())).toThrow("OFFER_POLICY_PROOF_STALE");
    expect(h.repo.readEligibility(record.offerId)?.state).toBe("held");
    if(kind==="final-fence")expect(finalResolutionSeen).toBe(true);
    expect(h.store.database.prepare("SELECT body FROM offer_reply_observations ORDER BY revision").all()).toEqual(history);
  });
  it("preserves a stored accepted receipt while current acceptance expires",()=>{
    const h=setup(),record=h.save();
    for(const kind of ["owner-approved","creator-accepted"] as const){
      h.decisions.set(kind,{scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},creatorId:h.terms.creatorId,provider:h.terms.provider,programRef:h.terms.programRef,sourceRef:kind,
        offerId:record.offerId,version:record.version,providerAccountRef:"synthetic-provider-account",manifestHash:record.manifestHash,decision:kind,occurredAt:new Date(h.now()).toISOString(),validUntil:new Date(h.now()+10).toISOString()});
      h.repo.decision(record.offerId,{version:record.version,sourceRef:kind,kind},kind);
    }
    expect(h.repo.readEligibility(record.offerId,"activation")?.state).toBe("eligible");h.advance(11);
    expect(h.repo.readEligibility(record.offerId,"activation")?.state).toBe("held");expect(h.repo.readOffer(record.offerId)?.acceptedRef).toBe("creator-accepted");
    expect(h.repo.acceptedTerms(record.offerId)).toBeNull();
    const replay=h.repo.decision(record.offerId,{version:record.version,sourceRef:"creator-accepted",kind:"creator-accepted"},"creator-accepted");
    expect(replay.acceptedRef).toBe("creator-accepted");expect(h.repo.readEligibility(replay.offerId,"activation")?.state).toBe("held");
  });
  it("supports a verified fixed-per-sale route and rejects guaranteed/unknown fee fields before projection",()=>{
    const h=setup();h.terms.provider="external-affiliate";h.terms.commission={...h.terms.commission,type:"fixed-per-sale",fixedMinor:100,standardRateBps:null};
    h.source.state.current.routes[0]!.provider="external-affiliate";h.source.state.current.routes[0]!.supportsFixedPerSale=true;
    h.save();expect(h.repo.readEligibility("synthetic-offer")?.state).toBe("eligible");
    for(const fields of [{guaranteedFeeMinor:1},{upfrontFeeMinor:1},{paidComponentMinor:1},{relationship:"gifted"},{relationship:"paid-hybrid"}])
      expect(()=>h.repo.saveFromAdapter("invalid",null,{...h.terms,...fields},"invalid")).toThrow();
  });
  it("requires separately funded exact reward policy and does not turn candidate tier numbers into adoption",()=>{
    const h=setup(),reward=rewardPolicyFixture(scope,h.now());h.source.state.current.performanceReward=reward;h.terms.rewardVersion=reward.rewardVersion;h.terms.rewardProgrammeRef=reward.programmeRef;
    h.save();expect(h.repo.readEligibility("synthetic-offer")?.state).toBe("eligible");
    reward.terms.state="proposed";reward.terms.adoptionRef=null;
    expect(h.repo.readEligibility("synthetic-offer")?.reasonCodes).toContain("PERFORMANCE_REWARD_PROPOSED");
  });
});
describe("atomic native import and verified reply observations",()=>{
  it("commits a finite import atomically and binds exact actor, key, body and versions",()=>{
    const h=setup(),command={rows:[{offerId:"synthetic-a",expectedVersion:null,terms:h.terms},{offerId:"synthetic-b",expectedVersion:"v99",terms:h.terms}]};
    expect(()=>h.repo.importBatch(command,"import","synthetic-reviewer")).toThrow("VERSION_CONFLICT");
    expect(h.repo.readOffer("synthetic-a")).toBeNull();command.rows[1]!.expectedVersion=null;
    const result=h.repo.importBatch(command,"import","synthetic-reviewer");expect(result.records).toHaveLength(2);
    expect(h.repo.importBatch(command,"import","synthetic-reviewer")).toEqual(result);
    expect(()=>h.repo.importBatch(command,"import","other-reviewer")).toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(()=>h.repo.importBatch({rows:Array(101).fill(command.rows[0])},"large","synthetic-reviewer")).toThrow();
    expect(()=>h.repo.importBatch({rows:[command.rows[0],command.rows[0]]},"duplicate","synthetic-reviewer")).toThrow("DUPLICATE_OFFER_ID");
  });
  it("blocks malformed fees and unauthorized native import/reply requests",()=>{
    const h=setup();const input={method:"POST",path:"/v1/offers/import",role:"reader" as const,idempotencyKey:"key",body:{rows:[{offerId:"a",expectedVersion:null,terms:h.terms}]}};
    expect(handleOfferRoute(input,h.repo)?.status).toBe(403);
    expect(handleOfferRoute({...input,role:"reviewer",body:{rows:[{offerId:"a",expectedVersion:null,terms:{...h.terms,upfrontFeeMinor:1}}]}},h.repo)?.status).toBe(422);
    h.save();expect(handleOfferRoute({...input,path:"/v1/offers/synthetic-offer/replies",role:"reviewer",body:{expectedVersion:"v1",sourceRef:"forged",classification:"other"}},h.repo)?.status).toBe(422);
  });
  it("returns canonical policy reasons and the rejected import row without echoing input values",()=>{
    const h=setup();const result=handleOfferRoute({method:"POST",path:"/v1/offers/import",role:"reviewer",actorRef:"synthetic-reviewer",idempotencyKey:"import",
      body:{rows:[{offerId:"a",expectedVersion:null,terms:h.terms},{offerId:"b",expectedVersion:null,terms:{...h.terms,upfrontFeeMinor:123}}]}},h.repo);
    expect(result).toEqual({status:422,body:{code:"POLICY_VIOLATION",reasonCodes:["UPFRONT_FEE_PROHIBITED"],rowIndex:1,executionCertainty:"notApplied"}});
    expect(h.repo.readOffer("a")).toBeNull();
    expect(()=>parseOfferTerms({...h.terms,paidComponentMinor:0})).toThrow();
    expect(()=>parseOfferTerms({...h.terms,commission:{...h.terms.commission,standardRateBps:Infinity}})).toThrow();
  });
  it("holds every same-programme offer after a source fee request, retaining history without counteroffer",()=>{
    const h=setup(),saved=h.save(),reply=h.reply();const original=h.repo.resolvePolicyProof(saved.offerId,"invitation")!.proof!;
    const result=h.repo.observeReply(saved.offerId,saved.version,reply.sourceRef,"reply-key","synthetic-reviewer");
    expect(result).toMatchObject({autoCounterOffer:false,sourceEffects:"none",current:{commercial:{reasonCodes:expect.arrayContaining(["CREATOR_FEE_REQUEST"])}}});
    expect(()=>h.repo.assertPolicyProof(original,h.now())).toThrow();
    h.save("synthetic-new-offer",h.terms,"new-offer");expect(h.repo.readEligibility("synthetic-new-offer")?.reasonCodes).toContain("CREATOR_FEE_REQUEST");
    expect(h.repo.observeReply(saved.offerId,saved.version,reply.sourceRef,"reply-key","synthetic-reviewer").receipt).toEqual(result.receipt);
    expect(h.store.database.prepare("SELECT COUNT(*) n FROM offer_reply_observations").get()?.n).toBe(1);
  });
  it("does not clear a fee hold from an ordinary no-fee reply or lift a separate suppression",()=>{
    const h=setup(),saved=h.save(),fee=h.reply();h.repo.observeReply(saved.offerId,saved.version,fee.sourceRef,"fee","synthetic-reviewer");h.advance(1);
    const other=h.reply(saved,{sourceRef:"synthetic-other",eventRef:"synthetic-event-other",classification:"other",reason:"No commitment",excerpt:"No fee mentioned"});
    h.repo.observeReply(saved.offerId,saved.version,other.sourceRef,"other","synthetic-reviewer");expect(h.repo.readEligibility(saved.offerId)?.reasonCodes).toContain("CREATOR_FEE_REQUEST");
    h.advance(1);const accepted=h.reply(saved,{sourceRef:"synthetic-accepted",eventRef:"synthetic-event-accepted",classification:"commission-only-accepted",resolvesSourceRefs:[fee.sourceRef],acceptanceRef:"synthetic-native-terms",reason:"Source confirmed exact commission terms"});
    h.repo.observeReply(saved.offerId,saved.version,accepted.sourceRef,"acceptance","synthetic-reviewer");
    expect(h.repo.readEligibility(saved.offerId)?.reasonCodes).not.toContain("CREATOR_FEE_REQUEST");h.suppress();expect(h.repo.readEligibility(saved.offerId)?.reasonCodes).toContain("CREATOR_SUPPRESSED");
  });
  it("retains the original reply receipt after an offer relabel and refuses a conflicting actor replay",()=>{
    const h=setup(),record=h.save(),fee=h.reply(),first=h.repo.observeReply(record.offerId,record.version,fee.sourceRef,"fee","synthetic-reviewer");
    const newer=h.repo.saveFromAdapter(record.offerId,record.version,{...h.terms,counterofferRef:"synthetic-relabel"},"new-version");
    expect(newer.commercial?.reasonCodes).toContain("CREATOR_FEE_REQUEST");
    const replay=h.repo.observeReply(record.offerId,record.version,fee.sourceRef,"fee","synthetic-reviewer");
    expect(replay.receipt).toEqual(first.receipt);expect(replay.current?.version).toBe(newer.version);
    expect(()=>h.repo.observeReply(record.offerId,record.version,fee.sourceRef,"fee","other-reviewer")).toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("preserves import/reply receipts and fee holds over a real SQLite close and reopen",()=>{
    const directory=mkdtempSync(join(tmpdir(),"farda-policy-"));directories.push(directory);const path=join(directory,"agent.sqlite"),h=setup(path);
    const command={rows:[{offerId:"synthetic-offer",expectedVersion:null,terms:h.terms}]},imported=h.repo.importBatch(command,"import","synthetic-reviewer");
    const record=h.repo.readOffer("synthetic-offer")!,reply=h.reply(record),saved=h.repo.observeReply(record.offerId,record.version,reply.sourceRef,"reply","synthetic-reviewer");
    h.store.close();stores.splice(stores.indexOf(h.store),1);
    const reopened=new AgentStore(path,{workspaceId:scope.workspaceId,accountId:scope.accountId});stores.push(reopened);
    const repo=new OfferRepository(reopened.database,{workspaceId:scope.workspaceId,accountId:scope.accountId},h.auth,{now:h.now});
    expect(repo.importBatch(command,"import","synthetic-reviewer").records[0]?.receipt).toEqual(imported.records[0]?.receipt);
    expect(repo.observeReply(record.offerId,record.version,reply.sourceRef,"reply","synthetic-reviewer").receipt).toEqual(saved.receipt);
    expect(repo.readEligibility(record.offerId)?.reasonCodes).toContain("CREATOR_FEE_REQUEST");
    expect(reopened.database.prepare("SELECT COUNT(*) n FROM offer_reply_observations").get()?.n).toBe(1);
  });
  it("rejects wrong-account replies, changed source receipts and a revoked source without committing",()=>{
    const h=setup(),saved=h.save();h.reply(saved,{scope:{...scope,accountId:"other"}});
    expect(()=>h.repo.observeReply(saved.offerId,saved.version,"synthetic-fee-reply","reply","synthetic-reviewer")).toThrow("CREATOR_REPLY_SOURCE_UNVERIFIED");
    h.reply();h.revoke();expect(()=>h.repo.observeReply(saved.offerId,saved.version,"synthetic-fee-reply","reply","synthetic-reviewer")).toThrow("CREATOR_REPLY_SOURCE_UNVERIFIED");
    expect(h.store.database.prepare("SELECT COUNT(*) n FROM offer_reply_observations").get()?.n).toBe(0);
  });
});
it("uses source-earned amounts and retains legacy unknowns instead of applying candidate tiers",()=>{
  const source:RewardSource={scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},creatorId:"synthetic-creator",sourceRef:"synthetic-ledger",observedAt:"2026-11-07T00:00:00Z",coveredRoutes:["website","tiktok-shop"],orders:[],paused:true,commissionMinor:0,costsExcludingRewardsAndCommissionMinor:0,awardsComplete:true,
    awards:[{tier:"tech",earnedRef:"synthetic-earned",redemptionRef:null,redeemedMinor:null,selection:null,amountMinor:900,programmeRef:"synthetic-programme",rewardVersion:"synthetic-earlier-version",sourceVersion:"synthetic-source-v1"}]};
  expect(projectRewards("offer",source.creatorId,"v1",source)).toMatchObject({earnedMinor:900,outstandingMinor:900,paused:true});
  const legacy={...source,awards:[{tier:"tech" as const,earnedRef:"legacy",redemptionRef:null,redeemedMinor:null,selection:null}]};
  expect(projectRewards("offer",source.creatorId,"v1",legacy)).toMatchObject({earnedMinor:null,unknowns:expect.arrayContaining([expect.stringContaining("Legacy award")])});
  expect(projectRewards("offer",source.creatorId,"v1",{...source,awards:[]},source.awards).earnedMinor).toBe(900);
});
