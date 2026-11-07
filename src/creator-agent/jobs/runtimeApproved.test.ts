// @vitest-environment node
import {expect,it} from "vitest";
import {approvalFixture,approvalTestScope as scope} from "../approvals/fixtures.testkit.ts";
import {CapabilityLedger} from "../connections/ledger.ts";
import {digest} from "../config.ts";
import {JobRepository} from "./repository.ts";
import {DispatchGuard} from "./dispatchGuard.ts";
import type {DispatchHandler,DispatchIntent,DispatchReadback} from "./dispatchSchema.ts";
import {JobRuntime} from "./runtime.ts";
import {createRuntimeApi} from "./runtimeApi.ts";
import {ApiRequestLimits} from "../apiRequestLimits.ts";
import {RuntimeError,type RuntimeAuthority,type RuntimeWindowPlan} from "./runtimeSchema.ts";
import {syntheticRuntimeRegistration} from "./runtime.testkit.ts";

it.each(["none","activation","window","catchup"] as const)("event cadence uses real J04/dispatch with %s runtime authority withdrawal and original outcome recovery",async revoke=>{
  const a=approvalFixture();try{
    a.draft.actionKind="synthetic-runtime-artifact";a.command.actionKind=a.draft.actionKind;a.draft.phase="other";a.draft.acquisitionTerms=null;a.draft.effects={spendsMoney:false,sendsCreator:false,changesPolicy:false};
    const approved=await a.approved(),item=approved.manifest.items[0]!,d=approved.manifest.draft;
    const intent:DispatchIntent={handlerRef:"synthetic-runtime-artifact.v1",payloadRef:d.payloadRef,approval:{scope,approvalRef:approved.manifest.approvalRef,manifestVersion:approved.manifest.manifestVersion,manifestHash:approved.manifest.manifestHash,itemRef:item.itemRef,itemVersion:item.itemVersion,itemHash:item.itemHash,actionKind:d.actionKind,providerAccountRef:d.providerAccountRef,payloadHash:item.payloadHash,policyVersion:d.policyVersion,termsVersion:d.termsVersion,rightsVersion:d.rightsVersion,phase:d.phase}};
    const r=syntheticRuntimeRegistration();r.family="registered-business";r.registrationRef="synthetic-approved-runtime";r.membership="approved-manifest";r.cadence={kind:"event",eventType:"synthetic-approved-event"};r.definition={...r.definition,jobId:r.registrationRef,mode:"executeApproved",handler:"dispatch-approved.v1",outputSchemaVersion:"job-dispatch-result.v1"};r.apiBinding=null;r.browserBinding=null;r.browserExecutorRef=null;if(revoke==="catchup")r.cadence={kind:"hourly",timezone:"UTC",minute:0,startsAt:a.at()};
    a.db.exec("CREATE TABLE synthetic_native_artifacts(dispatch_key TEXT PRIMARY KEY,receipt TEXT NOT NULL)");let calls=0;
    const na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Synthetic local artifact has no provider, budget or stock consumption."};
    const handler:DispatchHandler={idempotency:"source-enforced",policyVersion:a.policy.version,provider:na,sourceEffect:"localArtifact",resources:()=>({budget:na,stock:na,quota:na}),budgets:r.definition.budgets,
      execute:async c=>{c.assertCurrent();calls++;const receipt:Extract<DispatchReadback,{state:"applied"}>={state:"applied",receipt:{receiptRef:"synthetic-native-artifact-receipt",dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,sourceEffect:"localArtifact",observedAt:a.at()}};a.db.prepare("INSERT OR IGNORE INTO synthetic_native_artifacts VALUES(?,?)").run(c.dispatchKey,JSON.stringify(receipt));return{state:"unknown",reasonCode:"SYNTHETIC_LOST_ACK"};},
      reconcile:async c=>{const row=a.db.prepare("SELECT receipt FROM synthetic_native_artifacts WHERE dispatch_key=?").get(c.dispatchKey);return row?JSON.parse(String(row.receipt)) as DispatchReadback:{state:"unknown",reasonCode:"SYNTHETIC_LOOKUP_UNKNOWN"};}};
    const jobs=new JobRepository(a.db,{scope,now:()=>a.state.now}),ledger=new CapabilityLedger(a.db,scope,{now:()=>a.state.now});const dispatch=new DispatchGuard({db:a.db,jobs,scope,approvals:a.repo,handlers:new Map([[intent.handlerRef,handler]]),now:()=>a.state.now});
    const sourceLease={scope,observedAt:a.at(),validUntil:a.until()};let current=true,windowCurrent=true;
    const fence=()=>{if(!current)throw new RuntimeError("SOURCE_SCOPE_DENIED",403);};
    const authority:RuntimeAuthority={resolveActivation:async()=>({...sourceLease,receiptRef:"receipt:synthetic-activation",registrationRef:r.registrationRef,registrationHash:digest(r),sourceVersion:"synthetic-runtime-source-v1",triggerRef:"synthetic-trigger",triggerVersion:"v1",toolApprovalRef:"synthetic-tool-approval",migration:{state:"notApplicable",policyVersion:a.policy.version}}),assertActivation:fence,
      prepareWindow:async({window}):Promise<RuntimeWindowPlan>=>({...sourceLease,receiptRef:"receipt:synthetic-approved-window",sourceVersion:"v1",registrationHash:digest(r),window,kind:"approved",intents:[intent]}),assertWindow:()=>{if(!windowCurrent)throw new RuntimeError("SOURCE_SCOPE_DENIED",403);},
      resolvePreflight:async()=>{throw new RuntimeError("SYNTHETIC_NO_READ_EXECUTOR");},assertCurrent:()=>{throw new RuntimeError("SYNTHETIC_NO_READ_EXECUTOR");},resolveTakeover:async()=>{throw new RuntimeError("SYNTHETIC_NO_TAKEOVER");},assertTakeover:()=>{throw new RuntimeError("SYNTHETIC_NO_TAKEOVER");}};
    const options={scope,jobs,ledger,dispatch,authority,registry:{registrations:new Map([[r.registrationRef,r]]),executors:new Map()},now:()=>a.state.now};const runtime=new JobRuntime(a.db,options),machine={workerRef:"worker:synthetic-approved",assertCurrent:()=>{}};runtime.install(r.registrationRef,0,machine);
    const run=await runtime.fire({registrationRef:r.registrationRef,registrationVersion:1,intendedAt:a.at(),triggerEventRef:"synthetic-approved-trigger"},machine);expect(run.run.definition.handler).toBe("dispatch-approved.v1");expect(a.db.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(1);expect(jobs.processOne("worker:legacy")).toBeNull();
    if(revoke==="activation"||revoke==="window"){const resolve=a.repo.resolveCurrentProof.bind(a.repo);a.repo.resolveCurrentProof=async binding=>{const proof=await resolve(binding);if(revoke==="activation")current=false;else windowCurrent=false;return proof;};await expect(runtime.work({runRef:run.run.runId},machine)).rejects.toMatchObject({status:403,executionCertainty:"notApplied"});expect(calls).toBe(0);expect(a.db.prepare("SELECT COUNT(*) AS n FROM synthetic_native_artifacts").get()?.n).toBe(0);return;}
    const uncertain=await runtime.work({runRef:run.run.runId},machine);expect(uncertain.dispatch?.executionCertainty).toBe("uncertain");expect(calls).toBe(1);
    if(revoke==="catchup"){
      const token="synthetic-runtime-api-machine-not-for-deployment",api=createRuntimeApi({runtime,scope,secret:"synthetic-runtime-api-secret-not-for-deployment",now:()=>a.state.now,limits:new ApiRequestLimits(a.db,scope,()=>a.state.now),machine:{token,workerRef:machine.workerRef,resolve:async(scope,operation,input)=>({scope,workerRef:machine.workerRef,operation,inputHash:digest(input),proofRef:"synthetic-exact-proof",observedAt:a.at(),validUntil:a.until()}),assertCurrent:()=>{}}});
      const replay=await api.execute("catchUp",{registrationRef:r.registrationRef,registrationVersion:1,through:a.at(),limit:1},`Bearer ${token}`);
      expect(replay).toMatchObject({state:"uncertain",executionCertainty:"uncertain",returned:1});expect(calls).toBe(1);expect(a.db.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(1);
    }
    const restarted=new JobRuntime(a.db,options),done=await restarted.reconcile({runRef:run.run.runId},machine);expect(done.dispatch?.executionCertainty).toBe("applied");expect(calls).toBe(1);expect(a.db.prepare("SELECT COUNT(*) AS n FROM synthetic_native_artifacts").get()?.n).toBe(1);
    current=false;await expect(restarted.work({runRef:run.run.runId},machine)).rejects.toMatchObject({status:403});expect(calls).toBe(1);
  }finally{a.db.close();}
});
