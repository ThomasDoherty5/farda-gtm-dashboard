// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHttpTransport } from "../adapter/httpTransport";
import { createLiveAdapter } from "../adapter/liveAdapter";
import { SCHEMA_VERSION, type ReadRequest, type RequestedScope } from "../adapter/contract";
import { createAgentServer, type AgentServerOptions } from "./server";
import { nativeAnalyticsFixture } from "./analytics/nativeFixtures.testkit";
import { nativeAnalyticsViewKeys } from "./analytics/contract";
import { controlSourceFixture, controlSourceProvider, controlTestScope, controlTestTime } from "./operationsControlsFixtures";
import { POLICY_VERSION } from "./assessmentSchema";
import { syntheticBinding, syntheticPacket, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures";

const apps: ReturnType<typeof createAgentServer>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function start(extra: Partial<AgentServerOptions> = {}) {
  const options: AgentServerOptions = { databasePath: ":memory:", workspaceId: SYNTHETIC_SCOPE.workspaceId,
    accountId: SYNTHETIC_SCOPE.accountIds[0]!, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, ...extra };
  const app = createAgentServer(options); apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Expected local test service");
  const origin = `http://127.0.0.1:${address.port}`;
  const scope: RequestedScope = { workspaceId: options.workspaceId, accountIds: [options.accountId], environment: "sandbox" };
  const makeAdapter = (token: string | null = SYNTHETIC_READ_TOKEN) => createLiveAdapter("sandbox", {
    transport: createHttpTransport(origin, { fetch: (input, init) => {
      const headers = new Headers(init?.headers); if (token) headers.set("authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    } }), writeAttempts: 1,
  });
  const request = (viewKey: string, filters: Record<string, unknown> = {}): ReadRequest<Record<string, unknown>> => ({
    schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-native-conformance", requestedScope: scope,
    viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 50 },
  });
  return { app, options, origin, scope, makeAdapter, request };
}

describe("real service + HTTP transport + live adapter conformance supplements", () => {
  it("validates all seven native analytics responses and actual denials without a demo transport", async () => {
    const fixture = nativeAnalyticsFixture();
    const f = await start({ workspaceId: fixture.scope.workspaceId, accountId: fixture.scope.accountId,
      analyticsSource: fixture.source, operations: { now: fixture.now } });
    const adapter = f.makeAdapter();
    for (const key of nativeAnalyticsViewKeys) {
      const response = await adapter.readView({ ...f.request(key), ...fixture.request(key) });
      expect(response.scope).toMatchObject(f.scope); expect(response.data).toMatchObject({ datasetKey: "analytics-native", viewKey: key });
      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_READ_TOKEN);
    }
    await expect(f.makeAdapter(null).readView(f.request("overviewSummary"))).rejects.toMatchObject({ category: "unauthenticated" });
    await expect(adapter.readView({ ...f.request("overviewSummary"), requestedScope: { ...f.scope, accountIds: ["foreign-account"] } })).rejects.toBeDefined();
    fixture.state.allowed = false;
    await expect(adapter.readView(f.request("overviewSummary"))).rejects.toBeDefined();
    const cancel = new AbortController(); cancel.abort();
    await expect(adapter.readView(f.request("overviewSummary"), { signal: cancel.signal })).rejects.toBeDefined();
  });

  it("serves the nightly compatibility key from the same qualified reconciliation owner", async () => {
    const snapshot = controlSourceFixture(), now = () => Date.parse(controlTestTime);
    const f = await start({ workspaceId: controlTestScope.workspaceId, accountId: controlTestScope.accountId,
      operations: { now }, operationsControlSource: controlSourceProvider(() => snapshot, now) });
    const adapter = f.makeAdapter();
    const nightly = await adapter.readView(f.request("nightlyReconciliation"));
    const canonical = await adapter.readView(f.request("operationsControl", { section: "reconciliation" }));
    expect(nightly.data).toEqual(canonical.data); expect(nightly.dataVersion).toBe(canonical.dataVersion);
    expect(nightly.data).toMatchObject({ kind: "native-operations-controls", section: "reconciliation" });
    expect(nightly.coverage.complete).toBe(true);
  });

  it("saves and replays an override annotation through the actual adapter without rewriting scored evidence", async () => {
    const binding = syntheticBinding(), packet = syntheticPacket();
    const f = await start({ bindings: [binding] });
    const savedResponse = await fetch(f.origin + `/v1/creators/${packet.creatorId}`, { method: "PUT",
      headers: { authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}`, "content-type": "application/json", "idempotency-key": "synthetic-override-assessment" },
      body: JSON.stringify({ packet, expectedVersion: 0, policyVersion: POLICY_VERSION, configHash: binding.hash }) });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json() as { runId: string };
    const immutable = structuredClone(f.app.store.findRun(packet.creatorId, saved.runId));
    const adapter = f.makeAdapter(SYNTHETIC_REVIEW_TOKEN), evidenceId = packet.posts[0]!.postId;
    const read = f.request("evidenceRecord", { creatorId: packet.creatorId, evidenceId });
    const before = await adapter.readView<unknown, { version: string; sourceReview: { basisHash: string } }>(read);
    expect(before.data).not.toBeNull();
    const input = { schemaVersion: SCHEMA_VERSION, operation: "saveResource" as const, requestId: "synthetic-override-save", requestedScope: f.scope,
      resourceKind: "reviewerAssessment" as const, resourceRef: evidenceId, expectedVersion: before.data!.version,
      idempotencyKey: "synthetic-override-once", payload: { kind: "override", creatorId: packet.creatorId, runId: saved.runId,
        basisHash: before.data!.sourceReview.basisHash, targetId: "review", reason: "Independent review records a qualified replacement interpretation.",
        replacement: "The fictional demonstration is visible during the observed interval." } };
    const one = await adapter.saveResource(input), replay = await adapter.saveResource(input);
    expect(replay).toEqual(one); expect(one.executionCertainty).toBe("applied");
    expect(one.record).toMatchObject({ revision: 1, input: input.payload, original: { id: "review" } });
    expect(f.app.store.findRun(packet.creatorId, saved.runId)).toEqual(immutable);
    const after = await adapter.readView<unknown, { sourceReview: { contested: boolean; annotations: unknown[] } }>(read);
    expect(after.data!.sourceReview.contested).toBe(true); expect(after.data!.sourceReview.annotations).toHaveLength(1);
    await expect(adapter.saveResource({ ...input, payload: { ...input.payload, replacement: "A different replacement cannot reuse this request key." } })).rejects.toBeDefined();
  });
});
