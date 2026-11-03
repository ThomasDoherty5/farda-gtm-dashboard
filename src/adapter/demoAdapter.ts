import type { FardaAdapter, ReadOptions } from "./adapter";
import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { createDemoApprovals } from "./demoApprovals";
import { respondWith } from "./demoViews";
import { discoveryDemo } from "@/fixtures/discovery";
import { AdapterError } from "./errors";
import { DEMO_NOW, overviewOriginal, type OverviewData, type OverviewFixtureKey } from "@/fixtures/overview";

/**
 * Deterministic demo adapter. Frozen clock, environment "demo", no network, no provider dispatch.
 * Approvals run on an in-memory state machine with labeled synthetic receipts (see demoApprovals).
 * Overview capabilities report "unverified" so nothing can look sent or paid.
 */
export function createDemoAdapter(opts: { fixture?: OverviewFixtureKey; latencyMs?: number } = {}): FardaAdapter {
  const fixture = opts.fixture ?? "FX-01-happy-read";
  const latencyMs = opts.latencyMs ?? 0;
  const approvals = createDemoApprovals();

  return {
    environment: "demo",
    kind: "demo",
    async readView<F, T>(request: ReadRequest<F>, options?: ReadOptions): Promise<ReadResponse<T>> {
      if (request.requestedScope.environment !== "demo")
        throw new AdapterError({ code: "FORBIDDEN", message: "Demo adapter only serves the demo environment.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
      await wait(latencyMs, options?.signal);
      if (request.viewKey === "approvalDetail") return approvals.readApproval(request as ReadRequest<{ approvalId: string }>) as ReadResponse<T>;
      if (request.viewKey === "runDetail") return approvals.readRun(request as ReadRequest<{ runId: string }>) as ReadResponse<T>;
      if (request.viewKey === "discoverySummary")
        return respondWith(request, discoveryDemo, { dataVersion: "discovery-demo@1", capabilities: [{ actionKind: "startLiveDiscovery", state: "unverified", reasonCodes: ["SOURCE_ACCESS_UNVERIFIED"] }] }) as ReadResponse<T>;
      if (request.viewKey !== "overviewSummary")
        throw new AdapterError({ code: "INTEGRATION_PENDING", message: `No demo fixture for view ${request.viewKey}.`, requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
      return overviewResponse(request, fixture) as ReadResponse<T>;
    },
    async submitAction<P>(request: ActionRequest<P>, options?: ReadOptions): Promise<ActionResponse> {
      if (request.requestedScope.environment !== "demo")
        throw new AdapterError({ code: "FORBIDDEN", message: "Demo adapter only serves the demo environment.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
      await wait(latencyMs, options?.signal);
      return approvals.submit(request);
    },
  };
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

function err(code: string, message: string, requestId: string): never {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: code === "SOURCE_UNAVAILABLE", retryAfterMs: null });
}

function overviewResponse<F>(request: ReadRequest<F>, fixture: OverviewFixtureKey): ReadResponse<OverviewData> {
  const base: ReadResponse<OverviewData> = {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    dataVersion: "overview-original@1",
    dataState: "ready",
    data: overviewOriginal,
    sourceFreshness: [
      {
        sourceRef: overviewOriginal.orders.sourceRef!,
        lastSourceSuccessAt: DEMO_NOW,
        observedAt: DEMO_NOW,
        mirroredAt: DEMO_NOW,
        staleReasonCode: null,
      },
    ],
    coverage: { expectedCount: 5, observedCount: 5, missingCount: 0, complete: true, reasonCodes: [] },
    capabilities: [{ actionKind: "requestReport", state: "unverified", reasonCodes: ["DEMO_NO_DISPATCH"] }],
    page: { nextCursor: null, hasMore: false },
    refresh: { nextPollAfterMs: null },
  };
  const d = overviewOriginal;
  switch (fixture) {
    case "FX-01-happy-read":
      return base;
    case "FX-02-known-zero":
      return { ...base, data: { ...d, attributedOrders: { ...d.attributedOrders, value: 0 }, attributedNetSales: { ...d.attributedNetSales, value: { minorUnits: 0, currency: "USD" } } } };
    case "FX-03-empty-filter":
      return { ...base, dataState: "empty", data: null, coverage: { ...base.coverage, expectedCount: 0, observedCount: 0 } };
    case "FX-04-missing-metric":
      return { ...base, data: { ...d, posts: d.posts.map((p) => ({ ...p, shares: null })) } };
    case "FX-05-partial-coverage":
      return { ...base, dataState: "partial", data: { ...d, posts: d.posts.slice(0, 3) }, coverage: { expectedCount: 5, observedCount: 3, missingCount: 2, complete: false, reasonCodes: ["SOURCE_ROWS_DEFERRED"] } };
    case "FX-06-stale-source":
      return { ...base, dataState: "stale", sourceFreshness: base.sourceFreshness.map((f) => ({ ...f, lastSourceSuccessAt: "2026-10-30T09:00:00.000Z", staleReasonCode: "SOURCE_SYNC_DELAYED" })) };
    case "FX-07-offline-read":
      return err("SOURCE_UNAVAILABLE", "The data service could not be reached.", request.requestId);
    case "FX-08-forbidden-account":
      return err("FORBIDDEN", "You do not have access to this account.", request.requestId);
    case "FX-09-expired-session":
      return err("SESSION_EXPIRED", "Your session expired. Sign in again.", request.requestId);
  }
}
