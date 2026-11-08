// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { SCHEMA_VERSION, readResponseSchema } from "../adapter/contract.ts";
import { viewSchemas } from "../adapter/viewSchemas/index.ts";
import { settlementSourceFixture } from "./settlements/fixtures.testkit.ts";
import { actionDomainFixture, actionTestScope as scope, exportFixturePayload as payload } from "./actions/fixtures.testkit.ts";
import type { SettlementSnapshot } from "./settlements/source.ts";

const apps: ReturnType<typeof createAgentServer>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
async function setup() {
  const domain=actionDomainFixture(110),fixture=settlementSourceFixture(scope,domain.now());
  const source={...fixture.source,async read(request:Parameters<typeof fixture.source.read>[0]){
    const snapshot=await fixture.source.read(request) as SettlementSnapshot;
    snapshot.export={sourceVersion:domain.snapshot.version,filters:payload.filters};return snapshot;
  }};
  const app=createAgentServer({databasePath:":memory:",workspaceId:scope.workspaceId,accountId:scope.accountId,
    readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,operations:{now:domain.now},
    settlements:{source,ledger:domain.ledger},actionFoundation:{approvals:{sources:{resolveActor:domain.authorize,assertCurrent:domain.assertAuthority}}}});
  apps.push(app);await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const address=app.server.address();if(!address||typeof address==="string")throw Error("Local synthetic service required");
  const origin=`http://127.0.0.1:${address.port}`,requestedScope={workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox"};
  async function post(path:string,input:object,token=SYNTHETIC_REVIEW_TOKEN){const response=await fetch(origin+path,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};}
  const read=(viewKey:string,filters:unknown={},page={cursor:null as string|null,limit:50},token=SYNTHETIC_REVIEW_TOKEN)=>post("/v1/read",{schemaVersion:SCHEMA_VERSION,operation:"readView",requestId:"synthetic-settlement-read",requestedScope,viewKey,filters,period:null,sort:[],page},token);
  return {...fixture,domain,app,source,read,post,requestedScope};
}
describe("settlement native adapter and canonical export composition",()=>{
  it("serves three distinct source-owned record routes with scoped pages and no payment capability",async()=>{
    const w=await setup(),ledger=await w.read("commissionLedger",{}, {cursor:null,limit:1});expect(ledger.status).toBe(200);
    const parsed=readResponseSchema(viewSchemas.commissionLedger!).parse(ledger.body);
    expect(parsed).toMatchObject({dataState:"partial",data:{kind:"native-commission-ledger",source:{synthetic:true},capabilities:{pay:false}},coverage:{complete:false}});
    expect(parsed.page.nextCursor).toBeTruthy();
    const detail=await w.read("settlementDetail",{settlementId:ledger.body.data.records[0].ref});expect(detail.status).toBe(200);
    expect(readResponseSchema(viewSchemas.settlementDetail!).parse(detail.body).data).toMatchObject({kind:"native-settlement",record:{provider:"collabs"}});
    const manual=await w.read("commissionLedger",{provider:"externalManual"});
    expect(manual.body.data.capabilities.export).toBe(false);expect(manual.body.data.export).toBeNull();
    const payable=await w.read("payableDetail",{payableId:manual.body.data.records[0].ref});expect(payable.status).toBe(200);
    expect(readResponseSchema(viewSchemas.payableDetail!).parse(payable.body).data).toMatchObject({kind:"native-payable",record:{historical:{payoutOwner:"externalManual"}}});
    expect(JSON.stringify(ledger.body)).not.toContain("fixture-creator");
    expect((await w.read("commissionLedger",{provider:"tiktok"},{cursor:parsed.page.nextCursor,limit:1})).status).toBe(409);
  });
  it("exports the whole source snapshot and recovers only its original request without generating twice",async()=>{
    const w=await setup(),ledger=await w.read("commissionLedger",{}, {cursor:null,limit:1}),version=ledger.body.data.export.sourceVersion;
    expect(ledger.body.data.capabilities.export).toBe(true);
    const original={requestKey:"original-export",expectedVersion:version,payload};
    expect((await w.read("ledgerExportRequest",original)).body.data.state).toBe("absent");expect(w.domain.state.pageReads).toBe(0);
    const action=await w.post("/v1/action",{schemaVersion:SCHEMA_VERSION,operation:"exportSnapshot",actionKind:"exportLedger",requestId:"export-attempt",requestedScope:w.requestedScope,
      entityRefs:[],approvalRef:null,manifestRef:null,expectedVersion:version,idempotencyKey:original.requestKey,payload});
    expect(action.status).toBe(200);expect(action.body.state).toBe("succeeded");
    const recovery=await w.read("ledgerExportRequest",original);expect(recovery.status).toBe(200);
    expect(readResponseSchema(viewSchemas.ledgerExportRequest!).parse(recovery.body).data).toMatchObject({state:"succeeded",receipt:{rowCount:110,confersRelease:false}});
    const artifact=await w.read("ledgerExportArtifact",{artifactRef:recovery.body.data.receipt.artifactRef});expect(artifact.status).toBe(200);
    const checked=readResponseSchema(viewSchemas.ledgerExportArtifact!).parse(artifact.body);expect(checked.data).toMatchObject({kind:"native-ledger-export-artifact",receipt:{rowCount:110}});
    expect(artifact.body.data.body.split("\r\n")).toHaveLength(112);expect(w.domain.state.pageReads).toBe(3);
    expect((await w.read("ledgerExportRequest",{...original,expectedVersion:"another-version"})).status).toBe(409);
    expect((await w.read("ledgerExportArtifact",{artifactRef:recovery.body.data.receipt.artifactRef},undefined,SYNTHETIC_READ_TOKEN)).status).toBe(403);
    w.domain.state.denySource=true;expect((await w.read("ledgerExportArtifact",{artifactRef:recovery.body.data.receipt.artifactRef})).status).toBe(403);
    expect(w.domain.state.pageReads).toBe(3);
  });
  it("keeps stale and partial unknown records distinct from a current authoritative absence",async()=>{
    const w=await setup(),ledger=await w.read("commissionLedger"),ref=ledger.body.data.records[0].ref;
    w.records.splice(0);w.state.version="next-source-version";w.state.partial=true;
    const partial=await w.read("settlementDetail",{settlementId:ref});expect(partial.status).toBe(200);expect(partial.body.dataState).toBe("partial");expect(partial.body.data.record).toBeNull();
    w.state.partial=false;w.state.version="third-source-version";expect((await w.read("settlementDetail",{settlementId:ref})).status).toBe(404);
  });
});
