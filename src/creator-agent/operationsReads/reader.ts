import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import type { OperationsScope } from "../operations.ts";
import { nativeOpsReadViewSchemas } from "../../adapter/viewSchemas/ops.ts";
import { operationsDetailViews, operationsReadFilters, operationsSnapshotSchema, type OperationsReadViewKey, type OperationsSnapshot } from "./contract.ts";
import { OperationsReadError, operationsMaxObservationAgeMs, operationsSourceTimeoutMs, type OperationsReadSourceReader, type OperationsReadPrincipal, type OperationsReadBinding } from "./source.ts";

export { OperationsReadError } from "./source.ts";
/** Freeze parsed input retained by the final fence; source code cannot mutate a published basis. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
type Filters = Record<string, string | number>;
type Capability = { actionKind: string; state: "available" | "held" | "denied" | "unsupported"; reasonCodes: string[] };
type Options = { scope: OperationsScope; secret: string; source?: OperationsReadSourceReader; now?: () => number; timeoutMs?: number };

/**
 * Intents the screens name. None can execute here: shipping decisions and return tasks stay approval-request-only with their
 * owners, and an audited customer reveal belongs to the source that keeps the audit.
 */
const held = (actionKind: string): Capability => ({ actionKind, state: "held", reasonCodes: ["OPERATIONS_ACTIONS_NOT_CONNECTED"] });
const intents: Record<OperationsReadViewKey, Capability[]> = {
  operationsOverview: [], orderDetail: [], fulfillmentAnalytics: [], operationsShipping: [], opsHealth: [],
  shippingException: [held("recordShippingDecision")],
  returnDetail: [held("prepareReturnTask"), held("closeReturn")],
  orderCustomer: [held("revealCustomerDetails")],
};
/** Record fields that must equal the requested address, so a source cannot answer one record with another. */
const identity: Partial<Record<OperationsReadViewKey, [field: string, filter: string][]>> = {
  orderDetail: [["orderRef", "orderId"]], orderCustomer: [["orderRef", "orderId"]], returnDetail: [["returnRef", "returnId"]],
  shippingException: [["shipmentRef", "shipmentId"], ["exceptionId", "exceptionId"]], fulfillmentAnalytics: [["periodDays", "days"]],
};

export type OperationsReadResult = {
  data: unknown; version: string; dataState: "ready" | "empty" | "partial" | "stale";
  coverage: { expectedCount: number | null; observedCount: number | null; missingCount: number | null; complete: boolean; reasonCodes: string[] };
  sourceFreshness: { sourceRef: { source: string; accountId: string; sourceId: null; canonicalId: null; url: null; identityState: "unresolved"; provenanceRef: string };
    lastSourceSuccessAt: string; observedAt: string; mirroredAt: null; staleReasonCode: string | null; freshnessState?: "current" | "partial" }[];
  capabilities: Capability[];
  assertCurrent: () => void;
};

/**
 * Operations reads for the THO-301 screens. There is no order, shipping or returns source in this repository, so the default
 * is an honest unconfigured answer: a typed `INTEGRATION_PENDING` error, never a fixture, a synthesized figure or an empty
 * success. A configured server-only reader is validated strictly, bound to the exact scope and address, and labelled with its
 * freshness and coverage. Only fields the native schema allows leave the service. Nothing is cached or persisted.
 */
