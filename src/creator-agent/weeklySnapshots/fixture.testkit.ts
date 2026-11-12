import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../config.ts";
import { createAgentServer } from "../server.ts";
import { nativeAnalyticsFixture } from "../analytics/nativeFixtures.testkit.ts";
import { nativeAttributionSchema } from "../analytics/views.ts";
import { reportEventSchema, ReportError, type ReportSnapshot } from "../slackReporting/contract.ts";
import { createReportingSourceFixture, reportFixture, reportingScope as scope } from "../slackReporting/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../testFixtures.ts";
import { weeklyExpectedMeasures, weeklyFactsSchema, weeklyMetrics, type WeeklyFacts } from "./contract.ts";
import { weeklySnapshotWindow } from "./schedule.ts";
import type { WeeklySnapshotConfig } from "./service.ts";

const machineToken = "synthetic-weekly-report-machine-000000000000";
export const first = weeklySnapshotWindow("2026-11-02")!;
export const second = weeklySnapshotWindow("2026-11-09")!;

export function facts(window: WeeklyFacts["window"], total: number): WeeklyFacts {
  const asOf = new Date(Date.parse(window.scheduledAt) - 60_000).toISOString();
  return weeklyFactsSchema.parse({
    scope, window, version: "v1", sourceVersion: "synthetic-verified-source-v1", capturedAt: asOf,
    coverage: "complete", correction: null,
    rankings: { collaborations: [{ rank: 1, label: "a123456789ab" }], postsByViews: [], postsByCtr: [] },
    mediaDecisions: [{ stage: "stageOne", state: "held", dueAt: null, sourceVersion: "synthetic-stage-v1" }],
    measures: weeklyExpectedMeasures.map(({ metric, dimension }) => {
      const [, , unit] = weeklyMetrics[metric];
      let amount = 0;
      if (metric === "netReceipts") amount = total;
      if (metric === "channelReceipts") amount = dimension === "shopify" ? total * 3 / 4 : total / 4;
      if (metric === "maturePostingEligible") amount = 4;
      if (metric === "maturePostingVerified") amount = 2;
      if (metric === "maturePostingRate") amount = 5000;
      if (metric === "averageRating") amount = 440;
      const actual = { amount, coverage: "complete", asOf, sourceRef: "synthetic-source-private", sourceVersion: "source-v1",
        currency: unit === "money" ? "USD" : null, decimals: unit === "money" ? 2 : null };
      const forecast = metric === "netReceipts"
        ? { ...actual, amount: 9000, asOf: window.start, scenario: "synthetic-plan", definition: "canonical-net-v1" } : null;
      return { metric, dimension, actual, forecast, definition: "canonical-net-v1" };
    }),
  });
}

