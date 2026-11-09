import type { NativeAnalyticsBinding, NativeAnalyticsSnapshot } from "./contract.ts";

export const ANALYTICS_ACCESS_MAX_AGE_MS = 15 * 60_000;
export type NativeAnalyticsSource = {
  read(binding: NativeAnalyticsBinding, signal: AbortSignal): Promise<unknown | null>;
  /** Must verify every owner proof against current scope, principal, request and permission/source/definition versions. */
  assertCurrent(snapshot: NativeAnalyticsSnapshot, binding: NativeAnalyticsBinding, now: number): void;
};
const suffixes = ["REQUEST_INVALID", "CURSOR_INVALID", "CURSOR_STALE", "UNAUTHENTICATED", "SOURCE_DENIED", "SOURCE_CHANGED", "PERMISSION_CHANGED", "DEFINITION_CHANGED", "SOURCE_INVALID", "BINDING_MISMATCH", "SOURCE_UNCONFIGURED", "SOURCE_UNAVAILABLE", "SOURCE_FENCE_UNAVAILABLE", "PUBLICATION_EXPIRED", "SOURCE_TIMEOUT", "RATE_LIMITED", "REQUEST_CANCELLED", "INVALID_CLOCK", "REFERENCE_KEY_INVALID", "TIMEOUT_INVALID"] as const;
export type NativeAnalyticsErrorCode = `ANALYTICS_${typeof suffixes[number]}`;
const codes = new Set<string>(suffixes.map(value => `ANALYTICS_${value}`));
/** Never carry source exception text or arbitrary public code strings. */
export class NativeAnalyticsError extends Error {
  readonly code: NativeAnalyticsErrorCode;
  readonly status: number;
  constructor(code: string, status = 503) {
    const known = codes.has(code), safe = known ? code as NativeAnalyticsErrorCode : "ANALYTICS_SOURCE_UNAVAILABLE";
    super(safe); this.code = safe; this.status = known && [400, 401, 403, 409, 429, 499, 500, 503, 504].includes(status) ? status : 503;
  }
}
