// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "./server.ts";
import { OPERATIONS_SCHEMA_VERSION, type OperationsOptions } from "./operations.ts";
import { POLICY_VERSION } from "./assessmentSchema.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type CapabilityRegistration, type CapabilityView, type ExpectedBinding, type VerificationReceipt } from "./connections/schema.ts";
import type { JobDefinition, JobEvent, JobRunView } from "./jobs/schema.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE, syntheticBinding } from "./testFixtures.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
const privateCredentialRef = "secretref:synthetic-private-credential-name";
const privateConnectionRef = "connection:synthetic-private-connection-name";
const binding = (patch: Partial<ExpectedBinding> = {}): ExpectedBinding => ({ ...scope, provider: "synthetic-provider", providerAccountId: "synthetic-provider-account", action: "readPolicy", mode: "observe", route: "api", routeRef: "route:synthetic-reader", authorizationScopeVersion: "synthetic-scope-v1", toolVersion: "synthetic-v1", requiredScopes: ["policy:read"], secretRef: privateCredentialRef, connectionRef: privateConnectionRef, ...patch });
const registration = (b = binding()): CapabilityRegistration => ({ binding: b, ownerRef: "owner:synthetic-operator", costBasis: { state: "unknown", reasonCode: "COST_NOT_MEASURED" } });
const definition = (patch: Partial<JobDefinition> = {}): JobDefinition => ({ jobId: "synthetic-job", version: 1, ownerRef: "owner:synthetic-operator", mode: "observe", handler: "record-reference.v1", eventType: "synthetic-reference-event", inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-local-result.v1", policyVersion: POLICY_VERSION, modelVersion: null, offerVersion: null, capabilityBinding: binding(), budgets: { maxItems: 10, maxSteps: 20, maxAttempts: 2, maxRunMs: 60_000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 10 }, ...patch });
const event = (patch: Partial<JobEvent> = {}): JobEvent => ({ schemaVersion: "job-reference-batch.v1", jobId: "synthetic-job", jobVersion: 1, eventId: "synthetic-event", eventType: "synthetic-reference-event", eventAt: null, items: [{ itemKey: "synthetic-item", subjectRef: "subject:synthetic", evidenceRef: null }], ...patch });
type Envelope<T> = { schemaVersion: string; scope: typeof SYNTHETIC_SCOPE & { authorizationScopeVersion: string }; data: T; sourceEffect: "none" };
type Run = Pick<JobRunView, "runId" | "state" | "enabled" | "control" | "counts" | "usage" | "items">;

describe("actual authenticated operations HTTP and SQLite integration", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  let directory: string;
  let databasePath: string;
  let origin: string;
  let clock: number;
  async function start(options: OperationsOptions = {}) {
    app = createAgentServer({ databasePath, workspaceId: scope.workspaceId, accountId: scope.accountId,
      readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, bindings: [syntheticBinding()],
      secureCookies: true, publicOrigin: "https://synthetic-operator.invalid", operations: { now: () => clock, ...options } });
    await new Promise<void>((resolve, reject) => { app!.server.once("error", reject); app!.server.listen(0, "127.0.0.1", () => { app!.server.off("error", reject); resolve(); }); });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected ephemeral address");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() { const closing = app; app = undefined; if (closing) await closing.close(); }
  async function request<T = Record<string, unknown>>(path: string, init: RequestInit = {}, token: string | null = SYNTHETIC_READ_TOKEN) {
    const headers = new Headers(init.headers);
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`${origin}${path}`, { ...init, headers });
    const body = await response.json() as T;
    expect(JSON.stringify(body)).not.toContain(privateCredentialRef);
    expect(JSON.stringify(body)).not.toContain(privateConnectionRef);
    return { status: response.status, body, headers: response.headers };
  }
  const post = <T = Record<string, unknown>>(path: string, data: unknown, key?: string, token: string | null = SYNTHETIC_REVIEW_TOKEN) => request<T>(path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(data) }, token);
  const registerCapability = (input = registration(), expectedRevision = 0) => post<Envelope<CapabilityView>>("/v1/connections/register", { registration: input, expectedRevision });
  const registerJob = (input = definition(), expectedVersion = 0) => post("/v1/jobs/register", { definition: input, expectedVersion });
  const ingress = (input = event(), key = "synthetic-request") => post<Envelope<Run>>("/v1/jobs/ingress", input, key);
  const proof = (): VerificationReceipt => ({ receiptRef: "receipt:synthetic-verified-read", binding: binding(), outcome: "Ready", checkedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 60_000).toISOString(), verifiedScopes: ["policy:read"], connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: [] });
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "farda-operations-http-")); databasePath = join(directory, "agent.sqlite"); clock = Date.parse("2026-11-05T06:00:00.000Z"); await start(); });
  afterEach(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });

  it("requires authentication, preserves the existing scorecard capability endpoint, and returns scoped empty operations", async () => {
    for (const path of ["/v1/connections", "/v1/jobs", "/v1/job-runs"]) {
      expect((await request(path, {}, null)).status).toBe(401);
      expect((await request(path, {}, "synthetic-invalid-credential")).status).toBe(401);
      const read = await request<Envelope<{ records: unknown[]; total: number; partial: boolean }>>(path);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ schemaVersion: OPERATIONS_SCHEMA_VERSION, scope: SYNTHETIC_SCOPE, sourceEffect: "none", data: { records: [], total: 0, partial: false } });
      expect(read.headers.get("cache-control")).toBe("no-store");
    }
    const original = await request("/v1/capabilities");
    expect(original.body).toMatchObject({ environment: "sandbox", sourceAutomation: "notConnected", storageSchema: 1 });
  });

  it("shares the owner database for in-memory HTTP registrations, ingress and replay", async () => {
    await stop();
    databasePath = ":memory:";
    await start();
    const capability = await registerCapability();
    expect(capability.status).toBe(200);
    expect((await registerJob()).status).toBe(200);
    const run = await ingress();
    expect(run.status).toBe(200);
    expect(run.body.data).toMatchObject({ state: "held", enabled: false });
    expect((await ingress()).body.data.runId).toBe(run.body.data.runId);
    const database = app!.store.database;
    expect(database.prepare("SELECT COUNT(*) AS total FROM capability_events").get()?.total).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS total FROM job_runs").get()?.total).toBe(1);
    expect((await request(`/v1/connections/${capability.body.data.capabilityId}`)).status).toBe(200);
    app!.operations.close();
    app!.operations.close();
    expect(database.prepare("SELECT COUNT(*) AS total FROM job_runs").get()?.total).toBe(1);
    // The service owns this handle; releasing borrowed repositories must not close it.
    await stop();
  });

  it("returns authenticated server-owned identity without issuing a session, CSRF token or credential", async () => {
    expect((await request("/v1/identity", {}, null)).status).toBe(401);
    for (const [token, role] of [[SYNTHETIC_READ_TOKEN, "reader"], [SYNTHETIC_REVIEW_TOKEN, "reviewer"]]) {
      const identity = await request(`/v1/identity?role=forged&workspaceId=synthetic-wrong`, {}, token);
      expect(identity.status).toBe(200);
      expect(identity.body).toEqual({ service: "farda-creator-agent", schemaVersion: "creator-agent.v1", role,
        scope: { ...SYNTHETIC_SCOPE, authorizationScopeVersion: "creator-agent.scope.v1" } });
      expect(identity.headers.get("set-cookie")).toBeNull();
      expect(JSON.stringify(identity.body)).not.toMatch(/csrf|token|cookie|credential/i);
      expect(JSON.stringify(identity.body)).not.toContain(SYNTHETIC_READ_TOKEN);
      expect(JSON.stringify(identity.body)).not.toContain(SYNTHETIC_REVIEW_TOKEN);
    }
  });

  it("requires reviewer authority on every mutation before accepting a body", async () => {
    const id = "a".repeat(64);
    for (const path of ["/v1/connections/register", `/v1/connections/${id}/verify`, `/v1/connections/${id}/revoke`, "/v1/jobs/register", "/v1/jobs/ingress", "/v1/jobs/synthetic-job/pause", "/v1/job-runs/synthetic-run/control"]) {
      const response = await post(path, { forged: true }, undefined, SYNTHETIC_READ_TOKEN);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
    }
  });

  it("reuses exact-origin and CSRF checks for reviewer cookies", async () => {
    const session = await request<{ csrfToken: string }>("/v1/session", {}, SYNTHETIC_REVIEW_TOKEN);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    expect(session.headers.get("set-cookie")).toMatch(/HttpOnly.*SameSite=Strict.*Secure/);
    const data = JSON.stringify({ registration: registration(), expectedRevision: 0 });
    const init = { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": session.body.csrfToken }, body: data };
    expect((await request("/v1/connections/register", init, null)).status).toBe(403);
    expect((await request("/v1/connections/register", { ...init, headers: { ...init.headers, origin: "https://synthetic-wrong-origin.invalid" } }, null)).status).toBe(403);
    expect((await request("/v1/connections/register", { ...init, headers: { ...init.headers, origin: "https://synthetic-operator.invalid", "x-csrf-token": "synthetic-invalid-csrf" } }, null)).status).toBe(403);
    expect((await request("/v1/connections/register", { ...init, headers: { ...init.headers, origin: "https://synthetic-operator.invalid" } }, null)).status).toBe(200);
  });

  it("rejects forged identities, scopes, Ready fields and trusted proof injection", async () => {
    for (const patch of [{ workspaceId: "synthetic-other-workspace" }, { accountId: "synthetic-other-account" }, { environment: "production" as const }]) {
      expect((await registerCapability(registration(binding(patch)))).status).toBe(400);
      expect((await registerJob(definition({ capabilityBinding: binding(patch) }))).status).toBe(400);
    }
    expect((await post("/v1/connections/register", { registration: registration(), expectedRevision: 0, Ready: true })).status).toBe(400);
    expect((await registerCapability({ ...registration(), connected: true } as CapabilityRegistration)).status).toBe(400);
    const saved = await registerCapability();
    const id = saved.body.data.capabilityId;
    for (const addition of [{ state: "Ready" }, { proof: proof() }, { resolveReceipt: "synthetic-override" }]) {
      expect((await post(`/v1/connections/${id}/verify`, { receiptRef: proof().receiptRef, expectedRevision: 1, ...addition })).status).toBe(400);
    }
    const unknown = await post<Envelope<CapabilityView>>(`/v1/connections/${id}/verify`, { receiptRef: proof().receiptRef, expectedRevision: 1 });
    expect(unknown.status).toBe(200);
    expect(unknown.body.data).toMatchObject({ state: "Unverified", reasonCodes: ["VERIFIER_NOT_CONFIGURED"], receiptRef: null });
    expect((await post(`/v1/connections/${id}/verify`, { receiptRef: proof().receiptRef, expectedRevision: 1 })).status).toBe(409);
  });

  it("uses only the server-injected verifier, then respects revocation and bounded safe history", async () => {
    const first = await registerCapability();
    const id = first.body.data.capabilityId;
    await stop();
    await start({ resolveReceipt: (ref) => ref === proof().receiptRef ? proof() : null });
    const verified = await post<Envelope<CapabilityView>>(`/v1/connections/${id}/verify`, { receiptRef: proof().receiptRef, expectedRevision: 1 });
    expect(verified.status).toBe(200);
    expect(verified.body.data).toMatchObject({ state: "Ready", verifiedScopes: ["policy:read"], registration: { hasCredentialReference: true, hasConnectionReference: true } });
    expect(app!.operations.ledger.requireReady(binding()).allowed).toBe(true);
    const revoked = await post<Envelope<CapabilityView>>(`/v1/connections/${id}/revoke`, { reasonCode: "SYNTHETIC_PERMISSION_REVOKED", expectedRevision: 2 });
    expect(revoked.body.data.state).toBe("Denied");
    expect(app!.operations.ledger.requireReady(binding()).allowed).toBe(false);
    const history = await request<Envelope<{ records: CapabilityView[]; total: number; partial: boolean }>>(`/v1/connections/${id}/history?limit=2`);
    expect(history.body.data).toMatchObject({ total: 3, partial: true });
    expect(history.body.data.records).toHaveLength(2);
    expect(history.body.data.records.map((record) => record.revision)).toEqual([1, 2]);
    expect((await request(`/v1/connections/${id}/history?limit=101`)).status).toBe(400);
    expect((await request(`/v1/connections/${id}?accountId=synthetic-wrong`)).status).toBe(400);
  });

  it("enforces strict bounded collection queries and truthful partial coverage", async () => {
    await registerCapability();
    await registerCapability(registration(binding({ action: "readHealth" })));
    await registerJob();
    await registerJob(definition({ jobId: "synthetic-second-job" }));
    await ingress();
    await ingress(event({ eventId: "synthetic-second-event" }), "synthetic-second-request");
    for (const path of ["/v1/connections", "/v1/jobs", "/v1/job-runs"]) {
      const read = await request<Envelope<{ records: unknown[]; total: number; partial: boolean }>>(`${path}?limit=1`);
      expect(read.body.data).toMatchObject({ total: 2, partial: true });
      expect(read.body.data.records).toHaveLength(1);
      for (const suffix of ["?limit=0", "?limit=101", "?limit=1&limit=2", "?workspaceId=synthetic-other"]) expect((await request(path + suffix)).status).toBe(400);
    }
  });

  it("persists disabled held jobs, deduplicates ingress and supports pause/cancel without worker or activation routes", async () => {
    const registered = await registerJob();
    expect(registered.status).toBe(200);
    expect(registered.body).toMatchObject({ data: { enabled: false } });
    const first = await ingress();
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ state: "held", enabled: false, counts: { completed: 0 }, usage: { externalCalls: 0, modelCalls: 0, zapierTasks: "unknown" } });
    const runId = first.body.data.runId;
    expect((await ingress()).body.data.runId).toBe(runId);
    expect((await ingress(event(), "synthetic-other-request")).body.data.runId).toBe(runId);
    expect((await ingress(event({ eventId: "synthetic-changed" }))).status).toBe(409);
    expect((await request(`/v1/jobs/synthetic-job`)).status).toBe(200);
    expect((await request(`/v1/job-runs/${runId}`)).status).toBe(200);
    expect((await request(`/v1/job-runs/${runId}/history?limit=1`)).body).toMatchObject({ data: { partial: true } });
    expect((await post("/v1/jobs/synthetic-job/pause", { version: 1 })).status).toBe(200);
    expect((await post(`/v1/job-runs/${runId}/control`, { command: "pause" })).body).toMatchObject({ data: { state: "paused" } });
    expect((await post(`/v1/job-runs/${runId}/control`, { command: "cancel" })).body).toMatchObject({ data: { state: "cancelled" } });
    expect((await post(`/v1/job-runs/${runId}/control`, { command: "resume" })).status).toBe(400);
    for (const suffix of ["activate", "claim", "checkpoint", "complete", "fail", "processOne"]) {
      expect((await post(`/v1/jobs/synthetic-job/${suffix}`, {})).status).toBe(404);
      expect((await post(`/v1/job-runs/${runId}/${suffix}`, {})).status).toBe(404);
    }
    await stop();
    await start();
    expect((await request(`/v1/job-runs/${runId}`)).body).toMatchObject({ data: { runId, state: "cancelled" } });
  });

  it("strips exact private reference values from every nested job response and keeps internal worker bindings intact", async () => {
    await registerJob();
    expect(app!.operations.jobs.getJob("synthetic-job").definition.capabilityBinding?.secretRef).toBe(privateCredentialRef);
    const run = await ingress();
    const id = run.body.data.runId;
    const paths = ["/v1/jobs", "/v1/jobs/synthetic-job", "/v1/job-runs", `/v1/job-runs/${id}`, `/v1/job-runs/${id}/history`];
    for (const path of paths) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toMatch(/"secretRef"|"connectionRef"|"leaseToken"/);
    }
    expect((await ingress()).body.data.runId).toBe(id);
    expect((await post(`/v1/job-runs/${id}/control`, { command: "pause" })).status).toBe(200);
    expect((await post(`/v1/job-runs/${id}/control`, { command: "cancel" })).status).toBe(200);
    const publicDefinition = (await request<Envelope<{ definition: { capabilityBinding: Record<string, unknown> } }>>("/v1/jobs/synthetic-job")).body.data.definition;
    expect(publicDefinition.capabilityBinding).toMatchObject({ hasCredentialReference: true, hasConnectionReference: true });
  });

  it("reopens an isolated online-backup restore with capability/job identity and ingress idempotency preserved", async () => {
    const capability = await registerCapability();
    await registerJob();
    const run = await ingress();
    const snapshot = join(directory, "backup", "snapshot.sqlite");
    const restored = join(directory, "restore", "agent.sqlite");
    const backupEnv = { ...process.env, FARDA_AGENT_WORKSPACE_ID: scope.workspaceId, FARDA_AGENT_ACCOUNT_ID: scope.accountId };
    const makeBackup = (source: string, destination: string) => JSON.parse(execFileSync(process.execPath, ["tools/creator-agent/backup.mjs", "create", source, destination], { cwd: process.cwd(), env: backupEnv, timeout: 10_000, encoding: "utf8" })) as { restored: boolean; storageSchema: number };
    expect(makeBackup(databasePath, snapshot)).toMatchObject({ restored: true, storageSchema: 1 });
    expect(makeBackup(snapshot, restored)).toMatchObject({ restored: true, storageSchema: 1 });
    await stop();
    databasePath = restored;
    await start();
    expect(app!.operations.ledger.get(capability.body.data.capabilityId)).toMatchObject({ capabilityId: capability.body.data.capabilityId, revision: 1, state: "Unverified" });
    expect(app!.operations.jobs.getRun(run.body.data.runId)).toMatchObject({ runId: run.body.data.runId, state: "held" });
    expect((await request(`/v1/connections/${capability.body.data.capabilityId}`)).body).toMatchObject({ data: { capabilityId: capability.body.data.capabilityId, state: "Unverified" } });
    expect((await ingress()).body.data.runId).toBe(run.body.data.runId);
    expect((await request<Envelope<{ total: number }>>("/v1/job-runs")).body.data.total).toBe(1);
  });

  it("closes every database handle when operations initialization fails and makes normal close idempotent", async () => {
    await stop();
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE job_schema SET version=99 WHERE id=1").run();
    db.close();
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      expect(() => createAgentServer({ databasePath, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, workspaceId: scope.workspaceId, accountId: scope.accountId })).toThrow("UNSUPPORTED_JOB_SCHEMA");
      expect(close).toHaveBeenCalledTimes(1); // The agent owns the one shared database handle.
    } finally { close.mockRestore(); }
    const repair = new DatabaseSync(databasePath);
    repair.prepare("UPDATE job_schema SET version=1 WHERE id=1").run();
    repair.close();
    await start();
    const running = app!;
    app = undefined;
    expect(running.close()).toBe(running.close());
    await running.close();
  });

  it("reuses the one-MiB JSON body bound and never echoes rejected secret material", async () => {
    const response = await request("/v1/connections/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ syntheticPayload: "x".repeat(1_048_576) }) }, SYNTHETIC_REVIEW_TOKEN);
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: "BODY_TOO_LARGE", executionCertainty: "notApplied" });
    expect((await post("/v1/jobs/register", { definition: { ...definition(), enabled: true }, expectedVersion: 0 })).status).toBe(400);
  });
});
