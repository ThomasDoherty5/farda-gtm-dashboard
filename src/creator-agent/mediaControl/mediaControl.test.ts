// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { canonicalMediaFixture } from "../media/canonicalFixture.testkit.ts";
import { META, TIKTOK, syntheticMediaSettings } from "../media/canonicalKernel.testkit.ts";
import type { Manifest } from "../media/contract.ts";
import { MEDIA_STAGE_ACTION } from "../media/canonicalContract.ts";
import { approvalDispatchBinding } from "../approvals/repository.ts";

// Every native fixture effect uses the actual J04, capability ledger and existing runner.
// Observation/economic assertions below preserve the original author regressions.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
let clock = new Date("2026-11-06T20:00:00Z");
const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(clock.getTime() + minutes * 60_000).toISOString();
const A = <T>(value: T) => ({value,state:"adopted",adoptionRef:"decision:owner-economics-v1",adoptedAt:"2026-11-01T00:00:00Z"});
const P = <T>(value: T) => ({value,state:"proposed",adoptionRef:null,adoptedAt:null});
const settingsFrom = (m: Manifest,id: string) => syntheticMediaSettings(m,id,()=>clock);
async function world() {
  const f=await canonicalMediaFixture(); cleanups.push(()=>f.approval.db.close()); clock=new Date(f.approval.at());
  const advance=async(iso:string)=>{f.advance(iso);clock=new Date(iso);await f.refreshCapabilities();};
  const order=(i:number,nativeCampaignId:string,over:Record<string,unknown>={})=>({source:"shop:synthetic",orderRef:`order-${i}`,channel:"website",
    placedAt:ago(60*24),updatedAt:ago(60*24),units:1,returnedUnits:0,merchandiseMinor:12000,shippingCollectedMinor:800,refundedMerchandiseMinor:0,
    refundedShippingMinor:0,returnWindowClosed:true,affiliateAttributed:false,commissionAccruedMinor:null,paidMediaMatch:{provider:"meta",providerAccountRef:META,nativeCampaignId},...over});
  return {...f,...f.kernel,store:{database:f.approval.db},f,advance,order,campaign:f.draft,released:f.releaseStage};
}
type World=Awaited<ReturnType<typeof world>>;
async function launched(w:World){await w.released();const c=await w.campaign();await w.f.launch(c.campaignId);
  return {c:w.media.read(c.campaignId)!,nativeId:w.media.read(c.campaignId)!.native.nativeCampaignId!};}
async function profitable(w:World){const r=await launched(w);await w.f.profitable(r.c.campaignId);await w.advance("2026-11-10T20:30:00Z");return r;}

