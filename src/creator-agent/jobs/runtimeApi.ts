import {createHmac,timingSafeEqual} from "node:crypto";
import {z} from "zod";
import {digest} from "../config.ts";
import {openOperationsToken,sealOperationsToken} from "../operationsTokens.ts";
import type {ApiRequestLimits} from "../apiRequestLimits.ts";
import {approvalScopeSchema,trustedHumanSchema,type ApprovalSources,type TrustedHuman} from "../approvals/contract.ts";
import type {JobRuntime} from "./runtime.ts";
import {runtimeApiOperationSchema,safeRuntimeRunSchema,safeRuntimeRegistrationSchema,runtimeApiAckSchema,runtimeUsageViewSchema,safeRuntimeSchedulingSchema,type RuntimeApiOperation,type SafeRuntimeRun,type RuntimeApiAck} from "./runtimeViews.ts";
export {runtimeApiOperationSchema,safeRuntimeRunSchema,safeRuntimeRegistrationSchema,runtimeApiAckSchema} from "./runtimeViews.ts";
import type {RuntimeUsageRead} from "./runtimeMeasurements.ts";
import {RuntimeError,runtimeRef,runtimeInstant,runtimeFireSchema,runtimeWorkSchema,runtimeCatchUpSchema,runtimeTakeoverSchema,type RuntimeMachine,type RuntimeOptions,type RuntimeRunRead} from "./runtimeSchema.ts";

const publicRef=z.string().min(1).max(1400).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const inputSchemas={install:z.object({registrationRef:publicRef,expectedVersion:z.number().int().nonnegative().safe()}).strict(),fire:runtimeFireSchema.extend({registrationRef:publicRef}),
  catchUp:runtimeCatchUpSchema.extend({registrationRef:publicRef}),work:runtimeWorkSchema.extend({runRef:publicRef}),continue:z.object({runRef:publicRef}).strict(),reconcile:z.object({runRef:publicRef}).strict(),takeover:runtimeTakeoverSchema.extend({runRef:publicRef,itemRef:publicRef})};
export const runtimeApiCommandSchema=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("install"),input:inputSchemas.install}).strict(),z.object({operation:z.literal("fire"),input:inputSchemas.fire}).strict(),z.object({operation:z.literal("catchUp"),input:inputSchemas.catchUp}).strict(),
  z.object({operation:z.literal("work"),input:inputSchemas.work}).strict(),z.object({operation:z.literal("continue"),input:inputSchemas.continue}).strict(),z.object({operation:z.literal("reconcile"),input:inputSchemas.reconcile}).strict(),z.object({operation:z.literal("takeover"),input:inputSchemas.takeover}).strict(),
]);
type Command=z.infer<typeof runtimeApiCommandSchema>;
export const runtimeMachineProofSchema=z.object({scope:approvalScopeSchema,workerRef:runtimeRef,operation:runtimeApiOperationSchema,inputHash:z.string().regex(/^[a-f0-9]{64}$/),proofRef:runtimeRef,observedAt:runtimeInstant,validUntil:runtimeInstant}).strict();
export type RuntimeMachineProof=z.infer<typeof runtimeMachineProofSchema>;
export type RuntimeMachineBinding={token:string;workerRef:string;resolve(scope:RuntimeOptions["scope"],operation:RuntimeApiOperation,input:Command["input"]):Promise<unknown>;assertCurrent(proof:RuntimeMachineProof,now:number):void};
export type RuntimeApiOptions={runtime:JobRuntime;scope:RuntimeOptions["scope"];secret:string;machine?:RuntimeMachineBinding;
  actorSources?:Pick<ApprovalSources,"resolveActor"|"assertCurrent">;readAdmission?:"gateway"|"upstream";limits:Pick<ApiRequestLimits,"admit">;now?:()=>number};
