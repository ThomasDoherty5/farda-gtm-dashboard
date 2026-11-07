import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "./config.ts";
import type { OperationsScope } from "./operations.ts";
import { inventoryFilters,supportFilters,inventorySnapshotSchema,supportSnapshotSchema,nativeInventorySchema,nativeSupportSchema,transferIntent,handoffIntent,available,positionHold,policy,requestReceipt,type InventorySnapshot,type SupportSnapshot } from "./stockSupportSchema.ts";

export type StockSupportSource={
  readInventory:(scope:OperationsScope)=>Promise<InventorySnapshot>;
  readSupport:(scope:OperationsScope)=>Promise<SupportSnapshot>;
};
export class StockSupportError extends Error {
  readonly code:string;readonly status:number;readonly currentVersion?:string;
  constructor(code:string,status:number,currentVersion?:string){super(code);this.code=code;this.status=status;this.currentVersion=currentVersion;}
}
type View="inventoryOverview"|"supportWorkspace";
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,179}$/);
const common={operation:z.literal("requestApproval"),entityRefs:z.array(z.never()).max(0),approvalRef:z.null(),manifestRef:z.null(),
  runRef:z.null().optional(),expectedVersion:z.string().regex(/^ss1-[0-9a-f]{64}$/),idempotencyKey:id,
  requestedScope:z.object({workspaceId:id,accountIds:z.array(id).length(1),environment:z.literal("sandbox")}).strict(),
  schemaVersion:z.string().optional(),requestId:z.string().optional()};
