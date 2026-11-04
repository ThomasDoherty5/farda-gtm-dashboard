import type { Money, ProvenanceValue } from "./contract";
import { ISSUE_TAGS, REFUNDS, FIN_BILLING, ledgerOrders, ledgerShipments, type Carrier, type LedgerShipment, type ShipmentEvent } from "@/fixtures/opsHealth";
import { HOMES, type Home } from "@/fixtures/operations";
import { known, unknown, usd } from "@/fixtures/values";

export type ShipmentState = "Delivered" | "In transit" | "Lost" | "Returned" | "Label uncertain";
export type ReducedShipment = {
  shipmentRef: string;
  orderRef: string;
  home: Home;
  carrier: Carrier;
  state: ShipmentState;
  /** Carrier acceptance. A purchased label is not a handoff. Null when the carrier never accepted it. */
  shippedAt: string | null;
  /** The authoritative delivery clock: the carrier's delivered event, by occurrence time. */
  deliveredAt: string | null;
  labelCostCents: number | null;
  unitsShipped: number;
  duplicatesIgnored: number;
  outOfOrder: boolean;
  /** Stock decrements recorded for this shipment. One confirmed label is one decrement, however many events arrive. */
  stockDecrements: number;
};

const HOUR = 3_600_000;
const t = (iso: string) => new Date(iso).getTime();

/** Dedupe by event id and order by when it happened, not when it arrived, so a retry or a late scan can't change the answer. */
export function reduceShipment(s: LedgerShipment): ReducedShipment {
  const seen = new Set<string>();
  const unique: ShipmentEvent[] = [];
  for (const e of s.events) if (!seen.has(e.eventId)) { seen.add(e.eventId); unique.push(e); }
  const ordered = [...unique].sort((a, b) => t(a.occurredAt) - t(b.occurredAt));
  const arrival = [...unique].sort((a, b) => t(a.receivedAt) - t(b.receivedAt));
  const find = (kind: ShipmentEvent["kind"]) => ordered.find((e) => e.kind === kind)?.occurredAt ?? null;
  const confirmed = ordered.some((e) => e.kind === "label_purchased");
  const last = ordered[ordered.length - 1]?.kind;
  const state: ShipmentState = !confirmed ? "Label uncertain" : last === "delivered" ? "Delivered" : last === "lost" ? "Lost" : last === "returned" ? "Returned" : "In transit";
  return {
    shipmentRef: s.shipmentRef,
    orderRef: s.orderRef,
    home: s.home,
    carrier: s.carrier,
    state,
    shippedAt: confirmed ? find("carrier_accepted") : null,
    deliveredAt: state === "Delivered" ? find("delivered") : null,
    labelCostCents: confirmed ? s.labelCostCents : null,
    unitsShipped: s.unitsShipped,
    duplicatesIgnored: s.events.length - unique.length,
    outOfOrder: arrival.some((e, i) => e.eventId !== ordered[i]!.eventId),
    stockDecrements: confirmed ? 1 : 0,
  };
}

export type Average = { days: ProvenanceValue<number>; sample: number };
export type HealthGroup = { key: string; orderToShipped: Average; shippedToDelivered: Average; costPerOrder: ProvenanceValue<Money>; orders: number; costUnread: number };
export type OrderLine = { orderRef: string; reservationRef: string; shipmentRef: string | null; home: Home | null; state: ShipmentState | "Canceled" | "Partially fulfilled"; unitsOrdered: number; unitsShipped: number; note: string };
export type OpsHealth = {
  datasetKey: "operations-demo";
  issues: {
    tags: { tag: string; thisWeek: number; lastWeek: number }[];
    refunds: { total: Money; orders: number; pending: { orderRef: string; amount: Money }[] };
    fin: { periodLabel: string; resolutions: number; cost: Money; cap: Money };
  };
  fulfillment: { all: HealthGroup; byHome: HealthGroup[]; byCarrier: HealthGroup[] };
  orders: OrderLine[];
  integrity: { shipments: number; duplicatesIgnored: number; outOfOrder: number; stockDecrements: number };
};

const mean = (hours: number[]): Average => ({ days: hours.length ? known(Math.round((10 * hours.reduce((a, b) => a + b, 0)) / hours.length / 24) / 10) : unknown("NO_SHIPMENTS_IN_GROUP"), sample: hours.length });

