import { buildOpsHealth, healthGroup, mean, reduceShipment, type OpsHealth } from "./opsHealth";
import { ISSUE_TAGS, REFUNDS, ledgerOrders, ledgerShipments, type LedgerOrder, type LedgerShipment, type ShipmentEvent, type ShipmentEventKind } from "@/fixtures/opsHealth";
import { operationsDemo, shippingExceptionDemo } from "@/fixtures/operations";
import { supportDemo } from "@/fixtures/support";
import { DEMO_NOW } from "@/fixtures/overview";
import { HOME_STOCK } from "@/fixtures/inventory";

const health = buildOpsHealth();
const value = (v: { state: string; value: unknown }) => (v.state === "known" ? v.value : null);
const shipment = (ref: string) => ledgerShipments.find((s) => s.shipmentRef === ref)!;

describe("fulfillment averages are derived from the ledger", () => {
  it("ties the overall figures to the Operations overview", () => {
    expect(value(health.fulfillment.all.orderToShipped.days)).toBe(operationsDemo.all.timeToShipDays.value);
    expect(value(health.fulfillment.all.shippedToDelivered.days)).toBe(operationsDemo.health.carrierTransitDays.value);
    expect(health.fulfillment.all.costPerOrder.value).toEqual(operationsDemo.health.shippingCostPerOrder.value);
  });

  it("ties each home's order-to-shipped days to the overview, and splits delivery by home and carrier", () => {
    for (const g of health.fulfillment.byHome) expect(value(g.orderToShipped.days)).toBe(operationsDemo.byHome[g.key.slice(-2) as "H1"].timeToShipDays.value);
    expect(health.fulfillment.byCarrier.map((g) => value(g.shippedToDelivered.days))).toEqual([3, 4]);
    expect(health.fulfillment.byHome.reduce((n, g) => n + g.shippedToDelivered.sample, 0)).toBe(health.fulfillment.all.shippedToDelivered.sample);
  });

  it("delivers nothing before it was shipped, and nothing after the demo clock", () => {
    for (const s of ledgerShipments.map(reduceShipment)) {
      if (s.deliveredAt) {
        expect(Date.parse(s.deliveredAt)).toBeGreaterThan(Date.parse(s.shippedAt!));
        expect(Date.parse(s.deliveredAt)).toBeLessThanOrEqual(Date.parse(DEMO_NOW));
      }
    }
  });

  it("leaves a shipped order with an unread label cost out of the cost average, never as $0", () => {
    const g = health.fulfillment.all;
    expect(g.costUnread).toBe(1);
    // Worked by hand from the fixture: 30 delivered labels cycle 595, 645, 685, 725, 775 six times (6 x 3,425 = 20,550), plus the
    // lost ($6.75) and returned ($6.85) labels = 21,910 over 32 costed orders = 684.69, so $6.85. The unread one (TEST-SP-0099) is out.
    expect(g.costPerOrder.value).toEqual({ minorUnits: 685, currency: "USD" });
  });
});

/** Hand-built ledger rows, so the expected numbers below are worked by hand and not recomputed with the code's formula. */
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const hr = (h: number) => new Date(T0 + h * 3_600_000).toISOString();
const evt = (ref: string, n: number, kind: ShipmentEventKind, h: number): ShipmentEvent => ({ eventId: `${ref}-${n}`, kind, occurredAt: hr(h), receivedAt: hr(h) });
const ship = (ref: string, order: string, cost: number | null, kinds: [ShipmentEventKind, number][], units = 1): LedgerShipment => ({
  shipmentRef: ref, orderRef: order, home: "H1", carrier: "Carrier A", unitsShipped: units, labelCostCents: cost, events: kinds.map(([k, h], i) => evt(ref, i + 1, k, h)),
});
const order = (ref: string, units = 1, canceled = false): LedgerOrder => ({ orderRef: ref, orderedAt: hr(0), unitsOrdered: units, canceledAt: canceled ? hr(1) : null, reservationRef: `RSV-${ref}` });
const orderedAt = new Map([["O1", hr(0)], ["O2", hr(0)], ["O3", hr(0)], ["O4", hr(0)]]);

