import type { HubShipment, ShippingHubData } from "@/features/operations/shippingHub/types";

export const SHIPPING_DEMO_NOW = "2026-11-04T18:42:00.000Z";
const at = "2026-11-04T18:40:00.000Z";
const money = (minorUnits: number) => ({ minorUnits, currency: "USD" });
const freshness = (): HubShipment["freshness"] => (["tracking", "inventory", "address", "quote", "terms"] as const).map(field => ({ field, state: "current", observedAt: at, sourceRef: `demo-${field}` }));
const base = (id: string): HubShipment => ({
  id, parcelId: `${id}-parcel-1`, version: "v1", requestedAt: "2026-11-01T17:00:00.000Z",
  recipient: { type: "customer", ref: "C-1042", display: "C-1042" }, origin: { kind: "order", ref: "DEMO-1042", channel: "website" }, purpose: "sale",
  sku: "OC6", quantity: 1, location: "H1", owner: "Alex", parcelIndex: 1, parcelCount: 1, remainingUnits: 0,
  readiness: "ready", reservationRef: `${id}-reservation`, addressRef: `${id}-address-v1`, addressVerified: true,
  package: { weightGrams: 500, lengthCm: 24, widthCm: 10, heightCm: 10, measuredAt: at },
  pipeline: "ready", carrierState: "unknown", carrier: "UPS", trackingRef: null, trackingUrl: null,
  shipBy: "2026-11-05T20:00:00.000Z", eta: null, etaSource: "Order commitment", deliveredAt: null, lastEventAt: at,
  label: { state: "none", transactionRef: null, receiptRef: null, cost: null },
  quote: { ref: `${id}-quote`, service: "UPS Ground", cost: money(685), maxCost: money(700), expiresAt: "2026-11-04T19:00:00.000Z", observedAt: at },
  exception: null, nextAction: "Review label proposal", reviewCapability: { state: "available", reason: null },
  approval: { state: "pending", actionVersion: "v1", slackDecisionRef: null, linearReceiptRef: null }, freshness: freshness(), postingClock: null, timeline: [],
});
const label = (id: string, cost: number): HubShipment["label"] => ({ state: "purchased", transactionRef: `DEMO-TXN-${id}`, receiptRef: `DEMO-RECEIPT-${id}`, cost: money(cost) });
const creator = (name: string, ref: string): HubShipment["recipient"] => ({ type: "creator", ref, display: `@demo.${name}`, collaborationRef: `DEMO-COLLAB-${ref}` });
const allocation = (ref: string): HubShipment["origin"] => ({ kind: "allocation", ref: `DEMO-${ref}`, collaborationRef: `DEMO-COLLAB-${ref}`, acceptedTermsVersion: "v3" });

