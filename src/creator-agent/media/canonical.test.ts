// @vitest-environment node
import {describe,it,expect} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {canonicalMediaFixture} from "./canonicalFixture.testkit.ts";
import {MEDIA_STAGE_ACTION} from "./canonicalContract.ts";

describe("media consumers use canonical J04 and the existing runner",()=>{
  it("records one shared stage authorization and creates/publishes native account campaigns through actual proofs",async()=>{
    const f=await canonicalMediaFixture();
    try{const stage=await f.run(MEDIA_STAGE_ACTION,f.stage.stageRef);expect(stage.executionCertainty).toBe("applied");
      const c=f.kernel.prepare();const draft=await f.run("media.createDraft",c.campaignId);expect(draft.executionCertainty).toBe("applied");
      const published=await f.run("media.publish",c.campaignId);expect(published.executionCertainty).toBe("applied");
      expect(f.state.calls).toBe(2);expect(f.kernel.media.read(c.campaignId)?.native.status).toBe("ACTIVE");
      expect(f.kernel.control.read(f.stage.stageRef)?.reservations[0]?.plannedMaxMinor).toBe(66000);
    }finally{f.approval.db.close();}
  });
});

async function publishedFixture(){const f=await canonicalMediaFixture();await f.run(MEDIA_STAGE_ACTION,f.stage.stageRef);const c=f.kernel.prepare();await f.run("media.createDraft",c.campaignId);await f.run("media.publish",c.campaignId);return{f,c};}
describe("mandatory media safety regressions with real positive effects",()=>{
  it("keeps a malformed missing draft lookup uncertain across new keys and restores only the original keyed native receipt",async()=>{
    const f=await canonicalMediaFixture();try{const c=f.kernel.prepare(),a=await f.approve("media.createDraft",c.campaignId),run=await f.handoff(a);f.state.lostAck=true;
      expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");expect(f.state.calls).toBe(1);expect(f.kernel.native.size).toBe(1);
      f.state.malformed=true;expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");
      const saved=JSON.parse(String(f.approval.db.prepare("SELECT body FROM media_campaigns WHERE campaign_id=?").get(c.campaignId)!.body));
      expect(()=>f.kernel.media.prepare({...saved.input,expiresAt:"2026-11-21T00:00:00Z"},"new-body")).toThrow("CAMPAIGN_IN_PROGRESS");
      expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");expect(f.state.calls).toBe(1);
      f.state.malformed=false;f.state.lostAck=false;expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");expect(f.kernel.media.read(c.campaignId)?.native.status).toBe("PAUSED");
    }finally{f.approval.db.close();}
  });
  it("does not publish after final source-read revocation; original pending attempt is retained without a second send",async()=>{
    const f=await canonicalMediaFixture();try{await f.run(MEDIA_STAGE_ACTION,f.stage.stageRef);const c=f.kernel.prepare();await f.run("media.createDraft",c.campaignId);
      const a=await f.approve("media.publish",c.campaignId),run=await f.handoff(a);let reads=0;f.state.afterRead=()=>{if(++reads===2)f.state.deny=true;};
      const result=await f.dispatch.execute(run.runRef);expect(result.executionCertainty).not.toBe("applied");expect(f.state.calls).toBe(1);expect(f.kernel.media.read(c.campaignId)?.native.status).toBe("PAUSED");
    }finally{f.approval.db.close();}
  });
  it("retains a late publish receipt historically after a genuinely approved finite pause, without undoing native PAUSED",async()=>{
    const f=await canonicalMediaFixture();try{await f.run(MEDIA_STAGE_ACTION,f.stage.stageRef);const c=f.kernel.prepare();await f.run("media.createDraft",c.campaignId);
      const a=await f.approve("media.publish",c.campaignId),run=await f.handoff(a);f.state.lostAck=true;expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");
      // Read-only reconciliation learns the original native identity before a separately finite pause is proposed.
      f.state.lostAck=false;expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");
      const pause=f.kernel.media.proposeMutation(c.campaignId,{kind:"pause",dailyBudgetMinor:null},"pause-intent");expect((await f.run("media.pause",pause.mutationId)).executionCertainty).toBe("applied");
      const before=f.state.calls;expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");expect(f.state.calls).toBe(before);
      expect([...f.kernel.native.values()][0]?.status).toBe("PAUSED");expect(f.kernel.media.read(c.campaignId)?.native.status).toBe("PAUSED");
    }finally{f.approval.db.close();}
  });
  it("blocks a genuinely approved budget increase when product gates fail, while separately approved pause stays possible",async()=>{
    const {f,c}=await publishedFixture();try{await f.profitable(c.campaignId);const m=f.kernel.media.proposeMutation(c.campaignId,{kind:"edit-budget",dailyBudgetMinor:3000},"increase-intent"),a=await f.approve("media.changeBudget",m.mutationId),run=await f.handoff(a);
      f.state.failedGate=true;await expect(f.dispatch.execute(run.runRef)).rejects.toThrow("APPROVAL_SOURCE_UNAVAILABLE");expect(f.state.calls).toBe(2);expect([...f.kernel.native.values()][0]?.dailyBudgetMinor).toBe(2000);
      const pause=f.kernel.media.proposeMutation(c.campaignId,{kind:"pause",dailyBudgetMinor:null},"pause-gate-failed");expect((await f.run("media.pause",pause.mutationId)).executionCertainty).toBe("applied");expect(f.state.calls).toBe(3);
    }finally{f.approval.db.close();}
  });
  it("revalidates the original shared stage decision instead of trusting a stored released state",async()=>{
    const f=await canonicalMediaFixture();try{await f.run(MEDIA_STAGE_ACTION,f.stage.stageRef);const c=f.kernel.prepare();await f.run("media.createDraft",c.campaignId);
      const event=[...f.approval.events.values()].find(e=>e.approvalRef===f.kernel.control.canonicalStageRequest(f.stage.stageRef).canonical!.binding.approvalRef)!;event.decision="rejected";
      await expect(f.approve("media.publish",c.campaignId)).rejects.toThrow();expect(f.state.calls).toBe(1);expect(f.kernel.control.read(f.stage.stageRef)?.reservations).toHaveLength(0);
    }finally{f.approval.db.close();}
  });
});