describe("averages of nothing are unknown, not zero", () => {
  it("mean([]) is unknown with NO_SHIPMENTS_IN_GROUP and a sample of 0", () => {
    expect(mean([])).toMatchObject({ days: { state: "unknown", value: null, reasonCode: "NO_SHIPMENTS_IN_GROUP" }, sample: 0 });
  });

  it("mean works in hours and reports days to one decimal: 24 h and 48 h is 1.5 days", () => {
    expect(mean([24, 48])).toMatchObject({ days: { state: "known", value: 1.5 }, sample: 2 });
  });

  it("an empty group is unknown for timing and cost, with the reasons", () => {
    const g = healthGroup("Empty", [], orderedAt);
    expect(g.orderToShipped.days).toMatchObject({ state: "unknown", value: null, reasonCode: "NO_SHIPMENTS_IN_GROUP" });
    expect(g.shippedToDelivered.days).toMatchObject({ state: "unknown", value: null, reasonCode: "NO_SHIPMENTS_IN_GROUP" });
    expect(g.costPerOrder).toMatchObject({ state: "unknown", value: null, reasonCode: "COST_NOT_READ" });
    expect(g.orders).toBe(0);
  });

  it("a group of only an unconfirmed label has nothing to average and no cost", () => {
    const g = healthGroup("Uncertain", [reduceShipment(ship("S1", "O1", null, [["label_uncertain", 2]]))], orderedAt);
    expect(g.orderToShipped.days).toMatchObject({ state: "unknown", reasonCode: "NO_SHIPMENTS_IN_GROUP" });
    expect(g.costPerOrder).toMatchObject({ state: "unknown", reasonCode: "COST_NOT_READ" });
  });

  it("a shipped group whose labels have no cost is COST_NOT_READ, not $0", () => {
    const g = healthGroup("Unread", [reduceShipment(ship("S1", "O1", null, [["label_purchased", 1], ["carrier_accepted", 24]]))], orderedAt);
    expect(g.costPerOrder).toMatchObject({ state: "unknown", value: null, reasonCode: "COST_NOT_READ" });
    expect(g.costUnread).toBe(1);
    expect(g.orderToShipped.days).toMatchObject({ state: "known", value: 1 });
  });
});

describe("a leaves-out rule is worked by hand", () => {
  const costed = (ref: string, order: string, cost: number | null) => reduceShipment(ship(ref, order, cost, [["label_purchased", 1], ["carrier_accepted", 24], ["delivered", 96]]));

  it("leaves an unread cost out: $5.00 and $7.00 with one unread is $6.00 over 2 orders, and the unread one is counted aside", () => {
    const g = healthGroup("G", [costed("S1", "O1", 500), costed("S2", "O2", 700), costed("S3", "O3", null)], orderedAt);
    expect(g.costPerOrder.value).toEqual({ minorUnits: 600, currency: "USD" });
    expect(g.costUnread).toBe(1);
  });

  it("a delivered shipment with no carrier acceptance is excluded from shipped-to-delivered and counted as unknown", () => {
    const noScan = reduceShipment(ship("S4", "O4", 500, [["label_purchased", 1], ["delivered", 100]]));
    expect(noScan).toMatchObject({ state: "Delivered", shippedAt: null });
    // S1: accepted at 24 h, delivered at 96 h = 3 days. The unscanned one must not become a ~20,000-day average.
    const g = healthGroup("G", [costed("S1", "O1", 500), noScan], orderedAt);
    expect(g.shippedToDelivered).toMatchObject({ days: { state: "known", value: 3 }, sample: 1 });
    expect(g.deliveredWithoutAcceptance).toBe(1);
    const only = healthGroup("G", [noScan], orderedAt);
    expect(only.shippedToDelivered.days).toMatchObject({ state: "unknown", value: null });
    expect(only.orderToShipped.days).toMatchObject({ state: "unknown", value: null });
  });

  it("shipping cost per order divides by orders: an order with two labels counts once", () => {
    // O1 has labels of $5.00 and $3.00 = $8.00; O2 has $4.00. (800 + 400) / 2 orders = $6.00. Per shipment would be $4.00.
    const g = healthGroup("G", [costed("S1", "O1", 500), costed("S1b", "O1", 300), costed("S2", "O2", 400)], orderedAt);
    expect(g.costPerOrder.value).toEqual({ minorUnits: 600, currency: "USD" });
    expect(g.orders).toBe(2);
  });

  it("an order with any shipped label of unread cost is left out of the cost average whole, so it is never understated", () => {
    const g = healthGroup("G", [costed("S1", "O1", 500), costed("S1b", "O1", null), costed("S2", "O2", 400)], orderedAt);
    expect(g.costPerOrder.value).toEqual({ minorUnits: 400, currency: "USD" });
  });
});

