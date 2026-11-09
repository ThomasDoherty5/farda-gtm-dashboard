// @vitest-environment node
import { expect, it } from "vitest";
import { digest } from "./config.ts";
import { bulkFixture } from "./bulk/fixtures.testkit.ts";
import { CapabilityLedger } from "./connections/ledger.ts";
import { JobRuntime } from "./jobs/runtime.ts";
import { RuntimeError, type RuntimeAuthority, type RuntimeWindowPlan } from "./jobs/runtimeSchema.ts";
import { assertBulkRuntimeRegistration, createBulkRuntimeRegistration, findBulkGroupManifest } from "./bulkRuntime.ts";

it("J13 executes exact canonical approvals through the registered durable runtime; retries and restart keep original per-row actions",async()=>{
  const w=bulkFixture();try{
    const approved=await w.approve(0),intents=w.intentsFor(approved.manifest);
    const registration=createBulkRuntimeRegistration({registrationRef:w.packet.registration.registrationRef,ownerRef:"fictional-j13-owner",sourceRef:w.packet.sourceRef,policyVersion:w.a.policy.version,budgets:w.handlers.values().next().value!.budgets});
    const registry={registrations:new Map([[registration.registrationRef,registration]]),executors:new Map()};
    let current=true;const fence=()=>{if(!current)throw new RuntimeError("FICTIONAL_RUNTIME_REVOKED",403);};
    const lease=()=>({scope:w.scope,observedAt:w.a.at(),validUntil:w.a.until()});
    const authority:RuntimeAuthority={
      resolveActivation:async()=>({...lease(),receiptRef:"fictional-j13-activation",registrationRef:registration.registrationRef,registrationHash:digest(registration),sourceVersion:"v1",triggerRef:"fictional-one-off-exact-event",triggerVersion:"v1",toolApprovalRef:"fictional-machine-approval",migration:{state:"notApplicable",policyVersion:w.a.policy.version}}),assertActivation:fence,
      prepareWindow:async({window}):Promise<RuntimeWindowPlan>=>({...lease(),receiptRef:"fictional-j13-approved-window",sourceVersion:"v1",registrationHash:digest(registration),window,kind:"approved",intents}),assertWindow:fence,
      resolvePreflight:async()=>{throw new Error("Approved J13 reuses canonical dispatch preflight.");},assertCurrent:fence,
      resolveTakeover:async()=>{throw new Error("No source-read takeover in this fixture.");},assertTakeover:fence,
    };
    const options={scope:w.scope,jobs:w.jobs,ledger:new CapabilityLedger(w.a.db,w.scope,{now:()=>w.a.state.now}),dispatch:w.dispatch,registry,authority,now:()=>w.a.state.now};
    let runtime=new JobRuntime(w.a.db,options);const machine={workerRef:"fictional-j13-worker",assertCurrent:fence};
    expect(w.a.db.prepare("SELECT count(*) n FROM job_runtime_registrations").get()?.n).toBe(0);
    assertBulkRuntimeRegistration(w.a.db,registry,w.packet.registration);
    runtime.install(registration.registrationRef,0,machine);
    const input={registrationRef:registration.registrationRef,registrationVersion:1,intendedAt:w.a.at(),triggerEventRef:"fictional-exact-bulk-event"};
    const first=await runtime.fire(input,machine),same=await runtime.fire(input,machine);
    expect(same.run.runId).toBe(first.run.runId);
    // Approved runtime windows retain the immutable dispatch job identity;
    // the installed registration and durable window carry J13 ownership.
    const registered=await runtime.readRegistration(registration.registrationRef);
    expect(registered.registration.definition).toMatchObject({jobId:"J13",version:1,mode:"executeApproved"});
    expect(first).toMatchObject({registrationRef:registration.registrationRef,registrationVersion:1,window:{registrationRef:registration.registrationRef,registrationVersion:1}});
    expect(registered.windows).toContainEqual({runRef:first.run.runId,window:first.window});
    expect(first.run.definition.jobId).toMatch(/^approved:[a-f0-9]{64}$/);expect(runtime.ownsRun(first.run.runId)).toBe(true);
    expect(w.jobs.processOne("fictional-legacy-worker")).toBeNull();
    await runtime.work({runRef:first.run.runId,maxItems:3},machine);
    runtime=new JobRuntime(w.a.db,options);await runtime.work({runRef:first.run.runId,maxItems:100},machine);
    const final=w.dispatch.read(first.run.runId,false);expect(final.items).toHaveLength(24);expect(final.items.every(i=>i.receipt?.sourceEffect==="localArtifact")).toBe(true);
    expect(new Set(w.state.calls.map(c=>c.dispatchKey)).size).toBe(24);expect(w.state.calls).toHaveLength(24);
    await runtime.work({runRef:first.run.runId,maxItems:100},machine);expect(w.state.calls).toHaveLength(24);
    expect(findBulkGroupManifest(w.a.db,w.scope,w.packet.sourceRef,w.seal(),"bulk.invitation",approved.manifest.draft.payloadRef)?.manifestHash).toBe(approved.manifest.manifestHash);
    expect(findBulkGroupManifest(w.a.db,{...w.scope,accountId:"another-account"},w.packet.sourceRef,w.seal(),"bulk.invitation",approved.manifest.draft.payloadRef)).toBeNull();
    current=false;await expect(runtime.work({runRef:first.run.runId,maxItems:100},machine)).rejects.toMatchObject({status:403});expect(w.state.calls).toHaveLength(24);
    registry.registrations.set(registration.registrationRef,{...registration,ownerRef:"changed-owner"});expect(()=>assertBulkRuntimeRegistration(w.a.db,registry,w.packet.registration)).toThrow("BULK_RUNTIME_VERSION_REUSED");
  }finally{w.a.db.close();}
});
