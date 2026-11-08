// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures";
import { SCHEMA_VERSION, readResponseSchema } from "../adapter/contract";
import { adapterErrorBodySchema } from "../adapter/wire";
import { viewSchemas } from "../adapter/viewSchemas";
import { settingsViewSchemas } from "../adapter/viewSchemas/settings";
import { recruitmentViewSchemas } from "../adapter/viewSchemas/recruitment";
import { createLiveAdapter } from "../adapter/liveAdapter";
import { createHttpTransport } from "../adapter/httpTransport";
import { teamInvitationReadViewKeys, teamInvitationReasonPrefix, type TeamInvitationReadViewKey } from "./teamInvitationReads/contract";
import { TeamInvitationReadError } from "./teamInvitationReads/source";
import type { TeamInvitationReadSourceReader } from "./teamInvitationReads/source";
import { teamInvitationRecord, teamInvitationSnapshot, teamInvitationTestScope, teamInvitationTestTime } from "./teamInvitationReads/fixtures.testkit";
import { teamInvitationTestSource } from "./teamInvitationReads/fixtures.testkit";

const apps: ReturnType<typeof createAgentServer>[] = [];
const requestedScope = { workspaceId: teamInvitationTestScope.workspaceId, accountIds: [teamInvitationTestScope.accountId], environment: "sandbox" as const };
const PROVIDER_SECRET = "synthetic-provider-session-credential-not-real-0003";
type TestOptions = Omit<Partial<AgentServerOptions>, "teamInvitationReadSource"> & { teamInvitationReadSource?: TeamInvitationReadSourceReader | TeamInvitationReadSourceReader["read"] };
async function start(extra: TestOptions = {}) {
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: teamInvitationTestScope.workspaceId, accountId: teamInvitationTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => Date.parse(teamInvitationTestTime) }, ...extra, teamInvitationReadSource: typeof extra.teamInvitationReadSource === "function" ? teamInvitationTestSource(extra.teamInvitationReadSource) : extra.teamInvitationReadSource });
  apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test service");
  const origin = `http://127.0.0.1:${address.port}`;
  const read = async (viewKey: string, filters: unknown, options: { token?: string | null; scope?: unknown; cursor?: string | null; signal?: AbortSignal } = {}) => {
    const token = options.token === undefined ? SYNTHETIC_READ_TOKEN : options.token;
    const response = await fetch(`${origin}/v1/read`, { method: "POST", signal: options.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-team-invitation-read", requestedScope: options.scope ?? requestedScope,
        viewKey, filters, period: null, sort: [], page: { cursor: options.cursor ?? null, limit: 50 } }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
  };
  return { app, origin, read };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

describe("authenticated team permission and invitation draft reads (THO-305, THO-298, THO-367)", () => {
  it.each(teamInvitationReadViewKeys)("%s: unconfigured source is a typed INTEGRATION_PENDING error with a specific reason and no data, for reader and reviewer", async viewKey => {
    const { read } = await start();
    for (const token of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN]) {
      const result = await read(viewKey, {}, { token });
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toBe("no-store");
      const body = adapterErrorBodySchema.parse(result.body);
      expect(body).toMatchObject({ code: "INTEGRATION_PENDING", requestId: "synthetic-team-invitation-read", executionCertainty: "notApplied",
        reasonCodes: [teamInvitationReasonPrefix[viewKey] + "_SOURCE_UNCONFIGURED"] });
      expect(result.body).not.toHaveProperty("data");
      expect(result.text).not.toMatch(/invitation-demo|studio\.rae|Founder|Needs assignment|QuickBooks/);
    }
  });

  it.each(teamInvitationReadViewKeys)("%s: unauthenticated, wrong-token and foreign workspace/account/environment reads are denied before source access (AD-01)", async viewKey => {
    let reads = 0;
    const { read } = await start({ teamInvitationReadSource: async () => { reads++; return teamInvitationSnapshot(viewKey); } });
    for (const token of [null, "synthetic-wrong-token-not-a-secret-000000003"]) {
      const denied = await read(viewKey, {}, { token });
      expect(denied.status).toBe(401);
      expect(denied.body).toMatchObject({ code: "AUTH_REQUIRED", message: "Access is not currently permitted.", executionCertainty: "notApplied" });
      expect(denied.body).not.toHaveProperty("data");
    }
    for (const scope of [{ ...requestedScope, workspaceId: "foreign-workspace" }, { ...requestedScope, accountIds: ["foreign-account"] },
      { ...requestedScope, environment: "production" }]) {
      const foreign = await read(viewKey, {}, { scope });
      expect(foreign.status).toBe(400);
      expect(foreign.body).toMatchObject({ code: "INVALID_INPUT", executionCertainty: "notApplied" });
      expect(foreign.body).not.toHaveProperty("data");
    }
    expect(reads).toBe(0);
  });

  it.each(teamInvitationReadViewKeys)("%s: a configured source answer validates against the frontend envelope and view schema with exact scope (AD-09)", async viewKey => {
    const seen: unknown[] = [];
    const { read } = await start({ teamInvitationReadSource: async (scope, request) => { seen.push({ scope, request }); return teamInvitationSnapshot(viewKey); } });
    const result = await read(viewKey, {}, { token: SYNTHETIC_REVIEW_TOKEN });
    expect(result.status).toBe(200);
    const body = readResponseSchema(viewSchemas[viewKey]!).parse(result.body);
    expect(body).toMatchObject({ schemaVersion: SCHEMA_VERSION, requestId: "synthetic-team-invitation-read", dataState: "ready",
      scope: { ...requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, page: { nextCursor: null, hasMore: false },
      coverage: { complete: true, expectedCount: 1, observedCount: 1 } });
    expect(body.sourceFreshness).toHaveLength(1);
    expect(body.capabilities.some(c => c.state === "available")).toBe(false);
    // Exact scope and filters reach the source; nothing is widened or defaulted.
    expect(seen).toEqual([{ scope: teamInvitationTestScope, request: { viewKey, filters: {} } }]);
  });

  it("denies sendInvitation to a reader with REVIEWER_REQUIRED and holds it, not connected, for a reviewer; the team view grants and assigns nothing", async () => {
    const { read, app } = await start({ teamInvitationReadSource: async (_scope, request) => teamInvitationSnapshot(request.viewKey) });
    expect((await read("invitationDraft", {})).body.capabilities).toEqual([{ actionKind: "sendInvitation", state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] }]);
    expect((await read("invitationDraft", {}, { token: SYNTHETIC_REVIEW_TOKEN })).body.capabilities)
      .toEqual([{ actionKind: "sendInvitation", state: "held", reasonCodes: ["INVITATION_ACTIONS_NOT_CONNECTED"] }]);
    for (const token of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN]) expect((await read("teamPermissions", {}, { token })).body.capabilities).toEqual([]);
    // Reading records no action, approval or job.
    for (const table of ["operations_control_requests", "job_runs"])
      expect(app.store.database.prepare(`SELECT count(*) n FROM ${table}`).get()?.n, table).toBe(0);
  });

  it("never presents recorded permission evidence or a source-claimed grant as granting access", async () => {
    const record = { ...(teamInvitationRecord("teamPermissions") as object), granted: true, grantToken: "synthetic-grant-token-0003" };
    const { read } = await start({ teamInvitationReadSource: async () => teamInvitationSnapshot("teamPermissions", { record }) });
    const result = await read("teamPermissions", {}, { token: SYNTHETIC_REVIEW_TOKEN });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["TEAM_PERMISSIONS_RECORD_INVALID"] });
    expect(result.text).not.toContain("synthetic-grant-token-0003");
    expect(result.body).not.toHaveProperty("data");
    const { read: readClaim } = await start({ teamInvitationReadSource: async () => ({ ...teamInvitationSnapshot("teamPermissions"),
      capabilities: [{ actionKind: "changeSourceRole", state: "available", reasonCodes: [] }] }) });
    const claimed = await readClaim("teamPermissions", {}, { token: SYNTHETIC_REVIEW_TOKEN });
    expect(claimed.status).toBe(502);
    expect(claimed.body).toMatchObject({ code: "SOURCE_RESPONSE_INVALID", reasonCodes: ["TEAM_PERMISSIONS_SOURCE_INVALID"] });
  });

  it.each(teamInvitationReadViewKeys)("%s: a non-null cursor is INVALID_CURSOR and demo scenario, fixture and unknown filters are refused (D-11)", async viewKey => {
    let reads = 0;
    const { read } = await start({ teamInvitationReadSource: async () => { reads++; return teamInvitationSnapshot(viewKey); } });
    expect((await read(viewKey, {}, { cursor: "sc1.synthetic-cursor" })).body).toMatchObject({ code: "INVALID_CURSOR", executionCertainty: "notApplied" });
    for (const filters of [{ scenario: "stale" }, { fixture: "x" }, { creator: "@studio.rae" }]) {
      const refused = await read(viewKey, filters);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(reads).toBe(0);
  });

  it("carries stale, partial and empty states with counts and reasons, without turning unknown into zero (AD-03)", async () => {
    let clock = Date.parse(teamInvitationTestTime);
    let mode: "partial" | "empty" | "ready" = "partial";
    const { read } = await start({ operations: { now: () => clock }, teamInvitationReadSource: async (_scope, request) => {
      if (mode === "partial") return teamInvitationSnapshot(request.viewKey, { coverage: { state: "partial", expectedCount: 6, observedCount: 4, reasonCodes: ["PROVIDER_ROLES_NOT_READ"] } });
      if (mode === "empty") return teamInvitationSnapshot(request.viewKey, { record: null, coverage: { state: "complete", expectedCount: 0, observedCount: 0, reasonCodes: [] } });
      return teamInvitationSnapshot(request.viewKey);
    } });
    const partial = await read("teamPermissions", {});
    expect(partial.body).toMatchObject({ dataState: "partial", coverage: { expectedCount: 6, observedCount: 4, missingCount: 2, complete: false, reasonCodes: ["PROVIDER_ROLES_NOT_READ"] } });
    expect(partial.body.data.matrix.length).toBeGreaterThan(0);
    mode = "empty";
    for (const viewKey of teamInvitationReadViewKeys) {
      const empty = await read(viewKey, {});
      expect(empty.body, viewKey).toMatchObject({ dataState: "empty", data: null, coverage: { expectedCount: 0, observedCount: 0, complete: true } });
    }
    mode = "ready";
    const draft = await read("invitationDraft", {});
    expect(draft.body.data.quota).toEqual({ state: "unknown", reasonCode: "QUOTA_NOT_READ" });
    clock = Date.parse("2026-11-06T12:10:00.000Z");
    const stale = await read("invitationDraft", {});
    expect(stale.body).toMatchObject({ dataState: "stale", coverage: { complete: false, reasonCodes: ["INVITATION_SOURCE_STALE"] } });
    expect(stale.body.sourceFreshness[0]).toMatchObject({ staleReasonCode: "INVITATION_SOURCE_STALE", lastSourceSuccessAt: "2026-11-06T11:55:00.000Z" });
    expect(stale.body.data).not.toBeNull();
  });

  it("maps source denial, failure, invalid answers and an uncounted null to typed errors without source text (AD-02)", async () => {
    let mode = "deny";
    const { read } = await start({ teamInvitationReadSource: async (_scope, request) => {
      if (mode === "deny") throw new TeamInvitationReadError(`Bearer ${PROVIDER_SECRET}`, 403);
      if (mode === "fail") throw new Error(`upstream refused token=${PROVIDER_SECRET}`);
      if (mode === "invalid") return { ...teamInvitationSnapshot(request.viewKey), secret: PROVIDER_SECRET };
      if (mode === "numericQuota") return teamInvitationSnapshot(request.viewKey, { record: { ...(teamInvitationRecord(request.viewKey) as object), quota: 0, gaps: -1 } });
      return teamInvitationSnapshot(request.viewKey, { record: null });
    } });
    const expected: Record<string, [number, string, string | null]> = { deny: [403, "SOURCE_AUTHORITY_DENIED", null], fail: [503, "SOURCE_UNAVAILABLE", "_SOURCE_UNAVAILABLE"],
      invalid: [502, "SOURCE_RESPONSE_INVALID", "_SOURCE_INVALID"], numericQuota: [502, "SOURCE_RESPONSE_INVALID", "_RECORD_INVALID"], uncounted: [502, "SOURCE_RESPONSE_INVALID", "_SOURCE_INVALID"] };
    for (const viewKey of teamInvitationReadViewKeys) {
      for (const [next, [status, code, reason]] of Object.entries(expected)) {
        mode = next;
        const result = await read(viewKey, {});
        expect(result.status, `${viewKey} ${next}`).toBe(status);
        expect(result.body).toMatchObject({ code, executionCertainty: "notApplied" });
        if (reason) expect(result.body.reasonCodes).toEqual([teamInvitationReasonPrefix[viewKey] + reason]);
        else expect(result.body).not.toHaveProperty("reasonCodes");
        expect(result.body).not.toHaveProperty("data");
        expect(result.text).not.toContain(PROVIDER_SECRET);
        expect(result.text).not.toContain(SYNTHETIC_READ_TOKEN);
      }
    }
    mode = "deny";
    expect((await read("teamPermissions", {})).body.message).toBe("Access is not currently permitted.");
  });

  it("answers a hung source as a typed 504 TIMEOUT", async () => {
    // The reader's 10 s bound is below the 15 s HTTP request timeout; the unit test proves the bound itself with a short timeout.
    const { read } = await start({ teamInvitationReadSource: (_scope, _request, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
    const result = await read("invitationDraft", {});
    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({ code: "TIMEOUT", reasonCodes: ["INVITATION_SOURCE_TIMEOUT"], executionCertainty: "notApplied" });
  }, 20_000);

  it("never echoes the bearer credential or source version in a successful payload", async () => {
    const { read } = await start({ teamInvitationReadSource: async (_scope, request) => teamInvitationSnapshot(request.viewKey, { version: "synthetic-private-source-version" }) });
    for (const viewKey of teamInvitationReadViewKeys) for (const token of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN]) {
      const result = await read(viewKey, {}, { token });
      expect(result.status).toBe(200);
      for (const secret of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, "synthetic-private-source-version"]) expect(result.text).not.toContain(secret);
    }
  });

  it("aborts the source read when the client disconnects (cancellation)", async () => {
    let signal: AbortSignal | undefined, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { read } = await start({ teamInvitationReadSource: (_scope, _request, options) => { signal = options.signal; entered(); return new Promise(() => {}); } });
    const controller = new AbortController();
    const pending = read("teamPermissions", {}, { signal: controller.signal }).catch(error => error);
    await started;
    controller.abort();
    await pending;
    await expect.poll(() => signal?.aborted).toBe(true);
  });

  it("isolates scope per instance and caches nothing between reads (cache isolation)", async () => {
    let calls = 0;
    const scopes: unknown[] = [];
    const { read } = await start({ teamInvitationReadSource: async (scope, request) => { calls++; scopes.push(scope); return teamInvitationSnapshot(request.viewKey, { version: `synthetic-v${calls}` }); } });
    const one = await read("invitationDraft", {});
    const two = await read("invitationDraft", {});
    expect(calls).toBe(2);
    expect(one.body.dataVersion).not.toBe(two.body.dataVersion);
    expect(scopes).toEqual([teamInvitationTestScope, teamInvitationTestScope]);
  });

  it("shares the per-principal read limit with other reads (FHAD-05 rate limit)", async () => {
    const { read } = await start();
    for (let i = 0; i < 60; i++) await read("operationsOverview", {});
    let last: Awaited<ReturnType<typeof read>> | undefined;
    for (let i = 0; i < 61; i++) last = await read(i % 2 ? "teamPermissions" : "invitationDraft", {});
    expect(last!.status).toBe(429);
    expect(last!.body).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: expect.any(Number) });
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("reports the source and every role, owner and invitation execution as not connected in capabilities", async () => {
    const { origin } = await start();
    const caps = await (await fetch(`${origin}/v1/capabilities`, { headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN } })).json();
    expect(caps.teamInvitationReads).toEqual({ sourceAuthority: "notConnected", views: "read-only-projections", roleChangeExecution: "notConnected",
      ownerAssignmentExecution: "notConnected", invitationSendExecution: "notConnected" });
  });

  it("reaches the frontend through the real HTTP transport and live adapter as a typed unavailable error, or as validated data", async () => {
    let configured = false;
    const { origin } = await start({ teamInvitationReadSource: async (_scope, request) => configured ? teamInvitationSnapshot(request.viewKey) : Promise.reject(new Error("offline")) });
    const readerFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers); headers.set("authorization", `Bearer ${SYNTHETIC_READ_TOKEN}`);
      return fetch(url, { ...init, headers });
    };
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(origin, { fetch: readerFetch }) });
    const request = (viewKey: TeamInvitationReadViewKey) => ({ schemaVersion: SCHEMA_VERSION, operation: "readView" as const, viewKey, requestedScope,
      filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "synthetic-adapter-read" });
    for (const viewKey of teamInvitationReadViewKeys)
      await expect(adapter.readView(request(viewKey))).rejects.toMatchObject({ category: "unavailable", body: { code: "SOURCE_UNAVAILABLE" } });
    configured = true;
    for (const viewKey of teamInvitationReadViewKeys) {
      const response = await adapter.readView(request(viewKey));
      expect(response.dataState, viewKey).toBe("ready");
      expect(response.data, viewKey).not.toBeNull();
    }
    const { origin: pendingOrigin } = await start();
    const pending = createLiveAdapter("sandbox", { transport: createHttpTransport(pendingOrigin, { fetch: readerFetch }) });
    for (const viewKey of teamInvitationReadViewKeys)
      await expect(pending.readView(request(viewKey))).rejects.toMatchObject({ category: "unavailable", body: { code: "INTEGRATION_PENDING" } });
  });

  it("serves exactly the two view keys the frontend registry validates with the same schemas", async () => {
    expect([...teamInvitationReadViewKeys].sort()).toEqual(["invitationDraft", "teamPermissions"]);
    expect(viewSchemas.teamPermissions).toBe(settingsViewSchemas.teamPermissions);
    expect(viewSchemas.invitationDraft).toBe(recruitmentViewSchemas.invitationDraft);
  });
  it.each(teamInvitationReadViewKeys)("%s refuses a demo identity at the authenticated native boundary", async viewKey => {
    const record = { ...teamInvitationRecord(viewKey) as object, datasetKey: "demo-only-record" };
    const { read } = await start({ teamInvitationReadSource: async () => teamInvitationSnapshot(viewKey, { record }) });
    const result = await read(viewKey, {});
    expect(result.status).toBe(502); expect(result.body).not.toHaveProperty("data");
  });

  it.each([403, 409] as const)("rejects a source authority change (%s) before the HTTP read publishes", async status => {
    let entered!: () => void, release!: () => void, changed = false;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const source: TeamInvitationReadSourceReader = {
      async read(_scope, request, options) { const captured = teamInvitationSnapshot(request.viewKey, { principalRef: options.principal.principalRef }); entered(); await gate; return captured; },
      assertCurrent() { if (changed) throw new TeamInvitationReadError("private-revoked-proof", status); },
    };
    const { read } = await start({ teamInvitationReadSource: source });
    const pending = read("invitationDraft", {}); await started; changed = true; release();
    const result = await pending;
    expect(result.status).toBe(status); expect(result.body).not.toHaveProperty("data"); expect(result.text).not.toContain("private-revoked-proof");
  });

});
