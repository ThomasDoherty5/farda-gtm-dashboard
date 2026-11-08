/** Test-only injected source answers. Records are the existing labelled synthetic operations fixtures; the service never serves them by default. */
import { fulfillmentDemo, operationsDemo, orderDemo, returnDemo, shippingExceptionDemo } from "../../fixtures/operations.ts";
import { opsExceptionsDemo, sandboxChain, shipmentsDemo } from "../../fixtures/opsShipping.ts";
import { buildOpsHealth } from "../../adapter/opsHealth.ts";
import type { OperationsReadViewKey } from "./contract.ts";

export const operationsReadTestScope = { workspaceId: "synthetic-operations-workspace", accountId: "synthetic-operations-account", environment: "sandbox" as const };
export const operationsReadTestTime = "2026-11-06T12:00:00.000Z";
export const operationsReadTestFilters: Record<OperationsReadViewKey, Record<string, string | number>> = {
  operationsOverview: {}, operationsShipping: {}, opsHealth: {}, fulfillmentAnalytics: { days: 14 },
  orderDetail: { orderId: "TEST-SH-1042" }, orderCustomer: { orderId: "TEST-SH-1042" },
  shippingException: { shipmentId: "TEST-SP-0093", exceptionId: "TEST-EVT-129" }, returnDetail: { returnId: "TEST-RET-028" },
};
/** Synthetic placeholder customer values. They exist only to prove what a reader role never receives. */
export const syntheticCustomer = { name: "Synthetic Customer 1042", email: "synthetic-1042@example.test", city: "Testville" };

export function operationsRecord(viewKey: OperationsReadViewKey): unknown {
  switch (viewKey) {
    case "operationsOverview": return structuredClone(operationsDemo);
    case "orderDetail": return orderDemo("TEST-SH-1042");
    case "orderCustomer": return { datasetKey: "operations-customer-demo", orderRef: "TEST-SH-1042", access: { state: "allowed", reason: null },
      revealed: { ...syntheticCustomer }, audit: [{ id: "CUST-AUD-1", at: "2026-11-06T10:00:00.000Z", role: "operations", orderRef: "TEST-SH-1042", reason: "Synthetic audited reveal." }] };
    case "shippingException": return shippingExceptionDemo("TEST-SP-0093", "TEST-EVT-129");
    case "returnDetail": return returnDemo("TEST-RET-028");
    case "fulfillmentAnalytics": return fulfillmentDemo(14);
    case "operationsShipping": return { datasetKey: "operations-shipping-demo", shipments: shipmentsDemo, exceptions: opsExceptionsDemo, chain: sandboxChain };
    case "opsHealth": return buildOpsHealth();
  }
}

export function operationsSnapshot(viewKey: OperationsReadViewKey, patch: Record<string, unknown> = {}) {
  return { scope: { ...operationsReadTestScope }, viewKey, version: "synthetic-operations-v1", observedAt: "2026-11-06T11:55:00.000Z",
    validUntil: "2026-11-06T12:10:00.000Z", coverage: { state: "complete", expectedCount: 1, observedCount: 1, reasonCodes: [] },
    record: operationsRecord(viewKey), ...patch };
}
