import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,179}$/);
const day = z.string().date();
const instant = z.string().datetime({offset:true}).refine(v=>Number.isFinite(Date.parse(v)));
const count = z.number().int().nonnegative().safe();
const quantity = count.nullable();
export const stockHome = z.enum(["H1","H2","H3"]);
const scope = z.object({workspaceId:id,accountId:id,environment:z.literal("sandbox")}).strict();
const base = {scope, revision:id, observedAt:instant, coverage:z.enum(["complete","partial"])};
const capture = z.object({units:count,receipt:id}).strict().nullable();
const windowSchema = z.object({ref:id,start:day,end:day}).strict().refine(w=>w.start<=w.end);
const position = z.object({home:stockHome,sku:id,onHand:capture,reserved:capture,shopify:capture,threshold:quantity,
  reservations:z.array(z.object({ref:id,orderRef:id,kind:z.enum(["order","sample","replacement"]),units:count}).strict()).max(1000)}).strict()
  .superRefine((p,c)=>{
    if(new Set(p.reservations.map(r=>r.ref)).size!==p.reservations.length ||
      (p.reserved && p.reservations.reduce((sum,r)=>sum+r.units,0)!==p.reserved.units))
      c.addIssue({code:"custom",message:"Active reservation identities and total disagree."});
  });
const movement = z.object({ref:id,home:stockHome,sku:id,date:day,type:z.enum(["Receipt","Customer shipment","Creator shipment","Return to stock","Write-off","Reserve","Release reserve","Transfer out","Transfer in"]),
  orderRef:id.nullable(),physicalDelta:z.number().int().safe().nullable(),reserveDelta:z.number().int().safe().nullable(),receipt:id.nullable()}).strict()
  .refine(m=>m.receipt!==null || (m.physicalDelta===null && m.reserveDelta===null),"Unreceipted movement cannot affect stock.")
  .refine(m=>!["Reserve","Release reserve"].includes(m.type) || m.physicalDelta===0 || m.physicalDelta===null,"A reservation cannot deplete physical stock.");
const transfer = z.object({ref:id,sku:id,from:stockHome,to:stockHome,units:count.positive(),expectedBy:day.nullable(),dispatchReceipt:id.nullable(),received:capture}).strict().refine(t=>t.from!==t.to && (!t.received||!!t.dispatchReceipt));
const periodStock=z.object({window:windowSchema,positions:z.array(position).max(300),movements:z.array(movement).max(2000),transfers:z.array(transfer).max(300)}).strict()
  .superRefine((p,c)=>{
    if(new Set(p.positions.map(x=>x.home+"/"+x.sku)).size!==p.positions.length || new Set(p.movements.map(x=>x.ref)).size!==p.movements.length ||
       new Set(p.transfers.map(x=>x.ref)).size!==p.transfers.length || p.movements.some(m=>m.date<p.window.start || m.date>p.window.end))
      c.addIssue({code:"custom",message:"Invalid or ambiguous stock identity or period."});
    // Nonnegative known counts must remain exactly representable together. Null observations stay unknown.
    for(const field of ["onHand","reserved"] as const) {
      const total=p.positions.reduce((sum,row)=>sum+(row[field]?.units??0),0);
      if(!Number.isSafeInteger(total))c.addIssue({code:"custom",path:["positions"],message:"Stock aggregate exceeds the exact integer range."});
    }
  });
export const inventorySnapshotSchema=z.object({...base,currentWindow:id.nullable(),periods:z.array(periodStock).max(36)}).strict()
  .refine(s=>new Set(s.periods.map(p=>p.window.ref)).size===s.periods.length && (s.currentWindow===null?s.periods.length===0:s.periods.some(p=>p.window.ref===s.currentWindow)));
const supportCase=z.object({id,orderRef:id.nullable(),sourceRef:id,updatedAt:instant,state:z.enum(["Open","Waiting","In review","Resolved","Unknown"]),
  category:z.enum(["Pairing","App","Hardware defect","Shipping","Other","Return","Replacement","Unknown"]),
  owner:z.enum(["Operations","Support","Fin","Unassigned","Unknown"]),shipmentRef:id.nullable(),returnRef:id.nullable(),handoffAllowed:z.boolean()}).strict();