/** Synthetic operational fixtures, including parcel measurements and quotes. No factory/Shippo pricing claim. */
export function shippingHubDemo(scenario = "default"): ShippingHubData {
  const transit = base("DEMO-SHIP-1041");
  Object.assign(transit, { recipient: { type: "customer", ref: "C-1041", display: "C-1041" }, origin: { kind: "order", ref: "DEMO-1041", channel: "website" }, readiness: "dispatched", pipeline: "transit", carrierState: "in-transit", trackingRef: "DEMO1041", eta: "2026-11-03T20:00:00.000Z", etaSource: "Carrier estimate", lastEventAt: "2026-11-03T16:42:00.000Z", quote: null, label: label("1041", 720), exception: { kind: "carrier-delay", message: "Carrier delay; last event 26 hours ago. Current delivery time is unknown." }, nextAction: "Review carrier exception" });
  transit.freshness[0] = { field: "tracking", state: "stale", observedAt: transit.lastEventAt, sourceRef: "demo-carrier-1041" };
  const held = base("DEMO-SHIP-C018");
  Object.assign(held, { recipient: creator("river", "C018"), origin: allocation("C018"), purpose: "sample", location: "H2", owner: "Sam", carrier: null, readiness: "address-pending", addressVerified: false, addressRef: null, quote: null, etaSource: "Accepted allocation", exception: { kind: "address-pending", message: "Verify the creator address before reviewing a label." }, nextAction: "Verify address" });
  held.freshness[1]!.observedAt = SHIPPING_DEMO_NOW;
  held.freshness[2] = { field: "address", state: "unknown", observedAt: null, sourceRef: "demo-address-C018" };
  const ready = base("DEMO-SHIP-1042");
  ready.requestedAt = "2026-11-02T18:00:00.000Z";
  const printed = base("DEMO-SHIP-C019");
  Object.assign(printed, { recipient: creator("ash", "C019"), origin: allocation("C019"), purpose: "sample", location: "H2", owner: "Sam", pipeline: "label", carrierState: "pre-transit", carrier: "FedEx", trackingRef: "DEMO019", quote: null, label: label("019", 710), nextAction: "Open label / print" });
  printed.lastEventAt = "2026-11-04T18:30:00.000Z";
  const delivered = base("DEMO-SHIP-C020");
  Object.assign(delivered, { recipient: creator("mica", "C020"), origin: allocation("C020"), purpose: "sample", location: "H3", owner: "Lee", readiness: "dispatched", reservationRef: null, pipeline: "delivered", carrierState: "delivered", trackingRef: "DEMO020", quote: null, deliveredAt: "2026-11-04T18:20:00.000Z", label: label("020", 690), nextAction: "Open creator details", postingClock: { dueAt: "2026-11-12T01:00:00.000Z", timezone: "America/Los_Angeles", recordRef: "DEMO-CLOCK-C020", observedAt: "2026-11-04T18:36:00.000Z", acceptedTermsVersion: "v3", brief: "1 native review + 2 supporting clips" } });
  delivered.freshness[0]!.observedAt = "2026-11-04T18:35:00.000Z";
  delivered.timeline = [{ id: "demo-event-delivered", occurredAt: delivered.deliveredAt!, title: "Delivered / carrier evidence", evidenceRef: "demo-delivery-020" }, { id: "demo-event-accepted", occurredAt: "2026-11-01T23:40:00.000Z", title: "Carrier accepted", evidenceRef: "demo-acceptance-020" }, { id: "demo-event-label", occurredAt: "2026-11-01T17:00:00.000Z", title: "Label created", evidenceRef: "demo-label-020" }];
  const returned = base("DEMO-SHIP-R041");
  Object.assign(returned, { recipient: { type: "customer", ref: "C-1040", display: "C-1040" }, origin: { kind: "replacement", ref: "DEMO-R041", parentOriginRef: "DEMO-1040", parentShipmentId: "DEMO-SHIP-1040", approvalRef: null }, purpose: "replacement", readiness: "return-hold", pipeline: "returns", carrierState: "returning", trackingRef: "DEMOR041", quote: null, eta: "2026-11-06T20:00:00.000Z", etaSource: "Carrier estimate", label: label("R041", 680), nextAction: "Open return case" });
  returned.freshness[0]!.observedAt = "2026-11-04T18:32:00.000Z";
  const shipments = [transit, held, ready, printed, delivered, returned];
  if (scenario === "edge") {
    const replacement = base("DEMO-SHIP-C021");
    Object.assign(replacement, { recipient: creator("river", "C018"), purpose: "replacement", origin: { kind: "replacement", ref: "DEMO-RC021", parentOriginRef: "DEMO-C018", parentShipmentId: held.id, approvalRef: "DEMO-APPROVAL-RC021" }, label: { state: "uncertain", transactionRef: null, receiptRef: null, cost: null }, exception: { kind: "uncertain-label", message: "Provider outcome unknown. Reconcile before retrying." }, nextAction: "Reconcile label outcome" });
    const split = base("DEMO-SHIP-1043-P1");
    Object.assign(split, { origin: { kind: "order", ref: "DEMO-1043", channel: "website" }, parcelCount: 2, remainingUnits: 1, trackingRef: transit.trackingRef, carrier: transit.carrier });
    const split2 = { ...structuredClone(split), id: "DEMO-SHIP-1043-P2", parcelId: "DEMO-SHIP-1043-parcel-2", parcelIndex: 2, trackingRef: null, readiness: "reservation-conflict" as const, reservationRef: null, exception: { kind: "stock-conflict", message: "Reservation changed. Refresh stock before review." } };
    const unapproved = base("DEMO-SHIP-C022");
    Object.assign(unapproved, { recipient: creator("new", "C022"), origin: { ...allocation("C022"), acceptedTermsVersion: null }, purpose: "sample", readiness: "unapproved", exception: { kind: "unapproved", message: "Sample terms are not accepted." } });
    shipments.push(replacement, split, split2, unapproved);
  }
  if (scenario === "stale") for (const s of shipments) s.freshness.forEach(f => { f.state = "stale"; });
  if (scenario === "partial") shipments.splice(4);
  if (scenario === "empty") shipments.splice(0);
  return { datasetKey: "shipping-hub-demo", observedAt: SHIPPING_DEMO_NOW, reviewValidUntil: "2026-11-04T18:47:00.000Z", sourceLabel: "Shippo + order / allocation ledger", shipments,
    stock: [{ location: "H1", sku: "OC6", onHand: 20, reserved: 3 }, { location: "H2", sku: "OC6", onHand: 10, reserved: 2 }, { location: "H3", sku: "OC6", onHand: 12, reserved: 0 }],
    initialSelection: scenario === "default" ? [held.id, ready.id] : [] };
}