describe("canonical control authorizations and original financial boundaries",()=>{
  it("keeps a stage proposal held until its genuine distinct founder decision and existing-runner receipt",async()=>{
    const w=await world(),c=await w.campaign();
    expect(w.control.read(w.stage.stageRef)).toMatchObject({state:"awaiting-approval",dispatch:"held"});
    await expect(w.approve("media.publish",c.campaignId)).rejects.toThrow();
    await expect(w.approve(MEDIA_STAGE_ACTION,w.stage.stageRef,"synthetic:reviewer")).rejects.toThrow("FOUNDER_REQUIRED");
    expect(w.control.read(w.stage.stageRef)?.reservations).toHaveLength(0);
    expect((await w.released()).state).toBe("released");
    expect(w.state.calls).toBe(1); // Only the already approved paused native draft.
  });
  it("retains the exact two-account split, all five receipt-backed gates and headroom without charging the cap",async()=>{
    const w=await world();await w.released();const meta=await w.campaign("meta"),tiktok=await w.campaign("tiktok");
    await w.f.launch(meta.campaignId);await w.f.launch(tiktok.campaignId);
    const stage=w.control.read(w.stage.stageRef)!;
    expect(stage.reservations.map(r=>[r.provider,r.state,r.plannedMaxMinor])).toEqual([["meta","committed",66000],["tiktok","committed",66000]]);
    const observation=w.control.observe(w.stage.stageRef,"split-observation");
    expect(observation.exposure).toMatchObject({demonstrated:true,capMinor:150000,spendMinor:0,plannedMaxMinor:132000,remainingMinor:18000});
    expect(w.control.read(w.stage.stageRef)!.reservations.every(r=>r.gates.length===5&&r.gates.every(g=>g.state==="verified"))).toBe(true);
    expect(w.media.read(meta.campaignId)!.gates.every(g=>g.state==="verified")).toBe(true);
    expect(w.treasury.mediaChargedMinor).toBe(0);expect(w.native.size).toBe(2);
  });
  it("keeps a failed-gate publication unapplied and reserves nothing rather than borrowing a stale release",async()=>{
    const w=await world();await w.released();const c=await w.campaign();w.gates.set("fulfillment-support-cash",null);
    await expect(w.f.launch(c.campaignId)).rejects.toThrow();
    expect(w.control.read(w.stage.stageRef)?.reservations).toHaveLength(0);expect(w.media.read(c.campaignId)?.native.status).toBe("PAUSED");expect(w.state.calls).toBe(1);
  });
  it("retains an uncertain publication allocation and learns its original native receipt without a second send",async()=>{
    const w=await world();await w.released();const c=await w.campaign(),run=await w.handoff(await w.approve("media.publish",c.campaignId));
    w.state.lostAck=true;expect((await w.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");
    expect(w.control.read(w.stage.stageRef)?.reservations[0]).toMatchObject({state:"pending",plannedMaxMinor:66000});
    const calls=w.state.calls;w.state.lostAck=false;expect((await w.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");
    expect(w.control.read(w.stage.stageRef)?.reservations[0]?.state).toBe("committed");expect(w.state.calls).toBe(calls);
  });
  it("retains pending exposure during concurrent observation and refuses an overlapping allocation",async()=>{
    const w=await world();await w.released();const a=await w.campaign(),b=await w.campaign();
    let observed=false;w.state.beforeEffect=async()=>{w.state.beforeEffect=null;
      expect(w.control.observe(w.stage.stageRef,"inflight-observation").exposure.plannedMaxMinor).toBe(66000);observed=true;
      await expect(w.f.launch(b.campaignId)).rejects.toThrow("STAGE_AUTHORIZATION_EXHAUSTED");};
    await w.f.launch(a.campaignId);expect(observed).toBe(true);expect(w.control.read(w.stage.stageRef)?.reservations).toHaveLength(1);
    expect(w.state.calls).toBe(3);
  });
  it("refuses a native cap plus headroom beyond the allocation even when an account limit is lower",async()=>{
    const w=await world();await launched(w);w.reportOver.set(META,{accountSpendMinor:0,accountSpendLimitMinor:10000});
    const c=await w.campaign("meta",55000);await expect(w.f.launch(c.campaignId)).rejects.toThrow();
    expect(w.control.observe(w.stage.stageRef,"account-limit-observation").exposure.allocations[0]?.plannedMaxMinor).toBe(66000);
  });
  it("uses fresh spend reports, rejects mismatched/future data and preserves a cumulative correction",async()=>{
    const w=await world(),{nativeId}=await launched(w);w.spend.set(nativeId,20000);w.control.observe(w.stage.stageRef,"spend-current");
    w.reportOver.set(META,{sourceUpdatedAt:ago(480),observedAt:ago(480)});
    const stale=w.control.observe(w.stage.stageRef,"spend-stale");expect(stale.holds).toContain(`SPEND_STALE:meta:${META}`);
    expect(stale.corrections.map(c=>c.kind)).toContain("out-of-order-report-ignored");
    const c=await w.campaign("tiktok");await expect(w.f.launch(c.campaignId)).rejects.toThrow();
    w.reportOver.set(META,{observedAt:ahead(10)});expect(w.control.observe(w.stage.stageRef,"spend-future").holds).toContain(`SPEND_REPORT_TIME_INVALID:meta:${META}`);
    w.reportOver.set(META,{providerAccountRef:TIKTOK});expect(w.control.observe(w.stage.stageRef,"spend-other-account").holds).toContain(`SPEND_REPORT_MISMATCH:meta:${META}`);
    w.reportOver.delete(META);w.spend.set(nativeId,18000);expect(w.control.observe(w.stage.stageRef,"spend-corrected").corrections).toContainEqual(expect.objectContaining({kind:"spend-revised-down",detail:"20000 -> 18000"}));
    w.spend.set(nativeId,null);expect(w.control.observe(w.stage.stageRef,"spend-unknown").exposure.spendMinor).toBeNull();
  });
  it("keeps verified contribution, requires current review cadence and records the learning window after an exact increase",async()=>{
    const w=await world(),{c}=await profitable(w),o=w.control.observe(w.stage.stageRef,"profitable-current");
    expect(o.economics).toMatchObject({canonical:{orders:3,contributionMinor:21048,contributionPerOrderMinor:7016},canonicalCpaMinor:5000,allowableAcquisitionCostMinor:7016,scale:{state:"met"}});
    expect((await w.f.mutate(c.campaignId,"edit-budget",3000)).state).toBe("confirmed");
    const again=w.control.proposeChange(w.stage.stageRef,{campaignId:c.campaignId,kind:"increase-budget",dailyBudgetMinor:4000,rationale:"Synthetic second scale review."},"second-learning-window");
    expect(again.heldReasons).toContain("LEARNING_WINDOW_ACTIVE");
    expect(w.media.read(c.campaignId)?.native.readback?.dailyBudgetMinor).toBe(3000);
  });
});

describe("canonical recovery and retained author safety boundaries",()=>{
  it("keeps a lost budget-change acknowledgment on the original native attempt until exact reconciliation",async()=>{
    const w=await world(),{c}=await profitable(w);
    const m=w.media.proposeMutation(c.campaignId,{kind:"edit-budget",dailyBudgetMinor:1000},"lost-budget-intent");
    const run=await w.handoff(await w.approve("media.changeBudget",m.mutationId));w.state.lostAck=true;
    expect((await w.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");const calls=w.state.calls;
    w.state.lostAck=false;expect((await w.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");
    expect(w.media.readMutation(c.campaignId,m.mutationId)).toMatchObject({state:"confirmed",after:{dailyBudgetMinor:1000}});expect(w.state.calls).toBe(calls);
  });
  it("holds growth outside its actual review window while permitting separately approved reduction",async()=>{
    const w=await world(),{c}=await profitable(w);await w.advance("2026-11-11T02:00:00Z");
    const proposal=w.control.proposeChange(w.stage.stageRef,{campaignId:c.campaignId,kind:"increase-budget",dailyBudgetMinor:3000,rationale:"Synthetic off-cadence growth."},"off-cadence-proposal");
    expect(proposal.heldReasons).toContain("REVIEW_WINDOW_CLOSED");
    await expect(w.f.mutate(c.campaignId,"edit-budget",3000)).rejects.toThrow();
    expect((await w.f.mutate(c.campaignId,"edit-budget",1000)).state).toBe("confirmed");expect(w.media.read(c.campaignId)?.native.readback?.dailyBudgetMinor).toBe(1000);
  });
  it("pauses each exactly authorized campaign on failed stock and retains already incurred exposure",async()=>{
    const w=await world();await w.released();const a=await w.campaign("meta"),b=await w.campaign("tiktok");await w.f.launch(a.campaignId);await w.f.launch(b.campaignId);
    w.spend.set(a.native.nativeCampaignId!,12000);w.health.stock={state:"failed",code:"synthetic-stock-shortage"};w.state.failedGate=true;
    expect(w.control.observe(w.stage.stageRef,"stock-failed").safetyTriggers).toContain("QUALIFIED_STOCK_SHORTAGE");
    for(const c of [a,b])expect((await w.f.mutate(c.campaignId,"pause",null)).state).toBe("confirmed");
    expect([...w.native.values()].map(n=>n.status)).toEqual(["PAUSED","PAUSED"]);
    expect(w.control.observe(w.stage.stageRef,"stock-paused").exposure.spendMinor).toBe(12000);
    expect(w.control.read(w.stage.stageRef)!.reservations.every(r=>r.state==="committed")).toBe(true);
  });
  it("can execute a finite safety pause outside growth cadence after rights failure without increasing spend",async()=>{
    const w=await world(),{c,nativeId}=await launched(w);await w.advance("2026-11-07T11:00:00Z");
    w.health.rights={state:"failed",code:"synthetic-rights-expired"};w.gates.set("permissioned-content",null);
    expect(w.control.observe(w.stage.stageRef,"expired-rights").safetyTriggers).toContain("RIGHTS_REVOKED_OR_EXPIRED");
    expect((await w.f.mutate(c.campaignId,"pause",null)).state).toBe("confirmed");expect(w.native.get(nativeId)?.status).toBe("PAUSED");
  });
  it("keeps an uncertain safety pause reconcilable and never invents non-application from malformed readback",async()=>{
    const w=await world(),{c,nativeId}=await launched(w),m=w.media.proposeMutation(c.campaignId,{kind:"pause",dailyBudgetMinor:null},"uncertain-pause-intent");
    const run=await w.handoff(await w.approve("media.pause",m.mutationId));w.state.lostAck=true;
    expect((await w.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");w.state.malformed=true;
    expect((await w.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");const calls=w.state.calls;
    w.state.malformed=false;w.state.lostAck=false;expect((await w.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");
    expect(w.native.get(nativeId)?.status).toBe("PAUSED");expect(w.state.calls).toBe(calls);
  });
  it("does not let an older approved increase undo a confirmed finite pause",async()=>{
    const w=await world(),{c,nativeId}=await profitable(w),m=w.media.proposeMutation(c.campaignId,{kind:"edit-budget",dailyBudgetMinor:3000},"older-increase-intent");
    const run=await w.handoff(await w.approve("media.changeBudget",m.mutationId));await w.f.mutate(c.campaignId,"pause",null);const calls=w.state.calls;
    await expect(w.dispatch.execute(run.runRef)).rejects.toThrow();expect(w.native.get(nativeId)).toMatchObject({status:"PAUSED",dailyBudgetMinor:2000});expect(w.state.calls).toBe(calls);
  });
  it("keeps the original safety receipt immutable after external reactivation, requiring a fresh finite intent",async()=>{
    const w=await world(),{c,nativeId}=await launched(w),m=w.media.proposeMutation(c.campaignId,{kind:"pause",dailyBudgetMinor:null},"first-pause-intent");
    const first=await w.handoff(await w.approve("media.pause",m.mutationId));expect((await w.dispatch.execute(first.runRef)).executionCertainty).toBe("applied");
    w.native.get(nativeId)!.status="ACTIVE";w.versions.get(nativeId)!.nativeVersion="synthetic-external-reactivation-v2";const calls=w.state.calls;
    expect((await w.dispatch.reconcile(first.runRef)).executionCertainty).toBe("applied");expect(w.state.calls).toBe(calls);
    expect(w.native.get(nativeId)?.status).toBe("ACTIVE");
    expect((await w.f.mutate(c.campaignId,"pause",null)).state).toBe("confirmed");expect(w.native.get(nativeId)?.status).toBe("PAUSED");expect(w.state.calls).toBe(calls+1);
  });
  it("does not overwrite a later confirmed reduction when an earlier budget receipt is read again",async()=>{
    const w=await world(),{c,nativeId}=await profitable(w),m=w.media.proposeMutation(c.campaignId,{kind:"edit-budget",dailyBudgetMinor:1500},"first-reduction-intent");
    const first=await w.handoff(await w.approve("media.changeBudget",m.mutationId));await w.dispatch.execute(first.runRef);await w.f.mutate(c.campaignId,"edit-budget",1000);
    const calls=w.state.calls;await w.dispatch.reconcile(first.runRef);expect(w.native.get(nativeId)?.dailyBudgetMinor).toBe(1000);expect(w.media.read(c.campaignId)?.native.readback?.dailyBudgetMinor).toBe(1000);expect(w.state.calls).toBe(calls);
  });
  it("releases only a positively closed never-applied publication, retaining its original revoked approval history",async()=>{
    const w=await world();await w.released();const c=await w.campaign(),a=await w.approve("media.publish",c.campaignId),run=await w.handoff(a);
    w.state.failBefore=true;expect((await w.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");
    const event=[...w.approval.events.values()].find(e=>e.approvalRef===a.manifest.approvalRef)!;event.decision="rejected";
    w.state.terminal=true;expect((await w.dispatch.reconcile(run.runRef)).executionCertainty).toBe("notApplied");
    expect(w.control.read(w.stage.stageRef)?.reservations[0]?.state).toBe("released");const calls=w.state.calls;
    await expect(w.dispatch.execute(run.runRef)).rejects.toThrow();expect(w.state.calls).toBe(calls);expect(w.native.get(c.native.nativeCampaignId!)?.status).toBe("PAUSED");
  });
  it("does not turn refreshed source leases into an extension of the immutable approved stage end",async()=>{
    const w=await world();await w.released();const binding=w.control.canonicalStageRequest(w.stage.stageRef).canonical!.binding;
    await w.advance("2026-12-01T00:00:00Z");const current=await w.approvals.resolveCurrentProof(binding);
    expect(current.state).toBe("held");expect(Date.parse(w.approvals.readApproval(binding.approvalRef)!.manifest.draft.expiresAt)).toBeLessThanOrEqual(w.approval.state.now);expect(w.state.calls).toBe(0);
  });
  it.each(["ceiling","cash","commitments"])("refuses a new stage release when current treasury %s is not demonstrated",async kind=>{
    const w=await world();if(kind==="ceiling")Object.assign(w.treasury,{founderInvestedMinor:3900000,commitmentsMinor:500000});
    if(kind==="cash")w.treasury.actualCashMinor=null;if(kind==="commitments")w.treasury.commitmentsMinor=null;
    await expect(w.released()).rejects.toThrow();expect(w.control.read(w.stage.stageRef)?.state).not.toBe("released");expect(w.state.calls).toBe(0);
  });
  it("requires the adopted release cadence and distinct native identity for later stages",async()=>{
    const w=await world();await w.advance("2026-11-07T02:00:00Z");await expect(w.released()).rejects.toThrow("REVIEW_WINDOW_CLOSED");
    await w.advance("2026-11-07T20:00:00Z");await w.released();const second=w.control.proposeStage(w.terms({stageRef:"stage:second",ordinal:2}),"second-stage-proposal");
    expect(second.state).toBe("awaiting-approval");await expect(w.approve(MEDIA_STAGE_ACTION,second.stageRef)).rejects.toThrow();
    const first=w.control.canonicalStageRequest(w.stage.stageRef).canonical!.binding;
    expect((await w.approvals.resolveCurrentProof({...first,itemRef:second.stageRef})).state).toBe("held");
    expect(approvalDispatchBinding(w.approvals.readApproval(first.approvalRef)!.manifest,first.itemRef)).toEqual(first);
  });
});

describe("canonical stage economic and observation regressions",()=>{
it("treats spend within the approved overdelivery headroom as bounded, and beyond it as a safety trigger", async () => {
    const w = await world();
    const { nativeId } = await launched(w);
    w.spend.set(nativeId, 64_000);
    const within = w.control.observe("stage:initial", "o1");
    expect(within.safetyTriggers).toEqual([]);
    expect(within.exposure.campaigns[0]).toMatchObject({ lifetimeBudgetMinor: 60_000, boundMinor: 66_000, spendMinor: 64_000 });
    w.spend.set(nativeId, 67_000);
    expect(w.control.observe("stage:initial", "o2").safetyTriggers).toEqual(expect.arrayContaining([expect.stringMatching(/^OVERDELIVERY_BEYOND_HEADROOM/)]));
  });

it("never treats a daily budget as a ceiling: an unknown native lifetime cap fails closed, and a raised one triggers safety", async () => {
    const w = await world();
    const { nativeId } = await launched(w);
    w.rowOver.set(nativeId, { lifetimeBudgetMinor: null });
    await w.advance("2026-11-07T03:00:00Z");
    const o = w.control.observe("stage:initial", "o1");
    expect(o.exposure.demonstrated).toBe(false);
    expect(o.exposure.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^NATIVE_LIFETIME_CAP_UNAVAILABLE/)]));
    expect(o.holds).toContain("EXPOSURE_UNDEMONSTRATED");
    w.rowOver.set(nativeId, { lifetimeBudgetMinor: 90_000 });
    expect(w.control.observe("stage:initial", "o2").safetyTriggers).toEqual(expect.arrayContaining([expect.stringMatching(/^NATIVE_CAP_EXCEEDS_APPROVED/)]));
    w.rowOver.set(nativeId, { maxDelivery: true });
    expect(w.control.observe("stage:initial", "o3").safetyTriggers).toEqual(expect.arrayContaining([expect.stringMatching(/^ADDITIONAL_DELIVERY_ENABLED/)]));
  });

it("never lets an account spend limit stand in for a missing native lifetime cap", async () => {
    const w = await world();
    const { nativeId } = await launched(w);
    w.rowOver.set(nativeId, { lifetimeBudgetMinor: null });
    w.spend.set(nativeId, 10_000);
    w.reportOver.set(META, { accountSpendMinor: 10_000, accountSpendLimitMinor: 50_000 });
    const o = w.control.observe("stage:initial", "o1");
    expect(o.exposure.allocations[0]).toMatchObject({ plannedMaxMinor: null, accountLimitMinor: 50_000 });
    expect(o.holds).toContain("EXPOSURE_UNDEMONSTRATED");
  });

it("treats an untracked active campaign in a stage account as a safety trigger", async () => {
    const w = await world();
    await w.released();
    w.native.set("native:outside", { ...settingsFrom((await w.campaign()).manifest!, "native:outside"), status: "ACTIVE" });
    expect(w.control.observe("stage:initial", "o1").safetyTriggers).toContain(`UNTRACKED_ACTIVE_CAMPAIGN:meta:${META}:native:outside`);
  });

it("unprofitable: CPA above allowable cost holds scale and recommends a reduction; a breached test loss is a safety trigger", async () => {
    const w = await world();
    const { c, nativeId } = await profitable(w);
    w.spend.set(nativeId, 40_000);
    const o = w.control.observe("stage:initial", "o1");
    expect(o.economics).toMatchObject({ canonicalCpaMinor: 13_334, scale: { state: "not-met", reasons: ["CPA_ABOVE_ALLOWABLE_ACQUISITION_COST"] },
      diagnostic: { lossMinor: 40_000 - 21_048, state: "within" } });
    expect(o.recommendations).toContainEqual({ action: "reduce-budget", reason: "CPA_ABOVE_ADOPTED_MAXIMUM" });
    const inc = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "increase-budget", dailyBudgetMinor: 3000, rationale: "ROAS looks good." }, "ch1");
    expect(inc.heldReasons).toEqual(expect.arrayContaining(["SCALE_CRITERIA_NOT_MET", "CPA_ABOVE_ALLOWABLE_ACQUISITION_COST"]));
    w.params.diagnostic.maxTestLossMinor = A(10_000);
    expect(w.control.observe("stage:initial", "o2").safetyTriggers).toContain("MAX_TEST_LOSS_REACHED");
  });

it("unknown: a proposed 20% commission, a cost counted twice or a missing order feed keeps contribution unknown, never zero", async () => {
    const w = await world();
    const { nativeId } = await profitable(w);
    w.orders.push(w.order(4, nativeId, { affiliateAttributed: true }));
    const o = w.control.observe("stage:initial", "o1");
    expect(o.economics).toMatchObject({ canonical: { contributionMinor: null }, allowableAcquisitionCostMinor: null, scale: { state: "unknown" } });
    expect(o.economics.unknownInputs).toContain("PARAMETER_PROPOSED_NOT_ADOPTED:affiliateCommissionBps");
    w.orders.pop();
    w.orders.push(w.order(4, nativeId, { affiliateAttributed: true, commissionAccruedMinor: 1200 }));
    expect(w.control.observe("stage:initial", "o2").economics.canonical).toMatchObject({ contributionMinor: 21_048 + 7016 - 1200, commissionsAccruedMinor: 1200 });
    w.params.contribution.landedCogsPerUnit = A([{ component: "unit-cost", amountMinor: 4000 }, { component: "tariff", amountMinor: 500 }, { component: "tariff", amountMinor: 500 }]);
    expect(w.control.observe("stage:initial", "o3").economics.unknownInputs).toContain("COST_COUNTED_TWICE:tariff");
    w.feed.available = false;
    const missing = w.control.observe("stage:initial", "o4").economics;
    expect(missing.canonical).toMatchObject({ orders: null, contributionMinor: null, retainedMerchandiseMinor: null });
    expect(missing.unknownInputs).toContain("ORDERS_UNAVAILABLE");
    w.feed.available = true; w.feed.complete = false;
    expect(w.control.observe("stage:initial", "o5").economics.canonical.contributionMinor).toBeNull();
  });

it("an open return window needs the adopted return allowance; the unapproved 5% proposal stays unknown", async () => {
    const w = await world();
    const { nativeId } = await profitable(w);
    w.orders.push(w.order(4, nativeId, { returnWindowClosed: false }));
    expect(w.control.observe("stage:initial", "o1").economics.unknownInputs).toContain("PARAMETER_PROPOSED_NOT_ADOPTED:returnAllowanceBps");
    w.params.contribution.returnAllowanceBps = A(500);
    expect(w.control.observe("stage:initial", "o2").economics.canonical.contributionMinor).toBe(21_048 + 7016 - 600);
  });

it("late refund: a refund reported later lowers retained contribution and is recorded as a correction", async () => {
    const w = await world();
    const { nativeId } = await profitable(w);
    w.control.observe("stage:initial", "o1");
    w.orders[0] = w.order(1, nativeId, { refundedMerchandiseMinor: 12_000, refundedShippingMinor: 800, returnedUnits: 1, updatedAt: ago(1) });
    const o = w.control.observe("stage:initial", "o2");
    expect(o.corrections).toEqual([expect.objectContaining({ kind: "late-refund", key: "order|shop:synthetic|order-1", detail: "0 -> 12800" })]);
    // The refunded order keeps its fulfillment, fees and other costs: 0 + 0 − 0 COGS − 800 − 384 − 100 = −1,284.
    expect(o.economics.canonical).toMatchObject({ orders: 3, contributionMinor: 7016 * 2 - 1284, retainedMerchandiseMinor: 24_000 });
    w.orders[0] = w.order(1, nativeId);
    expect(w.control.observe("stage:initial", "o3").economics.canonical.retainedMerchandiseMinor).toBe(24_000);
  });

it("duplicate conversion: native and mirror events for one order count once, and platform purchases never join canonical orders", async () => {
    const w = await world();
    const { nativeId } = await profitable(w);
    const conv = (id: string, channel: string, orderRef: string | null, value = 12_800) => ({ conversionId: id, channel, orderSource: orderRef ? "shop:synthetic" : null,
      orderRef, convertedAt: ago(60 * 24), valueMinor: value });
    w.conversions.set(nativeId, [conv("c1", "native", "order-1"), conv("m1", "mirror", "order-1"), conv("c2", "native", null), conv("c3", "native", "order-2")]);
    const o = w.control.observe("stage:initial", "o1").economics;
    expect(o.platform).toMatchObject({ purchases: 3, duplicatesRemoved: 1, valueMinor: 3 * 12_800, includesOrganicAffiliate: false, incrementalPaidRoas: null, comparable: true });
    expect(o.canonical.orders).toBe(3);
    w.params.attributionWindow = P("attribution:7d-click");
    expect(w.control.observe("stage:initial", "o1b").economics.platform).toMatchObject({ comparable: false, purchases: null, valueMinor: null });
    w.params.attributionWindow = A("attribution:7d-click");
    w.rowOver.set(nativeId, { attributionWindow: "attribution:1d-view" });
    expect(w.control.observe("stage:initial", "o2").economics.platform.excluded).toContain(`ATTRIBUTION_WINDOW_MISMATCH:${nativeId}`);
  });

it("late conversion: a conversion that arrives after a later observation is counted once and recorded", async () => {
    const w = await world();
    const { nativeId } = await profitable(w);
    w.control.observe("stage:initial", "o1");
    await w.advance("2026-11-10T21:00:00Z");
    w.conversions.set(nativeId, [{ conversionId: "late-1", channel: "native", orderSource: "shop:synthetic", orderRef: "order-3", convertedAt: "2026-11-10T17:00:00Z",
      valueMinor: 12_800 }]);
    const o = w.control.observe("stage:initial", "o2");
    expect(o.corrections).toContainEqual(expect.objectContaining({ kind: "late-conversion", key: "order|shop:synthetic|order-3" }));
    expect(o.economics.platform.purchases).toBe(1);
    expect(w.control.observe("stage:initial", "o3").economics.platform.purchases).toBe(1);
  });

it("keeps diagnostic loss separate from scale: no adopted minimum evidence means scale stays unknown", async () => {
    const w = await world();
    await profitable(w);
    w.params.minimumEvidence = P({ orders: 1, spendMinor: 1, days: 0 });
    const o = w.control.observe("stage:initial", "o1").economics;
    expect(o.scale).toMatchObject({ state: "unknown", reasons: ["PARAMETER_PROPOSED_NOT_ADOPTED:minimumEvidence"] });
    expect(o.diagnostic.state).toBe("within");
  });

it("rights revoked, failed checkout, unavailable permission and untrustworthy measurement trigger; unknown health only holds", async () => {
    const w = await world();
    await launched(w);
    w.health.rights = { state: "failed", code: "rights:revoked" };
    w.health.checkout = { state: "failed", code: "checkout:payment-failed" };
    w.health.permission = { state: "failed", code: "permission:revoked" };
    w.health.measurement = { state: "failed", code: "measurement:dedup-broken" };
    expect(w.control.observe("stage:initial", "o1").safetyTriggers).toEqual(["CHECKOUT_FAILED", "RIGHTS_REVOKED_OR_EXPIRED", "PERMISSION_UNAVAILABLE",
      "MEASUREMENT_UNTRUSTWORTHY"]);
    for (const k of ["rights", "checkout", "permission", "measurement"]) delete w.health[k];
    w.health.rights = { validUntil: ago(1) };
    const o = w.control.observe("stage:initial", "o2");
    expect(o).toMatchObject({ safetyTriggers: [], holds: ["HEALTH_UNKNOWN:rights", "CANONICAL_STAGE_REVALIDATION_REQUIRED"] });
  });

it("exhausted cap: spend at the allocation cap triggers a pause", async () => {
    const w = await world();
    const { nativeId } = await launched(w);
    w.spend.set(nativeId, 66_000);
    w.rowOver.set(nativeId, { lifetimeBudgetMinor: 75_000 });
    w.params.diagnostic.maxTestLossMinor = A(1_000_000);
    const o = w.control.observe("stage:initial", "o1");
    expect(o.safetyTriggers).toEqual(expect.arrayContaining([`NATIVE_CAP_EXCEEDS_APPROVED:${w.media.read(w.control.read("stage:initial")!.reservations[0]!.campaignId)!.campaignId}`]));
    w.rowOver.delete(nativeId);
    w.spend.set(nativeId, 75_000);
    expect(w.control.observe("stage:initial", "o2").safetyTriggers).toEqual(expect.arrayContaining([`ALLOCATION_CAP_EXHAUSTED:meta:${META}`]));
  });

it("R4 keeps GMV Max orders out of paid-incremental CPA unless incremental evidence is adopted", async () => {
    const w = await world();
    const { nativeId } = await profitable(w);
    w.rowOver.set(nativeId, { includesOrganicAffiliate: true });
    const o = w.control.observe("stage:initial", "o1").economics;
    expect(o).toMatchObject({ canonical: { orders: 3 }, incrementalPaidOrders: 0 });
    expect(o.canonicalCpaMinor).toBeNull();
    expect(o.scale.state).toBe("unknown");
    expect(o.scale.reasons).toContain(`NOT_INCREMENTAL_PAID:${nativeId}`);
    expect(o.platform).toMatchObject({ includesOrganicAffiliate: true, incrementalPaidRoas: null });
    (w.params as Record<string, unknown>).incrementalEvidence = A([{ provider: "meta", providerAccountRef: META, environment: "sandbox", nativeCampaignId: nativeId,
      evidenceRef: "lift:synthetic-holdout" }]);
    expect(w.control.observe("stage:initial", "o2").economics).toMatchObject({ canonical: { orders: 3 }, incrementalPaidOrders: 3, canonicalCpaMinor: 5000, scale: { state: "met" } });
  });

it("R5 counts media spend accrued but not yet charged against the founder cash ceiling, once", async () => {
    const w = await world();
    await profitable(w);
    Object.assign(w.treasury, { founderInvestedMinor: 3_000_000, commitmentsMinor: 1_252_000 });
    const unbilled = w.control.observe("stage:initial", "o1").treasury;
    expect(unbilled).toMatchObject({ state: "exceeds", mediaExposureMinor: 150_000, mediaChargedMinor: 0, projectedFounderInvestedMinor: 4_002_000 });
    Object.assign(w.treasury, { mediaChargedMinor: 15_000 });
    expect(w.control.observe("stage:initial", "o2").treasury).toMatchObject({ state: "within", mediaExposureMinor: 135_000, projectedFounderInvestedMinor: 3_987_000 });
    Object.assign(w.treasury, { mediaChargedMinor: null });
    expect(w.control.observe("stage:initial", "o3").treasury.reasons).toContain("TREASURY_MEDIA_CHARGED_UNKNOWN");
  });

it("R6 holds on null spend after an out-of-order report, and fails closed when the campaign record is unreadable", async () => {
    const w = await world();
    const { c, nativeId } = await launched(w);
    w.spend.set(nativeId, 20_000);
    w.control.observe("stage:initial", "o0");
    w.reportOver.set(META, { sourceUpdatedAt: ago(60), observedAt: ago(50) });
    const o = w.control.observe("stage:initial", "o1");
    expect(o.holds).toContain(`SPEND_UNKNOWN:${c.campaignId}`);
    expect(o.exposure.reasons).toContain(`SPEND_STALE:${c.campaignId}`);
    w.reportOver.delete(META);
    w.store.database.prepare("UPDATE media_campaigns SET body=? WHERE campaign_id=?").run("{", c.campaignId);
    expect(w.control.observe("stage:initial", "o2").holds).toContain(`CAMPAIGN_RECORD_UNAVAILABLE:${c.campaignId}`);
  });

it("R6 keeps the stage ordinal column in step with a re-proposal and never surfaces a raw UNIQUE error", async () => {
    const w = await world();
    w.control.proposeStage(w.terms({ stageRef: "stage:a", ordinal: 2 }), "s1");
    expect(w.control.proposeStage(w.terms({ stageRef: "stage:a", ordinal: 3, capMinor: 300_000 }), "s2")).toMatchObject({ ordinal: 3, revision: 2 });
    expect(w.control.proposeStage(w.terms({ stageRef: "stage:b", ordinal: 2 }), "s3")).toMatchObject({ ordinal: 2, state: "awaiting-approval" });
    expect(() => w.control.proposeStage(w.terms({ stageRef: "stage:c", ordinal: 3, capMinor: 300_000 }), "s4")).toThrow("STAGE_ORDINAL_TAKEN");
  });

it("R6 resolves a gates-not-verified incident once the media record shows every gate verified", async () => {
    const w = await world();
    const { c } = await launched(w);
    const db = w.store.database;
    const stage = JSON.parse(String(db.prepare("SELECT body FROM media_control_stages WHERE stage_ref=?").get("stage:initial")!.body));
    stage.incidents.push({ code: "GATES_NOT_VERIFIED_AT_PUBLISH", campaignId: c.campaignId, at: clock.toISOString(), decisionRef: stage.decisionRef, resolvedAt: null });
    db.prepare("UPDATE media_control_stages SET body=? WHERE stage_ref=?").run(JSON.stringify(stage), "stage:initial");
    const row = db.prepare("SELECT reservation_id, body FROM media_control_reservations WHERE campaign_id=?").get(c.campaignId)!;
    const r = JSON.parse(String(row.body));
    r.gates = [{ gate: "qualified-product-stock", state: "missing" }];
    db.prepare("UPDATE media_control_reservations SET body=? WHERE reservation_id=?").run(JSON.stringify(r), row.reservation_id as string);
    expect(w.control.observe("stage:initial", "o1").holds).not.toContain(`INCIDENT_OPEN:GATES_NOT_VERIFIED_AT_PUBLISH`);
    const after = w.control.read("stage:initial")!;
    expect(after.incidents[0]!.resolvedAt).not.toBeNull();
    expect(after.reservations[0]!.gates.every((g) => g.state === "verified")).toBe(true);
  });

it("S7 compares a budget change with the fresh reported budget, and treats an unreported campaign's incrementality as unknown", async () => {
    const w = await world();
    const { c, nativeId } = await profitable(w);
    w.rowOver.set(nativeId, { dailyBudgetMinor: 900 });
    expect(w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "reduce-budget", dailyBudgetMinor: 1000, rationale: "Slow down." }, "ch1").heldReasons)
      .toContain("NOT_A_REDUCTION");
    w.rowOver.delete(nativeId);
    w.reportOver.set(META, { campaigns: [] });
    const o = w.control.observe("stage:initial", "o1").economics;
    expect(o.incrementalPaidOrders).toBe(0);
    expect(o.scale.reasons).toContain(`INCREMENTALITY_UNKNOWN:${nativeId}`);
  });
});