export function createOperationsReadReader(options: Options) {
  const { scope, secret, source } = options, now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? operationsSourceTimeoutMs;
  if (secret.length < 32) throw new Error("Operations reference key must be private and at least 32 characters.");
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", secret).update(JSON.stringify(["operations-read.v1", scope, kind, value])).digest("hex").slice(0, 32);

  async function observe(viewKey: OperationsReadViewKey, binding: OperationsReadBinding, signal: AbortSignal | undefined): Promise<OperationsSnapshot> {
    if (!source) throw new OperationsReadError("INTEGRATION_PENDING", 503, ["OPERATIONS_SOURCE_UNCONFIGURED"]);
    if (typeof source.read !== "function" || typeof source.assertCurrent !== "function") throw new OperationsReadError("SOURCE_AUTHORITY_UNVERIFIED", 503);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let raw: unknown;
    try {
      raw = await new Promise<unknown>((resolve, reject) => {
        const abort = () => reject(combined.reason);
        if (combined.aborted) return abort();
        combined.addEventListener("abort", abort, { once: true });
        source.read({ ...scope }, structuredClone(binding.request), { signal: combined, principal: { ...binding.principal } }).then(resolve, reject)
          .finally(() => combined.removeEventListener("abort", abort));
      });
    } catch (error) {
      if (error instanceof OperationsReadError && (error.status === 401 || error.status === 403)) throw new OperationsReadError("SOURCE_AUTHORITY_DENIED", 403);
      if (timeout.aborted && !signal?.aborted) throw new OperationsReadError("TIMEOUT", 504, ["OPERATIONS_SOURCE_TIMEOUT"]);
      if (signal?.aborted) throw new OperationsReadError("REQUEST_CANCELLED", 499);
      throw new OperationsReadError("SOURCE_UNAVAILABLE", 503, ["OPERATIONS_SOURCE_UNAVAILABLE"]);
    }
    if (raw === null || raw === undefined) throw new OperationsReadError("SOURCE_UNAVAILABLE", 503, ["OPERATIONS_SOURCE_UNAVAILABLE"]);
    const parsed = operationsSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new OperationsReadError("SOURCE_RESPONSE_INVALID", 502, ["OPERATIONS_SOURCE_INVALID"]);
    const s = freeze(structuredClone(parsed.data));
    if (s.principalRef !== binding.principal.principalRef) throw new OperationsReadError("SOURCE_AUTHORITY_DENIED", 403);
    if (digest(s.scope) !== digest(scope)) throw new OperationsReadError("SOURCE_AUTHORITY_DENIED", 403);
    if (s.viewKey !== viewKey) throw new OperationsReadError("SOURCE_RESPONSE_INVALID", 502, ["OPERATIONS_SOURCE_VIEW_MISMATCH"]);
    const currentTime = now();
    if (!Number.isFinite(currentTime) || Date.parse(s.observedAt) > currentTime) throw new OperationsReadError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
    return s;
  }

  function fence(snapshot: OperationsSnapshot, binding: OperationsReadBinding, signal?: AbortSignal) {
    return () => {
      if (signal?.aborted) throw new OperationsReadError("REQUEST_CANCELLED", 499);
      const timestamp = now();
      if (!Number.isFinite(timestamp)) throw new OperationsReadError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
      try {
        if (!source || typeof source.assertCurrent !== "function") throw new Error("Missing current authority");
        assertSynchronousVoid(() => source.assertCurrent(snapshot, binding, timestamp));
      } catch (error) {
        if (error instanceof OperationsReadError && (error.status === 401 || error.status === 403)) throw new OperationsReadError("SOURCE_AUTHORITY_DENIED", 403);
        if (error instanceof OperationsReadError && error.status === 409) throw new OperationsReadError("SOURCE_VERSION_CHANGED", 409);
        throw new OperationsReadError("SOURCE_AUTHORITY_UNVERIFIED", 503);
      }
    };
  }

  /** The strict native schema refuses undeclared fields before applying the customer privacy projection. */
  function project(viewKey: OperationsReadViewKey, record: unknown, f: Filters): unknown {
    const checked = nativeOpsReadViewSchemas[viewKey]!.safeParse(record);
    if (!checked.success) throw new OperationsReadError("SOURCE_RESPONSE_INVALID", 502, ["OPERATIONS_RECORD_INVALID"]);
    const data = checked.data as Record<string, unknown>;
    for (const [field, filter] of identity[viewKey] ?? [])
      if (data[field] !== f[filter]) throw new OperationsReadError("SOURCE_RESPONSE_INVALID", 502, ["OPERATIONS_RECORD_ADDRESS_MISMATCH"]);
    if (viewKey !== "orderCustomer") return data;
    const customer = data as { orderRef: string; access: { state: string; reason: string | null }; revealed: unknown; audit: { orderRef: string }[] };
    if (customer.audit.some(entry => entry.orderRef !== f.orderId)) throw new OperationsReadError("SOURCE_RESPONSE_INVALID", 502, ["OPERATIONS_RECORD_ADDRESS_MISMATCH"]);
    // Coarse transport roles authorize no disclosure. Prior audit reasons may also contain PII; keep them server-side.
    return { ...customer, access: { state: "denied", reason: "CUSTOMER_REVEAL_AUTHORITY_NOT_CONNECTED" }, revealed: null, audit: [] };
  }

  async function read(viewKey: OperationsReadViewKey, rawFilters: unknown, principal: OperationsReadPrincipal, signal?: AbortSignal): Promise<OperationsReadResult> {
    const role = principal?.role;
    if (!principal?.principalRef?.trim() || (role !== "reader" && role !== "reviewer")) throw new OperationsReadError("SOURCE_SCOPE_DENIED", 403);
    const filters = operationsReadFilters[viewKey].safeParse(rawFilters);
    if (!filters.success) throw new OperationsReadError("INVALID_INPUT", 400);
    const f = filters.data as Filters;
    const binding: OperationsReadBinding = freeze(structuredClone({ scope, principal, request: { viewKey, filters: f } }));
    const s = await observe(viewKey, binding, signal);
    const assertCurrent = fence(s, binding, signal);
    assertCurrent();
    const capabilities = intents[viewKey].map(c => role === "reviewer" ? { ...c, reasonCodes: [...c.reasonCodes] } : { actionKind: c.actionKind, state: "denied" as const, reasonCodes: ["REVIEWER_REQUIRED"] });
    // The source's own statement that nothing exists here. For a named record that is not found; for a list it is empty.
    if (s.record === null && operationsDetailViews.has(viewKey) && s.coverage.state === "complete" && Math.min(Date.parse(s.validUntil), Date.parse(s.observedAt) + operationsMaxObservationAgeMs) > now()) {
      assertCurrent();
      throw new OperationsReadError("RECORD_NOT_FOUND", 404);
    }
    const deadline = Math.min(Date.parse(s.validUntil), Date.parse(s.observedAt) + operationsMaxObservationAgeMs);
    const projection = s.record === null ? null : project(viewKey, s.record, f);
    const data = projection===null?null:{...(projection as Record<string,unknown>),provenance:{...(projection as {provenance:Record<string,unknown>}).provenance,
      validUntil:new Date(deadline).toISOString(),version:alias("version",s.version)}};
    if (data && (data as { provenance: { observedAt: string } }).provenance.observedAt !== s.observedAt) throw new OperationsReadError("SOURCE_RESPONSE_INVALID", 502, ["OPERATIONS_PROVENANCE_MISMATCH"]);
    const stale = deadline <= now();
    const partial = s.coverage.state === "partial";
    const { expectedCount, observedCount } = s.coverage;
    const reasonCodes = [...new Set([...(stale ? ["OPERATIONS_SOURCE_STALE"] : []), ...s.coverage.reasonCodes])];
    const finalFence = () => {
      assertCurrent();
      if (!stale && deadline <= now()) throw new OperationsReadError("SOURCE_VERSION_CHANGED", 409);
    };
    const result: OperationsReadResult = {
      data, version: "ops1-" + digest([binding, alias("permission", s.permissionVersion), viewKey, f, role, alias("source", s.version), s.observedAt, s.coverage, data]),
      dataState: stale ? "stale" : partial ? "partial" : data === null ? "empty" : "ready",
      coverage: { expectedCount, observedCount, missingCount: expectedCount !== null && observedCount !== null ? expectedCount - observedCount : null,
        complete: !partial && !stale, reasonCodes },
      sourceFreshness: [{ sourceRef: { source: "operations-source", accountId: scope.accountId, sourceId: null, canonicalId: null, url: null,
        identityState: "unresolved", provenanceRef: alias("source", s.version) }, lastSourceSuccessAt: s.observedAt, observedAt: s.observedAt,
        mirroredAt: null, staleReasonCode: stale ? "OPERATIONS_SOURCE_STALE" : null, ...(stale ? {} : { freshnessState: partial ? "partial" as const : "current" as const }) }],
      assertCurrent: finalFence,
      capabilities: stale || partial ? capabilities.map(c => c.state === "held" ? { ...c, reasonCodes: [...c.reasonCodes, ...(stale ? ["SOURCE_STALE"] : ["SOURCE_COVERAGE_PARTIAL"])] } : c) : capabilities,
    };
    finalFence();
    return result;
  }
  return { read };
}
