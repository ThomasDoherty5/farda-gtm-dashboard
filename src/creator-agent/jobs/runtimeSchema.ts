import { z } from "zod";
import type { JobRepository } from "./repository.ts";
import { jobDefinitionSchema, referenceInputSchema, type JobRunView } from "./schema.ts";
import { expectedBindingSchema, capabilityScopeSchema } from "../connections/schema.ts";
import type { CapabilityLedger } from "../connections/ledger.ts";
import { dispatchIntentSchema, grantSchema, type DispatchWorker, type DispatchRead } from "./dispatchSchema.ts";
import type { DispatchGuard } from "./dispatchGuard.ts";
import { scheduleDraftSchema } from "../scheduleCadence.ts";

export const runtimeRef = referenceInputSchema.shape.subjectRef;
export const runtimeInstant = z.string().datetime({offset:true}).refine(v=>Number.isFinite(Date.parse(v)));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const scopeSchema = capabilityScopeSchema.extend({environment:z.literal("sandbox")});
export const runtimeCadenceSchema = z.discriminatedUnion("kind",[
  z.object({kind:z.literal("calendar"),draft:scheduleDraftSchema,draftVersion:runtimeRef,startsAt:runtimeInstant}).strict(),
  z.object({kind:z.literal("hourly"),timezone:scheduleDraftSchema.shape.timezone,minute:z.number().int().min(0).max(59),startsAt:runtimeInstant}).strict(),
  z.object({kind:z.literal("event"),eventType:runtimeRef}).strict(),
]);
export type RuntimeCadence = z.infer<typeof runtimeCadenceSchema>;
export const runtimeRegistrationSchema = z.object({
  registrationRef:runtimeRef,version:z.number().int().positive().safe(),family:z.enum(["J19","J20","J08","registered-business"]),
  definition:jobDefinitionSchema,cadence:runtimeCadenceSchema,ownerRef:runtimeRef,sourceRef:runtimeRef,
  sourceSchemaVersion:runtimeRef,outputSchemaVersion:runtimeRef,membership:z.enum(["source-partitions","enrolled-only","approved-manifest"]),
  apiBinding:expectedBindingSchema.nullable(),browserBinding:expectedBindingSchema.nullable(),executorRef:runtimeRef,browserExecutorRef:runtimeRef.nullable(),apiChannel:z.enum(["directApi","mcp","model"]),
}).strict().superRefine((r,c)=>{
  if(r.family==="J08"&&(r.cadence.kind!=="hourly"||r.membership!=="enrolled-only"))c.addIssue({code:"custom",message:"J08 requires hourly enrolled-only membership."});
  if(["J19","J20"].includes(r.family)&&(r.cadence.kind!=="calendar"||r.cadence.draft.cadence!=="daily"))c.addIssue({code:"custom",message:"Discovery and review require distinct daily registrations."});
  if(r.definition.mode==="executeApproved"&&r.membership!=="approved-manifest")c.addIssue({code:"custom",message:"Execution requires an exact approved manifest."});
  if(r.apiBinding&&!["api","mcp","webhook"].includes(r.apiBinding.route))c.addIssue({code:"custom",message:"Primary binding must be a supported non-browser route."});
  if(r.apiBinding&&(r.apiBinding.route==="mcp")!==(r.apiChannel==="mcp"))c.addIssue({code:"custom",message:"MCP measurement must match its registered route."});
  if(r.apiChannel==="model"&&!r.definition.modelVersion)c.addIssue({code:"custom",message:"Model calls require a pinned model version."});
  if(r.browserBinding?.route!=="browser"&&r.browserBinding)c.addIssue({code:"custom",message:"Browser binding must be explicit."});
  if(Boolean(r.browserBinding)!==Boolean(r.browserExecutorRef))c.addIssue({code:"custom",message:"Browser binding and compiled executor must both be explicit."});
  for(const b of [r.apiBinding,r.browserBinding])if(b&&b.mode!==r.definition.mode)c.addIssue({code:"custom",message:"Binding mode mismatch."});
  if(r.apiBinding&&r.browserBinding&&(r.apiBinding.provider!==r.browserBinding.provider||r.apiBinding.providerAccountId!==r.browserBinding.providerAccountId||r.apiBinding.action!==r.browserBinding.action))c.addIssue({code:"custom",message:"Fallback must share the exact provider account and action."});
});
export type RuntimeRegistration = z.infer<typeof runtimeRegistrationSchema>;
const lease = {scope:scopeSchema,receiptRef:runtimeRef,observedAt:runtimeInstant,validUntil:runtimeInstant};
export const runtimeActivationSchema = z.object({...lease,registrationRef:runtimeRef,registrationHash:hash,sourceVersion:runtimeRef,
  triggerRef:runtimeRef,triggerVersion:runtimeRef,toolApprovalRef:runtimeRef,
  migration:z.discriminatedUnion("state",[
    z.object({state:z.literal("notApplicable"),policyVersion:runtimeRef}).strict(),
    z.object({state:z.literal("replacement"),oldTriggerRef:runtimeRef,oldTriggerVersion:runtimeRef,disabledReceiptRef:runtimeRef,disabledAt:runtimeInstant}).strict(),
  ]),
}).strict();
export type RuntimeActivation = z.infer<typeof runtimeActivationSchema>;
export const runtimeWindowSchema = z.object({windowRef:runtimeRef,registrationRef:runtimeRef,registrationVersion:z.number().int().positive().safe(),
  intendedAt:runtimeInstant,windowStart:runtimeInstant,windowEnd:runtimeInstant,eventRef:runtimeRef.nullable()}).strict();
