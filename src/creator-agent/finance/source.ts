import type { OperationsScope } from "../operations.ts";
import type { FinanceViewKey, FinanceSnapshot } from "./contract.ts";

/**
 * D-13 accounting ceiling. A source lease may shorten it; it cannot extend server-owned freshness. Commission and settlement
 * figures are treated as accounting facts here because they feed the close.
 */
export const financeMaxObservationAgeMs = 24 * 60 * 60_000;
/** Bounded below the HTTP request timeout so a hung source answers as a typed timeout instead of a dropped connection. */
export const financeSourceTimeoutMs = 10_000;

export type FinanceSourceRequest = { viewKey: FinanceViewKey; filters: Readonly<Record<string, string>> };
/**
 * Server-only accounting/provider boundary (for example QuickBooks or provider settlement statements). Nothing is configured
 * by default. Throw `FinanceError` with 401/403 for a source denial; anything else counts as the source being unavailable.
 */
export type FinancePrincipal = { principalRef: string; role: "reader" | "reviewer" };
export type FinanceReadBinding = { scope: OperationsScope; principal: FinancePrincipal; request: FinanceSourceRequest };
export type FinanceSourceReader = {
  read(scope: OperationsScope, request: FinanceSourceRequest, options: { signal: AbortSignal; principal: FinancePrincipal }): Promise<unknown | null>;
  /** Synchronously verify the exact principal, scope, request, source version, permission version and independent readAccess grant against current authority.
   * Returning a promise or any non-void value is a refusal. Coarse roles never authorize customer disclosure. */
  assertCurrent(snapshot: FinanceSnapshot, binding: FinanceReadBinding, now: number): void;
};

/** Public error metadata only: a code, a status and bounded reason codes. Source exception text is never carried. */
export class FinanceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reasonCodes: string[];
  constructor(code: string, status: number, reasonCodes: string[] = []) { super(code); this.code = code; this.status = status; this.reasonCodes = reasonCodes; }
}
