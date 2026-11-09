import { z } from "zod";

const ref=z.string().trim().min(1).max(4096),instant=z.string().datetime({offset:true});
const home=z.enum(["H1","H2","H3"]),count=z.number().int().nonnegative().safe();
export const operationsTimezoneSchema=z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}},"Use a recognized timezone.");
export const operationsReportingScopeSchema=z.object({home:z.union([home,z.literal("all")]),startAt:instant,endAt:instant,
  timezone:operationsTimezoneSchema,basis:z.enum(["requestedAt","eventAt"])}).strict().refine(value=>Date.parse(value.startAt)<Date.parse(value.endAt),"A reporting window must be ordered.");
export const dispatchSourceFactsSchema=z.object({
  requestedAt:instant,orderRef:ref.nullable(),sampleRef:ref.nullable(),shipmentRef:ref.nullable(),detailRef:ref.nullable(),
  orderUnfulfilled:z.boolean().nullable(),sampleApproved:z.boolean().nullable(),labelCreated:z.boolean().nullable(),canceled:z.boolean().nullable(),
  identityResolved:z.boolean().nullable(),stockAvailable:z.boolean().nullable(),evidenceRef:ref,observedAt:instant,
}).strict();
export const nativeFulfillmentEventSchema=z.object({
  kind:z.enum(["orderPaid","labelCreated","carrierAccepted","shipped","delivered","carrierLost","carrierReturned","returnAuthorized","returnReceived","returnInspected","refundSettled","replacementCreated","replacementShipped","inventoryRestocked","inventoryQuarantined","accountingPosted","caseClosed"]),
  state:z.enum(["confirmed","pending","failed","unknown"]),eventAt:instant.nullable(),observedAt:instant,
  receiptRef:ref.nullable(),sourceRef:ref.nullable(),reasonCode:ref.nullable(),
}).strict().superRefine((value,ctx)=>{
  if(value.state==="confirmed"&&(!value.eventAt||!value.receiptRef||!value.sourceRef))ctx.addIssue({code:"custom",message:"A confirmed milestone requires its own source receipt and event time."});
  if(value.eventAt&&Date.parse(value.eventAt)>Date.parse(value.observedAt))ctx.addIssue({code:"custom",message:"An event cannot follow its observation."});
});
export const nativeOperationsLinkSchema=z.object({kind:z.enum(["order","shipment","return","sample","approval","support"]),targetRef:ref,
  state:z.enum(["verified","missing","expired","denied"]),url:z.string().url().nullable(),observedAt:instant.nullable(),validUntil:instant.nullable()}).strict();
export const nativeOperationsExtensions={reportingScope:operationsReportingScopeSchema.nullable().default(null),
  nativeEvents:z.array(nativeFulfillmentEventSchema).max(100).default([]),sourceLinks:z.array(nativeOperationsLinkSchema).max(30).default([])};
export const nativeStockSummarySchema=z.object({home,onHand:count.nullable(),reserved:count.nullable(),capacity:count.nullable(),threshold:count.nullable()}).strict();
export const nativeQueueSourceSchema=dispatchSourceFactsSchema.nullable().default(null);
// These references are accepted by the existing order/sample and exception read routes.
// A hub destination filters its existing shipment list; it does not confer drawer or dispatch authority.
const routeRef=z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const nativeOperationsShipmentSchema=z.object({
  ref:routeRef,orderRef:routeRef.nullable(),sampleRef:routeRef.nullable(),home,requestedAt:instant,eventAt:instant.nullable(),
  carrierState:z.enum(["labelCreated","inTransit","outForDelivery","deliveredUnconfirmed","delivered","lost","returned"]),lastScan:z.string().nullable(),
  shipmentDetail:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("exception"),shipmentRef:routeRef,exceptionRef:routeRef}).strict(),
    z.object({kind:z.literal("hub"),shipmentRef:routeRef}).strict(),
  ]).nullable(),
  originDetail:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("order"),ref:routeRef}).strict(),
    z.object({kind:z.literal("sample"),ref:routeRef}).strict(),
  ]).nullable(),
}).strict().superRefine((value,ctx)=>{
  if(value.orderRef===null&&value.sampleRef===null)ctx.addIssue({code:"custom",message:"A shipment requires its canonical order or standalone sample identity."});
  if(value.shipmentDetail&&value.shipmentDetail.shipmentRef!==value.ref)ctx.addIssue({code:"custom",path:["shipmentDetail"],message:"A shipment drilldown must name this exact shipment."});
  if(value.originDetail&&value.originDetail.ref!==(value.originDetail.kind==="order"?value.orderRef:value.sampleRef))ctx.addIssue({code:"custom",path:["originDetail"],message:"An origin drilldown must name this exact order or sample."});
});
export type OperationsReportingScope=z.infer<typeof operationsReportingScopeSchema>;
export type DispatchSourceFacts=z.infer<typeof dispatchSourceFactsSchema>;
export type NativeFulfillmentEvent=z.infer<typeof nativeFulfillmentEventSchema>;
export type NativeOperationsLink=z.infer<typeof nativeOperationsLinkSchema>;
export type NativeOperationsShipment=z.infer<typeof nativeOperationsShipmentSchema>;
