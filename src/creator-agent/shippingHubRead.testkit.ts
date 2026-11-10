import { shippingHubDemo, SHIPPING_DEMO_NOW } from "../fixtures/shippingHub.ts";
import type { ShippingHubBinding, ShippingHubSnapshot, ShippingHubSource } from "./shippingHubRead.ts";
import { ShippingHubReadError } from "./shippingHubRead.ts";

/** Explicit synthetic owner projection for actual-service tests only. The production
 * service never imports this module or selects a demo scenario. */
export function shippingHubSourceFixture(binding: ShippingHubBinding, at: number, scenario = "default"): ShippingHubSnapshot {
  const offset = at - Date.parse(SHIPPING_DEMO_NOW);
  const demo = JSON.parse(JSON.stringify(shippingHubDemo(scenario)), (_key, value: unknown) =>
    typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) ? new Date(Date.parse(value) + offset).toISOString() : value) as ReturnType<typeof shippingHubDemo>;
  const observedAt = new Date(at).toISOString(), validUntil = new Date(at + 60_000).toISOString();
  return { binding, sourceRef: "synthetic-shipping-source", sourceVersion: "synthetic-v1", permissionVersion: "synthetic-access-v1", observedAt, validUntil,
    evidenceStage: "synthetic", timezone: "America/Los_Angeles", coverage: { state: "complete", expectedCount: demo.shipments.length, observedCount: demo.shipments.length, reasonCodes: [] },
    owners: (["shipping", "stock", "terms", "posting"] as const).map(kind => ({ kind, sourceRef: "synthetic-owner-" + kind, sourceVersion: "synthetic-v1", permissionVersion: "synthetic-access-v1",
      observedAt, validUntil, receiptRef: "synthetic-receipt-" + kind })), shipments: demo.shipments, stock: demo.stock };
}

export function shippingHubTestSource(now: () => number, scenario = "default"): ShippingHubSource {
  return { async read(binding) { return shippingHubSourceFixture(binding, now(), scenario); },
    assertCurrent(snapshot, binding) { if (snapshot.binding.principal.principalRef !== binding.principal.principalRef) throw new ShippingHubReadError("DENIED", 403); } };
}
