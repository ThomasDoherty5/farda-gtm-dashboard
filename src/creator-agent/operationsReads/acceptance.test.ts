// @vitest-environment node
import { expect,it } from "vitest";
import { createOperationsReadReader } from "./reader.ts";
import { operationsReadFilters } from "./contract.ts";
import { operationsReadTestScope,operationsReadTestTime,operationsRecord,operationsSnapshot,operationsTestSource } from "./fixtures.testkit.ts";
import { nativeFulfillmentEventSchema,operationsReportingScopeSchema,type DispatchSourceFacts } from "../../adapter/viewSchemas/nativeOperations.ts";

// Fictional source evidence only. These tests do not establish provider readiness or permit fulfillment effects.
const observedAt="2026-11-06T11:55:00.000Z",principal={principalRef:"agent-reader",role:"reader" as const};
const filters={home:"H1" as const,startAt:"2026-11-05T00:00:00.000Z",endAt:"2026-11-06T11:00:00.000Z",timezone:"America/Los_Angeles"};
const row=(ref:string,requestedAt:string,patch:Partial<DispatchSourceFacts>={})=>({ref,kind:"order" as "order"|"sample",home:"H1",waitingHours:999,units:1,hold:null,
  sourceFacts:{requestedAt,orderRef:ref,sampleRef:null,shipmentRef:null,detailRef:ref,orderUnfulfilled:true,sampleApproved:null,labelCreated:false,canceled:false,
    identityResolved:true,stockAvailable:true,evidenceRef:"fictional-source-eligibility",observedAt,...patch} satisfies DispatchSourceFacts});
const overview=()=>({...operationsRecord("operationsOverview"),reportingScope:{...filters,basis:"requestedAt" as const},queue:{rows:[row("fictional-order",filters.startAt)],total:1}});
function reader(record:Record<string,unknown>,clock=()=>Date.parse(operationsReadTestTime)) {
  const calls:unknown[]=[];
  const source=operationsTestSource(async(_scope,request)=>{calls.push(request);return operationsSnapshot("operationsOverview",{record});});
  return {calls,service:createOperationsReadReader({scope:operationsReadTestScope,secret:"fictional-operations-acceptance-key-at-least-32",source,now:clock,permittedLinkOrigins:["https://source.example.test"]})};
}
type QueueData={queue:{rows:{ref:string;waitingHours:number;hold:{reason:string}|null}[]};stock:{onHand:number|null;reserved:number|null}[]};

