import {digest} from "../config.ts";
import {approvalFixture,approvalTestScope as scope} from "../approvals/fixtures.testkit.ts";
import {ApprovalRepository,approvalDispatchBinding} from "../approvals/repository.ts";
import type {ApprovalRead} from "../approvals/contract.ts";
import {CapabilityLedger,capabilityIdForBinding} from "../connections/ledger.ts";
import {unknownSourceFreshness,unknownBusinessEligibility,type VerificationReceipt,type ExpectedBinding} from "../connections/schema.ts";
import {JobRepository} from "../jobs/repository.ts";
import {DispatchGuard} from "../jobs/dispatchGuard.ts";
import {DispatchError,type ResourceAuthority,type ResourceGrant} from "../jobs/dispatchSchema.ts";
import {createMediaDomainBridge,type MediaAccountRegistration,type MediaDomainRegistration} from "./approvalBridge.ts";
import {MEDIA_ACTIONS,MEDIA_STAGE_ACTION,type CanonicalMediaAction,type CanonicalMediaRequest,type CanonicalMediaSource,type CanonicalStageSource,type MediaSourceSnapshot,type StageSourceSnapshot,type MediaConditionalWrite,type CanonicalMediaReadback} from "./canonicalContract.ts";
import {MEDIA_GATES,gateReceiptSchema,type NativeSettings} from "./contract.ts";
import {mediaKernelFixture,syntheticMediaSettings,META,TIKTOK} from "./canonicalKernel.testkit.ts";

