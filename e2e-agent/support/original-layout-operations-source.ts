import { operationsSnapshot } from "../../src/creator-agent/operationsReads/fixtures.testkit.ts";
import type { OperationsReadViewKey } from "../../src/creator-agent/operationsReads/contract.ts";
import { SYNTHETIC_SCOPE } from "../../src/creator-agent/testFixtures.ts";
// Independently authored fictional source facts for original-layout comparisons. No provider authority.
const observedAt = "2026-11-06T11:55:00.000Z";
const known = (value: unknown) => ({ state: "known", value, reasonCode: null, evidenceRefs: ["LAYOUT-EVIDENCE"],
  sourceRef: { source: "synthetic-layout", accountId: SYNTHETIC_SCOPE.accountIds[0]!, sourceId: "LAYOUT-SOURCE", canonicalId: null, url: null, identityState: "unresolved", provenanceRef: "LAYOUT-EVIDENCE" },
  occurredAt: observedAt, sourceUpdatedAt: observedAt, observedAt });
const money = (minorUnits: number) => ({ minorUnits, currency: "USD" });
const event = (kind: string, index: number) => ({ kind, state: "confirmed", eventAt: `2026-11-06T11:${String(40 + index).padStart(2,"0")}:00.000Z`, observedAt, receiptRef: `TEST-RC-${index}`, sourceRef: `TEST-SRC-${index}`, reasonCode: null });
const summary = (toShip: number, shipped: number, overdue: number) => ({ toShip: known(toShip), shippedToday: known(shipped), waitingOverTwoDays: known(overdue), timeToShipDays: known(1.2) });
const homes = [{ home: "H1", onHand: 100, reserved: 14, capacity: 120, threshold: 20 }, { home: "H2", onHand: 28, reserved: 10, capacity: 120, threshold: 20 }, { home: "H3", onHand: 68, reserved: 4, capacity: 120, threshold: 20 }];
export function originalLayoutOperationsSource(viewKey: OperationsReadViewKey, filters: Record<string, unknown>, resolved: boolean) {
  const snapshot = operationsSnapshot(viewKey), r = snapshot.record;
  const home = ["H1","H2","H3"].includes(String(filters.home)) ? String(filters.home) : "all";
  if (["operationsOverview","operationsShipping","fulfillmentAnalytics","opsHealth"].includes(viewKey)) r.reportingScope = { home, startAt: "2026-11-01T00:00:00.000Z", endAt: "2026-11-07T00:00:00.000Z", timezone: "UTC", basis: "requestedAt" };
  if (viewKey === "operationsOverview") {
    const sourceRows: [string,string,string,number,number][] = [["TEST-SH-1042","order","H1",57.6,2],["TEST-SC-0081","sample","H2",50.4,2],["TEST-TT-1038","order","H1",31.2,1],["TEST-SH-1045","order","H3",16,1],["TEST-SC-0085","sample","H2",8,1],["TEST-SH-1044","order","H2",18,1]];
    const rows = sourceRows.filter(([, , h]) => home === "all" || h === home).map(([ref,kind,h,waitingHours,units]) => ({ ref,kind,home:h,waitingHours,units,hold:null,
      sourceFacts: { requestedAt: new Date(Date.parse(observedAt)-waitingHours*3600000).toISOString(), orderRef: kind === "order" ? ref : null, sampleRef: kind === "sample" ? ref : null, shipmentRef:null,detailRef:ref,orderUnfulfilled:kind === "order" ? true : null,sampleApproved:kind === "sample" ? true : null,labelCreated:false,canceled:false,identityResolved:true,stockAvailable:true,evidenceRef:`EVIDENCE-${ref}`,observedAt } }));
    const total=home === "all" ? 18 : home === "H1" ? 7 : home === "H2" ? 6 : 5;
    // Layout rows are an observed subset of these independently supplied fictional source totals.
    Object.assign(snapshot,{coverage:{state:"partial",expectedCount:total,observedCount:rows.length,reasonCodes:["SOURCE_ROWS_INCOMPLETE"]}});
    Object.assign(r,{ all:summary(18,26,4), byHome:{H1:summary(7,11,2),H2:summary(6,8,1),H3:summary(5,7,1)},openIssues:known(7),needHumanResponse:2,queue:{rows,total},stock:homes.filter(h=>home === "all" || h.home===home),transfers:[{ref:"TEST-TR-012",toHome:"H2",state:"In transit"}],exceptions:[{shipmentRef:"TEST-SP-0093",exceptionId:"TEST-EVT-129",state:"Lost",home:"H2"},{shipmentRef:"TEST-SP-0091",exceptionId:"TEST-EVT-127",state:"Returned",home:"H1"}].filter(e=>home === "all" || e.home===home),health:{carrierTransitDays:known(3.4),shippingCostPerOrder:known(money(685)),onTimeHandoffPct:known(94)} });
  }
  if (viewKey === "orderDetail") Object.assign(r,{total:known(money(6998)),totalContext:"2 units · fictional paid order",items:[{name:"Farda device · Graphite",units:2,unitPrice:known(money(3499))}],attributionLabel:"Creator code",attributionContext:"Source-confirmed attribution",collaboration:"TEST-COL-018",discountCode:"FARDA-TEST018",sourceKey:"SHOP-TEST-1042",nativeEvents:[event("orderPaid",0)]});
  if (viewKey === "shippingException") Object.assign(r,{home:"H2",shippingCost:known(money(675)),shippingCostContext:"$5.95 label + $0.80 packaging",owner:"Fulfillment · Home H2",supportCase:"TEST-ISS-021",nativeEvents:[event("labelCreated",0),event("carrierAccepted",1),event("shipped",2),event("carrierLost",3)]});
  if (viewKey === "returnDetail") {
    Object.assign(r,{home:"H3",orderKey:"SHOP-TEST-1028",selected:{disposition:"restock",resolution:"refund",reason:"Fictional inspected return"},inspection:{receiptRef:"TEST-INSP-028",resellable:true,units:1},refundAmount:money(3499),nativeEvents:[event("returnAuthorized",0),event("returnReceived",1),event("returnInspected",2)]});
    if (resolved) { snapshot.version="layout-resolved-v2"; Object.assign(r,{state:"resolved",nativeEvents:["returnReceived","inventoryRestocked","refundSettled","accountingPosted","caseClosed"].map(event),resolved:{chain:[],refunded:money(3499),returnedUnits:1,restockedUnits:1,retainedUnits:1,replacement:"Not selected",caseRef:"TEST-ISS-018"}}); }
  }
  if (viewKey === "fulfillmentAnalytics") {
    r.reportingScope = { home: "all", startAt: "2026-10-16T00:00:00.000Z", endAt: "2026-10-30T00:00:00.000Z", timezone: "UTC", basis: "eventAt" };
    const shipped=[12,19,21,16,28,24,32,26,18,22,29,25,31,26],backlog=[22,25,20,28,24,19,26,22,27,25,18,21,20,18];
    Object.assign(r,{daily:shipped.map((value,index)=>({label:index===0?"16 Oct":String(16+index),shipped:value,backlog:backlog[index]})),shippedPrior:known(279),onTimePct:known(94),awaitingHandoff:known(18),overdue:4,stock:homes.map(h=>({home:h.home,available:h.onHand-h.reserved,reserved:h.reserved,threshold:h.threshold})),scaleUnits:120,avgTransitDays:known(3.4),transit:[{label:"1–2 days",share:32},{label:"3–4 days",share:51},{label:"5–6 days",share:13},{label:"7+ days",share:4,warn:true}],exceptions:{lost:1,returned:1}});
  }
  return snapshot;
}