it("binds the exact home and reporting period and sorts oldest first with deterministic ties",async()=>{
  const record=overview();record.queue={rows:[row("order-b","2026-11-05T03:00:00.000Z"),row("order-a","2026-11-05T03:00:00.000Z"),row("order-c",filters.startAt)],total:3};
  const w=reader(record),result=await w.service.read("operationsOverview",filters,principal),data=result.data as QueueData;
  expect(w.calls).toEqual([{viewKey:"operationsOverview",filters}]);
  expect(data.queue.rows.map(r=>r.ref)).toEqual(["order-c","order-a","order-b"]);
  expect(data.queue.rows[0]?.waitingHours).toBe((Date.parse(observedAt)-Date.parse(filters.startAt))/3600000);
  expect(data.queue.rows.every(r=>r.hold===null)).toBe(true);
});
it.each(["home","startAt","endAt","timezone"] as const)("rejects a source reporting scope with a different %s",async key=>{
  const record=overview(),values={home:"H2",startAt:"2026-11-04T00:00:00.000Z",endAt:"2026-11-06T10:00:00.000Z",timezone:"UTC"};
  const mismatched={...record,reportingScope:{...record.reportingScope,[key]:values[key]}};
  await expect(reader(mismatched).service.read("operationsOverview",filters,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_REPORTING_SCOPE_MISMATCH"]});
});
it("requires a valid complete timezone/window and a requestedAt queue basis",async()=>{
  for(const input of [{...filters,timezone:"Not/A_Timezone"},{home:"H1",startAt:filters.startAt},{...filters,endAt:filters.startAt}])
    expect(operationsReadFilters.operationsOverview.safeParse(input).success).toBe(false);
  expect(operationsReportingScopeSchema.safeParse({...filters,basis:"requestedAt",timezone:"Not/A_Timezone"}).success).toBe(false);
  const record=overview();await expect(reader({...record,reportingScope:{...record.reportingScope,basis:"eventAt"}}).service.read("operationsOverview",filters,principal)).rejects.toMatchObject({status:502});
});
it("uses a half-open period and rejects rows from another home",async()=>{
  for(const requestedAt of ["2026-11-04T23:59:59.999Z",filters.endAt]){
    const record=overview();record.queue.rows=[row("fictional-order",requestedAt)];
    await expect(reader(record).service.read("operationsOverview",filters,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_QUEUE_PERIOD_MISMATCH"]});
  }
  const record=overview();record.queue.rows[0]!.home="H2";
  await expect(reader(record).service.read("operationsOverview",filters,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_QUEUE_HOME_MISMATCH"]});
});
it.each([{canceled:true},{labelCreated:true},{identityResolved:null},{stockAvailable:null},{orderUnfulfilled:false},{detailRef:"another-order"}] satisfies Partial<DispatchSourceFacts>[])("holds ineligible or unknown source facts %j",async facts=>{
  const record=overview();record.queue.rows=[row("fictional-order",filters.startAt,facts)];
  const result=await reader(record).service.read("operationsOverview",filters,principal);expect((result.data as QueueData).queue.rows[0]?.hold).not.toBeNull();
});
it("requires sample approval independently of order status",async()=>{
  const record=overview(),sample=row("fictional-sample",filters.startAt,{orderRef:null,sampleRef:"fictional-sample",orderUnfulfilled:null,sampleApproved:false});sample.kind="sample";record.queue.rows=[sample];
  expect(((await reader(record).service.read("operationsOverview",filters,principal)).data as QueueData).queue.rows[0]?.hold).not.toBeNull();
  sample.sourceFacts.sampleApproved=true;
  expect(((await reader(record).service.read("operationsOverview",filters,principal)).data as QueueData).queue.rows[0]?.hold).toBeNull();
});
it("does not turn missing eligibility or stock observations into a known zero",async()=>{
  const record=overview(),withoutFacts={...record,reportingScope:null,queue:{rows:[{...record.queue.rows[0]!,sourceFacts:null}],total:1},stock:[{home:"H1",onHand:null,reserved:0,capacity:null,threshold:null}]};
  const result=await reader(withoutFacts).service.read("operationsOverview",{},principal),data=result.data as QueueData;
  expect(data.queue.rows[0]?.hold).toMatchObject({reason:"Dispatch eligibility is unknown"});expect(data.stock[0]).toMatchObject({onHand:null,reserved:0});
  await expect(reader({...withoutFacts,reportingScope:record.reportingScope}).service.read("operationsOverview",filters,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_QUEUE_PERIOD_UNVERIFIED"]});
});
it("requires a separate authoritative receipt and time for each confirmed event",()=>{
  const event={kind:"refundSettled",state:"confirmed",eventAt:"2026-11-06T11:00:00.000Z",observedAt,receiptRef:"fictional-refund-receipt",sourceRef:"fictional-refund-source",reasonCode:null};
  expect(nativeFulfillmentEventSchema.safeParse(event).success).toBe(true);
  for(const patch of [{receiptRef:null},{sourceRef:null},{eventAt:null},{eventAt:"2026-11-06T12:00:00.000Z"}])expect(nativeFulfillmentEventSchema.safeParse({...event,...patch}).success).toBe(false);
});
it.each(["returnAuthorized","returnInspected","carrierLost","carrierReturned"] as const)("projects source-confirmed %s only with its own valid receipt and observation",async kind=>{
  const event={kind,state:"confirmed",eventAt:"2026-11-06T11:00:00.000Z",observedAt,receiptRef:`fictional-${kind}-receipt`,sourceRef:`fictional-${kind}-source`,reasonCode:null};
  const result=await reader({...overview(),nativeEvents:[event]}).service.read("operationsOverview",filters,principal);
  expect(result.data).toMatchObject({nativeEvents:[event]});result.assertCurrent();
  for(const patch of [{receiptRef:null},{sourceRef:null},{eventAt:null},{eventAt:"2026-11-06T11:55:00.001Z"}]){
    await expect(reader({...overview(),nativeEvents:[{...event,...patch}]}).service.read("operationsOverview",filters,principal))
      .rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID",status:502,reasonCodes:["OPERATIONS_RECORD_INVALID"]});
  }
  await expect(reader({...overview(),nativeEvents:[{...event,observedAt:"2026-11-06T11:55:00.001Z"}]}).service.read("operationsOverview",filters,principal))
    .rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID",status:502,reasonCodes:["OPERATIONS_EVENT_TIME_INVALID"]});
});
it("withholds every synthetic source URL, including an allowlisted origin",async()=>{
  const record={...overview(),sourceLinks:[{kind:"order",targetRef:"fictional-order",state:"verified",url:"https://source.example.test/orders/fictional-order",observedAt,validUntil:"2026-11-06T12:05:00.000Z"}]};
  const result=await reader(record).service.read("operationsOverview",filters,principal);
  expect((result.data as {sourceLinks:{url:string|null}[]}).sourceLinks[0]?.url).toBeNull();
});
it("does not publish a claimed source URL after its shorter grant expires",async()=>{
  // Adversarial non-synthetic claim, not proof of a real connection: its lease must fail closed regardless of its label.
  let now=Date.parse(operationsReadTestTime);const base=overview(),record={...base,synthetic:false,provenance:{...(operationsRecord("operationsOverview").provenance as object),evidenceStage:"source"},
    sourceLinks:[{kind:"order",targetRef:"fictional-order",state:"verified",url:"https://source.example.test/orders/fictional-order",observedAt,validUntil:"2026-11-06T12:00:01.000Z"}]};
  const result=await reader(record,()=>now).service.read("operationsOverview",filters,principal);now+=1000;
  expect(()=>result.assertCurrent()).toThrow();
});
it("also refuses a URL that expires during projection before the enclosing result is marked stale",async()=>{
  let ticks=0;const now=Date.parse(operationsReadTestTime),record={...overview(),synthetic:false,
    provenance:{...(operationsRecord("operationsOverview").provenance as object),evidenceStage:"source"},
    sourceLinks:[{kind:"order",targetRef:"fictional-order",state:"verified",url:"https://source.example.test/orders/fictional-order",observedAt,validUntil:"2026-11-06T12:00:01.000Z"}]};
  // Observation + source fence + two link-time checks see the grant. Projection's final clock crosses its boundary.
  await expect(reader(record,()=>++ticks>=5?now+1000:now).service.read("operationsOverview",filters,principal)).rejects.toMatchObject({status:409});
});
it.each(["http://source.example.test/orders/x","https://foreign.example.test/orders/x","https://user:secret@source.example.test/orders/x","https://source.example.test/orders/x?token=fictional","https://source.example.test/orders/x#private"])("withholds an unqualified source link endpoint %s",async url=>{
  const record={...overview(),synthetic:false,provenance:{...(operationsRecord("operationsOverview").provenance as object),evidenceStage:"source"},
    sourceLinks:[{kind:"order",targetRef:"fictional-order",state:"verified",url,observedAt,validUntil:"2026-11-06T12:05:00.000Z"}]};
  const result=await reader(record).service.read("operationsOverview",filters,principal);
  expect((result.data as {sourceLinks:{url:string|null;state:string}[]}).sourceLinks[0]).toMatchObject({url:null,state:"denied"});
});
