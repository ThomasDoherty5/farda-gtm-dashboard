import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import type { OperationsScope } from "../operations.ts";
import { nativeFinanceViewSchemas } from "../../adapter/viewSchemas/finance.ts";
import { financeDetailViews, financeFilters, financeSnapshotSchema, type FinanceSnapshot, type FinanceViewKey } from "./contract.ts";
import { FinanceError, financeMaxObservationAgeMs, financeSourceTimeoutMs, type FinanceSourceReader, type FinancePrincipal, type FinanceReadBinding } from "./source.ts";
import { financeSummaryContextSchema } from "./headlines.ts";

export { FinanceError } from "./source.ts";
/** Freeze parsed input retained by the final fence; source code cannot mutate a published basis. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
type Capability = { actionKind: string; state: "available" | "held" | "denied" | "unsupported"; reasonCodes: string[] };
type Options = { scope: OperationsScope; secret: string; source?: FinanceSourceReader; now?: () => number; timeoutMs?: number };

/** Read-only intents the screens name. None can execute here: pay, reconcile and close stay with their owners. */
const intents: Record<FinanceViewKey, Capability[]> = {
  financeDashboard: [], commissionLedger: [], monthsHistory: [], reportManifest: [],
  settlementDetail: [{ actionKind: "reconcileSettlement", state: "held", reasonCodes: ["FINANCE_ACTIONS_NOT_CONNECTED"] },
    { actionKind: "payCommission", state: "unsupported", reasonCodes: ["PROVIDER_OWNS_PAYOUT"] }],
  payableDetail: [{ actionKind: "executePayment", state: "held", reasonCodes: ["FINANCE_ACTIONS_NOT_CONNECTED"] }],
  periodClose: [{ actionKind: "closePeriod", state: "held", reasonCodes: ["FINANCE_ACTIONS_NOT_CONNECTED"] }],
  closePackage: [{ actionKind: "closePeriod", state: "held", reasonCodes: ["FINANCE_ACTIONS_NOT_CONNECTED"] }],
};
/** The record field that must equal the requested address, so a source cannot answer one record with another. */
const identity: Partial<Record<FinanceViewKey, string>> = { settlementDetail: "settlementId", payableDetail: "payableId", periodClose: "period", closePackage: "period" };

export type FinanceReadResult = {
  data: unknown; version: string; dataState: "ready" | "empty" | "partial" | "stale";
  /** Internal freshness transition for composed reads; stale evidence retains its independent access grant. */
  freshUntil: string | null;
  coverage: { expectedCount: number | null; observedCount: number | null; missingCount: number | null; complete: boolean; reasonCodes: string[] };
  sourceFreshness: { sourceRef: { source: string; accountId: string; sourceId: null; canonicalId: null; url: null; identityState: "unresolved"; provenanceRef: string };
    lastSourceSuccessAt: string; observedAt: string; mirroredAt: null; staleReasonCode: string | null; freshnessState?: "current" | "partial" }[];
  capabilities: Capability[];
  assertCurrent: () => void;
};

/**
 * Finance and payable/settlement reads. There is no accounting or provider source in this repository, so the default is
 * an honest unconfigured answer: a typed `INTEGRATION_PENDING` error, never a fixture, a synthesized figure or an empty success.
 * A configured server-only reader is validated strictly, bound to the exact scope and address, and labelled with its
 * freshness and coverage. Nothing is cached or persisted, and no write path exists.
 */
