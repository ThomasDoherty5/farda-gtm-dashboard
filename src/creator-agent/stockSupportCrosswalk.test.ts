// @vitest-environment node
import { expect,it } from "vitest";
import { AgentStore } from "./store.ts";
import { createStockSupportWorkflow } from "./stockSupport.ts";
import { inventorySourceFixture,supportSourceFixture,stockTestScope as scope,stockTestTime } from "./stockSupportFixtures.ts";
import { nativeInventorySchema } from "./stockSupportSchema.ts";
import { inventoryDemo } from "../fixtures/inventory.ts";
import { heldRows,operationsDemo } from "../fixtures/operations.ts";
import { sandboxChain } from "../fixtures/opsShipping.ts";

it("reconciles the native stock slice with the shared order, sample, shortage and transfer chain without performing movements",async()=>{
  const store=new AgentStore(":memory:",scope),db=store.database,stock=inventorySourceFixture(),original=structuredClone(stock);
  db.exec("CREATE TABLE capability_scope(id INTEGER,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId,scope.accountId,scope.environment);
  try{
    const workflow=createStockSupportWorkflow(db,scope,{readInventory:async()=>stock,readSupport:async()=>supportSourceFixture()},()=>Date.parse(stockTestTime));
    const shown=await workflow.read("inventoryOverview",{},"agent-reviewer"),data=nativeInventorySchema.parse(shown.data),period=data.period!;
    const refs=Object.fromEntries(sandboxChain.map(c=>[c.key,c.ref]));
    expect(operationsDemo.queue.rows.map(r=>r.ref)).toEqual(expect.arrayContaining([refs.order,refs.sample]));
    expect(period.positions.map(p=>({home:p.home,sku:p.sku,onHand:p.onHand?.units,reserved:p.reserved?.units})))
      .toEqual(inventoryDemo().rows.map(p=>({home:p.home,sku:p.sku,onHand:p.onHand,reserved:p.reserved})));
    const sample=period.movements.find(m=>m.orderRef===refs.sample)!;
    expect(sample).toMatchObject({home:"H2",type:"Reserve",physicalDelta:0,reserveDelta:2,receipt:expect.any(String)});
    const order=period.movements.find(m=>m.orderRef===refs.order)!;
    expect(order).toMatchObject({type:"Customer shipment",physicalDelta:-1,reserveDelta:-1});
    const transfer=period.transfers.find(t=>t.ref===refs.transfer)!;
    expect(transfer).toMatchObject({from:"H1",to:"H2",units:inventoryDemo().transfer.expectedUnits,received:null});
    const shortage=heldRows.find(r=>r.ref===refs.shortage)!;
    expect(shortage.home).toBe(transfer.to);expect(shortage.hold?.reason).toMatch(/Not enough available stock/);
    const h2=period.positions.find(p=>p.home===shortage.home)!;
    expect(h2.onHand!.units-h2.reserved!.units).toBe(18);
    const scoped=await workflow.read("inventoryOverview",{home:"H2",sku:h2.sku,windowRef:"current"},"agent-reviewer");
    await expect(workflow.propose({operation:"requestApproval",actionKind:"requestStockTransfer",entityRefs:[],approvalRef:null,manifestRef:null,
      expectedVersion:scoped.version,idempotencyKey:"synthetic-chain-shortage",requestedScope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox"},
      payload:{scope:{home:"H2",sku:h2.sku,windowRef:"current"},sku:h2.sku,windowRef:"current",from:"H2",to:"H1",units:19,reasonCode:"sample-shortage"}},"agent-reviewer"))
      .rejects.toMatchObject({code:"QUOTA_OR_STOCK_HOLD"});
    expect(db.prepare("SELECT count(*) n FROM stock_support_reviews").get()?.n).toBe(0);
    expect(stock).toEqual(original);
  }finally{store.close();}
});
