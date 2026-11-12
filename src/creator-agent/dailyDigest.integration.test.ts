// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "./config.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { digestDatasets, type DigestCohort, type DigestDataset, type DigestRow, type DigestSourceBinding } from "./dailyDigest/contract.ts";
import { DigestSourceError } from "./dailyDigest/query.ts";
import { dailyDigestWindow } from "./dailyDigest/schedule.ts";
import type { DailyDigestConfig } from "./dailyDigest/service.ts";
import { reportReadSchema, type ReportEvent, type ReportSnapshot } from "./slackReporting/contract.ts";
import { createReportingSourceFixture, reportFixture, reportingScope as scope } from "./slackReporting/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";

const reporter = "synthetic-daily-report-machine-token-000000000000";
const reportDate = "2026-11-12";
const locator = { eventRef: "daily-exceptions:" + reportDate, eventVersion: "policy-v1" };
const initialNow = Date.parse("2026-11-12T16:31:00Z");
const sourceAsOf = "2026-11-12T16:24:00.000Z";
const window = dailyDigestWindow(reportDate, null)!;
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

const usd = (minorUnits: number) => ({ currency: "USD", decimals: 2, minorUnits });
const sample: DigestRow[] = [
  { dataset: "launch", ref: "task-late", type: "task", open: true, priority: "P0", ownerAssigned: true, dueAt: "2026-11-12T16:29:00Z", openedAt: null },
  { dataset: "launch", ref: "task-next", type: "task", open: true, priority: "P0", ownerAssigned: false, dueAt: "2026-11-14T16:30:00Z", openedAt: null },
  { dataset: "launch", ref: "task-outside", type: "task", open: true, priority: "P0", ownerAssigned: true, dueAt: "2026-11-14T16:30:00.001Z", openedAt: null },
  { dataset: "launch", ref: "approval-waiting", type: "approval", open: true, priority: null, ownerAssigned: null, dueAt: null, openedAt: "2026-11-11T16:29:00Z" },
  { dataset: "creators", ref: "collaboration-one", handle: "synthetic_creator", followUpPending: true, followUpDueAt: "2026-11-12T20:00:00Z",
    postState: "awaiting", postingDueAt: "2026-11-11T21:00:00Z", sampleDeliveredAt: "2026-11-10T18:00:00Z", dataCheck: true },
  { dataset: "creators", ref: "collaboration-voluntary", handle: "synthetic_voluntary", followUpPending: false, followUpDueAt: null,
    postState: "notRequired", postingDueAt: null, sampleDeliveredAt: "2026-11-10T18:00:00Z", dataCheck: false },
  { dataset: "content", ref: "content-review", state: "review", reviewDueAt: "2026-11-12T16:29:00Z", rights: "finite", rightsExpiresAt: "2026-11-19T16:30:00Z", metricsAsOf: null },
  { dataset: "content", ref: "content-live", state: "live", reviewDueAt: null, rights: "perpetual", rightsExpiresAt: null, metricsAsOf: "2026-11-05T16:29:00Z" },
  { dataset: "orders", ref: "order-one", type: "order", placedAt: "2026-11-11T08:00:00Z", validOrder: true, retainedUnits: 2, netReceipts: usd(7550), check: "clear" },
  { dataset: "orders", ref: "order-two", type: "order", placedAt: "2026-11-12T07:59:59Z", validOrder: true, retainedUnits: 1, netReceipts: usd(3000), check: "failed" },
  { dataset: "orders", ref: "order-today", type: "order", placedAt: "2026-11-12T08:00:00Z", validOrder: true, retainedUnits: 1, netReceipts: usd(9000), check: "clear" },
  { dataset: "orders", ref: "refund-yesterday", type: "refund", occurredAt: "2026-11-11T20:00:00Z", refund: usd(2000) },
  { dataset: "media", ref: "media-day", start: window.start, end: window.end, spend: usd(2500),
    stageState: "released", stage: { spent: usd(135000), limit: usd(150000) } },
  { dataset: "support", ref: "case-aged", open: true, currentOpenedAt: "2026-11-10T16:29:00Z" },
  { dataset: "support", ref: "case-boundary", open: true, currentOpenedAt: "2026-11-10T16:30:00Z" },
  { dataset: "reviews", ref: "review-low", postedAt: "2026-11-11T18:00:00Z", stars: 2 },
  { dataset: "reviews", ref: "review-normal", postedAt: "2026-11-11T18:00:00Z", stars: 3 },
  { dataset: "stock", ref: "position-one", available: 3, low: true },
  { dataset: "stock", ref: "position-two", available: 4, low: false },
  { dataset: "freshness", ref: "sync-stale", state: "stale" },
  { dataset: "freshness", ref: "sync-no-change", state: "noChange" },
  { dataset: "freshness", ref: "synthetic-ad-import", state: "stale", adImport: { lastSuccessAt: "2026-11-10T18:00:00Z" } },
];

