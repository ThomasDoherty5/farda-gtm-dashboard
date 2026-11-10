import type { TrafficAggregateBinding, TrafficAuthority, TrafficBinding, TrafficCapability, TrafficClickAggregate, TrafficOrderAggregate, TrafficReportEnvelope } from "./contract.ts";

export const TRAFFIC_SOURCE_MAX_LEASE_MS = 15 * 60_000;
const publicCodes = new Set(["DATABASE_SCOPE_MISMATCH", "INVALID_CLOCK", "REQUEST_CANCELLED", "SOURCE_READ_TIMEOUT",
  "TRAFFIC_TIMEOUT_INVALID", "TRAFFIC_REFERENCE_KEY_INVALID", "TRAFFIC_SOURCE_BINDING_DENIED", "TRAFFIC_SOURCE_STALE", "TRAFFIC_SOURCE_FENCE_UNAVAILABLE", "TRAFFIC_SOURCE_DENIED", "TRAFFIC_SOURCE_CHANGED", "TRAFFIC_SOURCE_UNAVAILABLE", "TRAFFIC_SOURCE_UNCONFIGURED", "TRAFFIC_CAPABILITY_INVALID",
  "TRAFFIC_IMPORT_REQUEST_INVALID", "TRAFFIC_IMPORT_CALLER_DENIED", "TRAFFIC_IMPORT_DENIED", "TRAFFIC_IMPORT_KEY_REUSED", "TRAFFIC_IMPORT_CHANGED", "TRAFFIC_RECEIPT_CHANGED", "TRAFFIC_RECEIPT_INTEGRITY_INVALID", "TRAFFIC_DEFINITION_CHANGED", "TRAFFIC_DEFINITION_VERSION_REUSED",
  "TRAFFIC_REPORT_INVALID", "TRAFFIC_REPORT_TOO_LARGE", "TRAFFIC_REPORT_BINDING_CHANGED", "TRAFFIC_REPORT_FUTURE", "TRAFFIC_REVISION_CONFLICT", "TRAFFIC_OLDER_REVISION", "TRAFFIC_FILTERS_INVALID", "TRAFFIC_PRINCIPAL_DENIED", "TRAFFIC_WINDOW_CHANGED", "TRAFFIC_SEGMENT_CHANGED", "TRAFFIC_PUBLICATION_EXPIRED"]);
export class SiteTrafficError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) {
    const known = publicCodes.has(code), safeCode = known ? code : "TRAFFIC_SOURCE_UNAVAILABLE";
    super(safeCode); this.code = safeCode;
    this.status = (known || status === 401 || status === 403) && [400, 401, 403, 409, 422, 429, 499, 500, 503, 504].includes(status) ? status : 503;
  }
}
export type SiteTrafficSource = {
  readCapability(binding: TrafficBinding, signal: AbortSignal): Promise<unknown>;
  readReport(binding: TrafficBinding, signal: AbortSignal): Promise<unknown>;
  /** Current principal/machine grant, exact scope/request and source/permission versions; synchronous void only. */
  assertCurrent(snapshot: TrafficCapability | TrafficReportEnvelope, binding: TrafficBinding, now: number): void;
};
export type TrafficAggregateSource<T extends { authority: TrafficAuthority }> = {
  readAggregate(binding: TrafficAggregateBinding, signal: AbortSignal): Promise<unknown>;
  assertCurrent(snapshot: T, binding: TrafficAggregateBinding, now: number): void;
};
export type MatchingCommerceSource = TrafficAggregateSource<TrafficOrderAggregate>;
export type CreatorClickSource = TrafficAggregateSource<TrafficClickAggregate>;