export class RuntimeApiError extends RuntimeError{readonly retryAfterMs:number|null;constructor(code:string,status=403,certainty:"notApplied"|"applied"|"uncertain"="notApplied",retryAfterMs:number|null=null){super(code,status,certainty);this.retryAfterMs=retryAfterMs;}}
const publicReasons=new Set(["SOURCE_SCOPE_DENIED","RUNTIME_QUOTA_EXHAUSTED","RUNTIME_CAPACITY_EXHAUSTED","RUNTIME_CAPABILITY_UNVERIFIED","RUNTIME_BROWSER_UNVERIFIED","RUNTIME_BROWSER_NOT_REGISTERED","RUNTIME_SOURCE_STALE","RUNTIME_SOURCE_NOT_CONNECTED","RUNTIME_SOURCE_UNAVAILABLE","RUNTIME_SOURCE_RESPONSE_INVALID","SOURCE_RATE_LIMITED","SOURCE_READ_UNAVAILABLE","SOURCE_UI_DRIFT","SOURCE_LOGIN","SOURCE_MFA","SOURCE_CAPTCHA","SOURCE_TERMS_CHANGED","JOB_LEASE_FENCED","JOB_DISABLED_OR_STALE","RUNTIME_STEP_BUDGET","RUNTIME_SCHEDULE_DRAFT_CHANGED","RUNTIME_ENROLLMENT_UNVERIFIED","RUNTIME_ENROLLMENT_CHANGED","RUNTIME_WINDOW_SNAPSHOT_CONFLICT"]);
const publicReason=(reason:string)=>publicReasons.has(reason)?reason:"SOURCE_HELD";