describe("shared pool, exact native attempts and finite safety authority",()=>{
  it("keeps the initial authorization one $1500 pool across both accounts, including pending exposure",async()=>{
    const f=await canonicalMediaFixture();try{await f.releaseStage();const meta=await f.draft("meta"),tiktok=await f.draft("tiktok");
      await f.launch(meta.campaignId);await f.launch(tiktok.campaignId);
      const reservations=f.kernel.control.read(f.stage.stageRef)!.reservations;expect(reservations.map(r=>r.plannedMaxMinor)).toEqual([66000,66000]);expect(reservations.reduce((n,r)=>n+r.plannedMaxMinor,0)).toBe(132000);
      const more=await f.draft("meta",10000),approval=await f.approve("media.publish",more.campaignId);const blocked=await f.handoff(approval);await expect(f.dispatch.execute(blocked.runRef)).rejects.toThrow("STAGE_AUTHORIZATION_EXHAUSTED");expect(f.state.calls).toBe(5);
    }finally{f.approval.db.close();}
  });
  it("checks native version and safety generation atomically when a real finite pause wins during publication",async()=>{
    const f=await canonicalMediaFixture();try{await f.releaseStage();const c=await f.draft();const publication=await f.handoff(await f.approve("media.publish",c.campaignId));
      const p=f.kernel.media.proposeMutation(c.campaignId,{kind:"pause",dailyBudgetMinor:null},"finite-pause-before-publish"),pause=await f.handoff(await f.approve("media.pause",p.mutationId));
      f.state.beforeEffect=async()=>{f.state.beforeEffect=null;expect((await f.dispatch.execute(pause.runRef)).executionCertainty).toBe("applied");};
      expect((await f.dispatch.execute(publication.runRef)).executionCertainty).toBe("uncertain");expect(f.state.calls).toBe(2);
      expect([...f.kernel.native.values()][0]?.status).toBe("PAUSED");expect(f.kernel.media.read(c.campaignId)?.native.status).toBe("PAUSED");
      expect((await f.dispatch.reconcile(publication.runRef)).executionCertainty).toBe("uncertain");expect(f.state.calls).toBe(2);
    }finally{f.approval.db.close();}
  });
  it("requires exact positive original-attempt closure before a second attempt and never closes by absence",async()=>{
    const f=await canonicalMediaFixture();try{const c=f.kernel.prepare(),r=await f.handoff(await f.approve("media.createDraft",c.campaignId));f.state.failBefore=true;
      expect((await f.dispatch.execute(r.runRef)).executionCertainty).toBe("uncertain");expect((await f.dispatch.reconcile(r.runRef)).executionCertainty).toBe("uncertain");expect(f.state.calls).toBe(1);
      f.state.terminal=true;expect((await f.dispatch.reconcile(r.runRef)).executionCertainty).toBe("notApplied");f.state.failBefore=false;f.state.terminal=false;
      expect((await f.dispatch.execute(r.runRef)).executionCertainty).toBe("applied");expect(f.state.calls).toBe(2);expect(f.kernel.native.size).toBe(1);
    }finally{f.approval.db.close();}
  });
  it("keeps original native receipt and attempt while current read permission is denied",async()=>{
    const f=await canonicalMediaFixture();try{const c=f.kernel.prepare(),r=await f.handoff(await f.approve("media.createDraft",c.campaignId));f.state.lostAck=true;
      await f.dispatch.execute(r.runRef);f.state.denyRead=true;await expect(f.dispatch.reconcile(r.runRef)).rejects.toMatchObject({status:403,executionCertainty:"uncertain"});
      expect(f.state.calls).toBe(1);f.state.denyRead=false;expect((await f.dispatch.reconcile(r.runRef)).executionCertainty).toBe("applied");expect(f.state.calls).toBe(1);
    }finally{f.approval.db.close();}
  });
  it("holds impossible source times and unknown/wrong scope instead of fabricating readiness",async()=>{
    const f=await canonicalMediaFixture();try{const c=f.kernel.prepare(),original=f.source.readBasis;
      for(const mutation of [(s:Record<string,unknown>)=>({...s,observedAt:"2026-11-06T00:00:00+99:99"}),(s:Record<string,unknown>)=>({...s,scope:{...f.scope,accountId:"other-account"}}),(s:Record<string,unknown>)=>({...s,permission:{state:"unknown"}})]){
        f.source.readBasis=async input=>mutation(await original(input) as Record<string,unknown>);await expect(f.approve("media.createDraft",c.campaignId)).rejects.toThrow();}
      expect(f.state.calls).toBe(0);
    }finally{f.approval.db.close();}
  });
});

