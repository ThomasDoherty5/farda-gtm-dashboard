// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server";
import { inventorySourceFixture, stockTestScope, stockTestTime, supportSourceFixture } from "./stockSupportFixtures";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures";

const apps: ReturnType<typeof createAgentServer>[] = [];
const requestedScope = { workspaceId: stockTestScope.workspaceId, accountIds: [stockTestScope.accountId], environment: "sandbox" };
async function start(options: Partial<AgentServerOptions> = {}) {
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: stockTestScope.workspaceId, accountId: stockTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => Date.parse(stockTestTime) }, ...options });
  apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test server");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, body?: unknown, reviewer = false) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + (reviewer ? SYNTHETIC_REVIEW_TOKEN : SYNTHETIC_READ_TOKEN), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const read = (viewKey: string, filters: unknown, reviewer = false, scope = requestedScope) => call("/v1/read", {
    schemaVersion: "2026-11-02.proposed", operation: "readView", requestId: "synthetic-sprint-read", requestedScope: scope,
    viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 10 },
  }, reviewer);
  return { app, call, read };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

describe("continuous sprint authenticated integration boundaries", () => {
  it("reports absent source authority and truthful empty/missing monitor records", async () => {
    const { read, call } = await start();
    expect(await read("inventoryOverview", {})).toMatchObject({ status: 503, data: { code: "INTEGRATION_PENDING", executionCertainty: "notApplied" } });
    expect(await read("supportWorkspace", { caseId: "queue" })).toMatchObject({ status: 503, data: { code: "INTEGRATION_PENDING" } });
    for (const view of ["contentMonitor", "watchlist"]) {
      const result = await read(view, {});
      expect(result.status).toBe(200);
      expect(result.data.data).toMatchObject({ sourceState: "unconfigured", total: 0 });
      expect(result.data.coverage.complete).toBe(false);
      expect(result.data.capabilities).toEqual([expect.objectContaining({ state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] })]);
    }
    expect(await read("hourlyRun", { runId: "missing-native-run" })).toMatchObject({ status: 404, data: { code: "RECORD_NOT_FOUND" } });
    expect(await read("postPerformance", { postId: "missing-native-post" })).toMatchObject({ status: 404, data: { code: "RECORD_NOT_FOUND" } });
    const capabilities = (await call("/v1/capabilities")).data;
    expect(capabilities.contentMonitor).toMatchObject({ sourceAuthority: "notConnected", retryAuthority: "notConnected" });
    expect(capabilities.stockSupportReview).toMatchObject({ sourceAuthority: "notConnected", inventoryExecution: "notConnected", supportExecution: "notConnected" });
  });

  it("rejects wrong scope and private request-key lookups before touching the source", async () => {
    let reads = 0;
    const { read } = await start({ stockSupportSource: {
      readInventory: async scope => { reads++; return inventorySourceFixture(scope); },
      readSupport: async scope => { reads++; return supportSourceFixture(scope); },
    } });
    expect((await read("inventoryOverview", {}, false, { ...requestedScope, accountIds: ["other-account"] })).status).toBe(400);
    expect(await read("inventoryOverview", { proposalRequestKey: "private-request" })).toMatchObject({ status: 403 });
    expect(await read("supportWorkspace", { caseId: "queue", proposalRequestKey: "private-request" })).toMatchObject({ status: 403 });
    expect(reads).toBe(0);
  });

  it("stores one local transfer proposal without changing source stock, and fences reader writes", async () => {
    const inventory = inventorySourceFixture();
    const sourceBefore = structuredClone(inventory);
    const { read, call, app } = await start({ stockSupportSource: {
      readInventory: async () => structuredClone(inventory), readSupport: async scope => supportSourceFixture(scope),
    } });
    const shown = await read("inventoryOverview", {}, true);
    expect(shown.status).toBe(200);
    const request = { schemaVersion: "2026-11-02.proposed", operation: "requestApproval", requestId: "synthetic-transfer",
      requestedScope, actionKind: "requestStockTransfer", expectedVersion: shown.data.dataVersion, idempotencyKey: "transfer-same-key",
      entityRefs: [], approvalRef: null, manifestRef: null,
      payload: { scope: {}, sku: "FARDA-GRAPHITE", windowRef: "current", from: "H1", to: "H2", units: 1, reasonCode: "rebalance" } };
    expect(await call("/v1/action", request)).toMatchObject({ status: 403 });
    const first = await call("/v1/action", request, true), second = await call("/v1/action", request, true);
    expect(first).toMatchObject({ status: 200, data: { state: "approvalPending", executionCertainty: "applied", approvalRef: null, manifestRef: null } });
    expect(second.data.actionRef).toBe(first.data.actionRef);
    expect(Number(app.store.database.prepare("SELECT COUNT(*) n FROM stock_support_reviews WHERE status='recorded'").get()!.n)).toBe(1);
    expect(inventory).toEqual(sourceBefore);
    const observed = await read("inventoryOverview", { proposalRequestKey: request.idempotencyKey }, true);
    expect(observed.data.data.reconciliation).toMatchObject({ state: "recorded", actionRef: first.data.actionRef });
  });

  it("does not certify a missing request from stale or partial source evidence", async () => {
    let clock = Date.parse(stockTestTime), partial = false;
    const { read } = await start({ operations: { now: () => clock }, stockSupportSource: {
      readInventory: async scope => ({ ...inventorySourceFixture(scope),
        observedAt: partial ? new Date(clock).toISOString() : stockTestTime, coverage: partial ? "partial" : "complete" }),
      readSupport: async scope => supportSourceFixture(scope),
    } });
    clock += 16 * 60_000;
    const stale = await read("inventoryOverview", { proposalRequestKey: "uncertain-original-key" }, true);
    expect(stale.status).toBe(409);
    expect(stale.data.code).toBe("SOURCE_STALE");
    // Renew the source observation without moving the service/admission clock backward.
    partial = true;
    const incomplete = await read("inventoryOverview", { proposalRequestKey: "uncertain-original-key" }, true);
    expect(incomplete.status).toBeGreaterThanOrEqual(400);
    expect(incomplete.data.code).toBe("SOURCE_COVERAGE_PARTIAL");
  });
});
