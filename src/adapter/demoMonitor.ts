import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { respondWith } from "./demoViews";
import { AdapterError } from "./errors";
import {
  DEMO_RUN_HOURLY_ID,
  contentMonitorDemo,
  hourlyRunDemo,
  monitorPosts,
  postPerformanceDemo,
  watchlistDemo,
  type ContentMonitorData,
  type HourlyRunData,
  type IntakeSource,
  type MonitoringState,
  type Network,
  type PostPerformanceData,
  type WatchlistData,
} from "@/fixtures/monitor";
import type { OverviewFixtureKey } from "@/fixtures/overview";

export const monitorViewKeys = ["contentMonitor", "watchlist", "hourlyRun", "postPerformance"] as const;
export const isMonitorView = (key: string) => (monitorViewKeys as readonly string[]).includes(key);

export type MonitorFilters = { source: "all" | IntakeSource; network: "all" | Network; window: "last-30" | "last-7"; q: string };
export type WatchlistFilters = { source: "all" | IntakeSource; state: "all" | MonitoringState; cohort: "all" | "launch-a" };

const fail = (code: string, message: string, requestId: string): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: code === "SOURCE_UNAVAILABLE", retryAfterMs: null });
};

export function readMonitorView<T>(request: ReadRequest<unknown>, fixture: OverviewFixtureKey): ReadResponse<T> {
  if (fixture === "FX-07-offline-read") fail("SOURCE_UNAVAILABLE", "The data service could not be reached.", request.requestId);
  if (fixture === "FX-08-forbidden-account") fail("FORBIDDEN", "You do not have access to this account.", request.requestId);
  if (fixture === "FX-09-expired-session") fail("SESSION_EXPIRED", "Your session expired. Sign in again.", request.requestId);
  const make = <D>(data: D, version: string, degrade?: (d: D) => D): ReadResponse<D> => {
    const base = respondWith(request, data, { dataVersion: version, capabilities: [{ actionKind: "retryMonitorProfile", state: "unverified", reasonCodes: ["SOURCE_LOGIN_REQUIRED"] }] });
    switch (fixture) {
      case "FX-03-empty-filter": return { ...base, dataState: "empty", data: null, coverage: { ...base.coverage, expectedCount: 0, observedCount: 0 } };
      case "FX-04-missing-metric": return { ...base, data: degrade ? degrade(data) : data };
      case "FX-05-partial-coverage": return { ...base, dataState: "partial", coverage: { expectedCount: 9, observedCount: 5, missingCount: 4, complete: false, reasonCodes: ["POST_SNAPSHOTS_UNAVAILABLE"] } };
      case "FX-06-stale-source": return { ...base, dataState: "stale", sourceFreshness: [{ sourceRef: { source: "monitor", accountId: request.requestedScope.accountIds[0] ?? "demo", sourceId: null, canonicalId: null, url: null, identityState: "resolved", provenanceRef: "demo:monitor" }, lastSourceSuccessAt: "2026-10-30T09:00:00.000Z", observedAt: "2026-10-30T09:00:00.000Z", mirroredAt: "2026-10-30T09:00:00.000Z", staleReasonCode: "SOURCE_SESSION_EXPIRED" }] };
      default: return base;
    }
  };

  switch (request.viewKey) {
    case "contentMonitor": {
      const f = request.filters as Partial<MonitorFilters>;
      const q = (f.q ?? "").trim().toLowerCase();
      const live = f.window !== "last-7";
      const posts = monitorPosts
        .filter((p) => (!f.source || f.source === "all" || p.source === f.source) && (!f.network || f.network === "all" || p.network === f.network) && (!q || p.handle.toLowerCase().includes(q) || p.postId.toLowerCase().includes(q)))
        // A window with no snapshot has no counts. They are unknown, never zero.
        .map((p) => (live ? p : { ...p, views: null, interactions: null, orders: null, netSales: null }));
      const filtered = posts.length !== monitorPosts.length;
      const data: ContentMonitorData = {
        ...contentMonitorDemo,
        posts,
        windowLabel: live ? "Last 30 days" : "Last 7 days",
        windowAvailable: live,
        attributedOrders: live && !filtered ? contentMonitorDemo.attributedOrders : live ? posts.reduce((s, p) => s + (p.orders ?? 0), 0) : null,
        attributedNetSales: live && !filtered ? contentMonitorDemo.attributedNetSales : live ? { minorUnits: posts.reduce((s, p) => s + (p.netSales?.minorUnits ?? 0), 0), currency: "USD" } : null,
      };
      return make(data, "monitor-demo@1", (d) => ({ ...d, posts: d.posts.map((p, i) => (i === 3 ? { ...p, interactions: null } : p)) })) as ReadResponse<T>;
    }
    case "watchlist": {
      const f = request.filters as Partial<WatchlistFilters>;
      const rows = watchlistDemo.rows.filter((r) => (!f.source || f.source === "all" || r.intake === f.source) && (!f.state || f.state === "all" || r.state === f.state) && (!f.cohort || f.cohort === "all" || r.cohort === f.cohort));
      return make<WatchlistData>({ ...watchlistDemo, rows }, "watchlist-demo@1") as ReadResponse<T>;
    }
    case "hourlyRun": {
      const { runId } = request.filters as { runId: string };
      if (runId !== DEMO_RUN_HOURLY_ID) fail("RECORD_NOT_FOUND", "This isn't an hourly monitoring run.", request.requestId);
      return make<HourlyRunData>(hourlyRunDemo, "hourly-run-demo@1") as ReadResponse<T>;
    }
    default: {
      const { postId } = request.filters as { postId: string };
      const p = monitorPosts.find((m) => m.postId === postId) ?? fail("RECORD_NOT_FOUND", "This post does not exist or was removed.", request.requestId);
      const full = postId === postPerformanceDemo.postId;
      const data: PostPerformanceData = full
        ? postPerformanceDemo
        : {
            ...postPerformanceDemo,
            postId,
            handle: p.handle,
            network: p.network === "tiktok" ? "TikTok" : "Instagram",
            views: p.views,
            interactions: p.interactions ? { ...p.interactions, saves: null, uniqueReach: null } : null,
            orders: p.orders,
            netSales: p.netSales,
            // Only P-001 has a reported GMV figure; an Instagram post has no TikTok Shop checkout, so GMV does not apply to it.
            gmv: p.network === "tiktok" ? { state: "not-reported" } : { state: "not-applicable" },
            // Only P-001 has consecutive snapshots in this demo.
            dailyDeltas: [],
            details: { creatorId: "Not in this demo", contentId: "Not in this demo", intake: p.source === "tiktok-affiliate" ? "TikTok affiliate" : "Social Cat", metricSource: "Linked post snapshot", salesSource: "Reconciled orders" },
          };
      return make<PostPerformanceData>(data, `post-${postId}@1`, (d) => ({ ...d, views: null, interactions: null })) as ReadResponse<T>;
    }
  }
}