describe("durable original identities and receipt integrity",()=>{
  it("does not let a delayed old closure release the next attempt's uncertain live exposure",async()=>{
    const f=await canonicalMediaFixture();try{await f.releaseStage();const c=await f.draft(),run=await f.handoff(await f.approve("media.publish",c.campaignId));f.state.failBefore=true;
      expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");f.state.terminal=true;
      let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});const original=f.source.readOperation;let reads=0;
      f.source.readOperation=async id=>{const result=await original(id);if(++reads===1){started();await wait;}return result;};
      const late=f.dispatch.reconcile(run.runRef).then(value=>({value}),error=>({error}));await ready;
      expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("notApplied");f.state.failBefore=false;f.state.terminal=false;f.state.lostAck=true;
      expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");expect(f.kernel.control.read(f.stage.stageRef)?.reservations[0]?.state).toBe("pending");
      release();expect(await late).toMatchObject({error:{message:"DISPATCH_CLOSURE_ATTEMPT_MISMATCH"}});
      expect(f.kernel.control.read(f.stage.stageRef)?.reservations[0]).toMatchObject({state:"pending",plannedMaxMinor:66000});expect([...f.kernel.native.values()][0]?.status).toBe("ACTIVE");expect(f.state.calls).toBe(3);
      expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");expect(f.kernel.control.read(f.stage.stageRef)?.reservations[0]?.state).toBe("committed");expect(f.state.calls).toBe(3);
      const settled=f.approval.db.prepare("SELECT body FROM media_control_reservations WHERE campaign_id=? AND active=1").get(c.campaignId)?.body;
      f.approval.state.now+=1000;await f.dispatch.reconcile(run.runRef);
      expect(f.approval.db.prepare("SELECT body FROM media_control_reservations WHERE campaign_id=? AND active=1").get(c.campaignId)?.body).toBe(settled);
    }finally{f.approval.db.close();}
  });
  it.each(["pause","edit-budget"] as const)("keeps a native %s rejection terminal and distinct from the requested business effect",async kind=>{
    const {f,c}=await publishedFixture();try{const m=f.kernel.media.proposeMutation(c.campaignId,{kind,dailyBudgetMinor:kind==="pause"?null:1000},`rejected-${kind}`),run=await f.handoff(await f.approve(kind==="pause"?"media.pause":"media.changeBudget",m.mutationId));
      f.state.rejected=true;const rejected=await f.dispatch.execute(run.runRef);expect(rejected.executionCertainty).toBe("applied");expect(rejected.receipt?.providerOutcome).toEqual({state:"rejected",reasonCode:"PROVIDER_REJECTED"});
      expect(f.kernel.media.readMutation(c.campaignId,m.mutationId)).toMatchObject({state:"provider-rejected",providerRejectionCode:"synthetic-rejection",before:{status:"ACTIVE",dailyBudgetMinor:2000},after:{status:"ACTIVE",dailyBudgetMinor:2000}});
      expect((await f.dispatch.reconcile(run.runRef)).receipt).toEqual(rejected.receipt);expect((await f.dispatch.execute(run.runRef)).receipt).toEqual(rejected.receipt);expect(f.state.calls).toBe(3);
    }finally{f.approval.db.close();}
  });
  it("reconciles after an actual SQLite close/reopen using the original attempt and no second provider call",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"media-canonical-"));let f=await canonicalMediaFixture(join(directory,"state.sqlite"));
    try{const c=f.kernel.prepare(),run=await f.handoff(await f.approve("media.createDraft",c.campaignId));f.state.lostAck=true;await f.dispatch.execute(run.runRef);
      expect(f.state.calls).toBe(1);const provider={results:[...f.results],intents:[...f.intents],native:[...f.kernel.native],versions:[...f.versions]};f.approval.db.close();
      f=await canonicalMediaFixture(join(directory,"state.sqlite"));for(const [k,v]of provider.results)f.results.set(k,v);for(const[k,v]of provider.intents)f.intents.set(k,v);for(const[k,v]of provider.native)f.kernel.native.set(k,v);for(const[k,v]of provider.versions)f.versions.set(k,v);
      const restored=await f.dispatch.reconcile(run.runRef);expect(restored.executionCertainty).toBe("applied");expect(restored.dispatchKey).toBe(run.dispatchKey);expect(f.state.calls).toBe(0);expect(f.kernel.native.size).toBe(1);
    }finally{f.approval.db.close();rmSync(directory,{recursive:true,force:true});}
  });
  it("does not accept a closure for another attempt or an expired closure",async()=>{
    const f=await canonicalMediaFixture();try{const c=f.kernel.prepare(),run=await f.handoff(await f.approve("media.createDraft",c.campaignId));f.state.failBefore=true;await f.dispatch.execute(run.runRef);f.state.terminal=true;
      const original=f.source.readOperation;f.source.readOperation=async identity=>({...await original(identity) as object,attemptNumber:identity.attemptNumber+1});
      expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");
      f.source.readOperation=async identity=>({...await original(identity) as object,validUntil:"2026-11-01T00:00:00Z"});expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");
      expect(f.state.calls).toBe(1);f.source.readOperation=original;expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("notApplied");
    }finally{f.approval.db.close();}
  });
  it("records receipt reuse after a native send as uncertain, never a second current receipt or stuck applying",async()=>{
    const f=await canonicalMediaFixture();try{await f.releaseStage();const c=await f.draft(),prior=[...f.results.values()].find(r=>r.state==="applied")!;
      const run=await f.handoff(await f.approve("media.publish",c.campaignId)),perform=f.source.perform;
      f.source.perform=async input=>({...await perform(input) as object,receiptRef:prior.state==="applied"?prior.receiptRef:"unreachable"});
      expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");expect(f.kernel.media.read(c.campaignId)).toMatchObject({state:"uncertain",heldReasons:["MEDIA_RECEIPT_REUSED"]});
      expect(f.state.calls).toBe(2);expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");expect(f.state.calls).toBe(2);
    }finally{f.approval.db.close();}
  });
});
