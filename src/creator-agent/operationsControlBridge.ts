import { z } from "zod";
import { digest } from "./config.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";
import { approvalDraftSchema, approvalScopeSchema, approvalRefSchema as ref, approvalInstantSchema as instant, proposeCommandSchema,
  type ApprovalDraft, type ApprovalPrincipal, type ApprovalRegistry, type ApprovalRead } from "./approvals/contract.ts";
import type { ActionResponse } from "../adapter/contract.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import type { createActionService, RegisteredAction } from "./actions/service.ts";
import { copyRegisteredAction, registeredHandlerRefs } from "./actions/registration.ts";
import type { DispatchHandler } from "./jobs/dispatchSchema.ts";
import type { ActionDomain } from "./actionDomains.ts";
import { operationsAuthorityTargetSchema, operationsTargetMaterialHash, OperationsAuthorityError, type OperationsControlAuthority, type OperationsControlProof } from "./operationsControlAuthority.ts";

export const operationsCanonicalKinds = ["task", "takeover", "repair", "permissionEvidence"] as const;
export const operationsCanonicalActionKinds = {task:"operations.task",takeover:"operations.takeover",repair:"operations.repair",permissionEvidence:"operations.permissionEvidence"} as const;
export type OperationsCanonicalKind = typeof operationsCanonicalKinds[number];
export const operationsCanonicalIntentSchema = z.object({
  mode:z.literal("canonical-v2"),intentRef:ref,digest:z.string().regex(/^[a-f0-9]{64}$/),scope:approvalScopeSchema,
  principalRef:ref,personRef:ref,directoryVersion:ref,createdAt:instant,
  kind:z.enum(operationsCanonicalKinds),targetId:ref,reason:z.string().trim().min(1).max(1000),baseVersion:z.string().regex(/^oc1-[a-f0-9]{64}$/),
  sourceRevision:ref,sourceMaterialHash:z.string().regex(/^[a-f0-9]{64}$/),target:operationsAuthorityTargetSchema,
  selectedItemRefs:z.array(ref).min(1).max(100),
}).strict().superRefine((value,ctx)=>{
  if(value.kind!==value.target.kind||value.targetId!==value.target.id||new Set(value.selectedItemRefs).size!==value.selectedItemRefs.length||value.selectedItemRefs.some(item=>!value.target.items.some(t=>t.itemRef===item)))
    ctx.addIssue({code:"custom",message:"The canonical intent must select exact source target items."});
  const {digest:hash,intentRef,createdAt,...material}=value;void intentRef;void createdAt;
  if(hash!==operationsIntentDigest(material))ctx.addIssue({code:"custom",message:"The immutable intent digest must cover its full configured material."});
});
export type OperationsCanonicalIntent=z.infer<typeof operationsCanonicalIntentSchema>;
export function operationsIntentDigest(value:Omit<OperationsCanonicalIntent,"digest"|"intentRef"|"createdAt">):string{return digest(value);}
export function operationsIntentPayloadHash(intent:OperationsCanonicalIntent):string{return digest(["operations-control-payload.v2",intent.intentRef,intent.digest]);}
export function operationsIntentItemHash(intent:OperationsCanonicalIntent,itemRef:string):string{return digest([operationsIntentPayloadHash(intent),itemRef]);}

export interface OperationsCanonicalSource {
  /** Delegate to this exact registered source owner; returning a draft grants no approval. */
  resolveDraft(input:{intent:OperationsCanonicalIntent;proof:OperationsControlProof;phase:"preview"|"current"}):Promise<unknown>;
  assertCurrent(input:{intent:OperationsCanonicalIntent;proof:OperationsControlProof},draft:ApprovalDraft,now:number):void;
}
export type OperationsOwnerRegistration={registration:RegisteredAction;handlers:ReadonlyMap<string,DispatchHandler>};
export type OperationsControlBridgeOptions={
  scope:z.infer<typeof approvalScopeSchema>;authority:OperationsControlAuthority;source:OperationsCanonicalSource;
  owners:ReadonlyMap<OperationsCanonicalKind,OperationsOwnerRegistration>;
  intents:{read(ref:string):OperationsCanonicalIntent|null;assertCurrent(intent:OperationsCanonicalIntent,proof:OperationsControlProof):void};
  actions:()=>Pick<ReturnType<typeof createActionService>,"execute">;
  approvals:()=>{readCommand(kind:"propose",command:z.infer<typeof proposeCommandSchema>,principal:ApprovalPrincipal,key:string):ApprovalRead|null};
  now?:()=>number;
};

