import type { OperationsScope } from "../operations.ts";
import type { TeamInvitationReadViewKey, TeamInvitationSnapshot } from "./contract.ts";

/**
 * Freshness ceiling for provider roles and invitation/quota facts. D-13 names no class for them, so this uses the same
 * 15 minutes the operations controls apply to source role facts and the capability ledger applies to permission proof.
 * A source lease may shorten it; it cannot extend server-owned freshness.
 */
export const teamInvitationMaxObservationAgeMs = 15 * 60_000;
/** Bounded below the HTTP request timeout so a hung source answers as a typed timeout instead of a dropped connection. */
export const teamInvitationSourceTimeoutMs = 10_000;

export type TeamInvitationReadSourceRequest = { viewKey: TeamInvitationReadViewKey; filters: Readonly<Record<string, never>> };
/**
 * Server-only boundary for provider role registers (team permissions) and the TikTok Affiliate Center draft/quota mirror
 * (invitation draft). Nothing is configured by default. Throw `TeamInvitationReadError` with 401/403 for a source denial;
 * anything else counts as the source being unavailable. The reader only reads: it never grants, assigns or sends.
 */
export type TeamInvitationReadPrincipal = { principalRef: string; role: "reader" | "reviewer" };
export type TeamInvitationReadBinding = { scope: OperationsScope; principal: TeamInvitationReadPrincipal; request: TeamInvitationReadSourceRequest };
export type TeamInvitationReadSourceReader = {
  read(scope: OperationsScope, request: TeamInvitationReadSourceRequest, options: { signal: AbortSignal; principal: TeamInvitationReadPrincipal }): Promise<unknown | null>;
  /** Synchronously verify the exact principal, scope, request, source version and permission version against current authority.
   * Returning a promise or any non-void value is a refusal. Coarse roles never authorize customer disclosure. */
  assertCurrent(snapshot: TeamInvitationSnapshot, binding: TeamInvitationReadBinding, now: number): void;
};

/** Public error metadata only: a code, a status and bounded reason codes. Source exception text is never carried. */
export class TeamInvitationReadError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reasonCodes: string[];
  constructor(code: string, status: number, reasonCodes: string[] = []) { super(code); this.code = code; this.status = status; this.reasonCodes = reasonCodes; }
}
