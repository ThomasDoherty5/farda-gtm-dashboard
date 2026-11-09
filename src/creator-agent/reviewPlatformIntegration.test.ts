// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { evt } from "./funnelFixtures.testkit.ts";
import { digest } from "./config.ts";
import { SCHEMA_VERSION } from "../adapter/contract";
import { savedCreatorPlatformSchema } from "./creatorPlatformViews.ts";

type Json = Record<string, unknown>;
const scope = { workspaceId: "fixture-review-platform", accountIds: ["fixture-account"], environment: "sandbox" as const };
describe("review sprint creator platform HTTP pagination and provenance", () => {
  let app: ReturnType<typeof createAgentServer>;
  let origin: string;
  const hashes = new Map<string, string>();
  beforeEach(async () => {
    hashes.clear();
    app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      workspaceId: scope.workspaceId, accountId: scope.accountIds[0]!, funnelAuthority: { resolve: async (_scope, _request, ref) =>
        hashes.has(ref) ? { workspaceId: scope.workspaceId, accountId: scope.accountIds[0]!, eventHash: hashes.get(ref)! } : null } });
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test server.");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await app.close(); });
  async function post(path: string, body: unknown, token = SYNTHETIC_READ_TOKEN) {
    const response = await fetch(origin + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Json };
  }
  async function ingest(id: string) {
    const event = evt("review-platform-" + id, "discovered", id);
    hashes.set(event.evidenceRef.provenanceRef, digest(event));
    const response = await post("/v1/funnel/events", { jobId: "fixture-review-platform-job", jobVersion: "v1", mode: "observe",
      actor: { id: "fixture-source-observer", role: "observer" }, accountRef: event.sourceAccount,
      policyVersion: event.policyOfferApprovalVersions.policy, inputHash: digest(event), idempotencyKey: event.eventId, correlationId: "corr:" + event.eventId,
      requestedAt: new Date().toISOString(), deadline: null, checkpoint: null, event }, SYNTHETIC_REVIEW_TOKEN);
    expect(response.status).toBe(200);
  }
  function request(viewKey: string, cursor: string | null = null, filters: Json = {}) {
    return { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "fixture-platform-read", requestedScope: scope,
      viewKey, filters, period: null, sort: [], page: { cursor, limit: 1 } };
  }
  it("reads all four empty native views without inventing zero performance or complete provider coverage", async () => {
    for (const key of ["socialCatBoard", "tiktokBoard", "socialCatDashboard", "tiktokDashboard"]) {
      const response = await post("/v1/read", request(key));
      expect(response.status).toBe(200);
      const data = savedCreatorPlatformSchema.parse(response.body.data);
      expect(data).toMatchObject({ total: 0, records: [], providerCoverage: "unknown" });
      expect(data.metrics.every(metric => metric.value === null)).toBe(true);
      expect(response.body.coverage).toMatchObject({ complete: false, reasonCodes: expect.arrayContaining(["SAVED_LEDGER_ONLY", "PROVIDER_UNIVERSE_UNKNOWN"]) });
      expect(response.body.capabilities).toEqual([]);
    }
  });
  it("pages fixed canonical membership while newer source records arrive, with exact cumulative local coverage", async () => {
    for (const id of ["A", "B", "C"]) await ingest(id);
    const first = await post("/v1/read", request("socialCatBoard"));
    expect(first.status).toBe(200);
    const initial = savedCreatorPlatformSchema.parse(first.body.data);
    expect(initial).toMatchObject({ total: 3, offset: 0 });
    await ingest("D");
    const ids = initial.records.map(row => row.id);
    let cursor = (first.body.page as { nextCursor: string }).nextCursor;
    for (let index = 1; index <= 2; index++) {
      const response = await post("/v1/read", request("socialCatBoard", cursor));
      expect(response.status).toBe(200);
      const data = savedCreatorPlatformSchema.parse(response.body.data);
      expect(data).toMatchObject({ total: 3, offset: index, asOf: initial.asOf });
      expect(response.body.coverage).toMatchObject({ expectedCount: 3, observedCount: index + 1, missingCount: 2 - index, complete: false });
      ids.push(...data.records.map(row => row.id));
      cursor = (response.body.page as { nextCursor: string }).nextCursor;
    }
    expect(cursor).toBeNull(); expect(new Set(ids).size).toBe(3);
    expect(savedCreatorPlatformSchema.parse((await post("/v1/read", request("socialCatBoard"))).body.data).total).toBe(4);
    expect(savedCreatorPlatformSchema.parse((await post("/v1/read", request("tiktokBoard"))).body.data).total).toBe(0);
    expect(JSON.stringify(first.body.data)).not.toContain("creator:A");
  });
  it("rejects changed role, view, filters and scope on cursor continuation", async () => {
    await ingest("A"); await ingest("B");
    const first = await post("/v1/read", request("socialCatBoard"));
    const cursor = (first.body.page as { nextCursor: string }).nextCursor;
    expect((await post("/v1/read", request("socialCatBoard", cursor), SYNTHETIC_REVIEW_TOKEN)).status).toBe(400);
    expect((await post("/v1/read", request("socialCatDashboard", cursor))).status).toBe(400);
    expect((await post("/v1/read", request("socialCatBoard", cursor, { q: "changed" }))).status).toBe(400);
    expect((await post("/v1/read", { ...request("socialCatBoard", cursor), requestedScope: { ...scope, accountIds: ["foreign-account"] } })).status).toBe(403);
    expect((await post("/v1/read", { ...request("socialCatBoard"), sort: [{ arbitrary: "sort" }] })).status).toBe(400);
    expect((await post("/v1/read", request("socialCatBoard", null, { unsupported: true }))).status).toBe(400);
  });
});
