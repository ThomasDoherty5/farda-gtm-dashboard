// @vitest-environment node
import {describe,it,expect} from "vitest";
import {createReportingTestkit,reportFixture} from "./slackReporting/fixtures.testkit.ts";
import {createSlackReporting} from "./slackReporting/service.ts";
import {formatReport} from "./slackReporting/format.ts";
import {reportEventSchema} from "./slackReporting/contract.ts";
import {MirrorFreshnessRepository} from "./mirrorFreshnessRepository.ts";
import {MirrorFreshnessRuntime} from "./mirrorFreshnessRuntime.ts";
import {fenceMirrorReporting,mirrorReportEvent,type MirrorReportingConfig} from "./mirrorFreshnessReporting.ts";
import {mirrorTestApproval,mirrorTestBindings,mirrorTestCompletion,mirrorTestSource} from "./mirrorFreshnessTestFixtures.ts";

function setup(){
 const w=createReportingTestkit(),input=mirrorTestSource();
 const approval={...mirrorTestApproval,approvedAt:new Date(w.now-1000).toISOString()};
 const repo=new MirrorFreshnessRepository(w.db,w.scope,{approval,boundMirrors:["orders"],now:()=>w.now});
 const runtime=new MirrorFreshnessRuntime(repo,w.scope,input.source,[mirrorTestBindings[0]!]);
 const config:MirrorReportingConfig={producerRef:"producer:synthetic-mirror",link:reportFixture(w.now).event.link,
  runEvidenceUrl:run=>"https://example.invalid/mirror-runs/"+encodeURIComponent(run)};
 const source=fenceMirrorReporting(runtime,w.source,config);
 const service=createSlackReporting({db:w.db,scope:w.scope,secret:"synthetic-reporting-private-test-key-000000000000",jobs:w.jobs,source,now:()=>w.now});
 const ingest=async(changed=0)=>{const c=mirrorTestCompletion("orders","complete",w.now,changed);await runtime.ingest(input.add(c));};
 const register=(eventRef:string)=>{
  const snapshot=reportFixture(w.now);snapshot.event=mirrorReportEvent(runtime,eventRef,config);
  snapshot.programme.permittedProducers=[config.producerRef];snapshot.testProvenance={kind:"controlledSandbox",evidenceRef:"synthetic-mirror-proof"};
  return {snapshot,locator:w.add(snapshot)};
 };
 return {w,repo,runtime,config,service,ingest,register,close(){runtime.stop();w.close();}};
}
describe("mirror incidents use the existing reporting owner",()=>{
 it("delivers one breach and one exact-thread recovery, with complete safe context and no repeat spam",async()=>{
  const x=setup();try{
   await x.ingest();x.runtime.sweep();expect(x.runtime.events()).toEqual([]);
   x.w.advance(75*60_000);x.runtime.sweep();const breach=x.runtime.events()[0]!;
   const {snapshot,locator}=x.register(breach.eventRef);
   const rendered=formatReport(snapshot).body;
   for(const text of ["Orders (google-sheets)","Last complete check:","Complete coverage through:","75 minutes","Inspect exact run evidence","Owner: <@USYNTHETIC>","Resume the mirror","Controlled sandbox test"])expect(rendered).toContain(text);
   const admitted=await x.service.accept(locator,"synthetic-mirror-request",x.w.machine);
   expect((await x.service.work(admitted.reportRef,x.w.machine)).executionCertainty).toBe("applied");
   x.w.advance(15*60_000);x.runtime.sweep();expect(x.runtime.events()).toHaveLength(1);
   await x.service.accept(locator,"synthetic-mirror-replay",x.w.machine);await x.service.work(admitted.reportRef,x.w.machine);
   expect(x.w.state.calls).toHaveLength(1);
   await x.ingest();x.w.advance(15*60_000);x.runtime.sweep();
   const clear=x.runtime.events()[1]!;const recovery=x.register(clear.eventRef);
   const cleared=await x.service.accept(recovery.locator,"synthetic-recovery",x.w.machine);
   expect((await x.service.work(cleared.reportRef,x.w.machine)).executionCertainty).toBe("applied");
   expect(x.w.state.calls).toHaveLength(2);
   expect(x.w.state.calls[1]!.threadTs).not.toBeNull();
   expect(x.w.state.calls[1]!.body).toContain("Complete recovery verified.");
  }finally{x.close();}
 });
 it("holds superseded transitions, altered evidence and revoked send authority",async()=>{
  const x=setup();try{
   await x.ingest();x.w.advance(75*60_000);x.runtime.sweep();
   const record=x.runtime.events()[0]!,registered=x.register(record.eventRef);
   const changed=structuredClone(registered.snapshot);changed.event.mirror!.runEvidenceUrl="https://example.invalid/other";
   x.w.add(changed);await expect(x.service.accept(registered.locator,"synthetic-forgery",x.w.machine)).rejects.toThrow("MIRROR_REPORT_EVENT_MISMATCH");
   x.w.add(registered.snapshot);x.w.state.sendAllowed=false;
   await expect(x.service.accept(registered.locator,"synthetic-denied",x.w.machine)).rejects.toThrow("REPORT_PERMISSION_DENIED");
   x.w.state.sendAllowed=true;await x.ingest();x.w.advance(15*60_000);x.runtime.sweep();
   await expect(x.service.accept(registered.locator,"synthetic-old",x.w.machine)).rejects.toThrow("MIRROR_REPORT_TRANSITION_SUPERSEDED");
   expect(x.w.state.calls).toHaveLength(0);
   for(const url of ["http://example.invalid/run","https://user:secret@example.invalid/run","https://example.invalid/run|<!here>"]){
    expect(reportEventSchema.safeParse({...registered.snapshot.event,mirror:{...registered.snapshot.event.mirror,runEvidenceUrl:url}}).success).toBe(false);
   }
  }finally{x.close();}
 });
});