/** Fictional actual J04/SQLite/capability/runner integration, without credentials or a provider connection. */
export async function canonicalMediaFixture(path=":memory:"){
  const approval=approvalFixture(path),at=approval.at,until=approval.until;
  const kernel=mediaKernelFixture(approval.db,{workspaceId:scope.workspaceId,accountId:scope.accountId},()=>new Date(approval.state.now));
  kernel.params.reviewCadence={value:{anchorAt:at(),intervalHours:24,windowMinutes:120,learningWindowHours:72,safetyIntervalMinutes:15},state:"adopted",adoptionRef:"synthetic-review-adoption",adoptedAt:at()};
  const state={sourceVersion:"source-v1",stageVersion:"stage-source-v1",deny:false,denyRead:false,denyStage:false,failedGate:false,
    lostAck:false,failBefore:false,malformed:false,terminal:false,rejected:false,calls:0,beforeRead:null as null|(()=>void|Promise<void>),afterRead:null as null|(()=>void|Promise<void>),beforeEffect:null as null|(()=>void|Promise<void>)};
  const accounts:MediaAccountRegistration[]=[META,TIKTOK].map(accountRef=>({accountRef,quotaResourceRef:`quota:${accountRef}`,bindings:Object.fromEntries(MEDIA_ACTIONS.map(action=>{
    const execute:ExpectedBinding={...scope,provider:accountRef===META?"meta":"tiktok",providerAccountId:accountRef,action,mode:"executeApproved",route:"api",routeRef:`route:${action}`,authorizationScopeVersion:"permission-v1",toolVersion:"synthetic-native-v1",requiredScopes:[action],connectionRef:null,secretRef:null};
    return[action,{execute,reconcile:{...execute,mode:"reconcile",requiredScopes:["read-outcome"]}}];})) as MediaAccountRegistration["bindings"]}));
  const registration:MediaDomainRegistration={policyVersion:approval.policy.version,configVersion:"synthetic-media-config",linearIssueRef:"synthetic-media-issue",accounts,
    budgets:{maxItems:1,maxSteps:10,maxAttempts:3,maxRunMs:60000,leaseMs:10000,maxConcurrency:1,retryBaseMs:0}};
  const versions=new Map<string,{nativeVersion:string;publicationGeneration:string;safetyGeneration:number}>(),results=new Map<string,CanonicalMediaReadback>(),intents=new Map<string,MediaConditionalWrite>();
  const key=(a:{provider:string;providerAccountRef:string;environment:string})=>`${a.provider}/${a.providerAccountRef}/${a.environment}`;
  function basis(r:CanonicalMediaRequest):MediaSourceSnapshot{
    const n=r.nativeCampaignId?kernel.native.get(r.nativeCampaignId):null,version=r.nativeCampaignId?versions.get(r.nativeCampaignId):null;
    const growth=r.action==="media.publish"||r.action==="media.changeBudget"&&(n?.dailyBudgetMinor===null||r.dailyBudgetMinor!>n!.dailyBudgetMinor!);
    const stage=kernel.control.canonicalStageRequest("stage:initial");
    return{scope,entityRef:r.entityRef,entityVersion:r.entityVersion,requestHash:r.requestHash,sourceRef:"synthetic-media-basis",sourceVersion:state.sourceVersion,observedAt:at(),validUntil:until(),
      permission:{sourceRef:"synthetic-media-permission",sourceVersion:"permission-v1",state:state.deny?"denied":"permitted",validUntil:until()},
      providerBinding:accounts.find(a=>a.accountRef===r.manifest.account.providerAccountRef)!.bindings[r.action].execute,
      native:n&&version?{settings:{...structuredClone(n),observedAt:at()},...version}:null,
      pool:growth?{poolRef:stage.stageRef,poolVersion:stage.subjectHash,allocationHash:digest([...stage.terms.allocations].sort((a,b)=>key(a).localeCompare(key(b)))),stageReceiptRef:stage.canonical?.receipt.receiptRef??"synthetic-unreleased",resourceRef:"synthetic-shared-stage-budget",
        campaignExposureMinor:Math.ceil(r.manifest.caps.lifetimeBudgetMinor*(1+stage.terms.headroomBps/10000)),state:stage.canonical?"released":"held",validUntil:until()}:null,
      gates:MEDIA_GATES.flatMap(gate=>{const parsed=gateReceiptSchema.safeParse(kernel.mediaAuthority.gate?.(gate,{campaignId:r.campaignId,manifestHash:r.manifestHash},{workspaceId:scope.workspaceId,accountId:scope.accountId}));
        return parsed.success?[{...parsed.data,...(state.failedGate&&gate==="qualified-product-stock"?{state:"failed" as const}:{})}]:[];}),
      safety:r.action==="media.pause"?{policyRef:"synthetic-finite-pause-policy",policyVersion:approval.policy.version,publicationGeneration:version!.publicationGeneration,desiredStatus:"PAUSED",maxNativeEffects:1,permittedTriggers:["STOCK_FAILED"]}:null};
  }
  const source:CanonicalMediaSource={idempotency:"source-enforced",conditionalWrites:"native-version-and-safety-generation",
    readBasis:async({request})=>{await state.beforeRead?.();const snapshot=basis(request);await state.afterRead?.();return snapshot;},
    assertCurrent:s=>{if(state.deny)throw new DispatchError("MEDIA_SOURCE_PERMISSION_REQUIRED",403);if(s.sourceVersion!==state.sourceVersion)throw new DispatchError("MEDIA_SOURCE_CHANGED");
      if(s.native){const v=versions.get(s.native.settings.nativeCampaignId);if(!v||digest(v)!==digest({nativeVersion:s.native.nativeVersion,publicationGeneration:s.native.publicationGeneration,safetyGeneration:s.native.safetyGeneration}))throw new DispatchError("MEDIA_NATIVE_VERSION_CHANGED");}
      if(state.failedGate&&s.safety===null)throw new DispatchError("MEDIA_GATE_NOT_CURRENT");},
    perform:async input=>{await state.beforeEffect?.();
      const previous=results.get(input.dispatchKey);if(previous?.state==="applied")return structuredClone(previous);
      const v=input.nativeCampaignId?versions.get(input.nativeCampaignId):null;
      if(state.deny||state.sourceVersion!==input.expectedSourceVersion||input.expectedNativeVersion!==(v?.nativeVersion??null)||input.expectedSafetyGeneration!==(v?.safetyGeneration??0)||input.expectedPublicationGeneration!==(v?.publicationGeneration??null))throw new DispatchError("NATIVE_CONDITIONAL_VERSION_REJECTED");
      kernel.media.assertCanonicalSources(input.entityRef,input.action,input.action==="media.createDraft"||input.action==="media.publish"||input.pool!==null);
      state.calls++;intents.set(input.dispatchKey,structuredClone(input));if(state.failBefore)throw new Error("Synthetic unknown before native ACK.");
      const id=input.nativeCampaignId??`native:${digest(input.dispatchKey).slice(0,24)}`;
      const n:NativeSettings=structuredClone(input.action==="media.createDraft"?syntheticMediaSettings(input.manifest,id,()=>new Date(approval.state.now)):kernel.native.get(id)!);
      const mutationRejected=state.rejected&&(input.action==="media.pause"||input.action==="media.changeBudget");
      if(!mutationRejected){if(input.desired.status)n.status=state.rejected?"REJECTED":input.desired.status;if(input.desired.dailyBudgetMinor!==null)n.dailyBudgetMinor=input.desired.dailyBudgetMinor;}n.observedAt=at();
      const next={nativeVersion:`native-v:${digest(input.dispatchKey).slice(0,24)}`,publicationGeneration:input.action==="media.publish"?`publication:${digest(input.dispatchKey).slice(0,24)}`:v?.publicationGeneration??"publication:unpublished",
        safetyGeneration:(v?.safetyGeneration??0)+(input.action==="media.pause"&&!mutationRejected?1:0)};
      kernel.native.set(id,n);versions.set(id,next);
      const identity={scope:input.scope,action:input.action,campaignId:input.campaignId,revision:input.revision,manifestHash:input.manifestHash,entityRef:input.entityRef,entityVersion:input.entityVersion,requestHash:input.requestHash,
        dispatchKey:input.dispatchKey,payloadHash:input.payloadHash,providerBindingHash:input.providerBindingHash,attemptRef:input.attemptRef,attemptNumber:input.attemptNumber,provider:input.provider,providerAccountRef:input.providerAccountRef,nativeCampaignId:input.nativeCampaignId};
      const result:CanonicalMediaReadback={...identity,state:"applied",receiptRef:`native-receipt:${digest(input.dispatchKey)}`,observedAt:at(),outcome:state.rejected?"rejected":"applied",rejectionCode:state.rejected?"synthetic-rejection":null,native:{settings:n,...next}};
      results.set(input.dispatchKey,result);if(state.lostAck)throw new Error("Synthetic lost ACK after native effect.");return structuredClone(result);},
    readOperation:async identity=>{if(state.malformed)return null;if(results.has(identity.dispatchKey))return structuredClone(results.get(identity.dispatchKey));
      if(state.terminal&&intents.has(identity.dispatchKey))return{...identity,state:"notApplied",receiptRef:`closed:${identity.attemptRef}`,observedAt:at(),validUntil:until(),complete:true,originalAttemptClosed:true};return{state:"unknown",reasonCode:"SYNTHETIC_UNKNOWN"};},
    assertReadCurrent:()=>{if(state.denyRead)throw new DispatchError("MEDIA_READ_PERMISSION_REQUIRED",403);},
  };
  const stageSource:CanonicalStageSource={readBasis:async()=>{const r=kernel.control.canonicalStageRequest("stage:initial");return{scope,stageRef:r.stageRef,revision:r.revision,subjectHash:r.subjectHash,sourceRef:"synthetic-governance-basis",sourceVersion:state.stageVersion,observedAt:at(),validUntil:until(),
    permission:{sourceRef:"synthetic-governance-permission",sourceVersion:"governance-permission-v1",state:state.denyStage?"denied":"permitted",validUntil:until()},governanceAccount:{kind:"internalGovernance",accountRef:"synthetic-media-governance-ledger",accountVersion:"ledger-v1",sourceRef:"synthetic-ledger-membership"},poolRef:r.stageRef,poolVersion:r.subjectHash,
    allocationHash:digest([...r.terms.allocations].sort((a,b)=>key(a).localeCompare(key(b)))),terms:r.terms,parameterVersion:kernel.params.version,adoptionRef:"synthetic-economics-adoption",adoptedAt:"2026-11-01T00:00:00Z",
    gates:MEDIA_GATES.map(gate=>({gate,state:"verified",sourceRef:`stage-gate:${gate}`,sourceVersion:"gate-v1",validUntil:until()}))}satisfies StageSourceSnapshot;},
    assertCurrent:s=>{if(state.denyStage)throw new DispatchError("MEDIA_STAGE_PERMISSION_REQUIRED",403);if(s.sourceVersion!==state.stageVersion)throw new DispatchError("MEDIA_STAGE_SOURCE_CHANGED");},
    assertReadCurrent:()=>{if(state.denyRead||state.denyStage)throw new DispatchError("MEDIA_STAGE_READ_PERMISSION_REQUIRED",403);}};
  const bridge=createMediaDomainBridge({scope,repository:kernel.media,controller:kernel.control,source,stageSource,registration,now:()=>approval.state.now,
    stageApprovals:{resolveCurrentProof:b=>approvals.resolveCurrentProof(b),assertCurrentProof:(p,t)=>approvals.assertCurrentProof(p,t)}});
  const receipts=new Map<string,VerificationReceipt>(),ledger=new CapabilityLedger(approval.db,scope,{now:()=>approval.state.now,resolveReceipt:ref=>receipts.get(ref)??null});
  for(const a of accounts)for(const bindings of Object.values(a.bindings))for(const b of [bindings.execute,bindings.reconcile]){
    const row=ledger.get(capabilityIdForBinding(b))??ledger.register({binding:b,ownerRef:"owner:synthetic-media",costBasis:{state:"unknown",reasonCode:"SYNTHETIC_COST_UNKNOWN"}},0),receiptRef=`receipt:${digest(b)}`;
    receipts.set(receiptRef,{receiptRef,binding:b,outcome:"Ready",checkedAt:at(),expiresAt:until(),verifiedScopes:b.requiredScopes,connectionHealth:"Authenticated",sourceFreshness:unknownSourceFreshness(),businessEligibility:unknownBusinessEligibility(),reasonCodes:["SYNTHETIC_VERIFIED"]});await ledger.verify(row.capabilityId,receiptRef,row.revision);}
  const quota=new Map<string,ResourceGrant>();
  const resources:ResourceAuthority={resolveGrants:async request=>Object.entries(request.requirements).flatMap(([dimension,need])=>{
    if(need.state!=="required")return[];if(dimension==="budget")return[bridge.reserveBudget(request.intent,request.dispatchKey)];
    const grant:ResourceGrant={grantRef:`quota:${digest(request.dispatchKey)}`,issuerRef:"synthetic-shared-quota",allocationVersion:"quota-v1",scope,dispatchKey:request.dispatchKey,dimension:"quota",resourceRef:need.resourceRef,quantity:1,unit:"request",currency:null,observedAt:at(),validUntil:until(),exclusive:true,
      quotaBasis:{publishedLimit:100,operatingLimit:80,allocatedTotal:1,windowRef:"synthetic-quota-window",windowStart:at(),windowEnd:until(),sharedAcrossRoutes:true}};
    if(!quota.has(grant.grantRef))quota.set(grant.grantRef,grant);return[structuredClone(quota.get(grant.grantRef)!)];}),
    assertCurrent:(grants,request)=>{for(const g of grants)if(g.dimension==="budget")bridge.assertBudget(g,request.intent);else if(!sameQuota(g))throw new DispatchError("QUOTA_WITHDRAWN");}};
  function sameQuota(g:ResourceGrant){return digest(g)===digest(quota.get(g.grantRef));}
  const jobs=new JobRepository(approval.db,{scope,now:()=>approval.state.now,resolveCapability:b=>ledger.requireReady(b)});
  const approvals:ApprovalRepository=new ApprovalRepository(approval.db,{...approval.options,registry:bridge.registry,verifyOutcome:o=>dispatch.verifyOutcome(o)});
  const dispatch:DispatchGuard=new DispatchGuard({db:approval.db,scope,approvals,jobs,ledger,resourceAuthority:resources,handlers:bridge.handlers,now:()=>approval.state.now});
  const stage=kernel.control.proposeStage(kernel.terms(),"synthetic-stage-proposal");let sequence=0;
  async function approve(action:CanonicalMediaAction|typeof MEDIA_STAGE_ACTION,entityRef:string,actor="synthetic:founder"){
    sequence++;const entityVersion=action===MEDIA_STAGE_ACTION?String(kernel.control.canonicalStageRequest(entityRef).revision):kernel.media.canonicalRequest(entityRef,action).entityVersion;
    const p=await approvals.preparePreview({actionKind:action,entityRef,entityVersion,selectionRefs:[entityRef],expectedVersion:0},{principalRef:"synthetic:requester"},`preview-${sequence}`);
    const r=await approvals.requestDecision({approvalRef:p.manifest.approvalRef,expectedVersion:p.manifest.manifestVersion},{principalRef:"synthetic:requester"},`request-${sequence}`);
    const event=approval.event(r,"approved",actor,`synthetic:event-${sequence}`);return approvals.observeDecision(event.locator,{ingressRef:"synthetic:verified-relay"});}
  async function handoff(a:ApprovalRead){const descriptor=bridge.actions.get(a.manifest.draft.actionKind)!;
    const handlerRef="handlerRef"in descriptor?descriptor.handlerRef:descriptor.handlerRefsByAccount.get(a.manifest.draft.providerAccountRef)!;
    return dispatch.handoff({approval:approvalDispatchBinding(a.manifest,a.manifest.items[0]!.itemRef),handlerRef,payloadRef:a.manifest.draft.payloadRef},{principalRef:"synthetic:requester",idempotencyKey:`handoff-${a.manifest.approvalRef}`});}
  async function run(action:CanonicalMediaAction|typeof MEDIA_STAGE_ACTION,entityRef:string){const a=await approve(action,entityRef),r=await handoff(a);return dispatch.execute(r.runRef);}
  function advance(iso:string){approval.state.now=Date.parse(iso);approval.policy.observedAt=at();approval.policy.validUntil=until();
    for(const human of approval.humans.values()){human.observedAt=at();human.validUntil=until();}
    for(const event of approval.events.values()){event.observedAt=at();event.validUntil=until();}
    for(const receipt of approval.linear.values()){receipt.observedAt=at();receipt.validUntil=until();}
  }
  async function refreshCapabilities(){for(const row of ledger.list(100).records){const old=[...receipts.values()].find(r=>capabilityIdForBinding(r.binding)===row.capabilityId);if(!old)throw new Error("Missing synthetic capability.");
    const receiptRef=`receipt:${digest({binding:old.binding,now:at()})}`;receipts.set(receiptRef,{...old,receiptRef,checkedAt:at(),expiresAt:until()});await ledger.verify(row.capabilityId,receiptRef,row.revision);}}
  async function profitable(campaignId:string){advance("2026-11-10T20:00:00Z");await refreshCapabilities();const id=kernel.media.read(campaignId)!.native.nativeCampaignId!;kernel.spend.set(id,15000);
    for(let i=1;i<=3;i++)kernel.orders.push({source:"shop:synthetic",orderRef:`order-${i}`,channel:"website",placedAt:"2026-11-09T20:00:00Z",updatedAt:"2026-11-09T20:00:00Z",units:1,returnedUnits:0,
      merchandiseMinor:12000,shippingCollectedMinor:800,refundedMerchandiseMinor:0,refundedShippingMinor:0,returnWindowClosed:true,affiliateAttributed:false,commissionAccruedMinor:null,
      paidMediaMatch:{provider:"meta",providerAccountRef:META,nativeCampaignId:id}});}
  async function releaseStage(){await run(MEDIA_STAGE_ACTION,stage.stageRef);return kernel.control.read(stage.stageRef)!;}
  async function draft(provider:"meta"|"tiktok"="meta",lifetime=60000){const c=kernel.prepare(provider,lifetime);await run("media.createDraft",c.campaignId);return kernel.media.read(c.campaignId)!;}
  async function launch(campaignId:string){await run("media.publish",campaignId);return kernel.media.read(campaignId)!;}
  async function mutate(campaignId:string,kind:"pause"|"edit-budget",dailyBudgetMinor:number|null){const m=kernel.media.proposeMutation(campaignId,{kind,dailyBudgetMinor},`mutation-intent-${++sequence}`);await run(kind==="pause"?"media.pause":"media.changeBudget",m.mutationId);return kernel.media.readMutation(campaignId,m.mutationId)!;}
  return{approval,scope,kernel,state,source,stageSource,registration,bridge,approvals,ledger,jobs,dispatch,resources,quota,receipts,versions,results,intents,stage,approve,handoff,run,advance,refreshCapabilities,profitable,releaseStage,draft,launch,mutate};
}
