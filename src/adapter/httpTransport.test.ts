import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, type ActionRequest, type ReadRequest } from "./contract";
import { createHttpTransport, httpTransportFactory } from "./httpTransport";
import { selectAdapter } from "./selectAdapter";
import { TransportFailure, type TransportRequest } from "./transport";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "sandbox" as const };
const readReq: TransportRequest = { kind: "read", envelope: { schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "overviewSummary", requestedScope: scope, filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r1" } as ReadRequest<unknown> };
const actionReq: TransportRequest = { kind: "action", envelope: { schemaVersion: SCHEMA_VERSION, operation: "decideApproval", requestedScope: scope, actionKind: "decideApproval", entityRefs: [], expectedVersion: "v1", approvalRef: "x", manifestRef: null, idempotencyKey: "k", payload: {}, requestId: "a1" } as ActionRequest<unknown> };
const signal = () => new AbortController().signal;

type Call = { url: string; init: RequestInit };
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** A scripted fetch: answers from a queue, and records what it was asked. */
function scripted(...answers: (Response | Error | ((init: RequestInit) => Promise<Response>))[]) {
  const calls: Call[] = [];
  const queue = [...answers];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(init ?? {}) : next.clone();
  }) as typeof fetch;
  return { fn, calls };
}
const failure = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as TransportFailure);
/** Like a real fetch that never answers: it rejects as soon as its signal aborts, even if it already had. */
const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.aborted ? reject(new DOMException("aborted", "AbortError")) : init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
const sessionOk = () => respond(200, { csrfToken: "csrf-1", principal: { id: "p", displayName: "P", role: "founder" }, allowedScopes: [] });

describe("createHttpTransport: requests", () => {
  it("posts a read to /v1/read with credentials included, JSON, and no CSRF header", async () => {
    const { fn, calls } = scripted(respond(200, { ok: true }));
    const body = await createHttpTransport("http://localhost:8787/", { fetch: fn }).send(readReq, { signal: signal() });
    expect(body).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:8787/v1/read");
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "include", cache: "no-store", redirect: "error" });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("x-csrf-token")).toBe(false);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(readReq.envelope);
  });
  it("takes the CSRF token for a write from the session call, once, and sends it as a header", async () => {
    const { fn, calls } = scripted(sessionOk(), respond(200, { ok: 1 }), respond(200, { ok: 2 }));
    const t = createHttpTransport("http://localhost:8787", { fetch: fn });
    await t.send(actionReq, { signal: signal() });
    await t.send(actionReq, { signal: signal() });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["GET http://localhost:8787/v1/session", "POST http://localhost:8787/v1/action", "POST http://localhost:8787/v1/action"]);
    expect(calls[0]!.init.credentials).toBe("include");
    expect(new Headers(calls[1]!.init.headers).get("x-csrf-token")).toBe("csrf-1");
    expect(new Headers(calls[2]!.init.headers).get("x-csrf-token")).toBe("csrf-1");
  });
  it("posts a save to /v1/save", async () => {
    const { fn, calls } = scripted(sessionOk(), respond(200, {}));
    await createHttpTransport("http://localhost:8787", { fetch: fn }).send({ kind: "save", envelope: { operation: "saveResource" } as never }, { signal: signal() });
    expect(calls[1]!.url).toBe("http://localhost:8787/v1/save");
  });
  it("asks for a new CSRF token after a 401, because the session is gone", async () => {
    const { fn, calls } = scripted(sessionOk(), respond(401, { code: "SESSION_EXPIRED" }), respond(200, { csrfToken: "csrf-2" }), respond(200, {}));
    const t = createHttpTransport("http://localhost:8787", { fetch: fn });
    await failure(t.send(actionReq, { signal: signal() }));
    await t.send(actionReq, { signal: signal() });
    expect(calls.filter((c) => c.url.endsWith("/v1/session"))).toHaveLength(2);
    expect(new Headers(calls[3]!.init.headers).get("x-csrf-token")).toBe("csrf-2");
  });
  it("says the write never went on the wire when the session call fails", async () => {
    const { fn, calls } = scripted(respond(401, { code: "UNAUTHENTICATED" }));
    const e = await failure(createHttpTransport("http://localhost:8787", { fetch: fn }).send(actionReq, { signal: signal() }));
    expect(e).toMatchObject({ kind: "http", status: 401, requestSent: false });
    expect(calls).toHaveLength(1);
  });
});