export async function weeklySnapshotFixture({ controlledSandbox = true, port = 0 } = {}) {
  const clock = Date.parse(first.scheduledAt) + 60_000;
  const reporting = createReportingSourceFixture(scope, clock);
  const route = reportFixture(clock);
  const records = new Map([[first.reportDate, facts(first, 8000)], [second.reportDate, facts(second, 10_000)]]);
  const corrections = new Map<string, WeeklyFacts>();
  const reads: string[] = [];
  const state = { sourceAllowed: true, secondReceipts: 10_000 };
  const analytics = nativeAnalyticsFixture({ scope, now: () => reporting.now });
  analytics.state.mutate = snapshot => {
    if (snapshot.viewKey !== "attribution" || !snapshot.facts.orders) return;
    snapshot.cohortRef = null;
    for (const owner of snapshot.owners) {
      owner.cohortRef = null;
      if (owner.owner === "commerceOrders") owner.definitionVersion = "canonical-net-v1";
    }
    snapshot.facts.economics = null;
    snapshot.facts.ads = null;
    for (const feed of snapshot.facts.orders.snapshot.feeds) {
      const prototype = feed.orders[0]!;
      feed.orders = [first, second].map((window, index) => {
        const gross = index === 0 ? 8000 : state.secondReceipts;
        return { ...prototype, orderRef: `synthetic-${feed.channel}-weekly-${index}`, canonicalOrderId: `canonical-${feed.channel}-weekly-${index}`,
          placedAt: new Date(Date.parse(window.start) + 3_600_000).toISOString(), netReceiptsMinor: feed.channel === "shopify" ? gross * 3 / 4 : gross / 4 };
      });
    }
  };
  const config: WeeklySnapshotConfig = {
    producerRef: "producer:synthetic-weekly-kpis", controlledSandbox,
    policy: { version: route.programme.version, adoptionRef: route.programme.adoptionRef, approvedLaunchAt: null },
    destination: { targetRef: route.destination.targetRef, workspaceId: route.destination.workspaceId, channelId: route.destination.channelId },
    link: route.event.link,
    sectionLinks: {
      headline: "https://linear.app/synthetic/issue/EXAMPLE-1", channels: "https://linear.app/synthetic/issue/EXAMPLE-2",
      creators: "https://linear.app/synthetic/issue/EXAMPLE-3", content: "https://linear.app/synthetic/issue/EXAMPLE-4",
      cashMedia: "https://linear.app/synthetic/issue/EXAMPLE-5", support: "https://linear.app/synthetic/issue/EXAMPLE-6",
    },
    source: {
      async read(request, context) {
        context.assertCurrent();
        if (digest(request.scope) !== digest(scope)) throw new Error("Synthetic source scope changed");
        reads.push(request.correctionRef ?? request.window.reportDate);
        return request.correctionRef ? corrections.get(request.correctionRef) : records.get(request.window.reportDate);
      },
      assertCurrent(evidence) {
        const known = evidence.correction ? corrections.get(evidence.correction.receiptRef) : records.get(evidence.window.reportDate);
        if (!state.sourceAllowed || digest(known) !== digest(evidence)) throw new ReportError("WEEKLY_PERMISSION_DENIED", 403);
      },
    },
    async readDelivery(event, context) {
      context.assertCurrent();
      const base = reportFixture(reporting.now);
      const snapshot: ReportSnapshot = {
        ...base, event, programme: { ...base.programme, permittedProducers: [config.producerRef] },
        testProvenance: { kind: "controlledSandbox", evidenceRef: "evidence:synthetic-weekly" },
        delivery: { ...base.delivery, notBefore: event.weeklySnapshot!.snapshot.window.scheduledAt },
      };
      reporting.add(snapshot);
      return snapshot;
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "farda-weekly-kpi-"));
  const app = createAgentServer({
    databasePath: join(dir, "agent.sqlite"), workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => reporting.now },
    analyticsSource: analytics.source,
    actionFoundation: { reporting: {
      token: machineToken, workerRef: reporting.machine.workerRef, source: reporting.source, weeklySnapshots: config,
      assertCurrent() { reporting.machine.assertCurrent(); },
    } },
  });
  const close = async () => {
    try { await app.close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const origin = "http://127.0.0.1:" + address.port;
  async function post(action: string, body: unknown, token = machineToken) {
    const response = await fetch(origin + "/v1/reports/" + action, {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const accept = (date: string, key: string) => post("accept", {
    locator: { eventRef: "weekly-kpi:" + date, eventVersion: config.policy.version }, idempotencyKey: key,
  });
  const event = (date: string) => reportEventSchema.parse(JSON.parse(String(
    app.store.database.prepare("SELECT event FROM weekly_kpi_prereads WHERE event_ref=?").get("weekly-kpi:" + date)?.event,
  )));
  async function trend() {
    const response = await fetch(origin + "/v1/read", {
      method: "POST", headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({
        ...analytics.request("attribution"), schemaVersion: "2026-11-02.proposed", operation: "readView", requestId: "synthetic-weekly-trend",
        requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" },
        period: { startAt: first.start, endAt: second.end, timezone: first.timezone, basis: "eventTime" },
      }),
    });
    const body = await response.json() as { data: unknown };
    if (response.status !== 200) throw new Error("Synthetic trend read failed " + JSON.stringify(body));
    return nativeAttributionSchema.parse(body.data).weeks;
  }
  return { app, reporting, records, corrections, reads, state, accept, event, post, trend, close };
}