describe("canceled orders and unconfirmed labels", () => {
  const live = [order("O1"), order("O2", 1, true)];
  const shipments = [
    ship("S1", "O1", 500, [["label_purchased", 1], ["carrier_accepted", 24], ["delivered", 96]]),
    ship("S2", "O2", 900, [["label_purchased", 1], ["carrier_accepted", 48], ["delivered", 120]]),
  ];

  it("a canceled order's shipment and label cost stay out of every average", () => {
    const h = buildOpsHealth({ orders: live, shipments });
    expect(h.fulfillment.all.orderToShipped).toMatchObject({ days: { value: 1 }, sample: 1 });
    expect(h.fulfillment.all.shippedToDelivered.sample).toBe(1);
    expect(h.fulfillment.all.costPerOrder.value).toEqual({ minorUnits: 500, currency: "USD" });
    expect(h.fulfillment.all.orders).toBe(1);
    expect(h.fulfillment.byHome[0]!.costPerOrder.value).toEqual({ minorUnits: 500, currency: "USD" });
  });

  it("the canceled order still lists as Canceled", () => {
    const h = buildOpsHealth({ orders: live, shipments });
    expect(h.orders.find((o) => o.orderRef === "O2")).toMatchObject({ state: "Canceled", unitsShipped: 0 });
  });

  it("an unconfirmed label ships 0 units", () => {
    const r = reduceShipment(ship("S3", "O3", null, [["label_uncertain", 2]], 2));
    expect(r.unitsShipped).toBe(0);
    expect(r.state).toBe("Label uncertain");
  });

  it("an unconfirmed label is not reported as a partial fulfillment", () => {
    const h = buildOpsHealth({ orders: [order("O3", 2)], shipments: [ship("S3", "O3", null, [["label_uncertain", 2]], 2)] });
    const o = h.orders[0]!;
    expect(o).toMatchObject({ state: "Label uncertain", unitsShipped: 0 });
    expect(o.note).toMatch(/not shipped/);
    expect(o.note).not.toMatch(/waits for stock/);
  });

  it("a partial order that is also lost stays Lost and keeps the Lost note, with the unit counts", () => {
    const h = buildOpsHealth({ orders: [order("O3", 3)], shipments: [ship("S3", "O3", 600, [["label_purchased", 1], ["carrier_accepted", 24], ["lost", 80]], 2)] });
    const o = h.orders[0]!;
    expect(o.state).toBe("Lost");
    expect(o.note).toMatch(/reported it lost/);
    expect(o.note).toMatch(/2 of 3 units shipped/);
  });
});

describe("shipment event handling", () => {
  it("counts a retried event once and records no extra stock decrement", () => {
    const r = reduceShipment(shipment("TEST-SP-200"));
    expect(r.duplicatesIgnored).toBe(2);
    expect(r.stockDecrements).toBe(1);
    expect(r.state).toBe("Delivered");
    expect(r.deliveredAt).toBe(reduceShipment({ ...shipment("TEST-SP-200"), events: shipment("TEST-SP-200").events.slice(0, 4) }).deliveredAt);
  });

  it("uses when it happened, not when it arrived, for a delivery that was mirrored early", () => {
    const r = reduceShipment(shipment("TEST-SP-201"));
    expect(r.outOfOrder).toBe(true);
    expect(r.state).toBe("Delivered");
    const reversed: LedgerShipment = { ...shipment("TEST-SP-201"), events: [...shipment("TEST-SP-201").events].reverse() };
    expect(reduceShipment(reversed)).toEqual(r);
  });

  it("does not show a label purchase with no confirmation as shipped, delivered or costed", () => {
    const r = reduceShipment(shipment("TEST-SP-0098"));
    expect(r).toMatchObject({ state: "Label uncertain", shippedAt: null, deliveredAt: null, labelCostCents: null, stockDecrements: 0 });
  });

  it("does not call a purchased label a handoff", () => {
    const labelOnly: LedgerShipment = { ...shipment("TEST-SP-200"), events: shipment("TEST-SP-200").events.slice(0, 1) };
    expect(reduceShipment(labelOnly)).toMatchObject({ state: "In transit", shippedAt: null, deliveredAt: null });
  });

  it("keeps lost and returned shipments out of the delivery average", () => {
    for (const ref of ["TEST-SP-0093", "TEST-SP-0091"]) expect(reduceShipment(shipment(ref)).deliveredAt).toBeNull();
    expect(reduceShipment(shipment("TEST-SP-0093")).state).toBe("Lost");
    expect(reduceShipment(shipment("TEST-SP-0091")).state).toBe("Returned");
    expect(reduceShipment(shipment("TEST-SP-0099")).state).toBe("In transit");
  });

  it("decrements stock once per confirmed shipment across the whole ledger", () => {
    expect(health.integrity.stockDecrements).toBe(ledgerShipments.length - 1);
    expect(health.integrity.duplicatesIgnored).toBe(2);
  });
});

