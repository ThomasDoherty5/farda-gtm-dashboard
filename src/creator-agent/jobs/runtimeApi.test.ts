// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {createRequire} from "node:module";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {DatabaseSync as DB} from "node:sqlite";
import {digest} from "../config.ts";
import {AgentStore} from "../store.ts";
import {ApiRequestLimits} from "../apiRequestLimits.ts";
import type {ApprovalSources,TrustedHuman} from "../approvals/contract.ts";
import {createRuntimeApi,type RuntimeMachineBinding} from "./runtimeApi.ts";
import {createRuntimeTestkit,syntheticRuntimeRegistration,runtimeSyntheticScope} from "./runtime.testkit.ts";
import {RuntimeError} from "./runtimeSchema.ts";
import {safeRuntimeRunSchema} from "./runtimeViews.ts";
const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const token="synthetic-runtime-machine-token-only-fixture",secret="synthetic-runtime-reference-secret-only-fixture",principal="synthetic-named-viewer";

describe("registered runtime gateway authenticates exact commands and projects safe source-owned reads",()=>{
  let dir:string,db:DB,f:ReturnType<typeof createRuntimeTestkit>,api:ReturnType<typeof createRuntimeApi>,binding:RuntimeMachineBinding,sources:ApprovalSources;
  let actorActive:boolean,machineActive:boolean;
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),"farda-runtime-api-"));const path=join(dir,"agent.sqlite");new AgentStore(path,runtimeSyntheticScope).close();db=new DatabaseSync(path);f=createRuntimeTestkit(db);await f.initialize();actorActive=true;machineActive=true;
    binding={token,workerRef:"synthetic-runtime-api-worker",resolve:async(scope,operation,input)=>({scope,workerRef:binding.workerRef,operation,inputHash:digest(input),proofRef:"synthetic-machine-proof",observedAt:new Date(f.now()).toISOString(),validUntil:new Date(f.now()+60000).toISOString()}),assertCurrent:()=>{if(!machineActive)throw new Error("Synthetic machine withdrawn");}};
    sources={resolveActor:async(requested,scope):Promise<TrustedHuman>=>({scope,principalRef:requested,personRef:"synthetic-viewer-person",roles:["viewer"],active:actorActive,directoryVersion:"synthetic-directory-v1",observedAt:new Date(f.now()).toISOString(),validUntil:new Date(f.now()+60000).toISOString()}),assertCurrent:snapshot=>{if(!actorActive||!snapshot.actor.active)throw new Error("Synthetic actor withdrawn");}};
    api=createRuntimeApi({runtime:f.runtime,scope:runtimeSyntheticScope,secret,machine:binding,actorSources:sources,limits:new ApiRequestLimits(db,runtimeSyntheticScope,f.now),now:f.now});
  });
  afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const fireInput=()=>({registrationRef:"synthetic-j19",registrationVersion:1,intendedAt:"2026-11-07T10:00:00Z",triggerEventRef:"synthetic-api-event"});
  it("runs exact machine fire/work and returns only aliased native scope with measured unknown-cost usage",async()=>{
    const admitted=await api.execute("fire",{...fireInput(),registrationRef:api.registrationRef("synthetic-j19")},`Bearer ${token}`);
    expect(admitted).toMatchObject({state:"queued",executionCertainty:"applied",returned:1});const runRef=admitted.runRefs[0]!;
    const done=await api.execute("work",{runRef,maxItems:1},`Bearer ${token}`);expect(done.state).toBe("completed");expect(f.state.sourceCalls).toBe(1);
    const view=await api.readRun(runRef,principal);expect(view).toMatchObject({kind:"registered-runtime-run",state:"completed",counts:{completed:1},usage:{invocations:{directApi:1},mcpTasks:null,ordinaryZapTasks:null,observedCostMinor:null,runtimeCost:"unknown"}});
    const serialized=JSON.stringify(view);for(const privateValue of [f.registration.registrationRef,f.registration.sourceRef,f.registration.ownerRef,f.registration.apiBinding!.providerAccountId,"synthetic-subject-first-0","receipt:synthetic","route:synthetic",token,secret])expect(serialized).not.toContain(privateValue);
    const registration=await api.readRegistration(api.registrationRef("synthetic-j19"),principal);expect(registration).toMatchObject({kind:"registered-runtime",cadence:{kind:"calendar",localTime:"10:00"},coverage:{returned:1,total:null}});
  });
  it("authenticates before input exists and never reports a prior unknown request safe to resend",async()=>{
    for(const authorization of [undefined,"Bearer wrong",`Bearer ${"é".repeat(token.length)}`])expect(()=>api.authenticateMachine(authorization)).toThrowError(expect.objectContaining({code:"RUNTIME_MACHINE_REQUIRED",status:401,executionCertainty:"uncertain"}));
    const unavailable=createRuntimeApi({runtime:f.runtime,scope:runtimeSyntheticScope,secret,limits:new ApiRequestLimits(db,runtimeSyntheticScope,f.now),now:f.now});expect(()=>unavailable.authenticateMachine(`Bearer ${token}`)).toThrowError(expect.objectContaining({code:"RUNTIME_MACHINE_NOT_CONFIGURED",executionCertainty:"uncertain"}));
    binding.resolve=async()=>{throw new Error("Synthetic resolver down");};await expect(api.execute("fire",fireInput(),`Bearer ${token}`)).rejects.toMatchObject({code:"RUNTIME_MACHINE_DENIED",executionCertainty:"uncertain"});expect(db.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(0);
  });
  it.each(["scope","worker","operation","hash","expired","future","longLease"])("rejects %s machine proof before an actual window is admitted",async mismatch=>{
    const resolve=binding.resolve;binding.resolve=async(...args)=>{const proof=await resolve(...args) as Record<string,unknown>;return{...proof,...(mismatch==="scope"?{scope:{...runtimeSyntheticScope,accountId:"synthetic-other-account"}}:mismatch==="worker"?{workerRef:"synthetic-other-worker"}:mismatch==="operation"?{operation:"work"}:mismatch==="hash"?{inputHash:"0".repeat(64)}:mismatch==="expired"?{validUntil:new Date(f.now()).toISOString()}:mismatch==="future"?{observedAt:new Date(f.now()+1).toISOString()}:{validUntil:new Date(f.now()+300001).toISOString()})};};
    await expect(api.execute("fire",fireInput(),`Bearer ${token}`)).rejects.toMatchObject({code:"RUNTIME_MACHINE_PROOF_INVALID",executionCertainty:"uncertain"});expect(db.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(0);
  });
  it("strictly rejects caller endpoints, definitions and changed input before proof resolution",async()=>{
    let resolutions=0;const resolve=binding.resolve;binding.resolve=async(...args)=>{resolutions++;return resolve(...args);};
    await expect(api.execute("fire",{...fireInput(),endpoint:"https://synthetic.invalid",definition:{}},`Bearer ${token}`)).rejects.toMatchObject({code:"INVALID_INPUT",status:422});expect(resolutions).toBe(0);
  });
  it("requires current named actor and exact read scope, with no raw-ID browser fallback",async()=>{
    const run=await f.fire();await expect(api.readRun(run.run.runId,principal)).rejects.toMatchObject({code:"RUNTIME_REFERENCE_INVALID"});
    const other=createRuntimeApi({runtime:f.runtime,scope:{...runtimeSyntheticScope,accountId:"synthetic-other-account"},secret,actorSources:sources,limits:new ApiRequestLimits(db,runtimeSyntheticScope,f.now),now:f.now});await expect(other.readRun(api.runRef(run.run.runId),principal)).rejects.toMatchObject({code:"RUNTIME_REFERENCE_INVALID"});
    const resolve=sources.resolveActor!;sources.resolveActor=async(...args)=>({...await resolve(...args) as TrustedHuman,scope:{...runtimeSyntheticScope,accountId:"synthetic-other-account"}});await expect(api.readRun(api.runRef(run.run.runId),principal)).rejects.toMatchObject({code:"AUTHORITY_REQUIRED",status:403});
  });
  it("a named actor withdrawn during the final source await receives no protected projection",async()=>{
    const run=await f.fire(),resolve=f.authority.resolveActivation;f.authority.resolveActivation=async r=>{const proof=await resolve(r);actorActive=false;return proof;};
    await expect(api.readRun(api.runRef(run.run.runId),principal)).rejects.toMatchObject({code:"AUTHORITY_REQUIRED",status:403});
  });
  it("the final actor fence cannot hide withdrawal of the retained source activation",async()=>{
    const run=await f.fire();let assertions=0;const assert=sources.assertCurrent!;sources.assertCurrent=(snapshot,now)=>{assert(snapshot,now);if(++assertions===2)f.state.denied=true;};
    await expect(api.readRun(api.runRef(run.run.runId),principal)).rejects.toMatchObject({code:"SOURCE_SCOPE_DENIED",status:403});
  });
  it("final machine withdrawal after a recorded observation preserves applied history without another read",async()=>{
    const run=await f.fire(),read=f.runtime.readRunWithFence.bind(f.runtime);f.runtime.readRunWithFence=async ref=>{const result=await read(ref);if(result.value.run.counts.completed)machineActive=false;return result;};
    await expect(api.execute("work",{runRef:api.runRef(run.run.runId)},`Bearer ${token}`)).rejects.toMatchObject({status:403,executionCertainty:"applied"});expect(f.state.sourceCalls).toBe(1);expect(f.jobs.getRun(run.run.runId).counts.completed).toBe(1);
  });
  it("bounded transport rate exhaustion is not source quota and retains uncertain original-command semantics",async()=>{
    for(let i=0;i<30;i++)await api.execute("fire",fireInput(),`Bearer ${token}`);
    await expect(api.execute("fire",fireInput(),`Bearer ${token}`)).rejects.toMatchObject({code:"RATE_LIMITED",status:429,executionCertainty:"uncertain",retryAfterMs:60000});expect(db.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(1);expect(f.state.sourceCalls).toBe(0);
  });
  it("a paused work request with no saved observation is not acknowledged as an applied effect",async()=>{
    const run=await f.fire();f.jobs.controlRun(run.run.runId,"pause");
    expect(await api.execute("work",{runRef:api.runRef(run.run.runId)},`Bearer ${token}`)).toMatchObject({state:"paused",executionCertainty:"notApplied"});expect(f.state.sourceCalls).toBe(0);
  });
  it("a compiled upstream read admission avoids a second charge while the standalone default enforces its own limit",async()=>{
    const run=await f.fire(),ref=api.runRef(run.run.runId);const upstream=createRuntimeApi({runtime:f.runtime,scope:runtimeSyntheticScope,secret,actorSources:sources,readAdmission:"upstream",limits:new ApiRequestLimits(db,runtimeSyntheticScope,f.now),now:f.now});
    await upstream.readRun(ref,principal);expect(db.prepare("SELECT COUNT(*) AS n FROM api_principal_events WHERE principal=? AND kind='read'").get(principal)?.n).toBe(0);
    await api.readRun(ref,principal);expect(db.prepare("SELECT COUNT(*) AS n FROM api_principal_events WHERE principal=? AND kind='read'").get(principal)?.n).toBe(1);
    const limits=new ApiRequestLimits(db,runtimeSyntheticScope,f.now);for(let i=1;i<120;i++)expect(limits.admit(principal,"read").admitted).toBe(true);
    await expect(api.readRun(ref,principal)).rejects.toMatchObject({code:"RATE_LIMITED",status:429});
  });
  it("adds current daily trigger/cadence and finite backlog evidence without raw source locators",async()=>{
    const run=await f.fire(),view=await api.readRun(api.runRef(run.run.runId),principal);
    expect(view.scheduling).toMatchObject({trigger:{alias:expect.stringMatching(/^trigger-[a-f0-9]{64}$/),versionAlias:expect.stringMatching(/^trigger-version-[a-f0-9]{64}$/)},
      cadence:{kind:"calendar",cadence:"daily",timezone:"UTC",localTime:"10:00",startsAt:"2026-11-06T10:00:00Z"},
      backlog:{state:"observed",nextPlannedAt:"2026-11-08T10:00:00.000Z",oldestUnadmittedAt:"2026-11-06T10:00:00.000Z",unadmittedInScannedRange:1,scannedSlots:2,scanComplete:true,scanCursor:null,total:null,scannedFrom:"2026-11-06T10:00:00Z",requestedThrough:"2026-11-07T12:00:00.000Z",scannedThrough:"2026-11-07T10:00:00.000Z"}});
    expect(JSON.stringify(view.scheduling)).not.toContain("synthetic-trigger");
    const legacy={...view};delete legacy.scheduling;expect(safeRuntimeRunSchema.parse(legacy).scheduling).toBeUndefined();
  });
  it("event-driven scheduling is explicitly inapplicable to clock-based backlog",async()=>{
    const r=syntheticRuntimeRegistration();r.registrationRef="synthetic-event-runtime";r.definition.jobId=r.registrationRef;r.family="registered-business";r.cadence={kind:"event",eventType:"synthetic-event"};
    const event=createRuntimeTestkit(db,{registration:r});await event.initialize();const run=await event.fire();
    const eventApi=createRuntimeApi({runtime:event.runtime,scope:runtimeSyntheticScope,secret,actorSources:sources,limits:new ApiRequestLimits(db,runtimeSyntheticScope,event.now),now:event.now});
    const data=await eventApi.readRun(eventApi.runRef(run.run.runId),principal);expect(data.scheduling).toMatchObject({cadence:{kind:"event"},backlog:{state:"notApplicable",reasonCode:"EVENT_DRIVEN_NO_DUE_SLOTS"}});
    expect(data.scheduling?.cadence).not.toHaveProperty("startsAt");expect(data.scheduling?.backlog).not.toHaveProperty("nextPlannedAt");expect(data.scheduling?.backlog).not.toHaveProperty("scannedSlots");
  });
  it("hourly backlog discloses the bounded inspected range and next uninspected slot, never a total",async()=>{
    const r=syntheticRuntimeRegistration();r.registrationRef="synthetic-hourly-runtime";r.definition.jobId=r.registrationRef;r.family="J08";r.membership="enrolled-only";r.cadence={kind:"hourly",timezone:"UTC",minute:0,startsAt:"2026-11-05T00:00:00Z"};
    const hourly=createRuntimeTestkit(db,{registration:r});await hourly.initialize();const run=await hourly.fire();
    const hourlyApi=createRuntimeApi({runtime:hourly.runtime,scope:runtimeSyntheticScope,secret,actorSources:sources,limits:new ApiRequestLimits(db,runtimeSyntheticScope,hourly.now),now:hourly.now});
    const data=await hourlyApi.readRun(hourlyApi.runRef(run.run.runId),principal);expect(data.scheduling).toMatchObject({cadence:{kind:"hourly",timezone:"UTC",minute:0},backlog:{state:"observed",scannedSlots:24,unadmittedInScannedRange:24,scanComplete:false,scanCursor:"2026-11-06T00:00:00.000Z",scannedThrough:"2026-11-05T23:00:00.000Z",requestedThrough:"2026-11-07T12:00:00.000Z",total:null}});
  });
  it("retains both source fences when the first run observation is withdrawn during the registration await",async()=>{
    const run=await f.fire(),resolve=f.authority.resolveActivation,assert=f.authority.assertActivation;let firstRef:string|null=null,revoked:string|null=null,reads=0;
    f.authority.resolveActivation=async r=>{f.advance(1);const proof=await resolve(r);if(++reads===1)firstRef=(proof as {receiptRef:string}).receiptRef;else revoked=firstRef;return proof;};
    f.authority.assertActivation=(proof,...args)=>{assert(proof,...args);if(proof.receiptRef===revoked)throw new RuntimeError("SOURCE_SCOPE_DENIED",403);};
    await expect(api.readRun(api.runRef(run.run.runId),principal)).rejects.toMatchObject({code:"SOURCE_SCOPE_DENIED",status:403});expect(reads).toBe(2);
  });
  it("rechecks the named actor after the final registration lookup",async()=>{
    const run=await f.fire(),resolve=f.authority.resolveActivation;let reads=0;f.authority.resolveActivation=async r=>{const proof=await resolve(r);if(++reads===2)actorActive=false;return proof;};
    await expect(api.readRun(api.runRef(run.run.runId),principal)).rejects.toMatchObject({code:"AUTHORITY_REQUIRED",status:403});expect(reads).toBe(2);
  });
  it("partial source coverage is not promoted to a complete-window acknowledgment",async()=>{
    f.state.partial=true;const run=await api.execute("fire",fireInput(),`Bearer ${token}`);expect((await api.execute("work",{runRef:run.runRefs[0]!},`Bearer ${token}`)).state).toBe("partial");
  });
});
