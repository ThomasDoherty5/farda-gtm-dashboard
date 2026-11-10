// @vitest-environment node
import { expect,it } from "vitest";
import { createNotionStockSupportSource } from "./notionStockSupportSource.ts";
import { stockTestScope as scope,stockTestTime } from "./stockSupportFixtures.ts";
const stockId="10000000-0000-4000-8000-000000000001",supportId="10000000-0000-4000-8000-000000000002";
const rowId="10000000-0000-4000-8000-000000000003",skuId="10000000-0000-4000-8000-000000000004";
import { digest } from "./config.ts";
import type { StockSupportBinding,StockSupportSourceResult } from "./stockSupport.ts";
const binding=(viewKey:StockSupportBinding["viewKey"],selected=scope):StockSupportBinding=>({scope:selected,principalRef:"agent-reader",operation:"read",viewKey,requestDigest:digest({viewKey})});
const sourceAuthority={observe:(binding:StockSupportBinding,snapshot:StockSupportSourceResult["snapshot"],time:number)=>({binding,sourceVersion:snapshot.revision,permissionVersion:"fictional-explicit-current-grant",observedAt:new Date(time).toISOString(),validUntil:new Date(time+60_000).toISOString()}),assertCurrent:(result:StockSupportSourceResult,binding:StockSupportBinding)=>{expect(result.authority.binding).toEqual(binding);expect(result.authority.sourceVersion).toBe(result.snapshot.revision);}};
const config={sourceAuthority,scope,stockDataSourceId:stockId,supportDataSourceId:supportId,referenceKey:"a".repeat(64),token:async()=>"test-only-token"};
const row=(parent=stockId,properties:object={})=>({object:"page",id:rowId,parent:{type:"data_source_id",data_source_id:parent},last_edited_time:stockTestTime,in_trash:false,properties});
const list=(results:unknown[],more=false)=>Response.json({object:"list",results,has_more:more,next_cursor:more?"next":null});
const prop=(type:string,value:unknown)=>({type,[type]:value});
it("holds an unqualified current grant before contacting the configured mirror",async()=>{
 let calls=0;const source=createNotionStockSupportSource({...config,sourceAuthority:undefined},async()=>{calls++;return list([]);});
 await expect(source.readInventory(binding("inventoryOverview"))).rejects.toMatchObject({code:"SOURCE_AUTHORITY_UNCONFIGURED",status:503});expect(calls).toBe(0);
});
it("isolates fixed Notion queries and represents an empty mirror without stock, case or cohort totals",async()=>{
 const paths:string[]=[];
 const source=createNotionStockSupportSource(config,async(input,options)=>{
   paths.push(String(input));expect(options?.method).toBe("POST");expect(options?.redirect).toBe("error");expect(JSON.parse(String(options?.body))).toEqual({page_size:100});
   return list([]);
 },()=>Date.parse(stockTestTime));
 expect((await source.readInventory(binding("inventoryOverview"))).snapshot).toMatchObject({scope,coverage:"partial",periods:[],currentWindow:null});
 expect((await source.readSupport(binding("supportWorkspace"))).snapshot).toMatchObject({cases:[],allTimeOpen:null,cohort:null});
 expect(paths).toEqual([stockId,supportId].map(id=>"https://api.notion.com/v1/data_sources/"+id+"/query"));
});
it("projects safe formula-backed movement deltas without turning a movement page into an opening balance",async()=>{
 const source=createNotionStockSupportSource(config,async()=>list([row(stockId,{
   Home:prop("select",{name:"H2"}),SKU:prop("relation",[{id:skuId}]),Type:prop("select",{name:"Reserve"}),Date:prop("date",{start:"2026-11-03"}),
   Posted:prop("checkbox",true),Evidence:prop("url","https://example.invalid/synthetic-evidence"),"Entry valid":prop("formula",{type:"boolean",boolean:true}),
   "Stock delta":prop("formula",{type:"number",number:0}),"Reserve delta":prop("formula",{type:"number",number:2}),
   Notes:prop("rich_text",[{plain_text:"synthetic-private-note"}])
 })]),()=>Date.parse(stockTestTime));
 const out=(await source.readInventory(binding("inventoryOverview"))).snapshot;expect(out.periods[0]?.positions[0]).toMatchObject({onHand:null,reserved:null,shopify:null,home:"H2"});
 expect(out.periods[0]?.movements[0]).toMatchObject({physicalDelta:0,reserveDelta:2,receipt:expect.stringMatching(/^ledger-/)});
 for(const secret of [rowId,skuId,"synthetic-private-note","example.invalid"]){expect(JSON.stringify(out)).not.toContain(secret);}
});
it("redacts support notes and person records and does not infer provider handoff or a financial outcome",async()=>{
 const source=createNotionStockSupportSource(config,async()=>list([row(supportId,{
   Owner:prop("people",[{name:"Synthetic private person"}]),Notes:prop("rich_text",[{plain_text:"private-conversation"}]),Status:prop("status",{name:"Open"}),
   Category:prop("select",{name:"Shipping"}),Order:prop("relation",[{id:skuId}]),Resolution:prop("select",{name:"Refunded"}),"Refund amount":prop("number",40)})]),()=>Date.parse(stockTestTime));
 const out=(await source.readSupport(binding("supportWorkspace"))).snapshot;expect(out.cases[0]).toMatchObject({category:"Shipping",state:"Open",owner:"Unknown",handoffAllowed:false,orderRef:expect.stringMatching(/^order-/)});
 for(const secret of [skuId,rowId,"private-conversation","private person","Refunded"]){expect(JSON.stringify(out)).not.toContain(secret);}
 expect(out.cohort).toBeNull();
});
it("rejects denied access, foreign parent and pagination cycles; missing credentials never call a provider",async()=>{
 const make=(f:typeof fetch)=>createNotionStockSupportSource(config,f,()=>Date.parse(stockTestTime));
 await expect(make(async()=>new Response("",{status:403})).readSupport(binding("supportWorkspace"))).rejects.toMatchObject({status:403});
 await expect(make(async()=>list([row(stockId)])).readSupport(binding("supportWorkspace"))).rejects.toMatchObject({status:403});
 await expect(make(async()=>list([],true)).readSupport(binding("supportWorkspace"))).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID"});
 const none=createNotionStockSupportSource({...config,token:async()=>null},async()=>{throw new Error("unexpected provider call");});
 await expect(none.readSupport(binding("supportWorkspace"))).rejects.toMatchObject({code:"INTEGRATION_PENDING"});
 await expect(none.readSupport(binding("supportWorkspace",{...scope,accountId:"other"}))).rejects.toMatchObject({status:403});
});
