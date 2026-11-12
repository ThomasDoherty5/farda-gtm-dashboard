// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { reportEventSchema, reportReadSchema, reportSnapshotSchema, type ReportLocator, type ReportSnapshot } from "./slackReporting/contract.ts";
import { createReportingSourceFixture, reportFixture, reportingScope as scope } from "./slackReporting/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { creatorHandoffRef, creatorPipelinePath, type CreatorHandoff } from "./creatorHandoff/contract.ts";
import { summarizeCreatorWeek } from "./creatorHandoff/weekly.ts";
import { weeklySnapshotWindow } from "./weeklySnapshots/schedule.ts";
import type { OrderRow } from "./analytics/sources.ts";

const at = "2026-11-09T16:30:10.000Z", now = Date.parse(at);
const weekly = weeklySnapshotWindow("2026-11-09")!;
const producer = "producer:synthetic-creator-handoff";
const collaborationId = "TEST-COLLAB-A", creatorId = "TEST-CREATOR-A", agreementRef = "TEST-AGREEMENT-A";
const origin = "https://dashboard.example.test";
const dashboardLink = origin + "/collaborations/" + collaborationId;
const clock = { receiptRef: "TEST-CLOCK-A", reviewAfter: "2026-11-06T12:00:00.000Z" };
const machineToken = "synthetic-creator-report-machine-000000000000";
const base = reportFixture(now);
const destination = { targetRef: "target:synthetic-creator-feed", version: "target-v1",
  workspaceId: base.destination.workspaceId, channelId: base.destination.channelId, botId: base.destination.botId };
const proof = { creatorId, dashboardLink, observedAt: at };
const firstSample = { shipmentId: "TEST-SHIPMENT-A", source: "shippo", purpose: "creatorSample" } as const;
const journey: CreatorHandoff[] = [
  { ...proof, kind: "agreement", receiptRef: agreementRef, campaignId: "TEST-CAMPAIGN-A", deliverableCount: 1,
    postingTerms: "committed", postingDeadline: "2026-11-05T12:00:00.000Z" },
  { ...proof, kind: "sampleReserved", receiptRef: "TEST-RESERVE-A", basisReceiptRef: agreementRef, reservationId: "TEST-RESERVATION-A" },
  { ...proof, ...firstSample, kind: "sampleShipped", receiptRef: "TEST-TRACK-IN-TRANSIT-A", basisReceiptRef: "TEST-RESERVE-A", carrier: "USPS", status: "inTransit" },
  { ...proof, ...firstSample, kind: "sampleDelivered", receiptRef: "TEST-TRACK-DELIVERED-A",
    basisReceiptRef: "TEST-TRACK-IN-TRANSIT-A", status: "delivered", clock },
  { ...proof, kind: "noPostReview", receiptRef: "TEST-NO-POST-A", basisReceiptRef: "TEST-TRACK-DELIVERED-A", clock, absence: "completeSourceRead" },
  { ...proof, kind: "postLive", receiptRef: "TEST-LIVE-A", basisReceiptRef: agreementRef,
    network: "tiktok", postId: "9000000001", liveUrl: "https://www.tiktok.com/@synthetic_maker/video/9000000001", visibility: "public" },
];
const occurrence = ["2026-11-02T12:00:00.000Z", "2026-11-02T12:10:00.000Z", "2026-11-03T12:00:00.000Z",
  "2026-11-04T12:00:00.000Z", "2026-11-06T12:30:00.000Z", "2026-11-07T12:00:00.000Z"];
const envelope: Omit<ReportSnapshot, "event"> = {
  ...base, programme: { ...base.programme, permittedProducers: [producer] },
  destination: { ...base.destination, ...destination }, testProvenance: { kind: "controlledSandbox", evidenceRef: "TEST-CREATOR-FEED" },
  delivery: { ...base.delivery, notBefore: at },
};
function snapshot(sequence: number, fact = journey[sequence - 1]!, occurredAt = occurrence[sequence - 1]!, version = "source-v1") {
  return reportSnapshotSchema.parse({ ...envelope, event: {
    eventRef: creatorHandoffRef(collaborationId, sequence), eventVersion: version, producerRef: producer, occurredAt, severity: "info",
    identity: { kind: "creatorHandoff", collaborationId, sequence, previousEventRef: sequence > 1 ? creatorHandoffRef(collaborationId, sequence - 1) : null },
    subject: { kind: "creator", handle: "synthetic_maker" }, facts: [{ label: "coverage", value: "complete" }],
    nextAction: "reviewCreator", link: base.event.link, creatorHandoff: fact,
  } });
}

