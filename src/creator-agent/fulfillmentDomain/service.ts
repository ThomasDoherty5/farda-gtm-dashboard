import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { ActionServiceError } from "../actions/contract.ts";
import { copyRegisteredAction, registeredHandler, registeredHandlerRefs, type RegisteredAction } from "../actions/registration.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";
import type { createActionService } from "../actions/service.ts";
import type { ActionDomain } from "../actionDomains.ts";
import { actorCanPropose } from "../approvals/policy.ts";
import { approvalDraftSchema, approvalScopeSchema, principalSchema, trustedHumanSchema,
  type ApprovalDraft, type ApprovalPrincipal, type ApprovalRead, type ApprovalRegistry, type ApprovalScope, type ProposeCommand } from "../approvals/contract.ts";
import { fulfillmentActionKinds, fulfillmentFilters, fulfillmentIntentSchema, fulfillmentPreviewAction, fulfillmentProposalSchema,
  FulfillmentError, type FulfillmentIntent, type FulfillmentKind, type FulfillmentPlan, type FulfillmentProposal } from "./contract.ts";
import { fulfillmentSnapshotSchema, fulfillmentSourceRequestSchema, FULFILLMENT_SOURCE_TTL_MS,
  type FulfillmentBindings, type FulfillmentOwnerObservation } from "./source.ts";

type Options={db:DatabaseSync;scope:ApprovalScope;secret:string;bindings?:FulfillmentBindings;now?:()=>number;timeoutMs?:number;
  actions:()=>Pick<ReturnType<typeof createActionService>,"execute"|"approvalVersion">;
  approvals:()=>{readCommand(kind:"propose",command:ProposeCommand,principal:ApprovalPrincipal,key:string):ApprovalRead|null}};
const freeze=<T>(v:T):T=>{if(v&&typeof v==="object"){Object.freeze(v);for(const child of Object.values(v))freeze(child);}return v;};
export function fulfillmentIntentDigest(intent:Omit<FulfillmentIntent,"intentRef"|"digest"|"createdAt">){return digest(intent);}
export function fulfillmentPayloadHash(intent:FulfillmentIntent){return digest(["fulfillment-intent.v1",intent.intentRef,intent.digest]);}
export function fulfillmentItemHash(intent:FulfillmentIntent,itemRef:string){return digest([fulfillmentPayloadHash(intent),itemRef]);}
export function fulfillmentBounds(plan:FulfillmentPlan){return {spend:plan.remedy.kind==="refund"?plan.remedy.amount.minorUnits:plan.remedy.costBound.minorUnits,
  currency:plan.remedy.kind==="refund"?plan.remedy.amount.currency:plan.remedy.costBound.currency,units:plan.remedy.kind==="replacement"?plan.remedy.quantity:0};}

