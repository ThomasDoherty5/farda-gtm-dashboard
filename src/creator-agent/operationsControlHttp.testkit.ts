import {createAgentServer,type AgentServerOptions} from "./server.ts";
import {approvalFixture,approvalTestScope as scope} from "./approvals/fixtures.testkit.ts";
import {controlSourceFixture,controlTestJob} from "./operationsControlsFixtures.ts";
import {OperationsAuthorityError,type OperationsAuthoritySnapshot,type OperationsAuthorityTarget} from "./operationsControlAuthority.ts";
import {operationsIntentPayloadHash,operationsIntentItemHash,operationsCanonicalActionKinds,type OperationsCanonicalSource} from "./operationsControlBridge.ts";
import {stableApprovalDraft} from "./approvals/repository.ts";
import type {DispatchHandler} from "./jobs/dispatchSchema.ts";
import {digest} from "./config.ts";
import {SCHEMA_VERSION} from "../adapter/contract.ts";
import {SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN} from "./testFixtures.ts";

/** Fictional source bindings over the actual server, J04 and SQLite; never deployment configuration. */
export function createOperationsControlHttpFixture(overrides:Partial<AgentServerOptions>={},fixtureOptions:{repair?:boolean}={}){
  const a=approvalFixture(),human={...structuredClone(a.humans.get("synthetic:requester")!),principalRef:"agent-reviewer",personRef:"synthetic-person-one"};
  a.humans.set(human.principalRef,human);
  a.humans.set("agent-reader",{...structuredClone(human),principalRef:"agent-reader",roles:["viewer"]});
  const snapshot=controlSourceFixture(scope);snapshot.observedAt=a.at();
  for(const rows of [snapshot.roles,snapshot.tasks,snapshot.takeovers,snapshot.permissions,snapshot.comparisons,snapshot.conflicts,snapshot.reports,snapshot.attribution,snapshot.handoffs,snapshot.runMembership])for(const row of rows)row.observedAt=a.at();
  snapshot.tasks[0]!.ownerRef=human.personRef;
  const target:OperationsAuthorityTarget={kind:"task",id:snapshot.tasks[0]!.id,sourceVersion:snapshot.tasks[0]!.sourceVersion,
    providerAccountRef:a.draft.providerAccountRef,providerAccountVersion:a.draft.providerAccountVersion,ownerPersonRef:human.personRef,permission:"allowed",
    items:snapshot.tasks[0]!.items.map(item=>({itemRef:item.itemKey,itemVersion:"item-v1",targetRef:item.subjectRef,targetVersion:"subject-v1",sourceRef:item.evidenceRef!,units:0,spendMinor:0}))};
  const targets=[target];
  if(fixtureOptions.repair){const conflict=snapshot.conflicts[0]!;targets.push({kind:"repair",id:conflict.id,sourceVersion:conflict.sourceVersion,providerAccountRef:target.providerAccountRef,
    providerAccountVersion:target.providerAccountVersion,ownerPersonRef:human.personRef,permission:"allowed",items:[{itemRef:"synthetic-repair-item",itemVersion:conflict.sourceVersion,targetRef:conflict.id,targetVersion:conflict.authoritativeVersion!,sourceRef:conflict.evidenceRef,units:0,spendMinor:0}]});}
  const state={denied:false,effects:0,afterDraft:null as null|(()=>void),serviceRefs:[] as OperationsAuthoritySnapshot["serviceRefs"]};
  const current=(principalRef=human.principalRef):OperationsAuthoritySnapshot=>({scope,principalRef,personRef:human.personRef,directoryVersion:human.directoryVersion,
    observedAt:a.at(),validUntil:a.until(),permission:state.denied?"denied":"allowed",snapshot:structuredClone(snapshot),targets:structuredClone(targets),serviceRefs:structuredClone(state.serviceRefs)});
  const draftFor=({intent,proof}:Parameters<OperationsCanonicalSource["resolveDraft"]>[0])=>({...structuredClone(a.draft),
    actionKind:operationsCanonicalActionKinds[intent.kind],phase:"other" as const,acquisitionTerms:null,effects:{spendsMoney:false,sendsCreator:false,changesPolicy:false},
    providerAccountRef:intent.target.providerAccountRef,providerAccountVersion:intent.target.providerAccountVersion,sourceBasisRef:intent.intentRef,sourceBasisVersion:intent.digest,
    sourceValidUntil:proof.validUntil,payloadHash:operationsIntentPayloadHash(intent),items:intent.target.items.filter(item=>intent.selectedItemRefs.includes(item.itemRef)).map(item=>({...item,payloadHash:operationsIntentItemHash(intent,item.itemRef)}))});
  const canonical:OperationsCanonicalSource={resolveDraft:async input=>{const value=draftFor(input);state.afterDraft?.();return value;},
    assertCurrent:(input,draft)=>{input.proof.assertCurrent();if(digest(stableApprovalDraft(draftFor({...input,phase:"current"})))!==digest(stableApprovalDraft(draft)))throw new OperationsAuthorityError("OPERATIONS_DRAFT_SOURCE_CHANGED");}};
  const na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Fictional local artifact has no provider or financial effect."};
  const handler:DispatchHandler={idempotency:"source-enforced",sourceEffect:"localArtifact",policyVersion:a.policy.version,provider:na,resources:()=>({budget:na,stock:na,quota:na}),
    budgets:{maxItems:10,maxSteps:20,maxAttempts:2,maxRunMs:10000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0},
    execute:async c=>{c.assertCurrent();state.effects++;return {state:"applied",receipt:{receiptRef:"synthetic-control-artifact",dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,
      handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,sourceEffect:"localArtifact",observedAt:a.at()}};},reconcile:async()=>({state:"unknown",reasonCode:"SOURCE_LOOKUP_UNKNOWN"})};
  const options:AgentServerOptions={databasePath:":memory:",workspaceId:scope.workspaceId,accountId:scope.accountId,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,
    operations:{now:()=>a.state.now},actionFoundation:{approvals:{sources:a.sources,currentPolicy:a.options.currentPolicy}},
    operationsControlAuthority:{read:async request=>current(request.principal.principalRef),assertCurrent:(request,observed)=>{
      if(state.denied)throw new OperationsAuthorityError("OPERATIONS_SOURCE_SCOPE_DENIED",403);
      if(digest(current(request.principal.principalRef))!==digest(observed))throw new OperationsAuthorityError("OPERATIONS_SOURCE_CHANGED");}},
    operationsCanonical:{source:canonical,owners:new Map(targets.map(t=>[t.kind as "task"|"repair",{registration:{handlerRef:"synthetic-control-task.v1"},handlers:new Map([["synthetic-control-task.v1",handler]])}]))},...overrides};
  const app=createAgentServer(options);app.operations.jobs.register(controlTestJob,0);
  const requestedScope={workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox"};
  const readRequest=(section="runs",filters:Record<string,unknown>={})=>({schemaVersion:SCHEMA_VERSION,operation:"readView",requestId:"synthetic-controls-read",requestedScope,
    viewKey:"operationsControl",filters:{section,...filters},period:null,sort:[],page:{limit:50,cursor:null}});
  function refreshClock(timestamp=Date.now()){
    a.state.now=timestamp;for(const who of a.humans.values()){who.observedAt=a.at();who.validUntil=a.until();}
    a.policy.observedAt=a.at();a.policy.validUntil=a.until();a.draft.sourceValidUntil=a.until();a.draft.expiresAt=new Date(timestamp+120000).toISOString();
    for(const gate of Object.values(a.draft.gates))if(gate.state==="satisfied")gate.validUntil=a.until();
    snapshot.observedAt=a.at();for(const rows of [snapshot.roles,snapshot.tasks,snapshot.takeovers,snapshot.permissions,snapshot.comparisons,snapshot.conflicts,snapshot.reports,snapshot.attribution,snapshot.handoffs,snapshot.runMembership])for(const row of rows)row.observedAt=a.at();
  }
  return {a,app,options,snapshot,target,targets,state,current,canonical,requestedScope,readRequest,refreshClock,
    close:async()=>{await app.close();a.db.close();}};
}
