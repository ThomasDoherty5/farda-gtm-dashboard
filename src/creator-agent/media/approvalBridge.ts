import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import { approvalDraftSchema, type ApprovalDraft, type ApprovalRegistry, type ApprovalScope, type VerifiedApprovalProof } from "../approvals/contract.ts";
import { stableApprovalDraft } from "../approvals/repository.ts";
import type { ExpectedBinding } from "../connections/schema.ts";
import type { RegisteredAction } from "../actions/service.ts";
import { DispatchError, type DispatchApprovalAuthority, type DispatchHandler, type DispatchContext, type DispatchReconcileContext, type DispatchReadback, type ResourceRequirements } from "../jobs/dispatchSchema.ts";
import { PaidMediaRepository, readbackMismatches } from "./repository.ts";
import { MediaReleaseController } from "../mediaControl/repository.ts";
import { MEDIA_GATES } from "./contract.ts";
import { MEDIA_ACTIONS, MEDIA_STAGE_ACTION, MEDIA_STAGE_HANDLER, mediaSourceSnapshotSchema, stageSourceSnapshotSchema,
  type CanonicalMediaAction, type CanonicalMediaRequest, type MediaSourceSnapshot, type CanonicalMediaSource,
  type CanonicalStageSource, type StageSourceSnapshot, type MediaOperationIdentity, type CanonicalMediaReadback } from "./canonicalContract.ts";

export type MediaAccountRegistration={accountRef:string;quotaResourceRef:string;bindings:Record<CanonicalMediaAction,{execute:ExpectedBinding;reconcile:ExpectedBinding}>};
export type MediaDomainRegistration={policyVersion:string;configVersion:string;linearIssueRef:string;accounts:MediaAccountRegistration[];budgets:DispatchHandler["budgets"]};
type CampaignEvidence={request:CanonicalMediaRequest;source:MediaSourceSnapshot;draft:ApprovalDraft;stageProof:VerifiedApprovalProof|null};
type StageEvidence={request:ReturnType<MediaReleaseController["canonicalStageRequest"]>;source:StageSourceSnapshot;draft:ApprovalDraft};
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
function fail(code:string,status=409):never{throw new DispatchError(code,status);}
const snapshotMaterial=(s:MediaSourceSnapshot)=>({...s,observedAt:undefined,validUntil:undefined,permission:{...s.permission,validUntil:undefined},
  native:s.native?{...s.native,settings:{...s.native.settings,observedAt:undefined}}:null,pool:s.pool?{...s.pool,validUntil:undefined}:null,
  gates:s.gates.map(g=>({...g,verifiedAt:undefined,expiresAt:undefined}))});
const stageMaterial=(s:StageSourceSnapshot)=>({...s,observedAt:undefined,validUntil:undefined,permission:{...s.permission,validUntil:undefined},gates:s.gates.map(g=>({...g,validUntil:undefined}))});
const accountKey=(a:{provider:string;providerAccountRef:string;environment:string})=>`${a.provider}/${a.providerAccountRef}/${a.environment}`;

