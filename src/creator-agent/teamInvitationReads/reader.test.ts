// @vitest-environment node
import { describe, expect, it } from "vitest";
import { teamInvitationReadViewKeys, teamInvitationReasonPrefix } from "./contract";
import type { TeamInvitationReadViewKey } from "./contract";
import { createTeamInvitationReadReader, TeamInvitationReadError } from "./reader";
import type { TeamInvitationReadSourceReader } from "./source";
import { teamInvitationRecord, teamInvitationSnapshot, teamInvitationTestScope, teamInvitationTestTime } from "./fixtures.testkit";
import { teamInvitationTestSource } from "./fixtures.testkit";
import { teamPermissionsSchema } from "../../adapter/viewSchemas/settings";
import { recruitmentViewSchemas } from "../../adapter/viewSchemas/recruitment";

const secret = "synthetic-team-invitation-reference-key-not-secret-1";
const now = () => Date.parse(teamInvitationTestTime);
const reader = (source?: TeamInvitationReadSourceReader | TeamInvitationReadSourceReader["read"], extra: { timeoutMs?: number; clock?: () => number } = {}) =>
{
  const native = createTeamInvitationReadReader({ scope: teamInvitationTestScope, secret, source: typeof source === "function" ? teamInvitationTestSource(source) : source, now: extra.clock ?? now, timeoutMs: extra.timeoutMs });
  return { read: (viewKey: TeamInvitationReadViewKey, filters: unknown, role: "reader" | "reviewer", signal?: AbortSignal) =>
    native.read(viewKey, filters, { principalRef: `agent-${role}`, role }, signal) };
};
const failure = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as TeamInvitationReadError; } throw new Error("Expected a team/invitation read failure"); };
const counted = { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] };
const schemas = { teamPermissions: teamPermissionsSchema, invitationDraft: recruitmentViewSchemas.invitationDraft! };

