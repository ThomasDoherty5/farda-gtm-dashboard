// @vitest-environment node
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { bulkFixture } from "./bulk/fixtures.testkit.ts";
import { digest } from "./config.ts";
import type { DispatchRead } from "./jobs/dispatchSchema.ts";

it("four concurrent J13 batches share one source quota instead of multiplying capacity per batch",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"bulk-shared-quota-")),worlds:ReturnType<typeof bulkFixture>[]=[];
  try{
    const jobs:DispatchRead[]=[];
    for(let n=0;n<4;n++){
      const w=bulkFixture({path:join(dir,"shared.sqlite")});worlds.push(w);w.packet.batchRef=`fictional-concurrent-batch-${n}`;
      for(const row of w.packet.rows){row.recipientRef+=`-batch-${n}`;row.payloadHashes=row.payloadHashes.map(hash=>digest([hash,n]));}
      for(const group of w.packet.groups){for(const member of group.members){const row=w.packet.rows.find(r=>r.rowId===member.rowId)!,item=group.draft!.items.find(i=>i.itemRef===member.itemRef)!;item.targetRef=row.recipientRef;item.payloadHash=row.payloadHashes[group.kind==="sampleDecision"?1:0]!;}group.draft!.payloadHash=digest(group.draft!.items.map(i=>i.payloadHash));}
      w.seal();const group=(await w.bulk.read({...w.filters,batchRef:w.packet.batchRef},w.principal)).data.groups[0]!;const command={actionKind:group.actionKind,...group.preview!,expectedVersion:0};
      // The public current selector changes with its explicit source batch, never its target population implicitly.
      const preview=await w.repo.preparePreview(command,w.principal,`fictional-preview-batch-${n}`);
      const request=await w.repo.requestDecision({approvalRef:preview.manifest.approvalRef,expectedVersion:1},w.principal,`fictional-request-batch-${n}`);
      const event=w.a.event(request,"approved","synthetic:founder",`fictional-event-batch-${n}`),approved=await w.repo.observeDecision(event.locator,{ingressRef:"fictional-verified-ingress"});
      jobs.push(await w.dispatch.handoffBatch(w.intentsFor(approved.manifest),{principalRef:w.principal.principalRef,idempotencyKey:`fictional-handoff-batch-${n}`}));
    }
    const results=await Promise.allSettled(worlds.map((w,i)=>w.dispatch.execute(jobs[i]!.runRef)));
    expect(results.some(r=>r.status==="rejected")).toBe(true);
    expect(worlds.reduce((n,w)=>n+w.state.calls.length,0)).toBe(80);
    expect(worlds[0]!.a.db.prepare("SELECT SUM(quantity) n FROM fictional_bulk_grants WHERE dimension='quota'").get()?.n).toBe(80);
    expect(new Set(worlds.flatMap(w=>w.state.calls.map(c=>c.dispatchKey))).size).toBe(80);
  }finally{for(const w of worlds)w.a.db.close();rmSync(dir,{recursive:true,force:true});}
});

it.each(["policy","permission","economics","expiry","capacity"] as const)("postapproval %s change prevents original J13 rows starting after resume",async(change)=>{
  const w=bulkFixture();try{
    const run=await w.queue();w.dispatch.control(run.runRef,run.revision,"pause");
    if(change==="policy")w.a.policy.version="fictional-policy-v2";
    if(change==="permission")w.state.denied=true;
    if(change==="economics"){w.packet.groups[0]!.draft!.acquisitionTerms!.commissionPct=21;w.seal();}
    if(change==="expiry")w.a.state.now=Date.parse(w.packet.expiresAt);
    if(change==="capacity"){w.packet.capacity[0]!.remaining=0;w.seal();}
    w.dispatch.control(run.runRef,w.dispatch.read(run.runRef).revision,"resume");
    await expect(w.dispatch.execute(run.runRef)).rejects.toMatchObject({executionCertainty:"notApplied"});
    expect(w.state.calls).toHaveLength(0);expect(w.a.db.prepare("SELECT COUNT(*) n FROM job_dispatch_attempts").get()?.n).toBe(0);
  }finally{w.a.db.close();}
});

it("invitation can be approved without accepted terms while activation cannot",async()=>{
  const w=bulkFixture();try{
    expect(w.packet.groups[0]!.draft!.gates.acceptedTerms.state).toBe("notApplicable");
    const invitation=await w.approve();expect(invitation.current.state).toBe("approved");
    w.packet.groups[0]!.kind="activation";w.packet.groups[0]!.draft!.phase="activation";w.packet.capacity[0]!.kind="actionQuota";w.packet.capacity.push({...w.packet.capacity[0]!,kind:"activeCollaborations",unit:"collaboration"});w.seal();
    await expect(w.repo.preparePreview(await w.command(),w.principal,"fictional-unaccepted-activation")).rejects.toThrow(/ACCEPTED_TERMS/);
    expect(w.state.calls).toHaveLength(0);
  }finally{w.a.db.close();}
});

it("source confirmation reconciles the original uncertain sample receipt without a second invocation",async()=>{
  const w=bulkFixture();try{
    const run=await w.queue(1);w.state.uncertain.add(w.packet.rows[0]!.recipientRef);await w.dispatch.execute(run.runRef);
    const original=w.state.calls[0]!,calls=w.state.calls.length;
    w.state.receipts.set(original.dispatchKey,{receiptRef:"fictional-original-sample-confirmed",dispatchKey:original.dispatchKey,payloadHash:original.intent.approval.payloadHash,handlerRef:original.intent.handlerRef,providerBindingHash:original.providerBindingHash,sourceEffect:"localArtifact",observedAt:w.a.at()});
    w.restart();const recovered=await w.dispatch.reconcile(run.runRef);expect(recovered.items.every(item=>item.receipt)).toBe(true);expect(w.state.calls).toHaveLength(calls);
    const data=(await w.bulk.read(w.filters,w.principal)).data;expect(data.sampleCommitments).toMatchObject({remainingUnits:0,remainingMinor:0});expect(data.aggregateCounts.uncertain).toBe(0);
    const receipts=recovered.items.map(i=>i.receipt);await w.dispatch.execute(run.runRef);expect(w.dispatch.read(run.runRef).items.map(i=>i.receipt)).toEqual(receipts);expect(w.state.calls).toHaveLength(calls);
  }finally{w.a.db.close();}
});

it.each(["paid","hybrid","gifted","upfront","guaranteed"] as const)("rejects %s recruiting economics before any immutable approval is recorded",async(kind)=>{
  const w=bulkFixture();try{
    const terms=w.packet.groups[0]!.draft!.acquisitionTerms!;
    if(kind==="paid"||kind==="hybrid"||kind==="gifted")terms.relationship=kind;
    if(kind==="upfront")terms.upfrontFeeMinor=1;
    if(kind==="guaranteed")terms.guaranteedFeeMinor=1;
    w.seal();await expect(w.bulk.read(w.filters,w.principal)).rejects.toThrow("BULK_COMMISSION_ONLY_REQUIRED");
    expect(w.a.db.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(0);expect(w.state.calls).toHaveLength(0);
  }finally{w.a.db.close();}
});
