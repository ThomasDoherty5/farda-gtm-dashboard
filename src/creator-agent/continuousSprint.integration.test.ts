// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server";
import { inventorySourceFixture, stockTestScope, stockTestTime, supportSourceFixture } from "./stockSupportFixtures";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures";
import { loadCreatorSourceRuntime } from "./sourceRuntime";

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
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.restoreAllMocks(); });

describe("continuous sprint authenticated integration boundaries", () => {
  it("wires the private mirror reader through the actual launcher and HTTP adapter without claiming complete inventory or handoff authority", async () => {
    const stockId="00000000-0000-4000-8000-000000000011",supportId="00000000-0000-4000-8000-000000000012";
    const rowId="00000000-0000-4000-8000-000000000013",orderId="00000000-0000-4000-8000-000000000014";
    const actualFetch=globalThis.fetch,providerCalls:string[]=[];let denied=false;
    vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      const url=String(input);
      if(!url.startsWith("https://api.notion.com/"))return actualFetch(input,init);
      providerCalls.push(url);
      expect(init?.method).toBe("POST");expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({page_size:100});
      if(denied)return new Response("",{status:403});
      const results=url.includes(supportId)?[{object:"page",id:rowId,parent:{type:"data_source_id",data_source_id:supportId},
        last_edited_time:stockTestTime,in_trash:false,properties:{Status:{type:"status",status:{name:"Open"}},
          Order:{type:"relation",relation:[{id:orderId}]},Notes:{type:"rich_text",rich_text:[{plain_text:"fictional-private-support-note"}]}}}]:[];
      return Response.json({object:"list",results,has_more:false,next_cursor:null});
    });
    const runtime=loadCreatorSourceRuntime({FARDA_STOCK_SUPPORT_SOURCE_CONFIG:JSON.stringify({stockDataSourceId:stockId,supportDataSourceId:supportId}),
      FARDA_AGENT_READ_TOKEN:SYNTHETIC_READ_TOKEN,FARDA_NOTION_READ_TOKEN:"synthetic-notion-read-token"},stockTestScope);
    const {read,call}=await start({...runtime,operations:{now:Date.now}});
    const stock=await read("inventoryOverview",{}),support=await read("supportWorkspace",{caseId:"queue"});
    expect(stock).toMatchObject({status:200,data:{coverage:{complete:false},data:{kind:"source-stock",coverage:"partial",period:null,skus:[]}}});
    expect(support).toMatchObject({status:200,data:{coverage:{complete:false},data:{kind:"source-support",allTimeOpen:null,cohort:null,
      cases:[{state:"Open",owner:"Unknown",handoffAllowed:false}]}}});
    for(const value of [rowId,orderId,"fictional-private-support-note","synthetic-notion-read-token"])
      expect(JSON.stringify(support.data)).not.toContain(value);
    const capabilities=(await call("/v1/capabilities")).data;
    expect(capabilities.stockSupportReview).toMatchObject({sourceAuthority:"injected",inventoryExecution:"notConnected",supportExecution:"notConnected"});
    expect(providerCalls).toEqual([stockId,supportId].map(id=>"https://api.notion.com/v1/data_sources/"+id+"/query"));
    denied=true;
    expect(await read("inventoryOverview",{})).toMatchObject({status:403,data:{executionCertainty:"notApplied"}});
    expect(await read("supportWorkspace",{caseId:"queue"})).toMatchObject({status:403,data:{executionCertainty:"notApplied"}});
  });
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
