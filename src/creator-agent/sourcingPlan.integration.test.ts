// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readResponseSchema } from "../adapter/contract.ts";
import { viewSchemas } from "../adapter/viewSchemas/index.ts";
import { adapterErrorBodySchema } from "../adapter/wire.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { nativeSourcingSourceFixture } from "./sourcing/nativeFixtures.testkit.ts";
import { nativeSourcingPlanSchema } from "./sourcing/views.ts";
import { NativeSourcingError } from "./sourcing/nativeSource.ts";
import { sourcingSourceFixture, sourcingTestTime } from "./sourcing/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";

const apps: ReturnType<typeof createAgentServer>[] = [], dirs: string[] = [];
type Auth = "reader" | "reviewer" | "none" | { cookie: string };
async function start(configured = true, extra: Partial<AgentServerOptions> = {}, sourceFixture = nativeSourcingSourceFixture()) {
  const fixture = sourceFixture, calls = { reads: 0 }, original = fixture.source.read;
  fixture.source.read = async (binding, signal) => { calls.reads++; return original(binding, signal); };
  const options: AgentServerOptions = { databasePath: ":memory:", workspaceId: fixture.scope.workspaceId, accountId: fixture.scope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: fixture.now }, sourcingPlanSource: configured ? fixture.source : undefined, ...extra };
  const app = createAgentServer(options); apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Expected local test service");
  const base = `http://127.0.0.1:${address.port}`;
  const requestedScope = { workspaceId: fixture.scope.workspaceId, accountIds: [fixture.scope.accountId], environment: "sandbox" };
  const call = async (path: string, body?: unknown, auth: Auth = "reader") => {
    const headers = auth === "none" ? {} : typeof auth === "object" ? { cookie: auth.cookie } : { authorization: `Bearer ${auth === "reviewer" ? SYNTHETIC_REVIEW_TOKEN : SYNTHETIC_READ_TOKEN}` };
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const envelope = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: "2026-11-02.proposed", operation: "readView", requestId: "synthetic-sourcing-plan-read", requestedScope, ...fixture.request, ...overrides });
  const read = (overrides: Record<string, unknown> = {}, auth: Auth = "reader") => call("/v1/read", envelope(overrides), auth);
  return { fixture, calls, options, app, requestedScope, call, read };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const planEnvelope = readResponseSchema(viewSchemas.sourcingPlan!);
function canonical(body: Record<string, unknown>, code: string) {
  expect(adapterErrorBodySchema.strict().parse(body)).toMatchObject({ code, correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/), executionCertainty: "notApplied" });
  expect(Object.keys(body).sort()).toEqual(["code", "correlationId", "executionCertainty", "message", "requestId", "retryAfterMs", "retryable"]); expect(body).not.toHaveProperty("data");
}