export function createFinanceReader(options: Options) {
  const { scope, secret, source } = options, now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? financeSourceTimeoutMs;
  if (secret.length < 32) throw new Error("Finance reference key must be private and at least 32 characters.");
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", secret).update(JSON.stringify(["finance.v1", scope, kind, value])).digest("hex").slice(0, 32);

  async function observe(viewKey: FinanceViewKey, filters: Record<string, string>, binding: FinanceReadBinding, signal: AbortSignal | undefined): Promise<FinanceSnapshot> {
    if (!source) throw new FinanceError("INTEGRATION_PENDING", 503, ["FINANCE_SOURCE_UNCONFIGURED"]);
    if (typeof source.read !== "function" || typeof source.assertCurrent !== "function") throw new FinanceError("SOURCE_AUTHORITY_UNVERIFIED", 503);
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
      if (error instanceof FinanceError && (error.status === 401 || error.status === 403)) throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403);
      if (timeout.aborted && !signal?.aborted) throw new FinanceError("TIMEOUT", 504, ["FINANCE_SOURCE_TIMEOUT"]);
      if (signal?.aborted) throw new FinanceError("REQUEST_CANCELLED", 499);
      throw new FinanceError("SOURCE_UNAVAILABLE", 503, ["FINANCE_SOURCE_UNAVAILABLE"]);
    }
    if (raw === null || raw === undefined) throw new FinanceError("SOURCE_UNAVAILABLE", 503, ["FINANCE_SOURCE_UNAVAILABLE"]);
    const parsed = financeSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_SOURCE_INVALID"]);
    const s = freeze(structuredClone(parsed.data));
    if (s.principalRef !== binding.principal.principalRef) throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403);
    if (digest(s.scope) !== digest(scope)) throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403);
    if (s.viewKey !== viewKey) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_SOURCE_VIEW_MISMATCH"]);
    const currentTime = now();
    if (!Number.isFinite(currentTime) || Date.parse(s.observedAt) > currentTime) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
    if ("period" in filters && s.period !== filters.period) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_PERIOD_MISMATCH"]);
    return s;
  }

  function fence(snapshot: FinanceSnapshot, binding: FinanceReadBinding, signal?: AbortSignal) {
    return () => {
      if (signal?.aborted) throw new FinanceError("REQUEST_CANCELLED", 499);
      const timestamp = now();
      if (!Number.isFinite(timestamp)) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
      if (Date.parse(snapshot.readAccess.observedAt) > timestamp) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
      if (Date.parse(snapshot.readAccess.validUntil) <= timestamp) throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403, ["FINANCE_READ_ACCESS_EXPIRED"]);
      try {
        if (!source || typeof source.assertCurrent !== "function") throw new Error("Missing current authority");
        assertSynchronousVoid(() => source.assertCurrent(snapshot, binding, timestamp));
      } catch (error) {
        if (error instanceof FinanceError && (error.status === 401 || error.status === 403)) throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403);
        if (error instanceof FinanceError && error.status === 409) throw new FinanceError("SOURCE_VERSION_CHANGED", 409);
        throw new FinanceError("SOURCE_AUTHORITY_UNVERIFIED", 503);
      }
      const publicationTime = now();
      if (!Number.isFinite(publicationTime)) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
      if (Date.parse(snapshot.readAccess.observedAt) > publicationTime || Date.parse(snapshot.readAccess.validUntil) <= publicationTime)
        throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403, ["FINANCE_READ_ACCESS_EXPIRED"]);
    };
  }

  async function read(viewKey: FinanceViewKey, rawFilters: unknown, principal: FinancePrincipal, signal?: AbortSignal): Promise<FinanceReadResult> {
    const role = principal?.role;
    if (!principal?.principalRef?.trim() || (role !== "reader" && role !== "reviewer")) throw new FinanceError("SOURCE_SCOPE_DENIED", 403);
    const filters = financeFilters[viewKey].safeParse(rawFilters);
    if (!filters.success) throw new FinanceError("INVALID_INPUT", 400);
    const f = filters.data as Record<string, string>;
    const binding: FinanceReadBinding = freeze(structuredClone({ scope, principal, request: { viewKey, filters: f } }));
    const s = await observe(viewKey, f, binding, signal);
    const assertCurrent = fence(s, binding, signal);
    assertCurrent();
    // Only the independently qualified snapshot grant can authorize browser retention.
    const projectedRecord = s.record !== null && typeof s.record === "object" && !Array.isArray(s.record)
      ? { ...s.record, readAccess: { validUntil: s.readAccess.validUntil } } : s.record;
    const capabilities = intents[viewKey].map(c => role === "reviewer" ? { ...c, reasonCodes: [...c.reasonCodes] } : { actionKind: c.actionKind, state: "denied" as const, reasonCodes: ["REVIEWER_REQUIRED"] });
    if (s.record === null) {
      // The source's own statement that nothing exists here. For a named record that is not found; for a list it is empty.
      if (financeDetailViews.has(viewKey) && s.coverage.state === "complete" && Math.min(Date.parse(s.validUntil), Date.parse(s.observedAt) + financeMaxObservationAgeMs) > now()) {
        assertCurrent();
        throw new FinanceError("RECORD_NOT_FOUND", 404);
      }
    } else {
      const checked = nativeFinanceViewSchemas[viewKey]!.safeParse(projectedRecord);
      if (!checked.success) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_RECORD_INVALID"]);
      const field = identity[viewKey];
      if (field && (checked.data as Record<string, unknown>)[field] !== f[field]) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_RECORD_ADDRESS_MISMATCH"]);
    }
    const deadline = Math.min(Date.parse(s.validUntil), Date.parse(s.observedAt) + financeMaxObservationAgeMs);
    const stale = deadline <= now();
    const partial = s.coverage.state === "partial";
    const { expectedCount, observedCount } = s.coverage;
    const reasonCodes = [...new Set([...(stale ? ["FINANCE_SOURCE_STALE"] : []), ...s.coverage.reasonCodes])];
    const data = s.record === null ? null : nativeFinanceViewSchemas[viewKey]!.parse(projectedRecord);
    if (viewKey === "financeDashboard" && data) {
      const context = financeSummaryContextSchema.nullable().optional().parse((data as { summaryContext?: unknown }).summaryContext);
      if (context && Date.parse(context.cashAsOf) > Date.parse(s.observedAt)) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_CASH_TIME_INVALID"]);
      if (f.startAt && (!context || Date.parse(context.period.startAt) !== Date.parse(f.startAt) || Date.parse(context.period.endAt) !== Date.parse(f.endAt!) || context.period.timezone !== f.timezone))
        throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_REPORTING_PERIOD_MISMATCH"]);
      if (context) (data as { summaryContext: typeof context }).summaryContext = { ...context,
        policy: { ...context.policy, version: alias("policy-version", context.policy.version), evidenceRef: alias("policy-evidence", context.policy.evidenceRef) } };
    }
    if (data && (data as { provenance: { observedAt: string } }).provenance.observedAt !== s.observedAt) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_PROVENANCE_MISMATCH"]);
    const finalFence = () => {
      assertCurrent();
      if (!stale && deadline <= now()) throw new FinanceError("SOURCE_VERSION_CHANGED", 409);
    };
    const result: FinanceReadResult = {
      data, version: "fin1-" + digest([binding, alias("permission", s.permissionVersion), viewKey, f, alias("source", s.version), s.observedAt, s.coverage, data]),
      dataState: stale ? "stale" : partial ? "partial" : data === null ? "empty" : "ready",
      freshUntil: stale ? null : new Date(deadline).toISOString(),
      coverage: { expectedCount, observedCount, missingCount: expectedCount !== null && observedCount !== null ? expectedCount - observedCount : null,
        complete: !partial && !stale, reasonCodes },
      sourceFreshness: [{ sourceRef: { source: "finance-source", accountId: scope.accountId, sourceId: null, canonicalId: null, url: null,
        identityState: "unresolved", provenanceRef: alias("source", s.version) }, lastSourceSuccessAt: s.observedAt, observedAt: s.observedAt,
        mirroredAt: null, staleReasonCode: stale ? "FINANCE_SOURCE_STALE" : null, ...(stale ? {} : { freshnessState: partial ? "partial" as const : "current" as const }) }],
      assertCurrent: finalFence,
      capabilities: stale || partial ? capabilities.map(c => c.state === "held" ? { ...c, reasonCodes: [...c.reasonCodes, ...(stale ? ["SOURCE_STALE"] : ["SOURCE_COVERAGE_PARTIAL"])] } : c) : capabilities,
    };
    finalFence();
    return result;
  }
  return { read };
}
