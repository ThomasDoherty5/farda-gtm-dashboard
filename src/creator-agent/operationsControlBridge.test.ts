// @vitest-environment node
import {afterEach,describe,expect,it} from "vitest";
import {approvalFixture,approvalTestScope as scope} from "./approvals/fixtures.testkit.ts";
import {ApprovalRepository,stableApprovalDraft} from "./approvals/repository.ts";
import {createOperations} from "./operations.ts";
import {createProviderHealth} from "./providerHealth.ts";
import {createOperationsControls} from "./operationsControls.ts";
import {controlSourceFixture,controlTestJob} from "./operationsControlsFixtures.ts";
import {createOperationsControlAuthority,operationsAuthoritySnapshotSchema,OperationsAuthorityError,type OperationsAuthoritySnapshot,type OperationsControlAuthoritySource,type OperationsAuthorityTarget} from "./operationsControlAuthority.ts";
import {createOperationsControlBridge,operationsIntentPayloadHash,operationsIntentItemHash,operationsCanonicalActionKinds,type OperationsCanonicalSource,type OperationsControlBridge} from "./operationsControlBridge.ts";
import {DispatchGuard} from "./jobs/dispatchGuard.ts";
import type {DispatchHandler} from "./jobs/dispatchSchema.ts";
import {createActionService} from "./actions/service.ts";
import {digest} from "./config.ts";
import {SCHEMA_VERSION} from "../adapter/contract.ts";

