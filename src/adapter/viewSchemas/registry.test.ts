import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import { SCHEMA_VERSION, type ReadRequest } from "../contract";
import { createLiveAdapter } from "../liveAdapter";
import { demoBackedTransport, rawTransport } from "../transportTestKit";
import { actionPayloadSchemas, mergeSchemas, viewSchemas } from "./index";
import { analyticsViewSchemas } from "./analytics";
import { approvalActionSchemas, approvalViewSchemas } from "./approvals";
import { collaborationViewSchemas } from "./collaboration";
import { creatorsViewSchemas } from "./creators";
import { evidenceViewSchemas } from "./evidence";
import { financeViewSchemas } from "./finance";
import { lifecycleActionSchemas, lifecycleViewSchemas } from "./lifecycle";
import { monitorViewSchemas } from "./monitor";
import { opsActionSchemas, opsViewSchemas } from "./ops";
import { recruitmentViewSchemas } from "./recruitment";
import { scorecardsViewSchemas } from "./scorecards";
import { settingsViewSchemas } from "./settings";

const AREAS = [analyticsViewSchemas, approvalViewSchemas, collaborationViewSchemas, creatorsViewSchemas, evidenceViewSchemas, financeViewSchemas, lifecycleViewSchemas, monitorViewSchemas, opsViewSchemas, recruitmentViewSchemas, scorecardsViewSchemas, settingsViewSchemas];
const scope = { workspaceId: "w", accountIds: ["a"], environment: "sandbox" as const };
let n = 0;
const read = (viewKey: string, filters: unknown = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestedScope: scope, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: `reg-${++n}`,
});
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as AdapterError);
const served = () => demoBackedTransport(createDemoAdapter(), "sandbox");
type Body = Record<string, unknown> & { data: { datasetKey: string; orders?: unknown; netReceipts: { value: { minorUnits: unknown } }; attributedOrders: Record<string, unknown> } };
const answer = async (request: ReadRequest<unknown>) => (await served().send({ kind: "read", envelope: request }, { signal: new AbortController().signal })) as Body;

describe("the view schema registry", () => {
  it("holds every area's view keys exactly once", () => {
    const total = AREAS.reduce((sum, a) => sum + Object.keys(a).length, 0);
    expect(Object.keys(viewSchemas)).toHaveLength(total);
    expect(total).toBeGreaterThan(40);
  });
  it("holds every area's action payload schemas exactly once", () => {
    const total = [approvalActionSchemas, lifecycleActionSchemas, opsActionSchemas].reduce((sum, a) => sum + Object.keys(a).length, 0);
    expect(Object.keys(actionPayloadSchemas)).toHaveLength(total);
  });
  it("refuses a key that two areas both claim, instead of ignoring one of them", () => {
    expect(() => mergeSchemas<z.ZodTypeAny>("view key", [{ x: z.string() }, { x: z.number() }])).toThrow(/"x" is registered by more than one area/);
  });
});

describe("the live adapter checks data against the registry", () => {
  const through = (body: unknown, request = read("overviewSummary")) => createLiveAdapter("sandbox", { transport: rawTransport(body), retryDelayMs: 0 }).readView({ ...request });

  it("returns a good answer unchanged", async () => {
    const request = read("overviewSummary");
    const res = await through(await answer(request), request);
    expect((res.data as Body["data"]).datasetKey).toBe("overview-original");
  });

  it("rejects data of the wrong shape and shows nothing, even when the envelope is perfect", async () => {
    const request = read("overviewSummary");
    const good = await answer(request);
    good.data.netReceipts.value.minorUnits = "12596";
    const e = await fail(through(good, request));
    expect(e).toBeInstanceOf(AdapterError);
    expect(e.category).toBe("unavailable");
    expect(e.body.retryable).toBe(false);
  });

  it("rejects data with a required field missing", async () => {
    const request = read("overviewSummary");
    const good = await answer(request);
    delete good.data.orders;
    expect((await fail(through(good, request))).category).toBe("unavailable");
  });

  it("rejects an answer for a view with no schema, because it cannot be checked", async () => {
    const request = read("overviewSummary");
    const good = await answer(request);
    const e = await fail(through(good, { ...request, viewKey: "madeUpView" }));
    expect(e.category).toBe("unavailable");
  });

  it("lets an answer with no data through for any view: empty, denied and pending carry nothing to check", async () => {
    const request = read("madeUpView");
    const good = await answer(read("overviewSummary"));
    const res = await through({ ...good, requestId: request.requestId, dataState: "empty", data: null }, request);
    expect(res.data).toBeNull();
    expect(res.dataState).toBe("empty");
  });

  it("uses the schemas it is given, not only the registry", async () => {
    const request = read("overviewSummary");
    const good = await answer(request);
    const strict = createLiveAdapter("sandbox", { transport: rawTransport(good), retryDelayMs: 0, viewSchemas: { overviewSummary: z.object({ datasetKey: z.literal("something-else") }) } });
    expect((await fail(strict.readView(request))).category).toBe("unavailable");
  });

  it("does not turn an unknown value into zero on the way through", async () => {
    const request = read("overviewSummary");
    const good = await answer(request);
    good.data.attributedOrders = { ...good.data.attributedOrders, state: "unknown", value: null, reasonCode: "SOURCE_NOT_READ" };
    const res = await through(good, request);
    expect((res.data as Body["data"]).attributedOrders).toMatchObject({ state: "unknown", value: null });
  });
});

describe("every view the demo can serve passes its own schema through the live adapter", () => {
  const live = createLiveAdapter("sandbox", { transport: served(), retryDelayMs: 0 });
  const keys = Object.keys(viewSchemas);

  it("reads each registered view that needs no filters, and none is rejected for its shape", async () => {
    let read_ok = 0;
    const skipped: string[] = [];
    for (const viewKey of keys) {
      try {
        await createDemoAdapter().readView({ ...read(viewKey), requestedScope: { ...scope, environment: "demo" } });
      } catch {
        skipped.push(viewKey); // needs a record id or filter the sweep does not know
        continue;
      }
      const res = await live.readView(read(viewKey));
      expect(res.requestId).toMatch(/^reg-/);
      read_ok++;
    }
    expect(read_ok).toBeGreaterThan(15);
    expect(read_ok + skipped.length).toBe(keys.length);
  });
});
