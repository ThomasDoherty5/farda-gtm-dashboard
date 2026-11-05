import { REWARD_SCENARIOS } from "@/fixtures/rewards";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
import { shippingHubViewSchemas } from "./shippingHub";
import { settingsViewSchemas } from "./settings";

const AREAS = [analyticsViewSchemas, approvalViewSchemas, collaborationViewSchemas, creatorsViewSchemas, evidenceViewSchemas, financeViewSchemas, lifecycleViewSchemas, monitorViewSchemas, opsViewSchemas, recruitmentViewSchemas, scorecardsViewSchemas, settingsViewSchemas, shippingHubViewSchemas];
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

/** Real demo ids for the views that need a record. Several per view where the demo serves different states. */
const WITH_RECORD: Record<string, unknown[]> = {
  approvalDetail: [{ approvalId: "demo-approval-exact" }, { approvalId: "demo-approval-expired" }, { approvalId: "demo-approval-conflict" }],
  runDetail: [{ runId: "demo-run-approval" }, { runId: "demo-run-batch" }, { runId: "demo-run-uncertain" }, { runId: "demo-run-noevidence" }],
  hourlyRun: [{ runId: "demo-run-hourly" }],
  collaborationDetail: [{ collaborationId: "demo-collaboration-1" }, { collaborationId: "demo-collaboration-2" }],
  evidenceRecord: [{ creatorId: "demo-creator-1", evidenceId: "demo-evidence-1" }],
  assessmentRecord: [{ creatorId: "demo-creator-1", assessmentId: "demo-assessment-content" }, { creatorId: "demo-creator-1", assessmentId: "demo-assessment-tiktok" }, { creatorId: "demo-creator-1", assessmentId: "demo-assessment-sc-commerce" }],
  offerDraft: [{ offerId: "demo-offer-1" }],
  offerRewards: REWARD_SCENARIOS.map((s) => ({ offerId: "demo-offer-1", scenario: s.scenarioId })),
  settlementDetail: [{ settlementId: "COMM-DEMO-D" }, { settlementId: "TT-NATIVE-DEMO" }],
  payableDetail: [{ payableId: "PAY-0012" }],
  orderCustomer: [{ orderId: "TEST-SH-1042" }],
  periodClose: [{ period: "2026-10" }],
  closePackage: [{ period: "2026-10" }, { period: "2026-10", scenario: "lateadjustment" }],
  emailFlow: [{ flow: "setup" }],
  scheduleDetail: [{ jobId: "zap-12" }],
  postPerformance: [{ postId: "P-001" }, { postId: "P-002" }],
  orderDetail: [{ orderId: "TEST-SH-1042" }],
  shippingException: [{ shipmentId: "TEST-SP-0093", exceptionId: "TEST-EVT-129" }],
  supportWorkspace: [{ caseId: "TEST-ISS-018" }, { caseId: "TEST-ISS-016" }],
  returnDetail: [{ returnId: "TEST-RET-028" }],
};

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
    // Every view that needs a record id is covered by the sweep below, so a new one cannot slip through unchecked.
    expect(skipped.filter((k) => !(k in WITH_RECORD)).sort()).toEqual([]);
  });

  it("reads each record-based view with real demo ids, and none is rejected for its shape", async () => {
    let reads = 0;
    for (const [viewKey, filtersList] of Object.entries(WITH_RECORD)) {
      expect(viewKey in viewSchemas, `${viewKey} has no schema`).toBe(true);
      for (const filters of filtersList) {
        const res = await live.readView(read(viewKey, filters));
        expect(res.data, `${viewKey} ${JSON.stringify(filters)} returned no data`).not.toBeNull();
        reads++;
      }
    }
    expect(reads).toBeGreaterThanOrEqual(Object.keys(WITH_RECORD).length);
  });

  it("a record that does not exist is a not-found, not a malformed answer", async () => {
    const e = await fail(live.readView(read("orderDetail", { orderId: "NO-SUCH-ORDER" })));
    expect(e).toBeInstanceOf(AdapterError);
    expect(e.category).toBe("notFound");
  });
});

describe("no screen reads a view the live adapter cannot check", () => {
  // Views that screens read but that have no schema yet, with the reason. Each leaves this list when its schema lands.
  // The test fails both ways: a new unchecked view must be listed here, and a listed view that gains a schema must be removed.
  const PENDING: Record<string, string> = {};

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [full] : [];
    });
  }
  const used = new Set<string>();
  for (const file of sourceFiles(join(process.cwd(), "src/features"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/useView<[\s\S]*?>\(\s*"([A-Za-z0-9]+)"/g)) used.add(m[1]!);
  }

  it("finds the views the screens read", () => {
    expect(used.size).toBeGreaterThan(30);
  });
  it("every view a screen reads has a schema or is listed as pending with a reason", () => {
    const unchecked = [...used].filter((k) => !(k in viewSchemas) && !(k in PENDING)).sort();
    expect(unchecked, "add a schema in src/adapter/viewSchemas, or list the view in PENDING with the reason").toEqual([]);
  });
  it("nothing listed as pending already has a schema", () => {
    expect(Object.keys(PENDING).filter((k) => k in viewSchemas)).toEqual([]);
  });
  it("every schema belongs to a view some screen reads, so a renamed view cannot leave a dead schema", () => {
    expect(Object.keys(viewSchemas).filter((k) => !used.has(k)).sort()).toEqual([]);
  });
});
