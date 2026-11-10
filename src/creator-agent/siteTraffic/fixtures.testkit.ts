import { AgentStore } from "../store.ts";
import { digest } from "../config.ts";
import { nextTrafficDay, trafficReportSchema, type TrafficAggregateBinding, type TrafficAuthority, type TrafficBinding, type TrafficCapability, type TrafficClickAggregate, type TrafficImportPrincipal, type TrafficOrderAggregate, type TrafficReportEnvelope } from "./contract.ts";
import { createSiteTrafficService } from "./service.ts";
import { SiteTrafficError, type CreatorClickSource, type MatchingCommerceSource, type SiteTrafficSource } from "./source.ts";

export const trafficTestRef = (label: string): string => "ref:" + digest(["fictional-traffic-only", label]);
export const trafficTestScope = { workspaceId: "fictional-traffic-workspace", accountId: "fictional-traffic-account", environment: "sandbox" as const };
export const trafficTestPrincipal = { principalRef: "fictional-traffic-reader" };
export const trafficTestMachine: TrafficImportPrincipal = { principalRef: "fictional-traffic-importer", kind: "machine", bindingRef: trafficTestRef("machine-binding"), grantVersion: digest("fictional-machine-v1") };
export const trafficTestKey = "fictional-site-traffic-reference-key-not-a-secret";
function fictionalCalendarDay(stamp: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(stamp).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function fictionalMidnight(day: string): string {
  const target = Date.parse(day + "T00:00:00Z"); let candidate = target;
  for (let step = 0; step < 3; step++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(candidate).map(part => [part.type, part.value]));
    const represented = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    candidate = target - (represented - candidate);
  }
  return new Date(candidate).toISOString();
}