describe("team permissions and invitation draft reader", () => {
  it.each(teamInvitationReadViewKeys)("answers %s as typed INTEGRATION_PENDING with a view-specific reason and no data when no source is configured", async viewKey => {
    for (const role of ["reader", "reviewer"] as const) {
      const error = await failure(reader().read(viewKey, {}, role));
      expect(error).toBeInstanceOf(TeamInvitationReadError);
      expect(error).toMatchObject({ code: "INTEGRATION_PENDING", status: 503, reasonCodes: [teamInvitationReasonPrefix[viewKey] + "_SOURCE_UNCONFIGURED"] });
    }
    expect(teamInvitationReasonPrefix).toEqual({ teamPermissions: "TEAM_PERMISSIONS", invitationDraft: "INVITATION" });
  });

  it.each(teamInvitationReadViewKeys)("validates %s against the frontend schema and labels freshness and coverage", async viewKey => {
    const calls: unknown[] = [];
    const result = await reader(async (scope, request) => { calls.push({ scope, request }); return teamInvitationSnapshot(viewKey); }).read(viewKey, {}, "reviewer");
    expect(calls).toEqual([{ scope: teamInvitationTestScope, request: { viewKey, filters: {} } }]);
    expect(schemas[viewKey].safeParse(result.data).success).toBe(true);
    expect(result.dataState).toBe("ready");
    expect(result.coverage).toEqual({ expectedCount: 1, observedCount: 1, missingCount: 0, complete: true, reasonCodes: [] });
    expect(result.sourceFreshness[0]).toMatchObject({ lastSourceSuccessAt: "2026-11-06T11:55:00.000Z", freshnessState: "current", staleReasonCode: null,
      sourceRef: { url: null, sourceId: null, identityState: "unresolved" } });
    expect(result.sourceFreshness[0]!.sourceRef.provenanceRef).toMatch(/^source-[a-f0-9]{32}$/);
    expect(JSON.stringify(result)).not.toContain("synthetic-team-invitation-v1");
    expect(result.version).toMatch(/^ti1-[a-f0-9]{64}$/);
  });

  it("denies sendInvitation to a reader and holds it, not connected, for a reviewer; the team view carries no grant or assignment", async () => {
    const source: TeamInvitationReadSourceReader["read"] = async (_scope, request) => teamInvitationSnapshot(request.viewKey);
    expect((await reader(source).read("invitationDraft", {}, "reader")).capabilities).toEqual([{ actionKind: "sendInvitation", state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] }]);
    expect((await reader(source).read("invitationDraft", {}, "reviewer")).capabilities).toEqual([{ actionKind: "sendInvitation", state: "held", reasonCodes: ["INVITATION_ACTIONS_NOT_CONNECTED"] }]);
    for (const role of ["reader", "reviewer"] as const) expect((await reader(source).read("teamPermissions", {}, role)).capabilities).toEqual([]);
  });

  it("never lets recorded permission evidence or a source-claimed grant become an available capability", async () => {
    // A source cannot add capabilities: the snapshot is strict.
    expect(await failure(reader(async () => teamInvitationSnapshot("teamPermissions", { capabilities: [{ actionKind: "changeSourceRole", state: "available", reasonCodes: [] }] }))
      .read("teamPermissions", {}, "reviewer"))).toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["TEAM_PERMISSIONS_SOURCE_INVALID"] });
    // Extra keys a role record might carry (a granted flag, a provider grant token) are refused by the strict native schema, never forwarded.
    const record = { ...(teamInvitationRecord("teamPermissions") as object), granted: true, grantToken: "synthetic-grant-token", recordedEvidence: { access: "granted" } };
    expect(await failure(reader(async () => teamInvitationSnapshot("teamPermissions", { record })).read("teamPermissions", {}, "reviewer")))
      .toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["TEAM_PERMISSIONS_RECORD_INVALID"] });
  });

  it("keeps an unread quota unknown and refuses a numeric quota or automatic invitations", async () => {
    const result = await reader(async () => teamInvitationSnapshot("invitationDraft")).read("invitationDraft", {}, "reader");
    expect((result.data as { quota: unknown }).quota).toEqual({ state: "unknown", reasonCode: "QUOTA_NOT_READ" });
    for (const patch of [{ quota: 0 }, { quota: { state: "unknown", reasonCode: "QUOTA_NOT_READ", value: 0 } }, { automateInvitations: "on" }]) {
      const record = { ...(teamInvitationRecord("invitationDraft") as object), ...patch };
      expect(await failure(reader(async () => teamInvitationSnapshot("invitationDraft", { record })).read("invitationDraft", {}, "reader")), JSON.stringify(patch))
        .toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["INVITATION_RECORD_INVALID"] });
    }
  });

  it("reports stale and partial sources honestly and never as complete", async () => {
    const stale = await reader(async () => teamInvitationSnapshot("teamPermissions"), { clock: () => Date.parse("2026-11-06T12:10:00.000Z") }).read("teamPermissions", {}, "reviewer");
    expect(stale).toMatchObject({ dataState: "stale", coverage: { complete: false, reasonCodes: ["TEAM_PERMISSIONS_SOURCE_STALE"] } });
    expect(stale.sourceFreshness[0]).toMatchObject({ staleReasonCode: "TEAM_PERMISSIONS_SOURCE_STALE" });
    expect(stale.sourceFreshness[0]).not.toHaveProperty("freshnessState");
    expect(stale.data).not.toBeNull();
    // The server-owned 15-minute ceiling wins over a longer source lease.
    const longLease = await reader(async () => teamInvitationSnapshot("invitationDraft", { validUntil: "2026-12-30T00:00:00.000Z" }),
      { clock: () => Date.parse("2026-11-06T12:10:01.000Z") }).read("invitationDraft", {}, "reviewer");
    expect(longLease).toMatchObject({ dataState: "stale", coverage: { reasonCodes: ["INVITATION_SOURCE_STALE"] } });
    expect(longLease.capabilities).toEqual([{ actionKind: "sendInvitation", state: "held", reasonCodes: ["INVITATION_ACTIONS_NOT_CONNECTED", "SOURCE_STALE"] }]);
    const partial = await reader(async () => teamInvitationSnapshot("teamPermissions", { coverage: { state: "partial", expectedCount: 6, observedCount: 4, reasonCodes: ["PROVIDER_ROLES_NOT_READ"] } }))
      .read("teamPermissions", {}, "reviewer");
    expect(partial).toMatchObject({ dataState: "partial", coverage: { expectedCount: 6, observedCount: 4, missingCount: 2, complete: false, reasonCodes: ["PROVIDER_ROLES_NOT_READ"] } });
    expect(partial.sourceFreshness[0]).toMatchObject({ freshnessState: "partial" });
    const partialDraft = await reader(async () => teamInvitationSnapshot("invitationDraft", { coverage: { state: "partial", expectedCount: 2, observedCount: 1, reasonCodes: ["DRAFT_MIRROR_INCOMPLETE"] } }))
      .read("invitationDraft", {}, "reviewer");
    expect(partialDraft.capabilities[0]!.reasonCodes).toEqual(["INVITATION_ACTIONS_NOT_CONNECTED", "SOURCE_COVERAGE_PARTIAL"]);
    const unknownTotal = await reader(async () => teamInvitationSnapshot("teamPermissions", { coverage: { state: "partial", expectedCount: null, observedCount: 4, reasonCodes: ["PROVIDER_UNIVERSE_UNKNOWN"] } }))
      .read("teamPermissions", {}, "reader");
    expect(unknownTotal.coverage).toMatchObject({ expectedCount: null, missingCount: null, complete: false });
  });

  it("is empty only when the source counted zero, and never synthesizes an empty success", async () => {
    for (const viewKey of teamInvitationReadViewKeys) {
      const empty = await reader(async () => teamInvitationSnapshot(viewKey, { record: null, coverage: counted })).read(viewKey, {}, "reader");
      expect(empty, viewKey).toMatchObject({ dataState: "empty", data: null, coverage: { expectedCount: 0, observedCount: 0, complete: true } });
      expect(await failure(reader(async () => teamInvitationSnapshot(viewKey, { record: null })).read(viewKey, {}, "reader")), viewKey)
        .toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: [teamInvitationReasonPrefix[viewKey] + "_SOURCE_INVALID"] });
    }
    // A partial null stays partial, never "empty".
    const partialNull = await reader(async () => teamInvitationSnapshot("invitationDraft", { record: null, coverage: { state: "partial", expectedCount: null, observedCount: null, reasonCodes: ["DRAFT_MIRROR_INCOMPLETE"] } }))
      .read("invitationDraft", {}, "reader");
    expect(partialNull).toMatchObject({ dataState: "partial", data: null, coverage: { complete: false } });
  });

  it("refuses foreign scope, another view, future observations, bad coverage and invalid records", async () => {
    const cases: [Record<string, unknown>, string, string[] | undefined][] = [
      [{ scope: { ...teamInvitationTestScope, accountId: "foreign" } }, "SOURCE_AUTHORITY_DENIED", undefined],
      [{ scope: { ...teamInvitationTestScope, workspaceId: "foreign" } }, "SOURCE_AUTHORITY_DENIED", undefined],
      [{ viewKey: "invitationDraft" }, "SOURCE_RESPONSE_INVALID", ["TEAM_PERMISSIONS_SOURCE_VIEW_MISMATCH"]],
      [{ observedAt: "2026-11-06T13:00:00.000Z", validUntil: "2026-11-06T14:00:00.000Z" }, "SOURCE_RESPONSE_INVALID", ["SOURCE_TIME_UNVERIFIED"]],
      [{ record: { matrix: "x" } }, "SOURCE_RESPONSE_INVALID", ["TEAM_PERMISSIONS_RECORD_INVALID"]],
      [{ record: { ...(teamInvitationRecord("teamPermissions") as object), gaps: -1 } }, "SOURCE_RESPONSE_INVALID", ["TEAM_PERMISSIONS_RECORD_INVALID"]],
      [{ coverage: { state: "complete", expectedCount: 2, observedCount: 1, reasonCodes: [] } }, "SOURCE_RESPONSE_INVALID", ["TEAM_PERMISSIONS_SOURCE_INVALID"]],
      [{ coverage: { state: "partial", expectedCount: 2, observedCount: 1, reasonCodes: [] } }, "SOURCE_RESPONSE_INVALID", ["TEAM_PERMISSIONS_SOURCE_INVALID"]],
      [{ credential: "synthetic" }, "SOURCE_RESPONSE_INVALID", ["TEAM_PERMISSIONS_SOURCE_INVALID"]],
    ];
    for (const [patch, code, reasonCodes] of cases) {
      const error = await failure(reader(async () => teamInvitationSnapshot("teamPermissions", patch)).read("teamPermissions", {}, "reader"));
      expect(error, JSON.stringify(patch)).toMatchObject({ code, reasonCodes: reasonCodes ?? [] });
    }
  });

  it("refuses demo-only and unknown filters before any source access", async () => {
    let reads = 0;
    for (const viewKey of teamInvitationReadViewKeys) {
      const source: TeamInvitationReadSourceReader["read"] = async () => { reads++; return teamInvitationSnapshot(viewKey); };
      for (const filters of [{ scenario: "stale" }, { fixture: "x" }, { q: "x" }, { creator: "@studio.rae" }, null, "x"])
        expect(await failure(reader(source).read(viewKey, filters, "reader")), JSON.stringify(filters)).toMatchObject({ code: "INVALID_INPUT", status: 400 });
    }
    expect(reads).toBe(0);
  });

  it("maps source denial, failure, null, timeout and cancellation without leaking source text", async () => {
    const leak = "Bearer synthetic-provider-credential-should-not-leak-0003";
    expect(await failure(reader(async () => { throw new TeamInvitationReadError(leak, 401); }).read("teamPermissions", {}, "reader")))
      .toMatchObject({ code: "SOURCE_AUTHORITY_DENIED", status: 403, reasonCodes: [] });
    const unavailable = await failure(reader(async () => { throw new Error(leak); }).read("invitationDraft", {}, "reader"));
    expect(unavailable).toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 503, reasonCodes: ["INVITATION_SOURCE_UNAVAILABLE"] });
    expect(JSON.stringify({ ...unavailable, message: unavailable.message })).not.toContain("credential");
    expect(await failure(reader(async () => null).read("teamPermissions", {}, "reader"))).toMatchObject({ code: "SOURCE_UNAVAILABLE", reasonCodes: ["TEAM_PERMISSIONS_SOURCE_UNAVAILABLE"] });
    let observedSignal: AbortSignal | undefined;
    const hung: TeamInvitationReadSourceReader["read"] = (_scope, _request, { signal }) => { observedSignal = signal; return new Promise(() => {}); };
    expect(await failure(reader(hung, { timeoutMs: 20 }).read("invitationDraft", {}, "reader"))).toMatchObject({ code: "TIMEOUT", status: 504, reasonCodes: ["INVITATION_SOURCE_TIMEOUT"] });
    expect(observedSignal?.aborted).toBe(true);
    const controller = new AbortController();
    const pending = reader(hung).read("teamPermissions", {}, "reader", controller.signal);
    controller.abort();
    expect(await failure(pending)).toMatchObject({ code: "REQUEST_CANCELLED", status: 499 });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not cache between reads, so a changed source or a later denial is always observed", async () => {
    let calls = 0, deny = false;
    const source: TeamInvitationReadSourceReader["read"] = async () => { calls++; if (deny) throw new TeamInvitationReadError("DENIED", 403); return teamInvitationSnapshot("teamPermissions"); };
    const r = reader(source);
    await r.read("teamPermissions", {}, "reader");
    deny = true;
    expect(await failure(r.read("teamPermissions", {}, "reader"))).toMatchObject({ code: "SOURCE_AUTHORITY_DENIED" });
    expect(calls).toBe(2);
  });

  it("rejects an unknown role and requires a private reference key", async () => {
    expect(await failure(reader(async () => teamInvitationSnapshot("teamPermissions")).read("teamPermissions", {}, "founder" as never))).toMatchObject({ code: "SOURCE_SCOPE_DENIED", status: 403 });
    expect(() => createTeamInvitationReadReader({ scope: teamInvitationTestScope, secret: "short" })).toThrow();
  });
});