function group(key: string, rows: ReducedShipment[], orderedAt: Map<string, string>): HealthGroup {
  const shipped = rows.filter((r) => r.shippedAt);
  const costs = rows.filter((r) => r.labelCostCents !== null);
  return {
    key,
    orders: new Set(rows.map((r) => r.orderRef)).size,
    orderToShipped: mean(shipped.map((r) => (t(r.shippedAt!) - t(orderedAt.get(r.orderRef)!)) / HOUR)),
    shippedToDelivered: mean(rows.filter((r) => r.deliveredAt).map((r) => (t(r.deliveredAt!) - t(r.shippedAt!)) / HOUR)),
    costPerOrder: costs.length ? known(usd(Math.round(costs.reduce((n, r) => n + r.labelCostCents!, 0) / costs.length))) : unknown("COST_NOT_READ"),
    costUnread: rows.filter((r) => r.shippedAt && r.labelCostCents === null).length,
  };
}

export function buildOpsHealth(): OpsHealth {
  const reduced = ledgerShipments.map(reduceShipment);
  const orderedAt = new Map(ledgerOrders.map((o) => [o.orderRef, o.orderedAt]));
  const rows: OrderLine[] = ledgerOrders.flatMap((o): OrderLine[] => {
    const s = reduced.find((r) => r.orderRef === o.orderRef);
    if (o.canceledAt) return [{ orderRef: o.orderRef, reservationRef: o.reservationRef, shipmentRef: null, home: null, state: "Canceled", unitsOrdered: o.unitsOrdered, unitsShipped: 0, note: "Canceled before a label. The reservation is released; on-hand stock did not change." }];
    if (!s) return [];
    const partial = s.unitsShipped < o.unitsOrdered;
    const note: Record<ShipmentState, string> = {
      Delivered: "Delivered. The delivery time comes from the carrier's event.",
      "In transit": "With the carrier. Not delivered yet, so it has no delivery time.",
      Lost: "The carrier reported it lost. A refund or replacement is a separate decision.",
      Returned: "Returned to sender. Stock changes only when the return is inspected.",
      "Label uncertain": "The label purchase has no confirmation. It is not shipped. Verify in the source before buying again.",
    };
    return [{ orderRef: o.orderRef, reservationRef: o.reservationRef, shipmentRef: s.shipmentRef, home: s.home, state: partial && s.state === "Delivered" ? "Partially fulfilled" : s.state, unitsOrdered: o.unitsOrdered, unitsShipped: s.unitsShipped, note: partial ? `${s.unitsShipped} of ${o.unitsOrdered} units shipped. The rest waits for stock and keeps its reservation.` : note[s.state] }];
  });
  const total = REFUNDS.filter((r) => r.receiptRef).reduce((n, r) => n + r.amountCents, 0);
  return {
    datasetKey: "operations-demo",
    issues: {
      tags: ISSUE_TAGS.map((x) => ({ ...x })),
      refunds: { total: usd(total), orders: REFUNDS.filter((r) => r.receiptRef).length, pending: REFUNDS.filter((r) => !r.receiptRef).map((r) => ({ orderRef: r.orderRef, amount: usd(r.amountCents) })) },
      fin: { periodLabel: FIN_BILLING.periodLabel, resolutions: FIN_BILLING.resolutions, cost: usd(FIN_BILLING.costCents), cap: usd(FIN_BILLING.capCents) },
    },
    fulfillment: {
      all: group("All homes", reduced, orderedAt),
      byHome: HOMES.map((h) => group(`Home ${h}`, reduced.filter((r) => r.home === h), orderedAt)),
      byCarrier: (["Carrier A", "Carrier B"] as Carrier[]).map((c) => group(c, reduced.filter((r) => r.carrier === c), orderedAt)),
    },
    orders: rows.filter((r) => r.state !== "Delivered"),
    integrity: { shipments: reduced.length, duplicatesIgnored: reduced.reduce((n, r) => n + r.duplicatesIgnored, 0), outOfOrder: reduced.filter((r) => r.outOfOrder).length, stockDecrements: reduced.reduce((n, r) => n + r.stockDecrements, 0) },
  };
}
