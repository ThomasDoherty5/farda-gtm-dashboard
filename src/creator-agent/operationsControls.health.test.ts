// @vitest-environment node
import {afterEach,expect,it,vi} from "vitest";
import {createAgentServer} from "./server.ts";
import {capabilityIdForBinding} from "./connections/ledger.ts";
import {unknownBusinessEligibility,unknownSourceFreshness,type ExpectedBinding,type VerificationReceipt} from "./connections/schema.ts";
import {healthBindingDigest,type HealthObservation} from "./providerHealth.ts";
import {controlTestScope as scope,controlTestTime} from "./operationsControlsFixtures.ts";
import {SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN} from "./testFixtures.ts";
import {controlSourceFixture,controlSourceProvider} from "./operationsControlsFixtures.ts";
const apps:ReturnType<typeof createAgentServer>[]=[];afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
const requestedScope={workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox"};
async function setup(configured=true){
 const binding:ExpectedBinding={...scope,provider:"notion",providerAccountId:"synthetic-native-account",action:"observe",mode:"observe",route:"api",routeRef:"route:synthetic",authorizationScopeVersion:"v1",toolVersion:"v1",requiredScopes:["read"],connectionRef:"connection:synthetic",secretRef:"secretref:synthetic"};
 const receipt:VerificationReceipt={receiptRef:"receipt:synthetic",binding,outcome:"Ready",checkedAt:controlTestTime,expiresAt:"2026-11-06T12:10:00Z",verifiedScopes:["read"],connectionHealth:"Authenticated",sourceFreshness:unknownSourceFreshness(),businessEligibility:unknownBusinessEligibility(),reasonCodes:[]};
 const observation:HealthObservation={bindingDigest:healthBindingDigest(binding),checkedAt:controlTestTime,status:"observed",permission:"allowed",session:"authenticated",roleScopePlan:"verified",coverage:"complete",sourceLastSuccess:controlTestTime,sourceUpdatedAt:controlTestTime,mirrorUpdatedAt:null,quotaState:"not_applicable",quotaRemaining:null,deadlineState:"not_applicable",deadline:null};
 const probe=vi.fn(async()=>structuredClone(observation));
 const clock={value:Date.parse(controlTestTime)},authority={denied:false};
 const app=createAgentServer({databasePath:":memory:",...scope,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,operationsControlSource:controlSourceProvider(controlSourceFixture,()=>clock.value,()=>!authority.denied),operations:{now:()=>clock.value,resolveReceipt:()=>receipt,
  resolveJobActivation:r=>({approved:true,decisionRef:r.decisionRef,definitionHash:r.definitionHash})},providerHealth:{now:()=>clock.value,activationRef:"activation:synthetic",catalog:configured?[{binding,ownerRef:"owner:synthetic",documentationRef:"docs:synthetic",documentationCheckedAt:controlTestTime,maxAgeSeconds:60,freshnessBasis:"successful_read",probe}]:[]}});
 apps.push(app);const id=capabilityIdForBinding(binding);app.operations.ledger.register({binding,ownerRef:"owner:synthetic",costBasis:{state:"unknown",reasonCode:"UNKNOWN"}},0);await app.operations.ledger.verify(id,receipt.receiptRef,1);expect(app.operations.ledger.get(id)?.state,JSON.stringify(app.operations.ledger.get(id))).toBe("Ready");
 await new Promise<void>(r=>app.server.listen(0,"127.0.0.1",r));const addr=app.server.address();if(!addr||typeof addr==="string")throw Error("No listener");const base="http://127.0.0.1:"+addr.port;
 const call=async(path:string,body:unknown,reviewer=true)=>{const r=await fetch(base+path,{method:"POST",headers:{authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN),"content-type":"application/json"},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const read=()=>call("/v1/read",{schemaVersion:"2026-11-02.proposed",operation:"readView",requestId:"synthetic-read",requestedScope,viewKey:"operationsControl",filters:{section:"connections"},period:null,sort:[],page:{limit:50,cursor:null}});
 const request=async(key="synthetic-health")=>{const r=await read();expect(r.status).toBe(200);return {schemaVersion:"2026-11-02.proposed",operation:"refreshObservation",actionKind:"refreshOperationsHealth",requestId:"synthetic-check",requestedScope,entityRefs:[],approvalRef:null,manifestRef:null,expectedVersion:r.body.data.version,idempotencyKey:key,payload:{targetRef:r.body.data.healthTargets[0].targetRef}};};
 return {app,id,probe,observation,base,call,read,request,clock,authority};
}
it("observes exactly once through native HTTP and returns actual J14 receipt, keeping business authority separate",async()=>{
 const s=await setup(),a=await s.request();const first=await s.call("/v1/action",a),retry=await s.call("/v1/action",a);
 expect(first.status).toBe(200);expect(first.body,JSON.stringify(first.body)).toMatchObject({state:"succeeded",executionCertainty:"applied"});expect(first.body.receiptRefs[0]).toMatch(/^health-observation:/);expect(retry.body).toEqual(first.body);expect(s.probe).toHaveBeenCalledTimes(1);
 expect((await s.call("/v1/action",{...a,payload:{targetRef:"other-binding"}})).status).toBe(400);
 expect((await s.call("/v1/action",{...a,expectedVersion:"oc1-"+"0".repeat(64)})).status).toBe(409);
});
it("rejects reader, foreign scope, tampered binding, stale version, forged endpoint and cookie request without CSRF",async()=>{
 const s=await setup(),a=await s.request();
 expect((await s.call("/v1/action",a,false)).status).toBe(403);
 expect((await s.call("/v1/action",{...a,requestedScope:{...requestedScope,accountIds:["other"]}})).status).toBe(400);
 expect((await s.call("/v1/action",{...a,payload:{...a.payload,endpoint:"https://example.test"}})).status).toBe(400);
 expect((await s.call("/v1/action",{...a,expectedVersion:"oc1-"+"0".repeat(64)})).status).toBe(409);
 const session=await fetch(s.base+"/v1/session",{method:"GET",headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN}}),cookie=session.headers.get("set-cookie")!.split(";")[0]!;
 const noCsrf=await fetch(s.base+"/v1/action",{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(a)});expect(noCsrf.status).toBe(403);expect(s.probe).not.toHaveBeenCalled();
});
it("holds unconfigured and subsequently denied bindings without a provider observation",async()=>{
 const missing=await setup(false),result=await missing.call("/v1/action",await missing.request());expect(result.body).toMatchObject({state:"blocked",executionCertainty:"notApplied",receiptRefs:[]});expect(missing.probe).not.toHaveBeenCalled();
 const denied=await setup();denied.app.operations.ledger.revoke(denied.id,"REVOKED",2);const d=await denied.call("/v1/action",await denied.request());expect(d.body).toMatchObject({state:"blocked",executionCertainty:"notApplied",reasonCodes:["PROVIDER_PERMISSION_HELD"]});expect(denied.probe).not.toHaveBeenCalled();
});
it("records a denied observation without claiming healthy source or repeated checking",async()=>{
 const s=await setup();s.observation.permission="denied";s.observation.status="missing_access";const r=await s.call("/v1/action",await s.request());
 expect(r.body).toMatchObject({state:"blocked",executionCertainty:"applied"});expect(r.body.reasonCodes).toContain("PERMISSION_DENIED");expect(r.body.receiptRefs).toHaveLength(1);
 expect((await s.call("/v1/action",await s.request("new-request"))).body).toMatchObject({state:"blocked",executionCertainty:"notApplied"});expect(s.probe).toHaveBeenCalledTimes(1);
});
it("reconciles concurrent original-key checks without falsely confirming an active lease",async()=>{
 const s=await setup();let release:()=>void=()=>{};const wait=new Promise<void>(r=>release=r);let entered:()=>void=()=>{};const started=new Promise<void>(r=>entered=r);
 s.probe.mockImplementation(async()=>{entered();await wait;return structuredClone(s.observation);});
 const a=await s.request(),first=s.call("/v1/action",a);await started;const duplicate=await s.call("/v1/action",a);
 expect(duplicate.body).toMatchObject({state:"outcomeUncertain",executionCertainty:"uncertain",receiptRefs:[]});release();const done=await first;expect(done.body.state).toBe("succeeded");expect((await s.call("/v1/action",a)).body).toEqual(done.body);expect(s.probe).toHaveBeenCalledTimes(1);
});

it("reprojects historical health after expiry and revocation while preserving actual receipt and denying lost source access",async()=>{
 const s=await setup(),a=await s.request(),first=await s.call("/v1/action",a);expect(first.body.state).toBe("succeeded");
 s.clock.value+=61_000;const expired=await s.call("/v1/action",a);expect(expired.body).toMatchObject({state:"blocked",executionCertainty:"applied",receiptRefs:first.body.receiptRefs});
 s.app.operations.ledger.revoke(s.id,"REVOKED",2);const revoked=await s.call("/v1/action",a);expect(revoked.body).toMatchObject({state:"blocked",executionCertainty:"applied",receiptRefs:first.body.receiptRefs});
 s.authority.denied=true;const denied=await s.call("/v1/action",a);expect(denied.status).toBe(403);expect(denied.body.executionCertainty).toBe("applied");expect(s.probe).toHaveBeenCalledTimes(1);
});
it("retains actual observation but clears protected success when source access is withdrawn during the awaited probe",async()=>{
 const s=await setup(),a=await s.request();s.probe.mockImplementation(async()=>{s.authority.denied=true;return structuredClone(s.observation);});
 const result=await s.call("/v1/action",a);expect(result.status).toBe(403);expect(result.body.executionCertainty).toBe("applied");expect(s.app.store.database.prepare("SELECT COUNT(*) n FROM health_observations").get()?.n).toBe(1);
 s.authority.denied=false;expect((await s.call("/v1/action",a)).body.state).toBe("succeeded");expect(s.probe).toHaveBeenCalledTimes(1);
});
