// @vitest-environment node
import {afterEach,describe,it,expect} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AgentStore} from "./store.ts";
import {createOperations} from "./operations.ts";
import {createProviderHealth} from "./providerHealth.ts";
import {createOperationsControls,OperationsControlError,type OperationsControlSource} from "./operationsControls.ts";
import {operationsControlSourceSchema} from "./operationsControlsSchema.ts";
import {controlSourceFixture,controlTestJob,controlTestScope as scope,controlTestTime} from "./operationsControlsFixtures.ts";
const clean:(()=>void)[]=[];afterEach(()=>{for(const c of clean.splice(0))c();});
function setup(path=":memory:"){
 const store=new AgentStore(path,scope),now={value:Date.parse(controlTestTime)},ops=createOperations(store.database,scope,{now:()=>now.value});
 if(!store.database.prepare("SELECT 1 FROM job_heads").get())ops.jobs.register(controlTestJob,0);
 const health=createProviderHealth(store.database,scope,ops.ledger,ops.jobs,{now:()=>now.value}),source=controlSourceFixture();
 const provider:OperationsControlSource={read:async()=>structuredClone(source)};
 const input={db:store.database,scope,secret:"synthetic-server-only-controls-key",ledger:ops.ledger,jobs:ops.jobs,health,source:provider,now:()=>now.value};
 const service=createOperationsControls(input);clean.push(()=>{ops.close();store.close();});
 return {store,now,ops,health,source,provider,input,service};
}
async function request(s:ReturnType<typeof setup>,kind="task",key="synthetic-request"){
 const section=kind==="repair"?"reconciliation":"runs",r=await s.service.read({section},"agent-reviewer","reviewer"),a=r.data.actions.find(x=>x.kind===kind)!;
 return {schemaVersion:"synthetic",requestId:"req-synthetic",operation:"requestApproval",actionKind:"proposeOperationsReview",requestedScope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox"},
 entityRefs:[],approvalRef:null,manifestRef:null,expectedVersion:r.version,idempotencyKey:key,payload:{kind:a.kind,targetRef:a.targetRef,reason:"Synthetic review reason"}};
}
const propose=(s:ReturnType<typeof setup>,a:unknown)=>s.service.propose(a,"agent-reviewer","reviewer");
describe("native operations review controls",()=>{
 it("default source is unconnected with actual role and local records, never fixture permissions",async()=>{
  const s=setup(),native=createOperationsControls({...s.input,source:undefined}),r=await native.read({section:"team"},"agent-reader","reader");
  expect(r.data).toMatchObject({role:"reader",sourceState:"notConnected",records:[],actions:[]});expect(r.capabilities[0]?.state).toBe("denied");
 });
 it("stores exactly one finite local proposal under concurrent submission, without source writes or job ingress",async()=>{
  const s=setup(),a=await request(s),before=structuredClone(s.source);
  const [one,two]=await Promise.all([propose(s,a),propose(s,a)]);
  expect(two).toEqual(one);expect(one.state).toBe("approvalPending");
  expect(s.store.database.prepare("SELECT count(*) n FROM operations_control_requests").get()?.n).toBe(1);
  expect(s.store.database.prepare("SELECT count(*) n FROM job_runs").get()?.n).toBe(0);expect(s.source).toEqual(before);
  const read=await s.service.read({section:"runs",proposalRequestKey:a.idempotencyKey},"agent-reviewer","reviewer");
  expect(read.data.proposalReconciliation).toMatchObject({state:"recorded",actionRef:one.actionRef,manifestDigest:one.payloadVersion,reason:a.payload.reason});
 });
 it("rejects scope, role, forged fields and changed payload under the same request key",async()=>{
  const s=setup(),a=await request(s);
  await expect(s.service.propose(a,"agent-reader","reader")).rejects.toMatchObject({status:403});
  await expect(s.service.propose(a,"forged","reviewer")).rejects.toMatchObject({status:403});
  await expect(propose(s,{...a,requestedScope:{...a.requestedScope,accountIds:["other"]}})).rejects.toMatchObject({status:403});
  await expect(propose(s,{...a,approved:true})).rejects.toMatchObject({status:422});
  await propose(s,a);await expect(propose(s,{...a,payload:{...a.payload,reason:"Changed"}})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
 });
 it.each(["partial","stale","denied","unknown","budget"] as const)("holds %s task source evidence",async kind=>{
  const s=setup();
  if(kind==="partial")s.source.coverage="partial";if(kind==="stale")s.source.observedAt="2026-11-01T00:00:00Z";
  if(kind==="denied"||kind==="unknown")s.source.tasks[0]!.permission=kind;
  if(kind==="budget")s.source.tasks[0]!.items=Array.from({length:6},(_,i)=>({itemKey:"item-"+i,subjectRef:"subject-"+i,evidenceRef:null}));
  const a=await request(s);await expect(propose(s,a)).rejects.toBeInstanceOf(OperationsControlError);
  expect(s.store.database.prepare("SELECT count(*) n FROM operations_control_requests").get()?.n).toBe(0);
 });
 it("revalidates source membership across awaited reads and local job versions after the last await",async()=>{
  const s=setup(),a=await request(s);let calls=0;
  s.provider.read=async()=>{calls++;const result=structuredClone(s.source);if(calls===2){result.tasks=[];}return result;};
  await expect(propose(s,a)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  s.provider.read=async()=>{if(++calls===4)s.ops.jobs.register({...controlTestJob,version:2},1);return structuredClone(s.source);};
  await expect(propose(s,a)).rejects.toMatchObject({code:"STALE_VERSION"});
  expect(s.store.database.prepare("SELECT count(*) n FROM operations_control_requests WHERE json_extract(receipt,'$.state')='recorded'").get()?.n).toBe(0);
 });
 it("seals a lost-before-server stale request as a terminal no-op before any newer rebase",async()=>{
  const s=setup(),a=await request(s);s.source.revision="new-source";
  await expect(propose(s,a)).rejects.toMatchObject({code:"STALE_VERSION"});
  const r=await s.service.read({section:"runs",proposalRequestKey:a.idempotencyKey},"agent-reviewer","reviewer");
  expect(r.data.proposalReconciliation?.state).toBe("rejected");
  s.source.revision="synthetic-v1";await expect(propose(s,a)).rejects.toMatchObject({code:"STALE_VERSION"});
  expect((await propose(s,await request(s,"task","new-key"))).state).toBe("approvalPending");
 });
 it("looks up exact request beyond bounded history and never acknowledges a different section or request",async()=>{
  const s=setup(),a=await request(s);await propose(s,a);
  for(let i=0;i<25;i++)await propose(s,await request(s,"task","request-"+i));
  const r=await s.service.read({section:"runs",proposalRequestKey:a.idempotencyKey},"agent-reviewer","reviewer");
  expect(r.data.historyCoverage).toEqual({returned:20,total:26,partial:true});expect(r.data.proposalReconciliation?.state).toBe("recorded");
  const absent=await s.service.read({section:"runs",proposalRequestKey:"not-this-request"},"agent-reviewer","reviewer");expect(absent.data.proposalReconciliation?.state).toBe("absent");
  await expect(s.service.read({section:"team",proposalRequestKey:a.idempotencyKey},"agent-reviewer","reviewer")).rejects.toMatchObject({status:403});
 });
 it("never certifies absence on partial, stale or unavailable source",async()=>{
  const s=setup();for(const mode of ["partial","stale","missing"]){
   s.source.coverage=mode==="partial"?"partial":"complete";s.source.observedAt=mode==="stale"?"2026-01-01T00:00:00Z":controlTestTime;
   const service=mode==="missing"?createOperationsControls({...s.input,source:undefined}):s.service;
   expect((await service.read({section:"runs",proposalRequestKey:"pending"},"agent-reviewer","reviewer")).data.proposalReconciliation?.state).toBe("unverified");
  }
 });
 it.each(["local","unknown","missing-source-version","partial-comparison","missing-source"] as const)("holds unsafe repair basis %s",async kind=>{
  const s=setup();if(kind==="local"||kind==="unknown")s.source.conflicts[0]!.ownership=kind;
  if(kind==="missing-source-version")s.source.conflicts[0]!.authoritativeVersion=null;
  if(kind==="partial-comparison")s.source.comparisons[0]!.coverage="partial";
  if(kind==="missing-source")s.source.conflicts[0]!.category="missing_source";
  await expect(propose(s,await request(s,"repair"))).rejects.toBeInstanceOf(OperationsControlError);
 });
 it("records repair proposal with exact versions without applying changes or clearing discrepancy",async()=>{
  const s=setup(),before=structuredClone(s.source);await propose(s,await request(s,"repair"));
  expect(s.source).toEqual(before);const r=await s.service.read({section:"reconciliation"},"agent-reviewer","reviewer");
  expect(r.data.records.some(x=>x.details.some(([k,v])=>k==="State"&&v==="open"))).toBe(true);
 });
 it("preserves typed source permission loss after a successful read",async()=>{
  const s=setup();await s.service.read({section:"team"},"agent-reader","reader");
  s.provider.read=async()=>{throw new OperationsControlError("SOURCE_SCOPE_DENIED",403);};
  await expect(s.service.read({section:"team"},"agent-reader","reader")).rejects.toMatchObject({status:403,code:"SOURCE_SCOPE_DENIED"});
 });
 it("rejects invalid dates, mixed money currency, duplicate identities and private fields",async()=>{
  const s=setup();expect(operationsControlSourceSchema.safeParse({...s.source,token:"secret"}).success).toBe(false);
  s.source.comparisons[0]!.mirrorAmount!.currency="EUR";await expect(s.service.read({section:"reconciliation"},"agent-reader","reader")).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID"});
  s.source.comparisons[0]!.mirrorAmount!.currency="USD";s.source.tasks.push(structuredClone(s.source.tasks[0]!));
  await expect(s.service.read({section:"runs"},"agent-reader","reader")).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID"});
 });
 it.each(["credential-field","private-value","private-preview","private-destination","currency"] as const)("rejects unsafe source content %s before a browser projection",async kind=>{
  const s=setup(),raw=JSON.parse(JSON.stringify(s.source));
  if(kind==="credential-field")raw.conflicts[0].field="access_token";
  if(kind==="private-value")raw.conflicts[0].sourceValue="synthetic-customer@example.test";
  if(kind==="private-preview")raw.reports[0].preview=[{label:"pending-reviews",value:"synthetic-private-secret"}];
  if(kind==="private-destination")raw.reports[0].destination="synthetic-customer@example.test";
  if(kind==="currency")raw.conflicts[0].sourceValue.currency="EUR";
  s.provider.read=async()=>raw;
  await expect(s.service.read({section:"reconciliation"},"agent-reader","reader")).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID"});
 });
 it("projects only safe labels and aliases from free source titles and account identifiers",async()=>{
  const s=setup();s.source.roles[0]!.provider="synthetic-private-secret";s.source.roles[0]!.account="synthetic-customer@example.test";
  s.source.tasks[0]!.title="synthetic-private-secret";s.source.reports[0]!.title="synthetic-private-secret";s.source.attribution[0]!.title="synthetic-private-secret";
  for(const section of ["team","runs","reports","capabilities"]){
   const r=await s.service.read({section},"agent-reader","reader");expect(JSON.stringify(r)).not.toContain("synthetic-private-secret");expect(JSON.stringify(r)).not.toContain("synthetic-customer@example.test");
  }
 });
 it("discloses bounded report history without silently dropping returned evidence",async()=>{
  const s=setup(),report=s.source.reports[0]!;
  report.preview=Array.from({length:50},()=>({label:"pending-reviews" as const,value:null}));
  report.history=Array.from({length:100},(_,i)=>({id:"history-"+i,at:controlTestTime,state:"confirmed" as const,receiptRef:"receipt-"+i}));
  const r=await s.service.read({section:"reports"},"agent-reader","reader"),details=r.data.records[0]!.details;
  expect(details).toContainEqual(["Delivery history coverage","50 shown of 100 returned; total source history unknown"]);
  expect(details.filter(([label])=>label.startsWith("Delivery ")&&label!=="Delivery history coverage")).toHaveLength(50);
  expect(details.filter(([label])=>label==="pending-reviews")).toHaveLength(50);expect(details.length).toBeLessThanOrEqual(120);
 });
 it("binds run platforms to exact current source membership and keeps missing or stale membership unknown",async()=>{
  const s=setup(),run=s.ops.jobs.ingest({schemaVersion:"job-reference-batch.v1",jobId:controlTestJob.jobId,jobVersion:1,eventId:"synthetic-event",eventType:controlTestJob.eventType,eventAt:null,items:[{itemKey:"item:one",subjectRef:"subject:one",evidenceRef:null}]},"synthetic-ingress");
  s.source.runMembership=[{id:"membership:one",runId:run.runId,platform:"instagram",assignedActorRef:null,sourceVersion:"membership-v1",evidenceRef:"evidence:membership",observedAt:controlTestTime}];
  expect((await s.service.read({section:"runs",platform:"instagram"},"agent-reader","reader")).data.runFilterEvidence).toMatchObject({matched:1,unknownPlatform:0});
  expect((await s.service.read({section:"runs",platform:"tiktok"},"agent-reader","reader")).data.localRuns).toHaveLength(0);
  s.source.runMembership[0]!.observedAt="2026-11-01T00:00:00Z";const stale=await s.service.read({section:"runs",platform:"instagram"},"agent-reader","reader");expect(stale.data.runFilterEvidence).toMatchObject({matched:0,unknownPlatform:1});
 });
 it("binds human takeover proposals to a real run item and never claims assignment or changes its checkpoint",async()=>{
  const s=setup(),run=s.ops.jobs.ingest({schemaVersion:"job-reference-batch.v1",jobId:controlTestJob.jobId,jobVersion:1,eventId:"synthetic-event",eventType:controlTestJob.eventType,eventAt:null,items:[{itemKey:"item:one",subjectRef:"subject:one",evidenceRef:null}]},"synthetic-ingress");
  s.source.takeovers=[{id:"takeover:one",runId:run.runId,itemId:run.items[0]!.itemId,reason:"owner_review",requestAllowed:true,assignment:null,sourceVersion:"takeover-v1",evidenceRef:"evidence:takeover",observedAt:controlTestTime}];
  const before=s.ops.jobs.getRun(run.runId);await propose(s,await request(s,"takeover"));expect(s.ops.jobs.getRun(run.runId)).toEqual(before);expect(s.source.takeovers[0]!.assignment).toBeNull();
  s.source.takeovers[0]!.itemId="foreign-item";await expect(propose(s,await request(s,"takeover","another-key"))).rejects.toMatchObject({code:"RECORD_NOT_FOUND"});
 });
 it("preserves immutable proposal receipts through a real SQLite restart",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"controls-test-"));clean.push(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,"controls.db");
  const first=setup(path),a=await request(first),receipt=await propose(first,a);const close=clean.pop()!;close();
  const reopened=setup(path);expect(await propose(reopened,a)).toEqual(receipt);
 });
});
