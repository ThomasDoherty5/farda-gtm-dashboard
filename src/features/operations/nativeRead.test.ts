import { dispatchEligible, queueDetailPath, stockAvailable, stockLow, isOperationsRecordPath, oldestQueueFirst, operationsEvidenceLabel, operationsHref } from "./nativeRead";
import type { QueueRow } from "@/fixtures/operations";

it("prioritizes the oldest source wait before compact slicing with a deterministic identity tie-break", () => {
  const row = (ref: string, waitingHours: number): QueueRow => ({ ref, waitingHours, kind: "order", home: "H1", units: 1, hold: null });
  const shuffled = [row("latest", 2), row("older-b", 49), row("oldest", 80), row("older-a", 49)];
  expect(oldestQueueFirst(shuffled).slice(0, 3).map(r => r.ref)).toEqual(["oldest", "older-a", "older-b"]);
  expect(shuffled[0]!.ref).toBe("latest");
});
it("keeps only operational context in a record drilldown", () => {
  const href = operationsHref("/orders/source-order", new URLSearchParams("home=H2&days=7&scenario=paid&reason=private&customer=private&view=orders"));
  expect(href).toBe("/orders/source-order?home=H2&days=7");
});
it("does not call a synthetic native source production or demo evidence", () => {
  expect(operationsEvidenceLabel({ datasetKey: "operations-native", synthetic: true })).toBe("Synthetic source evidence");
  expect(operationsEvidenceLabel({ datasetKey: "operations-native" })).toBe("Evidence stage unknown");
});

it("rejects external and script destinations supplied as operational source links", () => {
  expect(isOperationsRecordPath("/orders/native-order")).toBe(true);
  expect(isOperationsRecordPath("https://example.com/private")).toBe(false);
  expect(isOperationsRecordPath("//example.com/private")).toBe(false);
  expect(isOperationsRecordPath("javascript:alert(1)")).toBe(false);
});

it("keeps unknown native stock and missing eligibility out of dispatch readiness", () => {
  const stock = { home: "H1" as const, onHand: null, reserved: 2, capacity: 20, threshold: 5 };
  expect(stockAvailable(stock)).toBeNull(); expect(stockLow(stock)).toBe(false);
  const row: QueueRow = { ref: "queue-ref", kind: "sample", home: "H1", waitingHours: 60, units: 1, hold: null };
  expect(dispatchEligible(row, true)).toBe(false);
  expect(queueDetailPath(row, true)).toBeNull();
  expect(queueDetailPath(row, false)).toBe("/orders/queue-ref");
});
