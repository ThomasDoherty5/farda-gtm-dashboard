/**
 * Inventory fixtures (Figma source 7:129) — SYNTHETIC. One SKU across three homes. Physical on-hand comes from movements;
 * Shopify's observed count is a separate snapshot and can disagree. Reserving a sample moves Reserved and Available, never on-hand.
 * The Operations fixtures read their stock from here, so the two screens can't disagree. Do not mix with finance or support data.
 */
import type { ProvenanceValue } from "@/adapter/contract";
import type { Home } from "./operations";
import { known, unknown } from "./values";

export const DEMO_SKU = "FARDA-GRAPHITE";

/** The movement-derived balance and its thresholds for each home. */
export const HOME_STOCK: { home: Home; onHand: number; reserved: number; capacity: number; threshold: number }[] = [
  { home: "H1", onHand: 100, reserved: 14, capacity: 120, threshold: 20 },
  { home: "H2", onHand: 28, reserved: 10, capacity: 80, threshold: 20 },
  { home: "H3", onHand: 68, reserved: 4, capacity: 100, threshold: 20 },
];

export type StockRow = {
  home: Home;
  sku: string;
  /** From the movement ledger. */
  onHand: number;
  reserved: number;
  threshold: number;
  /** Shopify's own count of the location, a snapshot. Null means it was not read. */
  shopifyObserved: ProvenanceValue<number>;
};

export type Movement = {
  key: string;
  type: string;
  home: Home;
  /** What the movement changes. "available" movements are reservations and leave physical on-hand alone. */
  effect: { field: "available" | "onHand"; delta: number };
  /** A movement without its receipt is excluded from balances until it completes. */
  complete: boolean;
  missing?: string;
};

export type Transfer = {
  key: string;
  from: Home;
  to: Home;
  expectedUnits: number;
  /** Unknown until the destination confirms. It is never shown as zero. */
  receivedUnits: ProvenanceValue<number>;
  stage: "requested" | "dispatched" | "received";
};

export type TransferRequest = { key: string; from: Home; to: Home; units: number; reason: string; state: string };

export type InventoryOverview = {
  datasetKey: "inventory-demo";
  version: string;
  sku: string;
  syncedMinutesAgo: number | null;
  rows: StockRow[];
  movements: Movement[];
  transfer: Transfer;
  pendingRequests: TransferRequest[];
};

export const STAGES: Transfer["stage"][] = ["requested", "dispatched", "received"];
export const availableOf = (r: { onHand: number; reserved: number }) => r.onHand - r.reserved;

export const inventoryDemo = (scenario?: string): InventoryOverview => ({
  datasetKey: "inventory-demo",
  version: "inv1",
  sku: DEMO_SKU,
  syncedMinutesAgo: scenario === "stale" ? 190 : 5,
  rows: HOME_STOCK.map((s) => ({
    home: s.home,
    sku: DEMO_SKU,
    onHand: s.onHand,
    reserved: s.reserved,
    threshold: s.threshold,
    shopifyObserved: scenario === "conflict" && s.home === "H2" ? known(30) : scenario === "unread" && s.home === "H3" ? unknown("SHOPIFY_NOT_READ") : known(s.onHand),
  })),
  movements: [
    { key: "TEST-MOV-0188", type: "Sample reserve", home: "H2", effect: { field: "available", delta: -2 }, complete: true },
    { key: "TEST-MOV-0187", type: "Customer shipment", home: "H1", effect: { field: "onHand", delta: -1 }, complete: true },
    { key: "TEST-MOV-0186", type: "Return inspected", home: "H3", effect: { field: "onHand", delta: 1 }, complete: true },
    ...(scenario === "delayed" ? [{ key: "TEST-MOV-0189", type: "Transfer received", home: "H2" as Home, effect: { field: "onHand" as const, delta: 24 }, complete: false, missing: "Receipt not recorded" }] : []),
  ],
  transfer: { key: "TEST-TR-012", from: "H1", to: "H2", expectedUnits: 24, receivedUnits: unknown("RECEIPT_NOT_CONFIRMED"), stage: "dispatched" },
  pendingRequests: [],
});