/** One source registry facade over the existing immutable app-intent, J04 and runner. */
export function createOperationsControlBridge(options:OperationsControlBridgeOptions){
  const scope=approvalScopeSchema.parse(structuredClone(options.scope)),now=options.now??Date.now;
  const owners=new Map([...options.owners].map(([kind,value])=>[kind,{registration:copyRegisteredAction(value.registration),handlers:new Map(value.handlers)}]));
  for(const [kind,owner]of owners){
    if(!operationsCanonicalKinds.includes(kind)||registeredHandlerRefs(owner.registration).some(handler=>!owner.handlers.has(handler)))throw new Error("Operations control owner registration is incomplete.");
  }
  const fail=(code:string,status=409):never=>{throw new OperationsAuthorityError(code,status);};
  function readIntent(id:string,principal:ApprovalPrincipal,requireOwner=true){
    const raw=options.intents.read(id);if(!raw)return fail("OPERATIONS_CANONICAL_INTENT_REQUIRED",404);
    const intent=operationsCanonicalIntentSchema.parse(structuredClone(raw));
    if(digest(intent.scope)!==digest(scope)||intent.principalRef!==principal.principalRef)return fail("OPERATIONS_SOURCE_SCOPE_DENIED",403);
    if(requireOwner&&!owners.has(intent.kind))return fail("OPERATIONS_OWNER_UNCONFIGURED",503);
    return intent;
  }
  const key=(principal:ApprovalPrincipal,requestKey:string)=>"operations-preview-"+digest([scope,principal.principalRef,ref.parse(requestKey)]);
  function command(intent:OperationsCanonicalIntent){return proposeCommandSchema.parse({actionKind:operationsCanonicalActionKinds[intent.kind],entityRef:intent.intentRef,
    entityVersion:intent.digest,selectionRefs:intent.selectedItemRefs,expectedVersion:0});}
  function assertIntent(intent:OperationsCanonicalIntent,proof:OperationsControlProof){
    proof.assertCurrent();
    if(!proof.actor.roles.some(role=>["founder","operator","reviewer","finance"].includes(role))||proof.actor.personRef!==intent.personRef||proof.actor.directoryVersion!==intent.directoryVersion)
      return fail("OPERATIONS_NAMED_ACTOR_DENIED",403);
    if(digest(options.intents.read(intent.intentRef))!==digest(intent))return fail("OPERATIONS_INTENT_CHANGED");
    const target=proof.authority.targets.find(value=>value.kind===intent.kind&&value.id===intent.targetId);
    if(!target||target.permission!=="allowed"||target.ownerPersonRef!==intent.target.ownerPersonRef||digest(target)!==digest(intent.target)||operationsTargetMaterialHash(proof,intent.kind,intent.targetId)!==intent.sourceMaterialHash)
      return fail(target?.permission==="denied"?"OPERATIONS_SOURCE_SCOPE_DENIED":"OPERATIONS_TARGET_CHANGED",target?.permission==="denied"?403:409);
    assertSynchronousVoid(()=>options.intents.assertCurrent(structuredClone(intent),proof));proof.assertCurrent();
  }
  function validateDraft(intent:OperationsCanonicalIntent,proof:OperationsControlProof,raw:unknown){
    const parsed=approvalDraftSchema.safeParse(raw);if(!parsed.success)return fail("OPERATIONS_DRAFT_INVALID",502);
    const draft=parsed.data,target=intent.target;
    const expectedItems=target.items.filter(item=>intent.selectedItemRefs.includes(item.itemRef)).map(item=>({...item,payloadHash:operationsIntentItemHash(intent,item.itemRef)}));
    if(draft.actionKind!==operationsCanonicalActionKinds[intent.kind]||draft.providerAccountRef!==target.providerAccountRef||draft.providerAccountVersion!==target.providerAccountVersion||
      draft.sourceBasisRef!==intent.intentRef||draft.sourceBasisVersion!==intent.digest||draft.payloadHash!==operationsIntentPayloadHash(intent)||
      digest([...draft.items].sort((a,b)=>a.itemRef.localeCompare(b.itemRef)))!==digest([...expectedItems].sort((a,b)=>a.itemRef.localeCompare(b.itemRef)))||Date.parse(draft.sourceValidUntil)>Date.parse(proof.validUntil))
      return fail("OPERATIONS_DRAFT_BINDING_CHANGED");
    if(intent.kind!=="task"&&(draft.effects.spendsMoney||draft.effects.sendsCreator||draft.effects.changesPolicy||draft.items.some(item=>item.spendMinor!==0)))
      return fail("OPERATIONS_EFFECT_NOT_PERMITTED",403);
    assertIntent(intent,proof);
    try{assertSynchronousVoid(()=>options.source.assertCurrent({intent:structuredClone(intent),proof},structuredClone(draft),now()));}
    catch(error){if(error instanceof OperationsAuthorityError)throw error;return fail("OPERATIONS_DRAFT_SOURCE_CHANGED");}
    assertIntent(intent,proof);return draft;
  }
  // Retained observation is source-backed, not an issuer-created release flag. J04 stores its own proof.
  const issued=new Map<string,{intent:OperationsCanonicalIntent;proof:OperationsControlProof;draft:ApprovalDraft}>();
  async function resolve(intent:OperationsCanonicalIntent,phase:"preview"|"current"){
    const proof=await options.authority.resolve({principalRef:intent.principalRef});assertIntent(intent,proof);
    const raw=await options.source.resolveDraft({intent:structuredClone(intent),proof,phase});
    const draft=validateDraft(intent,proof,raw);issued.set(digest([intent.intentRef,draft]),{intent:structuredClone(intent),proof,draft:structuredClone(draft)});
    // Bound process-local observations; durable source/approval history remains in the existing repositories.
    while(issued.size>256)issued.delete(issued.keys().next().value!);return draft;
  }
  const registry:ApprovalRegistry={
    async resolvePreview(raw,principal,actualScope){
      const c=proposeCommandSchema.parse(structuredClone(raw)),intent=readIntent(c.entityRef,principal);
      if(digest(actualScope)!==digest(scope)||digest(c)!==digest(command(intent)))return fail("OPERATIONS_EXACT_INTENT_REQUIRED",409);
      return resolve(intent,"preview");
    },
    async currentDraft(manifest){
      const intent=readIntent(manifest.draft.sourceBasisRef,{principalRef:manifest.proposer.principalRef});
      if(digest(manifest.scope)!==digest(scope)||manifest.draft.sourceBasisVersion!==intent.digest||manifest.draft.actionKind!==operationsCanonicalActionKinds[intent.kind])return fail("OPERATIONS_EXACT_INTENT_REQUIRED");
      return resolve(intent,"current");
    },
    assertCurrentDraft(manifest,observed,timestamp){
      if(!Number.isSafeInteger(timestamp)||timestamp>now())return fail("INVALID_CLOCK",500);
      const found=issued.get(digest([manifest.draft.sourceBasisRef,observed]));
      if(!found||manifest.draft.sourceBasisVersion!==found.intent.digest||manifest.proposer.principalRef!==found.intent.principalRef||digest(manifest.scope)!==digest(scope))return fail("OPERATIONS_DRAFT_SOURCE_UNVERIFIED");
      validateDraft(found.intent,found.proof,observed);
    },
  };
  const actions=new Map<string,RegisteredAction>(),handlers=new Map<string,DispatchHandler>();
  for(const [kind,owner]of owners){actions.set(operationsCanonicalActionKinds[kind],owner.registration);for(const [id,handler]of owner.handlers){if(handlers.has(id)&&handlers.get(id)!==handler)throw new Error("Duplicate operations handler owner.");handlers.set(id,handler);}}
  const domain:ActionDomain={registry,actions,handlers};
  function lookup(intentRef:string,principal:ApprovalPrincipal,requestKey:string){const intent=readIntent(intentRef,principal,false);return options.approvals().readCommand("propose",command(intent),principal,key(principal,requestKey));}
  async function preview(intentRef:string,principal:ApprovalPrincipal,requestKey:string,requestId:string):Promise<ActionResponse>{
    const intent=readIntent(intentRef,principal),proof=await options.authority.resolve(principal);assertIntent(intent,proof);
    const c=command(intent),response=await options.actions().execute({schemaVersion:SCHEMA_VERSION,operation:"previewAction",actionKind:c.actionKind,
      requestId,requestedScope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:scope.environment},entityRefs:[],approvalRef:null,manifestRef:null,
      expectedVersion:intent.digest,idempotencyKey:key(principal,requestKey),payload:{entityRef:c.entityRef,entityVersion:c.entityVersion,selectionRefs:c.selectionRefs}},principal);
    try{assertIntent(intent,proof);}catch(error){if(error instanceof OperationsAuthorityError)throw new OperationsAuthorityError(error.code,error.status,response.executionCertainty??"uncertain");throw error;}
    return response;
  }
  return {domain,preview,lookup,supports:(kind:OperationsCanonicalKind)=>owners.has(kind)};
}
export type OperationsControlBridge=ReturnType<typeof createOperationsControlBridge>;
