import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { evidencePacketSchema } from "./evidence.ts";
import type { ConfigBinding } from "./config.ts";
import { AGENT_SCHEMA_VERSION, POLICY_VERSION, AGENT_VERSION } from "./assessmentSchema.ts";
import { assessCreator, MODEL_FOR_ROUTE } from "./policy.ts";
import { ratingPolicy } from "./ratingPolicy.ts";
import { AgentStore, AgentConflict } from "./store.ts";
import type { StoredAssessment } from "./store.ts";
import { PortfolioRepository, type PortfolioDecisionAuthority } from "./portfolioStore.ts";
import { handlePortfolioRoute } from "./portfolioRoutes.ts";
import { AssetRepository } from "./assetStore.ts";
import { handleAssetRoute } from "./assetRoutes.ts";
import type { AssetAuthority } from "./assets.ts";
import { agentAssessmentRecordSchema, agentSourcingSchema } from "./readViews.ts";

const ADAPTER_SCHEMA = "2026-11-02.proposed";
const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const versionOfData = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
type Role = "reader" | "reviewer";
type Session = { role: Role; csrf: string; expiresAt: number };
export type AgentServerOptions = { databasePath: string; readToken: string; reviewToken: string; workspaceId: string; accountId: string; bindings?: ConfigBinding[]; secureCookies?: boolean; publicOrigin?: string; assetAuthority?: AssetAuthority; portfolioAuthority?: PortfolioDecisionAuthority };
const writeSchema = z.object({ expectedVersion: z.number().int().nonnegative(), policyVersion: z.literal(POLICY_VERSION), configHash: z.string().nullable(), packet: evidencePacketSchema }).strict();

