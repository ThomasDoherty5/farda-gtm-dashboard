// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { approvalFixture, approvalTestScope } from "../approvals/fixtures.testkit.ts";
import { ApprovalRepository } from "../approvals/repository.ts";
import { actionDomainFixture, actionTestScope, actionTestSecret, exportFixturePayload, founderFixture } from "../actions/fixtures.testkit.ts";
import { createActionDomainServices } from "../actions/domainServices.ts";
import { AgentStore } from "../store.ts";
import type { DispatchContext, DispatchHandler } from "../jobs/dispatchSchema.ts";
import { createSettlementReader } from "./reader.ts";
import { settlementSourceFixture } from "./fixtures.testkit.ts";
import { createSettlementActionDomain, settlementMatchDigest, settlementLedgerSource, SETTLEMENT_MATCH_HANDLER } from "./proposalBridge.ts";
const close:(()=>void)[]=[];afterEach(()=>{for(const fn of close.splice(0))fn();});
function matching(){const a=approvalFixture();close.push(()=>a.db.close());const f=settlementSourceFixture(approvalTestScope,a.state.now),r=f.records[0]!;
  Object.assign(a.draft,{actionKind:"settlement.matchStatement",phase:"other",acquisitionTerms:null,providerAccountRef:r.accountRef,sourceBasisRef:r.ref,sourceBasisVersion:r.version,payloadHash:settlementMatchDigest(r,[r.candidates[0]!.ref]),effects:{spendsMoney:false,sendsCreator:false,changesPolicy:false}});
  Object.assign(a.draft.items[0]!,{itemRef:r.candidates[0]!.ref,targetRef:r.candidates[0]!.ref,targetVersion:r.version,payloadHash:a.draft.payloadHash});
  const na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Fictional statement matching has no money or stock effect."};
  const handler:DispatchHandler={policyVersion:a.policy.version,idempotency:"source-enforced",sourceEffect:"providerApplied",
    provider:{state:"required",binding:{...approvalTestScope,provider:"collabs",providerAccountId:r.accountRef,action:"matchStatement",mode:"executeApproved",route:"api",routeRef:"route:synthetic",authorizationScopeVersion:"v1",toolVersion:"v1",requiredScopes:["statement.match"],connectionRef:null,secretRef:null}},
    resources:()=>({budget:na,stock:na,quota:na}),budgets:{maxItems:10,maxSteps:10,maxAttempts:2,maxRunMs:10000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0},execute:async()=>({state:"unknown",reasonCode:"J11_EXECUTOR_UNBOUND"}),reconcile:async()=>({state:"unknown",reasonCode:"J11_EXECUTOR_UNBOUND"})};
  const bindings={source:f.source,matching:{actionKind:"settlement.matchStatement" as const,registry:a.options.registry,handler}};
  const reader=createSettlementReader({db:a.db,scope:approvalTestScope,secret:"fictional-key",bindings,now:()=>a.state.now});
  const domain=createSettlementActionDomain(reader,bindings)!;const repo=new ApprovalRepository(a.db,{...a.options,registry:domain.registry});
  const command={actionKind:"settlement.matchStatement",entityRef:reader.reference("settlement",r.ref),entityVersion:reader.alias("version",r.version),selectionRefs:[reader.alias("candidate",r.candidates[0]!.ref)],expectedVersion:0};
  return{a,f,reader,domain,repo,command,bindings,handler};
}
it("persists exact statement selection in the actual canonical J04 request; neither paid nor reconciled",async()=>{const w=matching(),actor={principalRef:"synthetic:requester"};
  const p=await w.repo.preparePreview(w.command,actor,"match-one");expect(p.manifest.draft.payloadHash).toBe(w.a.draft.payloadHash);
  expect(p.manifest.items.map(item=>item.itemRef)).toEqual(w.command.selectionRefs);
  expect(p.manifest.items[0]!.targetRef).toBe(w.f.records[0]!.candidates[0]!.ref);
  const requested=await w.repo.requestDecision({approvalRef:p.manifest.approvalRef,expectedVersion:1},actor,"match-request");
  expect(requested.request.record).not.toBeNull();expect(requested.decisionReceipt).toBeNull();expect(w.f.records[0]!.accounting.state).toBe("unknown");
  const replay=await w.repo.preparePreview(w.command,actor,"match-one");expect(replay.manifest).toEqual(p.manifest);
  await expect(w.repo.preparePreview({...w.command,selectionRefs:["forged-candidate"]},actor,"match-one")).rejects.toThrow();
});
it("reconstructs owner observations from the canonical manifest after bridge restart without changing its identity",async()=>{
  const w=matching(),p=await w.repo.preparePreview(w.command,{principalRef:"synthetic:requester"},"identity");
  const before=structuredClone(p.manifest),resolve=w.a.options.registry.currentDraft,assert=w.a.options.registry.assertCurrentDraft;
  w.a.options.registry.currentDraft=async(manifest?:typeof p.manifest)=>{expect(manifest).toEqual(before);return resolve();};
  w.a.options.registry.assertCurrentDraft=(manifest,observed,now)=>{expect(manifest).toEqual(before);expect(observed.items[0]!.itemRef).toBe(w.a.draft.items[0]!.itemRef);assert(manifest,observed,now);};
  const restarted=createSettlementActionDomain(w.reader,w.bindings)!;
  const current=await restarted.registry.currentDraft(p.manifest);
  expect(current).toEqual(p.manifest.draft);
  restarted.registry.assertCurrentDraft!(p.manifest,p.manifest.draft,w.a.state.now);
  expect(p.manifest).toEqual(before);
});
it("rejects an owner item identity that cannot be bound to the exact public candidate selection",async()=>{
  const w=matching();w.a.draft.items[0]!.itemRef="unrelated-owner-item";
  await expect(w.repo.preparePreview(w.command,{principalRef:"synthetic:requester"},"bad-owner-identity")).rejects.toThrow("SETTLEMENT_MATCH_ITEM_IDENTITY_INVALID");
});
it("preserves the canonical dispatch context and proof while the owner uses the original raw target",async()=>{
  const w=matching(),actor={principalRef:"synthetic:requester"},p=await w.repo.preparePreview(w.command,actor,"dispatch-identity");
  const request=await w.repo.requestDecision({approvalRef:p.manifest.approvalRef,expectedVersion:1},actor,"request-dispatch-identity");
  const event=w.a.event(request,"approved","synthetic:reviewer");await w.repo.observeDecision(event.locator,{ingressRef:"synthetic:authenticated-ingress"});
  const manifest=p.manifest,item=manifest.items[0]!,draft=manifest.draft;
  const binding={scope:manifest.scope,approvalRef:manifest.approvalRef,manifestVersion:manifest.manifestVersion,manifestHash:manifest.manifestHash,
    itemRef:item.itemRef,itemVersion:item.itemVersion,itemHash:item.itemHash,actionKind:draft.actionKind,providerAccountRef:draft.providerAccountRef,
    payloadHash:item.payloadHash,policyVersion:draft.policyVersion,termsVersion:draft.termsVersion,rightsVersion:draft.rightsVersion,phase:draft.phase};
  const result=await w.repo.resolveCurrentProof(binding);if(result.state!=="verified")throw Error("Fictional canonical approval must be verified");
  const proof=result.proof,context:DispatchContext={attemptRef:"synthetic:attempt",attemptNumber:1,dispatchKey:"synthetic:dispatch",providerBindingHash:"a".repeat(64),
    intent:{approval:binding,handlerRef:SETTLEMENT_MATCH_HANDLER,payloadRef:draft.payloadRef},heartbeat:async()=>"synthetic:heartbeat",
    assertCurrent:()=>w.repo.assertCurrentProof(proof,w.a.state.now),resourceGrants:()=>[],approvalProof:()=>proof};
  w.handler.execute=async received=>{expect(received).toBe(context);expect(received.approvalProof()).toBe(proof);expect(received.intent.approval).toBe(binding);
    expect(received.approvalProof().item.targetRef).toBe(w.f.records[0]!.candidates[0]!.ref);return {state:"unknown",reasonCode:"FICTIONAL_OWNER_NO_EFFECT"};};
  expect(w.domain.handlers.get(SETTLEMENT_MATCH_HANDLER)).toBe(w.handler);
  await w.domain.handlers.get(SETTLEMENT_MATCH_HANDLER)!.execute(context);
});
it("rejects the final bridge fence when source age crosses 24h while draft and source leases remain valid",async()=>{
  const w=matching();w.a.state.now+=24*60*60_000-1;w.f.state.now=w.a.state.now;
  const until=new Date(w.a.state.now+300_000).toISOString();w.a.policy.observedAt=new Date(w.a.state.now).toISOString();w.a.policy.validUntil=until;
  w.a.draft.sourceValidUntil=until;w.a.draft.expiresAt=until;
  for(const gate of Object.values(w.a.draft.gates))if(gate?.state==="satisfied")gate.validUntil=until;
  for(const human of w.a.humans.values()){human.observedAt=new Date(w.a.state.now).toISOString();human.validUntil=until;}
  const p=await w.repo.preparePreview(w.command,{principalRef:"synthetic:requester"},"aged-source");w.a.state.now+=2;
  expect(Date.parse(p.manifest.draft.sourceValidUntil)).toBeGreaterThan(w.a.state.now);
  expect(()=>w.domain.registry.assertCurrentDraft!(p.manifest,p.manifest.draft,w.a.state.now)).toThrow("SETTLEMENT_MATCH_SOURCE_CHANGED");
});
it("refuses candidate conflicts and source version drift before creating an approval",async()=>{const w=matching();w.f.records[0]!.candidates[0]!.problem="duplicate";
  await expect(w.repo.preparePreview(w.command,{principalRef:"synthetic:requester"},"bad")).rejects.toThrow("SETTLEMENT_MATCH_SELECTION_INVALID");});
