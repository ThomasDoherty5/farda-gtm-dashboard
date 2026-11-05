/**
 * REFERENCE SERVER: a test double for the adapter backend, NOT the backend.
 *
 * It implements the defaults in docs/adapter-decisions.md over node:http so the real HTTP path can be exercised: a
 * fake dev sign-in with an HttpOnly cookie, a CSRF header on writes, scope and role checks, idempotency, opaque version
 * tokens, an append-only audit log, per-principal rate limits and the status mapping of D-12. Its data is the demo
 * services' fixture data. It has no identity provider, database, hosting or provider integration, and nothing in it is a
 * secret. THO-283 is not done because this exists.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SCHEMA_VERSION, certaintyOfState, type ActionRequest, type ExecutionCertainty, type ReadRequest, type SaveResourceRequest } from "@/adapter/contract";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { overviewFixtureKeys, type OverviewFixtureKey } from "@/fixtures/overview";
import { AdapterError, type AdapterErrorBody, type ErrorCategory } from "@/adapter/errors";
import type { FardaAdapter } from "@/adapter/adapter";
import {
  DECIDE_ROLES,
  DISPATCH_ROLES,
  FOUNDER_ONLY_ACTION_KINDS,
  RUN_OPERATIONS,
  SEEDED_REQUESTERS,
  WRITE_ROLES,
  defaultUsers,
  type RefUser,
} from "./users";

export const PATHS = { read: "/v1/read", action: "/v1/action", save: "/v1/save", session: "/v1/session" } as const;
export const COOKIE_NAME = "farda_ref_session";
export const CSRF_HEADER = "x-csrf-token";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SESSION_LIFETIME_MS = 12 * 60 * MINUTE;
const SESSION_IDLE_MS = 60 * MINUTE;
const IDEMPOTENCY_RETENTION_MS = 14 * DAY;
const MAX_BODY_BYTES = 1_000_000;
const SUPPORTED_SCHEMA_VERSIONS = [SCHEMA_VERSION];

export type AuditEntry = Readonly<{
  seq: number;
  at: string;
  principal: string;
  role: string | null;
  event: string;
  /** Names and statuses only. Never a payload, cookie, token or message body. */
  detail: Readonly<Record<string, string | number | null>>;
}>;

export type ReferenceServerOptions = {
  /** 0 picks a free port. The server binds to 127.0.0.1 only; there is no host option. */
  port?: number;
  environment?: "sandbox" | "production";
  users?: RefUser[];
  /** Origins the browser app is served from. Cookies are host-based, so use `localhost` for both the app and this server. */
  allowedOrigins?: string[];
  limits?: { readsPerMinute: number; writesPerMinute: number };
  clock?: () => number;
  /** Where the banner and request errors are written. Defaults to a no-op so tests stay quiet. */
  log?: (line: string) => void;
};

export type ReferenceServer = {
  url: string;
  port: number;
  environment: "sandbox" | "production";
  close(): Promise<void>;
  /** A copy of the append-only audit log. */
  audit(): AuditEntry[];
  /** The fixed users, for tests. */
  users: readonly RefUser[];
};

type Session = { id: string; user: RefUser; stateId: string; fixture: OverviewFixtureKey | undefined; csrf: string; createdAt: number; lastSeenAt: number };
type Stored = { hash: string; status: number; body: unknown; at: number };
type DomainState = { adapter: FardaAdapter; idempotency: Map<string, Stored>; requesters: Map<string, string> };
type Kind = "read" | "action" | "save";

/** A response the handler has decided on. `audit` is the code or state recorded. */
class Reply {
  constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string> = {}) {}
}

const STATUS_BY_CATEGORY: Partial<Record<ErrorCategory, number>> = {
  unauthenticated: 401, forbidden: 403, notFound: 404, validation: 422, conflict: 409, approvalHold: 409, capabilityHold: 409,
  resourceHold: 409, rateLimited: 429, unavailable: 503, outcomeUncertain: 502, replayed: 409,
};

/** Fields that carry an internal record version. They leave the server as opaque tokens (D-10). */
const VERSION_KEYS = new Set(["version", "currentVersion", "dataVersion", "payloadVersion", "draftVersion", "resourceVersion"]);

