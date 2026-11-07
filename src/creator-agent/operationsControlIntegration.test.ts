// @vitest-environment node
import {afterEach,describe,expect,it} from "vitest";
import {createOperationsControlHttpFixture} from "./operationsControlHttp.testkit.ts";
import {nativeOperationsControlSchema} from "./operationsControlsSchema.ts";
import {SCHEMA_VERSION} from "../adapter/contract.ts";
import {SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN} from "./testFixtures.ts";
import {sealOperationsToken} from "./operationsTokens.ts";
import {loadOperationsSecret} from "./operationsSecret.ts";
import {controlTestJob} from "./operationsControlsFixtures.ts";
const closes:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
  const f=createOperationsControlHttpFixture();closes.push(f.close);
  await new Promise<void>((resolve,reject)=>{f.app.server.once("error",reject);f.app.server.listen(0,"127.0.0.1",resolve);});
  const address=f.app.server.address();if(!address||typeof address==="string")throw new Error("Missing local fixture address");
  const call=async(path:string,body:unknown,reviewer=true)=>{
    const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:"POST",headers:{authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN),"content-type":"application/json"},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};};
  async function request(key="synthetic-controls-preview"){
    const before=await call("/v1/read",f.readRequest()),data=nativeOperationsControlSchema.parse(before.body.data),action=data.canonicalActions![0]!;
    return {schemaVersion:SCHEMA_VERSION,requestId:"synthetic-control-action",operation:"previewAction",actionKind:"previewOperationsControl",requestedScope:f.requestedScope,
      entityRefs:[],approvalRef:null,manifestRef:null,expectedVersion:data.version,idempotencyKey:key,payload:{kind:action.kind,targetRef:action.targetRef,reason:"Review the exact fictional task.",itemRefs:action.items.map(row=>row.itemRef)}};
  }
  return {...f,call,request};
}
describe("named operations controls through the actual authenticated server",()=>{
  it("routes one finite preview into actual J04 and recovers the original key without dispatch",async()=>{
    const f=await fixture(),input=await f.request(),one=await f.call("/v1/action",input),again=await f.call("/v1/action",input);
    expect(one).toMatchObject({status:200,body:{state:"blocked",executionCertainty:"applied"}});expect(again).toEqual(one);
    expect(one.body.reasonCodes).toContain("APPROVAL_REQUEST_UNVERIFIED");
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(0);expect(f.state.effects).toBe(0);
    const read=await f.call("/v1/read",f.readRequest("runs",{proposalRequestKey:input.idempotencyKey}));
    expect(read.body.data.canonicalReconciliation).toMatchObject({state:"recorded",approvalRef:one.body.approvalRef,executionCertainty:"applied"});
  });
  it("rejects reader, extra fields, forged targets and changed same-key content without source effects",async()=>{
    const f=await fixture(),input=await f.request();
    expect((await f.call("/v1/action",input,false)).status).toBe(403);
    expect((await f.call("/v1/action",{...input,schemaVersion:"unsupported-controls-schema"})).status).toBe(400);
    expect((await f.call("/v1/action",{...input,payload:{...input.payload,approved:true}})).status).toBe(400);
    expect((await f.call("/v1/action",{...input,payload:{...input.payload,targetRef:"forged-source-target"}})).status).toBe(400);
    expect((await f.call("/v1/action",input)).status).toBe(200);
    expect((await f.call("/v1/action",{...input,payload:{...input.payload,reason:"A changed immutable reason"}})).status).toBe(409);expect(f.state.effects).toBe(0);
  });
  it("clears protected output on source loss after the canonical await while retaining local intent certainty",async()=>{
    const f=await fixture(),input=await f.request();f.state.afterDraft=()=>{f.state.denied=true;};
    const answer=await f.call("/v1/action",input);
    expect(answer).toMatchObject({status:403,body:{code:"OPERATIONS_SOURCE_SCOPE_DENIED",executionCertainty:"applied"}});
    expect(answer.body).not.toHaveProperty("approvalRef");expect(answer.body).not.toHaveProperty("reasonCodes");
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM operations_control_requests").get()?.n).toBe(1);
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);expect(f.state.effects).toBe(0);
  });
  it("returns explicit unavailable service evidence without manufacturing an activated runtime",async()=>{
    const f=await fixture();f.state.serviceRefs=[{kind:"runtimeRegistration",targetId:"synthetic-report-target",jobId:"synthetic-job",jobVersion:1,registrationRef:"synthetic-registration",registrationVersion:1}];
    const result=await f.call("/v1/read",f.readRequest("reports"));expect(result.status).toBe(200);
    expect(result.body.data.serviceEvidence).toEqual([expect.objectContaining({kind:"unavailable",service:"runtimeRegistration",reasonCode:"OPERATIONS_SERVICE_UNCONFIGURED"})]);expect(f.state.effects).toBe(0);
  });
  it("does not attach another job's runtime or report evidence to a selected schedule",async()=>{
    const f=await fixture(),selected=f.snapshot.reports[0]!;
    f.snapshot.reports.push({...structuredClone(selected),id:"synthetic-unrelated-report",jobId:"synthetic-another-job"});
    f.state.serviceRefs=[
      {kind:"runtimeRegistration",targetId:selected.id,jobId:controlTestJob.jobId,jobVersion:1,registrationRef:"synthetic-selected-registration",registrationVersion:1},
      {kind:"runtimeRegistration",targetId:"synthetic-other-runtime",jobId:"synthetic-another-job",jobVersion:1,registrationRef:"synthetic-other-registration",registrationVersion:1},
      {kind:"report",targetId:selected.id,reportRef:"synthetic-selected-report"},
      {kind:"report",targetId:"synthetic-unrelated-report",reportRef:"synthetic-unrelated-delivery"},
    ];
    const scope=f.current().scope,jobRef=sealOperationsToken(scope,loadOperationsSecret(f.app.store.database,scope),"schedule-job",controlTestJob.jobId);
    const result=await f.call("/v1/read",f.readRequest("reports",{jobRef}));expect(result.status).toBe(200);
    expect(result.body.data.serviceEvidence).toHaveLength(2);
    expect(result.body.data.serviceEvidence.map((row:{service:string})=>row.service)).toEqual(["runtimeRegistration","report"]);
  });
});
