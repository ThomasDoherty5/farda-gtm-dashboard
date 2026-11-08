// @vitest-environment node
import { expect, it } from "vitest";
import { createOperationsReadReader } from "./reader.ts";
import { operationsRecord, operationsSnapshot, operationsTestSource, operationsReadTestScope, operationsReadTestTime } from "./fixtures.testkit.ts";
import type { NativeFulfillmentEvent } from "../../adapter/viewSchemas/nativeOperations.ts";
const required=["returnReceived","inventoryQuarantined","refundSettled","accountingPosted","caseClosed"] as const;
function record(){return {...operationsRecord("returnDetail"),state:"resolved",units:2,inspection:{receiptRef:"fictional-inspection",resellable:false,units:2},completionVerified:true,
  resolved:{chain:[{outcome:"Legacy source summary",receipt:"fictional-summary",confirmedAt:"Historical label"}],refunded:{minorUnits:4000,currency:"USD"},returnedUnits:2,restockedUnits:0,retainedUnits:1,replacement:"None",caseRef:"fictional-case"},
  nativeEvents:required.map(kind=>({kind,state:"confirmed",eventAt:"2026-11-06T11:54:00.000Z",observedAt:"2026-11-06T11:55:00.000Z",receiptRef:`fictional-${kind}`,sourceRef:"fictional-source",reasonCode:null}))};}
const read=(value:unknown)=>createOperationsReadReader({scope:operationsReadTestScope,secret:"fictional-return-reference-secret-00001",now:()=>Date.parse(operationsReadTestTime),
  source:operationsTestSource(async()=>operationsSnapshot("returnDetail",{record:value}))}).read("returnDetail",{returnId:"TEST-RET-028"},{principalRef:"agent-reader",role:"reader"});
it("verifies return closure only from each independent source milestone",async()=>{
  expect((await read(record())).data).toMatchObject({completionVerified:true,state:"resolved"});
  const legacy=record();legacy.nativeEvents=[];expect((await read(legacy)).data).toMatchObject({completionVerified:false,resolved:{refunded:{minorUnits:4000}}});
});
it.each(required)("does not infer missing %s from a free-form resolved chain or supplied true flag",async missing=>{
  const value=record();value.nativeEvents=value.nativeEvents.filter(event=>event.kind!==missing);
  expect((await read(value)).data).toMatchObject({completionVerified:false});
});
it("refuses impossible return quantities instead of displaying source success",async()=>{
  const value=record();value.resolved.restockedUnits=3;await expect(read(value)).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID"});
});
it("requires the replacement's independent shipment receipt before verifying closure",async()=>{
  const value={...record(),selected:{disposition:"quarantine",resolution:"replacement",reason:"Source-qualified replacement"}};
  value.resolved.refunded.minorUnits=0;
  const nativeEvents:NativeFulfillmentEvent[]=[...value.nativeEvents.filter(event=>event.kind!=="refundSettled"),
    {...value.nativeEvents[0]!,kind:"replacementCreated",state:"confirmed"}];
  expect((await read({...value,nativeEvents})).data).toMatchObject({completionVerified:false});
  nativeEvents.push({...nativeEvents[0]!,kind:"replacementShipped",receiptRef:"fictional-replacement-shipped"});
  expect((await read({...value,nativeEvents})).data).toMatchObject({completionVerified:true});
});