const cohortSchema=z.object({start:day,end:day,timezone:z.string().min(1).max(100),receipt:id,open:quantity,tickets:z.object({setup:count,shipping:count,returns:count,hardware:count}).strict().nullable(),
  firstContact:quantity,returns:quantity,delivered:quantity,refundedOrders:quantity,replacements:quantity}).strict().superRefine((s,c)=>{
    if(Date.parse(s.end)-Date.parse(s.start)!==13*86400000)c.addIssue({code:"custom",message:"The support cohort must span 14 inclusive calendar dates."});
    try{new Intl.DateTimeFormat("en",{timeZone:s.timezone});}catch{c.addIssue({code:"custom",message:"Invalid cohort timezone."});}
    if(s.tickets){const n=Object.values(s.tickets).reduce((a,b)=>a+b,0);
      if(!Number.isSafeInteger(n))c.addIssue({code:"custom",path:["tickets"],message:"Ticket aggregate exceeds the exact integer range."});
      if((s.firstContact??0)>n||(s.open??0)>n)c.addIssue({code:"custom",message:"Cohort numerator exceeds ticket count."});}
    if(s.delivered!==null && (s.returns??0)>s.delivered)c.addIssue({code:"custom",message:"Return units exceed cohort deliveries."});
  });
export const supportSnapshotSchema=z.object({...base,cases:z.array(supportCase).max(1000),allTimeOpen:quantity,cohort:cohortSchema.nullable()}).strict()
  .refine(s=>new Set(s.cases.map(c=>c.id)).size===s.cases.length && s.cases.every(c=>Date.parse(c.updatedAt)<=Date.parse(s.observedAt)),"Ambiguous case or future case update.");
export type InventorySnapshot=z.infer<typeof inventorySnapshotSchema>;
export type SupportSnapshot=z.infer<typeof supportSnapshotSchema>;
export const inventoryFilters=z.object({home:stockHome.optional(),sku:id.optional(),windowRef:id.optional(),proposalRequestKey:id.optional()}).strict();
export const supportFilters=z.object({caseId:id,proposalRequestKey:id.optional()}).strict();
export const transferIntent=z.object({scope:inventoryFilters.omit({proposalRequestKey:true}),sku:id,windowRef:id,from:stockHome,to:stockHome,units:count.positive(),
  reasonCode:z.enum(["low-stock","order-shortage","sample-shortage","rebalance"])}).strict().refine(i=>i.from!==i.to);
export const handoffIntent=z.object({caseId:id,reasonCode:z.enum(["assignment","return-review","replacement-review","refund-review"])}).strict();
export const policy="stock-support-review.v1";
export const requestReceipt=z.object({requestKey:id,actorRef:id,state:z.enum(["recorded","absent","rejected"]),baseVersion:id.nullable(),actionRef:id.nullable(),
  digest:z.string().regex(/^[0-9a-f]{64}$/).nullable(),payloadDigest:z.string().regex(/^[0-9a-f]{64}$/).nullable()}).strict();
const pendingReview=z.object({id,kind:z.enum(["requestStockTransfer","requestSupportHandoff"]),from:stockHome.nullable(),to:stockHome.nullable(),sku:id.nullable(),units:quantity,reasonCode:id}).strict();
const viewHead={readAccess:z.object({validUntil:instant}).strict().nullable().optional(),pending:z.object({total:count,rows:z.array(pendingReview).max(20)}).strict(),actorRef:id,revision:id,observedAt:instant,coverage:z.enum(["complete","partial"]),stale:z.boolean(),reconciliation:requestReceipt.nullable()};
export const nativeInventorySchema=z.object({...viewHead,kind:z.literal("source-stock"),selected:inventoryFilters.omit({proposalRequestKey:true}),
  currentWindow:id.nullable(),windows:z.array(windowSchema),skus:z.array(id),period:periodStock.nullable()}).strict();
export const nativeSupportSchema=z.object({...viewHead,kind:z.literal("source-support"),caseId:id,cases:z.array(supportCase),allTimeOpen:quantity,cohort:cohortSchema.nullable()}).strict();
export type NativeStock=z.infer<typeof nativeInventorySchema>;
export type NativeSupport=z.infer<typeof nativeSupportSchema>;
export type StockIntent=z.infer<typeof transferIntent>|z.infer<typeof handoffIntent>;
export function available(p:InventorySnapshot["periods"][number]["positions"][number]) {return p.onHand && p.reserved?p.onHand.units-p.reserved.units:null;}
export function positionHold(p:InventorySnapshot["periods"][number]["positions"][number]|undefined) {
  if(!p || !p.onHand || !p.reserved || !p.shopify)return "STOCK_BASIS_UNKNOWN";
  if(p.shopify.units!==p.onHand.units || p.reserved.units>p.onHand.units)return "STOCK_CONFLICT";
  return null;
}
