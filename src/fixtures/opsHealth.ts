/**
 * Fulfillment and issue health fixtures (THO-271 acceptance) — SYNTHETIC. One event ledger for 34 shipments across three homes
 * and two carriers; every average on screen is derived from these timestamps, never typed in. Identifiers are fictional
 * ("TEST-…"), carriers are placeholders. The lost and returned shipments, the held order and the case links match the
 * Operations, Order, Exception and Support fixtures, so one order, shipment and case keeps one identity across screens.
 * Do not mix with the Overview, acquisition or finance datasets.
 */
import { DEMO_NOW } from "./overview";
import type { Home } from "./operations";

export type Carrier = "Carrier A" | "Carrier B";
export type ShipmentEventKind = "label_purchased" | "label_uncertain" | "carrier_accepted" | "in_transit" | "delivered" | "lost" | "returned";
/** `eventId` is the source's id: a retried delivery of the same event repeats it. `receivedAt` is when the mirror saw it. */
export type ShipmentEvent = { eventId: string; kind: ShipmentEventKind; occurredAt: string; receivedAt: string };
export type LedgerOrder = { orderRef: string; orderedAt: string; unitsOrdered: number; canceledAt: string | null; reservationRef: string };
export type LedgerShipment = {
  shipmentRef: string;
  orderRef: string;
  home: Home;
  carrier: Carrier;
  unitsShipped: number;
  /** Null means the label cost was not read. It is never treated as zero. */
  labelCostCents: number | null;
  events: ShipmentEvent[];
};

const HOUR = 3_600_000;
const NOW = new Date(DEMO_NOW).getTime();
const at = (hoursBeforeNow: number) => new Date(NOW - hoursBeforeNow * HOUR).toISOString();

/** Hours from order to carrier acceptance, for ten delivered shipments per home. Means: H1 26.4 h, H2 33.6 h, H3 24 h. */
const TO_SHIP: Record<Home, number[]> = {
  H1: [20, 24, 26, 28, 30, 22, 26, 32, 28, 28],
  H2: [30, 34, 36, 32, 38, 30, 34, 36, 32, 34],
  H3: [22, 24, 26, 24, 24, 22, 26, 24, 24, 24],
};
const TRANSIT: Record<Carrier, number[]> = {
  "Carrier A": [60, 66, 72, 78, 84, 72, 66, 78, 72, 72, 60, 84, 72, 72, 66, 78, 72, 72],
  "Carrier B": [90, 96, 102, 96, 84, 108, 96, 90, 102, 96, 96, 96],
};
const COST_CYCLE = [595, 645, 685, 725, 775];
const HOME_OF = (i: number): Home => (i < 10 ? "H1" : i < 20 ? "H2" : "H3");
const CARRIER_OF = (i: number): Carrier => (i % 5 < 3 ? "Carrier A" : "Carrier B");

const orders: LedgerOrder[] = [];
const shipments: LedgerShipment[] = [];
const ev = (shipmentRef: string, n: number, kind: ShipmentEventKind, occurred: number, received = occurred): ShipmentEvent => ({ eventId: `${shipmentRef}-E${n}`, kind, occurredAt: new Date(occurred).toISOString(), receivedAt: new Date(received).toISOString() });
const counters = { A: 0, B: 0 };

for (let i = 0; i < 30; i += 1) {
  const home = HOME_OF(i);
  const carrier = CARRIER_OF(i);
  const toShip = TO_SHIP[home][i % 10]!;
  const transit = TRANSIT[carrier][carrier === "Carrier A" ? counters.A++ : counters.B++]!;
  const orderRef = `TEST-SH-${String(1100 + i)}`;
  const shipmentRef = `TEST-SP-${String(200 + i)}`;
  const ordered = NOW - (340 - i * 5) * HOUR;
  const shipped = ordered + toShip * HOUR;
  const delivered = shipped + transit * HOUR;
  // Partial fulfillment: the third order asked for three units, two shipped, one waits for stock.
  const partial = i === 3;
  orders.push({ orderRef, orderedAt: new Date(ordered).toISOString(), unitsOrdered: partial ? 3 : 1, canceledAt: null, reservationRef: `TEST-RSV-${orderRef.slice(-4)}` });
  const events: ShipmentEvent[] = [
    ev(shipmentRef, 1, "label_purchased", ordered + 2 * HOUR),
    ev(shipmentRef, 2, "carrier_accepted", shipped),
    ev(shipmentRef, 3, "in_transit", shipped + 6 * HOUR),
    ev(shipmentRef, 4, "delivered", delivered),
  ];
  // A retried webhook repeats an event id. Another delivery arrives before the scan that preceded it.
  if (i === 0) events.push({ ...events[3]! , receivedAt: new Date(delivered + HOUR).toISOString() }, { ...events[2]!, receivedAt: new Date(shipped + 7 * HOUR).toISOString() });
  if (i === 1) events[3] = { ...events[3]!, receivedAt: new Date(shipped + 5 * HOUR).toISOString() };
  shipments.push({ shipmentRef, orderRef, home, carrier, unitsShipped: partial ? 2 : 1, labelCostCents: COST_CYCLE[i % 5]!, events });
}

