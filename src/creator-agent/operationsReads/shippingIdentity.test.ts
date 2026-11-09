// @vitest-environment node
import { expect, it } from "vitest";
import { nativeOperationsShipmentSchema, type NativeOperationsShipment } from "../../adapter/viewSchemas/nativeOperations.ts";
import { nativeOpsReadViewSchemas, operationsShippingSchema } from "../../adapter/viewSchemas/ops.ts";
import { createOperationsReadReader } from "./reader.ts";
import { operationsReadFilters, type OperationsReadViewKey } from "./contract.ts";
import { nativeOrderRecord, operationsRecord, operationsSnapshot, operationsTestSource, operationsReadTestScope, operationsReadTestTime } from "./fixtures.testkit.ts";

// Fictional native-source contracts only: no provider connection, shipment or customer authority is established.
const scope={home:"H1" as const,startAt:"2026-11-01T00:00:00.000Z",endAt:"2026-11-07T00:00:00.000Z",timezone:"UTC"};
const principal={principalRef:"agent-reader",role:"reader" as const};
function shipment(patch:Partial<NativeOperationsShipment>={}):NativeOperationsShipment {
  return {ref:"fictional-shipment",orderRef:"fictional-order",sampleRef:null,home:"H1",requestedAt:"2026-11-04T12:00:00.000Z",eventAt:"2026-11-06T11:00:00.000Z",
    carrierState:"lost",lastScan:null,shipmentDetail:{kind:"exception",shipmentRef:"fictional-shipment",exceptionRef:"fictional-exception"},originDetail:{kind:"order",ref:"fictional-order"},...patch};
}
function record(rows=[shipment()]) {
  return {...operationsRecord("operationsShipping"),reportingScope:{...scope,basis:"requestedAt" as const},shipments:rows};
}
function service(value:unknown,viewKey:OperationsReadViewKey="operationsShipping") {
  const requests:unknown[]=[];
  const source=operationsTestSource(async(_scope,request)=>{requests.push(request);return operationsSnapshot(viewKey,{record:value});});
  return {requests,reader:createOperationsReadReader({scope:operationsReadTestScope,secret:"fictional-shipping-contract-secret-at-least-32",source,now:()=>Date.parse(operationsReadTestTime)})};
}
it("keeps commerce orders, standalone samples and canonical shipment drilldowns distinct",async()=>{
  const sample=shipment({ref:"fictional-sample-shipment",orderRef:null,sampleRef:"fictional-allocation",carrierState:"inTransit",
    shipmentDetail:{kind:"hub",shipmentRef:"fictional-sample-shipment"},originDetail:{kind:"sample",ref:"fictional-allocation"}});
  const w=service(record([shipment(),sample])),result=await w.reader.read("operationsShipping",scope,principal);
  expect(w.requests).toEqual([{viewKey:"operationsShipping",filters:scope}]);
  expect(result.data).toMatchObject({datasetKey:"operations-native",synthetic:true,shipments:[
    {ref:"fictional-shipment",orderRef:"fictional-order",sampleRef:null,shipmentDetail:{kind:"exception",shipmentRef:"fictional-shipment",exceptionRef:"fictional-exception"}},
    {ref:"fictional-sample-shipment",orderRef:null,sampleRef:"fictional-allocation",shipmentDetail:{kind:"hub",shipmentRef:"fictional-sample-shipment"},originDetail:{kind:"sample",ref:"fictional-allocation"}},
  ]});
  result.assertCurrent();
});
it("does not fabricate a missing drilldown from the displayed reference",async()=>{
  const result=await service(record([shipment({shipmentDetail:null,originDetail:null})])).reader.read("operationsShipping",scope,principal);
  expect(result.data).toMatchObject({shipments:[{shipmentDetail:null,originDetail:null}]});
});
it.each([
  {shipmentDetail:{kind:"exception",shipmentRef:"another-shipment",exceptionRef:"fictional-exception"}},
  {shipmentDetail:{kind:"hub",shipmentRef:"another-shipment"}},
  {originDetail:{kind:"order",ref:"another-order"}},
  {originDetail:{kind:"sample",ref:"fictional-order"}},
  {orderRef:null,sampleRef:null},
  {shipmentDetail:{kind:"external",url:"https://source.example.test/shipment"}},
  {shipmentDetail:{kind:"hub",shipmentRef:"fictional-shipment",url:"https://source.example.test/shipment"}},
  {originDetail:{kind:"order",ref:"javascript:alert(1)"}},
])("rejects cross-record or unsupported routing material %j",async patch=>{
  const value={...shipment(),...patch};
  expect(nativeOperationsShipmentSchema.safeParse(value).success).toBe(false);
  await expect(service({...record(),shipments:[value]}).reader.read("operationsShipping",scope,principal)).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID",status:502});
});
it("rejects duplicate shipment identities without merging their origins or carrier states",async()=>{
  await expect(service(record([shipment(),shipment({carrierState:"delivered"})])).reader.read("operationsShipping",scope,principal)).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID"});
});
it("retains strict native/demo row isolation",()=>{
  const demo={datasetKey:"operations-shipping-demo",shipments:[{ref:"demo-shipment",orderRef:"demo-order",carrierState:"inTransit",lastScan:null}],exceptions:[],chain:[]};
  expect(operationsShippingSchema.safeParse(demo).success).toBe(true);
  expect(nativeOpsReadViewSchemas.operationsShipping!.safeParse({...record(),shipments:demo.shipments}).success).toBe(false);
  expect(nativeOpsReadViewSchemas.operationsShipping!.safeParse({...record(),datasetKey:demo.datasetKey}).success).toBe(false);
  const sample=shipment({orderRef:null,sampleRef:"fictional-sample",originDetail:{kind:"sample",ref:"fictional-sample"}});
  expect(operationsShippingSchema.safeParse({...demo,shipments:[sample]}).success).toBe(false);
});
it("binds each shipment to its home and the exact half-open reporting cohort",async()=>{
  await expect(service(record([shipment({home:"H2"})])).reader.read("operationsShipping",scope,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_SHIPMENT_HOME_MISMATCH"]});
  const historicalScope={...scope,endAt:"2026-11-06T10:00:00.000Z"};
  for(const requestedAt of ["2026-10-31T23:59:59.999Z",historicalScope.endAt]) {
    const value={...record([shipment({requestedAt})]),reportingScope:{...historicalScope,basis:"requestedAt"}};
    await expect(service(value).reader.read("operationsShipping",historicalScope,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_SHIPMENT_PERIOD_MISMATCH"]});
  }
  const eventRecord={...record([shipment({requestedAt:"2026-10-30T00:00:00.000Z"})]),reportingScope:{...scope,basis:"eventAt"}};
  expect((await service(eventRecord).reader.read("operationsShipping",scope,principal)).data).toMatchObject({shipments:[{requestedAt:"2026-10-30T00:00:00.000Z"}]});
  await expect(service({...eventRecord,shipments:[shipment({eventAt:null})]}).reader.read("operationsShipping",scope,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_SHIPMENT_PERIOD_MISMATCH"]});
  await expect(service(record([shipment({eventAt:"2026-11-06T12:01:00.000Z"})])).reader.read("operationsShipping",scope,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_SHIPMENT_TIME_INVALID"]});
});
it("uses the existing shared sample detail without manufacturing a commerce order or money",async()=>{
  const sample={...nativeOrderRecord("fictional-allocation"),kind:"sample",total:{state:"notApplicable",value:null,reasonCode:"SAMPLE_HAS_NO_REVENUE",evidenceRefs:[],sourceRef:null,occurredAt:null,sourceUpdatedAt:"2026-11-06T11:55:00.000Z",observedAt:"2026-11-06T11:55:00.000Z"}};
  const value={...sample,refunded:{...sample.total,reasonCode:"SAMPLE_HAS_NO_REFUND"}};
  expect((await service(value,"orderDetail").reader.read("orderDetail",{orderId:"fictional-allocation"},principal)).data).toMatchObject({kind:"sample",orderRef:"fictional-allocation",total:{state:"notApplicable",value:null},refunded:{state:"notApplicable",value:null}});
  await expect(service(value,"orderDetail").reader.read("orderDetail",{orderId:"another-allocation"},principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_RECORD_ADDRESS_MISMATCH"]});
});
it("accepts the exact health home/window and refuses a different source scope",async()=>{
  const value={...operationsRecord("opsHealth"),reportingScope:{...scope,basis:"eventAt"}};
  const w=service(value,"opsHealth");
  expect((await w.reader.read("opsHealth",scope,principal)).data).toMatchObject({reportingScope:{...scope,basis:"eventAt"}});
  expect(w.requests).toEqual([{viewKey:"opsHealth",filters:scope}]);
  await expect(service({...value,reportingScope:{...value.reportingScope,home:"H2"}},"opsHealth").reader.read("opsHealth",scope,principal)).rejects.toMatchObject({reasonCodes:["OPERATIONS_REPORTING_SCOPE_MISMATCH"]});
  expect(operationsReadFilters.opsHealth.safeParse({home:"H1",startAt:scope.startAt}).success).toBe(false);
});
