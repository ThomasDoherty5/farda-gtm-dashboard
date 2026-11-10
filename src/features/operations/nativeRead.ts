import type { QueueRow } from "@/fixtures/operations";

/** Stable order before any desktop/tablet/mobile page is sliced. */
export function oldestQueueFirst<T extends QueueRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const af = (a as NativeQueueRow).sourceFacts, bf = (b as NativeQueueRow).sourceFacts;
    return (af && bf ? Date.parse(af.requestedAt) - Date.parse(bf.requestedAt) : b.waitingHours - a.waitingHours) || a.ref.localeCompare(b.ref) || a.kind.localeCompare(b.kind);
  });
}
export function operationsEvidenceLabel(value: unknown): string {
  if (!value || typeof value !== "object") return "Source evidence unavailable";
  const data = value as { datasetKey?: unknown; synthetic?: unknown };
  return data.datasetKey === "operations-native" ? data.synthetic === true ? "Synthetic source evidence" : data.synthetic === false ? "Source evidence" : "Evidence stage unknown" : "Demo data";
}
/** Carry operational context, never fixture scenarios or customer information, into record drilldowns. */
export function operationsHref(path: string, search: URLSearchParams): string {
  const [pathname = path, rawQuery = ""] = path.split("?", 2);
  const params = new URLSearchParams();
  const view = new URLSearchParams(rawQuery).get("view");
  if (view && ["health", "hub", "overview", "orders", "shipping"].includes(view)) params.set("view", view);
  for (const name of ["home", "startAt", "endAt", "timezone", "days"]) {
    const value = search.get(name);
    if (value === null) continue;
    if (name === "home" && !["all", "H1", "H2", "H3"].includes(value)) continue;
    if (name === "days" && !["7", "14"].includes(value)) continue;
    if ((name === "startAt" || name === "endAt") && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) continue;
    if (name === "timezone") { try { new Intl.DateTimeFormat("en", { timeZone: value }); } catch { continue; } }
    params.set(name, value);
  }
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

/** Read-only source navigation may name existing internal records, never an arbitrary origin or script. */
export function isOperationsRecordPath(value: string): boolean {
  return /^\/(?:orders|shipments|returns|inventory|operations)(?:[/?#]|$)/.test(value) && !Array.from(value).some(character => character === "\\" || character.charCodeAt(0) <= 32);
}

export function operationsContext(search: URLSearchParams, value: unknown): URLSearchParams {
  const next = new URLSearchParams(search);
  if (!value || typeof value !== "object") return next;
  const data = value as { datasetKey?: unknown; reportingScope?: Record<string, unknown> };
  if (data.datasetKey === "operations-native" && data.reportingScope) for (const name of ["home", "startAt", "endAt", "timezone"]) {
    const field = data.reportingScope[name];
    if (typeof field === "string") next.set(name, field);
  }
  return next;
}

export type NativeQueueRow = QueueRow & { sourceFacts?: import("@/adapter/viewSchemas/nativeOperations").DispatchSourceFacts | null };
export type OperationsStock = { home: import("@/fixtures/operations").Home; onHand: number | null; reserved: number | null; capacity: number | null; threshold: number | null };
export type OperationsOverviewRead = Omit<import("@/fixtures/operations").OperationsOverview, "datasetKey" | "stock" | "queue"> & {
  datasetKey: "operations-demo" | "operations-native";
  stock: OperationsStock[];
  queue: { rows: NativeQueueRow[]; total: number };
  summaryBasis?: import("@/adapter/viewSchemas/nativeOperations").OperationsSummaryBasis | null;
  reportingScope?: import("@/adapter/viewSchemas/nativeOperations").OperationsReportingScope | null;
};
export function stockAvailable(stock: OperationsStock): number | null {
  return stock.onHand === null || stock.reserved === null ? null : stock.onHand - stock.reserved;
}
export function stockLow(stock: OperationsStock): boolean {
  const available = stockAvailable(stock);
  return available !== null && stock.threshold !== null && available < stock.threshold;
}
export function queueDetailPath(row: NativeQueueRow, native: boolean): string | null {
  const ref = native ? row.sourceFacts?.detailRef : row.ref;
  return ref ? `/orders/${encodeURIComponent(ref)}` : null;
}
export function dispatchEligible(row: NativeQueueRow, native: boolean): boolean {
  if (row.hold) return false;
  if (!native) return true;
  const f = row.sourceFacts;
  return !!f && f.canceled === false && f.identityResolved === true && f.stockAvailable === true && f.labelCreated === false && (row.kind === "order" ? f.orderRef !== null && f.orderUnfulfilled === true : f.sampleRef !== null && f.sampleApproved === true);
}
