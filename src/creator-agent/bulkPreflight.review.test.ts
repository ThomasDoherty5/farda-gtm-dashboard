// @vitest-environment node
import { expect,it } from "vitest";
import { bulkFixture } from "./bulk/fixtures.testkit.ts";
import { DispatchError } from "./jobs/dispatchSchema.ts";
import { digest } from "./config.ts";

it("a historical accepted payment cannot be imported into a new recruitment manifest",async()=>{
  const w=bulkFixture();try{
    const command=await w.command();w.packet.groups[0]!.draft!.historicalLiability={sourceRef:"fictional-accepted-liability",sourceVersion:"v1",acceptedMinor:10000,currency:"USD",validUntil:w.a.until()};w.seal();
    await expect(w.repo.preparePreview(command,w.principal,"fictional-historical-recruitment")).rejects.toThrow("BULK_MANIFEST_BINDING_INVALID");
    expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);expect(w.state.calls).toHaveLength(0);
  }finally{w.a.db.close();}
});

it("mixed finite work retains suppressed and duplicate rows, throttling, cancellation and original uncertain receipt recovery with exact counts",async()=>{
  const w=bulkFixture();try{
    w.packet.rows[22]!.blockers.push({code:"SUPPRESSED",groupRef:null},{code:"POLICY_HELD",groupRef:null});
    w.packet.rows[23]!.recipientRef=w.packet.rows[21]!.recipientRef;
    const draft=w.packet.groups[0]!.draft!;draft.items=draft.items.slice(0,22);draft.bounds.maxItems=22;draft.payloadHash=digest(draft.items.map(i=>i.payloadHash));w.seal();
    const sample=await w.queue(1);await w.dispatch.execute(sample.runRef);
    const run=await w.queue(),first=run.items[0]!,throttle=run.items[2]!.dispatchKey,original=w.resources.resolveGrants;
    const target=w.packet.groups[0]!.draft!.items.find(i=>i.itemRef===first.intent.approval.itemRef)!.targetRef;w.state.uncertain.add(target);
    w.resources.resolveGrants=async request=>{if(request.dispatchKey===throttle)throw new DispatchError("SOURCE_RATE_LIMITED",429,"notApplied",1000);return original(request);};
    await expect(w.dispatch.execute(run.runRef)).rejects.toMatchObject({code:"SOURCE_RATE_LIMITED"});
    const mixed=(await w.bulk.read(w.filters,w.principal)).data;
    expect(mixed.aggregateCounts).toEqual({snapshot:24,confirmed:1,failed:0,blocked:2,deferred:1,uncertain:1,canceled:0,ready:19});
    expect(mixed.primaryCounts.reduce((n,r)=>n+r.count,0)).toBe(2);
    expect(mixed.rows.find(r=>r.allBlockers.includes("SUPPRESSED"))!.allBlockers).toEqual(["SUPPRESSED","POLICY_HELD"]);
    expect(mixed.rows.some(r=>r.allBlockers.includes("DUPLICATE_RECIPIENT"))).toBe(true);
    w.dispatch.control(run.runRef,w.dispatch.read(run.runRef).revision,"pause");const calls=w.state.calls.length;await w.dispatch.execute(run.runRef);expect(w.state.calls).toHaveLength(calls);
    w.dispatch.control(run.runRef,w.dispatch.read(run.runRef).revision,"cancel");
    expect((await w.bulk.read(w.filters,w.principal)).data.aggregateCounts).toEqual({snapshot:24,confirmed:1,failed:0,blocked:2,deferred:0,uncertain:1,canceled:20,ready:0});
    const attempt=w.state.calls.find(c=>c.dispatchKey===first.dispatchKey)!;
    w.state.receipts.set(first.dispatchKey,{receiptRef:"fictional-mixed-original-confirmed",dispatchKey:first.dispatchKey,payloadHash:first.intent.approval.payloadHash,handlerRef:first.intent.handlerRef,providerBindingHash:attempt.providerBindingHash,sourceEffect:"localArtifact",observedAt:w.a.at()});
    w.restart();await w.dispatch.reconcile(run.runRef);
    const final=(await w.bulk.read(w.filters,w.principal)).data;
    expect(final.aggregateCounts).toEqual({snapshot:24,confirmed:2,failed:0,blocked:2,deferred:0,uncertain:0,canceled:20,ready:0});
    expect(final.rowReceipts).toHaveLength(14);expect(final.sampleCommitments).toMatchObject({remainingUnits:0,remainingMinor:0});expect(w.state.calls).toHaveLength(calls);
  }finally{w.a.db.close();}
});

