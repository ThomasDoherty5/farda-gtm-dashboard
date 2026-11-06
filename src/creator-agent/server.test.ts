// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newOfferTerms } from "./offers/contract.ts";
import { createAgentServer } from "./server.ts";
import { bindConfig, digest, type ConfigBinding } from "./config.ts";
import type { StoredAssessment } from "./store.ts";
import { AGENT_SCHEMA_VERSION, AGENT_VERSION, POLICY_VERSION, creatorAssessmentSchema } from "./assessmentSchema.ts";
import type { EvidencePacket } from "./evidence.ts";
import { evidencePacketSchema } from "./evidence.ts";
import { SCHEMA_VERSION } from "../adapter/contract";
import { createHttpTransport } from "../adapter/httpTransport";
import { createLiveAdapter } from "../adapter/liveAdapter";
import { evidenceViewSchemas } from "../adapter/viewSchemas/evidence";
import {
  SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE,
  syntheticBinding, syntheticConfig, syntheticPacket,
} from "./testFixtures.ts";

describe("actual creator-agent HTTP + SQLite service", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  let origin: string;
  let directory: string;
  let databasePath: string;
  let currentBindings: ConfigBinding[];

  async function start(bindings = [syntheticBinding()]) {
    currentBindings = bindings;
    app = createAgentServer({
      databasePath, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, bindings,
    });
    const server = app.server;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP test address.");
    origin = `http://127.0.0.1:${address.port}`;
  }

  async function stop() {
    const closing = app;
    app = undefined;
    if (closing) await closing.close();
  }

  async function request<T = unknown>(path: string, init: RequestInit = {}, token: string | null = SYNTHETIC_READ_TOKEN) {
    const headers = new Headers(init.headers);
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`${origin}${path}`, { ...init, headers });
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  }

  function writeBody(packet: EvidencePacket, expectedVersion = 0, overrides: Record<string, unknown> = {}) {
    const model = packet.checkoutRoute === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3";
    return { expectedVersion, policyVersion: POLICY_VERSION, configHash: currentBindings.find((binding) => binding.current.modelId === model)?.hash ?? null, packet, ...overrides };
  }

  async function put(packet = syntheticPacket(), expectedVersion = 0, key = "synthetic-save-1", overrides: Record<string, unknown> = {}, token = SYNTHETIC_REVIEW_TOKEN) {
    return request<StoredAssessment>(`/v1/creators/${packet.creatorId}`, {
      method: "PUT", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(writeBody(packet, expectedVersion, overrides)),
    }, token);
  }

  const readEnvelope = (creatorId = "synthetic-creator", evidenceId = "synthetic-post-1") => ({
    schemaVersion: SCHEMA_VERSION, operation: "readView" as const, viewKey: "evidenceRecord", requestId: "synthetic-read-1",
    requestedScope: SYNTHETIC_SCOPE, filters: { creatorId, evidenceId }, period: null, sort: [], page: { cursor: null, limit: 50 },
  });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "farda-creator-agent-test-"));
    databasePath = join(directory, "agent.sqlite");
    await start();
  });

  afterEach(async () => {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it("exposes scoped acquisition reads as empty and denies mutation to the private reader", async () => {
    for (const [viewKey, filters] of [
      ["pipelineSummary", {}], ["pipelineBranches", {}],
      ["offerDraft", { offerId: "never-saved" }], ["offerRewards", { offerId: "never-saved" }],
    ] as const) {
      const envelope = { ...readEnvelope(), viewKey, filters };
      const post = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
      const answer = await request<{ dataState: string; data: { coverage: { opportunities: number } } | null }>("/v1/read", post(envelope));
      expect(answer.status).toBe(200);
      expect(answer.body.dataState).toBe("empty");
      if (viewKey.startsWith("pipeline")) expect(answer.body.data?.coverage.opportunities).toBe(0);
      else expect(answer.body.data).toBeNull();
      expect((await request("/v1/read", post({ ...envelope, requestedScope: { ...SYNTHETIC_SCOPE, accountIds: ["some-other-account"] } }))).status).not.toBe(200);
    }
    for (const path of ["/v1/funnel/events", "/v1/save"]) {
      const input = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
      expect((await request(path, input, null)).status).toBe(401);
      expect((await request(path, input)).status).toBe(403);
    }
  });

  it("saves a proposed offer idempotently, recovers it after a process restart and holds unverified commitments", async () => {
    const terms = newOfferTerms("synthetic-creator", "website", "synthetic-brief");
    const input = { schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: SYNTHETIC_SCOPE,
      resourceKind: "actionDraft", resourceRef: "synthetic-offer", expectedVersion: null, requestId: "offer-test",
      idempotencyKey: "offer-test-create", payload: terms };
    const send = (value: unknown, token = SYNTHETIC_REVIEW_TOKEN) => request("/v1/save",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }, token);
    const saved = await send(input);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ resourceVersion: "v1", executionCertainty: "applied", record: { state: "proposed", acceptedRef: null,
      provider: null, scenarios: [expect.objectContaining({ contributionMinor: null }), expect.objectContaining({ contributionMinor: null })] } });
    await stop(); await start();
    expect((await send(input)).body).toEqual(saved.body);
    expect((await send({ ...input, idempotencyKey: "second-command" })).status).toBe(409);
    expect((await send({ ...input, expectedVersion: "v1", requestedScope: { ...SYNTHETIC_SCOPE, accountIds: ["another-account"] } })).status).not.toBe(200);
    const direct = await request("/v1/offers/synthetic-offer");
    expect(direct.body).toMatchObject({ version: "v1", historyTotal: 1, ownerApprovalRef: null });
    const fakeApproval = await request("/v1/offers/synthetic-offer/decisions", { method: "POST",
      headers: { "idempotency-key": "fake-approval", "content-type": "application/json" },
      body: JSON.stringify({ version: "v1", kind: "owner-approved", sourceRef: "unverified" }) }, SYNTHETIC_REVIEW_TOKEN);
    expect(fakeApproval.status).not.toBe(200);
    expect((await request("/v1/offers/synthetic-offer")).body).toMatchObject({ state: "proposed", acceptedRef: null });
  });

  it("serves truthful capabilities and requires authenticated read/write roles", async () => {
    expect((await request("/v1/capabilities", {}, null)).status).toBe(401);
    expect((await request("/v1/capabilities", {}, "synthetic-wrong-token-not-a-secret")).status).toBe(401);
    const capabilities = await request("/v1/capabilities");
    expect(capabilities.status).toBe(200);
    expect(capabilities.body).toMatchObject({ schemaVersion: AGENT_SCHEMA_VERSION, policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION, storageSchema: 1, environment: "sandbox", sourceAutomation: "notConnected" });
    expect((await put(syntheticPacket(), 0, "synthetic-reader-attempt", {}, SYNTHETIC_READ_TOKEN)).status).toBe(403);
    expect((await request("/v1/creators/synthetic-creator")).status).toBe(404);
  });

  it("requires distinct sufficiently long server credentials and explicit source scope", () => {
    const options = { databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, workspaceId: "synthetic-workspace", accountId: "synthetic-account" };
    expect(() => createAgentServer({ ...options, readToken: "short" })).toThrow("32");
    expect(() => createAgentServer({ ...options, reviewToken: SYNTHETIC_READ_TOKEN })).toThrow("distinct");
    expect(() => createAgentServer({ ...options, workspaceId: "" })).toThrow("Explicit workspace");
  });

  it("persists a real assessment in SQLite and preserves it across restart", async () => {
    const first = await put();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ revision: 1, assessment: { state: "prospectiveInviteEligible", contentQualification: "pass" } });
    expect(creatorAssessmentSchema.safeParse(first.body.assessment).success).toBe(true);
    expect(readFileSync(databasePath).subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");
    await stop();
    await start();
    const read = await request<StoredAssessment & { stale: boolean }>("/v1/creators/synthetic-creator");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ ...first.body, stale: false });
    expect(app!.store.history("synthetic-creator")).toEqual([first.body]);
  });

  it("refuses to reopen persisted evidence under a different workspace or account scope", async () => {
    const first = await put();
    expect(first.status).toBe(200);
    await stop();
    const options = {
      databasePath, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, bindings: [syntheticBinding()],
    };
    expect(() => createAgentServer({ ...options, workspaceId: "synthetic-other-workspace" })).toThrow("DATABASE_SCOPE_MISMATCH");
    expect(() => createAgentServer({ ...options, accountId: "synthetic-other-account" })).toThrow("DATABASE_SCOPE_MISMATCH");
    await start();
    const read = await request<StoredAssessment & { stale: boolean }>("/v1/creators/synthetic-creator");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ ...first.body, stale: false });
    expect(app!.store.history("synthetic-creator")).toEqual([first.body]);
  });

  it("replays an identical idempotency key and refuses a changed payload without overwriting history", async () => {
    const original = syntheticPacket();
    const first = await put(original);
    const replay = await put(original);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(app!.store.history(original.creatorId)).toHaveLength(1);
    const changed = structuredClone(original);
    changed.evidenceRevision = "synthetic-evidence-v2";
    changed.ratings.demo = 4;
    const reused = await put(changed, 0, "synthetic-save-1");
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", executionCertainty: "notApplied" });
    expect(app!.store.history(original.creatorId)).toEqual([first.body]);
  });

  it("requires correct expectedVersion and a new evidence/terms revision for material changes", async () => {
    const original = syntheticPacket();
    const first = await put(original);
    const changed = structuredClone(original);
    changed.ratings.demo = 4;
    expect((await put(changed, 0, "synthetic-version-conflict")).body).toMatchObject({ code: "VERSION_CONFLICT" });
    expect((await put(changed, 1, "synthetic-reused-evidence")).body).toMatchObject({ code: "EVIDENCE_REVISION_REUSED" });
    changed.evidenceRevision = "synthetic-evidence-v2";
    const next = await put(changed, 1, "synthetic-save-2");
    expect(next.status).toBe(200);
    expect(next.body.revision).toBe(2);
    expect(app!.store.history(original.creatorId)).toEqual([first.body, next.body]);
    expect((await put(original)).body).toEqual(first.body);
  });

  it("rejects stale policy/configuration and forged input before persistence", async () => {
    const packet = syntheticPacket();
    const forgedInputs = [
      { policyVersion: "2026-11-03" },
      { eligible: true },
      { packet: { ...packet, qualification: { state: "activationReady" } } },
      { packet: { ...packet, posts: [{ ...packet.posts[0]!, review: { ...packet.posts[0]!.review, watched: true } }, ...packet.posts.slice(1)] } },
      { expectedVersion: -1 },
    ];
    for (const [index, overrides] of forgedInputs.entries()) {
      const result = await put(packet, 0, `synthetic-forgery-${index}`, overrides);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: "INVALID_INPUT", executionCertainty: "notApplied" });
    }
    const stale = await put(packet, 0, "synthetic-stale-config", { configHash: "f".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "CONFIG_VERSION_CONFLICT" });
    expect(app!.store.history(packet.creatorId)).toEqual([]);
  });

  it("marks a configuration change stale at read time without rewriting the original assessment", async () => {
    const first = await put();
    const baseline = syntheticConfig();
    const nextBinding = bindConfig({ ...baseline, version: "synthetic-config-v2", approvalRef: "synthetic:approval-v2" }, baseline, digest(baseline));
    await stop();
    await start([nextBinding]);
    const read = await request<StoredAssessment & { stale: boolean }>("/v1/creators/synthetic-creator");
    expect(read.body.stale).toBe(true);
    expect(read.body.assessment.state).toBe("reviewNeeded");
    expect(read.body.assessment.reasonCodes).toContain("STALE_ASSESSMENT");
    expect(app!.store.history("synthetic-creator")).toEqual([first.body]);
    expect((await put(syntheticPacket(), 1, "synthetic-old-config-write", { configHash: first.body.assessment.config.hash })).status).toBe(409);
  });

  it("keeps an unbound configuration honest instead of using historical numeric defaults", async () => {
    await stop();
    await start([]);
    const result = await put();
    expect(result.status).toBe(200);
    expect(result.body.assessment).toMatchObject({ state: "reviewNeeded", score: null, config: { status: "unbound", hash: null, baselineHash: null, numericHash: null } });
  });

  it("rejects source-scope and identity manipulation without leaking another record", async () => {
    await put();
    const wrongScope = { ...readEnvelope(), requestedScope: { ...SYNTHETIC_SCOPE, workspaceId: "other-synthetic-workspace" } };
    const response = await request("/v1/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wrongScope) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toHaveProperty("data");
    const identity = await request("/v1/creators/other-synthetic-creator", { method: "PUT", headers: { "content-type": "application/json", "idempotency-key": "synthetic-wrong-identity" }, body: JSON.stringify(writeBody(syntheticPacket())) }, SYNTHETIC_REVIEW_TOKEN);
    expect(identity.status).toBe(400);
    expect(identity.body).toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(app!.store.history("other-synthetic-creator")).toEqual([]);
  });

  it("round-trips the persisted agent record through the real HTTP transport, live adapter and view validators", async () => {
    const saved = await put();
    const machineReaderFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${SYNTHETIC_READ_TOKEN}`);
      return fetch(input, { ...init, headers });
    };
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(origin, { fetch: machineReaderFetch }), writeAttempts: 1 });
    const response = await adapter.readView(readEnvelope());
    expect(response.scope.environment).toBe("sandbox");
    expect(response.dataState).toBe("ready");
    expect(evidenceViewSchemas.evidenceRecord!.safeParse(response.data).success).toBe(true);
    const data = response.data as { qualification: unknown; agentEvidence: unknown; readiness: unknown };
    expect(creatorAssessmentSchema.parse(data.qualification)).toEqual(saved.body.assessment);
    expect(evidencePacketSchema.parse(data.agentEvidence)).toEqual(saved.body.packet);
    expect(data.readiness).toMatchObject({ state: "notReady" });
    expect(response.capabilities.every((capability) => capability.state === "held")).toBe(true);
  });

  it("allows a cookie-authenticated adapter read while retaining CSRF protection for actual writes", async () => {
    await put();
    const session = await request<{ csrfToken: string }>("/v1/session");
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const read = await request("/v1/read", { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify(readEnvelope()) }, null);
    expect(read.status).toBe(200);
    const reviewerSession = await request<{ csrfToken: string }>("/v1/session", {}, SYNTHETIC_REVIEW_TOKEN);
    const reviewerCookie = reviewerSession.headers.get("set-cookie")!.split(";")[0]!;
    const packet = syntheticPacket();
    packet.evidenceRevision = "synthetic-evidence-v2";
    const denied = await request("/v1/creators/synthetic-creator", { method: "PUT", headers: { "content-type": "application/json", cookie: reviewerCookie, origin, "idempotency-key": "synthetic-cookie-write" }, body: JSON.stringify(writeBody(packet, 1)) }, null);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "CSRF_REJECTED" });
    const allowed = await request("/v1/creators/synthetic-creator", { method: "PUT", headers: { "content-type": "application/json", cookie: reviewerCookie, origin, "x-csrf-token": reviewerSession.body.csrfToken, "idempotency-key": "synthetic-cookie-write" }, body: JSON.stringify(writeBody(packet, 1)) }, null);
    expect(allowed.status).toBe(200);
  });
  it("returns an immediate unauthenticated answer to background session reads and challenges only explicit browser navigation", async () => {
    const background = await request("/v1/session", { headers: { accept: "application/json" } }, null);
    expect(background.status).toBe(401);
    expect(background.headers.get("www-authenticate")).toBeNull();
    const navigation = await request("/v1/session", { headers: { accept: "text/html" } }, null);
    expect(navigation.status).toBe(401);
    expect(navigation.headers.get("www-authenticate")).toContain("Basic");
  });

});