describe("orders that did not ship cleanly", () => {
  const byRef = (h: OpsHealth, ref: string) => h.orders.find((o) => o.orderRef === ref)!;

  it("reports a partial fulfillment with the units that shipped and the units still waiting", () => {
    const o = byRef(health, "TEST-SH-1103");
    expect(o).toMatchObject({ state: "Partially fulfilled", unitsOrdered: 3, unitsShipped: 2 });
    expect(o.note).toMatch(/2 of 3 units shipped/);
  });

  it("reports a canceled order with no shipment and no on-hand change", () => {
    const o = byRef(health, "TEST-SH-1046");
    expect(o).toMatchObject({ state: "Canceled", shipmentRef: null });
    expect(o.note).toMatch(/on-hand stock did not change/);
    expect(ledgerShipments.some((s) => s.orderRef === "TEST-SH-1046")).toBe(false);
  });

  it("gives one order, reservation and shipment identity, and one reservation per order", () => {
    const refs = ledgerOrders.map((o) => o.reservationRef);
    expect(new Set(refs).size).toBe(refs.length);
    for (const s of ledgerShipments) expect(ledgerOrders.some((o) => o.orderRef === s.orderRef)).toBe(true);
    expect(new Set(ledgerShipments.map((s) => s.shipmentRef)).size).toBe(ledgerShipments.length);
  });

  it("matches the lost and returned shipments, their homes and the support case on the other screens", () => {
    for (const ex of operationsDemo.exceptions) {
      const s = shipment(ex.shipmentRef);
      expect(reduceShipment(s).state).toBe(ex.state);
      expect(s.home).toBe(ex.home);
    }
    const lost = shipment("TEST-SP-0093");
    expect(lost.orderRef).toBe("TEST-SH-1031");
    expect(lost.labelCostCents).toBe(shippingExceptionDemo("TEST-SP-0093", "TEST-EVT-129")!.shippingCost.value!.minorUnits);
    expect(supportDemo(shippingExceptionDemo("TEST-SP-0093", "TEST-EVT-129")!.supportCase)!.case.linkedShipment).toBe("TEST-SP-0093");
    expect(supportDemo("TEST-ISS-021")!.case.orderRef).toBe("TEST-SH-1031");
  });

  it("agrees with the stock balances on how many homes exist", () => {
    expect(health.fulfillment.byHome.map((g) => g.key)).toEqual(HOME_STOCK.map((s) => `Home ${s.home}`));
  });
});

describe("issues tie out to the support cohort", () => {
  const cohort = supportDemo("TEST-ISS-021")!;

  it("splits each cohort ticket type into this week and last week without losing a ticket", () => {
    for (const t of cohort.cohort.tickets) {
      const tag = ISSUE_TAGS.find((x) => x.tag === t.label)!;
      expect(tag.thisWeek + tag.lastWeek).toBe(t.count);
    }
  });

  it("totals refunds from source receipts only, and lists the unreceipted one apart", () => {
    expect(health.issues.refunds.total).toEqual(cohort.outcomes.refundedAmount);
    expect(health.issues.refunds.orders).toBe(cohort.outcomes.refundedOrders);
    expect(health.issues.refunds.pending.map((p) => p.orderRef)).toEqual(["TEST-SH-1028"]);
    expect(REFUNDS.find((r) => r.orderRef === "TEST-SH-1028")!.receiptRef).toBeNull();
    expect(supportDemo("TEST-ISS-018")!.case.linkedReturn).toBe("TEST-RET-028");
  });

  it("reports Fin's cost against the same cap as the support workspace", () => {
    expect(health.issues.fin.cost).toEqual(cohort.fin.cost);
    expect(health.issues.fin.cap).toEqual(cohort.fin.cap);
    expect(health.issues.fin.resolutions).toBeGreaterThan(0);
  });
});