it("retains current source permission checks after the awaited domain preview",async()=>{const w=matching(),old=w.a.options.registry.resolvePreview;
  w.a.options.registry.resolvePreview=async()=>{const d=await old();w.f.state.denied=true;return d;};
  await expect(w.repo.preparePreview(w.command,{principalRef:"synthetic:requester"},"denied")).rejects.toMatchObject({status:403});});
it("rejects a delegated attempt to add a new money effect",async()=>{const w=matching();w.a.draft.effects.spendsMoney=true;
  await expect(w.repo.preparePreview(w.command,{principalRef:"synthetic:requester"},"money")).rejects.toThrow("SETTLEMENT_MATCH_AUTHORITY_INVALID");});
it("uses existing native export job for all110rows and reauthorizes a reconstructed wrapper after restart",async()=>{
  const fixture=actionDomainFixture(),store=new AgentStore(":memory:",actionTestScope);close.push(()=>store.close());
  const reader=createSettlementReader({db:store.database,scope:actionTestScope,secret:actionTestSecret,now:fixture.now});
  const ledger=settlementLedgerSource(reader,{ledger:fixture.ledger})!;
  const service=createActionDomainServices({db:store.database,scope:actionTestScope,secret:actionTestSecret,...fixture,ledger});
  const receipt=await service.exportLedger(exportFixturePayload,reader.alias("export-version","ledger-v1"),founderFixture,"export-native");
  expect(receipt.rowCount).toBe(110);expect(store.database.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(1);
  const restarted=createActionDomainServices({db:store.database,scope:actionTestScope,secret:actionTestSecret,...fixture,ledger:settlementLedgerSource(reader,{ledger:fixture.ledger})!});
  expect((await restarted.downloadExport(receipt.artifactRef,founderFixture)).body.split("\r\n")).toHaveLength(112);
  fixture.state.denySource=true;await expect(restarted.downloadExport(receipt.artifactRef,founderFixture)).rejects.toMatchObject({status:403});
});