/** Immutable proposal translation only. J04 owns approval; J15/J16 and the existing runner own every source effect. */
export function createFulfillmentDomain(options:Options){
  const {db}=options,scope=freeze(approvalScopeSchema.parse(options.scope)),bindings=options.bindings??{},now=options.now??Date.now;
  const owners=new Map(bindings.owners??[]),source=bindings.source,authority=bindings.authority;
  const scopeKey=digest(scope),alias=(kind:string,value:string)=>kind+"-"+createHmac("sha256",options.secret).update(JSON.stringify([scope,kind,value])).digest("hex").slice(0,40);
  function fail(code:string,status=409,certainty:"notApplied"|"applied"|"uncertain"="notApplied"):never{throw new FulfillmentError(code,status,certainty);}
  const at=()=>{const t=now();if(!Number.isSafeInteger(t))fail("FULFILLMENT_CLOCK_INVALID",500);return t;};
  const bound=db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
  if(bound?.workspace_id!==scope.workspaceId || bound?.account_id!==scope.accountId || options.secret.length<32)fail("FULFILLMENT_SCOPE_DENIED",403);
  db.exec("CREATE TABLE IF NOT EXISTS fulfillment_proposal_intents(scope_key TEXT NOT NULL,request_key TEXT NOT NULL,principal TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,request_hash TEXT NOT NULL,intent TEXT NOT NULL,PRIMARY KEY(scope_key,request_key))");
  const keyOf=(principal:ApprovalPrincipal,key:string)=>alias("request",JSON.stringify([principal.principalRef,key]));
  const commandKey=(intent:FulfillmentIntent)=>alias("canonical",intent.intentRef);
  const command=(intent:FulfillmentIntent):ProposeCommand=>({actionKind:fulfillmentActionKinds[intent.kind],entityRef:intent.intentRef,entityVersion:intent.digest,selectionRefs:intent.plan.items.map(i=>i.itemRef),expectedVersion:0});
  function parseIntent(raw:string){const i=fulfillmentIntentSchema.parse(JSON.parse(raw)),{intentRef,digest:hash,createdAt,...material}=i;void intentRef;void createdAt;
    if(hash!==fulfillmentIntentDigest(material)||digest(i.scope)!==scopeKey)fail("FULFILLMENT_INTENT_INVALID",409);return freeze(i);}
  function stored(principal:ApprovalPrincipal,key:string){const row=db.prepare("SELECT request_hash,intent FROM fulfillment_proposal_intents WHERE scope_key=? AND request_key=?").get(scopeKey,keyOf(principal,key));
    return row?{hash:String(row.request_hash),intent:parseIntent(String(row.intent))}:null;}
  function byRef(ref:string){const row=db.prepare("SELECT intent FROM fulfillment_proposal_intents WHERE scope_key=? AND json_extract(intent,'$.intentRef')=?").get(scopeKey,ref);return row?parseIntent(String(row.intent)):null;}
  const lookup=(i:FulfillmentIntent)=>options.approvals().readCommand("propose",command(i),{principalRef:i.principalRef},commandKey(i));
  const intentsFor=(kind:FulfillmentKind,target:string)=>db.prepare("SELECT intent FROM fulfillment_proposal_intents WHERE scope_key=? AND kind=? AND target=? ORDER BY request_key")
    .all(scopeKey,kind,target).map(row=>parseIntent(String(row.intent)));
  const pendingFor=(kind:FulfillmentKind,target:string)=>intentsFor(kind,target).filter(intent=>!lookup(intent)).map(intent=>intent.intentRef);
  // A recorded J04 preview is already a claim on this exact source plan. Another key must not mint a second dispatch identity.
  const claimedPlansFor=(kind:FulfillmentKind,target:string)=>intentsFor(kind,target).map(intent=>[intent.plan.planRef,intent.plan.version]);
  const planClaimed=(plan:FulfillmentPlan,claims:string[][])=>claims.some(([ref,version])=>ref===plan.planRef&&version===plan.version);
  function lease(observedAt:string,validUntil:string){const t=at(),o=Date.parse(observedAt),u=Date.parse(validUntil);return o<=t&&u>t&&u>o&&u-o<=FULFILLMENT_SOURCE_TTL_MS;}
  async function current(kind:FulfillmentKind,targetRef:string,rawPrincipal:ApprovalPrincipal,history:FulfillmentIntent|null,signal?:AbortSignal){
    if(!source || !authority?.resolveActor || !authority.assertCurrent || typeof source.assertCurrent!=="function")fail("FULFILLMENT_SOURCE_UNCONFIGURED",503);
    const principal=freeze(principalSchema.parse(structuredClone(rawPrincipal)));
    const parsedActor=trustedHumanSchema.safeParse(await boundedSourceRead(()=>authority.resolveActor!(principal.principalRef,scope),signal,options.timeoutMs));
    if(!parsedActor.success)return fail("FULFILLMENT_ACTOR_DENIED",403);
    const actor=freeze(parsedActor.data);
    const assertActor=()=>{if(!actor.active||actor.principalRef!==principal.principalRef||digest(actor.scope)!==scopeKey||!lease(actor.observedAt,actor.validUntil))fail("FULFILLMENT_ACTOR_DENIED",403);
      try{assertSynchronousVoid(()=>authority.assertCurrent!({scope,actor,slack:null,linearRecords:[]},at()));}catch{fail("FULFILLMENT_ACTOR_DENIED",403);}};
    assertActor();
    const request=freeze(fulfillmentSourceRequestSchema.parse({scope,principal,personRef:actor.personRef,directoryVersion:actor.directoryVersion,kind,targetRef,
      history:history?{intentRef:history.intentRef,digest:history.digest}:null}));
    const parsed=fulfillmentSnapshotSchema.safeParse(await boundedSourceRead(()=>source.read(request,{signal}),signal,options.timeoutMs));
    if(!parsed.success){if(parsed.error.issues.some(issue=>issue.path.at(-1)==="currency"))return fail("CURRENCY_NOT_SUPPORTED",503);return fail("FULFILLMENT_SOURCE_INVALID",502);}const snapshot=freeze(parsed.data);
    const assertCurrent=()=>{if(signal?.aborted)fail("REQUEST_CANCELLED",499);assertActor();
      if(digest(snapshot.request)!==digest(request))fail("FULFILLMENT_SOURCE_SCOPE_DENIED",403);
      if(snapshot.access!=="allowed")fail(snapshot.access==="denied"?"FULFILLMENT_SOURCE_DENIED":"FULFILLMENT_SOURCE_PERMISSION_UNKNOWN",snapshot.access==="denied"?403:503);
      if(history&&snapshot.historicalIntentAccess!=="allowed")fail("FULFILLMENT_HISTORY_ACCESS_DENIED",snapshot.historicalIntentAccess==="denied"?403:503);
      if(!lease(snapshot.observedAt,snapshot.validUntil))fail("FULFILLMENT_SOURCE_STALE");
      try{assertSynchronousVoid(()=>source.assertCurrent(snapshot,request,at()));}catch(error){if(error instanceof FulfillmentError||error instanceof ActionServiceError)throw error;fail("FULFILLMENT_SOURCE_CHANGED");}
      assertActor();};
    assertCurrent();return {actor,snapshot,request,assertCurrent};
  }
  type Current=Awaited<ReturnType<typeof current>>;
  const viewVersion=(p:Current)=>alias("version",digest([p.request.kind,p.request.targetRef,p.actor.personRef,p.actor.directoryVersion,p.snapshot.version,p.snapshot.permissionVersion,p.snapshot.policyVersion,p.snapshot.plans,p.snapshot.canPropose,p.snapshot.unresolvedActionRef]));
  function hold(p:Current){return !owners.has(p.request.kind)?"FULFILLMENT_OWNER_UNCONFIGURED":!actorCanPropose(p.actor,at())||!p.snapshot.canPropose?"FULFILLMENT_PROPOSAL_DENIED":p.snapshot.unresolvedActionRef?"FULFILLMENT_ORIGINAL_ACTION_UNCERTAIN":!p.snapshot.plans.length?"FULFILLMENT_NO_CURRENT_PLAN":null;}
  function publicPlan(plan:FulfillmentPlan,p:Current){const a=(v:string)=>alias("reference",v),r=plan.remedy,reason=hold(p);
    const remedy=r.kind==="refund"?{...r,orderRef:a(r.orderRef),lineRefs:r.lineRefs.map(a),balanceVersion:a(r.balanceVersion)}:
      {...r,skuRef:a(r.skuRef),originalOrderRef:r.originalOrderRef?a(r.originalOrderRef):null,originalShipmentRef:a(r.originalShipmentRef),newOrderRef:a(r.newOrderRef),newShipmentRef:a(r.newShipmentRef),stockEvidenceRef:a(r.stockEvidenceRef),stockVersion:a(r.stockVersion),addressRef:a(r.addressRef)};
    return {planRef:alias("plan",plan.planRef),summary:plan.remedy.kind==="refund"?"Review exact refund plan":"Review exact replacement plan",disposition:plan.disposition,
      inspectedQuantity:plan.inspection?.inspectedQuantity??null,inspectionEvidenceRef:plan.inspection?a(plan.inspection.evidenceRef):null,remedy,capability:{state:reason?"held" as const:"available" as const,reasonCodes:reason?[reason]:[]}};}
  function requireOriginal(i:FulfillmentIntent,kind:FulfillmentKind,targetRef:string,principal:ApprovalPrincipal){if(i.principalRef!==principal.principalRef||i.kind!==kind||i.targetRef!==targetRef)fail("FULFILLMENT_REQUEST_SCOPE_DENIED",403);}
  async function read(raw:unknown,principal:ApprovalPrincipal,signal?:AbortSignal){
    const f=fulfillmentFilters.parse(raw),row=f.requestKey?stored(principal,f.requestKey):null;if(row)requireOriginal(row.intent,f.kind,f.targetRef,principal);
    const p=await current(f.kind,f.targetRef,principal,row?.intent??null,signal),approval=row?lookup(row.intent):null,pendingRefs=pendingFor(f.kind,f.targetRef),claims=claimedPlansFor(f.kind,f.targetRef);
    const recovered=approval?{approvalRef:approval.manifest.approvalRef,manifestRef:"manifest-"+approval.manifest.manifestHash,version:options.actions().approvalVersion(approval)}:null;
    const pending=pendingRefs.length>0,reason=pending?"FULFILLMENT_PRIOR_PROPOSAL_PENDING":hold(p)??(p.snapshot.plans.every(plan=>planClaimed(plan,claims))?"FULFILLMENT_PLAN_ALREADY_PROPOSED":null),data:FulfillmentProposal=fulfillmentProposalSchema.parse({kind:"native-fulfillment-proposal",target:{kind:f.kind,ref:f.targetRef},version:viewVersion(p),
      source:{synthetic:p.snapshot.synthetic,observedAt:p.snapshot.observedAt,validUntil:new Date(Math.min(Date.parse(p.snapshot.validUntil),Date.parse(p.actor.validUntil))).toISOString()},
      plans:p.snapshot.plans.map(plan=>{const projected=publicPlan(plan,p),claimReason=pending?"FULFILLMENT_PRIOR_PROPOSAL_PENDING":planClaimed(plan,claims)?"FULFILLMENT_PLAN_ALREADY_PROPOSED":null;return claimReason?{...projected,capability:{state:"held" as const,reasonCodes:[claimReason]}}:projected;}),capability:{state:reason?"held":"available",reasonCodes:reason?[reason]:[]},
      recovery:f.requestKey?{requestKey:f.requestKey,state:approval?"recorded":row?"pending":"absent",approvalRef:recovered?.approvalRef??null,manifestRef:recovered?.manifestRef??null,version:recovered?.version??null}:null});
    const assertCurrent=()=>{p.assertCurrent();if(f.requestKey){const latest=stored(principal,f.requestKey);if(digest(latest)!==digest(row)||digest(latest?lookup(latest.intent):null)!==digest(approval))fail("FULFILLMENT_REQUEST_CHANGED");}
      if(digest(pendingFor(f.kind,f.targetRef))!==digest(pendingRefs)||digest(claimedPlansFor(f.kind,f.targetRef))!==digest(claims))fail("FULFILLMENT_REQUEST_CHANGED");p.assertCurrent();};
    assertCurrent();return {data,assertCurrent};
  }
  function assertIntent(i:FulfillmentIntent,p:Current){p.assertCurrent();const reason=hold(p);if(reason)fail(reason,reason.endsWith("UNCONFIGURED")?503:409);
    if(i.personRef!==p.actor.personRef||i.directoryVersion!==p.actor.directoryVersion||i.permissionVersion!==p.snapshot.permissionVersion||i.sourceVersion!==p.snapshot.version||
      i.baseVersion!==viewVersion(p)||!p.snapshot.plans.some(plan=>digest(plan)===digest(i.plan))||digest(byRef(i.intentRef))!==digest(i))fail("FULFILLMENT_INTENT_CHANGED");}
  const issued=new Map<string,{intent:FulfillmentIntent;proof:Current;draft:ApprovalDraft}>();
  function validateDraft(i:FulfillmentIntent,p:Current,raw:unknown){const draft=approvalDraftSchema.parse(raw),owner=owners.get(i.kind);if(!owner)fail("FULFILLMENT_OWNER_UNCONFIGURED",503);
    const handler=owner.handlers.get(registeredHandler(owner.registration,i.plan.providerAccountRef));
    if(!handler||handler.provider.state!=="required"||handler.provider.binding.providerAccountId!==i.plan.providerAccountRef||handler.provider.binding.workspaceId!==scope.workspaceId||handler.provider.binding.accountId!==scope.accountId||handler.provider.binding.environment!==scope.environment)fail("FULFILLMENT_OWNER_ACCOUNT_MISMATCH");
    const bounds=fulfillmentBounds(i.plan),expected=i.plan.items.map(item=>({...item,payloadHash:fulfillmentItemHash(i,item.itemRef)}));
    if(draft.actionKind!==fulfillmentActionKinds[i.kind]||draft.sourceBasisRef!==i.intentRef||draft.sourceBasisVersion!==i.digest||draft.payloadRef!==i.intentRef||draft.payloadHash!==fulfillmentPayloadHash(i)||
      draft.providerAccountRef!==i.plan.providerAccountRef||draft.providerAccountVersion!==i.plan.providerAccountVersion||draft.policyVersion!==i.plan.policyVersion||
      draft.phase!==(i.plan.remedy.kind==="replacement"?"shipment":"other")||digest(draft.items)!==digest(expected)||draft.bounds.maxItems!==expected.length||
      draft.bounds.maxSpendMinor!==bounds.spend||draft.bounds.maxUnits!==bounds.units||draft.bounds.currency!==bounds.currency||draft.exposure.state!=="known"||draft.exposure.minor!==bounds.spend||draft.exposure.currency!==bounds.currency||
      draft.effects.spendsMoney!==(bounds.spend>0)||draft.effects.sendsCreator||draft.effects.changesPolicy||draft.acquisitionTerms||draft.historicalLiability||draft.mediaAuthorization||draft.commercialOffers||
      Date.parse(draft.sourceValidUntil)>Math.min(Date.parse(p.snapshot.validUntil),Date.parse(p.actor.validUntil)))fail("FULFILLMENT_DRAFT_BINDING_CHANGED");
    assertIntent(i,p);const observation:FulfillmentOwnerObservation=freeze({intent:i,snapshot:p.snapshot,actor:p.actor});
    assertSynchronousVoid(()=>owner.assertCurrent(observation,freeze(structuredClone(draft)),at()));assertIntent(i,p);return draft;}
  async function resolve(i:FulfillmentIntent,phase:"preview"|"current"){
    const owner=owners.get(i.kind);if(!owner)fail("FULFILLMENT_OWNER_UNCONFIGURED",503);
    const p=await current(i.kind,i.targetRef,{principalRef:i.principalRef},i);assertIntent(i,p);
    const raw=await boundedSourceRead(()=>owner.resolveDraft(freeze({intent:i,snapshot:p.snapshot,actor:p.actor,phase})),undefined,options.timeoutMs);
    const draft=validateDraft(i,p,raw);issued.set(digest([i.intentRef,draft]),{intent:i,proof:p,draft:freeze(structuredClone(draft))});while(issued.size>256)issued.delete(issued.keys().next().value!);return draft;}
  const registry:ApprovalRegistry={
    async resolvePreview(c,principal,actualScope){const i=byRef(c.entityRef);if(!i||digest(actualScope)!==scopeKey||i.principalRef!==principal.principalRef||digest(c)!==digest(command(i)))fail("FULFILLMENT_EXACT_INTENT_REQUIRED");return resolve(i,"preview");},
    async currentDraft(manifest){const i=byRef(manifest.draft.sourceBasisRef);if(!i||digest(manifest.scope)!==scopeKey||i.principalRef!==manifest.proposer.principalRef||manifest.draft.sourceBasisVersion!==i.digest)fail("FULFILLMENT_EXACT_INTENT_REQUIRED");return resolve(i,"current");},
    assertCurrentDraft(manifest,observed,timestamp){if(!Number.isSafeInteger(timestamp)||timestamp>at())fail("FULFILLMENT_CLOCK_INVALID",500);const v=issued.get(digest([manifest.draft.sourceBasisRef,observed]));
      if(!v||manifest.proposer.principalRef!==v.intent.principalRef||digest(manifest.scope)!==scopeKey||manifest.draft.sourceBasisVersion!==v.intent.digest)fail("FULFILLMENT_DRAFT_UNVERIFIED");validateDraft(v.intent,v.proof,observed);},
  };
  const actions=new Map<string,RegisteredAction>(),handlers=new Map<string,DispatchHandler>();
  for(const [kind,owner]of owners){if(!fulfillmentActionKinds[kind]||typeof owner.resolveDraft!=="function"||typeof owner.assertCurrent!=="function")fail("FULFILLMENT_OWNER_INVALID",500);
    const registration=copyRegisteredAction(owner.registration);for(const name of registeredHandlerRefs(registration)){const handler=owner.handlers.get(name);if(!handler||handler.idempotency!=="source-enforced"||handler.sourceEffect!=="providerApplied"||handler.provider.state!=="required"||handlers.has(name))fail("FULFILLMENT_OWNER_INVALID",500);handlers.set(name,handler);}actions.set(fulfillmentActionKinds[kind],registration);}
  const domain:ActionDomain={registry,actions,handlers};
  async function preview(raw:unknown,principal:ApprovalPrincipal,signal?:AbortSignal){
    const a=fulfillmentPreviewAction.parse(raw);if(a.requestedScope.workspaceId!==scope.workspaceId||a.requestedScope.accountIds[0]!==scope.accountId)fail("FULFILLMENT_SCOPE_DENIED",403);
    const hash=digest([scope,principal,a.expectedVersion,a.payload]);let row=stored(principal,a.idempotencyKey);if(row&&row.hash!==hash)fail("IDEMPOTENCY_CONFLICT");const observedRow=row;
    const p=await current(a.payload.kind,a.payload.targetRef,principal,row?.intent??null,signal),reason=hold(p);if(reason)fail(reason,reason.endsWith("UNCONFIGURED")?503:409);
    let intent:FulfillmentIntent;
    db.exec("BEGIN IMMEDIATE");try{p.assertCurrent();row=stored(principal,a.idempotencyKey);if(row){if(row.hash!==hash)fail("IDEMPOTENCY_CONFLICT");
        // A late original needs its own explicit historical grant; do not reuse a history:null observation.
        if(digest(row)!==digest(observedRow))fail("FULFILLMENT_REQUEST_CHANGED",409,"uncertain");intent=row.intent;}
      else{if(pendingFor(a.payload.kind,a.payload.targetRef).length)fail("FULFILLMENT_PRIOR_PROPOSAL_PENDING",409,"uncertain");
        if(a.expectedVersion!==viewVersion(p))fail("STALE_VERSION");const plan=p.snapshot.plans.find(plan=>alias("plan",plan.planRef)===a.payload.planRef);if(!plan)fail("FULFILLMENT_PLAN_CHANGED");
        if(planClaimed(plan,claimedPlansFor(a.payload.kind,a.payload.targetRef)))fail("FULFILLMENT_PLAN_ALREADY_PROPOSED");
        const material={scope,principalRef:principal.principalRef,personRef:p.actor.personRef,directoryVersion:p.actor.directoryVersion,kind:a.payload.kind,targetRef:a.payload.targetRef,
          baseVersion:a.expectedVersion,permissionVersion:p.snapshot.permissionVersion,sourceVersion:p.snapshot.version,plan,reason:a.payload.reason};
        intent=freeze(fulfillmentIntentSchema.parse({...material,intentRef:"fulfillment-intent-"+randomUUID(),digest:fulfillmentIntentDigest(material),createdAt:new Date(at()).toISOString()}));
        p.assertCurrent();db.prepare("INSERT INTO fulfillment_proposal_intents VALUES(?,?,?,?,?,?,?)").run(scopeKey,keyOf(principal,a.idempotencyKey),principal.principalRef,a.payload.kind,a.payload.targetRef,hash,JSON.stringify(intent));}
      db.exec("COMMIT");}catch(error){db.exec("ROLLBACK");throw error;}
    // Only this existing service creates J04 records. No provider/worker call belongs to the bridge.
    try{const c=command(intent),response=await options.actions().execute({schemaVersion:a.schemaVersion,requestId:a.requestId,operation:"previewAction",actionKind:c.actionKind,
      requestedScope:a.requestedScope,entityRefs:[],approvalRef:null,manifestRef:null,expectedVersion:intent.digest,idempotencyKey:commandKey(intent),payload:{entityRef:c.entityRef,entityVersion:c.entityVersion,selectionRefs:c.selectionRefs}},principal);
      const receipt=lookup(intent);if(!receipt)fail("FULFILLMENT_PREVIEW_UNVERIFIED",502,"uncertain");
      const assertCurrent=()=>{p.assertCurrent();if(digest(byRef(intent.intentRef))!==digest(intent)||digest(lookup(intent))!==digest(receipt))fail("FULFILLMENT_INTENT_CHANGED",409,"applied");p.assertCurrent();};assertCurrent();return {response,assertCurrent};
    }catch(error){let failure=error;try{p.assertCurrent();}catch(currentError){failure=currentError;}
      if(failure instanceof FulfillmentError||failure instanceof ActionServiceError)throw new FulfillmentError(failure.code,failure.status,failure.executionCertainty==="applied"?"applied":"uncertain");throw new FulfillmentError("FULFILLMENT_PREVIEW_UNVERIFIED",502,"uncertain");}
  }
  return {read,preview,domain};
}
