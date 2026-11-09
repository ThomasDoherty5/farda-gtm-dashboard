import { createHmac } from "node:crypto";
import { z } from "zod";
import { digest } from "./config.ts";
import { StockSupportError,stockSupportAuthoritySchema,type StockSupportSource,type StockSupportBinding,type StockSupportSourceResult } from "./stockSupport.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";
import { inventorySnapshotSchema,supportSnapshotSchema,type InventorySnapshot,type SupportSnapshot } from "./stockSupportSchema.ts";
import type { OperationsScope } from "./operations.ts";

const uuid=z.string().uuid();
export type StockSupportMirrorConfig={scope:OperationsScope,stockDataSourceId:string,supportDataSourceId:string,token:()=>Promise<string|null>,referenceKey:string,
  sourceAuthority?:{observe(binding:StockSupportBinding,snapshot:InventorySnapshot|SupportSnapshot,now:number):StockSupportSourceResult["authority"];assertCurrent:StockSupportSource["assertCurrent"]}};
const page=z.object({object:z.literal("page"),id:uuid,parent:z.object({type:z.literal("data_source_id"),data_source_id:uuid}),last_edited_time:z.string().datetime({offset:true}),
  archived:z.literal(false).optional(),in_trash:z.literal(false),properties:z.record(z.unknown())});
const list=z.object({object:z.literal("list"),results:z.array(page).max(100),has_more:z.boolean(),next_cursor:z.string().min(1).max(2048).nullable()});
type Row=z.infer<typeof page>;
function property(row:Row,key:string,type:string){const v=z.object({type:z.literal(type)}).passthrough().safeParse(row.properties[key]);return v.success?v.data[type]:null;}
function choice(row:Row,key:string,type="select"){return z.object({name:z.string()}).safeParse(property(row,key,type)).data?.name??null;}
function date(row:Row,key:string){return z.object({start:z.union([z.string().date(),z.string().datetime({offset:true})])}).safeParse(property(row,key,"date")).data?.start.slice(0,10)??null;}
function relation(row:Row,key:string){const p=z.object({type:z.literal("relation"),relation:z.array(z.object({id:uuid})).length(1),has_more:z.literal(false).optional()}).safeParse(row.properties[key]);return p.data?.relation[0]?.id??null;}
function formula(row:Row,key:string,type:string){const p=z.object({type:z.literal(type)}).passthrough().safeParse(property(row,key,"formula"));return p.data?.[type]??null;}
const types=["Receipt","Customer shipment","Creator shipment","Return to stock","Write-off","Reserve","Release reserve","Transfer out","Transfer in"] as const;
const categories=["Pairing","App","Hardware defect","Shipping","Other"] as const;
const states:Record<string,"Open"|"Waiting"|"In review"|"Resolved">={"Open":"Open","New":"Open","In progress":"In review","Waiting":"Waiting","Waiting on customer":"Waiting","Resolved":"Resolved","Closed":"Resolved"};

