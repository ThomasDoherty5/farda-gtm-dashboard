import type { OperationsScope } from "../operations.ts";
import type { OperationsReadViewKey, OperationsSnapshot } from "./contract.ts";

/** D-13 order-source ceiling. A source lease may shorten it; it cannot extend server-owned freshness. */
export const operationsMaxObservationAgeMs = 15 * 60_000;
/** Bounded below the HTTP request timeout so a hung source answers as a typed timeout instead of a dropped connection. */
export const operationsSourceTimeoutMs = 10_000;

export type OperationsReadSourceRequest = { viewKey: OperationsReadViewKey; filters: Readonly<Record<string, string | number>> };
/**
 * Server-only order, shipping and returns boundary (for example the Shopify, Shippo and warehouse mirrors). Nothing is configured
 * by default. Throw `OperationsReadError` with 401/403 for a source denial; anything else counts as the source being unavailable.
 */
export type OperationsReadPrincipal = { principalRef: string; role: "reader" | "reviewer" };
export type OperationsReadBinding = { scope: OperationsScope; principal: OperationsReadPrincipal; request: OperationsReadSourceRequest };
export type OperationsReadSourceReader = {
  read(scope: OperationsScope, request: OperationsReadSourceRequest, options: { signal: AbortSignal; principal: OperationsReadPrincipal }): Promise<unknown | null>;
  /** Synchronously verify the exact principal, scope, request, source version and permission version against current authority.
   * Returning a promise or any non-void value is a refusal. Coarse roles never authorize customer disclosure. */
  assertCurrent(snapshot: OperationsSnapshot, binding: OperationsReadBinding, now: number): void;
};

/** Public error metadata only: a code, a status and bounded reason codes. Source exception text is never carried. */
export class OperationsReadError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reasonCodes: string[];
  constructor(code: string, status: number, reasonCodes: string[] = []) { super(code); this.code = code; this.status = status; this.reasonCodes = reasonCodes; }
}
