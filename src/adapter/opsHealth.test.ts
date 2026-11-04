import { buildOpsHealth, reduceShipment, type OpsHealth } from "./opsHealth";
import { ISSUE_TAGS, REFUNDS, ledgerOrders, ledgerShipments, type LedgerShipment } from "@/fixtures/opsHealth";
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
    const withCosts = ledgerShipments.filter((s) => s.labelCostCents !== null && reduceShipment(s).state !== "Label uncertain");
    expect(g.costPerOrder.value).toEqual({ minorUnits: Math.round(withCosts.reduce((n, s) => n + s.labelCostCents!, 0) / withCosts.length), currency: "USD" });
  });

  it("answers unknown, not zero, for a group with nothing to average", () => {
    const none = reduceShipment({ ...shipment("TEST-SP-0098") });
    expect(none.shippedAt).toBeNull();
    expect(none.labelCostCents).toBeNull();
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
