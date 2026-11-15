// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrderFeed, OrderRow } from "./analytics/sources.ts";
import { digest } from "./config.ts";
import { launchPulseLocator, type LaunchPulseConfig } from "./launchPulse/service.ts";
import { approvedLaunchWindowSchema, launchPacificDay, launchPulseSlot,
  type ApprovedLaunchWindow } from "./launchPulse/schedule.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { ReportError, reportReadSchema, type ReportEvent } from "./slackReporting/contract.ts";
import { createReportingSourceFixture, reportFixture, reportingScope as scope } from "./slackReporting/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";

const token = "synthetic-launch-report-machine-000000000000";
const hour = 3_600_000;
const scheduledAt = Date.parse("2026-11-07T17:00:00Z");
const initialNow = scheduledAt + 60_000;
const iso = (n: number) => new Date(n).toISOString();
const usd = (minorUnits: number) => ({ currency: "USD", minorUnits, decimals: 2 });
const plan = approvedLaunchWindowSchema.parse({
  version: "synthetic-launch-v1", approvalRef: "synthetic-approved-window", ownerRef: "synthetic-launch-owner",
  approvedAt: "2026-11-06T17:00:00Z", startsAt: "2026-11-07T15:00:00Z", endsAt: "2026-11-10T15:00:00Z",
  timezone: "America/Los_Angeles", interpretation: "elapsed72Hours", enabled: true,
});
const locator = launchPulseLocator(plan, launchPulseSlot(plan, scheduledAt)!);
const closeFixtures: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeFixtures.splice(0).reverse()) await close(); });

function order(id: string, owner: OrderRow["recordOwner"], time: number, net: number, units: number, fields: Partial<OrderRow> = {}): OrderRow {
  return { orderRef: "synthetic-private-order-" + id, canonicalOrderId: "synthetic-canonical-" + id, recordOwner: owner,
    placedAt: iso(time), currency: "USD", netReceiptsMinor: net, unitsRetained: units, valid: true,
    attribution: "unattributed", codeOwner: null, customerRef: null, newRetainedCustomer: null, ...fields };
}
const before = order("pre-launch", "shopify", scheduledAt - 3 * hour, 1200, 1);
const creator = order("creator", "shopify", scheduledAt - 1.5 * hour, 2500, 1, { attribution: "code", codeOwner: "creator" });
const tiktok = order("channel", "tiktokShop", scheduledAt - 0.5 * hour, 3000, 2, { attribution: "utm" });
const cancelled = order("cancelled", "shopify", scheduledAt - 0.25 * hour, 5000, 4, { valid: false });
const boundary = order("next-hour", "shopify", scheduledAt, 9000, 3);

