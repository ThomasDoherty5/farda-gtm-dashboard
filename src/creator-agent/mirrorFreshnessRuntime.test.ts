// @vitest-environment node
import {createRequire} from "node:module";
import {afterEach,describe,expect,it,vi} from "vitest";
import {MirrorFreshnessRepository} from "./mirrorFreshnessRepository.ts";
import {MirrorFreshnessRuntime} from "./mirrorFreshnessRuntime.ts";
import {mirrorCompletionSchema,mirrorFreshnessViewSchema} from "./mirrorFreshnessContract.ts";
import {mirrorTestApproval,mirrorTestBindings,mirrorTestCompletion,mirrorTestNow,mirrorTestScope,mirrorTestSource} from "./mirrorFreshnessTestFixtures.ts";
const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const cleanup:(()=>void)[]=[];
afterEach(()=>{cleanup.splice(0).reverse().forEach(f=>f());vi.useRealTimers();});
function setup(){
  const db=new DatabaseSync(":memory:");cleanup.push(()=>db.close());
  db.exec("CREATE TABLE capability_scope(id INTEGER PRIMARY KEY,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT INTO capability_scope VALUES(1,?,?,?)").run(mirrorTestScope.workspaceId,mirrorTestScope.accountId,"sandbox");
  const clock={at:mirrorTestNow};const source=mirrorTestSource();
  const repository=new MirrorFreshnessRepository(db,mirrorTestScope,{approval:mirrorTestApproval,boundMirrors:["orders"],now:()=>clock.at});
  const runtime=new MirrorFreshnessRuntime(repository,mirrorTestScope,source.source,[mirrorTestBindings[0]!]);cleanup.push(()=>runtime.stop());
  return {db,clock,source,repository,runtime};
}
describe("qualified mirror completion and health sweep",()=>{
  it.each(["partition","cursor","ack","watermark","excess"])("refuses incomplete %s evidence",what=>{
    const c=mirrorTestCompletion();
    if(what==="partition")c.coverage.partitionsExpected=2;
    if(what==="cursor")c.coverage.pendingCursor="synthetic-next";
    if(what==="ack")c.coverage.mirrorAcknowledged=false;
    if(what==="watermark")c.coverage.sourceAsOf=null;
    if(what==="excess")c.coverage.partitionsCompleted=2;
    expect(mirrorCompletionSchema.safeParse(c).success).toBe(false);
  });
  it("requires exact scope, binding version, source-currentness and immutable receipt identity",async()=>{
    const w=setup(),c=mirrorTestCompletion();
    for(const bad of [{...c,scope:{...c.scope,accountId:"synthetic-other"}},{...c,bindingVersion:"synthetic-other"},{...c,bindingRef:"synthetic-other"}]){
      await expect(w.runtime.ingest(w.source.add(bad))).rejects.toThrow("MIRROR_COMPLETION_BINDING_MISMATCH");
    }
    w.source.state.current=false;await expect(w.runtime.ingest(w.source.add(c))).rejects.toThrow("SOURCE_REVOKED");
    expect(w.repository.readRun(c.run.runId)).toBeNull();expect(w.runtime.completion(c.run.runId)).toBeNull();
    w.source.state.current=true;expect((await w.runtime.ingest(w.source.add(c))).duplicate).toBe(false);
    expect((await w.runtime.ingest(c.receiptRef)).duplicate).toBe(true);
    await expect(w.runtime.ingest(w.source.add({...c,coverage:{...c.coverage,sourceVersion:"synthetic-new"}}))).rejects.toThrow("MIRROR_COMPLETION_RECEIPT_REUSED");
    expect(w.runtime.completion(c.run.runId)).toEqual(c);
  });
  it("refuses asynchronous authority assertions and rolls back both records",async()=>{
    const w=setup(),c=mirrorTestCompletion();w.source.source.assertCurrent=async()=>{};
    await expect(w.runtime.ingest(w.source.add(c))).rejects.toThrow("synchronous void");
    expect(w.repository.readRun(c.run.runId)).toBeNull();expect(w.runtime.completion(c.run.runId)).toBeNull();
  });
  it("records owner history immutably and never inherits a changed source's watermark",async()=>{
    const w=setup();await w.runtime.ingest(w.source.add(mirrorTestCompletion()));
    expect(w.repository.policyHistory()).toEqual([mirrorTestApproval]);
    expect(()=>{w.repository.policies.orders.staleAfterMinutes=9000;}).toThrow();
    expect(()=>{w.repository.approval!.ownerRef="synthetic-injected";}).toThrow();
    const changed=structuredClone(mirrorTestApproval);changed.policies.orders!.staleAfterMinutes=90;
    expect(()=>new MirrorFreshnessRepository(w.db,mirrorTestScope,{approval:changed,now:()=>w.clock.at})).toThrow("MIRROR_POLICY_VERSION_REUSED");
    expect(()=>new MirrorFreshnessRuntime(w.repository,mirrorTestScope,w.source.source,[{...mirrorTestBindings[0]!,version:"synthetic-v2"}])).toThrow("MIRROR_BINDING_CHANGE_REQUIRES_RECONCILIATION");
    expect(w.db.isTransaction).toBe(false);
  });
  it("preserves paused stale incidents through partial checks, dedupes sweeps, and clears only complete recovery",async()=>{
    const w=setup();await w.runtime.ingest(w.source.add(mirrorTestCompletion("orders","complete",mirrorTestNow,0)));
    expect(w.runtime.sweep().incidents.opened).toEqual([]);expect(w.runtime.events()).toEqual([]);
    w.clock.at+=3_600_000;expect(w.runtime.sweep().incidents.opened).toEqual([]);
    w.clock.at+=900_000;const stale=w.runtime.sweep().incidents.opened[0]!;
    expect(stale).toMatchObject({state:"stale",ownerRef:"synthetic-owner",policyVersion:"synthetic-policy-v1",ageMinutes:75,recoveryAction:"resumeAndCompleteCheck"});
    expect(stale.runPath).toContain("mirrorRun=synthetic-run");
    w.clock.at+=900_000;w.runtime.sweep();expect(w.runtime.events()).toHaveLength(1);
    await w.runtime.ingest(w.source.add(mirrorTestCompletion("orders","partial",w.clock.at)));
    w.clock.at+=900_000;expect(w.runtime.sweep().incidents.cleared).toEqual([]);
    const recovery=mirrorTestCompletion("orders","complete",w.clock.at,0);await w.runtime.ingest(w.source.add(recovery));
    w.clock.at+=900_000;const cleared=w.runtime.sweep().incidents.cleared;
    expect(cleared.map(i=>i.state).sort()).toEqual(["partial","stale"]);
    expect(cleared.every(i=>i.clearedByRunId===recovery.run.runId)).toBe(true);
    const before=w.runtime.events();w.clock.at+=900_000;w.runtime.sweep();expect(w.runtime.events()).toEqual(before);
    expect(w.runtime.events(before[0]!.sequence,1)).toHaveLength(1);
    expect(()=>w.runtime.events(0,101)).toThrow();
    const restarted=new MirrorFreshnessRuntime(w.repository,mirrorTestScope,w.source.source,[mirrorTestBindings[0]!]);
    expect(restarted.events()).toEqual(before);expect(restarted.scheduleEvidence().state).toBe("unconfigured");
  });
  it("only reports running after starting the actual timer; failed and stopped schedules clear next run",()=>{
    vi.useFakeTimers();const w=setup();expect(w.runtime.scheduleEvidence().state).toBe("unconfigured");
    w.runtime.start("synthetic-deployment");expect(w.runtime.scheduleEvidence()).toMatchObject({state:"running",timezone:"America/Los_Angeles",everyMinutes:15});
    w.clock.at+=900_000;vi.advanceTimersByTime(900_000);expect(w.runtime.scheduleEvidence().lastSweepAt).toBe(new Date(w.clock.at).toISOString());
    w.runtime.stop();expect(w.runtime.scheduleEvidence()).toMatchObject({state:"stopped",nextSweepAt:null});
    w.runtime.start("synthetic-deployment");w.clock.at=NaN;vi.advanceTimersByTime(900_000);expect(w.runtime.scheduleEvidence()).toMatchObject({state:"failed",nextSweepAt:null});
  });
  it("rejects client inventory, declared freshness and schedule contradictions",()=>{
    const w=setup();const data={kind:"mirror-freshness",configured:true,mirrors:w.repository.evaluate(),policy:mirrorTestApproval,schedule:w.runtime.scheduleEvidence(),incidents:[]};
    expect(mirrorFreshnessViewSchema.safeParse(data).success).toBe(true);
    expect(mirrorFreshnessViewSchema.safeParse({...data,configured:false}).success).toBe(false);
    expect(mirrorFreshnessViewSchema.safeParse({...data,policy:null}).success).toBe(false);
    expect(mirrorFreshnessViewSchema.safeParse({...data,mirrors:data.mirrors.map(()=>data.mirrors[0])}).success).toBe(false);
    expect(mirrorFreshnessViewSchema.safeParse({...data,schedule:{...data.schedule,state:"running"}}).success).toBe(false);
  });
});