function order(id: string, channel: OrderRow["recordOwner"], unitsRetained: number, attribution: "code" | "utm" = "code"): OrderRow {
  return { orderRef: "TEST-" + id, canonicalOrderId: id, recordOwner: channel, placedAt: "2026-11-07T12:00:00.000Z",
    valid: true, currency: "USD", netReceiptsMinor: unitsRetained * 3000, attribution, codeOwner: attribution === "code" ? "creator" : null,
    customerRef: null, newRetainedCustomer: null, unitsRetained };
}
function weeklySource() {
  const b = "TEST-COLLAB-B";
  const delivered = { at: occurrence[3]!, receiptRef: "TEST-TRACK-DELIVERED-A" };
  const reviewClock = { reviewAfter: clock.reviewAfter, deliveryReceiptRef: delivered.receiptRef };
  const cohort = { campaignId: "TEST-CAMPAIGN-A", posting: "committed", delivery: delivered, reviewClock };
  const feed = { observedAt: at, lastSuccessAt: at, syncState: "ok", coverage: "complete", origin: "native", priorPeriodRefunds: null };
  return { scope, sourceVersion: "TEST-MONDAY-v1", asOf: at, periodClosedAt: weekly.end,
    lifecycle: { coverage: "complete", rows: [
      { ...cohort, collaborationId, creatorId, stage: "published", publication: { firstPublicPostAt: occurrence[5], completeThrough: weekly.end } },
      { ...cohort, collaborationId: b, creatorId: "TEST-CREATOR-B", stage: "review", publication: { firstPublicPostAt: null, completeThrough: weekly.end } },
      { ...cohort, campaignId: "TEST-CAMPAIGN-B", collaborationId: "TEST-COLLAB-C", creatorId: "TEST-CREATOR-C",
        stage: "delivered", posting: "voluntary", reviewClock: null, publication: null },
    ] },
    attributedOrders: { definition: "creator-attributed-retained-units.v1", coverage: "complete", orders: {
      scope, window: { start: "2026-11-02", end: "2026-11-08", timezone: weekly.timezone }, feeds: [
        { ...feed, channel: "shopify", feedRef: "TEST-SHOPIFY",
          orders: [order("TEST-A1", "shopify", 2), order("TEST-A2-REFUNDED", "shopify", 0), order("TEST-B1", "shopify", 1, "utm")] },
        { ...feed, channel: "tiktokShop", feedRef: "TEST-TIKTOK", orders: [order("TEST-B2", "tiktokShop", 1)] },
      ],
    }, assignments: [{ canonicalOrderId: "TEST-A1", collaborationId }, { canonicalOrderId: "TEST-A1", collaborationId },
      { canonicalOrderId: "TEST-A2-REFUNDED", collaborationId },
      { canonicalOrderId: "TEST-B1", collaborationId: b }, { canonicalOrderId: "TEST-B2", collaborationId: b }] },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(configured = true, dashboardOrigin: string | null = origin) {
  const directory = mkdtempSync(join(tmpdir(), "farda-creator-handoff-"));
  const source = createReportingSourceFixture(scope, now), data = weeklySource();
  const options: AgentServerOptions = {
    databasePath: join(directory, "agent.sqlite"), workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => source.now },
    actionFoundation: { reporting: { token: machineToken, workerRef: source.machine.workerRef, source: source.source,
      assertCurrent: () => source.machine.assertCurrent(),
      ...(configured ? { creatorFeed: { producerRef: producer, destination, controlledSandbox: true, dashboardOrigin,
        async readWeeklyFacts(request, context) {
          context.assertCurrent();
          expect(request).toEqual({ scope, window: weekly, sourceVersion: data.sourceVersion });
          return data;
        },
      } } : {}),
    } },
  };
  async function start() {
    const app = createAgentServer(options);
    await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
    return app;
  }
  let app = await start();
  cleanups.push(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  async function post(path: string, body: unknown, token = machineToken) {
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing controlled fixture port");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/reports/${path}`, {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const accept = (locator: ReportLocator, key = locator.eventRef + ":" + locator.eventVersion) => post("accept", { locator, idempotencyKey: key });
  async function run(locator: ReportLocator) {
    const queued = reportReadSchema.parse((await accept(locator)).body);
    return reportReadSchema.parse((await post("work", { reportRef: queued.reportRef })).body);
  }
  return { source, data, accept, post, run, async reopen() { await app.close(); app = await start(); } };
}

describe("creator handoff feed through the authenticated reporting route", () => {
  it("reconciles the original root after restart and replays one complete, ordered TEST collaboration thread", async () => {
    const f = await fixture(), locators = journey.map((fact, index) => f.source.add(snapshot(index + 1, fact)));
    expect(await f.accept(locators[2]!)).toMatchObject({ status: 409, body: { code: "REPORT_HANDOFF_PREDECESSOR_PENDING" } });
    const root = reportReadSchema.parse((await f.accept(locators[0]!)).body);
    f.source.state.mode = "lostAck";
    expect((await f.post("work", { reportRef: root.reportRef })).body.executionCertainty).toBe("uncertain");
    await f.reopen();
    f.source.state.sendAllowed = false;
    const applied = reportReadSchema.parse((await f.post("reconcile", { reportRef: root.reportRef })).body);
    expect(applied).toMatchObject({ executionCertainty: "applied", sourceEffect: "internalReport", grantsBusinessAuthority: false });
    const firstKey = f.source.state.calls[0]!.requestKey;
    expect(f.source.state.lookups.map(value => value.requestKey)).toEqual([firstKey]);
    expect(f.source.state.calls).toHaveLength(1);
    f.source.state.sendAllowed = true;
    f.source.state.mode = "applied";
    for (const locator of locators.slice(1)) {
      const delivered = await f.run(locator);
      expect(delivered.receipt?.threadRef).toBe(applied.receipt?.threadRef);
      expect((await f.accept(locator, "TEST-REPLAY-" + locator.eventRef)).body.reportRef).toBe(delivered.reportRef);
    }
    const messages = f.source.state.calls;
    expect(messages).toHaveLength(6);
    expect(messages[0]?.threadTs).toBeNull();
    expect(new Set(messages.slice(1).map(message => message.threadTs)).size).toBe(1);
    for (const [index, message] of messages.entries()) {
      expect(message.body).toContain(occurrence[index]);
      expect(message.body).toContain("TEST creator handoff · " + collaborationId);
      expect(message.body).toContain(dashboardLink);
      expect(message.body).not.toContain("TEST-TRACK-DELIVERED-A");
    }
    expect(messages[4]?.body).toContain("No-post review reached");
    expect(messages[4]?.body).toContain("<@USYNTHETIC>");
    expect(messages[5]?.body).toContain("Post went live · TikTok");
    expect(await f.accept(f.source.add(snapshot(6, journey[5], occurrence[5], "changed-source-v2"))))
      .toMatchObject({ status: 409, body: { code: "REPORT_HANDOFF_VERSION_CHANGED" } });
  });

  it("requires authoritative sample delivery and an exact clock, and reports shipping exceptions without starting it", async () => {
    const f = await fixture();
    for (const sequence of [1, 2, 3]) await f.run(f.source.add(snapshot(sequence)));
    const observed = snapshot(4);
    for (const change of [{ purpose: "customerOrder" }, { status: "labelCreated" }, { source: "manual" }, { customerAddress: "TEST private address" }]) {
      expect(reportEventSchema.safeParse({ ...observed.event, creatorHandoff: { ...journey[3], ...change } }).success).toBe(false);
    }
    const lost = snapshot(4, { ...proof, ...firstSample, kind: "sampleException", receiptRef: "TEST-LOST-A",
      basisReceiptRef: "TEST-TRACK-IN-TRANSIT-A", status: "lost" });
    await f.run(f.source.add(lost));
    expect(f.source.state.calls.at(-1)?.body).toContain("Shippo lost");
    expect(f.source.state.calls.at(-1)?.body).not.toContain("Review after");
    const pending = snapshot(5, { ...proof, kind: "noPostReview", receiptRef: "TEST-NO-POST-A",
      basisReceiptRef: "TEST-LOST-A", clock, absence: "completeSourceRead" });
    expect(await f.accept(f.source.add(pending))).toMatchObject({ status: 409, body: { code: "REPORT_HANDOFF_BASIS_MISMATCH" } });
    expect(f.source.state.calls).toHaveLength(4);
  });

  it("holds unconfigured, wrong-destination and unverified source links before a Slack grant", async () => {
    const unbound = await fixture(false);
    expect(await unbound.accept(unbound.source.add(snapshot(1)))).toMatchObject({ status: 503, body: { code: "CREATOR_FEED_UNCONFIGURED" } });
    const f = await fixture(), root = snapshot(1);
    expect(await f.accept(f.source.add({ ...root, destination: { ...root.destination, channelId: "COTHER" } })))
      .toMatchObject({ status: 403, body: { code: "CREATOR_FEED_DESTINATION_MISMATCH" } });
    const wrongOrigin = { ...root, event: { ...root.event, creatorHandoff: { ...journey[0]!, dashboardLink: "https://other.example.test/collaborations/" + collaborationId } } };
    expect(await f.accept(f.source.add(wrongOrigin))).toMatchObject({ status: 403, body: { code: "CREATOR_FEED_DESTINATION_MISMATCH" } });
    expect(f.source.state.grantCalls).toBe(0);
  });

  it("uses an authorized test source record when no dashboard sandbox is hosted", async () => {
    const f = await fixture(true, null), root = snapshot(1, { ...journey[0]!, dashboardLink: null });
    expect(await f.accept(f.source.add({ ...root, testProvenance: undefined })))
      .toMatchObject({ status: 403, body: { code: "CREATOR_FEED_DESTINATION_MISMATCH" } });
    expect((await f.run(f.source.add(root))).executionCertainty).toBe("applied");
    expect(f.source.state.calls[0]?.body).toContain("<https://linear.app/synthetic/issue/EXAMPLE-1|Open TEST collaboration evidence>");
    expect(f.source.state.calls[0]?.body).not.toContain("dashboard.example.test");
  });

  it("reconciles a completed Monday cohort, deduplicates attributed orders and keeps incomplete coverage explicit", async () => {
    const f = await fixture(), path = origin + creatorPipelinePath;
    const summary = summarizeCreatorWeek(f.data, weekly, scope, path, now)!;
    expect(summary.posting).toEqual([{ campaignId: "TEST-CAMPAIGN-A", eligible: 2, published: 1 },
      { campaignId: "TEST-CAMPAIGN-B", eligible: 0, published: 0 }]);
    expect(summary.ranked).toEqual([{ collaborationId, retainedUnits: 2 }, { collaborationId: "TEST-COLLAB-B", retainedUnits: 2 }]);
    expect(summary.stages).toContainEqual({ stage: "published", creators: 1 });
    const eventRef = "creator-weekly:" + weekly.reportDate;
    const event = reportEventSchema.parse({ eventRef, eventVersion: f.data.sourceVersion, producerRef: producer,
      occurredAt: at, severity: "info", identity: { kind: "window", windowRef: eventRef,
        cadence: "mondayWeekly", timezone: weekly.timezone, start: weekly.start, end: weekly.end, launchWindowRef: null },
      subject: { kind: "aggregate", category: "creators" }, facts: [{ label: "coverage", value: "complete" }],
      nextAction: "reviewCreator", link: base.event.link, creatorWeekly: summary,
    });
    const locator = f.source.add({ ...envelope, event, delivery: { ...envelope.delivery, notBefore: weekly.scheduledAt } });
    expect((await f.run(locator)).executionCertainty).toBe("applied");
    expect(f.source.state.calls[0]?.body).toContain("TEST-CAMPAIGN-A · 1/2 (50.0%)");
    expect(f.source.state.calls[0]?.body).toContain("TEST-CAMPAIGN-B · 0/0 (N/A)");
    const incomplete = { ...f.data, attributedOrders: { ...f.data.attributedOrders, coverage: "partial" } };
    expect(summarizeCreatorWeek(incomplete, weekly, scope, path, now)).toMatchObject({ ranked: null, posting: summary.posting });
  });
});
