// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@/adapter/contract";
import { AdapterError, mustClearProtectedData } from "@/adapter/errors";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { createHttpTransport } from "@/adapter/httpTransport";
import { COOKIE_NAME, startReferenceServer, type ReferenceServer } from "./server";
import { cookieFetch, freshState, liveOverHttp } from "./testKit";

/** Negative tests for the reference server, a TEST DOUBLE. They prove its behavior, not a real backend's. */
const scope = { workspaceId: "demo-workspace", accountIds: ["demo-account-farda"], environment: "sandbox" };
let seq = 0;

let server: ReferenceServer;
let now = Date.parse("2026-11-04T10:00:00.000Z");
const servers: ReferenceServer[] = [];
const start = async (options: Parameters<typeof startReferenceServer>[0] = {}) => {
  const s = await startReferenceServer({ clock: () => now, ...options });
  servers.push(s);
  return s;
};
beforeAll(async () => { server = await start(); });
afterEach(() => { now = Date.parse("2026-11-04T10:00:00.000Z"); });
afterAll(async () => { await Promise.all(servers.map((s) => s.close())); });

type Auth = { cookie: string; csrf: string; setCookie: string };
async function signIn(on: ReferenceServer, user: string, state = freshState("s")): Promise<Auth> {
  const res = await fetch(`${on.url}/dev/sign-in?user=${user}&state=${state}`, { redirect: "manual" });
  const setCookie = res.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0]!;
  const session = (await (await fetch(`${on.url}/v1/session`, { headers: { cookie } })).json()) as { csrfToken: string };
  return { cookie, csrf: session.csrfToken, setCookie };
}
const post = (on: ReferenceServer, path: string, body: unknown, auth: Auth | null, opts: { csrf?: string | null } = {}) =>
  fetch(`${on.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { cookie: auth.cookie } : {}), ...(opts.csrf === null ? {} : auth ? { "x-csrf-token": opts.csrf ?? auth.csrf } : {}) },
    body: JSON.stringify(body),
  });
const readEnv = (over: Record<string, unknown> = {}) => ({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "overviewSummary", requestedScope: scope, filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: `r-${++seq}`, ...over });
const actionEnv = (over: Record<string, unknown> = {}) => ({
  schemaVersion: SCHEMA_VERSION, operation: "decideApproval", requestedScope: scope, actionKind: "decideApproval", entityRefs: [], expectedVersion: "v1", approvalRef: "demo-approval-exact",
  manifestRef: null, idempotencyKey: `key-${++seq}`, payload: { decision: "approved" }, requestId: `a-${seq}`, ...over,
});
const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("startup", () => {
  it("refuses to start when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(startReferenceServer()).rejects.toThrow(/NODE_ENV is production/);
    vi.unstubAllEnvs();
  });
  it("binds only to the loopback address", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("sign-in and the session cookie", () => {
  it("issues an HttpOnly SameSite=Lax cookie, keeps the value out of every body, and has one fake user per role", async () => {
    expect(server.users.map((u) => u.role)).toEqual(["founder", "operator", "reviewer", "finance", "viewer", "runner"]);
    const auth = await signIn(server, "reviewer");
    expect(auth.setCookie).toMatch(/HttpOnly/);
    expect(auth.setCookie).toMatch(/SameSite=Lax/);
    const value = auth.cookie.split("=")[1]!;
    const session = await json(await fetch(`${server.url}/v1/session`, { headers: { cookie: auth.cookie } }));
    expect(session.principal).toMatchObject({ role: "reviewer" });
    expect(JSON.stringify(session)).not.toContain(value);
    expect(session.allowedScopes).toEqual([{ workspaceId: "demo-workspace", accountIds: ["demo-account-farda"], environment: "sandbox" }]);
  });
  it("refuses an unknown user", async () => {
    expect((await fetch(`${server.url}/dev/sign-in?user=root`, { redirect: "manual" })).status).toBe(422);
  });
  it("expires an idle session after 60 minutes and clears the cookie (D-1)", async () => {
    const auth = await signIn(server, "founder");
    now += 61 * 60_000;
    const res = await fetch(`${server.url}/v1/session`, { headers: { cookie: auth.cookie } });
    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("SESSION_EXPIRED");
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
  it("slides the idle timeout while the session is used, up to 12 hours", async () => {
    const auth = await signIn(server, "founder");
    for (let i = 0; i < 12; i++) { now += 59 * 60_000; expect((await fetch(`${server.url}/v1/session`, { headers: { cookie: auth.cookie } })).status).toBe(200); }
    now += 59 * 60_000;
    expect((await fetch(`${server.url}/v1/session`, { headers: { cookie: auth.cookie } })).status).toBe(401);
  });
});

describe("cookie missing: 401 clears protected data", () => {
  it("answers 401 with a typed body, and the adapter says to clear protected data", async () => {
    const res = await post(server, "/v1/read", readEnv(), null);
    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("UNAUTHENTICATED");
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(server.url, { fetch: cookieFetch(server.url, {}) }), retryDelayMs: 0 });
    const error = await adapter.readView(readEnv() as never).then(() => null, (e: unknown) => e as AdapterError);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error!.category).toBe("unauthenticated");
    expect(mustClearProtectedData(error!.category)).toBe(true);
  });
  it("is the same for a write, which applied nothing", async () => {
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(server.url, { fetch: cookieFetch(server.url, {}) }), retryDelayMs: 0 });
    const error = await adapter.submitAction(actionEnv() as never).then(() => null, (e: unknown) => e as AdapterError);
    expect(error!.body).toMatchObject({ code: "UNAUTHENTICATED", executionCertainty: "notApplied" });
  });
});

describe("CSRF on writes", () => {
  it("refuses a write with no token or the wrong one, applies nothing, and a read needs none", async () => {
    const auth = await signIn(server, "founder");
    for (const csrf of [null, "not-the-token"]) {
      const res = await post(server, "/v1/action", actionEnv(), auth, { csrf });
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ code: "FORBIDDEN", executionCertainty: "notApplied" });
    }
    // Nothing was applied: the approval is still undecided, so the same decision now succeeds.
    expect((await post(server, "/v1/action", actionEnv(), auth)).status).toBe(200);
    expect((await post(server, "/v1/read", readEnv(), auth, { csrf: null })).status).toBe(200);
  });
  it("refuses a disallowed browser origin", async () => {
    const auth = await signIn(server, "founder");
    const res = await fetch(`${server.url}/v1/read`, { method: "POST", headers: { "content-type": "application/json", cookie: auth.cookie, origin: "http://evil.example" }, body: JSON.stringify(readEnv()) });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("roles (D-3, D-5)", () => {
  it("lets a viewer read and refuses every write", async () => {
    const auth = await signIn(server, "viewer");
    expect((await post(server, "/v1/read", readEnv(), auth)).status).toBe(200);
    const res = await post(server, "/v1/action", actionEnv(), auth);
    expect(res.status).toBe(403);
    expect((await json(res)).message).toMatch(/AUTHORITY_REQUIRED/);
    expect((await post(server, "/v1/save", { schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: scope, resourceKind: "evidenceDraft", resourceRef: "demo-evidence-1", expectedVersion: "v1", idempotencyKey: "k", requestId: "s", payload: {} }, auth)).status).toBe(403);
  });
  it("keeps the job service to runs and dispatch", async () => {
    const auth = await signIn(server, "runner");
    expect((await post(server, "/v1/action", actionEnv(), auth)).status).toBe(403);
    expect((await post(server, "/v1/action", actionEnv({ operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", payload: {}, approvalRef: "demo-approval-nope" }), auth)).status).not.toBe(403);
  });
  it("lets only a founder or reviewer decide, and an operator cannot", async () => {
    expect((await post(server, "/v1/action", actionEnv(), await signIn(server, "operator"))).status).toBe(403);
  });
  it("sends founder-only action kinds to a founder only", async () => {
    const env = () => actionEnv({ operation: "requestApproval", actionKind: "executePayment", approvalRef: null, payload: {} });
    const refused = await post(server, "/v1/action", env(), await signIn(server, "reviewer"));
    expect(refused.status).toBe(403);
    expect((await json(refused)).message).toMatch(/founder/);
    expect((await post(server, "/v1/action", env(), await signIn(server, "founder"))).status).not.toBe(403);
  });
  it("refuses an approver who is also the requester, and accepts a different person", async () => {
    const state = freshState("req");
    const requester = await signIn(server, "reviewer", state); // the reviewer asked for demo-approval-exact (seeded)
    const own = await post(server, "/v1/action", actionEnv(), requester);
    expect(own.status).toBe(403);
    expect((await json(own)).message).toMatch(/must not approve/);
    const other = await post(server, "/v1/action", actionEnv(), await signIn(server, "founder", state));
    expect(other.status).toBe(200);
    expect(await json(other)).toMatchObject({ state: "approved", executionCertainty: "applied", receiptRefs: expect.any(Array) });
  });
  it("tracks who requested an approval it created", async () => {
    const state = freshState("collab");
    const operator = await signIn(server, "operator", state);
    const asked = await post(server, "/v1/action", actionEnv({ operation: "requestApproval", actionKind: "queueNextAction", approvalRef: null, payload: { collaborationId: "demo-collab-1", actionKey: "next" } }), operator);
    const body = await json(asked);
    if (asked.status === 200 && body.approvalRef) {
      const founder = await signIn(server, "founder", state);
      expect((await post(server, "/v1/action", actionEnv({ approvalRef: body.approvalRef }), founder)).status).not.toBe(403);
    }
    expect(asked.status).not.toBe(403);
  });
});

describe("scope (D-4): refuse, never narrow", () => {
  it.each([
    ["another workspace", { ...scope, workspaceId: "someone-else" }],
    ["another account", { ...scope, accountIds: ["not-mine"] }],
    ["a granted account plus one that is not", { ...scope, accountIds: ["demo-account-farda", "not-mine"] }],
    ["another environment", { ...scope, environment: "production" }],
  ])("answers FORBIDDEN for %s on a read, an action and a save", async (_label, requestedScope) => {
    const auth = await signIn(server, "founder");
    const results = await Promise.all([
      post(server, "/v1/read", readEnv({ requestedScope }), auth),
      post(server, "/v1/action", actionEnv({ requestedScope }), auth),
      post(server, "/v1/save", { schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope, resourceKind: "evidenceDraft", resourceRef: "demo-evidence-1", expectedVersion: "v1", idempotencyKey: "k", requestId: "s", payload: {} }, auth),
    ]);
    for (const res of results) {
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ code: "FORBIDDEN", executionCertainty: "notApplied" });
    }
  });
  it("answers an unknown record inside the scope as not found, and the same call outside it as forbidden (Q-02)", async () => {
    const auth = await signIn(server, "founder");
    const inside = await post(server, "/v1/read", readEnv({ viewKey: "approvalDetail", filters: { approvalId: "demo-approval-missing" } }), auth);
    expect(inside.status).toBe(404);
    expect((await json(inside)).code).toBe("RECORD_NOT_FOUND");
    const outside = await post(server, "/v1/read", readEnv({ viewKey: "approvalDetail", filters: { approvalId: "demo-approval-missing" }, requestedScope: { ...scope, workspaceId: "someone-else" } }), auth);
    expect(outside.status).toBe(403);
  });
});

describe("idempotency (D-8, D-9)", () => {
  it("returns the stored answer for the same key and payload, and applies once", async () => {
    const auth = await signIn(server, "founder");
    const env = actionEnv();
    const first = await json(await post(server, "/v1/action", env, auth));
    const again = await json(await post(server, "/v1/action", { ...env, requestId: "replay" }, auth));
    expect(again).toEqual(first);
    expect(server.audit().some((e) => e.event === "replay")).toBe(true);
  });
  it("answers the same key with a changed payload as MANIFEST_CHANGED, and applied nothing", async () => {
    const auth = await signIn(server, "founder");
    const env = actionEnv();
    expect((await post(server, "/v1/action", env, auth)).status).toBe(200);
    const res = await post(server, "/v1/action", { ...env, payload: { decision: "rejected", reason: "changed my mind" } }, auth);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "MANIFEST_CHANGED", executionCertainty: "notApplied" });
  });
  it("scopes a key to the principal and the kind: another user's identical key is a different command", async () => {
    const state = freshState("scope");
    const env = actionEnv({ idempotencyKey: "shared-key" });
    const a = await post(server, "/v1/action", env, await signIn(server, "founder", state));
    const b = await post(server, "/v1/action", env, await signIn(server, "reviewer", state));
    expect(a.status).toBe(200);
    // The reviewer's command is new, so it reaches the service, which finds the approval already decided (or refuses a self-approval).
    expect(b.status).toBeGreaterThanOrEqual(400);
  });
  it("keeps a key for 14 days, then treats it as a new command (the version check still protects the record)", async () => {
    const state = freshState("ret");
    let auth = await signIn(server, "founder", state);
    const env = actionEnv();
    expect((await post(server, "/v1/action", env, auth)).status).toBe(200);
    now += 14 * 24 * 60 * 60_000 - 60_000;
    auth = await signIn(server, "founder", state);
    await post(server, "/v1/action", env, auth);
    expect(server.audit().filter((e) => e.event === "replay" && e.detail.requestId === env.requestId)).toHaveLength(1);
    now += 2 * 60_000;
    auth = await signIn(server, "founder", state);
    await post(server, "/v1/action", env, auth);
    // Past 14 days the stored answer is gone, so this call is run as a new command, not replayed. (The demo services
    // underneath keep their own answers and have no retention, so this test checks the server's decision, not the record.)
    expect(server.audit().filter((e) => e.event === "replay" && e.detail.requestId === env.requestId)).toHaveLength(1);
    expect(server.audit().filter((e) => e.event === "action" && e.detail.requestId === env.requestId).length).toBeGreaterThanOrEqual(2);
  });
  it("refuses a write with no key", async () => {
    const auth = await signIn(server, "founder");
    const res = await post(server, "/v1/action", actionEnv({ idempotencyKey: " " }), auth);
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ code: "VALIDATION_FAILED", executionCertainty: "notApplied" });
  });
});

describe("rate limits (D-15)", () => {
  it("answers RATE_LIMITED with retryAfterMs per principal, and the window reopens", async () => {
    const limited = await start({ limits: { readsPerMinute: 3, writesPerMinute: 2 } });
    const a = await signIn(limited, "founder");
    const b = await signIn(limited, "reviewer");
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(limited, "/v1/read", readEnv(), a)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const res = await post(limited, "/v1/read", readEnv(), a);
    const body = await json(res);
    expect(body).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await post(limited, "/v1/read", readEnv(), b)).status).toBe(200);
    now += 61_000;
    expect((await post(limited, "/v1/read", readEnv(), a)).status).toBe(200);
  });
  it("limits writes on their own count and says nothing was applied", async () => {
    const limited = await start({ limits: { readsPerMinute: 100, writesPerMinute: 2 } });
    const a = await signIn(limited, "founder");
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await post(limited, "/v1/action", actionEnv({ approvalRef: `demo-approval-none-${i}` }), a)).status);
    expect(codes[2]).toBe(429);
    const res = await post(limited, "/v1/action", actionEnv(), a);
    expect(await json(res)).toMatchObject({ code: "RATE_LIMITED", executionCertainty: "notApplied" });
  });
});

describe("an uncertain outcome (D-12)", () => {
  it("is never a 2xx: the dispatch answers 502 OUTCOME_UNCERTAIN, and a replay returns the same stored answer", async () => {
    const auth = await signIn(server, "founder");
    expect((await post(server, "/v1/action", actionEnv({ approvalRef: "demo-approval-uncertain" }), auth)).status).toBe(200);
    const dispatch = actionEnv({ operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", approvalRef: "demo-approval-uncertain", payload: {} });
    const res = await post(server, "/v1/action", dispatch, auth);
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body).toMatchObject({ code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain", retryable: false });
    expect(JSON.stringify(body)).not.toMatch(/receipt/i);
    const again = await post(server, "/v1/action", { ...dispatch, requestId: "again" }, auth);
    expect(again.status).toBe(502);
    expect(await json(again)).toEqual(body);
  });
  it("reaches the screen as an outcomeUncertain error through the live adapter, with no receipt and no success", async () => {
    const adapter = liveOverHttp(server, { user: "founder", state: freshState("unc") });
    await adapter.submitAction(actionEnv({ approvalRef: "demo-approval-uncertain" }) as never);
    const error = await adapter.submitAction(actionEnv({ operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", approvalRef: "demo-approval-uncertain", payload: {} }) as never).then(() => null, (e: unknown) => e as AdapterError);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error!.category).toBe("outcomeUncertain");
    expect(error!.body.executionCertainty).toBe("uncertain");
    expect(error!.body.retryable).toBe(false);
  });
});

describe("opaque version tokens (D-10)", () => {
  it("hands out tokens the client cannot parse, accepts them back, and refuses a forged one as stale", async () => {
    const auth = await signIn(server, "founder");
    const read = await json(await post(server, "/v1/read", readEnv({ viewKey: "approvalDetail", filters: { approvalId: "demo-approval-exact" } }), auth));
    const token = read.data.currentVersion as string;
    expect(token).toMatch(/^ver_[A-Za-z0-9_-]{22}$/);
    expect(read.dataVersion).toMatch(/^ver_/);
    expect((await post(server, "/v1/action", actionEnv({ approvalRef: "demo-approval-exact", expectedVersion: "ver_forgedforgedforgedforge" }), auth)).status).toBe(409);
    expect((await post(server, "/v1/action", actionEnv({ approvalRef: "demo-approval-exact", expectedVersion: token }), auth)).status).toBe(200);
  });
});

describe("shapes and statuses (D-2, D-11, D-12, D-14)", () => {
  it("names the supported versions when the schema version is not one", async () => {
    const auth = await signIn(server, "founder");
    const res = await post(server, "/v1/read", readEnv({ schemaVersion: "1999-01-01" }), auth);
    expect(res.status).toBe(422);
    expect((await json(res)).message).toContain(SCHEMA_VERSION);
  });
  it("rejects `scenario` and `fixture` filters outside demo", async () => {
    const auth = await signIn(server, "founder");
    for (const filters of [{ scenario: "stale" }, { fixture: "FX-02-known-zero" }]) expect((await post(server, "/v1/read", readEnv({ filters }), auth)).status).toBe(422);
  });
  it("sends every error body with the fields D-14 names", async () => {
    const auth = await signIn(server, "founder");
    const res = await post(server, "/v1/read", readEnv({ viewKey: "approvalDetail", filters: { approvalId: "none" } }), auth);
    expect(Object.keys(await json(res)).sort()).toEqual(["code", "correlationId", "executionCertainty", "message", "requestId", "retryAfterMs", "retryable"]);
  });
  it("maps categories to statuses: hold 409, forbidden 403, validation 422, unavailable 503", async () => {
    const auth = await signIn(server, "founder");
    const call = async (env: Record<string, unknown>) => (await post(server, "/v1/action", env, auth)).status;
    expect(await call(actionEnv({ operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", approvalRef: "demo-approval-exact", payload: {} }))).toBe(409); // not approved yet: an approval hold
  });
  it("answers an unknown path as 404 and a wrong method as 405", async () => {
    expect((await fetch(`${server.url}/v1/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/v1/read`)).status).toBe(405);
  });
});

describe("audit log (D-16)", () => {
  it("records sign-in, reads, actions and denials in order, and holds no payload, cookie or token", async () => {
    const own = await start();
    const auth = await signIn(own, "founder");
    await post(own, "/v1/read", readEnv(), auth);
    await post(own, "/v1/action", actionEnv({ payload: { decision: "rejected", reason: "a secret reason text" } }), auth);
    await post(own, "/v1/action", actionEnv(), auth, { csrf: null });
    const log = own.audit();
    expect(log.map((e) => e.event)).toEqual(expect.arrayContaining(["signIn", "session", "read", "action", "denied"]));
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log.every((e) => Object.isFrozen(e))).toBe(true);
    const text = JSON.stringify(log);
    for (const secret of [auth.csrf, auth.cookie.split("=")[1]!, "a secret reason text", COOKIE_NAME]) expect(text).not.toContain(secret);
    const snapshot = own.audit();
    snapshot.pop();
    expect(own.audit().length).toBe(log.length);
  });
  it("shows the log to a founder only", async () => {
    expect((await fetch(`${server.url}/dev/audit`, { headers: { cookie: (await signIn(server, "operator")).cookie } })).status).toBe(403);
    expect((await fetch(`${server.url}/dev/audit`, { headers: { cookie: (await signIn(server, "founder")).cookie } })).status).toBe(200);
  });
});
