// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "./config.ts";
import { reportReadSchema } from "./slackReporting/contract.ts";
import { first, second, facts, weeklySnapshotFixture } from "./weeklySnapshots/fixture.testkit.ts";
import { weeklyComparisons } from "./weeklySnapshots/comparison.ts";
import { weeklySnapshotAfterLaunch, weeklySnapshotWindow } from "./weeklySnapshots/schedule.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(controlledSandbox = true) {
  const result = await weeklySnapshotFixture({ controlledSandbox });
  cleanups.push(result.close);
  return result;
}

describe("weekly KPI snapshots through the shared reporting machine", () => {
  it("freezes two weeks, presents hand-calculated deltas and reuses the original delivery and later revision", async () => {
    const f = await fixture();
    const a = reportReadSchema.parse((await f.accept(first.reportDate, "synthetic-week-one")).body);
    expect(f.event(first.reportDate).weeklySnapshot?.priorVersion).toBeNull();
    expect((await f.post("work", { reportRef: a.reportRef })).body.executionCertainty).toBe("applied");
    expect(f.reporting.state.calls[0]!.body).toContain("Net receipts USD 80.00 · prior N/A");

    f.reporting.advance(Date.parse(second.scheduledAt) - Date.parse(first.scheduledAt));
    const b = reportReadSchema.parse((await f.accept(second.reportDate, "synthetic-week-two")).body);
    const weekly = f.event(second.reportDate).weeklySnapshot!;
    const net = weekly.snapshot.measures.findIndex(measure => measure.metric === "netReceipts");
    expect(weekly.comparisons[net]).toEqual({ prior: { difference: 2000, percentBasisPoints: 2500 },
      forecast: { difference: 1000, percentBasisPoints: 1111 } });
    f.reporting.state.mode = "lostAck";
    expect((await f.post("work", { reportRef: b.reportRef })).body.executionCertainty).toBe("uncertain");
    expect((await f.post("reconcile", { reportRef: b.reportRef })).body.executionCertainty).toBe("applied");
    const text = f.reporting.state.calls[1]!.body;
    expect(text).toContain("Net receipts USD 100.00 · prior +USD 20.00 (+25%) · plan +USD 10.00 (+11.11%)");
    expect(text.match(/Source snapshot>/g)).toHaveLength(6);
    expect(text).not.toContain("synthetic-source-private");
    const weeks = await f.trend();
    expect(weeks.map(week => [week.snapshotVersion, ...week.channels.map(channel => channel.netReceipts.value?.minorUnits)]))
      .toEqual([["v1", 6000, 2000], ["v1", 7500, 2500]]);

    const prior = f.records.get(second.reportDate)!;
    const revised = { ...facts(second, 9600), version: "v2", sourceVersion: "synthetic-verified-source-v2",
      capturedAt: new Date(f.reporting.now).toISOString(),
      correction: { priorVersion: "v1", priorDigest: digest(prior), receiptRef: "synthetic-refund-correction" } };
    f.corrections.set("synthetic-refund-correction", revised);
    const source = f.app.actionFoundation.weeklySnapshots!;
    const received = await source.observeCorrection(second.reportDate, "synthetic-refund-correction", f.reporting.machine.assertCurrent);
    expect(received.facts.version).toBe("v2");
    expect(await source.observeCorrection(second.reportDate, "synthetic-refund-correction", f.reporting.machine.assertCurrent)).toEqual(received);
    expect((await f.trend())[1]?.snapshotVersion).toBeUndefined();
    f.state.secondReceipts = 9600;
    const corrected = (await f.trend())[1];
    expect(corrected?.snapshotVersion).toBe("v2");
    expect(corrected?.channels.map(channel => channel.netReceipts.value?.minorUnits)).toEqual([7200, 2400]);
    expect((await f.accept(second.reportDate, "synthetic-week-two-replay")).body.reportRef).toBe(b.reportRef);
    expect(f.event(second.reportDate).weeklySnapshot?.snapshot.version).toBe("v1");
    expect(f.app.store.database.prepare("SELECT COUNT(*) AS n FROM weekly_kpi_snapshots").get()?.n).toBe(3);
    expect(f.reporting.state.calls).toHaveLength(2);
    expect(f.reads).toEqual([first.reportDate, second.reportDate, "synthetic-refund-correction", "synthetic-refund-correction"]);
  });

  it("holds unknown source values, an unset launch and a revoked source before transport", async () => {
    const native = await fixture(false);
    expect((await native.accept(first.reportDate, "synthetic-unreleased")).body.code).toBe("WEEKLY_LAUNCH_GATE_CLOSED");
    expect(native.reads).toEqual([]);
    const f = await fixture();
    const original = f.records.get(first.reportDate)!;
    f.records.set(first.reportDate, { ...original, coverage: "partial", measures: original.measures.filter(m => m.metric === "retainedUnits") });
    const accepted = reportReadSchema.parse((await f.accept(first.reportDate, "synthetic-partial")).body);
    f.state.sourceAllowed = false;
    expect((await f.post("work", { reportRef: accepted.reportRef })).status).toBe(403);
    expect(f.reporting.state.calls).toHaveLength(0);
    f.state.sourceAllowed = true;
    expect((await f.post("work", { reportRef: accepted.reportRef })).body.executionCertainty).toBe("applied");
    expect(f.reporting.state.calls[0]!.body).toContain("Partial source coverage");
    expect(f.reporting.state.calls[0]!.body).toContain("N/A (source unavailable)");
  });

  it("derives the Pacific report slot and preserves both daylight-saving week lengths", () => {
    expect(first.scheduledAt).toBe("2026-11-02T16:30:00.000Z");
    expect((Date.parse(first.end) - Date.parse(first.start)) / 3_600_000).toBe(169);
    const spring = weeklySnapshotWindow("2026-03-09")!;
    expect((Date.parse(spring.end) - Date.parse(spring.start)) / 3_600_000).toBe(167);
    expect(weeklySnapshotWindow("2026-11-03")).toBeNull();
    expect(weeklySnapshotAfterLaunch(first, "2026-11-02T16:00:00Z")).toBe(false);
    expect(weeklySnapshotAfterLaunch(second, "2026-11-02T16:00:00Z")).toBe(true);
  });

  it("shows an absolute change for a known zero and holds incompatible measures and windows", () => {
    const latest = facts(second, 10_000), prior = facts(first, 0);
    const position = latest.measures.findIndex(measure => measure.metric === "netReceipts");
    expect(weeklyComparisons(latest, prior).comparisons[position]?.prior).toEqual({ difference: 10_000, percentBasisPoints: null });
    prior.measures[position]!.definition = "synthetic-other-net-definition";
    expect(weeklyComparisons(latest, prior).comparisons[position]?.prior).toBeNull();
    expect(weeklyComparisons(latest, latest).priorVersion).toBeNull();
    latest.measures[position]!.forecast!.currency = "EUR";
    expect(weeklyComparisons(latest, prior).comparisons[position]?.forecast).toBeNull();
  });
});