it("actual preflight throttle persists a deferred row and honors the source delay across restart without a new action ID",async()=>{
  const w=bulkFixture();try{
    const run=await w.queue(),original=w.resources.resolveGrants;let throttled=true,resolutions=0;
    const firstKey=run.items[0]!.dispatchKey;
    w.resources.resolveGrants=async request=>{resolutions++;if(throttled&&request.dispatchKey===firstKey)throw new DispatchError("SOURCE_RATE_LIMITED",429,"notApplied",1000);return original(request);};
    await expect(w.dispatch.execute(run.runRef)).rejects.toMatchObject({code:"SOURCE_RATE_LIMITED",retryAfterMs:1000,executionCertainty:"notApplied"});
    const held=w.dispatch.read(run.runRef,false),first=held.run.items.find(i=>i.itemKey===firstKey)!;
    expect(first).toMatchObject({state:"retryWait",attempts:0,reasonCode:"SOURCE_RATE_LIMITED",dueAt:new Date(w.a.state.now+1000).toISOString()});
    const data=(await w.bulk.read(w.filters,w.principal)).data;
    expect(data.aggregateCounts).toMatchObject({snapshot:24,deferred:1,ready:23});
    expect(data.rows.filter(r=>r.state==="deferred")[0]!.allBlockers).toContain("SOURCE_RATE_LIMITED");
    expect(data.recoveryQueue).toContainEqual(expect.objectContaining({runRef:run.runRef,nextAction:"waitForSourceReset"}));
    expect(w.a.db.prepare("SELECT COUNT(*) n FROM job_dispatch_attempts").get()?.n).toBe(0);
    w.restart();await w.dispatch.execute(run.runRef);expect(resolutions).toBe(24);expect(w.state.calls).toHaveLength(23);
    expect(w.state.calls.some(c=>c.dispatchKey===firstKey)).toBe(false);
    w.a.state.now+=1000;throttled=false;await w.dispatch.execute(run.runRef);
    expect(w.state.calls).toHaveLength(24);expect(w.state.calls.filter(c=>c.dispatchKey===firstKey)).toHaveLength(1);
    const sample=await w.queue(1);await w.dispatch.execute(sample.runRef);
    const complete=(await w.bulk.read(w.filters,w.principal)).data;
    expect(complete.aggregateCounts).toEqual({snapshot:24,confirmed:24,failed:0,blocked:0,deferred:0,uncertain:0,canceled:0,ready:0});
    expect(complete.rowReceipts).toHaveLength(36);expect(complete.sampleCommitments).toMatchObject({remainingUnits:0,remainingMinor:0});
  }finally{w.a.db.close();}
});

it("a throttle without an authoritative delay stays held instead of inventing a reset",async()=>{
  const w=bulkFixture();try{
    const run=await w.queue(),firstKey=run.items[0]!.dispatchKey;w.resources.resolveGrants=async()=>{throw new DispatchError("SOURCE_RATE_LIMITED",429);};
    await expect(w.dispatch.execute(run.runRef)).rejects.toMatchObject({code:"SOURCE_RATE_LIMITED"});
    expect(w.dispatch.read(run.runRef,false).run.items.find(item=>item.itemKey===firstKey)).toMatchObject({state:"held",attempts:0,reasonCode:"SOURCE_RATE_LIMITED"});
    expect((await w.bulk.read(w.filters,w.principal)).data.aggregateCounts).toMatchObject({snapshot:24,blocked:1,deferred:0,ready:23});
    expect(w.state.calls).toHaveLength(0);
  }finally{w.a.db.close();}
});

it.each(["receipt","uncertainty","cancel","pause"] as const)("a late preflight failure cannot overwrite a concurrent %s",async(outcome)=>{
  const w=bulkFixture();try{
    const run=await w.queue(),original=w.resources.resolveGrants;let entered!:()=>void,release!:()=>void,blocked=false;
    const waiting=new Promise<void>(r=>{entered=r;}),resume=new Promise<void>(r=>{release=r;});
    w.resources.resolveGrants=async request=>{if(!blocked){blocked=true;entered();await resume;throw new DispatchError("SOURCE_RATE_LIMITED",429,"notApplied",1000);}return original(request);};
    const pending=w.dispatch.execute(run.runRef);await waiting;
    if(outcome==="uncertainty")for(const row of w.packet.rows)w.state.uncertain.add(row.recipientRef);
    if(outcome==="receipt"||outcome==="uncertainty")await w.dispatch.execute(run.runRef);else w.dispatch.control(run.runRef,w.dispatch.read(run.runRef).revision,outcome);
    const before=w.dispatch.read(run.runRef,false);release();await expect(pending).rejects.toMatchObject({code:"SOURCE_RATE_LIMITED",executionCertainty:before.executionCertainty});
    const after=w.dispatch.read(run.runRef,false);expect(after.run.items).toEqual(before.run.items);expect(after.items).toEqual(before.items);expect(after.run.control).toBe(before.run.control);
    expect(w.state.calls).toHaveLength(outcome==="receipt"||outcome==="uncertainty"?24:0);
  }finally{w.a.db.close();}
});