/** Read two explicitly configured, scoped mirrors. Neither mirror establishes a Shopify snapshot, J15 opening balance or J16 execution permission. */
export function createNotionStockSupportSource(config:StockSupportMirrorConfig,fetcher:typeof fetch=fetch,now:()=>number=Date.now){
  const stockId=uuid.parse(config.stockDataSourceId).toLowerCase(),supportId=uuid.parse(config.supportDataSourceId).toLowerCase();
  if(stockId===supportId || config.referenceKey.length<32)throw new Error("Invalid stock/support source binding");
  const ref=(kind:string,raw:string)=>kind+"-"+createHmac("sha256",config.referenceKey).update(JSON.stringify([config.scope,kind,raw])).digest("hex").slice(0,24);
  async function rows(scope:OperationsScope,id:string){
    if(digest(scope)!==digest(config.scope))throw new StockSupportError("SOURCE_SCOPE_DENIED",403);
    const token=await config.token();if(!token)throw new StockSupportError("INTEGRATION_PENDING",503);
    const found:Row[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor:string|null=null;
    for(let n=0;n<5;n++){
      let response:Response;
      try{response=await fetcher("https://api.notion.com/v1/data_sources/"+id+"/query",{method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),
        headers:{Authorization:"Bearer "+token,"Notion-Version":"2026-03-11","Content-Type":"application/json"},body:JSON.stringify({page_size:100,...(cursor?{start_cursor:cursor}:{})})});}
      catch{throw new StockSupportError("SOURCE_UNAVAILABLE",503);}
      if(!response.ok){await response.body?.cancel();throw new StockSupportError([401,403].includes(response.status)?"SOURCE_AUTHORITY_DENIED":"SOURCE_UNAVAILABLE",[401,403].includes(response.status)?403:503);}
      const reader=response.body?.getReader();if(!reader)throw new StockSupportError("SOURCE_RESPONSE_INVALID",502);
      const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>2_000_000){await reader.cancel();throw new Error("oversized");}chunks.push(r.value);}}
      catch{throw new StockSupportError("SOURCE_RESPONSE_INVALID",502);}
      let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new StockSupportError("SOURCE_RESPONSE_INVALID",502);}
      const parsed=list.safeParse(raw);if(!parsed.success)throw new StockSupportError("SOURCE_RESPONSE_INVALID",502);
      for(const row of parsed.data.results){
        if(row.parent.data_source_id.toLowerCase()!==id)throw new StockSupportError("SOURCE_SCOPE_DENIED",403);
        if(ids.has(row.id)||!Number.isFinite(Date.parse(row.last_edited_time))||Date.parse(row.last_edited_time)>now())throw new StockSupportError("SOURCE_RESPONSE_INVALID",502);
        ids.add(row.id);found.push(row);
      }
      if(!parsed.data.has_more)return found.sort((a,b)=>a.id.localeCompare(b.id));
      cursor=parsed.data.next_cursor;if(!cursor||cursors.has(cursor))throw new StockSupportError("SOURCE_RESPONSE_INVALID",502);cursors.add(cursor);
    }
    // Both mirror projections are explicitly partial. Completeness is never borrowed from a bounded page scan.
    return found.sort((a,b)=>a.id.localeCompare(b.id));
  }
  const requireAuthority=()=>{if(!config.sourceAuthority)throw new StockSupportError("SOURCE_AUTHORITY_UNCONFIGURED",503);return config.sourceAuthority;};
  const assertCurrent:StockSupportSource["assertCurrent"]=(result,binding,time)=>assertSynchronousVoid(()=>requireAuthority().assertCurrent(structuredClone(result),structuredClone(binding),time));
  const qualify=<T extends InventorySnapshot|SupportSnapshot>(snapshot:T,binding:StockSupportBinding)=>{
    const authority=stockSupportAuthoritySchema.parse(requireAuthority().observe(structuredClone(binding),structuredClone(snapshot),now()));
    const result={snapshot,authority};assertCurrent(result,binding,now());return result;};
  return {
    assertCurrent,
    async readInventory(binding:StockSupportBinding){
      requireAuthority();const scope=binding.scope;
      const list=await rows(scope,stockId),observedAt=new Date(now()).toISOString();
      const movements:InventorySnapshot["periods"][number]["movements"]=[];
      for(const r of list){
        const home=z.enum(["H1","H2","H3"]).safeParse(choice(r,"Home")).data,sku=relation(r,"SKU"),dt=date(r,"Date"),type=z.enum(types).safeParse(choice(r,"Type")).data;
        if(!home||!sku||!dt||dt>observedAt.slice(0,10)||!type)continue;
        const evidence=property(r,"Evidence","url");
        const phys=formula(r,"Stock delta","number"),res=formula(r,"Reserve delta","number");
        const posted=property(r,"Posted","checkbox")===true && formula(r,"Entry valid","boolean")===true &&
          typeof evidence==="string"&&URL.canParse(evidence)&&new URL(evidence).protocol==="https:"&&Number.isSafeInteger(phys)&&Number.isSafeInteger(res);
        movements.push({ref:ref("movement",r.id),home,sku:ref("sku",sku),date:dt,type,orderRef:null,physicalDelta:posted?Number(phys):null,reserveDelta:posted?Number(res):null,receipt:posted?ref("ledger",r.id+"/"+r.last_edited_time):null});
      }
      const positions=[...new Map(movements.map(m=>[m.home+"/"+m.sku,{home:m.home,sku:m.sku,onHand:null,reserved:null,shopify:null,threshold:null,reservations:[]}])).values()];
      return qualify(inventorySnapshotSchema.parse({scope,observedAt,revision:digest(list.map(r=>[r.id,r.last_edited_time])),coverage:"partial",
        currentWindow:movements.length?"observed":null,periods:movements.length?[{window:{ref:"observed",start:movements.map(m=>m.date).sort()[0],end:observedAt.slice(0,10)},positions,movements,transfers:[]}]:[]}),binding);
    },
    async readSupport(binding:StockSupportBinding){
      requireAuthority();const scope=binding.scope;
      const list=await rows(scope,supportId),observedAt=new Date(now()).toISOString();
      const cases:SupportSnapshot["cases"]=list.map(r=>{
        const order=relation(r,"Order"),type=choice(r,"Type");
        return {id:ref("case",r.id),sourceRef:ref("support",r.id),orderRef:order?ref("order",order):null,updatedAt:r.last_edited_time,
          state:states[choice(r,"Status","status")??""]??"Unknown",category:type==="Return"||type==="Replacement"?type:z.enum(categories).safeParse(choice(r,"Category")).data??"Unknown",
          owner:"Unknown",shipmentRef:null,returnRef:null,handoffAllowed:false};
      });
      return qualify(supportSnapshotSchema.parse({scope,revision:digest(list.map(r=>[r.id,r.last_edited_time])),coverage:"partial",observedAt,cases,allTimeOpen:null,cohort:null}),binding);
    }
  };
}