async function fixture(rows: readonly DigestRow[] = [], clock = initialNow) {
  const dir = mkdtempSync(join(tmpdir(), "farda-digest-"));
  const reporting = createReportingSourceFixture(scope, clock);
  const route = reportFixture(clock);
  const bindings = Object.fromEntries(digestDatasets.map(dataset => [dataset, {
    sourceRef: "source:" + dataset, bindingVersion: "binding-v1",
    timezone: dataset === "orders" ? "UTC" : "America/Los_Angeles", permissionRef: "permission:" + dataset,
  }])) as Record<DigestDataset, DigestSourceBinding>;
  const reads: { dataset: DigestDataset; cursor: string | null; start: string; end: string }[] = [];
  const state = {
    failOrders: false, partialOrders: false, denyStock: false, unsafeContent: false,
    ownerMissing: false, cohort: null as DigestCohort | null, failDuring: null as (() => Promise<void>) | null,
  };
  const config: DailyDigestConfig = {
    producerRef: "producer:synthetic-daily-exceptions",
    policy: { version: route.programme.version, adoptionRef: route.programme.adoptionRef, effectiveAt: "2026-01-01T00:00:00Z" },
    destination: { targetRef: route.destination.targetRef, workspaceId: route.destination.workspaceId, channelId: route.destination.channelId },
    link: route.event.link,
    sectionLinks: {
      launch: "https://linear.app/synthetic/issue/EXAMPLE-1", creators: "https://linear.app/synthetic/issue/EXAMPLE-2",
      content: "https://linear.app/synthetic/issue/EXAMPLE-3", commerce: "https://linear.app/synthetic/issue/EXAMPLE-4",
      supportStock: "https://linear.app/synthetic/issue/EXAMPLE-5",
    },
    sources: bindings,
    cohort: {
      async read() { return state.cohort; },
      assertCurrent(proof) {
        if (digest(proof) !== digest(state.cohort)) throw new Error("Synthetic cohort changed");
      },
    },
    source: {
      assertCurrent(query, coverage) {
        if (digest(query.scope) !== digest(scope) || digest(query.binding) !== digest(bindings[query.dataset]) ||
            (coverage && coverage.snapshotRef !== "snapshot:" + query.dataset) ||
            (query.dataset === "stock" && state.denyStock)) throw new DigestSourceError("permissionDenied");
      },
      async readPage(query, fence) {
        if (state.failDuring) await state.failDuring();
        fence.assertCurrent();
        reads.push({ dataset: query.dataset, cursor: query.cursor, start: query.window.start, end: query.window.end });
        if (query.dataset === "orders" && state.failOrders) throw new DigestSourceError("readFailed", 4000);
        const candidates = rows.filter(row => row.dataset === query.dataset);
        const offset = query.cursor ? Number(query.cursor) : 0;
        const nextCursor = offset + 2 < candidates.length ? String(offset + 2) : null;
        const pageRows = candidates.slice(offset, offset + 2);
        return {
          scope, dataset: query.dataset, binding: bindings[query.dataset], start: query.window.start, end: query.window.end,
          scheduledAt: query.window.scheduledAt, snapshotRef: "snapshot:" + query.dataset, sourceVersion: "version:" + query.dataset,
          sourceAsOf: clock === initialNow ? sourceAsOf : new Date(clock - 1000).toISOString(), observedAt: new Date(reporting.now).toISOString(),
          coverage: state.partialOrders && query.dataset === "orders" && offset > 0 ? "partial" : "complete",
          rows: state.unsafeContent && query.dataset === "content" ? [{ ...pageRows[0], privateText: "synthetic@example.test" }] : pageRows,
          nextCursor, exhausted: nextCursor === null,
        };
      },
    },
    async readDelivery(event, context) {
      context.assertCurrent();
      const base = reportFixture(reporting.now);
      const snapshot: ReportSnapshot = {
        ...base, event, programme: { ...base.programme, permittedProducers: [config.producerRef] },
        testProvenance: { kind: "controlledSandbox", evidenceRef: "evidence:synthetic-digest" },
        destination: state.ownerMissing ? {
          ...base.destination, owner: { state: "missing", memberId: null, mappingVersion: "owner-v1" },
        } : base.destination,
        authority: { ...base.authority, read: reporting.state.readAllowed ? "allowed" : "denied", send: reporting.state.sendAllowed ? "allowed" : "denied" },
        delivery: { ...base.delivery, notBefore: event.dailyDigest!.window.scheduledAt },
      };
      reporting.add(snapshot);
      return snapshot;
    },
  };
  const options: AgentServerOptions = {
    databasePath: join(dir, "agent.sqlite"), workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: reader, reviewToken: reviewer, operations: { now: () => reporting.now },
    actionFoundation: { reporting: {
      token: reporter, workerRef: reporting.machine.workerRef, source: reporting.source, dailyDigest: config,
      assertCurrent() { reporting.machine.assertCurrent(); },
    } },
  };
  let app: ReturnType<typeof createAgentServer>;
  let origin: string;
  const start = async () => {
    app = createAgentServer(options);
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    origin = "http://127.0.0.1:" + address.port;
  };
  await start();
  closes.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = async (action: string, body: unknown, token = reporter) => {
    const response = await fetch(origin + "/v1/reports/" + action, {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const accept = (key = "daily-synthetic-trigger", selected = locator) => post("accept", { locator: selected, idempotencyKey: key });
  return {
    state, config, reads, reporting, accept, post,
    async restart() { await app.close(); await start(); },
    get db() { return app.store.database; },
    event() {
      const row = app.store.database.prepare("SELECT body FROM daily_digest_reads").get();
      return (JSON.parse(String(row?.body)) as { event: ReportEvent }).event;
    },
  };
}

describe("daily exceptions through the configured reporting machine", () => {
  it("uses all five query sections, preserves source times and matches independently calculated totals", async () => {
    const f = await fixture(sample);
    const accepted = await f.accept();
    expect(accepted.status).toBe(200);
    const { reportRef } = reportReadSchema.parse(accepted.body);
    const sent = await f.post("work", { reportRef });
    expect(sent.body).toMatchObject({ executionCertainty: "applied", grantsBusinessAuthority: false });
    const body = f.reporting.state.calls[0]!.body;
    for (const fact of [
      "Overdue P0 1", "P0 due in 48h 1", "Unassigned due in 7d 1", "Approvals waiting over 24h 1",
      "Follow-ups due today 1", "Past posting deadline 1", "Delivered, awaiting post 1", "Creator data checks 1", "@synthetic_creator",
      "Overdue reviews 1", "Rights expiring in 7d 1", "Stale post metrics 1",
      "Oldest affected content observation 2026-11-05T16:29:00Z",
      "Orders 2", "Retained units 3", "Net receipts USD 105.50", "Refunds USD 20.00", "Orders needing attention 1",
      "Ad spend USD 25.00", "Stage spent USD 1350.00", "Stage cap USD 1500.00", "Stage cap warnings 1",
      "Open support over 48h 1", "New reviews ≤2 stars 1", "Available stock 7", "Low-stock positions 1", "Stale or failed syncs 1",
      "Missed ad imports 1", "Oldest last successful ad import 2026-11-10T18:00:00Z",
    ]) expect(body).toContain(fact);
    expect(body.match(/Source evidence>/g)).toHaveLength(5);
    expect(body).not.toContain("🟢 No exceptions");
    expect(body).not.toContain("synthetic_voluntary");
    expect(body).not.toContain("🔴");
    expect(body).not.toContain("order-one");
    expect(body).not.toContain("synthetic-ad-import");
    expect(f.event().dailyDigest?.results.find(x => x.dataset === "orders")?.coverage)
      .toMatchObject({ rows: 4, pages: 2, sourceAsOf, sourceVersion: "version:orders", exhausted: true, binding: { timezone: "UTC" } });
    expect(f.reads.every(x => x.start === window.start && x.end === window.end)).toBe(true);
  });

  it("does not turn future or partial import evidence into a confirmed exception or an all-clear", async () => {
    const f = await fixture([
      { dataset: "freshness", ref: "import-future", state: "stale", adImport: { lastSuccessAt: "2026-11-12T16:25:00Z" } },
      { dataset: "freshness", ref: "import-partial", state: "partial", adImport: { lastSuccessAt: null } },
    ]);
    const accepted = reportReadSchema.parse((await f.accept()).body);
    await f.post("work", { reportRef: accepted.reportRef });
    const result = f.event().dailyDigest?.results.find(value => value.dataset === "freshness");
    expect(result).toMatchObject({ state: "partial", reason: "unknownFields", exceptions: 0, counts: [] });
    expect(result?.exceptionLastSuccessAt).toBeUndefined();
    const message = f.reporting.state.calls[0]!.body;
    expect(message).toContain("🟠 Daily exceptions");
    expect(message).not.toContain("Missed ad imports");
  });

  it("sends a single all-clear line only after every empty dataset was completely read", async () => {
    const f = await fixture();
    f.state.ownerMissing = true;
    const accepted = reportReadSchema.parse((await f.accept()).body);
    expect((await f.post("work", { reportRef: accepted.reportRef })).body.executionCertainty).toBe("applied");
    const message = f.reporting.state.calls[0]!.body;
    expect(message.split("\n")).toHaveLength(1);
    expect(message).toContain("🟢 No exceptions");
    expect(message).toContain("unassigned (no backup configured)");
    expect(message).not.toContain("<@");
    expect(f.reads.map(read => read.dataset)).toEqual(digestDatasets);
    expect(f.event().dailyDigest?.results.every(result => result.coverage?.rows === 0)).toBe(true);
  });

  it("keeps incomplete pagination unavailable after bounded retries, without partial money totals or another delivery", async () => {
    const f = await fixture(sample);
    f.state.partialOrders = true;
    expect(await f.accept()).toMatchObject({ status: 503, body: { code: "DIGEST_SOURCE_RETRY_DUE", retryAfterMs: 1000 } });
    const readCount = f.reads.length;
    expect((await f.accept("early")).status).toBe(503);
    expect(f.reads).toHaveLength(readCount);
    f.reporting.advance(1000);
    expect(await f.accept()).toMatchObject({ status: 503, body: { retryAfterMs: 2000 } });
    f.reporting.advance(2000);
    const accepted = reportReadSchema.parse((await f.accept()).body);
    await f.post("work", { reportRef: accepted.reportRef });
    expect(f.reporting.state.calls[0]?.body).toContain("Orders unavailable (incomplete read)");
    expect(f.reporting.state.calls[0]?.body).not.toMatch(/Net receipts|🟢 No exceptions/);
    expect(f.reads.filter(read => read.dataset === "orders")).toHaveLength(6);
    expect(f.reads.filter(read => read.dataset === "stock")).toHaveLength(1);
    f.state.partialOrders = false;
    expect((await f.accept("new-trigger-key")).body.reportRef).toBe(accepted.reportRef);
    await f.post("work", { reportRef: accepted.reportRef });
    expect(f.reporting.state.calls).toHaveLength(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM report_records").get()?.n).toBe(1);
  });

  it("resumes completed read checkpoints after restart and reconciles the original lost Slack acknowledgment", async () => {
    const f = await fixture(sample);
    f.state.failOrders = true;
    expect(await f.accept()).toMatchObject({ status: 503, body: { retryAfterMs: 4000 } });
    await f.restart();
    f.reporting.advance(4000);
    f.state.failOrders = false;
    const accepted = reportReadSchema.parse((await f.accept()).body);
    expect(f.reads.filter(read => read.dataset === "launch")).toHaveLength(2);
    expect(f.reads.filter(read => read.dataset === "orders")).toHaveLength(3);
    f.reporting.state.mode = "lostAck";
    expect((await f.post("work", { reportRef: accepted.reportRef })).body.executionCertainty).toBe("uncertain");
    const command = f.reporting.state.calls[0]!;
    await f.restart();
    expect((await f.post("reconcile", { reportRef: accepted.reportRef })).body.executionCertainty).toBe("applied");
    expect(f.reporting.state.lookups.map(value => value.requestKey)).toEqual([command.requestKey]);
    expect(command.body).toContain("Net receipts USD 105.50");
    expect(command.body).not.toContain("Orders unavailable");
    expect((await f.accept("duplicate-after-crash")).body.reportRef).toBe(accepted.reportRef);
    expect(f.reporting.state.calls).toHaveLength(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(1);
  });

  it("holds a second trigger while a first read owns the same period", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.state.failDuring = async () => { f.state.failDuring = null; entered(); await gate; };
    const first = f.accept();
    await started;
    try {
      expect(await f.accept("parallel-key")).toMatchObject({ status: 409, body: { code: "DIGEST_READ_IN_PROGRESS" } });
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
    expect(f.reads).toHaveLength(digestDatasets.length);
  });

  it("keeps denied or malformed source data out of the report and persists no private field", async () => {
    const f = await fixture(sample);
    f.state.denyStock = true;
    f.state.unsafeContent = true;
    expect((await f.accept()).status).toBe(503);
    f.reporting.advance(1000);
    expect((await f.accept()).status).toBe(503);
    f.reporting.advance(2000);
    const { reportRef } = reportReadSchema.parse((await f.accept()).body);
    expect((await f.post("work", { reportRef })).body.executionCertainty).toBe("applied");
    const body = f.reporting.state.calls[0]!.body;
    expect(body).toContain("Content unavailable (incomplete read)");
    expect(body).toContain("Stock unavailable (access denied)");
    expect(body).not.toMatch(/synthetic@example.test|Available stock|🟢 No exceptions/);
    expect(JSON.stringify(f.db.prepare("SELECT body FROM daily_digest_reads").get())).not.toContain("privateText");
    expect(f.reads.some(read => read.dataset === "stock")).toBe(false);
  });

  it("rechecks source permission before the shared sender can deliver", async () => {
    const f = await fixture(sample);
    const { reportRef } = reportReadSchema.parse((await f.accept()).body);
    f.state.denyStock = true;
    expect((await f.post("work", { reportRef })).body.executionCertainty).not.toBe("applied");
    expect(f.reporting.state.calls).toHaveLength(0);
    f.state.denyStock = false;
    expect((await f.post("work", { reportRef })).body.executionCertainty).toBe("applied");
    expect(f.reporting.state.calls).toHaveLength(1);
  });

  it("reconciles the old uncertain attempt after the schedule policy changes", async () => {
    const f = await fixture();
    const { reportRef } = reportReadSchema.parse((await f.accept()).body);
    f.reporting.state.mode = "lostAck";
    expect((await f.post("work", { reportRef })).body.executionCertainty).toBe("uncertain");
    const original = f.reporting.state.calls[0]!.requestKey;
    f.config.policy.version = "policy-v2";
    await f.restart();
    expect((await f.accept("revised-policy", { ...locator, eventVersion: "policy-v2" })).body.code).toBe("DIGEST_BINDING_CHANGED");
    expect((await f.post("reconcile", { reportRef })).body.executionCertainty).toBe("applied");
    expect(f.reporting.state.lookups.map(command => command.requestKey)).toEqual([original]);
    expect(f.reporting.state.calls).toHaveLength(1);
  });

  it("admits a weekend slot only inside the verified active cohort and rejects a reader or extra payload", async () => {
    const f = await fixture([], Date.parse("2026-11-14T16:30:05Z"));
    const saturday = { ...locator, eventRef: "daily-exceptions:2026-11-14" };
    expect((await f.post("accept", { locator: saturday, idempotencyKey: "reader" }, reader)).status).toBe(401);
    expect((await f.post("accept", { locator: saturday, idempotencyKey: "forged", rows: [], cohortActive: true })).status).toBe(400);
    expect((await f.accept("inactive", saturday)).body.code).toBe("DIGEST_WEEKEND_UNSCHEDULED");
    expect(f.reads).toHaveLength(0);
    f.state.cohort = { ref: "cohort:synthetic", version: "v1", scope, startsAt: "2026-11-14T16:00:00Z", endsAt: "2026-11-15T00:00:00Z" };
    const { reportRef } = reportReadSchema.parse((await f.accept("active", saturday)).body);
    expect(f.event().dailyDigest?.window.cohort?.ref).toBe("cohort:synthetic");
    expect((await f.post("work", { reportRef })).body.executionCertainty).toBe("applied");
  });

  it("holds a pre-slot call and observes the Pacific spring and fall calendar days at 08:30", async () => {
    const f = await fixture([], Date.parse("2026-11-12T16:29:59Z"));
    expect((await f.accept()).body.code).toBe("DIGEST_NOT_DUE");
    expect(f.reads).toHaveLength(0);
    const spring = dailyDigestWindow("2026-03-09", null)!;
    const fall = dailyDigestWindow("2026-11-02", null)!;
    expect(spring.scheduledAt).toBe("2026-03-09T15:30:00.000Z");
    expect(fall.scheduledAt).toBe("2026-11-02T16:30:00.000Z");
    expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(23 * 3_600_000);
    expect(Date.parse(fall.end) - Date.parse(fall.start)).toBe(25 * 3_600_000);
  });
});
