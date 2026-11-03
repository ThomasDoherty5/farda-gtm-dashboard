import { SCHEMA_VERSION, type DataState, type ReadRequest, type ReadResponse } from "./contract";

/** Builds a demo read response around one fixture. Sources and coverage are omitted because the data is synthetic. */
export function respondWith<T>(
  request: ReadRequest<unknown>,
  data: T,
  options: { dataVersion: string; dataState?: DataState; capabilities?: ReadResponse<T>["capabilities"] },
): ReadResponse<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    dataVersion: options.dataVersion,
    dataState: options.dataState ?? "ready",
    data,
    sourceFreshness: [],
    coverage: { expectedCount: null, observedCount: null, missingCount: null, complete: null, reasonCodes: [] },
    capabilities: options.capabilities ?? [],
    page: { nextCursor: null, hasMore: false },
    refresh: { nextPollAfterMs: null },
  };
}
