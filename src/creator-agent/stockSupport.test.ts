// @vitest-environment node
import { describe,it,expect } from "vitest";
import { AgentStore } from "./store.ts";
import { createStockSupportWorkflow } from "./stockSupport.ts";
import { inventorySnapshotSchema,supportSnapshotSchema } from "./stockSupportSchema.ts";
import { inventorySourceFixture,supportSourceFixture,stockTestScope as scope,stockTestTime } from "./stockSupportFixtures.ts";
const reviewer="agent-reviewer";
function setup(){
  const stock=inventorySourceFixture(),support=supportSourceFixture();
  const db=new AgentStore(":memory:",scope).database;db.exec("CREATE TABLE capability_scope(id INTEGER,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId,scope.accountId,scope.environment);
  const workflow=createStockSupportWorkflow(db,scope,{readInventory:async()=>stock,readSupport:async()=>support},()=>Date.parse(stockTestTime));
  return {workflow,stock,support,db};
}
const transfer={scope:{home:"H1",sku:"FARDA-GRAPHITE",windowRef:"current"},sku:"FARDA-GRAPHITE",windowRef:"current",from:"H1",to:"H2",units:16,reasonCode:"rebalance"};
const envelope=(expectedVersion:string,key:string,payload:object=transfer,actionKind="requestStockTransfer")=>({
  operation:"requestApproval",actionKind,requestedScope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox"},entityRefs:[],approvalRef:null,manifestRef:null,expectedVersion,idempotencyKey:key,payload});
describe("source-owned stock and support workspaces",()=>{
 it("preserves all three scope dimensions, snapshot/physical distinction, receipt and reservation identity",async()=>{
   const {workflow}=setup();const result=await workflow.read("inventoryOverview",transfer.scope,reviewer);
   expect(result.data).toMatchObject({kind:"source-stock",period:{positions:[{home:"H1",onHand:{units:100},reserved:{units:14},reservations:[{orderRef:"TEST-SH-1042"}]}],movements:[{ref:"TEST-MOV-0187"}],transfers:[{ref:"TEST-TR-012",received:null}]}});
   expect((await workflow.read("inventoryOverview",{home:"H2",windowRef:"prior"},reviewer)).data).toMatchObject({period:{positions:[],movements:[],transfers:[]}});
   expect((await workflow.read("inventoryOverview",{windowRef:"prior"},reviewer)).data).toMatchObject({period:{positions:[{sku:"FARDA-GRAPHITE-2",onHand:null,reserved:null}]}});
 });
 it("commits one local receipt across racing submissions; exact scoped lookup and rejected stale nonce survive retries",async()=>{
   const {workflow,db,stock}=setup(),before=structuredClone(stock);const v=(await workflow.read("inventoryOverview",transfer.scope,reviewer)).version;
   const a=envelope(v,"request-1");const [one,two]=await Promise.all([workflow.propose(a,reviewer),workflow.propose(a,reviewer)]);expect(two).toEqual(one);
   expect(db.prepare("SELECT count(*) n FROM stock_support_reviews").get()?.n).toBe(1);expect(stock).toEqual(before);
   const exact=await workflow.read("inventoryOverview",{...transfer.scope,proposalRequestKey:"request-1"},reviewer);
   expect(exact.data.reconciliation).toMatchObject({state:"recorded",actionRef:one.actionRef,requestKey:"request-1",baseVersion:v,digest:one.payloadVersion});
   await expect(workflow.read("inventoryOverview",{home:"H2",proposalRequestKey:"request-1"},reviewer)).rejects.toMatchObject({status:403});
   await expect(workflow.read("inventoryOverview",{...transfer.scope,proposalRequestKey:"request-1"},"agent-reader")).rejects.toMatchObject({status:403});
   await expect(workflow.propose(envelope(v,"request-1",{...transfer,units:3}),reviewer)).rejects.toMatchObject({status:409});
   await expect(workflow.propose(envelope(v,"request-late"),reviewer)).rejects.toMatchObject({code:"STALE_VERSION"});
   expect((await workflow.read("inventoryOverview",{...transfer.scope,proposalRequestKey:"request-late"},reviewer)).data.reconciliation?.state).toBe("rejected");
 });
 it("rejects shortages, incomplete receipts and conflicting or unknown balances without making a second stock ledger",async()=>{
   const {workflow,stock}=setup();
   async function attempt(code:string,units=2){
     const v=(await workflow.read("inventoryOverview",transfer.scope,reviewer)).version;
     await expect(workflow.propose(envelope(v,"attempt",{...transfer,units}),reviewer)).rejects.toMatchObject({code});
   }
   await attempt("QUOTA_OR_STOCK_HOLD",87);
   stock.periods[0]!.positions[0]!.shopify!.units=99;await attempt("STOCK_CONFLICT");
   stock.periods[0]!.positions[0]!.shopify=null;await attempt("STOCK_BASIS_UNKNOWN");
   stock.periods[0]!.positions[0]!.shopify={units:100,receipt:"verified"};
   stock.periods[0]!.movements[0]!.receipt=null;stock.periods[0]!.movements[0]!.physicalDelta=null;stock.periods[0]!.movements[0]!.reserveDelta=null;
   await attempt("RECEIPTS_MISSING");stock.coverage="partial";await attempt("SOURCE_COVERAGE_PARTIAL");
   stock.coverage="complete";stock.observedAt="2026-11-03T00:00:00Z";await attempt("SOURCE_STALE");
 });
 it("empty specific-case reads and uncertain stale or partial absences are held; reviews never deduct stock",async()=>{
   const {workflow,stock,support}=setup();support.cases=[];
   await expect(workflow.read("supportWorkspace",{caseId:"missing"},reviewer)).rejects.toMatchObject({code:"RECORD_NOT_FOUND"});
   expect((await workflow.read("supportWorkspace",{caseId:"queue"},reviewer)).data).toMatchObject({cases:[]});
   const proposal={...transfer,units:80};let v=(await workflow.read("inventoryOverview",transfer.scope,reviewer)).version;
   await workflow.propose(envelope(v,"first-review",proposal),reviewer);
   v=(await workflow.read("inventoryOverview",transfer.scope,reviewer)).version;
   await expect(workflow.propose(envelope(v,"independent-review",{...proposal,reasonCode:"order-shortage"}),reviewer)).resolves.toMatchObject({state:"approvalPending"});
   expect(stock.periods[0]!.positions[0]!.reserved?.units).toBe(14);
   stock.coverage="partial";const filters={...transfer.scope,proposalRequestKey:"missing-request"};
   await expect(workflow.read("inventoryOverview",filters,reviewer)).rejects.toMatchObject({code:"SOURCE_COVERAGE_PARTIAL"});
   stock.coverage="complete";stock.observedAt="2026-01-01T00:00:00Z";
   await expect(workflow.read("inventoryOverview",filters,reviewer)).rejects.toMatchObject({code:"SOURCE_STALE"});
 });
 it("refuses altered accounting, duplicate rows, mismatched scopes and future observations",async()=>{
   const {stock,support,workflow}=setup();stock.periods[0]!.movements[0]!.physicalDelta=-2;expect(inventorySnapshotSchema.safeParse(stock).success).toBe(false);
   stock.periods[0]!.movements[0]!.physicalDelta=0;stock.periods[0]!.positions[0]!.reservations[0]!.units=1;expect(inventorySnapshotSchema.safeParse(stock).success).toBe(false);
   support.scope={...scope,accountId:"elsewhere"};await expect(workflow.read("supportWorkspace",{caseId:"queue"},reviewer)).rejects.toMatchObject({status:403});
   support.scope=scope;support.observedAt="2099-01-01T00:00:00Z";await expect(workflow.read("supportWorkspace",{caseId:"queue"},reviewer)).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID"});
 });
 it("keeps 7 all-time and 6 cohort-open apart, rejects private fields and submits only an allowed case review",async()=>{
   const {workflow,support}=setup(),caseId="TEST-ISS-021",r=await workflow.read("supportWorkspace",{caseId},reviewer);
   expect(r.data).toMatchObject({allTimeOpen:7,cohort:{open:6,firstContact:27,returns:18,delivered:300}});
   const a=envelope(r.version,"handoff",{caseId,reasonCode:"refund-review"},"requestSupportHandoff");
   await expect(workflow.propose(a,"agent-reader")).rejects.toMatchObject({status:403});expect(await workflow.propose(a,reviewer)).toMatchObject({state:"approvalPending"});
   support.cases[0]!.handoffAllowed=false;const v=(await workflow.read("supportWorkspace",{caseId},reviewer)).version;
   await expect(workflow.propose({...a,idempotencyKey:"handoff-2",expectedVersion:v},reviewer)).rejects.toMatchObject({code:"CASE_HANDOFF_HELD"});
   expect(supportSnapshotSchema.safeParse({...support,cases:[{...support.cases[0],conversation:"private"}]}).success).toBe(false);
   expect(supportSnapshotSchema.safeParse({...support,cohort:{...support.cohort,firstContact:46}}).success).toBe(false);
 });
});

describe("safe source aggregate boundaries",()=>{
 it.each(["onHand","reserved"] as const)("refuses an unrepresentable period %s aggregate before projecting stock",async field=>{
   const {workflow,stock}=setup(),p=stock.periods[0]!.positions[0]!;
   stock.periods[0]!.positions=[0,1,2].map(i=>({...structuredClone(p),sku:"SAFE-ITEM-"+i,
     onHand:{units:field==="onHand"?Number.MAX_SAFE_INTEGER:0,receipt:"physical-"+i},
     reserved:{units:field==="reserved"?Number.MAX_SAFE_INTEGER:0,receipt:"reserved-"+i},
     shopify:null,reservations:field==="reserved"?[{ref:"reservation-"+i,orderRef:"order-"+i,kind:"order" as const,units:Number.MAX_SAFE_INTEGER}]:[]}));
   await expect(workflow.read("inventoryOverview",{},reviewer)).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID",status:502});
 });
 it("refuses an unrepresentable support ticket aggregate before projecting a rate or count",async()=>{
   const {workflow,support}=setup();support.cohort!.tickets={setup:Number.MAX_SAFE_INTEGER,shipping:Number.MAX_SAFE_INTEGER,returns:Number.MAX_SAFE_INTEGER,hardware:0};
   await expect(workflow.read("supportWorkspace",{caseId:"queue"},reviewer)).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID",status:502});
 });
 it("preserves exact safe boundary totals and unknown inputs",async()=>{
   const {workflow,stock,support}=setup(),p=stock.periods[0]!.positions[0]!;
   stock.periods[0]!.positions=[{...structuredClone(p),onHand:{units:Number.MAX_SAFE_INTEGER,receipt:"safe-limit"},reserved:{units:0,receipt:"none-reserved"},reservations:[]},
     {...structuredClone(p),sku:"UNKNOWN-ITEM",onHand:null,reserved:null,reservations:[]}];
   expect((await workflow.read("inventoryOverview",{},reviewer)).data).toMatchObject({period:{positions:[{onHand:{units:Number.MAX_SAFE_INTEGER}},{onHand:null,reserved:null}]}});
   support.cohort!.tickets={setup:Number.MAX_SAFE_INTEGER,shipping:0,returns:0,hardware:0};
   expect((await workflow.read("supportWorkspace",{caseId:"queue"},reviewer)).data).toMatchObject({cohort:{tickets:{setup:Number.MAX_SAFE_INTEGER}}});
   support.cohort!.tickets=null;
   expect((await workflow.read("supportWorkspace",{caseId:"queue"},reviewer)).data).toMatchObject({cohort:{tickets:null}});
 });
});