/** Authenticated gateway only; no provider, queue, policy or financial authority is implemented here. */
export function createRuntimeApi(options:RuntimeApiOptions){
  if(options.secret.length<32)throw new Error("A private scoped runtime reference key is required.");
  const now=options.now??Date.now,scope=options.scope;
  const seal=(kind:"run"|"registration"|"item",value:string)=>`rt-${kind}-${sealOperationsToken(scope,options.secret,`job-runtime-${kind}`,value)}`;
  const unseal=(kind:"run"|"registration"|"item",value:string,requireOpaque=false)=>{if(!value.startsWith(`rt-${kind}-`)){if(requireOpaque)throw new RuntimeApiError("RUNTIME_REFERENCE_INVALID",403);return runtimeRef.parse(value);}try{const decoded=openOperationsToken(scope,options.secret,`job-runtime-${kind}`,value.slice(`rt-${kind}-`.length));return runtimeRef.parse(decoded);}catch{throw new RuntimeApiError("RUNTIME_REFERENCE_INVALID",403);}};
  const display=(kind:"owner"|"evidence"|"usage"|"trigger"|"trigger-version",value:string)=>`${kind}-${createHmac("sha256",options.secret).update(JSON.stringify([scope,kind,value])).digest("hex")}`;
  const admit=(principal:string,kind:"read"|"write",certainty:"notApplied"|"uncertain"="notApplied")=>{const result=options.limits.admit(principal,kind);if(!result.admitted)throw new RuntimeApiError("RATE_LIMITED",429,certainty,result.retryAfterMs);};
  const assertActor=(actor:TrustedHuman,principalRef:string)=>{if(!actor.active||actor.principalRef!==principalRef||digest(actor.scope)!==digest(scope)||Date.parse(actor.observedAt)>now()||Date.parse(actor.validUntil)<=now()||Date.parse(actor.validUntil)<=Date.parse(actor.observedAt)||!options.actorSources?.assertCurrent)throw new RuntimeApiError("AUTHORITY_REQUIRED");try{options.actorSources.assertCurrent({scope,actor,slack:null,linearRecords:[]},now());}catch{throw new RuntimeApiError("AUTHORITY_REQUIRED");}};
  const actor=async(principalRef:string)=>{runtimeRef.parse(principalRef);if(!options.actorSources?.resolveActor)throw new RuntimeApiError("NAMED_ACTOR_UNCONFIGURED");let raw:unknown;try{raw=await options.actorSources.resolveActor(principalRef,scope);}catch{throw new RuntimeApiError("AUTHORITY_REQUIRED");}const parsed=trustedHumanSchema.safeParse(raw);if(!parsed.success)throw new RuntimeApiError("AUTHORITY_REQUIRED");assertActor(parsed.data,principalRef);if(options.readAdmission!=="upstream")admit(principalRef,"read");return parsed.data;};
  function normalized(command:Command):Command{
    let input:unknown;
    switch(command.operation){
      case"install":case"fire":case"catchUp":input={...command.input,registrationRef:unseal("registration",command.input.registrationRef)};break;
      case"takeover":input={...command.input,runRef:unseal("run",command.input.runRef),itemRef:unseal("item",command.input.itemRef)};break;
      default:input={...command.input,runRef:unseal("run",command.input.runRef)};
    }
    return runtimeApiCommandSchema.parse({operation:command.operation,input});
  }
  function authenticateMachine(authorization:string|undefined):void{
    const binding=options.machine;
    if(!binding||binding.token.length<32)throw new RuntimeApiError("RUNTIME_MACHINE_NOT_CONFIGURED",503,"uncertain");
    const expected=Buffer.from(`Bearer ${binding.token}`),supplied=Buffer.from(authorization??"");
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new RuntimeApiError("RUNTIME_MACHINE_REQUIRED",401,"uncertain");
  }
  async function machine(command:Command,authorization:string|undefined):Promise<RuntimeMachine>{
    authenticateMachine(authorization);const binding=options.machine!;
    const inputHash=digest(command.input);let raw:unknown;
    try{raw=await binding.resolve(scope,command.operation,structuredClone(command.input));}catch{throw new RuntimeApiError("RUNTIME_MACHINE_DENIED",403,"uncertain");}
    const parsed=runtimeMachineProofSchema.safeParse(raw);if(!parsed.success)throw new RuntimeApiError("RUNTIME_MACHINE_PROOF_INVALID",403,"uncertain");const proof=parsed.data;
    const assertCurrent=()=>{const start=Date.parse(proof.observedAt),end=Date.parse(proof.validUntil);
      if(digest(proof.scope)!==digest(scope)||proof.workerRef!==binding.workerRef||proof.operation!==command.operation||proof.inputHash!==inputHash||start>now()||end<=now()||end<=start||end-start>300000)throw new RuntimeApiError("RUNTIME_MACHINE_PROOF_INVALID",403,"uncertain");
      try{binding.assertCurrent(structuredClone(proof),now());}catch{throw new RuntimeApiError("RUNTIME_MACHINE_DENIED",403,"uncertain");}
    };
    assertCurrent();admit(binding.workerRef,"write","uncertain");return{workerRef:binding.workerRef,assertCurrent};
  }
  function usage(value:RuntimeUsageRead){return runtimeUsageViewSchema.parse({invocations:value.invocations,pendingInvocations:value.pendingInvocations,measuredRuntimeMs:value.measuredRuntimeMs,ordinaryZapTasks:value.ordinaryZapTasks,mcpTasks:value.mcpTasks,modelTokens:value.modelTokens,observedCostMinor:value.observedCostMinor,currency:value.currency,costCoverage:value.costCoverage,runtimeCost:value.runtimeCost,receiptAliases:value.receiptRefs.map(r=>display("usage",r)),coverage:value.coverage});}
  function projectRun(value:RuntimeRunRead,measurements:RuntimeUsageRead):SafeRuntimeRun{const run=value.run;return safeRuntimeRunSchema.parse({kind:"registered-runtime-run",source:"native-runtime",environment:"sandbox",runRef:seal("run",run.runId),registrationRef:seal("registration",value.registrationRef),registrationVersion:value.registrationVersion,family:value.family,mode:run.definition.mode,state:run.state,control:run.control,intendedAt:value.window.intendedAt,windowStart:value.window.windowStart,windowEnd:value.window.windowEnd,observedAt:run.observedAt,delayMs:value.delayMs,sourceCoverage:value.sourceCoverage,sourceObservedAt:value.sourceObservedAt,sourceFresh:value.sourceFresh,sourceReceiptAlias:display("evidence",value.sourceReceiptRef),counts:run.counts,hasContinuation:value.continuation!==null,executionCertainty:value.dispatch?.executionCertainty??(run.counts.completed?"applied":"notApplied"),blockers:run.blockerCodes.map(publicReason),
    nextAction:value.takeovers.some(t=>!t.resolved)?"The named owner must resolve the source takeover before another attempt.":value.continuation?"Complete the current page, then continue this source window.":run.state==="completed"||run.state==="empty"?"Inspect the source receipt, coverage and measured usage.":"Use the registered machine worker after resolving current source holds.",
    items:run.items.map(i=>({itemRef:seal("item",i.itemId),state:i.state,attempts:i.attempts,steps:i.steps,dueAt:i.dueAt,checkpointVersion:i.checkpointVersion,hasCursor:i.checkpoint.cursor!==null,retainedEvidenceRefs:i.checkpoint.processedRefs.length,result:i.result?.schemaVersion==="job-dispatch-result.v1"?"nativeReceiptRecorded":i.result?.kind==="proposal-recorded"?"proposalRecorded":i.result?"observationRecorded":"none",reasonCode:i.reasonCode?publicReason(i.reasonCode):null})),takeovers:value.takeovers.map(t=>({itemRef:seal("item",t.itemRef),version:t.version,kind:t.kind,ownerAlias:display("owner",t.ownerRef),resolved:t.resolved})),usage:usage(measurements)});}
  function ack(operation:RuntimeApiOperation,runs:RuntimeRunRead[],extra:Partial<RuntimeApiAck>={}):RuntimeApiAck{const certainty=runs.some(r=>r.dispatch?.executionCertainty==="uncertain")?"uncertain":operation==="work"||operation==="reconcile"?(runs.some(r=>r.dispatch?.executionCertainty==="applied"||r.run.counts.completed>0)?"applied":"notApplied"):operation==="catchUp"&&runs.length===0?"notApplied":"applied";const states=runs.map(r=>r.run.state);const state:RuntimeApiAck["state"]=certainty==="uncertain"?"uncertain":states.every(s=>s==="completed"||s==="empty")&&runs.length?(runs.some(r=>r.sourceCoverage==="partial"||r.continuation!==null)?"partial":"completed"):states.some(s=>s==="held"||s==="failed"||s==="deferred")?"held":states.some(s=>s==="partial")?"partial":states.some(s=>s==="running")?"running":states.some(s=>s==="paused")?"paused":states.some(s=>s==="cancelled"||s==="cancelling")?"cancelled":"queued";return runtimeApiAckSchema.parse({kind:"runtime-command-ack",operation,state,executionCertainty:certainty,registrationRef:runs[0]?seal("registration",runs[0].registrationRef):null,runRefs:runs.map(r=>seal("run",r.run.runId)),returned:runs.length,nextCursor:null,hasMore:false,...extra});}
  async function execute(operation:unknown,input:unknown,authorization?:string):Promise<RuntimeApiAck>{const parsed=runtimeApiCommandSchema.safeParse({operation,input});if(!parsed.success)throw new RuntimeApiError("INVALID_INPUT",422);const command=normalized(parsed.data),proof=await machine(command,authorization);let result:RuntimeApiAck;
    switch(command.operation){case"install":{const installed=options.runtime.install(command.input.registrationRef,command.input.expectedVersion,proof);result=ack("install",[],{state:"registered",registrationRef:seal("registration",installed.registrationRef)});break;}
      case"fire":result=ack("fire",[await options.runtime.fire(command.input,proof)]);break;
      case"catchUp":{const response=await options.runtime.catchUp(command.input,proof);result=ack("catchUp",response.runs,{nextCursor:response.nextCursor,hasMore:response.hasMore});break;}
      case"work":result=ack("work",[await options.runtime.work(command.input,proof)]);break;
      case"continue":result=ack("continue",[await options.runtime.continueWindow(command.input,proof)]);break;
      case"reconcile":result=ack("reconcile",[await options.runtime.reconcile(command.input,proof)]);break;
      case"takeover":result=ack("takeover",[(await options.runtime.resolveTakeover(command.input,proof)).current]);break;
    }
    try{proof.assertCurrent();}catch(error){throw new RuntimeApiError(error instanceof RuntimeError?error.code:"RUNTIME_MACHINE_DENIED",403,result.executionCertainty);}return result;
  }
  type RegistrationRead=Awaited<ReturnType<JobRuntime["readRegistration"]>>;
  function cadenceOf(v:RegistrationRead){const r=v.registration;return r.cadence.kind==="event"?{kind:"event" as const}:r.cadence.kind==="hourly"?r.cadence:{kind:"calendar" as const,timezone:r.cadence.draft.timezone,localTime:r.cadence.draft.localTime,cadence:r.cadence.draft.cadence,startsAt:r.cadence.startsAt};}
  function scheduling(v:RegistrationRead){const c=v.cadenceStatus;return safeRuntimeSchedulingSchema.parse({observedAt:v.observedAt,validUntil:v.validUntil,
    trigger:{alias:display("trigger",v.trigger.triggerRef),versionAlias:display("trigger-version",v.trigger.triggerVersion)},cadence:cadenceOf(v),
    backlog:c.kind==="event"?{state:"notApplicable",reasonCode:"EVENT_DRIVEN_NO_DUE_SLOTS"}:{state:"observed",nextPlannedAt:c.nextPlannedAt,oldestUnadmittedAt:c.oldestUnadmittedAt,unadmittedInScannedRange:c.unadmittedInScannedRange,scannedSlots:c.scannedSlots,scanComplete:c.scanComplete,scanCursor:c.scanCursor,...v.cadenceScan,total:null}});}
  async function readRun(runRef:string,principalRef:string){
    const who=await actor(principalRef),ref=unseal("run",publicRef.parse(runRef),true),snapshot=await options.runtime.readRunWithFence(ref);
    const registration=await options.runtime.readRegistrationWithFence(snapshot.value.registrationRef);
    if(registration.value.registration.version!==snapshot.value.registrationVersion)throw new RuntimeApiError("RUNTIME_REGISTRATION_STALE",409);
    const result=safeRuntimeRunSchema.parse({...projectRun(snapshot.value,options.runtime.measurements.read(ref)),scheduling:scheduling(registration.value)});
    // Both observations were issued before the last await. Neither an actor check nor
    // the later registration proof is a substitute for the retained run source fence.
    assertActor(who,principalRef);snapshot.assertCurrent();registration.assertCurrent();assertActor(who,principalRef);return result;
  }
  async function readRegistration(registrationRef:string,principalRef:string){const who=await actor(principalRef),ref=unseal("registration",publicRef.parse(registrationRef),true);const snapshot=await options.runtime.readRegistrationWithFence(ref),v=snapshot.value,r=v.registration;
    const result=safeRuntimeRegistrationSchema.parse({kind:"registered-runtime",source:"native-runtime",environment:"sandbox",registrationRef:seal("registration",r.registrationRef),version:r.version,family:r.family,mode:r.definition.mode,ownerAlias:display("owner",r.ownerRef),cadence:cadenceOf(v),observedAt:v.observedAt,validUntil:v.validUntil,cadenceStatus:v.cadenceStatus,windows:v.windows.map(w=>({runRef:w.runRef?seal("run",w.runRef):null,intendedAt:w.window.intendedAt})),coverage:v.coverage});assertActor(who,principalRef);snapshot.assertCurrent();assertActor(who,principalRef);return result;}
  return{authenticateMachine,execute,readRun,readRegistration,registrationRef:(ref:string)=>seal("registration",runtimeRef.parse(ref)),runRef:(ref:string)=>seal("run",runtimeRef.parse(ref))};
}
