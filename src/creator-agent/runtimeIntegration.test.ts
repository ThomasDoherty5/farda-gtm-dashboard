// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { createRuntimeTestkit, syntheticRuntimeRegistration, runtimeSyntheticScope as scope } from "./jobs/runtime.testkit.ts";
import { safeRuntimeRunSchema, runtimeApiAckSchema } from "./jobs/runtimeViews.ts";
import { digest } from "./config.ts";
import type { MirrorReconciliationBinding } from "./mirrorReconciliation/runtime.ts";
import type { ReconciliationRow } from "./mirrorReconciliation/contract.ts";
import { reportFixture } from "./slackReporting/fixtures.testkit.ts";
import { formatReport } from "./slackReporting/format.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";

const runtimeToken = "synthetic-runtime-worker-credential-0000000000";
const dispatchToken = "synthetic-dispatch-worker-credential-000000000";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(configured = true, reconciliation?: MirrorReconciliationBinding) {
  const directory = mkdtempSync(join(tmpdir(), "farda-runtime-http-")), databasePath = join(directory, "agent.sqlite");
  const store = new AgentStore(databasePath, scope);
  const registration = syntheticRuntimeRegistration(reconciliation
    ? { family: "registered-business", browserBinding: null, browserExecutorRef: null,
      cadence: { kind: "calendar", draft: { cadence: "daily", localTime: "02:00", timezone: "America/Los_Angeles", activeCohortOverride: false },
        draftVersion: "j1-d1", startsAt: "2026-11-06T10:00:00Z" } }
    : { family: "registered-business", cadence: { kind: "event", eventType: "synthetic-event" } });
  const kit = createRuntimeTestkit(store.database, { registration }); await kit.initialize();
  const registry = reconciliation ? { ...kit.registry, executors: new Map() } : kit.registry;
  const state = { machine: true, reader: true, afterActor: null as null | (() => void) };
  const at = () => new Date(kit.now()).toISOString(), until = () => new Date(kit.now() + 60_000).toISOString();
  const options: AgentServerOptions = { databasePath, workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: reader, reviewToken: reviewer, operations: { now: kit.now },
    actionFoundation: { approvals: { sources: {
      resolveActor: async principalRef => { state.afterActor?.(); return { scope, principalRef, personRef: "synthetic-person", roles: ["viewer"], active: true,
        directoryVersion: "synthetic-directory-v1", observedAt: at(), validUntil: until() }; },
      assertCurrent: snapshot => { if (!state.reader || digest(snapshot.scope) !== digest(scope)) throw new Error("Synthetic current directory withdrawal"); },
    } }, worker: { token: dispatchToken, workerRef: "synthetic-dispatch-machine", resolve: async () => { throw new Error("Bare dispatch must not receive registered runtime runs"); }, assertCurrent: () => {} } },
    ...(configured ? { runtime: { registry, authority: kit.authority, machine: { token: runtimeToken, workerRef: kit.machine.workerRef,
      resolve: async (s, operation, input) => ({ scope: s, workerRef: kit.machine.workerRef, operation, inputHash: digest(input), proofRef: "synthetic-machine-proof", observedAt: at(), validUntil: until() }),
      assertCurrent: () => { if (!state.machine) throw new Error("Synthetic machine withdrawn"); },
    } } } : {}),
    mirrorReconciliation: reconciliation,
  };
  const app = createAgentServer(options);
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Missing local test address");
  const origin = `http://127.0.0.1:${address.port}`;
  closes.push(async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function post(path: string, body: unknown, token = runtimeToken, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  async function get(path: string) {
    const response = await fetch(origin + path, { headers: { authorization: "Bearer " + reader } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const fire = (intendedAt = "2026-11-07T11:00:00Z") => post("/v1/runtime/machine", { operation: "fire", input: { registrationRef: registration.registrationRef, registrationVersion: registration.version,
    intendedAt, triggerEventRef: "synthetic-runtime-webhook" } });
  const read = (runId: string) => post("/v1/read", { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-runtime-read", requestedScope: {
    workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" }, viewKey: "runDetail", filters: { runId }, period: null,
    sort: [], page: { limit: 25, cursor: null } }, reader);
  return { app, kit, state, options, post, get, fire, read };
}
describe("registered runtime through the actual authenticated API and shared SQLite", () => {
  it("runs a nightly reconciliation, retries incomplete coverage and exposes owned discrepancies without repair authority", async () => {
    const schedule: MirrorReconciliationBinding["schedule"] = {
      checkId: "synthetic-subject-first-0", version: 1, timezone: "America/Los_Angeles", runAt: "02:00",
      cutoffLagMinutes: 60, coverage: { lookbackDays: 1 },
      expectedDatasets: [{ scope: "synthetic-order-ledger", grain: "order", amountField: "net-sales", currencies: ["USD"] }],
    };
    let now = Date.parse("2026-11-07T12:00:00Z"), reads = 0, permission = true;
    const f = await fixture(true, { registrationRef: "synthetic-j19", schedule, source: {
      async read(request) {
        reads++;
        const readAt = new Date(now).toISOString(), period = request.periods[0]!;
        expect(request).toMatchObject({ scope, periods: ["2026-11-06"], schedule, window: { intendedAt: "2026-11-07T10:00:00.000Z" } });
        const row = (key: string, amountMinor: number): ReconciliationRow => ({
          key, amountMinor, scope: "synthetic-order-ledger", grain: "order", period, currency: "USD", read: "complete",
        });
        return { receiptRef: "synthetic-read-" + reads, requestDigest: digest(request), observedAt: readAt,
          validUntil: new Date(now + 60_000).toISOString(),
          coverage: ["source", "mirror"].map(side => ({ side, scope: "synthetic-order-ledger", grain: "order", period,
            state: side === "source" && reads === 1 ? "partial" : "complete", version: "synthetic-" + side + "-v" + reads,
            readAt, sourceAsOf: side === "source" && reads === 1 ? null : readAt })),
          sourceRows: reads === 1 ? [] : [row("synthetic-private-order-one", 1100), row("synthetic-private-order-two", 700)],
          mirrorRows: [row("synthetic-private-order-one", 1000)] };
      },
      assertCurrent(snapshot, request) { expect(snapshot.requestDigest).toBe(digest(request)); },
      assertReadable() { if (!permission) throw new Error("Synthetic access withdrawal"); },
    } });
    const view = () => f.post("/v1/read", { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-reconciliation-read",
      requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" }, viewKey: "nightlyReconciliation",
      filters: {}, period: null, sort: [], page: { limit: 50, cursor: null } }, reviewer);
    expect(await view()).toMatchObject({ status: 200, body: { dataState: "partial", data: { sourceState: "notConnected", records: [] } } });
    const fired = await f.fire("2026-11-07T10:00:00Z");
    const runRef = runtimeApiAckSchema.parse(fired.body).runRefs[0]!;
    const work = () => f.post("/v1/runtime/machine", { operation: "work", input: { runRef, maxItems: 1 } });
    expect((await work()).body.state).not.toBe("completed");
    expect(await view()).toMatchObject({ status: 200, body: { dataState: "partial", data: { records: [
      { details: expect.arrayContaining([["Source keys", "Unknown"], ["Source amount", "Unknown"]]) },
    ] } } });
    f.kit.advance(2000);
    now = f.kit.now();
    expect(await work()).toMatchObject({ status: 200, body: { state: "completed" } });
    await work();
    expect(reads).toBe(2);
    const compared = await view();
    expect(compared).toMatchObject({ status: 200, body: { dataState: "ready", data: {
      records: expect.arrayContaining([
        { id: expect.any(String), title: "Source / mirror comparison", details: expect.arrayContaining([["Source amount", "1800 minor USD"], ["Mirror amount", "1000 minor USD"]]) },
        { id: expect.any(String), title: "record-key", details: expect.arrayContaining([["Category", "missing_mirror"], ["Recovery owner", expect.any(String)]]) },
        { id: expect.any(String), title: "net-sales", details: expect.arrayContaining([["Category", "amount"], ["Recovery owner", expect.any(String)]]) },
      ]),
      actions: [expect.objectContaining({ allowed: false }), expect.objectContaining({ allowed: false })], canonicalActions: [],
    } } });
    expect(JSON.stringify(compared.body)).not.toContain("synthetic-private-order");
    const saved = f.app.store.database.prepare("SELECT run_id FROM mirror_reconciliation_runs ORDER BY sequence").all();
    expect(saved).toHaveLength(2);
    const template = reportFixture(now), binding = { producerRef: template.event.producerRef, link: template.event.link };
    const report = f.app.mirrorReconciliation!.report(String(saved[1]!.run_id), binding);
    expect(report).toMatchObject({ severity: "orange", facts: [{ label: "coverage", value: "complete" },
      { label: "records", value: 2, unit: "count", missingReason: null }] });
    const formatted = formatReport({ ...template, event: report! });
    expect(formatted.body).toContain("Records affected: 2");
    expect(formatted.body).not.toContain("synthetic-private-order");
    expect(f.app.mirrorReconciliation!.report(String(saved[0]!.run_id), binding)).toBeNull();
    permission = false;
    expect(await view()).toMatchObject({ status: 403, body: { code: "SOURCE_SCOPE_DENIED" } });
  });
  it("holds unconfigured machine integration without inventing source activation", async () => {
    const f = await fixture(false), answer = await f.fire();
    expect(answer).toMatchObject({ status: 503, body: { code: "RUNTIME_MACHINE_NOT_CONFIGURED", executionCertainty: "uncertain" } });
    expect(f.kit.state.sourceCalls).toBe(0);
  });
  it("separates machine credentials and rejects arbitrary code before admission", async () => {
    const f = await fixture();
    for (const token of [reader, reviewer, dispatchToken]) expect(await f.post("/v1/runtime/machine", { code: "synthetic-untrusted-code" }, token)).toMatchObject({ status: 401, body: { executionCertainty: "uncertain" } });
    expect((await f.post("/v1/runtime/machine", { operation: "work", input: { runRef: "synthetic-run", code: "synthetic-untrusted-code" } })).status).toBe(422);
    expect(f.app.store.database.prepare("SELECT COUNT(*) AS n FROM job_runtime_pages").get()?.n).toBe(0);
    expect(() => createAgentServer({ ...f.options, runtime: { ...f.options.runtime!, machine: { ...f.options.runtime!.machine!, token: reader } } })).toThrow("distinct");
  });
  it("fires one intended window, executes the registered reader and returns truthful private-safe usage", async () => {
    const f = await fixture(), fired = await f.fire(); expect(fired.status).toBe(200);
    const ack = runtimeApiAckSchema.parse(fired.body), runRef = ack.runRefs[0]!;
    const repeated = await f.fire(); expect(runtimeApiAckSchema.parse(repeated.body).returned).toBe(1);
    expect(f.app.store.database.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(1);
    const worked = await f.post("/v1/runtime/machine", { operation: "work", input: { runRef, maxItems: 1 } });
    expect(worked).toMatchObject({ status: 200, body: { state: "completed", executionCertainty: "applied" } });
    await f.post("/v1/runtime/machine", { operation: "work", input: { runRef, maxItems: 1 } });
    expect(f.kit.state.sourceCalls).toBe(1);
    const read = await f.read(runRef); expect(read.status).toBe(200);
    const data = safeRuntimeRunSchema.parse(read.body.data);
    expect(data).toMatchObject({ runRef, delayMs: 3_600_000, state: "completed", counts: { total: 1, completed: 1 },
      usage: { invocations: { directApi: 1, model: 0 }, ordinaryZapTasks: null, mcpTasks: null, modelTokens: null, observedCostMinor: null, runtimeCost: "unknown" } });
    for (const privateValue of ["synthetic-subject", "synthetic-provider-account", "source:synthetic-discovery", "receipt:synthetic-observation", runtimeToken])
      expect(JSON.stringify(read.body)).not.toContain(privateValue);
  });
  it("does not admit a runtime run through the less-specific dispatch worker", async () => {
    const f = await fixture(), ack = runtimeApiAckSchema.parse((await f.fire()).body);
    const raw = f.app.store.database.prepare("SELECT run_id FROM job_runs").get()!.run_id;
    expect(await f.post("/v1/worker/dispatch", { runRef: raw }, dispatchToken)).toMatchObject({ status: 403,
      body: { code: "RUNTIME_MACHINE_BOUNDARY_REQUIRED", executionCertainty: "uncertain" } });
    expect(f.kit.state.sourceCalls).toBe(0); expect(ack.state).toBe("queued");
  });
  it("protects every source-owned legacy read, registration, ingress and control path", async () => {
    const f = await fixture(); await f.fire();
    const rawRun = String(f.app.store.database.prepare("SELECT run_id FROM job_runs").get()!.run_id), jobId = f.kit.registration.definition.jobId;
    for (const path of [`/v1/jobs/${jobId}`, `/v1/job-runs/${encodeURIComponent(rawRun)}`, `/v1/job-runs/${encodeURIComponent(rawRun)}/history`])
      expect(await f.get(path)).toMatchObject({ status: 403, body: { code: "SOURCE_ACTION_BOUNDARY_REQUIRED" } });
    for (const path of ["/v1/jobs", "/v1/job-runs"]) {
      const listed = await f.get(path); expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ data: { records: [], restrictedCount: 1 } });
      expect(JSON.stringify(listed.body)).not.toContain("synthetic-provider-account");
    }
    const definition = f.kit.registration.definition;
    expect((await f.post("/v1/jobs/register", { definition, expectedVersion: definition.version }, reviewer)).status).toBe(403);
    expect((await f.post("/v1/jobs/ingress", { schemaVersion: "job-reference-batch.v1", jobId, jobVersion: definition.version,
      eventId: "synthetic-forged-ingress", eventType: definition.eventType, eventAt: null, items: [] }, reviewer,
      { "idempotency-key": "synthetic-forged-ingress-key" })).status).toBe(403);
    expect((await f.post(`/v1/job-runs/${encodeURIComponent(rawRun)}/control`, { command: "cancel" }, reviewer)).status).toBe(403);
    expect(f.kit.jobs.getRun(rawRun).control).toBe("active"); expect(f.kit.state.sourceCalls).toBe(0);
  });
  it("counts a protected runtime read once against the shared transport limit", async () => {
    const f = await fixture(), runRef = runtimeApiAckSchema.parse((await f.fire()).body).runRefs[0]!;
    for (let index = 0; index < 120; index++) expect((await f.read(runRef)).status, `admitted read ${index + 1}`).toBe(200);
    expect(await f.read(runRef)).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(f.kit.state.sourceCalls).toBe(0);
  });
  it("withdraws machine authority and source read permission without exposing protected hints", async () => {
    const f = await fixture(), ack = runtimeApiAckSchema.parse((await f.fire()).body), runRef = ack.runRefs[0]!;
    f.state.machine = false;
    expect(await f.post("/v1/runtime/machine", { operation: "work", input: { runRef } })).toMatchObject({ status: 403, body: { executionCertainty: "uncertain" } });
    expect(f.kit.state.sourceCalls).toBe(0);
    f.kit.state.denied = true;
    const read = await f.read(runRef); expect(read.status).toBe(403);
    for (const key of ["data", "fieldErrors", "reasonCodes", "rowIndex", "currentVersion"]) expect(read.body).not.toHaveProperty(key);
  });
  it("keeps partial window coverage and named-person withdrawal explicit", async () => {
    const f = await fixture(); f.kit.state.partial = true;
    const runRef = runtimeApiAckSchema.parse((await f.fire()).body).runRefs[0]!;
    const read = await f.read(runRef); expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ dataState: "partial", coverage: { expectedCount: null, observedCount: 1, missingCount: null, complete: false } });
    f.state.afterActor = () => { f.state.reader = false; };
    expect((await f.read(runRef)).status).toBe(403);
  });
});