const closes:(()=>void)[]=[];afterEach(()=>closes.splice(0).forEach(close=>close()));
const secret="synthetic-operations-controls-server-key-not-deployment";
const principal={principalRef:"agent-reviewer"};
function setup(){
  const a=approvalFixture();closes.push(()=>a.db.close());
  const human=structuredClone(a.humans.get("synthetic:requester")!);human.principalRef=principal.principalRef;human.personRef="synthetic-person-one";a.humans.set(principal.principalRef,human);
  const ops=createOperations(a.db,scope,{now:()=>a.state.now});ops.jobs.register(controlTestJob,0);
  const health=createProviderHealth(a.db,scope,ops.ledger,ops.jobs,{now:()=>a.state.now});
  const snapshot=controlSourceFixture(scope);snapshot.observedAt=a.at();
  for(const rows of [snapshot.roles,snapshot.tasks,snapshot.takeovers,snapshot.permissions,snapshot.comparisons,snapshot.conflicts,snapshot.reports,snapshot.attribution,snapshot.handoffs,snapshot.runMembership])for(const row of rows)row.observedAt=a.at();
  snapshot.tasks[0]!.ownerRef=human.personRef;
  const target:OperationsAuthorityTarget={kind:"task",id:snapshot.tasks[0]!.id,sourceVersion:snapshot.tasks[0]!.sourceVersion,providerAccountRef:a.draft.providerAccountRef,providerAccountVersion:a.draft.providerAccountVersion,
    ownerPersonRef:human.personRef,permission:"allowed",items:snapshot.tasks[0]!.items.map(item=>({itemRef:item.itemKey,itemVersion:"item-v1",targetRef:item.subjectRef,targetVersion:"subject-v1",sourceRef:item.evidenceRef!,units:0,spendMinor:0}))};
  const state={denied:false,afterRead:null as (()=>void|Promise<void>)|null,afterDraft:null as (()=>void|Promise<void>)|null,effects:0,
    serviceRefs:[] as OperationsAuthoritySnapshot["serviceRefs"]};
  const current=():OperationsAuthoritySnapshot=>({scope,principalRef:principal.principalRef,personRef:human.personRef,directoryVersion:human.directoryVersion,observedAt:a.at(),validUntil:a.until(),permission:state.denied?"denied":"allowed",snapshot:structuredClone(snapshot),targets:[structuredClone(target)],serviceRefs:structuredClone(state.serviceRefs)});
  const source:OperationsControlAuthoritySource={read:async()=>{const value=current();await state.afterRead?.();return value;},assertCurrent:(_request,value)=>{
    if(state.denied)throw new OperationsAuthorityError("OPERATIONS_SOURCE_SCOPE_DENIED",403);if(digest(current())!==digest(value))throw new OperationsAuthorityError("OPERATIONS_SOURCE_CHANGED");
  }};
  const authority=createOperationsControlAuthority({scope,sources:a.sources,source,now:()=>a.state.now});
  const controls=createOperationsControls({db:a.db,scope,secret,ledger:ops.ledger,jobs:ops.jobs,health,authority,canonical:()=>bridge,now:()=>a.state.now});
  const draftFor=(input:Parameters<OperationsCanonicalSource["resolveDraft"]>[0])=>{
    const {intent,proof}=input;return {...structuredClone(a.draft),actionKind:operationsCanonicalActionKinds[intent.kind],phase:"other" as const,acquisitionTerms:null,effects:{spendsMoney:false,sendsCreator:false,changesPolicy:false},
      providerAccountRef:intent.target.providerAccountRef,providerAccountVersion:intent.target.providerAccountVersion,sourceBasisRef:intent.intentRef,sourceBasisVersion:intent.digest,
      sourceValidUntil:proof.validUntil,payloadHash:operationsIntentPayloadHash(intent),items:intent.target.items.filter(item=>intent.selectedItemRefs.includes(item.itemRef)).map(item=>({...item,payloadHash:operationsIntentItemHash(intent,item.itemRef)}))};
  };
  const canonicalSource:OperationsCanonicalSource={resolveDraft:async input=>{const value=draftFor(input);await state.afterDraft?.();return value;},assertCurrent:(input,draft)=>{
    input.proof.assertCurrent();if(digest(stableApprovalDraft(draftFor({...input,phase:"current"})))!==digest(stableApprovalDraft(draft)))throw new OperationsAuthorityError("OPERATIONS_DRAFT_SOURCE_CHANGED");
  }};
  const na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Fictional local artifact has no provider or financial effect."};
  const handler:DispatchHandler={idempotency:"source-enforced",sourceEffect:"localArtifact",policyVersion:a.policy.version,provider:na,resources:()=>({budget:na,stock:na,quota:na}),
    budgets:{maxItems:10,maxSteps:20,maxAttempts:2,maxRunMs:10000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0},execute:async c=>{c.assertCurrent();state.effects++;return {state:"applied",receipt:{receiptRef:"synthetic-local-control-artifact",dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,sourceEffect:"localArtifact",observedAt:a.at()}};},
    reconcile:async()=>({state:"unknown",reasonCode:"SOURCE_LOOKUP_UNKNOWN"})};
  const bridge:OperationsControlBridge=createOperationsControlBridge({scope,authority,source:canonicalSource,intents:controls.canonicalIntents,owners:new Map([["task",{registration:{handlerRef:"synthetic-control-task.v1"},handlers:new Map([["synthetic-control-task.v1",handler]])}]]),
    actions:()=>actions,approvals:()=>approvals,now:()=>a.state.now});
  const approvals:ApprovalRepository=new ApprovalRepository(a.db,{...a.options,registry:bridge.domain.registry});
  const dispatch=new DispatchGuard({db:a.db,jobs:ops.jobs,ledger:ops.ledger,scope,approvals,handlers:bridge.domain.handlers,now:()=>a.state.now});
  const actions:ReturnType<typeof createActionService>=createActionService({scope,secret,approvals,dispatch,registry:bridge.domain.actions,authorize:a.sources.resolveActor,assertAuthority:a.sources.assertCurrent,now:()=>a.state.now});
  async function request(key="synthetic-control-preview"){
    const view=await controls.read({section:"runs"},principal.principalRef,"reviewer"),action=view.data.canonicalActions![0]!;
    return {schemaVersion:SCHEMA_VERSION,requestId:"synthetic-control-http",operation:"previewAction",actionKind:"previewOperationsControl",requestedScope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox"},entityRefs:[],approvalRef:null,manifestRef:null,
      expectedVersion:view.version,idempotencyKey:key,payload:{kind:action.kind,targetRef:action.targetRef,reason:"Review the exact fictional finite task.",itemRefs:action.items.map(item=>item.itemRef)}};
  }
  return {a,ops,health,snapshot,target,state,source,authority,controls,bridge,approvals,dispatch,actions,request,canonicalSource,current};
}
describe("operations controls named source and canonical approval integration",()=>{
  it("creates one actual immutable J04 preview and retains app reason without dispatch or source writes",async()=>{
    const w=setup(),input=await w.request(),first=await w.controls.previewCanonical(input,principal.principalRef,"reviewer"),again=await w.controls.previewCanonical(input,principal.principalRef,"reviewer");
    expect(again).toEqual(first);expect(first).toMatchObject({state:"blocked",executionCertainty:"applied"});expect(first.reasonCodes).toContain("APPROVAL_REQUEST_UNVERIFIED");
    const approval=w.approvals.readApproval(first.approvalRef!)!;expect(approval.manifest.draft.actionKind).toBe("operations.task");
    expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);expect(w.a.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(0);expect(w.a.state.writes).toBe(0);expect(w.state.effects).toBe(0);
    const intent=w.controls.canonicalIntents.read(approval.manifest.draft.sourceBasisRef)!;expect(intent.reason).toBe(input.payload.reason);expect(intent.mode).toBe("canonical-v2");
    const read=await w.controls.read({section:"runs",proposalRequestKey:input.idempotencyKey},principal.principalRef,"reviewer");expect(read.data.canonicalReconciliation).toMatchObject({state:"recorded",approvalRef:first.approvalRef,executionCertainty:"applied"});
  });
  it("uses the existing J04 native decision and runner for one actual local artifact, never from Request task",async()=>{
    const w=setup(),input=await w.request(),preview=await w.controls.previewCanonical(input,principal.principalRef,"reviewer");
    const base={schemaVersion:SCHEMA_VERSION,requestId:"synthetic-http",requestedScope:input.requestedScope,entityRefs:[],approvalRef:preview.approvalRef!,manifestRef:preview.manifestRef!,expectedVersion:preview.payloadVersion};
    await w.actions.execute({...base,operation:"requestApproval",actionKind:"requestApproval",idempotencyKey:"synthetic-request-decision",payload:{}},principal);
    const requested=w.approvals.readApproval(preview.approvalRef!)!,event=w.a.event(requested);await w.approvals.observeDecision(event.locator,{ingressRef:"synthetic-ingress"});
    const queued=await w.actions.execute({...base,operation:"dispatchApprovedAction",actionKind:"dispatchApprovedAction",idempotencyKey:"synthetic-handoff",payload:{}},principal);
    expect(w.state.effects).toBe(0);const completed=await w.dispatch.execute(queued.runRef!);expect(completed.items[0]?.receipt?.sourceEffect).toBe("localArtifact");expect(w.state.effects).toBe(1);
  });
  it("binds named mine to current person instead of reviewer transport role",async()=>{
    const w=setup(),one=w.ops.jobs.ingest({schemaVersion:"job-reference-batch.v1",jobId:controlTestJob.jobId,jobVersion:1,eventId:"synthetic-event",eventType:controlTestJob.eventType,eventAt:null,items:[{itemKey:"one",subjectRef:"subject:one",evidenceRef:null}]},"synthetic-ingress");
    w.snapshot.runMembership=[{id:"membership-one",runId:one.runId,platform:"instagram",assignedActorRef:"synthetic-person-one",sourceVersion:"v1",evidenceRef:"synthetic-membership",observedAt:w.a.at()}];
    const read=await w.controls.read({section:"runs",mine:true},principal.principalRef,"reviewer");expect(read.data.localRuns).toHaveLength(1);expect(read.data.runFilterEvidence.assignment).toBe("named-principal-verified");
    w.snapshot.runMembership[0]!.assignedActorRef="agent-reviewer";expect((await w.controls.read({section:"runs",mine:true},principal.principalRef,"reviewer")).data.localRuns).toHaveLength(0);
    expect(JSON.stringify(read.data)).not.toContain("synthetic-person-one");
  });
  it.each(["false","promise","rejected"])("rejects an invalid synchronous source fence: %s",async kind=>{
    const w=setup();w.source.assertCurrent=()=> (kind==="false"?false:kind==="promise"?Promise.resolve():Promise.reject(new Error("synthetic denied"))) as never;
    await expect(w.controls.read({section:"team"},principal.principalRef,"reviewer")).rejects.toMatchObject({code:"OPERATIONS_SOURCE_CHANGED"});
  });
  it("rejects source and named actor revocation after the source await",async()=>{
    const w=setup();w.state.afterRead=()=>{w.state.denied=true;};await expect(w.controls.read({section:"team"},principal.principalRef,"reviewer")).rejects.toMatchObject({status:403});
    w.state.denied=false;w.state.afterRead=()=>{w.a.humans.get(principal.principalRef)!.active=false;};await expect(w.controls.read({section:"team"},principal.principalRef,"reviewer")).rejects.toMatchObject({status:403});
  });
  it.each(["future","expired","overlong","wrong-person","wrong-account"])("rejects invalid authority %s",async kind=>{
    const w=setup();w.source.read=async()=>{const value=w.current();if(kind==="future")value.observedAt=new Date(w.a.state.now+1).toISOString();if(kind==="expired")value.validUntil=w.a.at();if(kind==="overlong")value.validUntil=new Date(w.a.state.now+300001).toISOString();if(kind==="wrong-person")value.personRef="another-person";if(kind==="wrong-account")value.scope={...scope,accountId:"another-account"};return value;};
    await expect(w.controls.read({section:"team"},principal.principalRef,"reviewer")).rejects.toBeInstanceOf(OperationsAuthorityError);
  });
  it("retains original intent on J04 source loss and forbids changed same-key content",async()=>{
    const w=setup(),input=await w.request();w.state.afterDraft=()=>{w.state.denied=true;};
    await expect(w.controls.previewCanonical(input,principal.principalRef,"reviewer")).rejects.toMatchObject({executionCertainty:"applied"});expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);
    w.state.denied=false;w.state.afterDraft=null;const result=await w.controls.previewCanonical(input,principal.principalRef,"reviewer");expect(result.approvalRef).toBeTruthy();
    await expect(w.controls.previewCanonical({...input,payload:{...input.payload,reason:"Different task reason"}},principal.principalRef,"reviewer")).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});expect(w.state.effects).toBe(0);
  });
  it("does not promote a legacy local review into canonical authority",async()=>{
    const w=setup(),input=await w.request(),oldService=createOperationsControls({db:w.a.db,scope,secret,ledger:w.ops.ledger,jobs:w.ops.jobs,health:w.health,source:{read:async()=>structuredClone(w.snapshot)},now:()=>w.a.state.now});
    const oldView=await oldService.read({section:"runs"},principal.principalRef,"reviewer"),legacy={...input,expectedVersion:oldView.version,operation:"requestApproval",actionKind:"proposeOperationsReview",payload:{kind:input.payload.kind,targetRef:input.payload.targetRef,reason:input.payload.reason}};
    const old=await oldService.propose(legacy,principal.principalRef,"reviewer");expect(w.controls.canonicalIntents.read(old.actionRef)).toBeNull();
    await expect(w.controls.previewCanonical(input,principal.principalRef,"reviewer")).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);
  });
  it("preserves finance permission from existing J04 policy instead of inventing a narrower role",async()=>{
    const w=setup();w.a.humans.get(principal.principalRef)!.roles=["finance"];const input=await w.request();const preview=await w.controls.previewCanonical(input,principal.principalRef,"reviewer");expect(preview.approvalRef).toBeTruthy();expect(preview.reasonCodes).toContain("APPROVAL_REQUEST_UNVERIFIED");
  });
  it("does not invalidate an exact task when unrelated report material changes, but does on task changes",async()=>{
    const w=setup(),input=await w.request(),p=await w.controls.previewCanonical(input,principal.principalRef,"reviewer");const approval=w.approvals.readApproval(p.approvalRef!)!;
    w.snapshot.revision="new-overall-observation";w.snapshot.reports[0]!.configuration="paused";
    await expect(w.bridge.domain.registry.currentDraft(approval.manifest)).resolves.toMatchObject({sourceBasisRef:approval.manifest.draft.sourceBasisRef});
    w.snapshot.tasks[0]!.permission="denied";await expect(w.bridge.domain.registry.currentDraft(approval.manifest)).rejects.toMatchObject({code:"OPERATIONS_TARGET_CHANGED"});
  });
  it("never represents a repair write ACK as a cleared discrepancy",()=>{
    const w=setup(),snapshot=w.current(),conflict=snapshot.snapshot.conflicts[0]!;conflict.receiptRef="synthetic-repair-receipt";
    snapshot.serviceRefs=[{kind:"repairReceipt",targetId:conflict.id,receiptRef:conflict.receiptRef,sourceVersion:"v1",state:"resolved",observedAt:w.a.at(),sourceReadbackVersion:conflict.authoritativeVersion,mirrorReadbackVersion:conflict.mirrorVersion,ownerPersonRef:"synthetic-person-one"}];
    expect(operationsAuthoritySnapshotSchema.safeParse(snapshot).success).toBe(false);
    const receipt=snapshot.serviceRefs[0]!;if(!("state"in receipt))throw new Error("Fixture receipt required");receipt.state="applied";expect(operationsAuthoritySnapshotSchema.safeParse(snapshot).success).toBe(true);
    receipt.state="resolved";conflict.state="resolved";snapshot.snapshot.comparisons[0]!.mirrorCount=2;snapshot.snapshot.comparisons[0]!.mirrorAmount={minorUnits:2500,currency:"USD"};expect(operationsAuthoritySnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});
