import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import type { OperationsScope } from "../operations.ts";
import { nativeTeamPermissionsSchema } from "../../adapter/viewSchemas/settings.ts";
import { nativeInvitationDraftSchema } from "../../adapter/viewSchemas/recruitment.ts";
import { teamInvitationReadFilters, teamInvitationReasonPrefix, teamInvitationSnapshotSchema, type TeamInvitationReadViewKey,
  type TeamInvitationSnapshot } from "./contract.ts";
import { TeamInvitationReadError, teamInvitationMaxObservationAgeMs, teamInvitationSourceTimeoutMs, type TeamInvitationReadSourceReader, type TeamInvitationReadPrincipal, type TeamInvitationReadBinding } from "./source.ts";

export { TeamInvitationReadError } from "./source.ts";
/** Freeze parsed input retained by the final fence; source code cannot mutate a published basis. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
type Capability = { actionKind: string; state: "available" | "held" | "denied" | "unsupported"; reasonCodes: string[] };
type Options = { scope: OperationsScope; secret: string; source?: TeamInvitationReadSourceReader; now?: () => number; timeoutMs?: number };

/** Native schemas retain truth metadata and reject undeclared keys before any record leaves the service. */
const viewSchemas = { teamPermissions: nativeTeamPermissionsSchema, invitationDraft: nativeInvitationDraftSchema } satisfies Record<TeamInvitationReadViewKey, unknown>;

/**
 * Intents the screens name. None can execute here. The team screen names no action: roles and owners change only in the
 * source tools after a workspace owner confirms, so it carries no capability and nothing on it can grant or assign. The
 * composer names `sendInvitation`, which is sent only by the approved browser route after exact-action approval and is not
 * connected. A source answer cannot supply capabilities (the snapshot is strict), so recorded permission evidence can never
 * turn into an available grant.
 */
const intents: Record<TeamInvitationReadViewKey, Capability[]> = {
  teamPermissions: [],
  invitationDraft: [{ actionKind: "sendInvitation", state: "held", reasonCodes: ["INVITATION_ACTIONS_NOT_CONNECTED"] }],
};
const sourceName: Record<TeamInvitationReadViewKey, string> = { teamPermissions: "team-permissions-source", invitationDraft: "invitation-source" };

export type TeamInvitationReadResult = {
  data: unknown; version: string; dataState: "ready" | "empty" | "partial" | "stale";
  coverage: { expectedCount: number | null; observedCount: number | null; missingCount: number | null; complete: boolean; reasonCodes: string[] };
  sourceFreshness: { sourceRef: { source: string; accountId: string; sourceId: null; canonicalId: null; url: null; identityState: "unresolved"; provenanceRef: string };
    lastSourceSuccessAt: string; observedAt: string; mirroredAt: null; staleReasonCode: string | null; freshnessState?: "current" | "partial" }[];
  capabilities: Capability[];
  assertCurrent: () => void;
};

/**
 * Team permission and invitation draft reads for the THO-305 and THO-298 screens. There is no provider role register or
 * TikTok Affiliate Center reader in this repository, so the default is an honest unconfigured answer: a typed
 * `INTEGRATION_PENDING` error, never a fixture, a synthesized role or draft, or an empty success. A configured server-only
 * reader is validated strictly, bound to the exact scope and view, and labelled with its freshness and coverage. Nothing is
 * cached or persisted, nothing is granted, assigned or sent.
 */