export type RuntimeWindow = z.infer<typeof runtimeWindowSchema>;
const planBase = {...lease,sourceVersion:runtimeRef,registrationHash:hash,window:runtimeWindowSchema};
export const runtimeWindowPlanSchema = z.discriminatedUnion("kind",[
  z.object({...planBase,kind:z.literal("source"),items:z.array(referenceInputSchema.extend({enrollmentRef:runtimeRef.nullable()}).strict()).max(100),
    coverage:z.enum(["complete","partial"]),continuation:runtimeRef.nullable(),total:count.nullable()}).strict(),
  z.object({...planBase,kind:z.literal("approved"),intents:z.array(dispatchIntentSchema).min(1).max(100)}).strict(),
  z.object({...planBase,kind:z.literal("reconcile"),originalRunRef:runtimeRef}).strict(),
]);
export type RuntimeWindowPlan = z.infer<typeof runtimeWindowPlanSchema>;
export const runtimeBoundSchema = z.discriminatedUnion("state",[
  /** Source-owned normalized admissible records, never raw cents, inventory units or API requests. */
  z.object({state:z.literal("known"),remainingRecords:count,sourceRef:runtimeRef,basisRef:runtimeRef}).strict(),
  z.object({state:z.literal("unknown"),reasonCode:reason}).strict(),
  z.object({state:z.literal("notApplicable"),policyVersion:runtimeRef,reasonCode:reason}).strict(),
]);
export const runtimePreflightSchema = z.object({...lease,registrationHash:hash,windowRef:runtimeRef,itemKey:runtimeRef,checkpointHash:hash,
  bindingHash:hash,sourceVersion:runtimeRef,policyVersion:runtimeRef,modelVersion:runtimeRef.nullable(),offerVersion:runtimeRef.nullable(),
  enrollmentRef:runtimeRef.nullable(),grants:z.array(grantSchema).max(10),
  bounds:z.object({finiteScope:runtimeBoundSchema,quota:runtimeBoundSchema,evidence:runtimeBoundSchema,stock:runtimeBoundSchema,budget:runtimeBoundSchema}).strict(),
}).strict();
export type RuntimePreflight = z.infer<typeof runtimePreflightSchema>;
export const runtimeStepSchema = z.discriminatedUnion("state",[
  z.object({state:z.literal("completed"),evidenceRefs:z.array(runtimeRef).max(100),recordCount:count,sourceReceiptRef:runtimeRef}).strict(),
  z.object({state:z.literal("checkpoint"),evidenceRefs:z.array(runtimeRef).max(100),recordCount:count,nextCursor:runtimeRef,sourceReceiptRef:runtimeRef}).strict(),
  z.object({state:z.literal("takeover"),kind:z.enum(["login","mfa","captcha","uiDrift","termsChanged"]),handoffRef:runtimeRef,ownerRef:runtimeRef,reasonCode:reason}).strict(),
  z.object({state:z.literal("held"),reasonCode:reason}).strict(),
  z.object({state:z.literal("retry"),reasonCode:reason,retryAfterMs:z.number().int().min(0).max(3600000)}).strict(),
]);
export type RuntimeStep = z.infer<typeof runtimeStepSchema>;
export const runtimeTakeoverProofSchema=z.object({...lease,runRef:runtimeRef,itemRef:runtimeRef,takeoverVersion:z.number().int().positive().safe(),bindingHash:hash,resolutionRef:runtimeRef}).strict();
export type RuntimeTakeoverProof=z.infer<typeof runtimeTakeoverProofSchema>;
export const runtimeFireSchema=z.object({registrationRef:runtimeRef,registrationVersion:z.number().int().positive().safe(),intendedAt:runtimeInstant,triggerEventRef:runtimeRef}).strict();
export const runtimeWorkSchema=z.object({runRef:runtimeRef,maxItems:z.number().int().min(1).max(100).default(1)}).strict();
export const runtimeCatchUpSchema=z.object({registrationRef:runtimeRef,registrationVersion:z.number().int().positive().safe(),through:runtimeInstant,limit:z.number().int().min(1).max(24).default(10),cursor:runtimeInstant.optional()}).strict();
export const runtimeTakeoverSchema=z.object({runRef:runtimeRef,itemRef:runtimeRef,expectedVersion:z.number().int().positive().safe(),receiptRef:runtimeRef,requestKey:runtimeRef}).strict();
export type RuntimePreflightRequest={registration:RuntimeRegistration;window:RuntimeWindow;item:z.infer<typeof referenceInputSchema>;cursor:string|null;checkpointHash:string;binding:z.infer<typeof expectedBindingSchema>;requestKey:string};
export type RuntimeAuthority={
  resolveActivation(registration:RuntimeRegistration):Promise<unknown>;
  assertActivation(proof:RuntimeActivation,registration:RuntimeRegistration,now:number):void;
  prepareWindow(input:{registration:RuntimeRegistration;window:RuntimeWindow;continuation:string|null}):Promise<unknown>;
  assertWindow(proof:RuntimeWindowPlan,registration:RuntimeRegistration,now:number):void;
  resolvePreflight(input:RuntimePreflightRequest):Promise<unknown>;
  assertCurrent(proof:RuntimePreflight,input:RuntimePreflightRequest,now:number):void;
  resolveTakeover(input:z.infer<typeof runtimeTakeoverSchema>):Promise<unknown>;
  assertTakeover(proof:RuntimeTakeoverProof,now:number):void;
};
export type RuntimeExecutionContext={
  registration:RuntimeRegistration;window:RuntimeWindow;runRef:string;itemRef:string;subjectRef:string;cursor:string|null;
  maxRecords:number;binding:z.infer<typeof expectedBindingSchema>;assertCurrent():void;
  /** The runtime records an actual attempted invocation before calling the trusted transport. */
  invoke<T>(channel:"directApi"|"mcp"|"model"|"browser",operation:()=>Promise<T>):Promise<T>;
};
export type RuntimeExecutor={mode:"observe"|"propose"|"reconcile";execute(context:RuntimeExecutionContext):Promise<unknown>};
export type RuntimeRegistry={registrations:ReadonlyMap<string,RuntimeRegistration>;executors:ReadonlyMap<string,RuntimeExecutor>};
export type RuntimeOptions={scope:z.infer<typeof scopeSchema>;jobs:JobRepository;ledger:CapabilityLedger;dispatch?:DispatchGuard;registry:RuntimeRegistry;authority?:RuntimeAuthority;now?:()=>number};
export type RuntimeMachine=DispatchWorker;
export type RuntimeRunRead={schemaVersion:"farda.job-runtime.v1";registrationRef:string;registrationVersion:number;family:RuntimeRegistration["family"];window:RuntimeWindow;run:JobRunView;dispatch:DispatchRead|null;sourceCoverage:"complete"|"partial";sourceReceiptRef:string;sourceObservedAt:string;sourceFresh:boolean;delayMs:number;continuation:string|null;takeovers:{itemRef:string;version:number;kind:string;ownerRef:string;handoffRef:string;resolved:boolean}[];nextAction:string};
export class RuntimeError extends Error{readonly code:string;readonly status:number;readonly executionCertainty:"notApplied"|"applied"|"uncertain";constructor(code:string,status=409,certainty:"notApplied"|"applied"|"uncertain"="notApplied"){super(code);this.name="RuntimeError";this.code=code;this.status=status;this.executionCertainty=certainty;}}
