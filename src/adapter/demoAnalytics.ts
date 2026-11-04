import type { ReadRequest, ReadResponse } from "./contract";
import { respondWith } from "./demoViews";
import { AdapterError } from "./errors";
import {
  attributionDemo,
  campaignFunnelDemo,
  customerJourneyDemo,
  launchControlDemo,
  launchSnapshotDemo,
  paidMediaDemo,
  unknown,
  type AttributionData,
  type CampaignFunnelData,
  type CustomerJourneyData,
  type LaunchControlData,
  type LaunchSnapshotData,
  type PaidMediaData,
  type RightsState,
} from "@/fixtures/analytics";
import type { OverviewFixtureKey } from "@/fixtures/overview";

export const analyticsViewKeys = ["launchSnapshot", "launchControl", "attribution", "paidMedia", "campaignFunnel", "customerJourney"] as const;
export type AnalyticsViewKey = (typeof analyticsViewKeys)[number];
export const isAnalyticsView = (key: string): key is AnalyticsViewKey => (analyticsViewKeys as readonly string[]).includes(key);

export type PaidMediaFilters = { rights: "all" | RightsState; platform: "all" | "meta" | "tiktok" };
export type CampaignFunnelFilters = { campaignId: string; cohort: "first-wave" | "launch-a" };

const fail = (code: string, message: string, requestId: string): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: code === "SOURCE_UNAVAILABLE", retryAfterMs: null });
};

/**
 * Demo reads for the analytics screens. They honor the same fixture switches as the Overview, so each screen can be
 * driven into empty, partial, stale, missing-metric, offline, denied and expired-session states.
 */
export function readAnalyticsView<T>(request: ReadRequest<unknown>, fixture: OverviewFixtureKey): ReadResponse<T> {
  const key = request.viewKey as AnalyticsViewKey;
  const make = <D>(data: D, version: string, degrade?: (d: D) => D): ReadResponse<D> => {
    if (fixture === "FX-07-offline-read") return fail("SOURCE_UNAVAILABLE", "The data service could not be reached.", request.requestId);
    if (fixture === "FX-08-forbidden-account") return fail("FORBIDDEN", "You do not have access to this account.", request.requestId);
    if (fixture === "FX-09-expired-session") return fail("SESSION_EXPIRED", "Your session expired. Sign in again.", request.requestId);
    const base = respondWith(request, data, { dataVersion: version, capabilities: [{ actionKind: "recordDecision", state: "unverified", reasonCodes: ["DEMO_NO_DISPATCH"] }] });
    switch (fixture) {
      case "FX-03-empty-filter":
        return { ...base, dataState: "empty", data: null, coverage: { ...base.coverage, expectedCount: 0, observedCount: 0 } };
      case "FX-04-missing-metric":
        return { ...base, data: degrade ? degrade(data) : data };
      case "FX-05-partial-coverage":
        return { ...base, dataState: "partial", coverage: { expectedCount: 5, observedCount: 3, missingCount: 2, complete: false, reasonCodes: ["SOURCE_ROWS_DEFERRED"] } };
      case "FX-06-stale-source":
        return {
          ...base,
          dataState: "stale",
          sourceFreshness: [{ sourceRef: { source: "demo", accountId: request.requestedScope.accountIds[0] ?? "demo", sourceId: null, canonicalId: null, url: null, identityState: "resolved", provenanceRef: `demo:${key}` }, lastSourceSuccessAt: "2026-10-30T09:00:00.000Z", observedAt: "2026-10-30T09:00:00.000Z", mirroredAt: "2026-10-30T09:00:00.000Z", staleReasonCode: "SOURCE_SYNC_DELAYED" }],
        };
      default:
        return base;
    }
  };

  switch (key) {
    case "launchSnapshot":
      return make<LaunchSnapshotData>(launchSnapshotDemo, "launch-snapshot-demo@1", (d) => ({ ...d, conversations: unknown("SOURCE_ROWS_MISSING") })) as ReadResponse<T>;
    case "launchControl":
      return make<LaunchControlData>(launchControlDemo, "launch-control-demo@1") as ReadResponse<T>;
    case "attribution":
      return make<AttributionData>(attributionDemo, "overview-original@1", (d) => ({ ...d, tiktokPlatformRoas: unknown("PLATFORM_SPEND_MISSING"), contribution: unknown("LANDED_COST_INCOMPLETE") })) as ReadResponse<T>;
    case "paidMedia": {
      const f = request.filters as Partial<PaidMediaFilters>;
      const assets = paidMediaDemo.assets.filter((a) => (!f.rights || f.rights === "all" || a.rights === f.rights) && (!f.platform || f.platform === "all" || a.platform === f.platform));
      return make<PaidMediaData>({ ...paidMediaDemo, assets }, "paid-media-demo@1", (d) => ({ ...d, assets: d.assets.map((a) => (a.id === "AD-04" ? { ...a, rights: "unknown" as const } : a)) })) as ReadResponse<T>;
    }
    case "campaignFunnel": {
      const f = request.filters as Partial<CampaignFunnelFilters>;
      if (f.cohort === "launch-a") {
        const empty = make<CampaignFunnelData>({ ...campaignFunnelDemo, cohort: { key: "launch-a", label: "Launch A monitoring" }, campaigns: [] }, "campaign-funnel-demo@1");
        return { ...empty, dataState: empty.dataState === "ready" ? "empty" : empty.dataState, data: null } as ReadResponse<T>;
      }
      return make<CampaignFunnelData>(campaignFunnelDemo, "campaign-funnel-demo@1") as ReadResponse<T>;
    }
    case "customerJourney":
      return make<CustomerJourneyData>(customerJourneyDemo, "customer-journey-demo@1", (d) => ({ ...d, sessions: unknown("SESSIONS_SOURCE_UNSELECTED"), deliveredUnits: unknown("NO_DELIVERED_COHORT"), reviews: { ...d.reviews, ratedCount: unknown("RATINGS_FEED_UNAVAILABLE") } })) as ReadResponse<T>;
  }
}