const actionSchema=z.discriminatedUnion("actionKind",[
  z.object({...common,actionKind:z.literal("requestStockTransfer"),payload:transferIntent}).strict(),
  z.object({...common,actionKind:z.literal("requestSupportHandoff"),payload:handoffIntent}).strict()
]);
const fresh=(t:string,now:number)=>Date.parse(t)<=now && now-Date.parse(t)<=15*60_000;
const fail=(code:string,status:number):never=>{throw new StockSupportError(code,status);};
const scopeDigest=(s:OperationsScope)=>digest([s.workspaceId,s.accountId,s.environment]);
export function createStockSupportWorkflow(db:DatabaseSync,scope:OperationsScope,source?:StockSupportSource,now:()=>number=Date.now){
  const bound=db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
  if(bound?.workspace_id!==scope.workspaceId||bound.account_id!==scope.accountId||bound.environment!==scope.environment)fail("DATABASE_SCOPE_MISMATCH",403);
  db.exec(`CREATE TABLE IF NOT EXISTS stock_support_reviews(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, request_key TEXT UNIQUE NOT NULL, actor TEXT NOT NULL, view TEXT NOT NULL, target TEXT NOT NULL,
    request_hash TEXT NOT NULL, status TEXT NOT NULL, version TEXT NOT NULL, receipt TEXT NOT NULL,
    sku TEXT, from_home TEXT, units INTEGER, manifest TEXT);
    CREATE INDEX IF NOT EXISTS stock_support_pending_stock ON stock_support_reviews(sku,from_home,status);`);
  async function snapshot(view:View){
    if(!source)throw new StockSupportError("INTEGRATION_PENDING",503);
    const result=view==="inventoryOverview"?inventorySnapshotSchema.safeParse(await source.readInventory(scope)):supportSnapshotSchema.safeParse(await source.readSupport(scope));
    if(!result.success)throw new StockSupportError("SOURCE_RESPONSE_INVALID",502);
    if(scopeDigest(result.data.scope)!==scopeDigest(scope))throw new StockSupportError("SOURCE_SCOPE_DENIED",403);
    if(Date.parse(result.data.observedAt)>now())throw new StockSupportError("SOURCE_RESPONSE_INVALID",502);
    return result.data;
  }
  function filtersFor(view:View,filters:unknown){
    const result=(view==="inventoryOverview"?inventoryFilters:supportFilters).safeParse(filters);
    if(!result.success)throw new StockSupportError("INVALID_REQUEST",400);
    return result.data;
  }
  function version(s:InventorySnapshot|SupportSnapshot,view:View,target:string){
    const head=db.prepare("SELECT COALESCE(MAX(seq),0) n FROM stock_support_reviews WHERE view=? AND status='recorded'").get(view)?.n;
    const {observedAt,...facts}=s;
    // Observation leases may renew without changing the underlying version.
    void observedAt;
    return "ss1-"+digest([policy,facts,view,target,head]);
  }
  const targetOf=(f:z.infer<typeof inventoryFilters>|z.infer<typeof supportFilters>)=>{
    if("caseId" in f)return f.caseId;
    return digest({home:f.home??null,sku:f.sku??null,windowRef:f.windowRef??null});
  };
  function receipt(key:string,actor:string,view:View,target:string) {
    const row=db.prepare("SELECT actor,view,target,receipt FROM stock_support_reviews WHERE request_key=?").get(key);
    if(row && (row.actor!==actor||row.view!==view||row.target!==target))throw new StockSupportError("SOURCE_SCOPE_DENIED",403);
    return row?requestReceipt.parse(JSON.parse(String(row.receipt))):requestReceipt.parse({requestKey:key,actorRef:actor,state:"absent",baseVersion:null,actionRef:null,digest:null,payloadDigest:null});
  }
  function pendingReviews(view:View,f:z.infer<typeof inventoryFilters>|z.infer<typeof supportFilters>,windowRef:string|null){
    const conditions=["view=?","status='recorded'"];const values:string[]=[view];
    if("caseId" in f){conditions.push("target=?");values.push(f.caseId);}
    else{
      conditions.push("json_extract(manifest,'$.payload.windowRef')=?");values.push(windowRef??"");
      if(f.home){conditions.push("(from_home=? OR json_extract(manifest,'$.payload.to')=?)");values.push(f.home,f.home);}
      if(f.sku){conditions.push("sku=?");values.push(f.sku);}
    }
    const where=conditions.join(" AND ");
    const total=Number(db.prepare("SELECT COUNT(*) n FROM stock_support_reviews WHERE "+where).get(...values)?.n);
    const rows=db.prepare("SELECT receipt,manifest FROM stock_support_reviews WHERE "+where+" ORDER BY seq DESC LIMIT 20").all(...values).map(r=>{
      const received=requestReceipt.parse(JSON.parse(String(r.receipt)));
      const m=JSON.parse(String(r.manifest));
      return {id:received.actionRef!,kind:m.actionKind,from:m.payload.from??null,to:m.payload.to??null,sku:m.payload.sku??null,units:m.payload.units??null,reasonCode:m.payload.reasonCode};
    });
    return {total,rows};
  }
  async function read(view:View,filters:unknown,actorRef:string){
    const f=filtersFor(view,filters);
    if(f.proposalRequestKey && actorRef!=="agent-reviewer")throw new StockSupportError("SOURCE_SCOPE_DENIED",403);
    const s=await snapshot(view),target=targetOf(f),v=version(s,view,target),stale=!fresh(s.observedAt,now());
    const head={pending:pendingReviews(view,f,"periods" in s && !("caseId" in f)?f.windowRef??s.currentWindow:null),actorRef,revision:v,observedAt:s.observedAt,coverage:s.coverage,stale,reconciliation:f.proposalRequestKey?receipt(f.proposalRequestKey,actorRef,view,target):null};
    if(head.reconciliation?.state==="absent" && (stale||s.coverage!=="complete"))throw new StockSupportError(stale?"SOURCE_STALE":"SOURCE_COVERAGE_PARTIAL",409);
    if("periods" in s && !("caseId" in f)){
      const windowRef=f.windowRef??s.currentWindow;
      const period=s.periods.find(p=>p.window.ref===windowRef);
      if(f.windowRef && !period)throw new StockSupportError("RECORD_NOT_FOUND",404);
      const match=(r:{home:string;sku:string})=>(!f.home||r.home===f.home)&&(!f.sku||r.sku===f.sku);
      const skus=period?[...new Set([...period.positions,...period.movements,...period.transfers].map(r=>r.sku))].sort():[];
      const data=nativeInventorySchema.parse({...head,kind:"source-stock",selected:{...(f.home?{home:f.home}:{}),...(f.sku?{sku:f.sku}:{}),...(f.windowRef?{windowRef:f.windowRef}:{})},
        currentWindow:s.currentWindow,windows:s.periods.map(p=>p.window),skus,period:period?{window:period.window,positions:period.positions.filter(match),
          movements:period.movements.filter(match),transfers:period.transfers.filter(t=>(!f.sku||t.sku===f.sku)&&(!f.home||t.from===f.home||t.to===f.home))}:null});
      return {data,version:v,observedAt:s.observedAt,partial:s.coverage==="partial",stale,empty:!s.periods.length};
    }
    if(!("cases" in s)||!("caseId" in f))throw new StockSupportError("INVALID_REQUEST",400);
    if(f.caseId!=="queue" && !s.cases.some(c=>c.id===f.caseId))throw new StockSupportError(s.coverage==="partial"?"SOURCE_COVERAGE_PARTIAL":"RECORD_NOT_FOUND",s.coverage==="partial"?503:404);
    const data=nativeSupportSchema.parse({...head,kind:"source-support",caseId:f.caseId,cases:s.cases,allTimeOpen:s.allTimeOpen,cohort:s.cohort});
    return {data,version:v,observedAt:s.observedAt,partial:s.coverage==="partial",stale,empty:!s.cases.length&&!s.cohort&&s.allTimeOpen===null};
  }
  function ack(r:z.infer<typeof requestReceipt>){
    return {actionRef:r.actionRef!,payloadVersion:r.digest!,policyVersion:policy,receiptRefs:["proposal:"+r.actionRef],state:"approvalPending" as const};
  }
  async function propose(raw:unknown,actorRef:string){
    if(actorRef!=="agent-reviewer")throw new StockSupportError("SOURCE_SCOPE_DENIED",403);
    const parsed=actionSchema.safeParse(raw);if(!parsed.success)throw new StockSupportError("VALIDATION_FAILED",422);
    const a=parsed.data;if(a.requestedScope.workspaceId!==scope.workspaceId||a.requestedScope.accountIds[0]!==scope.accountId)throw new StockSupportError("SOURCE_SCOPE_DENIED",403);
    const transfer=a.actionKind==="requestStockTransfer"?a.payload:null;
    const view:View=transfer?"inventoryOverview":"supportWorkspace";
    const target=transfer?targetOf(transfer.scope):(a.payload as z.infer<typeof handoffIntent>).caseId;
    const requestHash=digest([scope,actorRef,a.actionKind,a.payload,a.expectedVersion]);
    const s=await snapshot(view);
    // Re-read upstream membership and coverage even on an idempotent retry.
    if("cases" in s && !s.cases.some(c=>c.id===target))throw new StockSupportError("RECORD_NOT_FOUND",404);
    if(transfer && "periods" in s && !s.periods.some(p=>p.window.ref===transfer.windowRef && p.positions.some(r=>r.sku===transfer.sku && r.home===transfer.from)))throw new StockSupportError("RECORD_NOT_FOUND",404);
    db.exec("BEGIN IMMEDIATE");
    let closed=false;
    try{
      const row=db.prepare("SELECT request_hash,version,receipt,status FROM stock_support_reviews WHERE request_key=?").get(a.idempotencyKey);
      if(row){
        if(row.request_hash!==requestHash)throw new StockSupportError("IDEMPOTENCY_CONFLICT",409);
        if(row.status==="rejected")throw new StockSupportError("STALE_VERSION",409,String(row.version));
        const result=ack(requestReceipt.parse(JSON.parse(String(row.receipt))));db.exec("COMMIT");return result;
      }
      if(!fresh(s.observedAt,now()))throw new StockSupportError("SOURCE_STALE",409);
      if(s.coverage!=="complete")throw new StockSupportError("SOURCE_COVERAGE_PARTIAL",409);
      const current=version(s,view,target);
      const save=(status:"recorded"|"rejected",id:string|null,hash:string|null,manifest:string|null)=>{
        const r=requestReceipt.parse({requestKey:a.idempotencyKey,actorRef,state:status,baseVersion:a.expectedVersion,actionRef:id,digest:hash,payloadDigest:digest(a.payload)});
        db.prepare("INSERT INTO stock_support_reviews(request_key,actor,view,target,request_hash,status,version,receipt,sku,from_home,units,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(a.idempotencyKey,actorRef,view,target,requestHash,status,current,JSON.stringify(r),transfer?.sku??null,transfer?.from??null,transfer?.units??null,manifest);
        db.exec("COMMIT");closed=true;return r;
      };
      if(current!==a.expectedVersion){save("rejected",null,null,null);throw new StockSupportError("STALE_VERSION",409,current);}
      if(transfer && "periods" in s){
        if(transfer.windowRef!==s.currentWindow || transfer.scope.windowRef && transfer.scope.windowRef!==transfer.windowRef ||
          transfer.scope.home && transfer.scope.home!==transfer.from || transfer.scope.sku && transfer.scope.sku!==transfer.sku)throw new StockSupportError("INVALID_PROPOSAL_TARGET",422);
        const p=s.periods.find(p=>p.window.ref===transfer.windowRef)!;
        const from=p.positions.find(r=>r.home===transfer.from&&r.sku===transfer.sku);
        const to=p.positions.find(r=>r.home===transfer.to&&r.sku===transfer.sku);
        const hold=positionHold(from)??positionHold(to);
        if(hold)throw new StockSupportError(hold,409);
        if(p.movements.some(m=>m.sku===transfer.sku && [transfer.from,transfer.to].includes(m.home) && !m.receipt))throw new StockSupportError("RECEIPTS_MISSING",409);
        // A local review request does not reserve units. Only J15 owns stock reservations.
        if(transfer.units>available(from!)!)throw new StockSupportError("QUOTA_OR_STOCK_HOLD",409);
      }else if("cases" in s){
        const c=s.cases.find(c=>c.id===target)!;
        if(!c.handoffAllowed || c.state==="Resolved" || c.state==="Unknown")throw new StockSupportError("CASE_HANDOFF_HELD",409);
      }else throw new StockSupportError("INVALID_REQUEST",400);
      const manifest={scope,sourceRevision:s.revision,current,actorRef,actionKind:a.actionKind,payload:a.payload,policy};
      return ack(save("recorded","review-"+randomUUID(),digest(manifest),JSON.stringify(manifest)));
    }catch(error){if(!closed)db.exec("ROLLBACK");throw error;}
  }
  return {read,propose};
}