export function createTeamInvitationReadReader(options: Options) {
  const { scope, secret, source } = options, now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? teamInvitationSourceTimeoutMs;
  if (secret.length < 32) throw new Error("Team and invitation reference key must be private and at least 32 characters.");
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", secret).update(JSON.stringify(["team-invitation-read.v1", scope, kind, value])).digest("hex").slice(0, 32);

  async function observe(viewKey: TeamInvitationReadViewKey, binding: TeamInvitationReadBinding, signal: AbortSignal | undefined): Promise<TeamInvitationSnapshot> {
    const prefix = teamInvitationReasonPrefix[viewKey];
    if (!source) throw new TeamInvitationReadError("INTEGRATION_PENDING", 503, [prefix + "_SOURCE_UNCONFIGURED"]);
    if (typeof source.read !== "function" || typeof source.assertCurrent !== "function") throw new TeamInvitationReadError("SOURCE_AUTHORITY_UNVERIFIED", 503);
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
      if (error instanceof TeamInvitationReadError && (error.status === 401 || error.status === 403)) throw new TeamInvitationReadError("SOURCE_AUTHORITY_DENIED", 403);
      if (timeout.aborted && !signal?.aborted) throw new TeamInvitationReadError("TIMEOUT", 504, [prefix + "_SOURCE_TIMEOUT"]);
      if (signal?.aborted) throw new TeamInvitationReadError("REQUEST_CANCELLED", 499);
      throw new TeamInvitationReadError("SOURCE_UNAVAILABLE", 503, [prefix + "_SOURCE_UNAVAILABLE"]);
    }
    if (raw === null || raw === undefined) throw new TeamInvitationReadError("SOURCE_UNAVAILABLE", 503, [prefix + "_SOURCE_UNAVAILABLE"]);
    const parsed = teamInvitationSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new TeamInvitationReadError("SOURCE_RESPONSE_INVALID", 502, [prefix + "_SOURCE_INVALID"]);
    const s = freeze(structuredClone(parsed.data));
    if (s.principalRef !== binding.principal.principalRef) throw new TeamInvitationReadError("SOURCE_AUTHORITY_DENIED", 403);
    if (digest(s.scope) !== digest(scope)) throw new TeamInvitationReadError("SOURCE_AUTHORITY_DENIED", 403);
    if (s.viewKey !== viewKey) throw new TeamInvitationReadError("SOURCE_RESPONSE_INVALID", 502, [prefix + "_SOURCE_VIEW_MISMATCH"]);
    const currentTime = now();
    if (!Number.isFinite(currentTime) || Date.parse(s.observedAt) > currentTime) throw new TeamInvitationReadError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
    return s;
  }

  function fence(snapshot: TeamInvitationSnapshot, binding: TeamInvitationReadBinding, signal?: AbortSignal) {
    return () => {
      if (signal?.aborted) throw new TeamInvitationReadError("REQUEST_CANCELLED", 499);
      const timestamp = now();
      if (!Number.isFinite(timestamp)) throw new TeamInvitationReadError("SOURCE_RESPONSE_INVALID", 502, ["SOURCE_TIME_UNVERIFIED"]);
      try {
        if (!source || typeof source.assertCurrent !== "function") throw new Error("Missing current authority");
        assertSynchronousVoid(() => source.assertCurrent(snapshot, binding, timestamp));
      } catch (error) {
        if (error instanceof TeamInvitationReadError && (error.status === 401 || error.status === 403)) throw new TeamInvitationReadError("SOURCE_AUTHORITY_DENIED", 403);
        if (error instanceof TeamInvitationReadError && error.status === 409) throw new TeamInvitationReadError("SOURCE_VERSION_CHANGED", 409);
        throw new TeamInvitationReadError("SOURCE_AUTHORITY_UNVERIFIED", 503);
      }
    };
  }

  async function read(viewKey: TeamInvitationReadViewKey, rawFilters: unknown, principal: TeamInvitationReadPrincipal, signal?: AbortSignal): Promise<TeamInvitationReadResult> {
    const role = principal?.role;
    if (!principal?.principalRef?.trim() || (role !== "reader" && role !== "reviewer")) throw new TeamInvitationReadError("SOURCE_SCOPE_DENIED", 403);
    if (!teamInvitationReadFilters[viewKey].safeParse(rawFilters).success) throw new TeamInvitationReadError("INVALID_INPUT", 400);
    const prefix = teamInvitationReasonPrefix[viewKey];
    const binding: TeamInvitationReadBinding = freeze(structuredClone({ scope, principal, request: { viewKey, filters: {} } }));
    const s = await observe(viewKey, binding, signal);
    const assertCurrent = fence(s, binding, signal);
    assertCurrent();
    let data: unknown = null;
    if (s.record !== null) {
      const checked = viewSchemas[viewKey].safeParse(s.record);
      if (!checked.success) throw new TeamInvitationReadError("SOURCE_RESPONSE_INVALID", 502, [prefix + "_RECORD_INVALID"]);
      data = checked.data;
    }
    if (data && (data as { provenance: { observedAt: string } }).provenance.observedAt !== s.observedAt) throw new TeamInvitationReadError("SOURCE_RESPONSE_INVALID", 502, [prefix + "_PROVENANCE_MISMATCH"]);
    const capabilities = intents[viewKey].map(c => role === "reviewer" ? { ...c, reasonCodes: [...c.reasonCodes] } : { actionKind: c.actionKind, state: "denied" as const, reasonCodes: ["REVIEWER_REQUIRED"] });
    const deadline = Math.min(Date.parse(s.validUntil), Date.parse(s.observedAt) + teamInvitationMaxObservationAgeMs);
    const stale = deadline <= now();
    const partial = s.coverage.state === "partial";
    const { expectedCount, observedCount } = s.coverage;
    const staleCode = prefix + "_SOURCE_STALE";
    const reasonCodes = [...new Set([...(stale ? [staleCode] : []), ...s.coverage.reasonCodes])];
    const finalFence = () => {
      assertCurrent();
      if (!stale && deadline <= now()) throw new TeamInvitationReadError("SOURCE_VERSION_CHANGED", 409);
    };
    const result: TeamInvitationReadResult = {
      // The record null case is the source's counted zero (the snapshot refuses a null without one): no role registered, or no draft.
      data, version: "ti1-" + digest([binding, alias("permission", s.permissionVersion), viewKey, role, alias("source", s.version), s.observedAt, s.coverage, data]),
      dataState: stale ? "stale" : partial ? "partial" : data === null ? "empty" : "ready",
      coverage: { expectedCount, observedCount, missingCount: expectedCount !== null && observedCount !== null ? expectedCount - observedCount : null,
        complete: !partial && !stale, reasonCodes },
      sourceFreshness: [{ sourceRef: { source: sourceName[viewKey], accountId: scope.accountId, sourceId: null, canonicalId: null, url: null,
        identityState: "unresolved", provenanceRef: alias("source", s.version) }, lastSourceSuccessAt: s.observedAt, observedAt: s.observedAt,
        mirroredAt: null, staleReasonCode: stale ? staleCode : null, ...(stale ? {} : { freshnessState: partial ? "partial" as const : "current" as const }) }],
      assertCurrent: finalFence,
      capabilities: stale || partial ? capabilities.map(c => c.state === "held" ? { ...c, reasonCodes: [...c.reasonCodes, ...(stale ? ["SOURCE_STALE"] : ["SOURCE_COVERAGE_PARTIAL"])] } : c) : capabilities,
    };
    finalFence();
    return result;
  }
  return { read };
}
