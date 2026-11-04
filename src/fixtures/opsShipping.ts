/**
 * Shipments, exception kinds and one linked sandbox chain for the Operations shipping view (OPS270-04, OPS270-08, FE09-05) — SYNTHETIC.
 * Every identifier is fictional. The chain reuses the refs in operations.ts and inventory.ts, so the three screens cannot drift.
 */
export type CarrierState = "labelCreated" | "inTransit" | "outForDelivery" | "deliveredUnconfirmed" | "delivered" | "lost" | "returned";
export type Shipment = { ref: string; orderRef: string; carrierState: CarrierState; lastScan: string | null };

/** "Delivered" counts only once the carrier confirms it. A delivered report awaiting confirmation is still in transit. */
export const isInTransit = (s: Shipment) => s.carrierState === "inTransit" || s.carrierState === "outForDelivery" || s.carrierState === "deliveredUnconfirmed";

export const shipmentsDemo: Shipment[] = [
  { ref: "TEST-SP-0087", orderRef: "TEST-SH-1031", carrierState: "inTransit", lastScan: "Oct 31, 9:10 AM · distribution center" },
  { ref: "TEST-SP-0088", orderRef: "TEST-SH-1033", carrierState: "outForDelivery", lastScan: "Nov 2, 7:45 AM · out for delivery" },
  { ref: "TEST-SP-0089", orderRef: "TEST-SH-1035", carrierState: "deliveredUnconfirmed", lastScan: "Nov 2, 10:20 AM · delivered, not yet confirmed by the carrier" },
  { ref: "TEST-SP-0090", orderRef: "TEST-SH-1036", carrierState: "delivered", lastScan: "Nov 1, 3:05 PM · delivered, confirmed" },
  { ref: "TEST-SP-0092", orderRef: "TEST-SH-1040", carrierState: "labelCreated", lastScan: null },
  { ref: "TEST-SP-0091", orderRef: "TEST-SH-1038", carrierState: "returned", lastScan: "Oct 30, 11:00 AM · returned to sender" },
  { ref: "TEST-SP-0093", orderRef: "TEST-SH-1042", carrierState: "lost", lastScan: "Oct 27, 4:32 PM · last scan" },
];

export type ExceptionKind = "aging" | "failedLabel" | "failedScan" | "duplicateShipment" | "stockShortage" | "uncertainRefund";
export type OpsException = { id: string; kind: ExceptionKind; ref: string; ageHours: number; detail: string; next: string; to: string };

export const EXCEPTION_KINDS: { kind: ExceptionKind; label: string; meaning: string }[] = [
  { kind: "aging", label: "Aging", meaning: "Waiting longer than the 48-hour warning" },
  { kind: "failedLabel", label: "Failed label", meaning: "The carrier label could not be created" },
  { kind: "failedScan", label: "Failed scan", meaning: "A carrier scan did not arrive when expected" },
  { kind: "duplicateShipment", label: "Duplicate shipment", meaning: "Two shipments exist for one order or sample" },
  { kind: "stockShortage", label: "Stock shortage", meaning: "Not enough available stock at the home" },
  { kind: "uncertainRefund", label: "Uncertain refund", meaning: "A refund was requested and its outcome is unknown" },
];

export const opsExceptionsDemo: OpsException[] = [
  { id: "EXC-1", kind: "aging", ref: "TEST-SH-1042", ageHours: 57.6, detail: "Waiting 2 days 10 hours at Home H1", next: "Open the order", to: "/orders/TEST-SH-1042" },
  { id: "EXC-2", kind: "aging", ref: "TEST-SC-0081", ageHours: 50.4, detail: "Waiting 2 days 2 hours at Home H2", next: "Open the sample", to: "/orders/TEST-SC-0081" },
  { id: "EXC-3", kind: "failedLabel", ref: "TEST-SH-1050", ageHours: 12, detail: "Label creation was rejected: address could not be verified", next: "Fix the order in Shopify", to: "/orders/TEST-SH-1050" },
  { id: "EXC-4", kind: "failedScan", ref: "TEST-SP-0087", ageHours: 70, detail: "No scan for 70 hours after the distribution-center scan", next: "Ask the carrier", to: "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129" },
  { id: "EXC-5", kind: "duplicateShipment", ref: "TEST-SC-0090", ageHours: 20, detail: "Two shipments reference this sample", next: "Cancel the extra label in the source", to: "/orders/TEST-SC-0090" },
  { id: "EXC-6", kind: "stockShortage", ref: "TEST-TT-1047", ageHours: 30, detail: "Not enough available stock at Home H2", next: "Transfer stock or choose another home", to: "/inventory" },
  { id: "EXC-7", kind: "uncertainRefund", ref: "TEST-SH-1038", ageHours: 40, detail: "The refund request has no provider receipt yet", next: "Reconcile before any second refund", to: "/returns/demo-returnId" },
];

/** One sandbox chain: an order, the sample it shares stock with, and the shortage that holds the sample, with the transfer that would clear it. */
export type ChainStep = { key: "order" | "sample" | "shortage" | "transfer"; label: string; ref: string; state: string; to: string };
export const sandboxChain: ChainStep[] = [
  { key: "order", label: "Sandbox order", ref: "TEST-SH-1042", state: "Waiting at Home H1", to: "/orders/TEST-SH-1042" },
  { key: "sample", label: "Linked sample", ref: "TEST-SC-0081", state: "Waiting at Home H2, 2 reserved", to: "/orders/TEST-SC-0081" },
  { key: "shortage", label: "Stock shortage", ref: "TEST-TT-1047", state: "Not enough available stock at Home H2", to: "/inventory" },
  { key: "transfer", label: "Transfer that clears it", ref: "TEST-TR-012", state: "In transit to Home H2 · receipt not confirmed", to: "/inventory" },
];