/** One J04 registry and existing-dispatch handlers; domain checkpoints never issue approval or acquire a runner lease. */
export function createMediaDomainBridge(options:{scope:ApprovalScope;repository:PaidMediaRepository;controller:MediaReleaseController;
  source:CanonicalMediaSource;stageSource:CanonicalStageSource;stageApprovals:DispatchApprovalAuthority;registration:MediaDomainRegistration;now?:()=>number}){
  const {scope,repository,controller,source,stageSource,stageApprovals,registration}=options;
  if(source.idempotency!=="source-enforced"||source.conditionalWrites!=="native-version-and-safety-generation")fail("MEDIA_NATIVE_CONDITIONAL_BOUNDARY_REQUIRED");
  const now=()=>{const t=(options.now??Date.now)();if(!Number.isSafeInteger(t))fail("INVALID_CLOCK",500);return t;};
  const na=(reason:string)=>({state:"notApplicable" as const,policyVersion:registration.policyVersion,reason});
  const campaignCache=new Map<string,CampaignEvidence>(),stageCache=new Map<string,StageEvidence>();
  const accounts=new Map(registration.accounts.map(a=>[a.accountRef,a]));
  if(accounts.size!==registration.accounts.length||!accounts.size)fail("MEDIA_ACCOUNT_REGISTRATION_INVALID");
  for(const a of accounts.values())for(const action of MEDIA_ACTIONS){const b=a.bindings[action];
    if(!b||b.execute.action!==action||b.reconcile.action!==action||b.execute.mode!=="executeApproved"||b.reconcile.mode!=="reconcile"||
      b.execute.providerAccountId!==a.accountRef||b.reconcile.providerAccountId!==a.accountRef)fail("MEDIA_ACCOUNT_REGISTRATION_INVALID");
    for(const binding of [b.execute,b.reconcile])if(binding.workspaceId!==scope.workspaceId||binding.accountId!==scope.accountId||binding.environment!==scope.environment)fail("MEDIA_SCOPE_DENIED",403);
  }
  const live=(observedAt:string,validUntil:string,t:number)=>Date.parse(observedAt)<=t&&Date.parse(validUntil)>t&&Date.parse(validUntil)>Date.parse(observedAt);
  const assertPermission=(s:{permission:MediaSourceSnapshot["permission"];observedAt:string;validUntil:string},t:number)=>{
    if(s.permission.state!=="permitted")fail("MEDIA_SOURCE_PERMISSION_REQUIRED",s.permission.state==="denied"?403:409);
    if(!live(s.observedAt,s.validUntil,t)||Date.parse(s.permission.validUntil)<=t)fail("MEDIA_SOURCE_EXPIRED");
  };
  function assertCampaign(e:CampaignEvidence,t:number){
    assertPermission(e.source,t);
    if(!same(repository.canonicalRequest(e.request.entityRef,e.request.action),e.request))fail("MEDIA_REQUEST_CHANGED");
    if(e.stageProof)stageApprovals.assertCurrentProof(e.stageProof,t);
    source.assertCurrent(e.source,t);
    const growth=e.request.action==="media.createDraft"||e.request.action==="media.publish"||e.source.pool!==null;
    repository.assertCanonicalSources(e.request.entityRef,e.request.action,growth);
    if(e.request.action==="media.changeBudget"&&e.request.dailyBudgetMinor!>e.request.manifest.caps.lifetimeBudgetMinor)fail("BUDGET_EXCEEDS_LIFETIME_CAP");
    if(e.request.action==="media.changeBudget")controller.assertCanonicalBudgetChange(e.request.campaignId,e.request.dailyBudgetMinor!,()=>source.assertCurrent(e.source,t));
    if(growth){
      const byGate=new Map(e.source.gates.map(g=>[g.gate,g]));
      if(byGate.size!==MEDIA_GATES.length||e.source.gates.length!==MEDIA_GATES.length)fail("MEDIA_FIVE_GATES_REQUIRED");
      for(const name of MEDIA_GATES){const g=byGate.get(name)!;if(g.state!=="verified"||g.campaignId!==e.request.campaignId||g.manifestHash!==e.request.manifestHash||
        !same(g.scope,{workspaceId:scope.workspaceId,accountId:scope.accountId})||!live(g.verifiedAt,g.expiresAt,t))fail("MEDIA_GATE_NOT_CURRENT");}
    }
  }
  function requirements(e:CampaignEvidence):ResourceRequirements{
    const a=accounts.get(e.request.manifest.account.providerAccountRef)!;
    return{budget:e.source.pool?{state:"required",resourceRef:e.source.pool.resourceRef,quantity:e.source.pool.campaignExposureMinor,unit:"minor",currency:"USD"}:na("No increased media exposure in this operation."),
      stock:na("Media does not ship physical stock."),quota:{state:"required",resourceRef:a.quotaResourceRef,quantity:1,unit:"request",currency:null}};
  }
  async function campaignEvidence(entityRef:string,action:CanonicalMediaAction):Promise<CampaignEvidence>{
    const r=repository.canonicalRequest(entityRef,action),a=accounts.get(r.manifest.account.providerAccountRef);if(!a||r.legacyPending)fail("MEDIA_EXACT_SOURCE_REQUIRED");
    const parsed=mediaSourceSnapshotSchema.safeParse(await source.readBasis({scope,request:r}));if(!parsed.success)fail("MEDIA_SOURCE_UNVERIFIED");const s=parsed.data;
    if(!same(s.scope,scope)||s.entityRef!==r.entityRef||s.entityVersion!==r.entityVersion||s.requestHash!==r.requestHash||!same(s.providerBinding,a.bindings[action].execute))fail("MEDIA_SOURCE_IDENTITY_MISMATCH");
    if(action==="media.createDraft"?((r.nativeCampaignId===null)!==(s.native===null)||!!s.native&&!["PAUSED","DRAFT"].includes(s.native.settings.status)):(!s.native||s.native.settings.nativeCampaignId!==r.nativeCampaignId))fail("MEDIA_NATIVE_IDENTITY_REQUIRED");
    if(s.native&&(s.native.settings.providerAccountRef!==a.accountRef||s.native.settings.provider!==r.manifest.provider||s.native.settings.environment!==scope.environment||s.native.safetyGeneration!==r.safetyGeneration))fail("MEDIA_NATIVE_VERSION_CHANGED");
    const growth=action==="media.publish"||(action==="media.changeBudget"&&(s.native?.settings.dailyBudgetMinor===null||r.dailyBudgetMinor!>s.native!.settings.dailyBudgetMinor!));
    let stageProof:VerifiedApprovalProof|null=null;
    if(growth){if(!s.pool||s.pool.state!=="released"||Date.parse(s.pool.validUntil)<=now())fail("MEDIA_STAGE_GRANT_REQUIRED");
      const stage=controller.canonicalStageRequest(s.pool.poolRef);if(!stage.canonical||stage.subjectHash!==s.pool.poolVersion||stage.canonical.receipt.receiptRef!==s.pool.stageReceiptRef||
        digest([...stage.terms.allocations].sort((x,y)=>accountKey(x).localeCompare(accountKey(y))))!==s.pool.allocationHash)fail("MEDIA_STAGE_CHANGED");
      const current=await stageApprovals.resolveCurrentProof(stage.canonical.binding);if(current.state!=="verified")fail("MEDIA_STAGE_APPROVAL_HELD");stageProof=current.proof;
    }else if(s.pool)fail("MEDIA_UNEXPECTED_EXPOSURE_GRANT");
    if(action==="media.pause"){
      if(!s.safety||!s.native||s.safety.publicationGeneration!==s.native.publicationGeneration||s.safety.policyVersion!==registration.policyVersion)fail("MEDIA_FINITE_SAFETY_AUTHORITY_REQUIRED");
    }else if(s.safety)fail("MEDIA_SAFETY_AUTHORITY_OUTSIDE_PAUSE");
    if(s.native&&action!=="media.pause"&&action!=="media.createDraft"){
      const mismatch=readbackMismatches(r.manifest,s.native.settings,action==="media.publish"?["PAUSED","DRAFT"]:["ACTIVE","IN_REVIEW","PAUSED"])
        .filter(code=>action==="media.changeBudget"&&code==="READBACK_MISMATCH:DAILY_BUDGET"?false:true);
      if(mismatch.length)fail(mismatch[0]!);
    }
    const basisHash=digest(snapshotMaterial(s)),payloadHash=digest({request:r,basisHash}),lease=new Date(Math.min(Date.parse(s.validUntil),Date.parse(s.permission.validUntil),Date.parse(r.manifest.schedule.endAt))).toISOString();
    const gate={state:"satisfied" as const,sourceRef:s.sourceRef,sourceVersion:basisHash,validUntil:lease},spend=s.pool?.campaignExposureMinor??0;
    const draft=approvalDraftSchema.parse({actionKind:action,phase:action==="media.pause"?"mediaSafetyPause":action==="media.publish"?"launch":"other",
      providerAccountRef:a.accountRef,providerAccountVersion:s.providerBinding.authorizationScopeVersion,payloadHash,payloadRef:`media-payload:${payloadHash}`,
      productVersion:action==="media.pause"?na("Status-only finite safety pause does not release product."):{state:"required",version:r.manifest.offer.skuRef},
      termsVersion:action==="media.pause"?na("Status-only pause creates no offer."):{state:"required",version:r.manifest.offer.version},
      rightsVersion:action==="media.pause"?na("Status-only pause stops paid use."):{state:"required",version:digest(r.manifest.creatives.map(c=>c.rightsHash))},
      configVersion:registration.configVersion,policyVersion:registration.policyVersion,effects:{spendsMoney:spend>0,sendsCreator:false,changesPolicy:false},
      items:[{itemRef:entityRef,itemVersion:r.entityVersion,targetRef:r.nativeCampaignId??r.campaignId,targetVersion:s.native?.publicationGeneration??r.manifestHash,payloadHash,sourceRef:s.sourceRef,units:0,spendMinor:spend}],
      bounds:{maxItems:1,maxUnits:0,maxSpendMinor:spend,currency:"USD"},exposure:{state:"known",minor:spend,currency:"USD"},acquisitionTerms:null,historicalLiability:null,
      gates:{acceptedTerms:na("No creator acquisition."),sampleAuthority:na("No samples sent."),providerTerms:gate,
        launchReadiness:action==="media.pause"?na("Finite status-only safety pause remains available when growth gates fail."):gate,sourcePermission:gate},
      sourceBasisRef:s.sourceRef,sourceBasisVersion:basisHash,sourceValidUntil:lease,linearIssueRef:registration.linearIssueRef,expiresAt:r.expiresAt});
    const e={request:r,source:s,draft,stageProof};assertCampaign(e,now());repository.freezeResourceBasis({entityRef,entityVersion:r.entityVersion,payloadHash,request:r,requirements:requirements(e)});campaignCache.set(draft.payloadRef,e);return e;
  }
  function assertStage(e:StageEvidence,t:number){assertPermission(e.source,t);stageSource.assertCurrent(e.source,t);
    const r=controller.canonicalStageRequest(e.request.stageRef);if(r.revision!==e.request.revision||r.subjectHash!==e.request.subjectHash)fail("MEDIA_STAGE_CHANGED");
    if(e.source.gates.some(g=>g.state!=="verified"||Date.parse(g.validUntil)<=t)||new Set(e.source.gates.map(g=>g.gate)).size!==MEDIA_GATES.length)fail("MEDIA_FIVE_GATES_REQUIRED");}
  async function stageEvidence(stageRef:string):Promise<StageEvidence>{
    const r=controller.canonicalStageRequest(stageRef),parsed=stageSourceSnapshotSchema.safeParse(await stageSource.readBasis({scope,stageRef,revision:r.revision,subjectHash:r.subjectHash}));if(!parsed.success)fail("MEDIA_STAGE_SOURCE_UNVERIFIED");const s=parsed.data;
    const allocations=[...r.terms.allocations].sort((a,b)=>accountKey(a).localeCompare(accountKey(b)));
    if(!same(s.scope,scope)||s.stageRef!==stageRef||s.revision!==r.revision||s.subjectHash!==r.subjectHash||!same(s.terms,r.terms)||s.poolRef!==stageRef||s.poolVersion!==r.subjectHash||s.allocationHash!==digest(allocations)||
      Date.parse(s.adoptedAt)>now()||(s.terms.ordinal===1&&s.terms.capMinor>150000)||allocations.length!==2||allocations.some(a=>!accounts.has(a.providerAccountRef)))fail("MEDIA_STAGE_EXACT_POOL_REQUIRED");
    const basisHash=digest(stageMaterial(s)),payloadHash=digest({terms:r.terms,basisHash}),lease=s.validUntil;
    const gate={state:"satisfied" as const,sourceRef:s.sourceRef,sourceVersion:basisHash,validUntil:lease};
    const draft=approvalDraftSchema.parse({actionKind:MEDIA_STAGE_ACTION,phase:"mediaStageRelease",providerAccountRef:s.governanceAccount.accountRef,providerAccountVersion:s.governanceAccount.accountVersion,
      payloadHash,payloadRef:`media-stage:${stageRef}:${r.revision}`,productVersion:na("Exact five stage gates retain product proof."),termsVersion:{state:"required",version:s.parameterVersion},rightsVersion:na("Exact stage gates retain content permission proof."),
      configVersion:registration.configVersion,policyVersion:registration.policyVersion,effects:{spendsMoney:false,sendsCreator:false,changesPolicy:false},
      items:[{itemRef:stageRef,itemVersion:String(r.revision),targetRef:s.poolRef,targetVersion:s.poolVersion,payloadHash,sourceRef:s.sourceRef,units:0,spendMinor:0}],
      bounds:{maxItems:1,maxUnits:0,maxSpendMinor:r.terms.capMinor,currency:"USD"},exposure:{state:"known",minor:r.terms.capMinor,currency:"USD"},acquisitionTerms:null,historicalLiability:null,
      mediaAuthorization:{kind:"stageCap",accountKind:"internalGovernance",poolRef:s.poolRef,poolVersion:s.poolVersion,allocationHash:s.allocationHash,capMinor:r.terms.capMinor,currency:"USD"},
      gates:{acceptedTerms:na("Not creator acquisition."),sampleAuthority:na("No samples."),providerTerms:na("Local governance write only."),launchReadiness:gate,sourcePermission:gate},
      sourceBasisRef:s.sourceRef,sourceBasisVersion:basisHash,sourceValidUntil:lease,linearIssueRef:registration.linearIssueRef,expiresAt:r.terms.endAt});
    const e={request:r,source:s,draft};assertStage(e,now());controller.assertCanonicalStage(stageRef,()=>assertStage(e,now()),true);stageCache.set(draft.payloadRef,e);return e;
  }
  const registry:ApprovalRegistry={resolvePreview:async(command,_principal,actualScope)=>{
    if(!same(actualScope,scope)||command.selectionRefs.length!==1||command.selectionRefs[0]!==command.entityRef)fail("MEDIA_PREVIEW_SCOPE_INVALID");
    const e=command.actionKind===MEDIA_STAGE_ACTION?await stageEvidence(command.entityRef):MEDIA_ACTIONS.includes(command.actionKind as CanonicalMediaAction)?await campaignEvidence(command.entityRef,command.actionKind as CanonicalMediaAction):fail("MEDIA_ACTION_UNKNOWN");
    if(command.entityVersion!==e.draft.items[0]!.itemVersion)fail("MEDIA_REQUEST_CHANGED");return e.draft;},
    currentDraft:async manifest=>manifest.draft.actionKind===MEDIA_STAGE_ACTION?(await stageEvidence(manifest.items[0]!.itemRef)).draft:(await campaignEvidence(manifest.items[0]!.itemRef,manifest.draft.actionKind as CanonicalMediaAction)).draft,
    assertCurrentDraft:(manifest,observed,t)=>{const e=manifest.draft.actionKind===MEDIA_STAGE_ACTION?stageCache.get(observed.payloadRef):campaignCache.get(observed.payloadRef);
      if(!e||!same(stableApprovalDraft(e.draft),stableApprovalDraft(observed))||!same(stableApprovalDraft(manifest.draft),stableApprovalDraft(observed)))fail("MEDIA_MATERIAL_CHANGED");
      if(manifest.draft.actionKind===MEDIA_STAGE_ACTION)assertStage(e as StageEvidence,t);else assertCampaign(e as CampaignEvidence,t);},
  };
  function identity(c:DispatchReconcileContext):MediaOperationIdentity{
    const r=repository.frozenRequest(c.intent.approval.payloadHash);
    return {scope,action:r.action,campaignId:r.campaignId,revision:r.revision,manifestHash:r.manifestHash,entityRef:r.entityRef,entityVersion:r.entityVersion,requestHash:r.requestHash,
      dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,providerBindingHash:c.providerBindingHash,attemptRef:c.attemptRef,attemptNumber:c.attemptNumber,
      provider:r.manifest.provider,providerAccountRef:r.manifest.account.providerAccountRef,nativeCampaignId:r.nativeCampaignId};
  }
  function resultFor(c:DispatchReconcileContext,r:CanonicalMediaReadback):DispatchReadback{
    if(r.state==="unknown")return r;
    const base={dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,receiptRef:r.receiptRef,observedAt:r.observedAt};
    return r.state==="applied"?{state:"applied",receipt:{...base,sourceEffect:"providerApplied",providerOutcome:r.outcome==="rejected"?{state:"rejected",reasonCode:"PROVIDER_REJECTED"}:{state:"accepted",reasonCode:null}}}:{state:"notApplied",...base,attemptRef:r.attemptRef,attemptNumber:r.attemptNumber,complete:true,originalAttemptClosed:true,validUntil:r.validUntil};
  }
  function assertRead(id:MediaOperationIdentity,certainty:"applied"|"notApplied"|"uncertain"="uncertain"){try{source.assertReadCurrent(id,now());}catch{throw new DispatchError("MEDIA_READ_PERMISSION_REQUIRED",403,certainty);}}
  const handlers=new Map<string,DispatchHandler>(),actions=new Map<string,RegisteredAction>();
  for(const action of MEDIA_ACTIONS){const routing=new Map<string,string>();
    for(const a of accounts.values()){
      const handlerRef=`media-${action.split(".")[1]}:${digest(a.accountRef).slice(0,24)}`;routing.set(a.accountRef,handlerRef);
      const handler:DispatchHandler={policyVersion:registration.policyVersion,idempotency:"source-enforced",sourceEffect:"providerApplied",provider:{state:"required",binding:a.bindings[action].execute},
        reconcileBinding:a.bindings[action].reconcile,budgets:registration.budgets,
        resources:intent=>{const r=repository.frozenRequest(intent.approval.payloadHash);if(r.action!==action||r.manifest.account.providerAccountRef!==a.accountRef||intent.approval.itemRef!==r.entityRef||intent.approval.itemVersion!==r.entityVersion)fail("MEDIA_EXACT_BASIS_REQUIRED");
          return repository.resourceBasis(r.entityRef,r.entityVersion,intent.approval.payloadHash).requirements;},
        execute:async(c:DispatchContext)=>{
          let e=campaignCache.get(c.intent.payloadRef);if(!e||e.request.action!==action||e.draft.payloadHash!==c.intent.approval.payloadHash)fail("MEDIA_CURRENT_BASIS_REQUIRED");
          const id=identity(c),proof=c.approvalProof();if(!same(proof.binding,c.intent.approval)||proof.decisionReceipt.decision!=="approved")fail("MEDIA_CANONICAL_APPROVAL_REQUIRED");
          const assert=()=>{c.assertCurrent();assertCampaign(e!,now());};
          repository.beginCanonical({identity:id,binding:c.intent.approval,decisionReceiptRef:proof.decisionReceipt.receiptRef,startedAt:new Date(now()).toISOString(),source:e.source,receipt:null,closed:null},assert);
          let raw:unknown,denied=false;
          try{await c.heartbeat();e=campaignCache.get(c.intent.payloadRef);if(!e)fail("MEDIA_CURRENT_BASIS_REQUIRED");
            assert();const grants=c.resourceGrants();
            raw=await source.perform({...id,approval:c.intent.approval,decisionReceiptRef:c.approvalProof().decisionReceipt.receiptRef,
              manifest:e.request.manifest,desired:{status:action==="media.pause"||action==="media.createDraft"?"PAUSED":action==="media.publish"?"ACTIVE":null,dailyBudgetMinor:action==="media.changeBudget"?e.request.dailyBudgetMinor:null},
              expectedSourceVersion:e.source.sourceVersion,expectedNativeVersion:e.source.native?.nativeVersion??null,expectedPublicationGeneration:e.source.native?.publicationGeneration??null,
              expectedSafetyGeneration:e.source.native?.safetyGeneration??0,pool:e.source.pool,resourceGrants:grants});
          }catch(error){denied=error instanceof DispatchError&&[401,403].includes(error.status);raw={state:"unknown",reasonCode:"MEDIA_OPERATION_OUTCOME_UNCERTAIN"};}
          const result=repository.recordCanonical(id,raw);controller.settleCanonicalExposure(id,result.state);
          if(denied)throw new DispatchError("MEDIA_SOURCE_PERMISSION_REQUIRED",403,result.state==="applied"?"applied":"uncertain");assertRead(id,result.state==="unknown"?"uncertain":result.state);return resultFor(c,result);
        },
        reconcile:async c=>{const id=identity(c);assertRead(id);const original=repository.canonicalCheckpoint(id);
          const raw=original.receipt??original.closed??await source.readOperation(id);const result=repository.recordCanonical(id,raw);controller.settleCanonicalExposure(id,result.state);
          assertRead(id,result.state==="unknown"?"uncertain":result.state);return resultFor(c,result);},
      };handlers.set(handlerRef,handler);
    }actions.set(action,{handlerRefsByAccount:routing});
  }
  const stageHandler:DispatchHandler={policyVersion:registration.policyVersion,idempotency:"source-enforced",sourceEffect:"localArtifact",provider:na("The source-backed internal media governance ledger is local."),budgets:registration.budgets,
    resources:()=>({budget:na("This records a cap, not a cash debit."),stock:na("No shipment."),quota:na("No external request.")}),
    execute:async c=>{await c.heartbeat();const e=stageCache.get(c.intent.payloadRef);if(!e||e.draft.payloadHash!==c.intent.approval.payloadHash)fail("MEDIA_STAGE_CURRENT_BASIS_REQUIRED");
      const proof=c.approvalProof(),receipt={receiptRef:`media-stage-receipt:${digest(c.dispatchKey)}`,dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,handlerRef:c.intent.handlerRef,
        providerBindingHash:c.providerBindingHash,sourceEffect:"localArtifact" as const,observedAt:new Date(now()).toISOString()};
      const actual=controller.recordCanonicalStage(e.request.stageRef,e.request.revision,proof,receipt,()=>{c.assertCurrent();assertStage(e,now());});return{state:"applied",receipt:actual};},
    reconcile:async c=>{const stageRef=c.intent.approval.itemRef;stageSource.assertReadCurrent(stageRef,now());const recorded=controller.canonicalStageRequest(stageRef).canonical;
      if(!recorded||recorded.receipt.dispatchKey!==c.dispatchKey||!same(recorded.binding,c.intent.approval))return{state:"unknown",reasonCode:"MEDIA_STAGE_RECEIPT_UNVERIFIED"};
      stageSource.assertReadCurrent(stageRef,now());return{state:"applied",receipt:recorded.receipt};},
  };
  handlers.set(MEDIA_STAGE_HANDLER,stageHandler);actions.set(MEDIA_STAGE_ACTION,{handlerRef:MEDIA_STAGE_HANDLER});
  return {registry,actions,handlers,
    /** Compose with the current owning quota authority; never turn a balance snapshot into a grant. */
    reserveBudget(intent:Parameters<DispatchHandler["resources"]>[0],dispatchKey:string){const e=campaignCache.get(intent.payloadRef);if(!e?.source.pool||!e.stageProof)fail("MEDIA_STAGE_GRANT_REQUIRED");
      try{return controller.reserveCanonicalExposure({stageRef:e.source.pool.poolRef,campaignId:e.request.campaignId,dispatchKey,resourceRef:e.source.pool.resourceRef,quantity:e.source.pool.campaignExposureMinor,
        validUntil:new Date(Math.min(Date.parse(e.source.pool.validUntil),Date.parse(e.stageProof.validUntil),Date.parse(e.source.validUntil))).toISOString()},()=>assertCampaign(e,now()));}catch(error){if(error instanceof AgentConflict)throw new DispatchError(error.message);throw error;}},
    assertBudget(grant:Parameters<MediaReleaseController["assertCanonicalExposure"]>[0],intent:Parameters<DispatchHandler["resources"]>[0]){const e=campaignCache.get(intent.payloadRef);if(!e?.stageProof)fail("MEDIA_STAGE_GRANT_REQUIRED");controller.assertCanonicalExposure(grant,()=>assertCampaign(e,now()));},
  };
}
