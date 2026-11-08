import type { NativeFulfillmentEvent } from "@/adapter/viewSchemas/nativeOperations";
import { Steps } from "@/components/Panels";
export const nativeEventLabels: Record<NativeFulfillmentEvent["kind"], string> = { orderPaid: "Paid", labelCreated: "Label created", carrierAccepted: "Carrier accepted", shipped: "Shipped", delivered: "Delivered", returnReceived: "Return received", refundSettled: "Refund settled", replacementCreated: "Replacement created", replacementShipped: "Replacement shipped", inventoryRestocked: "Inventory restocked", accountingPosted: "Accounting posted", inventoryQuarantined: "Inventory quarantined", caseClosed: "Case closed" };
export function NativeEventTimeline({ events = [], expected }: { events?: NativeFulfillmentEvent[]; expected: NativeFulfillmentEvent["kind"][] }) {
  const steps = expected.flatMap(kind => {
    const facts = events.filter(event => event.kind === kind);
    return facts.length ? facts.map((event, index) => ({ key: `${kind}-${index}`, title: nativeEventLabels[kind], state: event.state === "confirmed" ? "done" as const : event.state === "failed" ? "problem" as const : "pending" as const,
      note: `${event.state} · event ${event.eventAt ? new Date(event.eventAt).toLocaleString() : "Unknown"} · observed ${new Date(event.observedAt).toLocaleString()} · receipt ${event.receiptRef ?? "Unknown"}${event.reasonCode ? ` · ${event.reasonCode}` : ""}` })) : [{ key: kind, title: nativeEventLabels[kind], state: "pending" as const, note: "Unknown · no independent source receipt was returned." }];
  });
  return <Steps label="Independent fulfillment source events" steps={steps} />;
}
