// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { assetTestScope, syntheticAsset, syntheticAssetAuthority } from "./assetTestFixtures.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { syntheticPortfolioPacket } from "./portfolioTestFixtures.ts";
import { SCHEMA_VERSION } from "../adapter/contract";

describe("creator operations use the existing authenticated durable service", () => {
  let directory: string;
  let app: ReturnType<typeof createAgentServer> | undefined;
  let origin: string;
  async function start(extra: Partial<AgentServerOptions> = {}) {
    app = createAgentServer({ databasePath: join(directory, "agent.sqlite"), readToken: SYNTHETIC_READ_TOKEN,
      reviewToken: SYNTHETIC_REVIEW_TOKEN, ...assetTestScope, ...extra });
    await new Promise<void>((resolve, reject) => { app!.server.once("error", reject); app!.server.listen(0, "127.0.0.1", resolve); });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test TCP address");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() { const closing = app; app = undefined; if (closing) await closing.close(); }
  async function request(path: string, method = "GET", body?: unknown, token: string | null = SYNTHETIC_READ_TOKEN, extra: Record<string, string> = {}) {
    const response = await fetch(`${origin}${path}`, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "farda-ops-integration-")); });
  afterEach(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });

  it("initializes the launcher service in native Node without a TypeScript transform", () => {
    const moduleUrl = new URL("./server.ts", import.meta.url).href;
    const program = `const { createAgentServer } = await import(${JSON.stringify(moduleUrl)});
const app = createAgentServer(${JSON.stringify({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, ...assetTestScope })});
app.store.close(); console.log("native-service-initialized");`;
    expect(execFileSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8", timeout: 30_000 })).toContain("native-service-initialized");
  });
  it("rejects unauthenticated and reader writes across both namespaces", async () => {
    await start();
    for (const path of ["/v1/assets/ingest", "/v1/portfolio/reviews"]) {
      expect((await request(path, "POST", {}, null)).status).toBe(401);
      expect((await request(path, "POST", {}, SYNTHETIC_READ_TOKEN)).status).toBe(403);
      expect((await request(path, "POST", {}, SYNTHETIC_REVIEW_TOKEN)).status).toBe(400);
    }
  });
  it("requires same-origin CSRF for cookie-based operation writes", async () => {
    await start();
    const session = await request("/v1/session", "GET", undefined, SYNTHETIC_REVIEW_TOKEN);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    for (const path of ["/v1/assets/ingest", "/v1/portfolio/reviews"]) {
      const rejected = await request(path, "POST", {}, null, { cookie });
      expect(rejected.status).toBe(403); expect(rejected.body.code).toBe("CSRF_REJECTED");
      const checked = await request(path, "POST", {}, null, { cookie, origin, "x-csrf-token": session.body.csrfToken });
      expect(checked.status).toBe(400); expect(checked.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
  });
  it("persists asset ingestion across restart and safely replays the original receipt", async () => {
    const { authority } = syntheticAssetAuthority();
    await start({ assetAuthority: authority });
    const input = { scope: assetTestScope, expectedVersion: 0, submission: syntheticAsset() };
    const headers = { "idempotency-key": "synthetic-http-ingest" };
    const first = await request("/v1/assets/ingest", "POST", input, SYNTHETIC_REVIEW_TOKEN, headers);
    expect(first.status).toBe(200);
    await stop(); await start({ assetAuthority: authority });
    const replay = await request("/v1/assets/ingest", "POST", input, SYNTHETIC_REVIEW_TOKEN, headers);
    expect(replay.body).toEqual(first.body);
    const read = await request("/v1/assets/synthetic-asset");
    expect(read.status).toBe(200); expect(read.body.asset.version).toBe(1);
    expect(read.body.exports).toEqual([]); expect(read.body.deployments).toEqual([]);
    const crossScope = await request("/v1/assets/ingest", "POST", { ...input, scope: { ...assetTestScope, accountId: "different-account" } }, SYNTHETIC_REVIEW_TOKEN, { "idempotency-key": "synthetic-wrong-scope" });
    expect(crossScope.status).toBe(403);
  });
  it("persists portfolio review across restart and blocks an unverified founder decision", async () => {
    await start();
    const input = { scope: assetTestScope, expectedVersion: 0, packet: syntheticPortfolioPacket() };
    const headers = { "idempotency-key": "synthetic-http-review" };
    const first = await request("/v1/portfolio/reviews", "POST", input, SYNTHETIC_REVIEW_TOKEN, headers);
    expect(first.status).toBe(200); expect(first.body.proposal.safeguards.dispatchAuthorized).toBe(false);
    await stop(); await start();
    const replay = await request("/v1/portfolio/reviews", "POST", input, SYNTHETIC_REVIEW_TOKEN, headers);
    expect(replay.body).toEqual(first.body);
    const history = await request(`/v1/portfolio/reviews/${first.body.reviewKey}/history`);
    expect(history.body.reviews).toHaveLength(1); expect(history.body.decisions).toEqual([]);
    const decision = await request(`/v1/portfolio/reviews/${first.body.reviewKey}/decisions`, "POST", {
      scope: assetTestScope, expectedVersion: first.body.revision, reviewHash: first.body.reviewHash, linearDecisionRef: "synthetic:unverified",
    }, SYNTHETIC_REVIEW_TOKEN, { "idempotency-key": "synthetic-http-decision" });
    expect(decision.status).toBe(503); expect(decision.body.code).toBe("LINEAR_DECISION_UNVERIFIED");
  });
  it("reports unconnected authorities and keeps a real shipping read pending", async () => {
    await start();
    const capability = await request("/v1/capabilities");
    expect(capability.body.assetRegistry).toMatchObject({ sourceAuthority: "notConnected", providerExecution: "notConnected" });
    expect(capability.body.portfolioReview).toMatchObject({ decisionAuthority: "notConnected", providerExecution: "notConnected" });
    const shipping = await request("/v1/read", "POST", { schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "shippingHub", requestId: "synthetic-shipping-read",
      requestedScope: { workspaceId: assetTestScope.workspaceId, accountIds: [assetTestScope.accountId], environment: "sandbox" }, filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 } });
    expect(shipping.status).toBe(503); expect(shipping.body.code).toBe("INTEGRATION_PENDING");
    expect(shipping.body).not.toHaveProperty("data");
  });
});
