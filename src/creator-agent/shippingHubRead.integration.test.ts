// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { ShippingHubReadError, shippingHubSnapshotSchema, type ShippingHubSnapshot, type ShippingHubSource } from "./shippingHubRead.ts";
import { shippingHubSourceFixture } from "./shippingHubRead.testkit.ts";
import { nativeShippingHubSchema } from "../adapter/viewSchemas/shippingHub.ts";
import { readResponseSchema } from "../adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";

const scope = { workspaceId: "synthetic-hub-workspace", accountId: "synthetic-hub-account", environment: "sandbox" as const };
const apps: ReturnType<typeof createAgentServer>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup(configured = true) {
  const state = { now: Date.parse("2026-11-09T10:00:00Z"), reads: 0, permitted: true, version: "synthetic-v1",
    change: (_snapshot: ShippingHubSnapshot) => {}, afterRead: async () => {} };
  const source: ShippingHubSource = {
    async read(binding) {
      state.reads++; const captured = shippingHubSourceFixture(binding, state.now); captured.sourceVersion = state.version;
      state.change(captured); await state.afterRead(); return captured;
    },
    assertCurrent(snapshot) {
      if (!state.permitted) throw new ShippingHubReadError("PRIVATE_OWNER_TOKEN", 403);
      if (snapshot.sourceVersion !== state.version) throw new ShippingHubReadError("VERSION_CHANGED", 409);
    },
  };
  const options: AgentServerOptions = { databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => state.now }, ...(configured ? { shippingHubSource: source } : {}) };
  const app = createAgentServer(options); apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Expected actual HTTP address");
  const read = async (overrides: Record<string, unknown> = {}, token = SYNTHETIC_READ_TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/read`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ schemaVersion: "2026-11-02.proposed", operation: "readView", requestId: "synthetic-hub-read",
        requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" },
        viewKey: "shippingHub", filters: {}, period: null, sort: [], page: { cursor: null, limit: 100 }, ...overrides }) });
    return { status: response.status, body: await response.json() };
  };
  return { read, state, source, options };
}

describe("read-only canonical shipping hub at the real authenticated HTTP boundary", () => {
  it("serves customer and creator origins, parcels, costs and posting evidence without action authority or private source references", async () => {
    const h = await setup(), result = await h.read(); expect(result.status).toBe(200);
    const parsed = readResponseSchema(nativeShippingHubSchema).parse(result.body), data = parsed.data!;
    expect(data.provenance.evidenceStage).toBe("synthetic"); expect(data.shipments).toHaveLength(6);
    expect(new Set(data.shipments.map(s => s.recipient.type))).toEqual(new Set(["customer", "creator"]));
    expect(new Set(data.shipments.map(s => s.origin.kind))).toEqual(new Set(["order", "allocation", "replacement"]));
    expect(data.shipments.filter(s => s.pipeline === "delivered")[0]?.postingClock).not.toBeNull();
    expect(data.shipments.filter(s => s.pipeline === "label")[0]?.carrierState).toBe("pre-transit");
    expect(data.shipments.every(s => s.reviewCapability.state === "held" && s.trackingUrl === null)).toBe(true);
    expect(data.initialSelection).toEqual([]); expect(parsed.capabilities.every(c => c.state !== "available")).toBe(true);
    const wire = JSON.stringify(data);
    for (const privateValue of ["DEMO-SHIP", "DEMO-COLLAB", "@demo.", "synthetic-shipping-source", "synthetic-access-v1", SYNTHETIC_READ_TOKEN]) expect(wire).not.toContain(privateValue);
  });
  it("preserves partial observations without claiming complete counts or a successful empty result", async () => {
    const h = await setup(); h.state.change = s => { s.shipments = []; s.stock = []; s.coverage = { state: "partial", expectedCount: null, observedCount: 0, reasonCodes: ["OWNER_COVERAGE_INCOMPLETE"] }; };
    const result = await h.read(); expect(result.status).toBe(200); expect(result.body).toMatchObject({ dataState: "partial", coverage: { expectedCount: null, complete: false } });
    expect(result.body.data.shipments).toEqual([]);
  });
  it("returns an honest source hold when no owner is configured", async () => {
    const h = await setup(false), result = await h.read(); expect(result.status).toBe(503);
    expect(result.body.code).toBe("SHIPPING_SOURCE_UNCONFIGURED"); expect(result.body).not.toHaveProperty("data");
  });
  it.each(["auth", "scope", "filter", "period", "cursor", "limit"])("rejects %s before source access", async kind => {
    const h = await setup();
    const input = { scope: { requestedScope: { workspaceId: "foreign", accountIds: [scope.accountId], environment: "sandbox" } }, filter: { filters: { scenario: "demo" } },
      period: { period: { start: "2026-01-01", end: "2026-02-01" } }, cursor: { page: { cursor: "unbound", limit: 100 } }, limit: { page: { cursor: null, limit: 101 } }, auth: {} }[kind];
    const result = await h.read(input, kind === "auth" ? "invalid" : SYNTHETIC_READ_TOKEN);
    expect(result.status).toBeGreaterThanOrEqual(400); expect(result.body).not.toHaveProperty("data"); expect(h.state.reads).toBe(0);
  });
  it.each(["caller", "permission", "version", "expiry"])("refuses captured evidence after %s changes during its source read", async kind => {
    const h = await setup(); h.state.afterRead = async () => {
      if (kind === "caller") h.options.readToken = "synthetic-rotated-hub-reader-000000000";
      if (kind === "permission") h.state.permitted = false;
      if (kind === "version") h.state.version = "synthetic-v2";
      if (kind === "expiry") h.state.now += 60_000;
    };
    const result = await h.read(); expect([401, 403, 409]).toContain(result.status); expect(result.body).not.toHaveProperty("data");
    expect(JSON.stringify(result.body)).not.toContain("PRIVATE_OWNER_TOKEN");
  });
  it.each(["scope", "selection", "owners", "future", "packageFuture", "quoteFuture", "duplicate", "posting", "postingTimezone", "currency"])("rejects malformed %s evidence", async kind => {
    const h = await setup(); h.state.change = s => {
      if (kind === "scope") s.binding.scope.accountId = "foreign";
      if (kind === "selection") s.binding.request.limit = 50;
      if (kind === "owners") s.owners = s.owners.filter(o => o.kind !== "posting");
      if (kind === "future") s.shipments[0]!.lastEventAt = new Date(h.state.now + 1).toISOString();
      if (kind === "packageFuture") s.shipments.find(row => row.package)!.package!.measuredAt = new Date(h.state.now + 1).toISOString();
      if (kind === "quoteFuture") s.shipments.find(row => row.quote)!.quote!.observedAt = new Date(h.state.now + 1).toISOString();
      if (kind === "duplicate") s.shipments[1]!.parcelId = s.shipments[0]!.parcelId;
      if (kind === "posting") s.shipments.find(row => row.postingClock)!.postingClock!.acceptedTermsVersion = "different-terms";
      if (kind === "currency") s.shipments.find(row => row.quote)!.quote!.cost.currency = "JPY";
      if (kind === "postingTimezone") s.shipments.find(row => row.postingClock)!.postingClock!.timezone = "PRIVATE_OWNER_TOKEN";
    };
    const result = await h.read(); expect([403, 502]).toContain(result.status); expect(result.body).not.toHaveProperty("data");
    if (["packageFuture", "quoteFuture", "postingTimezone", "currency"].includes(kind)) {
      expect(result.status).toBe(502); expect(result.body.code).toBe("SHIPPING_SOURCE_INVALID");
    }
    expect(JSON.stringify(result.body)).not.toContain("PRIVATE_OWNER_TOKEN");
  });
  it("rejects missing or asynchronous source fences", async () => {
    const h = await setup(); h.source.assertCurrent = async () => {};
    expect((await h.read()).status).toBe(502);
    Object.assign(h.source, { assertCurrent: undefined }); expect((await h.read()).status).toBe(502);
  });
  it("does not accept undeclared private source fields", () => {
    const binding = { scope, principal: { principalRef: "agent-reader", role: "reader" as const }, request: { viewKey: "shippingHub" as const, filters: {}, limit: 100 } };
    expect(shippingHubSnapshotSchema.safeParse({ ...shippingHubSourceFixture(binding, Date.now()), token: "private" }).success).toBe(false);
  });
});