describe("createHttpTransport: statuses and typed bodies become TransportFailure", () => {
  it.each([401, 403, 404, 409, 422, 429, 500, 502, 503, 504])("maps %i with its typed body", async (status) => {
    const body = { code: "SOMETHING", message: "m", retryAfterMs: null, executionCertainty: "notApplied" };
    const { fn } = scripted(respond(status, body));
    const e = await failure(createHttpTransport("http://localhost:8787", { fetch: fn }).send(readReq, { signal: signal() }));
    expect(e).toBeInstanceOf(TransportFailure);
    expect(e).toMatchObject({ kind: "http", status, body, requestSent: true });
  });
  it("carries the retry delay from the body, or from Retry-After", async () => {
    const a = await failure(createHttpTransport("http://localhost:8787", { fetch: scripted(respond(429, { code: "RATE_LIMITED", retryAfterMs: 2500 }, { "retry-after": "9" })).fn }).send(readReq, { signal: signal() }));
    expect(a.retryAfterMs).toBe(2500);
    const b = await failure(createHttpTransport("http://localhost:8787", { fetch: scripted(respond(429, { code: "RATE_LIMITED" }, { "retry-after": "3" })).fn }).send(readReq, { signal: signal() }));
    expect(b.retryAfterMs).toBe(3000);
  });
  it("keeps no body when the error answer is not JSON", async () => {
    const e = await failure(createHttpTransport("http://localhost:8787", { fetch: scripted(respond(502, "<html>bad gateway</html>", { "content-type": "text/html" })).fn }).send(readReq, { signal: signal() }));
    expect(e).toMatchObject({ kind: "http", status: 502, body: null });
  });
  it("resolves a 2xx that is not JSON as null, so it can never read as success", async () => {
    const body = await createHttpTransport("http://localhost:8787", { fetch: scripted(respond(200, "not json")).fn }).send(readReq, { signal: signal() });
    expect(body).toBeNull();
  });
  it("maps a failed connection to network", async () => {
    const e = await failure(createHttpTransport("http://localhost:8787", { fetch: scripted(new TypeError("fetch failed")).fn }).send(readReq, { signal: signal() }));
    expect(e.kind).toBe("network");
  });
  it("maps a stalled server to timeout", async () => {
    const e = await failure(createHttpTransport("http://localhost:8787", { fetch: scripted(hang).fn, timeoutMs: 20 }).send(readReq, { signal: signal() }));
    expect(e.kind).toBe("timeout");
  });
  it("honours the caller's signal: aborted before and during the request", async () => {
    const t = createHttpTransport("http://localhost:8787", { fetch: scripted(hang).fn });
    const during = new AbortController();
    const pending = failure(t.send(readReq, { signal: during.signal }));
    during.abort();
    expect((await pending).kind).toBe("aborted");
    const before = new AbortController();
    before.abort();
    expect((await failure(t.send(readReq, { signal: before.signal }))).kind).toBe("aborted");
  });
  it("passes the live adapter's own timeout reason through as the timeout it is", async () => {
    const controller = new AbortController();
    const pending = failure(createHttpTransport("http://localhost:8787", { fetch: scripted(hang).fn }).send(readReq, { signal: controller.signal }));
    controller.abort(new TransportFailure("timeout"));
    expect((await pending).kind).toBe("timeout");
  });
});

describe("createHttpTransport: base URL", () => {
  it.each(["https://api.example.test", "http://localhost:8787", "http://127.0.0.1:1"])("accepts %s", (url) => expect(() => createHttpTransport(url)).not.toThrow());
  it.each(["http://api.example.test", "ftp://localhost", "not a url", "https://user:pw@api.example.test", ""])("refuses %j", (url) => expect(() => createHttpTransport(url)).toThrow(/VITE_FARDA_ADAPTER_BASE_URL/));
});

describe("wiring", () => {
  it("keeps the pending transport when no base URL is set", async () => {
    expect(httpTransportFactory({ environment: "sandbox", baseUrl: null })).toBeUndefined();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = selectAdapter({ VITE_FARDA_ADAPTER: "sandbox" }, "", { createTransport: httpTransportFactory });
    const e = await adapter.readView({ ...(readReq.envelope as ReadRequest<unknown>) }).then(() => null, (x: unknown) => x as { body: { code: string } });
    expect(e!.body.code).toBe("INTEGRATION_PENDING");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it.each(["sandbox", "production"] as const)("uses the HTTP transport when %s and a base URL are set, and never in demo", async (mode) => {
    const { fn, calls } = scripted(respond(401, { code: "UNAUTHENTICATED" }));
    vi.stubGlobal("fetch", fn);
    const adapter = selectAdapter({ VITE_FARDA_ADAPTER: mode, VITE_FARDA_ADAPTER_BASE_URL: "http://localhost:8787" }, "", { createTransport: httpTransportFactory });
    const env = { ...(readReq.envelope as ReadRequest<unknown>), requestedScope: { ...scope, environment: mode } };
    const e = await adapter.readView(env).then(() => null, (x: unknown) => x as { body: { code: string } });
    expect(e!.body.code).toBe("UNAUTHENTICATED");
    expect(calls[0]!.url).toBe("http://localhost:8787/v1/read");
    calls.length = 0;
    const demo = selectAdapter({ VITE_FARDA_ADAPTER: "demo", VITE_FARDA_ADAPTER_BASE_URL: "http://localhost:8787" }, "", { createTransport: httpTransportFactory });
    await demo.readView({ ...(readReq.envelope as ReadRequest<unknown>), requestedScope: { ...scope, environment: "demo" } });
    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe("no secret in the app", () => {
  const source = readFileSync(join(process.cwd(), "src/adapter/httpTransport.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("touches no browser storage, cookie or credential header, and sends the session cookie only by `credentials: include`", () => {
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|Authorization|Set-Cookie|Cookie\b/i);
    expect(code).toMatch(/credentials: "include"/);
  });
  it("keeps the CSRF token in a closure variable only", () => {
    expect(code).not.toMatch(/(?:storage|cookie)\s*[.[]/i);
    expect(code).toMatch(/let csrf: Promise<string> \| null/);
  });
});