/** Application/aggregate parser evidence only. Every report stays explicitly synthetic; no Shopify grant or actual import is implied. */
export function siteTrafficFixture(options: { now?: number; databasePath?: string } = {}) {
  const stamp = options.now ?? Date.parse("2026-11-09T12:00:00Z");
  const report = trafficReportSchema.parse({ schemaVersion: "shopify-traffic-normalized.v1", definition: {
    definitionRef: trafficTestRef("definition"), version: digest("fictional-definition-v1"), provider: "shopifyAnalytics", sourceAccountRef: trafficTestRef("shopify-account"), transport: "reportExport", reportRef: trafficTestRef("report"), reportVersion: digest("fictional-report-v1"),
    timezone: "America/Los_Angeles", measurementVersion: digest("fictional-session-measurement-v1"), filterHash: digest("fictional-bot-excluded-filter"), botFilter: "excluded", dailyAggregation: "sourceQualifiedAdditiveDailyCounts", sessionCohortRef: trafficTestRef("session-cohort"), freshnessMaxAgeMs: 7 * 86_400_000,
    counters: { sessions: "sessions", cartSessions: "sessions_with_cart_additions", checkoutSessions: "sessions_that_reached_checkout", completedCheckoutSessions: "sessions_that_completed_checkout", sessionUnit: "uniqueSessions", eventUnit: "events" },
    segments: [{ kind: "all" }, { kind: "utm", key: digest("fictional-creator-campaign"), channel: "creator", campaign: "campaign" }],
  }, partitions: [{ day: "2026-11-08", startAt: "2026-11-08T08:00:00Z", endAt: "2026-11-09T08:00:00Z", revision: 1, coverage: "complete", observedThrough: "2026-11-09T08:00:00Z", replaceSegments: true, sourceAsOf: "2026-11-09T08:00:00Z", sessionCohortRef: trafficTestRef("session-cohort"), rows: [
    { segment: { kind: "all" }, counters: { sessions: 16000, cartSessions: 1600, checkoutSessions: 400, completedCheckoutSessions: 160, productViewEvents: 3, cartAddEvents: 5000 } },
    { segment: { kind: "utm", key: digest("fictional-creator-campaign"), channel: "creator", campaign: "campaign" }, counters: { sessions: 3000, cartSessions: 100, checkoutSessions: 50, completedCheckoutSessions: 25, productViewEvents: null, cartAddEvents: null } },
  ] }] });
  // HTTP/browser fixtures use an explicitly fictional LA calendar relative to
  // their real runner clock; a future test run must not inherit stale Nov8 data.
  if (options.now !== undefined) {
    const endDay = fictionalCalendarDay(stamp), day = new Date(Date.parse(endDay + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
    Object.assign(report.partitions[0]!, { day, startAt: fictionalMidnight(day), endAt: fictionalMidnight(endDay), observedThrough: fictionalMidnight(endDay), sourceAsOf: fictionalMidnight(endDay) });
  }
  const state = { now: stamp, sourceVersion: digest("fictional-source-v1"), permissionVersion: digest("fictional-permission-v1"), denied: false, machineDenied: false, canImport: true,
    capabilityState: "ready" as TrafficCapability["state"], report, sourceReads: 0, importReads: 0, callerChecks: 0,
    beforeCapability: null as (() => void | Promise<void>) | null, beforeReport: null as (() => void | Promise<void>) | null,
    beforeOrders: null as (() => void | Promise<void>) | null, beforeClicks: null as (() => void | Promise<void>) | null,
    ordersTransform: null as ((value: TrafficOrderAggregate) => unknown) | null, clicksTransform: null as ((value: TrafficClickAggregate) => unknown) | null,
    capabilityTransform: null as ((value: TrafficCapability) => unknown) | null, rawBody: null as string | null,
  };
  function authority(binding: TrafficBinding, owner = "traffic"): TrafficAuthority {
    return { binding: structuredClone(binding), permissionVersion: state.permissionVersion, sourceVersion: state.sourceVersion, observedAt: new Date(state.now).toISOString(), validUntil: new Date(state.now + 300_000).toISOString(), provenance: { evidenceStage: "synthetic", synthetic: true, qualificationRef: trafficTestRef(owner + "-fictional-proof") } };
  }
  function assert(authority: TrafficAuthority, binding: TrafficBinding) {
    if (state.denied || digest(authority.binding) !== digest(binding)) throw new SiteTrafficError("TRAFFIC_SOURCE_DENIED", 403);
    if (authority.sourceVersion !== state.sourceVersion || authority.permissionVersion !== state.permissionVersion) throw new SiteTrafficError("TRAFFIC_SOURCE_CHANGED");
    if (binding.request.operation === "import" && (!state.canImport || state.machineDenied || !("kind" in binding.principal) || binding.principal.bindingRef !== trafficTestMachine.bindingRef || binding.principal.grantVersion !== trafficTestMachine.grantVersion)) throw new SiteTrafficError("TRAFFIC_IMPORT_DENIED", 403);
  }
  const source: SiteTrafficSource = {
    async readCapability(binding) {
      state.sourceReads++; await state.beforeCapability?.();
      const partition = state.report.partitions[0]!;
      const currentWindow = { startDay: partition.day, endDayExclusive: nextTrafficDay(state.report.partitions.at(-1)!.day), timezone: state.report.definition.timezone, startAt: partition.startAt, endAt: state.report.partitions.at(-1)!.endAt };
      const value: TrafficCapability = { authority: authority(binding), state: state.capabilityState, canImport: state.capabilityState === "ready" && state.canImport, definition: state.capabilityState === "ready" ? state.report.definition : null, currentWindow: state.capabilityState === "ready" ? currentWindow : null, reasonCodes: state.capabilityState === "ready" ? [] : ["ACCESS_UNSUPPORTED"] };
      return state.capabilityTransform ? state.capabilityTransform(structuredClone(value)) : structuredClone(value);
    },
    async readReport(binding) { state.importReads++; await state.beforeReport?.(); if (binding.request.operation !== "import") throw new SiteTrafficError("TRAFFIC_IMPORT_DENIED", 403);
      const value: TrafficReportEnvelope = { authority: authority(binding), importRef: binding.request.input.importRef, format: "normalized-json-v1", body: state.rawBody ?? JSON.stringify(state.report) }; return value; },
    assertCurrent(snapshot, binding) { assert(snapshot.authority, binding); },
  };
  const orders: MatchingCommerceSource = {
    async readAggregate(request) { await state.beforeOrders?.(); const value: TrafficOrderAggregate = { authority: authority(request.binding, "orders"), request: structuredClone(request), origin: "shopifyStorefrontOrigin", excludedOrigins: ["tiktokShop", "tiktokMirrors"], count: request.segment.kind === "all" ? 260 : 30, coverageThrough: request.coverageThrough!, coverage: Date.parse(request.coverageThrough!) === Date.parse(request.window.endAt) ? "complete" : "partial" }; return state.ordersTransform ? state.ordersTransform(value) : value; },
    assertCurrent(snapshot, binding) { assert(snapshot.authority, binding.binding); },
  };
  const clicks: CreatorClickSource = {
    async readAggregate(request: TrafficAggregateBinding) { await state.beforeClicks?.(); const value: TrafficClickAggregate = { authority: authority(request.binding, "clicks"), request: structuredClone(request), measure: "creatorTrackedClicks", count: 7000, coverage: "complete", attribution: request.segment.kind === "all" ? "allTraffic" : "sourceApprovedUtm", sourceAsOf: new Date(state.now).toISOString(), reasonCodes: [] }; return state.clicksTransform ? state.clicksTransform(value) : value; },
    assertCurrent(snapshot, binding) { assert(snapshot.authority, binding.binding); },
  };
  const store = new AgentStore(options.databasePath ?? ":memory:", trafficTestScope);
  const bindings = { scope: trafficTestScope, referenceKey: trafficTestKey, source, orders, clicks, now: () => state.now };
  const create = () => createSiteTrafficService({ db: store.database, ...bindings });
  const service = create(), input = { importRef: trafficTestRef("import-1"), requestKey: trafficTestRef("request-1"), expectedDefinitionVersion: report.definition.version };
  const filters = { period: null, segment: { kind: "all" as const } };
  const caller = { assertCallerCurrent() { state.callerChecks++; if (state.machineDenied) throw new SiteTrafficError("TRAFFIC_IMPORT_CALLER_DENIED", 403); } };
  return { state, source, orders, clicks, bindings, store, create, service, input, filters, principal: trafficTestPrincipal, machine: trafficTestMachine, caller, close: () => store.close() };
}
