// @vitest-environment node
import { expect,it } from "vitest";
import { AgentStore } from "./store.ts";
import { createStockSupportWorkflow } from "./stockSupport.ts";
import { inventorySourceFixture,supportSourceFixture,stockTestScope as scope,stockTestTime } from "./stockSupportFixtures.ts";
import { nativeInventorySchema } from "./stockSupportSchema.ts";
import { inventoryDemo } from "../fixtures/inventory.ts";
import { heldRows,operationsDemo } from "../fixtures/operations.ts";
import { sandboxChain } from "../fixtures/opsShipping.ts";
import { createOperationsReadReader } from "./operationsReads/reader.ts";
import { nativeOrderRecord,operationsRecord,operationsSnapshot,operationsTestSource } from "./operationsReads/fixtures.testkit.ts";
import type { DispatchSourceFacts } from "../adapter/viewSchemas/nativeOperations.ts";

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

it("reconciles the same sandbox chain through both native readers with exact home and period scope",async()=>{
  // Application integration evidence only: one fictional stock source, no provider activation or movements.
  const store=new AgentStore(":memory:",scope),db=store.database,stock=inventorySourceFixture(),before=structuredClone(stock);
  db.exec("CREATE TABLE capability_scope(id INTEGER,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId,scope.accountId,scope.environment);
  try{
    const now=()=>Date.parse(stock.observedAt),principal={principalRef:"agent-reviewer",role:"reviewer" as const};
    const inventory=createStockSupportWorkflow(db,scope,{readInventory:async()=>stock,readSupport:async()=>supportSourceFixture()},now);
    const ref=(key:string)=>sandboxChain.find(step=>step.key===key)!.ref;
    const current=stock.periods.find(period=>period.window.ref===stock.currentWindow)!;
    const h2=current.positions.find(position=>position.home==="H2")!;
    const dates={order:"2026-11-01T09:00:00.000Z",sample:"2026-11-02T09:00:00.000Z",shortage:"2026-11-03T09:00:00.000Z"};
    const rows=(["shortage","sample","order"] as const).map(key=>{
      const template=[...operationsDemo.queue.rows,...heldRows].find(row=>row.ref===ref(key))!;
      // The shortage asks for one more unit than this exact stock observation has available.
      const units=key==="shortage"?h2.onHand!.units-h2.reserved!.units+1:template.units;
      const sourceFacts:DispatchSourceFacts={requestedAt:dates[key],orderRef:template.kind==="order"?template.ref:null,
        sampleRef:template.kind==="sample"?template.ref:null,shipmentRef:null,detailRef:template.ref,
        orderUnfulfilled:template.kind==="order"?true:null,sampleApproved:template.kind==="sample"?true:null,
        labelCreated:false,canceled:false,identityResolved:true,stockAvailable:key!=="shortage",evidenceRef:"synthetic-chain-eligibility",observedAt:stock.observedAt};
      return {...template,units,waitingHours:0,sourceFacts};
    });
    const windowFilters=(period:typeof current,home:"all"|"H1"|"H2"|"H3"="all")=>({home,startAt:period.window.start+"T00:00:00.000Z",
      endAt:new Date(Date.parse(period.window.end+"T00:00:00.000Z")+86400000).toISOString(),timezone:"UTC"});
    const known=<T,>(value:T)=>({state:"known" as const,value,reasonCode:null,evidenceRefs:[],sourceRef:null,occurredAt:null,sourceUpdatedAt:stock.observedAt,observedAt:stock.observedAt});
    const unknown={...known(0),state:"unknown",value:null,reasonCode:"NO_HANDOFF"};
    const sourceCalls:unknown[]=[];
    const source=operationsTestSource(async(actualScope,request)=>{
      expect(actualScope).toEqual(scope);sourceCalls.push(structuredClone(request));
      if(request.viewKey==="orderDetail"){
        const row=rows.find(item=>item.sourceFacts.detailRef===request.filters.orderId)!;
        expect(row).toBeDefined();
        const base=nativeOrderRecord(row.ref),money={minorUnits:4000,currency:"USD"},notApplicable={...unknown,state:"notApplicable",reasonCode:"SAMPLE_HAS_NO_REVENUE"};
        return operationsSnapshot("orderDetail",{scope,version:stock.revision,observedAt:stock.observedAt,validUntil:new Date(now()+300000).toISOString(),record:{...base,
          provenance:{...(base.provenance as object),observedAt:stock.observedAt},kind:row.kind,home:row.home,
          reportingScope:{...windowFilters(current,row.home),basis:"requestedAt"},
          total:row.kind==="sample"?notApplicable:known(money),refunded:row.kind==="sample"?notApplicable:known({...money,minorUnits:0}),
          items:[{name:"Synthetic linked item",units:row.units,unitPrice:row.kind==="sample"?notApplicable:known(money)}]}});
      }
      if(request.viewKey!=="operationsOverview")throw new Error("Unexpected linked-chain view");
      const filters=request.filters,period=stock.periods.find(p=>windowFilters(p).startAt===filters.startAt&&windowFilters(p).endAt===filters.endAt)!;
      expect(period).toBeDefined();expect(filters.timezone).toBe("UTC");
      const matchHome=(home:string)=>filters.home==="all"||filters.home===home;
      const scopedRows=rows.filter(row=>matchHome(row.home)&&row.sourceFacts.requestedAt>=String(filters.startAt)&&row.sourceFacts.requestedAt<String(filters.endAt));
      const positions=period.positions.filter(position=>matchHome(position.home));
      const summary=(home?:string)=>{const eligible=scopedRows.filter(row=>(!home||row.home===home)&&row.sourceFacts.stockAvailable);
        return {toShip:known(eligible.length),waitingOverTwoDays:known(eligible.filter(row=>now()-Date.parse(row.sourceFacts.requestedAt)>=48*3600000).length),shippedToday:known(0),timeToShipDays:unknown};};
      const base=operationsRecord("operationsOverview"),record={...base,
        provenance:{...(base.provenance as object),observedAt:stock.observedAt},reportingScope:{...filters,basis:"requestedAt"},
        source:{label:"Synthetic shared stock and order evidence",lastSyncedAt:stock.observedAt,observedAt:stock.observedAt},
        all:summary(),byHome:{H1:summary("H1"),H2:summary("H2"),H3:summary("H3")},
        openIssues:known(scopedRows.filter(row=>!row.sourceFacts.stockAvailable).length),needHumanResponse:0,
        health:{carrierTransitDays:unknown,shippingCostPerOrder:unknown,onTimeHandoffPct:unknown},
        queue:{rows:scopedRows,total:scopedRows.length},stock:positions.map(position=>({home:position.home,onHand:position.onHand?.units??null,reserved:position.reserved?.units??null,capacity:null,threshold:position.threshold})),
        transfers:period.transfers.filter(transfer=>matchHome(transfer.from)||matchHome(transfer.to)).map(transfer=>({ref:transfer.ref,toHome:transfer.to,state:transfer.received?"received":"in transit"})),exceptions:[]};
      return operationsSnapshot("operationsOverview",{scope,version:stock.revision,observedAt:stock.observedAt,validUntil:new Date(now()+300000).toISOString(),
        coverage:{state:"complete",expectedCount:scopedRows.length,observedCount:scopedRows.length,reasonCodes:[]},record});
    });
    const operations=createOperationsReadReader({scope,source,secret:"synthetic-linked-chain-key-at-least-32",now});
    type NativeOverview={reportingScope:ReturnType<typeof windowFilters>&{basis:string};queue:{rows:typeof rows;total:number};all:{toShip:{value:number}};
      stock:{home:string;onHand:number|null;reserved:number|null}[];transfers:{ref:string;toHome:string;state:string}[]};
    async function both(period:typeof current,home:"all"|"H1"|"H2"|"H3"="all"){
      const filters=windowFilters(period,home),ops=await operations.read("operationsOverview",filters,principal);
      const inventoryResult=await inventory.read("inventoryOverview",{windowRef:period.window.ref,...(home==="all"?{}:{home})},principal.principalRef);
      const native=ops.data as NativeOverview,stockView=nativeInventorySchema.parse(inventoryResult.data);
      ops.assertCurrent();expect(ops.dataState).toBe("ready");expect(inventoryResult.stale).toBe(false);
      expect(native.reportingScope).toEqual({...filters,basis:"requestedAt"});expect(stockView.period!.window).toEqual(period.window);
      expect(native.stock).toEqual(stockView.period!.positions.map(position=>expect.objectContaining({home:position.home,onHand:position.onHand?.units??null,reserved:position.reserved?.units??null})));
      expect(native.transfers.map(transfer=>[transfer.ref,transfer.toHome,transfer.state])).toEqual(stockView.period!.transfers.map(transfer=>[transfer.ref,transfer.to,transfer.received?"received":"in transit"]));
      return {native,stockView};
    }
    const all=await both(current);
    expect(all.native.queue.rows.map(row=>row.ref)).toEqual([ref("order"),ref("sample"),ref("shortage")]);
    expect(all.native.queue.total).toBe(3);expect(all.native.all.toShip.value).toBe(2);
    for(const key of ["order","sample"] as const){
      const row=all.native.queue.rows.find(item=>item.ref===ref(key))!;
      expect(row.hold).toBeNull();expect(row.sourceFacts.detailRef).toBe(row.ref);
      const detail=await operations.read("orderDetail",{orderId:row.sourceFacts.detailRef!},principal);detail.assertCurrent();
      expect(detail.data).toMatchObject({kind:row.kind,orderRef:row.ref,home:row.home,reportingScope:{...windowFilters(current,row.home),basis:"requestedAt"}});
      if(key==="sample")expect(detail.data).toMatchObject({total:{state:"notApplicable"},refunded:{state:"notApplicable"}});
      const reservation=all.stockView.period!.positions.find(position=>position.home===row.home)!.reservations.find(item=>item.orderRef===row.sourceFacts.detailRef)!;
      expect(reservation).toMatchObject({kind:row.kind,orderRef:row.ref});
      expect(all.stockView.period!.movements.some(movement=>movement.orderRef===row.ref&&movement.receipt!==null)).toBe(true);
    }
    const scoped=await both(current,"H2"),shortage=scoped.native.queue.rows.find(row=>row.ref===ref("shortage"))!,position=scoped.stockView.period!.positions[0]!;
    expect(scoped.native.queue.rows.map(row=>row.ref)).toEqual([ref("sample"),ref("shortage")]);
    expect(scoped.native.queue.total).toBe(2);expect(scoped.native.all.toShip.value).toBe(1);
    expect(shortage.hold).toMatchObject({reason:"Not enough available stock at Home H2",sourceAction:"Transfer stock or choose another home"});
    expect(shortage.units).toBeGreaterThan(position.onHand!.units-position.reserved!.units);
    expect(position.onHand!.units-position.reserved!.units).toBe(18);
    expect(scoped.stockView.period!.transfers).toContainEqual(expect.objectContaining({ref:ref("transfer"),to:shortage.home,units:24,received:null}));
    const prior=await both(stock.periods.find(period=>period.window.ref==="prior")!);
    expect(prior.native.queue).toEqual({rows:[],total:0});expect(prior.native.all.toShip.value).toBe(0);
    expect(prior.native.stock).toEqual([expect.objectContaining({home:"H1",onHand:null,reserved:null})]);expect(prior.native.transfers).toEqual([]);
    expect(sourceCalls).toEqual([{viewKey:"operationsOverview",filters:windowFilters(current)},
      ...["order","sample"].map(key=>({viewKey:"orderDetail",filters:{orderId:ref(key)}})),
      ...[windowFilters(current,"H2"),windowFilters(stock.periods[1]!)].map(filters=>({viewKey:"operationsOverview",filters}))]);
    expect(db.prepare("SELECT count(*) n FROM stock_support_reviews").get()?.n).toBe(0);expect(stock).toEqual(before);
  }finally{store.close();}
});
