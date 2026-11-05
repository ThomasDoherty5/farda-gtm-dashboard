import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { evidencePacketSchema } from "./evidence.ts";
import type { ConfigBinding } from "./config.ts";
import { AGENT_SCHEMA_VERSION, POLICY_VERSION, AGENT_VERSION } from "./assessmentSchema.ts";
import { assessCreator, MODEL_FOR_ROUTE } from "./policy.ts";
import { AgentStore, AgentConflict } from "./store.ts";
import type { StoredAssessment } from "./store.ts";

const ADAPTER_SCHEMA = "2026-11-02.proposed";
const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
type Role = "reader" | "reviewer";
type Session = { role: Role; csrf: string; expiresAt: number };
export type AgentServerOptions = { databasePath: string; readToken: string; reviewToken: string; workspaceId: string; accountId: string; bindings?: ConfigBinding[]; secureCookies?: boolean; publicOrigin?: string };
const writeSchema = z.object({ expectedVersion: z.number().int().nonnegative(), policyVersion: z.literal(POLICY_VERSION), configHash: z.string().nullable(), packet: evidencePacketSchema }).strict();

/** First real agent service; independent of all demo adapters and reference-server fixtures. */
export function createAgentServer(options: AgentServerOptions) {
  if (options.readToken.length < 32 || options.reviewToken.length < 32 || safeEqual(options.readToken, options.reviewToken)) throw new Error("Two distinct server-only tokens of at least 32 characters are required");
  if (!options.workspaceId || !options.accountId) throw new Error("Explicit workspace and account scope are required");
  const store = new AgentStore(options.databasePath, { workspaceId: options.workspaceId, accountId: options.accountId });
  const sessions = new Map<string, Session>();
  const bindings = options.bindings ?? [];
  const modelBinding = (route: "website" | "tiktok-shop") => bindings.find((b) => b.current.modelId === MODEL_FOR_ROUTE[route]) ?? null;
  const authorize = (req: IncomingMessage): { role: Role; session: Session | null } | null => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice(7);
      return safeEqual(token, options.reviewToken) ? { role: "reviewer", session: null } : safeEqual(token, options.readToken) ? { role: "reader", session: null } : null;
    }
    const cookie = req.headers.cookie?.split(";").map((x) => x.trim()).find((x) => x.startsWith("farda_agent="))?.slice(12);
    const session = cookie ? sessions.get(cookie) : null;
    if (session && session.expiresAt > Date.now()) return { role: session.role, session };
    return null;
  };
  const current = (record: StoredAssessment) => {
    const binding = modelBinding(record.packet.checkoutRoute);
    const stale = record.assessment.policyVersion !== POLICY_VERSION || record.assessment.agentVersion !== AGENT_VERSION || record.assessment.config.hash !== (binding?.hash ?? null);
    return { ...record, stale, assessment: stale ? { ...record.assessment, state: "reviewNeeded" as const, reasonCodes: [...record.assessment.reasonCodes, "STALE_ASSESSMENT"] } : record.assessment };
  };
  const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(JSON.stringify(body));
  };
  const bodyOf = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1_048_576) throw new Error("BODY_TOO_LARGE");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/health" && req.method === "GET") return reply(res, 200, { service: "farda-creator-agent", schemaVersion: AGENT_SCHEMA_VERSION });
      if (path === "/v1/session" && req.method === "GET") {
        let authenticated = authorize(req);
        if (!authenticated && req.headers.authorization?.startsWith("Basic ")) {
          const [name, token] = Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":");
          if (name === "reader" && token && safeEqual(token, options.readToken)) authenticated = { role: "reader", session: null };
        }
        if (!authenticated) return reply(res, 401, { code: "AUTH_REQUIRED" }, { "www-authenticate": 'Basic realm="Farda agent reader", charset="UTF-8"' });
        for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
        if (sessions.size >= 1000) return reply(res, 429, { code: "SESSION_CAPACITY" });
        const token = randomBytes(32).toString("hex");
        const session = { role: authenticated.role, csrf: randomBytes(32).toString("hex"), expiresAt: Date.now() + 60 * 60_000 };
        sessions.set(token, session);
        return reply(res, 200, { csrfToken: session.csrf, role: session.role, principal: `agent-${session.role}`, scope: { workspaceId: options.workspaceId, accountIds: [options.accountId], environment: "sandbox", authorizationScopeVersion: "creator-agent.scope.v1" } }, { "set-cookie": `farda_agent=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${options.secureCookies ? "; Secure" : ""}` });
      }
      const auth = authorize(req);
      if (!auth) return reply(res, 401, { code: "AUTH_REQUIRED", executionCertainty: "notApplied" });
      // Cookie-authorized writes require both CSRF proof and exact same-origin. Machine bearer requests are separate.
      if (req.method !== "GET" && path !== "/v1/read" && auth.session) {
        const origin = options.publicOrigin ?? `http://${req.headers.host}`;
        if (req.headers.origin !== origin || req.headers["x-csrf-token"] !== auth.session.csrf)
          return reply(res, 403, { code: "CSRF_REJECTED", executionCertainty: "notApplied" });
      }
      if (path === "/v1/capabilities" && req.method === "GET") return reply(res, 200, {
        schemaVersion: AGENT_SCHEMA_VERSION, policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION,
        storageSchema: 1, environment: "sandbox", mode: "reviewedEvidence", sourceAutomation: "notConnected",
        models: (["website", "tiktok-shop"] as const).map((route) => ({ modelId: MODEL_FOR_ROUTE[route], configHash: modelBinding(route)?.hash ?? null })),
      });
      const match = /^\/v1\/creators\/([^/]+)$/.exec(path);
      if (match && req.method === "GET") {
        const record = store.latest(decodeURIComponent(match[1]!));
        return record ? reply(res, 200, current(record)) : reply(res, 404, { code: "RECORD_NOT_FOUND" });
      }
      if (match && req.method === "PUT") {
        if (auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED" });
        const input = writeSchema.parse(await bodyOf(req));
        if (input.packet.creatorId !== decodeURIComponent(match[1]!)) return reply(res, 400, { code: "IDENTITY_MISMATCH" });
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !key.trim() || key.length > 240) return reply(res, 400, { code: "IDEMPOTENCY_KEY_REQUIRED" });
        const binding = modelBinding(input.packet.checkoutRoute);
        if (input.configHash !== (binding?.hash ?? null)) return reply(res, 409, { code: "CONFIG_VERSION_CONFLICT", executionCertainty: "notApplied" });
        const assessment = assessCreator(input.packet, binding);
        return reply(res, 200, store.save(input.packet, assessment, input.expectedVersion, key));
      }
      if (path === "/v1/read" && req.method === "POST") {
        const input = z.object({ schemaVersion: z.literal(ADAPTER_SCHEMA), operation: z.literal("readView"), viewKey: z.literal("evidenceRecord"), requestId: z.string().min(1), requestedScope: z.object({ workspaceId: z.literal(options.workspaceId), accountIds: z.array(z.literal(options.accountId)).length(1), environment: z.literal("sandbox") }).strict(), filters: z.object({ creatorId: z.string().min(1), evidenceId: z.string().min(1) }).strict(), period: z.unknown(), sort: z.array(z.unknown()), page: z.unknown() }).strict().parse(await bodyOf(req));
        const stored = store.latest(input.filters.creatorId);
        if (!stored) return reply(res, 404, { code: "RECORD_NOT_FOUND" });
        const record = current(stored);
        const first = record.packet.posts.find((p) => p.postId === input.filters.evidenceId);
        if (!first) return reply(res, 404, { code: "RECORD_NOT_FOUND" });
        const unknown = (reasonCode: string) => ({ state: "unknown", value: null, reasonCode, evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: null, observedAt: record.recordedAt });
        const data = {
          evidenceRef: first.postId, creatorHandle: record.packet.creatorId, version: `v${record.revision}`, mediaUrl: first.sourceUrl, checkoutRoute: record.packet.checkoutRoute,
          observations: [], savedAt: record.recordedAt, reviewerRole: "Authenticated evidence reviewer",
          modelPublication: { label: record.assessment.config.status === "bound" ? record.assessment.config.version : "Configuration unbound", note: "Approved evidence policy is implemented; numeric baseline must be explicitly bound." },
          assessments: { creative: unknown("NO_CREATIVE_WEIGHT_BINDING"), routine: unknown("SEE_AGENT_QUALIFICATION"), commerce: unknown("NO_VERIFIED_ORDER_EVIDENCE") },
          firstReview: null, disputes: [], readiness: { state: "notReady", reasonCodes: ["AGENT_ASSESSMENT_READ_ONLY"] },
          qualification: record.assessment, agentEvidence: record.packet,
        };
        return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
          scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: `v${record.revision}`, dataState: record.stale ? "stale" : "ready", data,
          sourceFreshness: [], coverage: { expectedCount: 3, observedCount: record.assessment.packet.qualifyingPosts, missingCount: Math.max(0, 3 - record.assessment.packet.qualifyingPosts), complete: record.assessment.contentQualification === "pass", reasonCodes: record.assessment.reasonCodes },
          capabilities: [{ actionKind: "saveEvidenceDraft", state: "held", reasonCodes: ["AGENT_ASSESSMENT_READ_ONLY"] }, { actionKind: "markWatched", state: "held", reasonCodes: ["AGENT_ASSESSMENT_READ_ONLY"] }], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null },
        });
      }
      return reply(res, 404, { code: "UNSUPPORTED_OPERATION", executionCertainty: "notApplied" });
    } catch (error) {
      if (error instanceof AgentConflict) return reply(res, 409, { code: error.message, executionCertainty: "notApplied" });
      if (error instanceof z.ZodError || error instanceof SyntaxError) return reply(res, 400, { code: "INVALID_INPUT", executionCertainty: "notApplied" });
      if (error instanceof Error && error.message === "BODY_TOO_LARGE") return reply(res, 413, { code: "BODY_TOO_LARGE", executionCertainty: "notApplied" });
      return reply(res, 500, { code: "AGENT_ERROR", executionCertainty: "uncertain" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, store, close: () => new Promise<void>((resolve, reject) => server.close((error) => { store.close(); if (error) reject(error); else resolve(); })) };
}
