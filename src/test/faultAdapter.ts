import type { FardaAdapter } from "@/adapter/adapter";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import type { ReadRequest, ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { createLiveAdapter } from "@/adapter/liveAdapter";

/**
 * The fixture families the matrix drives every route with (docs/design-map.md, "Contract states"). Each wraps the real demo
 * adapter and changes only what the server would: the state of the read, or whether it is answered at all.
 */
export type Fault = "loading" | "unauthenticated" | "forbidden" | "empty" | "partial" | "stale" | "integration-pending" | "offline" | "all-unknown" | "all-zero" | "all-zero-plain";

const isProvenance = (v: unknown): v is { state: string; value: unknown } =>
  typeof v === "object" && v !== null && "state" in v && "value" in v && "evidenceRefs" in v;

/**
 * Rewrites every provenance value in a response: all-unknown turns each into an unknown (null value, with a reason), all-zero turns
 * each known number into a known zero. A screen that treats missing as zero, or can't show a real zero, shows it.
 */
export function rewriteProvenance<T>(data: T, mode: "unknown" | "zero"): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isProvenance(v)) {
      if (mode === "unknown") return { ...v, state: "unknown", value: null, reasonCode: "NOT_REPORTED" };
      return v.state === "known" && typeof v.value === "number" ? { ...v, value: 0 } : v;
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(data) as T;
}

/**
 * The plain numbers a provenance walk can't reach: every finite number property becomes 0, whatever its meaning. This is a crash and
 * rendering test (a divide by a zero denominator, a zero that is dropped), not a claim that the zeroed data is realistic.
 * What it cannot do: turn a plain number into an *unknown*. A plain field has no unknown representation, so the unknown check
 * only covers fields the contract types as provenance values.
 */
export function zeroPlainNumbers<T>(data: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "number" && Number.isFinite(v)) return 0;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(data) as T;
}

const failure = (request: ReadRequest<unknown>, code: string, message: string) =>
  new AdapterError({ code, message, requestId: request.requestId, correlationId: `fault-${request.requestId}`, retryable: false, retryAfterMs: null });

export function faultAdapter(fault: Fault, base: FardaAdapter = createDemoAdapter()): FardaAdapter {
  if (fault === "integration-pending") return createLiveAdapter("sandbox");
  return {
    ...base,
    environment: base.environment,
    kind: base.kind,
    submitAction: (r, o) => base.submitAction(r, o),
    saveResource: (r, o) => base.saveResource(r, o),
    async readView<F, T>(request: ReadRequest<F>, options?: { signal?: AbortSignal }): Promise<ReadResponse<T>> {
      if (fault === "loading") return new Promise<ReadResponse<T>>(() => undefined);
      if (fault === "unauthenticated") throw failure(request, "UNAUTHENTICATED", "The session expired.");
      if (fault === "offline") throw new AdapterError({ code: "SOURCE_UNAVAILABLE", message: "The data service could not be reached.", requestId: request.requestId, correlationId: null, retryable: true, retryAfterMs: null });
      if (fault === "forbidden") throw failure(request, "FORBIDDEN", "Not allowed for this account.");
      const res = await base.readView<F, T>(request, options);
      if (fault === "all-zero-plain") return { ...res, data: zeroPlainNumbers(res.data) };
      if (fault === "all-unknown" || fault === "all-zero") return { ...res, data: rewriteProvenance(res.data, fault === "all-unknown" ? "unknown" : "zero") };
      if (fault === "empty") return { ...res, dataState: "empty", data: null, coverage: { expectedCount: 0, observedCount: 0, missingCount: 0, complete: true, reasonCodes: [] } };
      if (fault === "partial") return { ...res, dataState: "partial", coverage: { expectedCount: 10, observedCount: 6, missingCount: 4, complete: false, reasonCodes: ["SOURCE_ROWS_INACCESSIBLE"] } };
      // stale: the data is the same, but the source was last read long ago
      const ref = res.sourceFreshness[0]?.sourceRef ?? { source: "demo", accountId: "a", sourceId: "demo-source", canonicalId: null, url: null, identityState: "resolved" as const, provenanceRef: "fault" };
      return { ...res, dataState: "stale", sourceFreshness: [{ sourceRef: ref, lastSourceSuccessAt: "2026-10-01T08:00:00.000Z", observedAt: "2026-10-01T08:00:00.000Z", mirroredAt: "2026-10-01T08:05:00.000Z", staleReasonCode: "SOURCE_BEHIND" }] };
    },
  };
}
