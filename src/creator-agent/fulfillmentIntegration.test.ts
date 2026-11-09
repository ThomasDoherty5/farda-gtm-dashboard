// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { fulfillmentFixture } from "./fulfillmentDomain/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { SCHEMA_VERSION, readResponseSchema } from "../adapter/contract.ts";
import { viewSchemas } from "../adapter/viewSchemas/index.ts";

const apps: ReturnType<typeof createAgentServer>[]=[];
const fixtures: ReturnType<typeof fulfillmentFixture>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const fixture of fixtures.splice(0))fixture.close();});
async function setup(kind:"shippingDecision"|"returnTask"="shippingDecision",configured=true) {
  const fixture=fulfillmentFixture(kind);fixtures.push(fixture);
  const human=fixture.a.humans.get(fixture.principal.principalRef)!;
  fixture.a.humans.set("agent-reviewer",{...human,principalRef:"agent-reviewer"});
  fixture.a.humans.set("agent-reader",{...human,principalRef:"agent-reader",roles:["viewer"]});
  const options:AgentServerOptions={databasePath:":memory:",workspaceId:fixture.scope.workspaceId,accountId:fixture.scope.accountId,
    readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,operations:{now:()=>fixture.a.state.now},
    ...(configured?{fulfillment:{source:fixture.source,owners:fixture.bindings.owners},actionFoundation:{approvals:{sources:fixture.a.sources,currentPolicy:fixture.a.options.currentPolicy}}}:{})};
  const app=createAgentServer(options);apps.push(app);await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const address=app.server.address();if(!address||typeof address==="string")throw Error("Synthetic local HTTP server required");
  const origin=`http://127.0.0.1:${address.port}`,requestedScope={workspaceId:fixture.scope.workspaceId,accountIds:[fixture.scope.accountId],environment:"sandbox"};
  async function post(path:string,input:object,token:string|null=SYNTHETIC_REVIEW_TOKEN){const response=await fetch(origin+path,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};}
  const read=(filters:object=fixture.filters,token:string|null=SYNTHETIC_REVIEW_TOKEN)=>post("/v1/read",{schemaVersion:SCHEMA_VERSION,operation:"readView",requestId:"fictional-fulfillment-read",requestedScope,
    viewKey:"fulfillmentProposal",filters,period:null,sort:[],page:{cursor:null,limit:50}},token);
  const action=(data:{version:string;plans:{planRef:string}[]})=>({schemaVersion:SCHEMA_VERSION,operation:"previewAction",actionKind:"previewFulfillmentDecision",requestId:"fictional-fulfillment-preview",requestedScope,
    entityRefs:[],approvalRef:null,manifestRef:null,expectedVersion:data.version,idempotencyKey:"original-fulfillment-request",payload:{...fixture.filters,planRef:data.plans[0]!.planRef,reason:"Review the fictional source inspection"}});
  return {fixture,app,read,post,action,requestedScope};
}

it.each(["shippingDecision","returnTask"] as const)("composes %s source plans through the real adapter and canonical J04, preserving pure recovery",async kind=>{
  const w=await setup(kind),read=await w.read();expect(read.status).toBe(200);
  expect(readResponseSchema(viewSchemas.fulfillmentProposal!).parse(read.body).data).toMatchObject({kind:"native-fulfillment-proposal",source:{synthetic:true},capability:{state:"available"}});
  const input=w.action(read.body.data),preview=await w.post("/v1/action",input);expect(preview.status).toBe(200);expect(preview.body.approvalRef).toBeTruthy();expect(preview.body.runRef).toBeNull();
  const ownerReads=w.fixture.state.ownerReads;w.fixture.state.version="next-source-version";
  const recovered=await w.read({...w.fixture.filters,requestKey:input.idempotencyKey});expect(recovered.status).toBe(200);
  expect(recovered.body.data.recovery).toMatchObject({state:"recorded",approvalRef:preview.body.approvalRef});
  expect(w.fixture.state.ownerReads).toBe(ownerReads);expect(w.fixture.state.effects).toBe(0);expect(JSON.stringify(recovered.body)).not.toContain(input.payload.reason);
  w.fixture.state.historyDenied=true;expect((await w.read({...w.fixture.filters,requestKey:input.idempotencyKey})).status).toBe(403);
});

it("keeps unconnected fulfillment unavailable and validates scope, transport authorization and exact plan payload",async()=>{
  const unconfigured=await setup("shippingDecision",false);expect((await unconfigured.read()).status).toBe(503);
  const w=await setup(),read=await w.read(),input=w.action(read.body.data);
  expect((await w.read(w.fixture.filters,null)).status).toBe(401);
  const reader=await w.read(w.fixture.filters,SYNTHETIC_READ_TOKEN);expect(reader.status).toBe(200);expect(reader.body.capabilities[0].state).toBe("denied");
  expect((await w.post("/v1/action",input,SYNTHETIC_READ_TOKEN)).status).toBe(403);
  expect((await w.post("/v1/action",{...input,requestedScope:{...input.requestedScope,workspaceId:"foreign"}})).status).toBe(400);
  expect((await w.post("/v1/action",{...input,payload:{...input.payload,amount:1}})).status).toBe(400);
  expect((await w.post("/v1/action",{...input,expectedVersion:"old-version"})).status).toBe(409);expect(w.fixture.state.effects).toBe(0);
});

it("preserves original uncertainty, fails closed on revocation and refuses a new-key recovery bypass",async()=>{
  const w=await setup(),read=await w.read(),input=w.action(read.body.data);w.fixture.owner.resolveDraft=async()=>{throw Error("Fictional source unavailable");};
  const failed=await w.post("/v1/action",input);expect(failed.body.executionCertainty).toBe("uncertain");
  expect((await w.read({...w.fixture.filters,requestKey:input.idempotencyKey})).body.data.recovery.state).toBe("pending");
  expect((await w.post("/v1/action",{...input,idempotencyKey:"second-key"})).status).toBe(409);
  w.fixture.state.denied=true;const denied=await w.read({...w.fixture.filters,requestKey:input.idempotencyKey});expect(denied.status).toBe(403);expect(denied.body).not.toHaveProperty("data");expect(w.fixture.state.effects).toBe(0);
});