class VersionTokens {
  private readonly secret = randomBytes(16).toString("hex");
  private readonly toToken = new Map<string, string>();
  private readonly toRaw = new Map<string, string>();
  wire(raw: string): string {
    let token = this.toToken.get(raw);
    if (!token) {
      token = `ver_${createHmac("sha256", this.secret).update(raw).digest("base64url").slice(0, 22)}`;
      this.toToken.set(raw, token);
      this.toRaw.set(token, raw);
    }
    return token;
  }
  /** An unknown token passes through, so the service answers it as a stale version instead of this layer guessing. */
  raw(token: string): string {
    return this.toRaw.get(token) ?? token;
  }
  opaque<T>(value: T): T {
    if (Array.isArray(value)) return value.map((v) => this.opaque(v)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, VERSION_KEYS.has(k) && typeof v === "string" ? this.wire(v) : this.opaque(v)])) as T;
    }
    return value;
  }
}

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function startReferenceServer(options: ReferenceServerOptions = {}): Promise<ReferenceServer> {
  if (process.env.NODE_ENV === "production") throw new Error("The reference server is a test double and refuses to run when NODE_ENV is production.");

  const environment = options.environment ?? "sandbox";
  const users = options.users ?? defaultUsers();
  const clock = options.clock ?? Date.now;
  const log = options.log ?? (() => undefined);
  const limits = options.limits ?? { readsPerMinute: 120, writesPerMinute: 30 };
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://localhost:5173", "http://localhost:4173"]);
  const tokens = new VersionTokens();
  const sessions = new Map<string, Session>();
  const states = new Map<string, DomainState>();
  const windows = new Map<string, { start: number; count: number }>();
  const auditLog: AuditEntry[] = [];

  const audit = (principal: string, role: string | null, event: string, detail: Record<string, string | number | null> = {}) => {
    auditLog.push(Object.freeze({ seq: auditLog.length + 1, at: new Date(clock()).toISOString(), principal, role, event, detail: Object.freeze({ ...detail }) }));
  };

  const stateFor = (stateId: string, fixture?: OverviewFixtureKey): DomainState => {
    let state = states.get(stateId);
    if (!state) {
      state = { adapter: createDemoAdapter({ fixture }), idempotency: new Map(), requesters: new Map(Object.entries(SEEDED_REQUESTERS)) };
      states.set(stateId, state);
    }
    return state;
  };

  // ---- Errors --------------------------------------------------------------------------------------

  const errorBody = (code: string, message: string, requestId: string | null, certainty: ExecutionCertainty, extra: Partial<AdapterErrorBody> = {}): AdapterErrorBody => ({
    code,
    message,
    requestId,
    correlationId: `ref-corr-${randomUUID()}`,
    retryable: false,
    retryAfterMs: null,
    executionCertainty: certainty,
    ...extra,
  });
  const refuse = (status: number, code: string, message: string, requestId: string | null, certainty: ExecutionCertainty = "notApplied", extra: Partial<AdapterErrorBody> = {}, headers: Record<string, string> = {}) =>
    new Reply(status, errorBody(code, message, requestId, certainty, extra), headers);

  // ---- Wire helpers --------------------------------------------------------------------------------

  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) return {};
    return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" };
  };

  const send = (req: IncomingMessage, res: ServerResponse, reply: Reply) => {
    res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...corsHeaders(req), ...reply.headers });
    res.end(JSON.stringify(reply.body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("too large"));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const parseCookies = (header: string | undefined) =>
    Object.fromEntries((header ?? "").split(";").flatMap((part) => { const i = part.indexOf("="); return i > 0 ? [[part.slice(0, i).trim(), part.slice(i + 1).trim()] as const] : []; }));

  const sessionCookie = (value: string, maxAgeSeconds: number) => `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;

  // ---- Sessions ------------------------------------------------------------------------------------

  /** Resolves the session or the 401 to send. Sliding idle timeout and a hard lifetime (D-1). */
  const authenticate = (req: IncomingMessage): { session: Session } | { reply: Reply } => {
    const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!id) return { reply: refuse(401, "UNAUTHENTICATED", "Sign in to continue.", null) };
    const session = sessions.get(id);
    const now = clock();
    if (!session || now - session.createdAt > SESSION_LIFETIME_MS || now - session.lastSeenAt > SESSION_IDLE_MS) {
      sessions.delete(id);
      return { reply: refuse(401, "SESSION_EXPIRED", "Your session expired. Sign in again.", null, "notApplied", {}, { "set-cookie": sessionCookie("", 0) }) };
    }
    session.lastSeenAt = now;
    return { session };
  };

  const csrfOk = (req: IncomingMessage, session: Session) => {
    const sent = req.headers[CSRF_HEADER];
    if (typeof sent !== "string") return false;
    const a = Buffer.from(sent);
    const b = Buffer.from(session.csrf);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // ---- Limits (D-15) -------------------------------------------------------------------------------

  const rateLimited = (principal: string, write: boolean): number | null => {
    const key = `${principal}|${write ? "w" : "r"}`;
    const now = clock();
    const limit = write ? limits.writesPerMinute : limits.readsPerMinute;
    const current = windows.get(key);
    if (!current || now - current.start >= MINUTE) {
      windows.set(key, { start: now, count: 1 });
      return null;
    }
    current.count += 1;
    return current.count > limit ? Math.max(1, MINUTE - (now - current.start)) : null;
  };

  // ---- Checks that need the envelope ---------------------------------------------------------------

  const sameAccounts = (granted: string[], requested: string[]) => requested.every((a) => granted.includes(a));

  /** D-4: refuse, never narrow. An environment, workspace or account outside the grant is FORBIDDEN. */
  const scopeError = (session: Session, scope: unknown, requestId: string | null): Reply | null => {
    const certainty = "notApplied" as const;
    if (!isRecord(scope) || typeof scope.workspaceId !== "string" || !Array.isArray(scope.accountIds) || !scope.accountIds.every((a) => typeof a === "string") || typeof scope.environment !== "string")
      return refuse(422, "VALIDATION_FAILED", "requestedScope must name a workspace, accounts and an environment.", requestId, certainty);
    const forbidden = () => refuse(403, "FORBIDDEN", "You do not have access to that workspace, account or environment.", requestId, certainty);
    if (scope.environment !== environment) return forbidden();
    const grant = session.user.grants.find((g) => g.workspaceId === scope.workspaceId);
    if (!grant || !sameAccounts(grant.accountIds, scope.accountIds as string[])) return forbidden();
    return null;
  };

  const envelopeError = (kind: Kind, envelope: unknown): Reply | null => {
    const id = isRecord(envelope) && typeof envelope.requestId === "string" ? envelope.requestId : null;
    if (!isRecord(envelope)) return refuse(422, "VALIDATION_FAILED", "The request body must be a JSON object.", id);
    if (typeof envelope.schemaVersion !== "string" || !SUPPORTED_SCHEMA_VERSIONS.includes(envelope.schemaVersion))
      return refuse(422, "VALIDATION_FAILED", `Unsupported schemaVersion. Supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}.`, id);
    const expected = kind === "read" ? "readView" : kind === "save" ? "saveResource" : null;
    if (expected && envelope.operation !== expected) return refuse(422, "VALIDATION_FAILED", `This path takes operation ${expected}.`, id);
    if (kind === "action" && (typeof envelope.operation !== "string" || ["readView", "saveResource", "inspectRun"].includes(envelope.operation)))
      return refuse(422, "VALIDATION_FAILED", "This path takes an action operation.", id);
    if (kind === "read" && !isRecord(envelope.filters)) return refuse(422, "VALIDATION_FAILED", "A read needs a filters object.", id);
    // D-11: `scenario` and `fixture` steer demo data, so they are accepted only in demo.
    if (kind === "read" && isRecord(envelope.filters) && ("scenario" in envelope.filters || "fixture" in envelope.filters))
      return refuse(422, "VALIDATION_FAILED", "`scenario` and `fixture` are accepted only in demo.", id, "notApplied", { fieldErrors: { filters: "Unknown filter." } });
    if (kind !== "read" && (typeof envelope.idempotencyKey !== "string" || envelope.idempotencyKey.trim() === ""))
      return refuse(422, "VALIDATION_FAILED", "A write needs an idempotency key. Nothing was applied.", id, "notApplied", { fieldErrors: { idempotencyKey: "An idempotency key is required." } });
    return null;
  };

  /** D-3 and D-5. A role never narrows by hiding a button: every rule is checked here. */
  const authorityError = (session: Session, state: DomainState, kind: Kind, envelope: Record<string, unknown>): Reply | null => {
    const id = envelope.requestId as string;
    const role = session.user.role;
    const needs = (what: string) => refuse(403, "FORBIDDEN", `AUTHORITY_REQUIRED: ${what}`, id);
    if (kind === "read") return null;
    if (kind === "save") return WRITE_ROLES.includes(role) ? null : needs("your role cannot save changes.");
    const operation = envelope.operation as string;
    const actionKind = typeof envelope.actionKind === "string" ? envelope.actionKind : "";
    if (role === "runner") return (RUN_OPERATIONS as readonly string[]).includes(operation) ? null : needs("the job service may only dispatch and manage runs.");
    if (operation === "decideApproval") {
      if (!DECIDE_ROLES.includes(role)) return needs("only a founder or reviewer can decide an approval.");
      const approvalRef = typeof envelope.approvalRef === "string" ? envelope.approvalRef : "";
      if (state.requesters.get(approvalRef) === session.user.id) return needs("the person who requested this must not approve it.");
    } else if (operation === "dispatchApprovedAction") {
      if (!DISPATCH_ROLES.includes(role)) return needs("only a founder, reviewer or the job service can dispatch.");
    } else if (!WRITE_ROLES.includes(role)) return needs("your role cannot make changes.");
    if (FOUNDER_ONLY_ACTION_KINDS.includes(actionKind) && role !== "founder") return needs("this needs the founder role.");
    return null;
  };

  // ---- Running the demo services -------------------------------------------------------------------

  /** The demo services only serve the demo environment, so the scope's environment is rewritten on the way in and out. */
  const inbound = <E extends { requestedScope: object }>(env: E): E => ({ ...env, requestedScope: { ...env.requestedScope, environment: "demo" } });
  const outbound = <R extends { scope: { environment: string } }>(res: R): R => ({ ...res, scope: { ...res.scope, environment } });

  const fromAdapterError = (error: AdapterError, requestId: string, write: boolean): Reply => {
    const body = jsonRoundTrip(error.body);
    const status = error.body.code === "TIMEOUT" ? 504 : (STATUS_BY_CATEGORY[error.category] ?? 500);
    const certainty = body.executionCertainty ?? (error.category === "outcomeUncertain" ? "uncertain" : "notApplied");
    return new Reply(status, tokens.opaque({ ...body, requestId: body.requestId ?? requestId, correlationId: body.correlationId ?? `ref-corr-${randomUUID()}`, executionCertainty: write || error.category === "outcomeUncertain" ? certainty : "notApplied", message: body.message ?? error.message }));
  };

  const execute = async (kind: Kind, envelope: Record<string, unknown>, state: DomainState, session: Session, signal: AbortSignal): Promise<Reply> => {
    const requestId = envelope.requestId as string;
    const raw = jsonRoundTrip(envelope);
    if (typeof raw.expectedVersion === "string") raw.expectedVersion = tokens.raw(raw.expectedVersion);
    try {
      if (kind === "read") return new Reply(200, tokens.opaque(jsonRoundTrip(outbound(await state.adapter.readView(inbound(raw as unknown as ReadRequest<unknown>), { signal })))));
      if (kind === "save") return new Reply(200, tokens.opaque(jsonRoundTrip(outbound(await state.adapter.saveResource(inbound(raw as unknown as SaveResourceRequest<unknown>), { signal })))));
      const response = outbound(await state.adapter.submitAction(inbound(raw as unknown as ActionRequest<unknown>), { signal }));
      // D-12: an uncertain write is never a 2xx. It is an error that says the outcome is unknown.
      if (response.state === "outcomeUncertain")
        return refuse(502, "OUTCOME_UNCERTAIN", "The outcome of this action is unknown. Check the source before sending it again.", requestId, "uncertain");
      if (response.executionCertainty === undefined) response.executionCertainty = certaintyOfState(response.state);
      // Remember who asked, for the requester-differs-from-approver rule.
      if (response.approvalRef && envelope.operation === "requestApproval") state.requesters.set(response.approvalRef, session.user.id);
      return new Reply(200, tokens.opaque(jsonRoundTrip(response)));
    } catch (error) {
      if (error instanceof AdapterError) return fromAdapterError(error, requestId, kind !== "read");
      log(`reference server: unexpected ${error instanceof Error ? error.name : "error"} while serving ${kind}`);
      return refuse(500, "SOURCE_UNAVAILABLE", "The reference server could not complete this request.", requestId, kind === "read" ? "notApplied" : "uncertain", { retryable: true });
    }
  };

  // ---- Request handling ----------------------------------------------------------------------------

  const handleKind = async (req: IncomingMessage, kind: Kind, session: Session): Promise<Reply> => {
    const write = kind !== "read";
    const principal = session.user.id;
    const role = session.user.role;
    const wait = rateLimited(principal, write);
    if (wait !== null) {
      audit(principal, role, "rateLimited", { kind, retryAfterMs: wait });
      return refuse(429, "RATE_LIMITED", "Too many requests. Try again shortly.", null, "notApplied", { retryable: true, retryAfterMs: wait }, { "retry-after": String(Math.ceil(wait / 1000)) });
    }
    if (write && !csrfOk(req, session)) {
      audit(principal, role, "denied", { kind, reason: "csrf" });
      return refuse(403, "FORBIDDEN", "The request did not carry a valid CSRF token. Nothing was applied.", null);
    }
    let envelope: unknown;
    try {
      const text = await readBody(req);
      envelope = JSON.parse(text);
    } catch {
      return refuse(422, "VALIDATION_FAILED", "The request body is not valid JSON.", null);
    }
    const invalid = envelopeError(kind, envelope);
    if (invalid) return invalid;
    const env = envelope as Record<string, unknown>;
    const requestId = env.requestId as string;
    const refused = scopeError(session, env.requestedScope, requestId);
    if (refused) { audit(principal, role, "denied", { kind, reason: "scope", requestId }); return refused; }
    const state = stateFor(session.stateId, session.fixture);
    const unauthorized = authorityError(session, state, kind, env);
    if (unauthorized) { audit(principal, role, "denied", { kind, reason: "authority", requestId }); return unauthorized; }

    const label = kind === "read" ? String(env.viewKey) : kind === "save" ? String(env.resourceKind) : `${String(env.operation)}:${String(env.actionKind)}`;
    const controller = new AbortController();
    if (!write) {
      const reply = await execute(kind, env, state, session, controller.signal);
      audit(principal, role, "read", { view: label, requestId, status: reply.status });
      return reply;
    }

    // D-8 and D-9: keys are scoped to principal and kind, kept 14 days with the stored response.
    const scopeOfKey = `${principal}|${kind}|${label}|${String(env.idempotencyKey)}`;
    const hash = sha({ ...env, requestId: undefined });
    const prior = state.idempotency.get(scopeOfKey);
    if (prior && clock() - prior.at > IDEMPOTENCY_RETENTION_MS) state.idempotency.delete(scopeOfKey);
    const kept = state.idempotency.get(scopeOfKey);
    if (kept) {
      if (kept.hash !== hash) {
        audit(principal, role, "denied", { kind, reason: "manifestChanged", requestId });
        return refuse(409, "MANIFEST_CHANGED", "This idempotency key was already used for a different request. Nothing was applied.", requestId);
      }
      audit(principal, role, "replay", { operation: label, requestId, status: kept.status });
      return new Reply(kept.status, kept.body);
    }
    const reply = await execute(kind, env, state, session, controller.signal);
    // A success and an unknown outcome are both kept: a retry must get the same answer, never run again.
    if (reply.status < 300 || (isRecord(reply.body) && reply.body.executionCertainty === "uncertain")) state.idempotency.set(scopeOfKey, { hash, status: reply.status, body: reply.body, at: clock() });
    audit(principal, role, kind === "action" ? "action" : "save", { operation: label, requestId, status: reply.status, code: isRecord(reply.body) && typeof reply.body.code === "string" ? reply.body.code : null });
    return reply;
  };

  const sessionReply = (session: Session) => {
    const grant = session.user.grants.find((g) => g.workspaceId && g.accountIds.length > 0);
    return new Reply(200, {
      referenceServer: true,
      principal: session.user.id,
      referencePrincipal: { id: session.user.id, displayName: session.user.displayName, role: session.user.role },
      scope: grant ? { workspaceId: grant.workspaceId, accountIds: grant.accountIds, environment, authorizationScopeVersion: "reference-scope-v1" } : null,
      allowedScopes: session.user.grants.map((g) => ({ workspaceId: g.workspaceId, accountIds: g.accountIds, environment })),
      csrfToken: session.csrf,
      expiresAt: new Date(session.createdAt + SESSION_LIFETIME_MS).toISOString(),
      idleExpiresAt: new Date(session.lastSeenAt + SESSION_IDLE_MS).toISOString(),
    });
  };

  const signIn = (url: URL, body: Record<string, unknown> | null): Reply => {
    const wanted = body && typeof body.user === "string" ? body.user : url.searchParams.get("user");
    const user = users.find((u) => u.role === wanted || u.id === wanted);
    if (!user) return refuse(422, "VALIDATION_FAILED", `Choose one of: ${users.map((u) => u.role).join(", ")}.`, null);
    const stateWanted = (body && typeof body.state === "string" ? body.state : url.searchParams.get("state")) ?? "default";
    // Dev only: a named state may be seeded with one of the demo overview fixtures. Reads still may not name a fixture (D-11).
    const fixtureWanted = (body && typeof body.fixture === "string" ? body.fixture : url.searchParams.get("fixture")) ?? undefined;
    const fixture = fixtureWanted === undefined ? undefined : overviewFixtureKeys.find((k) => k === fixtureWanted);
    if (fixtureWanted !== undefined && !fixture) return refuse(422, "VALIDATION_FAILED", `Unknown fixture. Choose one of: ${overviewFixtureKeys.join(", ")}.`, null);
    const id = randomBytes(24).toString("hex");
    const now = clock();
    const session: Session = { id, user, fixture, stateId: stateWanted.slice(0, 64), csrf: randomBytes(24).toString("hex"), createdAt: now, lastSeenAt: now };
    sessions.set(id, session);
    audit(user.id, user.role, "signIn", { state: session.stateId });
    const next = url.searchParams.get("next");
    const headers = { "set-cookie": sessionCookie(id, SESSION_LIFETIME_MS / 1000) };
    if (next && /^\/(?!\/)/.test(next)) return new Reply(302, { signedIn: user.role }, { ...headers, location: next });
    return new Reply(200, { signedIn: user.role, principal: user.id }, headers);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://reference.local");
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin) && url.pathname.startsWith("/v1/")) {
      audit("anonymous", null, "denied", { reason: "origin" });
      return send(req, res, refuse(403, "FORBIDDEN", "This origin is not allowed.", null));
    }
    if (req.method === "OPTIONS") {
      return void res.writeHead(204, { ...corsHeaders(req), "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": `content-type, ${CSRF_HEADER}`, "access-control-max-age": "600" }).end();
    }
    if (url.pathname === "/dev/sign-in" && (req.method === "GET" || req.method === "POST")) {
      let body: Record<string, unknown> | null = null;
      if (req.method === "POST") { try { const parsed: unknown = JSON.parse(await readBody(req)); body = isRecord(parsed) ? parsed : null; } catch { body = null; } }
      return send(req, res, signIn(url, body));
    }
    if (url.pathname === "/dev/sign-out" && req.method === "POST") {
      const auth = authenticate(req);
      if ("reply" in auth) return send(req, res, auth.reply);
      if (!csrfOk(req, auth.session)) return send(req, res, refuse(403, "FORBIDDEN", "The request did not carry a valid CSRF token.", null));
      sessions.delete(auth.session.id);
      audit(auth.session.user.id, auth.session.user.role, "signOut");
      return send(req, res, new Reply(200, { signedOut: true }, { "set-cookie": sessionCookie("", 0) }));
    }
    if (url.pathname === "/dev/audit" && req.method === "GET") {
      const auth = authenticate(req);
      if ("reply" in auth) return send(req, res, auth.reply);
      if (auth.session.user.role !== "founder") return send(req, res, refuse(403, "FORBIDDEN", "AUTHORITY_REQUIRED: the audit log needs the founder role.", null));
      return send(req, res, new Reply(200, { entries: auditLog }));
    }

    const kind = (Object.entries(PATHS).find(([, path]) => path === url.pathname)?.[0] ?? null) as Kind | "session" | null;
    if (!kind) return send(req, res, refuse(404, "RECORD_NOT_FOUND", "No such path.", null));
    const wantedMethod = kind === "session" ? "GET" : "POST";
    if (req.method !== wantedMethod) return send(req, res, refuse(405, "VALIDATION_FAILED", `Use ${wantedMethod} for this path.`, null, "notApplied", {}, { allow: wantedMethod }));

    const auth = authenticate(req);
    if ("reply" in auth) {
      audit("anonymous", null, "denied", { reason: "unauthenticated", path: url.pathname });
      return send(req, res, auth.reply);
    }
    if (kind === "session") {
      audit(auth.session.user.id, auth.session.user.role, "session");
      return send(req, res, sessionReply(auth.session));
    }
    return send(req, res, await handleKind(req, kind, auth.session));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(req, res, refuse(500, "SOURCE_UNAVAILABLE", "The reference server could not complete this request.", null, "uncertain"));
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    environment,
    users,
    audit: () => [...auditLog],
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
