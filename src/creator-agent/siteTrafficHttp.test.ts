// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { siteTrafficServerFixture, SYNTHETIC_TRAFFIC_MACHINE_TOKEN } from "./siteTrafficServerFixture.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { nativeSiteTrafficViewSchema } from "./siteTraffic/views.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { digest } from "./config.ts";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "traffic-http-"));
  const data = siteTrafficServerFixture(join(directory, "server.sqlite"));
  const app = createAgentServer(data.options);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, body: unknown, token: string) => {
    const response = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const readBody = { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "fictional-traffic-read", requestedScope: { workspaceId: data.options.workspaceId, accountIds: [data.options.accountId], environment: "sandbox" },
    viewKey: "customerJourney", filters: data.filters, period: null, sort: [], page: { cursor: null, limit: 100 } };
  return { ...data, app, request, readBody, read: (body: unknown = readBody) => request("/v1/read", body, SYNTHETIC_READ_TOKEN),
    import: (body: unknown = data.command, token = SYNTHETIC_TRAFFIC_MACHINE_TOKEN) => request("/v1/site-traffic/import", body, token),
    async close() { await app.close(); data.close(); rmSync(directory, { recursive: true, force: true }); } };
}

it("imports through the machine boundary into the actual server database; repeated delivery preserves one total and first actual import stays pending", async () => {
  const h = await fixture();
  try {
    const pending = await h.read(); expect(pending.status).toBe(200); expect(pending.body.data.measures.sessions.value).toBeNull();
    const first = await h.import(); expect(first.status, JSON.stringify(first.body)).toBe(200);
    const repeat = await h.import(); expect(repeat.status).toBe(200); expect(repeat.body).toEqual(first.body);
    expect(h.state.importReads).toBe(1);
    const result = await h.read(); expect(result.status, JSON.stringify(result.body)).toBe(200);
    const view = nativeSiteTrafficViewSchema.parse(result.body.data);
    expect(view.measures.sessions.value).toBe(16000); expect(view.measures.shopifyOrders.value).toBe(260);
    expect(view.rates.storeOrderConversion.percent).toBe(1.625);
    expect(view.rates.providerConversion.percent).toBe(1); expect(view.measures.productViewEvents.value).toBe(3);
    expect(view.imports.firstActualImport).toEqual({ state: "pending", receipt: null });
    expect(view.provenance).toMatchObject({ synthetic: true, evidenceStage: "synthetic" });
    expect(JSON.stringify(view)).not.toContain(h.options.accountId); expect(JSON.stringify(view)).not.toContain(h.input.requestKey);
    expect(h.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_imports").get()?.n).toBe(0);
  } finally { await h.close(); }
});

it("reader and reviewer credentials cannot import, and caller fields cannot supply source counts or cross-account authority", async () => {
  const h = await fixture();
  try {
    expect((await h.import(h.command, SYNTHETIC_READ_TOKEN)).status).toBe(401);
    expect((await h.import(h.command, SYNTHETIC_REVIEW_TOKEN)).status).toBe(401);
    expect((await h.import({ ...h.command, sessions: 16000, permitted: true })).status).toBe(422);
    expect((await h.import({ ...h.command, requestedScope: { ...h.command.requestedScope, accountId: "another-fictional-account" } })).status).toBe(403);
    expect(h.state.importReads).toBe(0); expect((await h.read()).body.data.measures.sessions.value).toBeNull();
  } finally { await h.close(); }
});

it("revoked machine authority during the source read prevents the atomic import and leaves its original key reusable only after fresh authorization", async () => {
  const h = await fixture();
  try {
    h.state.beforeReport = () => { h.state.machineDenied = true; };
    const denied = await h.import(); expect(denied.status).toBe(403); expect(denied.body).not.toHaveProperty("receiptRef");
    h.state.beforeReport = null; h.state.machineDenied = false;
    expect((await h.read()).body.data.measures.sessions.value).toBeNull();
    const retried = await h.import(); expect(retried.status).toBe(200); expect(retried.body.inserted).toBe(2);
    expect((await h.read()).body.data.measures.sessions.value).toBe(16000);
  } finally { await h.close(); }
});

it("a late source denial clears the whole protected read; malformed filters and unrelated cursor/window scope are rejected", async () => {
  const h = await fixture();
  try {
    expect((await h.import()).status).toBe(200);
    h.state.beforeClicks = () => { h.state.denied = true; };
    const denied = await h.read(); expect(denied.status).toBe(403); expect(denied.body.data).toBeUndefined();
    h.state.denied = false; h.state.beforeClicks = null;
    expect((await h.read({ ...h.readBody, filters: { ...h.filters, segment: { kind: "utm", segmentRef: "private@example.test" } } })).status).toBe(400);
    expect((await h.read({ ...h.readBody, page: { cursor: "other-window", limit: 100 } })).status).toBe(400);
    const changed = await h.read({ ...h.readBody, filters: { ...h.filters, segment: { kind: "utm", segmentRef: "traffic-segment-" + digest("unapproved-segment") } } });
    expect(changed.status).toBe(409); expect(changed.body.data).toBeUndefined();
  } finally { await h.close(); }
});

it("machine principal rotation while resolving a proof cannot borrow the original server binding", async () => {
  const h = await fixture();
  try {
    h.machineState.beforeResolve = () => { h.machine.principal.grantVersion = digest("rotated-machine-grant"); };
    expect((await h.import()).status).toBe(403); expect(h.state.importReads).toBe(0);
  } finally { await h.close(); }
});