/**
 * Retry of one failed read-only monitoring profile. The demo's TikTok session is expired, so the service answers blocked
 * with a login-required reason: nothing ran, nothing was resent, and no outbound action is possible from here.
 */
export function retryMonitorProfile(request: ActionRequest<{ profile: string }>): ActionResponse {
  const failed = hourlyRunDemo.profiles.failed;
  if (request.expectedVersion !== hourlyRunDemo.version) throw new AdapterError({ code: "STALE_VERSION", message: "This run changed. Reload it before retrying.", requestId: request.requestId, correlationId: `demo-${request.requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", currentVersion: hourlyRunDemo.version });
  if (!failed || request.payload.profile !== failed.handle) throw new AdapterError({ code: "VALIDATION_FAILED", message: "Only the profile that failed in this run can be retried.", requestId: request.requestId, correlationId: `demo-${request.requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    actionRef: `retry-${request.idempotencyKey.slice(0, 8)}`,
    state: "blocked",
    runRef: hourlyRunDemo.runId,
    approvalRef: null,
    manifestRef: null,
    payloadVersion: "retry-1",
    policyVersion: "monitor-readonly-1",
    modelVersion: null,
    offerVersion: null,
    reasonCodes: ["SOURCE_LOGIN_REQUIRED"],
    receiptRefs: [],
    nextAction: { kind: "reconnectSource", ownerRef: null, dueAt: null, available: true },
    nextPollAfterMs: null,
  };
}
