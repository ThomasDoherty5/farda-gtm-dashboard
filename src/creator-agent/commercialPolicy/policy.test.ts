// @vitest-environment node
import { describe, expect, it } from "vitest";
import { commercialPolicySnapshotSchema, rewardPolicySnapshotSchema } from "./contract.ts";
import { assertCommercialPolicyCurrent, assertRewardPolicyCurrent, commercialPolicyHash, readCommercialPolicy, readRewardPolicy } from "./authority.ts";
import { commercialPolicyFixture, commercialSourceFixture, rewardPolicyFixture, syntheticCommercialScope as scope } from "./fixtures.testkit.ts";

const now=Date.parse("2026-11-07T00:00:00Z");
describe("source-owned commercial and historical reward policies",()=>{
  it("rejects malformed offsets, unsafe combined amounts and mismatched reward scope",()=>{
    const p=commercialPolicyFixture(scope,now);
    expect(commercialPolicySnapshotSchema.safeParse({...p,validUntil:"2026-11-07T00:00:00+99:99"}).success).toBe(false);
    expect(commercialPolicySnapshotSchema.safeParse({...p,samples:{...p.samples,merchandiseCapMinor:Number.MAX_SAFE_INTEGER,shippingCapMinor:1}}).success).toBe(false);
    expect(commercialPolicySnapshotSchema.safeParse({...p,performanceReward:rewardPolicyFixture({...scope,accountId:"other"},now)}).success).toBe(false);
  });
  it("keeps missing, proposed, revoked and expired source authority held",()=>{
    expect(readCommercialPolicy(undefined,scope,now).reasonCodes).toContain("COMMERCIAL_POLICY_UNAVAILABLE");
    const h=commercialSourceFixture(commercialPolicyFixture(scope,now));h.state.current.state="proposed";h.state.current.approvalRef=null;
    expect(readCommercialPolicy(h.source,scope,now).reasonCodes).toContain("COMMERCIAL_POLICY_PROPOSED");
    h.state.current.state="revoked";expect(readCommercialPolicy(h.source,scope,now).reasonCodes).toContain("COMMERCIAL_POLICY_REVOKED");
    h.state.current.validUntil=new Date(now).toISOString();expect(readCommercialPolicy(h.source,scope,now).snapshot).toBeNull();
  });
  it("renews a lease without changing material version, but refuses changed backing state",()=>{
    const h=commercialSourceFixture(commercialPolicyFixture(scope,now));const old=structuredClone(h.state.current),hash=commercialPolicyHash(old);
    h.state.current.validUntil=new Date(now+7200000).toISOString();expect(commercialPolicyHash(h.state.current)).toBe(hash);
    expect(()=>assertCommercialPolicyCurrent(h.source,old,scope,now)).not.toThrow();
    h.state.current.commission.maxRateBps=1000;expect(()=>assertCommercialPolicyCurrent(h.source,old,scope,now)).toThrow();
  });
  it("reads exact earlier reward terms despite a paused programme or a different current cap",()=>{
    const h=commercialSourceFixture(commercialPolicyFixture(scope,now)),old=rewardPolicyFixture(scope,now);old.pausedForNewAcquisition=true;
    h.state.rewardVersions.set(`${old.programmeRef}:${old.rewardVersion}`,old);
    h.state.current.performanceReward={...rewardPolicyFixture(scope,now),rewardVersion:"synthetic-new-version"};
    h.state.current.performanceReward.terms.milestones[0]!.additionalCapMinor=100;
    const read=readRewardPolicy(h.source,{scope,programmeRef:old.programmeRef,rewardVersion:old.rewardVersion},now);
    expect(read?.terms.milestones[0]?.additionalCapMinor).toBe(900);expect(read?.pausedForNewAcquisition).toBe(true);
    expect(()=>assertRewardPolicyCurrent(h.source,read!,scope,now)).not.toThrow();
    expect(readRewardPolicy(h.source,{scope,programmeRef:old.programmeRef,rewardVersion:"missing"},now)).toBeNull();
  });
  it("keeps current execution denial distinct from historical reward adoption",()=>{
    const h=commercialSourceFixture(commercialPolicyFixture(scope,now)),reward=rewardPolicyFixture(scope,now);h.state.current.performanceReward=reward;
    const old=structuredClone(reward);reward.execution.state="denied";reward.execution.sourceVersion="revoked-v2";
    expect(()=>assertRewardPolicyCurrent(h.source,old,scope,now)).toThrow();
    const denied=readRewardPolicy(h.source,{scope,programmeRef:reward.programmeRef,rewardVersion:reward.rewardVersion},now);
    expect(denied).toMatchObject({terms:{state:"effective"},execution:{state:"denied"}});
    reward.terms.adoptionRef=null;expect(rewardPolicySnapshotSchema.safeParse(reward).success).toBe(false);
  });
});