/** First real agent service; independent of all demo adapters and reference-server fixtures. */
export function createAgentServer(options: AgentServerOptions) {
  if (options.readToken.length < 32 || options.reviewToken.length < 32 || safeEqual(options.readToken, options.reviewToken)) throw new Error("Two distinct server-only tokens of at least 32 characters are required");
  if (!options.workspaceId || !options.accountId) throw new Error("Explicit workspace and account scope are required");
  const store = new AgentStore(options.databasePath, { workspaceId: options.workspaceId, accountId: options.accountId });
  const portfolio = new PortfolioRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId }, options.portfolioAuthority);
  const assets = new AssetRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId }, options.assetAuthority);
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
  const current = (record: StoredAssessment, superseded = false) => {
    const binding = modelBinding(record.packet.checkoutRoute);
    const stale = superseded || record.assessment.policyVersion !== POLICY_VERSION || record.assessment.agentVersion !== AGENT_VERSION || record.assessment.config.hash !== (binding?.hash ?? null);
    return { ...record, stale, assessment: stale ? { ...record.assessment, state: "reviewNeeded" as const, reasonCodes: [...new Set([...record.assessment.reasonCodes, "STALE_ASSESSMENT", ...(superseded ? ["SUPERSEDED_ASSESSMENT"] : [])])] } : record.assessment };
  };
  const readBase = z.object({
    schemaVersion: z.literal(ADAPTER_SCHEMA), operation: z.literal("readView"), requestId: z.string().min(1),
    requestedScope: z.object({ workspaceId: z.literal(options.workspaceId), accountIds: z.array(z.literal(options.accountId)).length(1), environment: z.literal("sandbox") }).strict(),
    period: z.unknown(), sort: z.array(z.unknown()), page: z.unknown(),
  }).strict();
  const readSchema = z.discriminatedUnion("viewKey", [
    readBase.extend({ viewKey: z.literal("evidenceRecord"), filters: z.object({ creatorId: z.string().min(1), evidenceId: z.string().min(1) }).strict() }),
    readBase.extend({ viewKey: z.literal("assessmentRecord"), filters: z.object({ creatorId: z.string().min(1), assessmentId: z.string().min(1) }).strict() }),
    readBase.extend({ viewKey: z.literal("shippingHub"), filters: z.object({}).strict() }),
    readBase.extend({ viewKey: z.literal("discoverySummary"), filters: z.object({}).strict() }),
  ]);
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
        if (!authenticated) return reply(res, 401, { code: "AUTH_REQUIRED" }, req.headers.accept?.includes("text/html") ? { "www-authenticate": 'Basic realm="Farda agent reader", charset="UTF-8"' } : {});
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
      if (path === "/v1/portfolio" || path.startsWith("/v1/portfolio/")) {
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const key = req.headers["idempotency-key"];
        const result = await handlePortfolioRoute({ method: req.method ?? "GET", path: req.url ?? path,
          role: auth.role, body: req.method === "POST" ? await bodyOf(req) : undefined,
          idempotencyKey: typeof key === "string" ? key : undefined }, portfolio);
        if (result) return reply(res, result.status, result.body);
      }
      if (path === "/v1/assets" || path.startsWith("/v1/assets/")) {
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const key = req.headers["idempotency-key"];
        const result = await handleAssetRoute({ method: req.method ?? "GET", path: req.url ?? path,
          role: auth.role, body: req.method === "POST" ? await bodyOf(req) : undefined,
          idempotencyKey: typeof key === "string" ? key : undefined }, assets);
        if (result) return reply(res, result.status, result.body);
      }
      if (path === "/v1/policy" && req.method === "GET") return reply(res, 200, ratingPolicy);
      if (path === "/v1/capabilities" && req.method === "GET") return reply(res, 200, {
        schemaVersion: AGENT_SCHEMA_VERSION, policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION,
        storageSchema: 1, environment: "sandbox", mode: "reviewedEvidence", sourceAutomation: "notConnected",
        portfolioReview: { storage: "durable", decisionAuthority: options.portfolioAuthority ? "injected" : "notConnected", providerExecution: "notConnected" },
        assetRegistry: { storage: "durable", sourceAuthority: options.assetAuthority ? "injected" : "notConnected", providerExecution: "notConnected" },
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
        const input = readSchema.parse(await bodyOf(req));
        if (input.viewKey === "shippingHub") return reply(res, 503, { code: "INTEGRATION_PENDING", message: "Shipping source and label executor are not connected.", requestId: input.requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
        if (input.viewKey === "discoverySummary") {
          const listing = store.listLatest();
          const records = listing.records.map((stored) => current(stored));
          const models = (["website", "tiktok-shop"] as const).map((route) => {
            const binding = modelBinding(route);
            return {
              modelId: MODEL_FOR_ROUTE[route], status: binding ? "bound" as const : "unbound" as const,
              configVersion: binding?.current.version ?? null, configHash: binding?.hash ?? null,
              baselineHash: binding?.baselineHash ?? null, numericHash: binding?.numericHash ?? null,
              criteria: binding?.current.criteria ?? null, bands: binding?.current.bands ?? null,
              arithmetic: binding?.current.arithmetic ?? null, decisionRules: binding?.current.decisionRules ?? null,
            };
          });
          const data = agentSourcingSchema.parse({
            kind: "agent-sourcing", policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION, agentSchemaVersion: AGENT_SCHEMA_VERSION,
            records: records.map((record) => ({ creatorId: record.packet.creatorId, runId: record.runId, evidenceId: record.packet.posts[0]?.postId ?? null,
              briefId: record.packet.briefId, checkoutRoute: record.packet.checkoutRoute, state: record.assessment.state, recordedAt: record.recordedAt, revision: record.revision, stale: record.stale })),
            models, total: listing.total, partial: listing.partial,
          });
          const dataVersion = versionOfData(data);
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion, dataState: listing.partial ? "partial" : records.some((record) => record.stale) ? "stale" : "ready", data,
            sourceFreshness: [], coverage: { expectedCount: listing.total, observedCount: records.length, missingCount: listing.total - records.length, complete: !listing.partial, reasonCodes: listing.partial ? ["LATEST_RECORD_LIMIT"] : [] },
            capabilities: [{ actionKind: "startLiveDiscovery", state: "held", reasonCodes: ["SOURCE_AUTOMATION_NOT_CONNECTED"] }],
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null },
          });
        }
        if (input.viewKey === "assessmentRecord") {
          const stored = store.findRun(input.filters.creatorId, input.filters.assessmentId);
          if (!stored) return reply(res, 404, { code: "RECORD_NOT_FOUND" });
          const superseded = store.latest(input.filters.creatorId)?.runId !== stored.runId;
          const record = current(stored, superseded);
          const data = agentAssessmentRecordSchema.parse({
            kind: "creator-v3", creatorId: stored.packet.creatorId, assessmentId: stored.runId, runId: stored.runId,
            evidenceId: superseded ? null : stored.packet.posts[0]?.postId ?? null,
            qualification: record.assessment, assessedQualification: stored.assessment, agentEvidence: stored.packet,
            recordedAt: stored.recordedAt, revision: stored.revision, stale: record.stale, superseded,
          });
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data), dataState: record.stale ? "stale" : "ready", data,
            sourceFreshness: [], coverage: { expectedCount: 3, observedCount: record.assessment.packet.qualifyingPosts, missingCount: Math.max(0, 3 - record.assessment.packet.qualifyingPosts), complete: record.assessment.contentQualification === "pass", reasonCodes: record.assessment.reasonCodes },
            capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null },
          });
        }
        const stored = store.latest(input.filters.creatorId);
        if (!stored) return reply(res, 404, { code: "RECORD_NOT_FOUND" });
        const record = current(stored);
        const first = record.packet.posts.find((p) => p.postId === input.filters.evidenceId);
        if (!first) return reply(res, 404, { code: "RECORD_NOT_FOUND" });
        const unknown = (reasonCode: string) => ({ state: "unknown", value: null, reasonCode, evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: null, observedAt: record.recordedAt });
        const data = {
          evidenceRef: first.postId, creatorHandle: record.packet.creatorId, version: `v${record.revision}`, mediaUrl: first.sourceUrl, checkoutRoute: record.packet.checkoutRoute,
          observations: [], savedAt: record.recordedAt, reviewerRole: "Authenticated evidence reviewer",
          modelPublication: { label: record.assessment.config.status === "bound" ? record.assessment.config.version : "Configuration unbound", note: record.assessment.config.status === "bound" ? "Approved immutable baseline verified; numerical configuration preserved." : "Approved evidence policy is implemented; numeric baseline must be explicitly bound." },
          assessments: { creative: unknown("NO_CREATIVE_WEIGHT_BINDING"), routine: unknown("SEE_AGENT_QUALIFICATION"), commerce: unknown("NO_VERIFIED_ORDER_EVIDENCE") },
          firstReview: null, disputes: [], readiness: { state: "notReady", reasonCodes: ["AGENT_ASSESSMENT_READ_ONLY"] },
          qualification: record.assessment, agentEvidence: record.packet,
        };
        return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
          scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data), dataState: record.stale ? "stale" : "ready", data,
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
