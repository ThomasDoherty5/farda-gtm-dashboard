import { Badge } from "@/components/Badge";
import styles from "./Operations.module.css";
import type { NativeFulfillmentEvent } from "@/adapter/viewSchemas/nativeOperations";
import { Steps } from "@/components/Panels";
export const nativeEventLabels: Record<NativeFulfillmentEvent["kind"], string> = { refundRequested: "Refund requested", returnAuthorized: "Return authorized", returnInspected: "Return inspected", carrierLost: "Lost by carrier", carrierReturned: "Returned by carrier", orderPaid: "Paid", labelCreated: "Label created", carrierAccepted: "Carrier accepted", shipped: "Shipped", delivered: "Delivered", returnReceived: "Return received", refundSettled: "Refund settled", replacementCreated: "Replacement created", replacementShipped: "Replacement shipped", inventoryRestocked: "Inventory restocked", accountingPosted: "Accounting posted", inventoryQuarantined: "Inventory quarantined", caseClosed: "Case closed" };
export function NativeEventTimeline({ events = [], expected, horizontal = false, stockReconciliation = false }: { stockReconciliation?: boolean; horizontal?: boolean; events?: NativeFulfillmentEvent[]; expected: NativeFulfillmentEvent["kind"][] }) {
  const steps = expected.flatMap(kind => {
    const facts = events.filter(event => event.kind === kind);
    return facts.length ? facts.map((event, index) => ({ key: `${kind}-${index}`, title: nativeEventLabels[kind], state: event.state === "confirmed" ? (kind === "carrierLost" || kind === "carrierReturned" ? "problem" as const : "done" as const) : event.state === "failed" ? "problem" as const : "pending" as const,
      note: `${event.state} · event ${event.eventAt ? new Date(event.eventAt).toLocaleString() : "Unknown"} · observed ${new Date(event.observedAt).toLocaleString()} · receipt ${event.receiptRef ?? "Unknown"}${event.reasonCode ? ` · ${event.reasonCode}` : ""}` })) : [{ key: kind, title: nativeEventLabels[kind], state: "pending" as const, note: "Unknown · no independent source receipt was returned." }];
  });
  if (stockReconciliation) {
    const inventory = events.filter(event => event.kind === "inventoryRestocked" || event.kind === "inventoryQuarantined");
    steps.push({ key: "stock-reconciliation", title: "Stock reconciled", state: inventory.some(event => event.state === "failed") ? "problem" : "pending",
      note: inventory.length ? "Reconciliation unknown; independent observations: " + inventory.map(event => `${nativeEventLabels[event.kind]} · ${event.state} · event ${event.eventAt ? new Date(event.eventAt).toLocaleString() : "Unknown"} · observed ${new Date(event.observedAt).toLocaleString()} · receipt ${event.receiptRef ?? "Unknown"}${event.reasonCode ? ` · ${event.reasonCode}` : ""}`).join("; ") : "Unknown · no independent source receipt was returned." });
  }
  if (horizontal) return <ol className={styles.refundStates} aria-label="Independent fulfillment source events">{steps.map(step => <li key={step.key}><Badge tone={step.state === "done" ? "success" : step.state === "problem" ? "danger" : "neutral"}>{step.title}</Badge><p>{step.note}</p></li>)}</ol>;
  return <Steps label="Independent fulfillment source events" steps={steps} />;
}