const SHIPPED_AT = (hoursToShip: number, orderedAgo: number) => NOW - (orderedAgo - hoursToShip) * HOUR;
const extra = (orderRef: string, shipmentRef: string, home: Home, carrier: Carrier, orderedAgo: number, toShip: number, cost: number | null, tail: (shipped: number) => ShipmentEvent[], units = 1) => {
  const ordered = NOW - orderedAgo * HOUR;
  orders.push({ orderRef, orderedAt: new Date(ordered).toISOString(), unitsOrdered: units, canceledAt: null, reservationRef: `TEST-RSV-${orderRef.slice(-4)}` });
  const shipped = SHIPPED_AT(toShip, orderedAgo);
  shipments.push({ shipmentRef, orderRef, home, carrier, unitsShipped: units, labelCostCents: cost, events: [ev(shipmentRef, 1, "label_purchased", ordered + 2 * HOUR), ev(shipmentRef, 2, "carrier_accepted", shipped), ...tail(shipped)] });
};
// The lost shipment on Order TEST-SH-1031 (Home H2, $6.75 label), and the returned one for Home H1.
extra("TEST-SH-1031", "TEST-SP-0093", "H2", "Carrier B", 160, 34, 675, (s) => [ev("TEST-SP-0093", 3, "in_transit", s + 6 * HOUR), ev("TEST-SP-0093", 4, "lost", s + 42 * HOUR)]);
extra("TEST-SH-1027", "TEST-SP-0091", "H1", "Carrier A", 150, 26, 685, (s) => [ev("TEST-SP-0091", 3, "in_transit", s + 6 * HOUR), ev("TEST-SP-0091", 4, "returned", s + 60 * HOUR)]);
// Shipped and still moving: its label cost was not read, so it stays out of the cost average instead of counting as $0.
extra("TEST-SH-1052", "TEST-SP-0099", "H3", "Carrier A", 40, 24, null, (s) => [ev("TEST-SP-0099", 3, "in_transit", s + 6 * HOUR)]);
// The label purchase was requested and no confirmation came back. Not shipped, no stock decrement, no cost.
orders.push({ orderRef: "TEST-SH-1048", orderedAt: at(30), unitsOrdered: 1, canceledAt: null, reservationRef: "TEST-RSV-1048" });
shipments.push({ shipmentRef: "TEST-SP-0098", orderRef: "TEST-SH-1048", home: "H2", carrier: "Carrier B", unitsShipped: 1, labelCostCents: null, events: [ev("TEST-SP-0098", 1, "label_uncertain", NOW - 28 * HOUR)] });
// Canceled before any label: the reservation is released and no shipment exists.
orders.push({ orderRef: "TEST-SH-1046", orderedAt: at(52), unitsOrdered: 1, canceledAt: at(50), reservationRef: "TEST-RSV-1046" });

export const ledgerOrders: LedgerOrder[] = orders;
export const ledgerShipments: LedgerShipment[] = shipments;

/** Support issues tagged by type for the two most recent weeks. The weeks sum to the 14-day cohort in the support fixtures. */
export const ISSUE_TAGS: { tag: string; thisWeek: number; lastWeek: number }[] = [
  { tag: "Setup / pairing", thisWeek: 10, lastWeek: 8 },
  { tag: "Shipping", thisWeek: 7, lastWeek: 5 },
  { tag: "Returns", thisWeek: 2, lastWeek: 4 },
  { tag: "Hardware", thisWeek: 5, lastWeek: 4 },
];

/** Refunds with a source receipt. TEST-SH-1028's refund is approved but has no receipt yet, so it is not in the total. */
export const REFUNDS: { orderRef: string; amountCents: number; receiptRef: string | null }[] = [
  { orderRef: "TEST-SH-1012", amountCents: 3499, receiptRef: "TEST-REF-1012-1" },
  { orderRef: "TEST-SH-1015", amountCents: 3499, receiptRef: "TEST-REF-1015-1" },
  { orderRef: "TEST-SH-1022", amountCents: 3499, receiptRef: "TEST-REF-1022-1" },
  { orderRef: "TEST-SH-1028", amountCents: 3499, receiptRef: null },
];

/** The billing period is not the 14-day cohort, so Fin's resolutions are a different count from the cohort's first-contact total. */
export const FIN_BILLING = { periodLabel: "Demo billing period", resolutions: 48, costCents: 4800, capCents: 15000 };
