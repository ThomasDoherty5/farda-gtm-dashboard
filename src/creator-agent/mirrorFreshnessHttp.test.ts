// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { assetTestScope } from "./assetTestFixtures.ts";
import { SCHEMA_VERSION, readResponseSchema } from "../adapter/contract";
import { freshnessStateOf } from "../adapter/freshness";
import { MIRROR_IDS, mirrorFreshnessBadge, mirrorFreshnessDetail } from "./mirrorFreshness.ts";
import { mirrorFreshnessViewSchema, mirrorRunDetailSchema } from "./mirrorFreshnessContract.ts";
import { mirrorTestApproval, mirrorTestBindings, mirrorTestSource, mirrorTestCompletion } from "./mirrorFreshnessTestFixtures.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const scope = { ...assetTestScope, environment: "sandbox" as const };
const NOW = Date.parse("2027-02-10T12:00:00Z");
const dataSchema = mirrorFreshnessViewSchema;
const dirs: string[] = [];

describe("mirrorFreshness read", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  let origin = "";
  let source = mirrorTestSource();
  async function start(extra: Partial<AgentServerOptions> = {}, databasePath = ":memory:") {
    source = mirrorTestSource();
    if(extra.mirrorFreshness?.source) extra.mirrorFreshness.source=source.source;
    app = createAgentServer({ databasePath, ...assetTestScope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => NOW }, ...extra });
    await new Promise<void>(resolve => app!.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test address");
    origin = `http://127.0.0.1:${address.port}`;
  }
  const read = (patch: Record<string, unknown> = {}, token: string | null = SYNTHETIC_READ_TOKEN) => fetch(`${origin}/v1/read`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "mirrorFreshness", requestId: "synthetic-mirror-freshness",
      requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment }, filters: {}, period: null,
      sort: [], page: { cursor: null, limit: 50 }, ...patch }),
  });
  afterEach(async () => {
    if (app) await app.close(); app = undefined;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("is honestly unavailable when nothing is configured", async () => {
    await start();
    const response = await read();
    expect(response.status).toBe(200);
    const body = readResponseSchema(dataSchema).parse(await response.json());
    expect(body.dataState).toBe("unavailable");
    expect(body.data!.configured).toBe(false);
    expect(body.data!.mirrors.map(m => m.mirrorId)).toEqual([...MIRROR_IDS]);
    for (const mirror of body.data!.mirrors) {
      expect(mirror).toMatchObject({ state: "unknown", valuesAreCurrent: false, ageMinutes: null, reasonCodes: ["MIRROR_RUNS_NOT_BOUND"] });
      expect(mirrorFreshnessBadge(mirror).state).toBe("unknown");
    }
    expect(body.sourceFreshness).toEqual([]);
    expect(body.coverage).toEqual({ expectedCount: 7, observedCount: 0, missingCount: 7, complete: false, reasonCodes: ["MIRROR_RUNS_NOT_BOUND"] });
  });

  it("does not treat thresholds alone as a bound run recorder", async () => {
    await start({ mirrorFreshness: { policies: { orders: { staleAfterMinutes: 90 }, content: { staleAfterMinutes: 120 } } } });
    const body = readResponseSchema(dataSchema).parse(await (await read()).json());
    expect(body.dataState).toBe("unavailable");
    expect(body.data!.configured).toBe(false);
    for (const mirror of body.data!.mirrors) expect(mirror).toMatchObject({ state: "unknown", reasonCodes: ["MIRROR_RUNS_NOT_BOUND"] });
    expect(body.sourceFreshness).toEqual([]);
  });

  it("is partial when only some mirrors have a run recorder", async () => {
    await start({ mirrorFreshness: {source:source.source, approval:mirrorTestApproval, bindings:mirrorTestBindings.filter(b=>["orders","finance"].includes(b.mirrorId))} });
    const body = readResponseSchema(dataSchema).parse(await (await read()).json());
    expect(body.dataState).toBe("partial");
    expect(Object.fromEntries(body.data!.mirrors.map(m => [m.mirrorId, m.state]))).toEqual({ orders: "neverSynced", shipments: "unknown", stock: "unknown",
      support: "unknown", finance: "neverSynced", content: "unknown", collaborations: "unknown" });
    expect(body.coverage).toMatchObject({ expectedCount: 7, observedCount: 2, complete: false, reasonCodes: ["MIRROR_RUNS_NOT_BOUND"] });
  });

  it("enforces authentication, exact scope and the bounded request shape", async () => {
    await start();
    expect((await read({}, null)).status).toBe(401);
    expect((await read({ requestedScope: { workspaceId: scope.workspaceId, accountIds: ["synthetic-other-account"], environment: "sandbox" } })).status).toBe(403);
    expect((await read({ filters: { mirrorId: "orders" } })).status).toBe(400);
    expect((await read({ page: { cursor: "synthetic-cursor", limit: 1 } })).status).toBe(400);
    expect((await read({ period: { start: "2027-01-01", end: "2027-01-31" } })).status).toBe(400);
  });

  it("serves recorded runs with one state for the badge, the detail and the D-13 entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "farda-mirror-read-")); dirs.push(dir);
    const path = join(dir, "state.sqlite");
    await start({ mirrorFreshness: {source:source.source, approval:mirrorTestApproval, bindings:mirrorTestBindings} }, path);
    for(const [id,outcome,age,changed] of [
      ["orders","complete",10,2],["shipments","complete",10,0],["stock","complete",90,1],
      ["support","complete",50,1],["support","partial",5,0],["finance","failed",5,0],["content","accessRevoked",5,0],
    ] as const) await app!.mirrorRuntime!.ingest(source.add(mirrorTestCompletion(id,outcome,NOW-age*60_000,changed)));
    const sweep=app!.mirrorRuntime!.sweep();
    expect(sweep.incidents.opened.length).toBeGreaterThan(0);
    const response = await read();
    expect(response.status).toBe(200);
    const body = readResponseSchema(dataSchema).parse(await response.json());
    expect(body.dataState).toBe("ready");
    const states = Object.fromEntries(body.data!.mirrors.map(m => [m.mirrorId, m.state]));
    expect(states).toEqual({ orders: "current", shipments: "noChange", stock: "stale", support: "partial", finance: "error", content: "accessRevoked", collaborations: "neverSynced" });
    const d13 = Object.fromEntries(body.sourceFreshness.map(entry => [entry.sourceRef.source, freshnessStateOf(entry)]));
    expect(d13).toEqual({ "mirror:orders": "current", "mirror:shipments": "noChange", "mirror:stock": "error", "mirror:support": "partial", "mirror:finance": "error", "mirror:content": "error",
      "mirror:collaborations": "neverSynced" });
    for (const mirror of body.data!.mirrors) {
      expect(mirrorFreshnessBadge(mirror).state).toBe(mirror.state);
      expect(mirrorFreshnessDetail(mirror).state).toBe(mirror.state);
    }
    // A read never writes incidents; the earlier sweep's incidents are unchanged.
    const after = new DatabaseSync(path);
    try { expect(Number(after.prepare("SELECT SUM(occurrences) n FROM mirror_freshness_incidents").get()!.n)).toBe(Number(after.prepare("SELECT COUNT(*) n FROM mirror_freshness_incidents").get()!.n)); }
    finally { after.close(); }
  });

  it("does not promote configured bindings without recorded owner adoption", async () => {
    await start({mirrorFreshness:{source:source.source,bindings:mirrorTestBindings}});
    const body=readResponseSchema(dataSchema).parse(await (await read()).json());
    expect(body.dataState).toBe("unavailable");expect(body.data!.policy).toBeNull();
    expect(body.data!.schedule.state).toBe("unconfigured");
    expect(body.data!.mirrors.every(m=>m.state==="unknown")).toBe(true);
  });

  it("reads exact source run evidence and refuses cross-account access",async()=>{
    await start({mirrorFreshness:{source:source.source,approval:mirrorTestApproval,bindings:mirrorTestBindings}});
    const completion=mirrorTestCompletion();await app!.mirrorRuntime!.ingest(source.add(completion));
    const args={viewKey:"mirrorRunDetail",filters:{runId:completion.run.runId}};
    const body=readResponseSchema(mirrorRunDetailSchema).parse(await(await read(args)).json());
    expect(body.data!.completion).toEqual(completion);
    expect((await read({...args,requestedScope:{workspaceId:scope.workspaceId,accountIds:["synthetic-foreign"],environment:"sandbox"}})).status).toBe(403);
    expect((await read({...args,filters:{runId:"mailto:person@example.test"}})).status).toBe(400);
    const absent=readResponseSchema(mirrorRunDetailSchema).parse(await(await read({viewKey:"mirrorRunDetail",filters:{runId:"synthetic-absent"}})).json());
    expect(absent.dataState).toBe("unavailable");expect(absent.data!.completion).toBeNull();
  });

  it("refuses invalid thresholds and duplicate bindings at startup", () => {
    expect(() => createAgentServer({databasePath:":memory:",...assetTestScope,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,
      mirrorFreshness:{policies:{orders:{staleAfterMinutes:5}}}})).toThrow("MIRROR_CHECK_SLOWER_THAN_THRESHOLD");
    expect(() => createAgentServer({databasePath:":memory:",...assetTestScope,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,
      operations:{now:()=>NOW},mirrorFreshness:{approval:mirrorTestApproval,source:source.source,bindings:[mirrorTestBindings[0]!,mirrorTestBindings[0]!]}})).toThrow();
  });
});