describe("native daily sourcing over actual HTTP and SQLite", () => {
  it("fails unconfigured closed with typed metadata and no fabricated plan", async () => {
    const f = await start(false), result = await f.read(); expect(result.status).toBe(503); canonical(result.body, "SOURCING_SOURCE_UNCONFIGURED");
    expect((await f.call("/v1/capabilities")).body.dailySourcingPlan).toMatchObject({ sourceAuthority: "notConnected", discoveryExecution: "notConnected", dispatch: "notConnected" });
  });
  it("refuses unauthenticated and foreign scopes before source access", async () => {
    const f = await start(); expect((await f.read({}, "none")).status).toBe(401);
    for (const requestedScope of [{ ...f.requestedScope, workspaceId: "foreign" }, { ...f.requestedScope, accountIds: ["foreign"] }, { ...f.requestedScope, accountIds: [...f.requestedScope.accountIds, "foreign"] }, { ...f.requestedScope, environment: "production" }]) {
      const result = await f.read({ requestedScope }); expect(result.status).toBe(400); canonical(result.body, "INVALID_INPUT");
    }
    expect(f.calls.reads).toBe(0);
  });
  it("serves the complete synthetic plan to reviewer and cookie-authenticated reader with no private references", async () => {
    const f = await start(), first = await f.read({}, "reviewer"); expect(first.status).toBe(200);
    const reviewer = planEnvelope.parse(first.body), data = nativeSourcingPlanSchema.parse(reviewer.data);
    expect(data).toMatchObject({ datasetKey: "sourcing-plan-native", provenance: { evidenceStage: "synthetic", synthetic: true } });
    expect(data.plan!.schedule.effectiveState).toBe("active");
    expect(data.plan!.capacity.map(row => [row.kind, row.unit])).toEqual(expect.arrayContaining([["invitations", "invitations"], ["sampleUnits", "units"], ["authorizedCost", "minorUnits"]]));
    expect(data.plan!.latestRun!.receiptRefs).toHaveLength(data.plan!.latestRun!.confirmedInvitations.value!);
    expect(reviewer.capabilities).toContainEqual({ actionKind: "requestBatchApproval", state: "held", reasonCodes: ["APPROVAL_SERVICE_NOT_CONNECTED"] });
    const login = await f.call("/v1/session"), cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const reader = planEnvelope.parse((await f.read({}, { cookie })).body);
    expect(reader.data).toEqual(reviewer.data);
    // Principal binding is part of the native view version, even when the permitted public plan is the same.
    expect(reader.dataVersion).not.toBe(reviewer.dataVersion);
    expect(reader.capabilities).toContainEqual({ actionKind: "requestBatchApproval", state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] });
    const text = JSON.stringify(reviewer);
    for (const secret of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, "synthetic-social-cat-account", "synthetic-invite-receipt-1", "fictional-grant-v1"]) expect(text).not.toContain(secret);
  });
  it("retains partial unknown values and stale source evidence without converting either to zero", async () => {
    const fixture = nativeSourcingSourceFixture();
    fixture.state.mutate = packet => { packet.snapshot = { ...sourcingSourceFixture(fixture.scope, sourcingTestTime), version: fixture.state.version }; };
    const f = await start(true, {}, fixture), partial = planEnvelope.parse((await f.read()).body), plan = nativeSourcingPlanSchema.parse(partial.data).plan!;
    expect(partial.dataState).toBe("partial"); expect(plan.steps[3]!.count).toEqual({ value: null, missingReason: "J20_REVIEW_INCOMPLETE" });
    expect(plan.capacity[1]).toMatchObject({ state: "unknown", dispatchBlocked: true, remaining: { value: null } });
    expect(partial.coverage).toMatchObject({ expectedCount: 45, observedCount: 35, missingCount: 10, complete: false });
    fixture.state.now += 2 * 3600_000;
    const stale = planEnvelope.parse((await f.read()).body);
    expect(stale.dataState).toBe("stale"); expect(stale.coverage.complete).toBe(false);
    expect(nativeSourcingPlanSchema.parse(stale.data).plan!.capacity.every(row => row.dispatchBlocked)).toBe(true);
  });
  it("rejects forged filters/cursors/envelope fields before reading the source", async () => {
    const f = await start();
    for (const filters of [{ fixture: "discovery-demo" }, { scenario: "ready" }, { workspaceId: "foreign" }, { sourceAccount: "other" }, null]) { const result = await f.read({ filters }); expect(result.status).toBe(400); canonical(result.body, "INVALID_INPUT"); }
    for (const overrides of [{ period: { preset: "today" } }, { sort: [{ field: "x", direction: "asc" }] }, { injected: true }, { schemaVersion: "2020-01-01" }, { operation: "submitAction" }]) { const result = await f.read(overrides); expect(result.status).toBe(400); canonical(result.body, "INVALID_INPUT"); }
    const cursor = await f.read({ page: { cursor: "forged", limit: 50 } }); expect(cursor.status).toBe(400); expect(cursor.body).not.toHaveProperty("data");
    expect(f.calls.reads).toBe(0);
  });
  it("refuses malformed evidence, impossible dates and foreign scope without serializing source prose", async () => {
    const f = await start();
    for (const text of ["DM @synthetic.creator now", "synthetic.person@example.test", "https://example.test/profile"]) {
      f.fixture.state.mutate = packet => { (packet.snapshot.steps[0] as { nextAction: string }).nextAction = text; };
      const result = await f.read(); expect(result.status).toBe(503); canonical(result.body, "SOURCING_SOURCE_INVALID"); expect(JSON.stringify(result.body)).not.toContain(text);
      f.fixture.state.mutate = packet => { (packet.snapshot.steps[3]!.count as { value: number | null; missingReason: string | null }).value = null; (packet.snapshot.steps[3]!.count as { missingReason: string | null }).missingReason = text; };
      const reason = await f.read(); expect(reason.status).toBe(503); canonical(reason.body, "SOURCING_SOURCE_INVALID"); expect(JSON.stringify(reason.body)).not.toContain(text);
    }
    f.fixture.state.mutate = packet => { packet.snapshot.capacity[0]!.resetAt = "2026-11-31T00:00:00Z"; };
    expect((await f.read()).body.code).toBe("SOURCING_SOURCE_INVALID");
    f.fixture.state.mutate = packet => { packet.snapshot.scope.workspaceId = "foreign"; };
    const foreign = await f.read(); expect(foreign.status).toBe(403); canonical(foreign.body, "SOURCING_BINDING_MISMATCH");
  });
  it("denies revoked source permission with401/403 so the browser clears protected plan data", async () => {
    for (const status of [401, 403]) {
      const f = await start(); f.fixture.source.read = async () => { throw new NativeSourcingError("SOURCING_SOURCE_DENIED", status); };
      const result = await f.read(); expect(result.status).toBe(status); canonical(result.body, "SOURCING_SOURCE_DENIED");
    }
  });
  it("refuses future access observations and the exact access lease boundary after await", async () => {
    const f = await start(); f.fixture.state.mutate = packet => { packet.observedAt = new Date(f.fixture.state.now + 1).toISOString(); };
    let result = await f.read(); expect(result.status).toBe(409); canonical(result.body, "SOURCING_PUBLICATION_EXPIRED");
    f.fixture.state.mutate = null; f.fixture.state.afterRead = () => { f.fixture.state.now += 60_000; };
    result = await f.read(); expect(result.status).toBe(409); canonical(result.body, "SOURCING_PUBLICATION_EXPIRED");
  });
  it("keeps the original server maximum age even if the data source claims a year-long lease", async () => {
    const fixture = nativeSourcingSourceFixture(); fixture.state.now += 27 * 3600_000;
    fixture.state.mutate = packet => { packet.snapshot.validUntil = new Date(sourcingTestTime + 365 * 86400_000).toISOString(); };
    const f = await start(true, {}, fixture), response = await f.read(); expect(response.status).toBe(200);
    const body = planEnvelope.parse(response.body); expect(body.dataState).toBe("stale");
    expect(nativeSourcingPlanSchema.parse(body.data)).toMatchObject({ missingReason: "SOURCE_MAX_AGE_EXCEEDED", plan: { schedule: { effectiveState: "draft" } } });
  });
  it("preserves immutable source material and rejects regressed observations after SQLite restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "farda-native-sourcing-")); dirs.push(dir); const databasePath = join(dir, "agent.sqlite");
    const newer = nativeSourcingSourceFixture({ now: () => sourcingTestTime + 60_000 }); newer.state.version = "fictional-plan-v2";
    const first = await start(true, { databasePath }, newer); expect((await first.read()).status).toBe(200);
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const older = nativeSourcingSourceFixture(); older.state.now = sourcingTestTime + 120_000;
    const second = await start(true, { databasePath }, older), result = await second.read(); expect(result.status).toBe(409); canonical(result.body, "SOURCING_SOURCE_CHANGED");
  });
  it("rechecks actual caller and source permission at final publication", async () => {
    const f = await start(); f.fixture.state.afterRead = () => { f.options.readToken = "synthetic-rotated-reader-token-00000000000000000"; };
    expect((await f.read()).status).toBe(401);
    const g = await start(); g.fixture.state.afterRead = () => { g.fixture.state.allowed = false; };
    const result = await g.read(); expect(result.status).toBe(403); expect(result.body).not.toHaveProperty("data");
  });
  it("shares per-principal read admission and leaves unrelated views with their existing owners", async () => {
    const f = await start(); for (let index = 0; index < 120; index++) expect((await f.read()).status).toBe(200);
    const limited = await f.read(); expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toMatch(/^[1-9]\d*$/); expect(limited.body).toMatchObject({ code: "RATE_LIMITED", requestId: null, executionCertainty: "notApplied" }); expect(f.calls.reads).toBe(120);
    expect((await f.read({}, "reviewer")).status).toBe(200);
    const g = await start(false); expect((await g.read({ viewKey: "discoverySummary" })).body.data.kind).toBe("agent-sourcing"); expect((await g.read({ viewKey: "sourcingPlanX" })).status).toBe(400);
  });
});
