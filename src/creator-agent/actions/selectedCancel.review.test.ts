// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture, approvalTestScope as scope } from "../approvals/fixtures.testkit.ts";
import { JobRepository } from "../jobs/repository.ts";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";
import { createActionService } from "./service.ts";
import { actionTestSecret } from "./fixtures.testkit.ts";
import { SCHEMA_VERSION } from "../../adapter/contract.ts";

const databases: ReturnType<typeof approvalFixture>["db"][] = [];
const principal={principalRef:"synthetic:requester"};
async function fixture(){
  const a=approvalFixture();databases.push(a.db);
  a.draft.actionKind="review-local-task";a.command.actionKind=a.draft.actionKind;a.draft.phase="other";a.draft.acquisitionTerms=null;a.draft.effects.sendsCreator=false;
  a.draft.items=Array.from({length:2},(_,i)=>({...a.draft.items[0]!,itemRef:"review-item-"+i,targetRef:"review-target-"+i}));
  a.draft.bounds.maxItems=2;a.command.selectionRefs=a.draft.items.map(i=>i.itemRef);
  const calls:string[]=[];
  const na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Fictional local artifact without inventory, money or provider writes."};
  const handler:DispatchHandler={idempotency:"source-enforced",sourceEffect:"localArtifact",policyVersion:a.policy.version,provider:na,resources:()=>({budget:na,stock:na,quota:na}),
    budgets:{maxItems:2,maxSteps:50,maxAttempts:2,maxRunMs:10000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0},
    execute:async c=>{calls.push(c.intent.approval.itemRef);return{state:"applied",receipt:{receiptRef:"review-artifact-"+c.intent.approval.itemRef,dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,sourceEffect:"localArtifact",observedAt:a.at()}};},
    reconcile:async()=>({state:"unknown",reasonCode:"SOURCE_READBACK_UNKNOWN"})};
  const jobs=new JobRepository(a.db,{scope,now:()=>a.state.now});
  const dispatch=new DispatchGuard({db:a.db,jobs,scope,approvals:a.repo,handlers:new Map([["review-handler.v1",handler]]),now:()=>a.state.now});
  const service=createActionService({scope,secret:actionTestSecret,approvals:a.repo,dispatch,registry:new Map([[a.draft.actionKind,{handlerRef:"review-handler.v1"}]]),authorize:a.sources.resolveActor,assertAuthority:a.sources.assertCurrent,now:()=>a.state.now});
  const approved=await a.approved();
  const base={schemaVersion:SCHEMA_VERSION,requestId:"review-selected",requestedScope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox" as const},entityRefs:[],approvalRef:approved.manifest.approvalRef,manifestRef:service.manifestRef(approved),runRef:null};
  const queued=await service.execute({...base,operation:"dispatchApprovedAction",actionKind:"dispatchApprovedAction",expectedVersion:service.approvalVersion(approved),idempotencyKey:"review-handoff",payload:{}},principal);
  const cancel=(refs:string[],key="review-cancel")=>({...base,runRef:queued.runRef,operation:"controlRun",actionKind:"cancelUnsent",expectedVersion:service.runVersion(dispatch.read(queued.runRef!)),idempotencyKey:key,payload:{control:"cancel",itemRefs:refs}});
  return{...a,jobs,dispatch,service,handler,calls,runRef:queued.runRef!,cancel};
}
afterEach(()=>{for(const db of databases.splice(0))db.close();});

describe("independent finite selected-cancel boundaries",()=>{
  it("cancels the exact row while its worker awaits authority, then executes only the other original row",async()=>{
    const w=await fixture();let release!:()=>void,entered!:(ref:string)=>void;
    const paused=new Promise<void>(done=>{release=done;}),started=new Promise<string>(done=>{entered=done;});
    const original=w.repo.resolveCurrentProof.bind(w.repo);let first=true;
    w.repo.resolveCurrentProof=async binding=>{if(first){first=false;entered(binding.itemRef);await paused;}return original(binding);};
    const execution=w.dispatch.execute(w.runRef),selected=await started;
    await w.service.execute(w.cancel([selected]),principal);release();
    const result=await execution;
    expect(result.run.counts).toMatchObject({cancelled:1,completed:1});expect(w.calls).toHaveLength(1);expect(w.calls).not.toContain(selected);
    const cancelled=result.items.find(i=>i.intent.approval.itemRef===selected)!;
    expect(cancelled.receipt).toBeNull();expect(w.db.prepare("SELECT COUNT(*) AS n FROM job_dispatch_attempts WHERE dispatch_key=?").get(cancelled.dispatchKey)?.n).toBe(0);
  });
  it("returns a typed exact-item conflict for attempted/completed selection without changing its immutable receipt",async()=>{
    const w=await fixture();await w.dispatch.execute(w.runRef);const before=w.dispatch.read(w.runRef),view=await w.service.readRun(w.runRef,principal);
    await expect(w.service.execute(w.cancel([view.items[0]!.itemRef]),principal)).rejects.toMatchObject({code:"ITEM_NOT_UNSENT",status:409,executionCertainty:"notApplied"});
    expect(w.dispatch.read(w.runRef).items.map(i=>i.receipt)).toEqual(before.items.map(i=>i.receipt));expect(w.calls).toHaveLength(2);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM job_dispatch_controls").get()?.n).toBe(0);
  });
  it("rolls back selected row changes and transition history if the exact control receipt cannot commit",async()=>{
    const w=await fixture(),before=w.dispatch.read(w.runRef),command=w.cancel([before.items[0]!.intent.approval.itemRef]);
    w.db.exec("CREATE TRIGGER review_reject_control BEFORE INSERT ON job_dispatch_controls BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    await expect(w.service.execute(command,principal)).rejects.toThrow();
    expect(w.dispatch.read(w.runRef).revision).toBe(before.revision);expect(w.dispatch.read(w.runRef).run.counts.cancelled).toBe(0);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM job_dispatch_controls").get()?.n).toBe(0);
    w.db.exec("DROP TRIGGER review_reject_control");await w.service.execute(command,principal);
    expect(w.dispatch.read(w.runRef).run.counts.cancelled).toBe(1);expect(w.db.prepare("SELECT COUNT(*) AS n FROM job_dispatch_controls").get()?.n).toBe(1);expect(w.calls).toHaveLength(0);
  });
});
