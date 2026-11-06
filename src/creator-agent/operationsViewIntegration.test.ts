// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { assetTestScope } from "./assetTestFixtures.ts";
import { SCHEMA_VERSION, readResponseSchema } from "../adapter/contract";
import { viewSchemas } from "../adapter/viewSchemas";
import { unknownBusinessEligibility, unknownSourceFreshness, type ExpectedBinding, type VerificationReceipt } from "./connections/schema.ts";
import { capabilityIdForBinding } from "./connections/ledger.ts";

const keys = ["connectionsOverview", "channelCapabilities", "automationRuns"] as const;
const scope = { ...assetTestScope, environment: "sandbox" as const };
const binding = (action = "readPolicy"): ExpectedBinding => ({ ...scope, provider: "notion", providerAccountId: "synthetic-private-source-account",
  action, mode: "observe", route: "api", routeRef: "route:synthetic-reader", authorizationScopeVersion: "synthetic-auth-v1", toolVersion: "synthetic-tool-v1",
  requiredScopes: ["policy:read"], connectionRef: "connection:synthetic-private-connection", secretRef: "secretref:synthetic-private-secret" });

describe("native authenticated saved-operations read views", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  let origin: string;
  let clock = Date.parse("2026-11-06T05:00:00.000Z");
  const receipts = new Map<string, VerificationReceipt>();
  async function start() {
    clock = Date.parse("2026-11-06T05:00:00.000Z"); receipts.clear();
    app = createAgentServer({ databasePath: ":memory:", ...assetTestScope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      operations: { now: () => clock, resolveReceipt: ref => receipts.get(ref) ?? null } });
    await new Promise<void>(resolve => app!.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test address");
    origin = `http://127.0.0.1:${address.port}`;
  }
  const request = (viewKey: string, patch: Record<string, unknown> = {}, token: string | null = SYNTHETIC_READ_TOKEN) => fetch(`${origin}/v1/read`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestId: "synthetic-operations-read",
      requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment }, filters: {}, period: null,
      sort: [], page: { cursor: null, limit: 50 }, ...patch }),
  });
  afterEach(async () => { if (app) await app.close(); app = undefined; });

  it("returns validated empty saved stores without asserting provider-wide coverage", async () => {
    await start();
    for (const key of keys) {
      const response = await request(key);
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      const body = readResponseSchema(viewSchemas[key]!).parse(await response.json());
      expect(body.data).toMatchObject({ source: "saved-operations", records: [], coverage: { total: 0, returned: 0, partial: false } });
      expect(body.coverage).toMatchObject({ expectedCount: 0, observedCount: 0, complete: true });
      expect(body.sourceFreshness).toEqual([]); expect(body.capabilities).toEqual([]);
    }
  });

  it("enforces exact scope, authentication and supported local listing semantics", async () => {
    await start();
    for (const key of keys) {
      expect((await request(key, {}, null)).status).toBe(401);
      expect((await request(key, { requestedScope: { workspaceId: scope.workspaceId, accountIds: ["synthetic-other-account"], environment: "sandbox" } })).status).toBe(400);
      expect((await request(key, { filters: { providerAccountId: "synthetic-client-selection" } })).status).toBe(400);
      expect((await request(key, { page: { cursor: "synthetic-client-cursor", limit: 1 } })).status).toBe(400);
      expect((await request(key, { sort: [{ field: "unknown", direction: "asc" }] })).status).toBe(400);
      expect((await request(key, { period: { start: "2026-01-01", end: "2026-01-31" } })).status).toBe(400);
    }
  });

  it("returns current per-action verification, expires it at read time and strips private locators", async () => {
    await start();
    const b = binding();
    const saved = app!.operations.ledger.register({ binding: b, ownerRef: "owner:synthetic-private-owner", costBasis: { state: "unknown", reasonCode: "COST_UNKNOWN" } }, 0);
    receipts.set("receipt:synthetic-private-receipt", { receiptRef: "receipt:synthetic-private-receipt", binding: b, outcome: "Ready", checkedAt: new Date(clock).toISOString(),
      expiresAt: new Date(clock + 60_000).toISOString(), verifiedScopes: b.requiredScopes, connectionHealth: "Authenticated",
      sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: [] });
    await app!.operations.ledger.verify(saved.capabilityId, "receipt:synthetic-private-receipt", 1);
    const ready = await (await request("connectionsOverview")).json();
    expect(ready.data.records).toHaveLength(1);
    expect(ready.data.records[0]).toMatchObject({ state: "Ready", sourceUpdatedAt: null, lastSuccessAt: null, freshness: "unknown" });
    const serialized = JSON.stringify(ready);
    for (const privateValue of [b.providerAccountId, b.connectionRef!, b.secretRef!, "owner:synthetic-private-owner", "receipt:synthetic-private-receipt", capabilityIdForBinding(b)])
      expect(serialized).not.toContain(privateValue);
    clock += 60_001;
    const expired = await (await request("channelCapabilities")).json();
    expect(expired.data.records[0]).toMatchObject({ state: "Expired", lastSuccessAt: null });
    expect(expired.data.records[0].id).toBe(ready.data.records[0].id);
  });

  it("reports bounded saved coverage without fabricated cursors or hidden omitted rows", async () => {
    await start();
    for (const action of ["readPolicy", "readMetrics", "readOrders"]) app!.operations.ledger.register({ binding: binding(action), ownerRef: "owner:synthetic-owner",
      costBasis: { state: "unknown", reasonCode: "COST_UNKNOWN" } }, 0);
    const response = await request("connectionsOverview", { page: { cursor: null, limit: 1 } });
    const body = readResponseSchema(viewSchemas.connectionsOverview!).parse(await response.json());
    expect(body.dataState).toBe("partial"); expect(body.data).toMatchObject({ coverage: { total: 3, returned: 1, partial: true } });
    expect(body.coverage).toMatchObject({ expectedCount: 3, observedCount: 1, missingCount: 2, complete: false });
    expect(body.page).toEqual({ nextCursor: null, hasMore: false });
  });
});