async function fixture(window: ApprovedLaunchWindow | null = plan, clock = initialNow, controlledSandbox = true) {
  const dir = mkdtempSync(join(tmpdir(), "farda-launch-pulse-"));
  const reporting = createReportingSourceFixture(scope, clock);
  const state = { sourceReads: 0, enabled: true, empty: false, missing: false, conflict: false, windowVersion: window?.version,
    receiptAuthorized: true };
  const base = reportFixture(clock);
  const config: LaunchPulseConfig = {
    producerRef: "producer:synthetic-launch-pulse", policy: { version: base.programme.version, adoptionRef: base.programme.adoptionRef },
    window, controlledSandbox, publication: null, link: base.event.link, dashboardLink: "https://dashboard.example.test/overview/launch",
    destination: { targetRef: base.destination.targetRef, workspaceId: base.destination.workspaceId, channelId: base.destination.channelId },
    source: {
      assertWindowCurrent(value) {
        if (!state.enabled || state.windowVersion !== value.version) throw new ReportError("LAUNCH_PULSE_SOURCE_PAUSED", 403);
      },
      async read(request, fence) {
        fence.assertCurrent();
        state.sourceReads++;
        const observedAt = iso(reporting.now), end = request.slot.scheduledAt;
        const coverage = { state: "complete", sourceAsOf: end, version: "synthetic-data-v1",
          receiptRef: "synthetic-coverage", maximumAgeMs: 2 * hour };
        const feed = (channel: OrderFeed["channel"], rows: OrderRow[]): OrderFeed => ({
          channel, origin: "native", feedRef: "synthetic-" + channel, orders: state.empty ? [] : rows,
          lastSuccessAt: end, observedAt, syncState: "ok", coverage: "complete", priorPeriodRefunds: null,
        });
        const start = request.slot.todayStart;
        return {
          scope, requestDigest: digest(request), observedAt, validUntil: iso(reporting.now + 60_000),
          receiptRef: "synthetic-receipt-" + digest(request),
          orders: { coverage, through: { start, end }, definition: "headline-metrics.v1",
            snapshot: { scope, window: { start: launchPacificDay(Date.parse(start)), end: launchPacificDay(Date.parse(end)),
              timezone: "America/Los_Angeles" }, feeds: [
              feed("shopify", [before, creator, tiktok, cancelled, boundary]),
              feed("tiktokShop", [state.conflict ? { ...tiktok, canonicalOrderId: creator.canonicalOrderId } : tiktok]),
            ] },
            creatorCodes: state.empty ? [] : [{ canonicalOrderId: creator.canonicalOrderId, code: "SYNTHETIC-A" }] },
          media: state.missing ? null : { coverage, through: { start, end }, stages: [{
            platform: "meta", stage: "test", spentToday: usd(1000), stageSpend: usd(2000), stageCap: usd(5000),
            capVersion: "synthetic-cap-v1", capApprovalRef: "synthetic-cap-approval",
          }] },
          stock: { coverage: { ...coverage, sourceAsOf: state.missing ? iso(reporting.now - 3 * hour) : end }, availableUnits: 12 },
          support: state.missing ? null : { coverage, categories: [{ category: "setup", count: 2 }] },
          alerts: { coverage, through: { start: iso(Date.parse(end) - hour), end },
            conditions: state.empty ? [] : [{ kind: "budgetCeiling", count: 1 }] },
        };
      },
      assertReceiptCurrent(receipt, request) {
        if (!state.receiptAuthorized || receipt.requestDigest !== digest(request)) throw new ReportError("LAUNCH_PULSE_RECEIPT_DENIED", 403);
      },
    },
    async readDelivery(event, original, context) {
      context.assertCurrent();
      const current = reportFixture(reporting.now);
      const snapshot = { ...current, event, destination: { ...current.destination, ...original },
        programme: { ...current.programme, permittedProducers: [config.producerRef] },
        testProvenance: { kind: "controlledSandbox" as const, evidenceRef: "synthetic-launch-pulse-evidence" },
        delivery: { ...current.delivery, notBefore: event.launchPulse!.slot.scheduledAt } };
      reporting.add(snapshot);
      return snapshot;
    },
  };
  const options: AgentServerOptions = {
    databasePath: join(dir, "agent.sqlite"), workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: reader, reviewToken: reviewer, operations: { now: () => reporting.now },
    actionFoundation: { reporting: { token, workerRef: reporting.machine.workerRef, source: reporting.source, launchPulse: config,
      assertCurrent: reporting.machine.assertCurrent } },
  };
  let app: ReturnType<typeof createAgentServer>, origin: string;
  async function start() {
    app = createAgentServer(options);
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic server address");
    origin = "http://127.0.0.1:" + address.port;
  }
  await start();
  closeFixtures.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = async (action: string, body: unknown) => {
    const response = await fetch(origin + "/v1/reports/" + action, { method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { reporting, state, post, accept: (idempotencyKey = "synthetic-pulse-attempt", target = locator) =>
    post("accept", { locator: target, idempotencyKey }),
    async updateWindow(value: ApprovedLaunchWindow | null) {
      await app.close();
      config.window = value;
      state.windowVersion = value?.version;
      await start();
    },
    get event(): ReportEvent {
      const row = app.store.database.prepare("SELECT body FROM launch_pulses ORDER BY rowid LIMIT 1").get();
      return (JSON.parse(String(row?.body)) as { event: ReportEvent }).event;
    },
  };
}

describe("approved hourly launch pulse", () => {
  it("reconciles one missed bucket to canonical orders, refunds, media, stock and red counts without duplicate delivery", async () => {
    const f = await fixture(plan, initialNow + hour);
    const first = reportReadSchema.parse((await f.accept()).body);
    expect((await f.accept("synthetic-trigger-replay")).body.reportRef).toBe(first.reportRef);
    expect(f.state.sourceReads).toBe(1);
    expect(f.event.launchPulse).toMatchObject({ coverage: "complete", commerce: { value: {
      hour: { orders: 1, retainedUnits: 2, netReceiptsMinor: 3000 },
      today: { orders: 3, retainedUnits: 4, netReceiptsMinor: 6700 },
      launch: { orders: 2, retainedUnits: 3, netReceiptsMinor: 5500 },
      attribution: { code: 1, utm: 1, unknown: 0 }, topCodes: [{ code: "SYNTHETIC-A", orders: 1 }],
    } }, stock: { value: { availableUnits: 12, hoursOfCover: 8 } } });
    f.reporting.state.mode = "lostAck";
    expect((await f.post("work", { reportRef: first.reportRef })).body.executionCertainty).toBe("uncertain");
    expect((await f.post("reconcile", { reportRef: first.reportRef })).body.executionCertainty).toBe("applied");
    expect((await f.post("work", { reportRef: first.reportRef })).body.executionCertainty).toBe("applied");
    expect(f.reporting.state.calls).toHaveLength(1);
    const text = f.reporting.state.calls[0]!.body;
    expect(text).toContain("Platform-reported spend and approved caps");
    expect(text).toContain("Approved budget ceiling 1");
    expect(text).toContain("Open dashboard");
    expect(text).not.toContain("synthetic-private-order");
  });

  it("requires approval, preserves a paused bucket and stops an old version at the exclusive end", async () => {
    const f = await fixture(null);
    expect((await f.accept()).body.code).toBe("LAUNCH_PULSE_NOT_ENABLED");
    expect(f.state.sourceReads).toBe(0);
    await f.updateWindow(plan);
    const accepted = reportReadSchema.parse((await f.accept()).body);
    f.state.enabled = false;
    expect((await f.post("work", { reportRef: accepted.reportRef })).body.code).toBe("LAUNCH_PULSE_SOURCE_PAUSED");
    expect(f.reporting.state.calls).toHaveLength(0);
    f.state.enabled = true;
    f.reporting.state.mode = "lostAck";
    expect((await f.post("work", { reportRef: accepted.reportRef })).body.executionCertainty).toBe("uncertain");
    f.state.enabled = false;
    expect((await f.post("reconcile", { reportRef: accepted.reportRef })).body.executionCertainty).toBe("applied");
    const shifted = approvedLaunchWindowSchema.parse({ ...plan,
      startsAt: iso(Date.parse(plan.startsAt) + hour), endsAt: iso(Date.parse(plan.endsAt) + hour) });
    await f.updateWindow(shifted);
    const reusedVersion = launchPulseLocator(shifted, launchPulseSlot(shifted, scheduledAt - hour)!);
    expect((await f.accept("synthetic-unversioned-change", reusedVersion)).body.code).toBe("LAUNCH_PULSE_WINDOW_VERSION_REUSED");
    const revised = { ...shifted, version: "synthetic-launch-v2" };
    await f.updateWindow(revised);
    expect((await f.accept("synthetic-stale-window")).body.code).toBe("LAUNCH_PULSE_BINDING_CHANGED");
    expect((await f.post("reconcile", { reportRef: accepted.reportRef })).body.executionCertainty).toBe("applied");
    const current = launchPulseLocator(revised, launchPulseSlot(revised, scheduledAt)!);
    f.reporting.advance(Date.parse(revised.endsAt) - f.reporting.now);
    expect((await f.accept("synthetic-ended-window", current)).body.code).toBe("LAUNCH_PULSE_WINDOW_ENDED");
    expect(f.reporting.state.calls).toHaveLength(1);
    expect(f.state.sourceReads).toBe(1);
  });

  it("holds a missed bucket outside reporting hours and requires a separate production publication decision", async () => {
    const offHours = await fixture(plan, Date.parse("2026-11-08T08:05:00Z"));
    expect((await offHours.accept()).body.code).toBe("LAUNCH_PULSE_OUTSIDE_REPORTING_HOURS");
    expect(offHours.state.sourceReads).toBe(0);
    const unapproved = await fixture(plan, initialNow, false);
    expect((await unapproved.accept()).body.code).toBe("LAUNCH_PULSE_PUBLICATION_UNAPPROVED");
    expect(unapproved.state.sourceReads).toBe(0);
  });

  it("keeps zero activity distinct from missing or stale sources and never computes cover from zero selling time", async () => {
    const first = Date.parse(plan.startsAt), f = await fixture(plan, first + 60_000);
    const start = launchPulseLocator(plan, launchPulseSlot(plan, first)!);
    f.state.empty = true;
    f.state.missing = true;
    expect((await f.accept("synthetic-first-bucket", start)).status).toBe(200);
    expect(f.event.launchPulse).toMatchObject({
      coverage: "partial", commerce: { value: { hour: { orders: 0, retainedUnits: 0, netReceiptsMinor: 0 } } },
      media: { value: null, reason: "missing" }, stock: { value: null, reason: "stale" },
      support: { value: null, reason: "missing" },
    });
    const g = await fixture(plan, first + 60_000);
    g.state.empty = true;
    expect((await g.accept("synthetic-zero-selling-time", start)).status).toBe(200);
    expect(g.event.launchPulse?.stock.value).toEqual({ availableUnits: 12, hoursOfCover: null });
  });

  it("refuses a double-owned cross-channel order and rejects a non-current source receipt", async () => {
    const f = await fixture();
    f.state.conflict = true;
    const accepted = reportReadSchema.parse((await f.accept()).body);
    expect(f.event.launchPulse?.commerce).toMatchObject({ reason: "mismatch", value: null });
    f.state.receiptAuthorized = false;
    expect((await f.post("work", { reportRef: accepted.reportRef })).body.code).toBe("LAUNCH_PULSE_RECEIPT_DENIED");
    expect(f.reporting.state.calls).toHaveLength(0);
  });

  it("computes approved calendar ends through DST and excludes outside-hour and pre-approval buckets", () => {
    const calendar = approvedLaunchWindowSchema.parse({ ...plan, interpretation: "throughLPlus3",
      approvedAt: "2026-10-30T14:00:00Z", startsAt: "2026-10-31T14:00:00Z", endsAt: "2026-11-04T08:00:00Z" });
    expect(approvedLaunchWindowSchema.safeParse({ ...calendar, endsAt: "2026-11-04T07:00:00Z" }).success).toBe(false);
    expect(launchPulseSlot(calendar, Date.parse("2026-11-01T15:00:00Z"))).toMatchObject({
      scheduledAt: "2026-11-01T15:00:00.000Z", todayStart: "2026-11-01T07:00:00.000Z",
    });
    expect(launchPulseSlot(calendar, Date.parse("2026-11-01T08:00:00Z"))).toBeNull();
    expect(launchPulseSlot(calendar, Date.parse(calendar.endsAt))).toBeNull();
    expect(launchPulseSlot({ ...plan, approvedAt: iso(scheduledAt + 1000) }, scheduledAt)).toBeNull();
  });
});
