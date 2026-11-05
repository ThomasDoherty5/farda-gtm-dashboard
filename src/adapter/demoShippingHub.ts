import { shippingHubDemo } from "@/fixtures/shippingHub";
import type { ReadRequest, ReadResponse } from "./contract";
import { respondWith } from "./demoViews";
import { AdapterError } from "./errors";

export function readShippingHub(request: ReadRequest<unknown>): ReadResponse<unknown> | null {
  if (request.viewKey !== "shippingHub") return null;
  const scenario = (request.filters as { scenario?: string } | null)?.scenario ?? "default";
  if (scenario === "unavailable" || scenario === "forbidden") throw new AdapterError({ code: scenario === "forbidden" ? "FORBIDDEN" : "SOURCE_UNAVAILABLE", message: scenario === "forbidden" ? "You cannot access this shipping scope." : "The shipping source is unavailable.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
  const data = shippingHubDemo(scenario);
  const result = respondWith(request, data, { dataVersion: `shipping-hub-${scenario}@1`, dataState: scenario === "partial" ? "partial" : scenario === "stale" ? "stale" : scenario === "empty" ? "empty" : "ready", capabilities: [] });
  result.coverage = { expectedCount: scenario === "partial" ? 6 : data.shipments.length, observedCount: data.shipments.length, missingCount: scenario === "partial" ? 2 : 0, complete: scenario !== "partial", reasonCodes: scenario === "partial" ? ["SOURCE_ROWS_DEFERRED"] : [] };
  return result;
}
