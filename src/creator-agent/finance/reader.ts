import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { financeViewSchemas } from "../../adapter/viewSchemas/finance.ts";
import { financeDetailViews, financeFilters, financeSnapshotSchema, type FinanceSnapshot, type FinanceViewKey } from "./contract.ts";
import { FinanceError, financeMaxObservationAgeMs, financeSourceTimeoutMs, type FinanceSourceReader } from "./source.ts";

export { FinanceError } from "./source.ts";
type Role = "reader" | "reviewer";
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
  coverage: { expectedCount: number | null; observedCount: number | null; missingCount: number | null; complete: boolean; reasonCodes: string[] };
  sourceFreshness: { sourceRef: { source: string; accountId: string; sourceId: null; canonicalId: null; url: null; identityState: "unresolved"; provenanceRef: string };
    lastSourceSuccessAt: string; observedAt: string; mirroredAt: null; staleReasonCode: string | null; freshnessState?: "current" | "partial" }[];
  capabilities: Capability[];
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

  async function observe(viewKey: FinanceViewKey, filters: Record<string, string>, signal: AbortSignal | undefined): Promise<FinanceSnapshot> {
    if (!source) throw new FinanceError("INTEGRATION_PENDING", 503, ["FINANCE_SOURCE_UNCONFIGURED"]);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let raw: unknown;
    try {
      raw = await new Promise<unknown>((resolve, reject) => {
        const abort = () => reject(combined.reason);
        if (combined.aborted) return abort();
        combined.addEventListener("abort", abort, { once: true });
        source({ ...scope }, { viewKey, filters: { ...filters } }, { signal: combined }).then(resolve, reject)
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
    const s = parsed.data;
    if (digest(s.scope) !== digest(scope)) throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403);
    if (s.viewKey !== viewKey) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_SOURCE_VIEW_MISMATCH"]);
    const currentTime = now();
    if (!Number.isFinite(currentTime) || Date.parse(s.observedAt) > currentTime) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
    if ("period" in filters && s.period !== filters.period) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_PERIOD_MISMATCH"]);
    return s;
  }

  async function read(viewKey: FinanceViewKey, rawFilters: unknown, role: Role, signal?: AbortSignal): Promise<FinanceReadResult> {
    if (role !== "reader" && role !== "reviewer") throw new FinanceError("SOURCE_SCOPE_DENIED", 403);
    const filters = financeFilters[viewKey].safeParse(rawFilters);
    if (!filters.success) throw new FinanceError("INVALID_INPUT", 400);
    const f = filters.data as Record<string, string>;
    const s = await observe(viewKey, f, signal);
    const capabilities = intents[viewKey].map(c => role === "reviewer" ? { ...c, reasonCodes: [...c.reasonCodes] } : { actionKind: c.actionKind, state: "denied" as const, reasonCodes: ["REVIEWER_REQUIRED"] });
    if (s.record === null) {
      // The source's own statement that nothing exists here. For a named record that is not found; for a list it is empty.
      if (financeDetailViews.has(viewKey)) throw new FinanceError("RECORD_NOT_FOUND", 404);
    } else {
      const checked = financeViewSchemas[viewKey]!.safeParse(s.record);
      if (!checked.success) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_RECORD_INVALID"]);
      const field = identity[viewKey];
      if (field && (checked.data as Record<string, unknown>)[field] !== f[field]) throw new FinanceError("SOURCE_RESPONSE_INVALID", 502, ["FINANCE_RECORD_ADDRESS_MISMATCH"]);
    }
    const deadline = Math.min(Date.parse(s.validUntil), Date.parse(s.observedAt) + financeMaxObservationAgeMs);
    const stale = deadline <= now();
    const partial = s.coverage.state === "partial";
    const { expectedCount, observedCount } = s.coverage;
    const reasonCodes = [...new Set([...(stale ? ["FINANCE_SOURCE_STALE"] : []), ...s.coverage.reasonCodes])];
    const data = s.record === null ? null : financeViewSchemas[viewKey]!.parse(s.record);
    return {
      data, version: "fin1-" + digest([scope, viewKey, f, alias("source", s.version), s.observedAt, s.coverage, data]),
      dataState: stale ? "stale" : partial ? "partial" : data === null ? "empty" : "ready",
      coverage: { expectedCount, observedCount, missingCount: expectedCount !== null && observedCount !== null ? expectedCount - observedCount : null,
        complete: !partial && !stale, reasonCodes },
      sourceFreshness: [{ sourceRef: { source: "finance-source", accountId: scope.accountId, sourceId: null, canonicalId: null, url: null,
        identityState: "unresolved", provenanceRef: alias("source", s.version) }, lastSourceSuccessAt: s.observedAt, observedAt: s.observedAt,
        mirroredAt: null, staleReasonCode: stale ? "FINANCE_SOURCE_STALE" : null, ...(stale ? {} : { freshnessState: partial ? "partial" as const : "current" as const }) }],
      capabilities: stale || partial ? capabilities.map(c => c.state === "held" ? { ...c, reasonCodes: [...c.reasonCodes, ...(stale ? ["SOURCE_STALE"] : ["SOURCE_COVERAGE_PARTIAL"])] } : c) : capabilities,
    };
  }
  return { read };
}
