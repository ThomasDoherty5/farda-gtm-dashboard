import { type InventorySnapshot,type SupportSnapshot } from "./stockSupportSchema.ts";
import type { OperationsScope } from "./operations.ts";
import { digest } from "./config.ts";
import { StockSupportError,type StockSupportSource,type StockSupportBinding } from "./stockSupport.ts";
/** Explicit fictional current-grant owner; no provider authority is inferred from these records. */
export function stockSupportTestSource(current:{readInventory(scope:OperationsScope):InventorySnapshot;readSupport(scope:OperationsScope):SupportSnapshot},now:()=>number=()=>Date.parse(stockTestTime),beforeRead?:()=>void|Promise<void>):StockSupportSource {
  const get=(binding:StockSupportBinding)=>binding.viewKey==="inventoryOverview"?current.readInventory(binding.scope):current.readSupport(binding.scope);
  const read=async(binding:StockSupportBinding)=>{await beforeRead?.();const snapshot=structuredClone(get(binding)),time=now();return {snapshot,authority:{binding:structuredClone(binding),
    sourceVersion:snapshot.revision,permissionVersion:"fictional-stock-support-permission-v1",observedAt:new Date(time).toISOString(),validUntil:new Date(time+15*60_000).toISOString()}};};
  return {readInventory:read,readSupport:read,assertCurrent(result,binding){if(result.authority.permissionVersion!=="fictional-stock-support-permission-v1"||digest(result.authority.binding)!==digest(binding)||digest(result.snapshot)!==digest(get(binding)))throw new StockSupportError("STOCK_SUPPORT_SOURCE_CHANGED",409);}};
}
export const stockTestTime="2026-11-04T17:00:00Z";
export const stockTestScope:OperationsScope={workspaceId:"test-workspace",accountId:"test-account",environment:"sandbox"};
export function inventorySourceFixture(scope:OperationsScope=stockTestScope):InventorySnapshot{
  const sku="FARDA-GRAPHITE";
  const positions:InventorySnapshot["periods"][number]["positions"]=(["H1","H2","H3"] as const).map((home,i)=>{
    const units=[100,28,68][i]!,reserved=[14,10,4][i]!;
    return {home,sku,onHand:{units,receipt:"TEST-BAL-"+home},shopify:{units,receipt:"TEST-SHOP-"+home},reserved:{units:reserved,receipt:"TEST-RSV-"+home},
      threshold:20,reservations:[{ref:"TEST-R-"+home,kind:i===1?"sample":"order",orderRef:["TEST-SH-1042","TEST-SC-0081","TEST-SH-1045"][i]!,units:reserved}]};
  });
  return {scope,revision:"stock-synthetic-1",observedAt:stockTestTime,coverage:"complete",currentWindow:"current",periods:[
    {window:{ref:"current",start:"2026-10-22",end:"2026-11-04"},positions,movements:[
      {ref:"TEST-MOV-0188",home:"H2",sku,date:"2026-11-02",type:"Reserve",orderRef:"TEST-SC-0081",physicalDelta:0,reserveDelta:2,receipt:"TEST-RESERVE-1"},
      {ref:"TEST-MOV-0187",home:"H1",sku,date:"2026-11-01",type:"Customer shipment",orderRef:"TEST-SH-1042",physicalDelta:-1,reserveDelta:-1,receipt:"TEST-SHIP-1"}],
      transfers:[{ref:"TEST-TR-012",sku,from:"H1",to:"H2",units:24,expectedBy:"2026-11-03",dispatchReceipt:"TEST-DISPATCH-1",received:null}]},
    {window:{ref:"prior",start:"2026-10-08",end:"2026-10-21"},positions:[{...positions[0]!,sku:"FARDA-GRAPHITE-2",onHand:null,reserved:null,shopify:null,reservations:[]}],movements:[],transfers:[]}
  ]};
}
export function supportSourceFixture(scope:OperationsScope=stockTestScope):SupportSnapshot{
  return {scope,revision:"support-synthetic-1",observedAt:stockTestTime,coverage:"complete",allTimeOpen:7,cases:[
    {id:"TEST-ISS-021",sourceRef:"TEST-CASE-021",orderRef:"TEST-SH-1031",state:"Open",category:"Shipping",owner:"Operations",updatedAt:"2026-11-04T16:49:00Z",shipmentRef:"TEST-SP-0093",returnRef:null,handoffAllowed:true},
    {id:"TEST-ISS-018",sourceRef:"TEST-CASE-018",orderRef:"TEST-SH-1028",state:"In review",category:"Return",owner:"Support",updatedAt:"2026-11-04T16:20:00Z",shipmentRef:null,returnRef:"TEST-RET-028",handoffAllowed:true}
  ],cohort:{start:"2026-10-22",end:"2026-11-04",timezone:"America/Los_Angeles",receipt:"TEST-COHORT-1",open:6,tickets:{setup:18,shipping:12,returns:6,hardware:9},firstContact:27,returns:18,delivered:300,refundedOrders:3,replacements:2}};
}
