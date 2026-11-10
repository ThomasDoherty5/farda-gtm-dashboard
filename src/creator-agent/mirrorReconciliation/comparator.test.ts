// @vitest-environment node
import { describe, expect, it } from "vitest";
import { operationsControlSourceSchema } from "../operationsControlsSchema.ts";
import { compareMirror, toOperationsControlSlice } from "./comparator.ts";
import {
  checkScheduleSchema, reconciliationComparisonSchema, reconciliationConflictSchema,
  type CheckInput, type CheckSchedule, type ReadCoverage, type ReconciliationRow,
} from "./contract.ts";
import { duePeriods, nextRunAt, periodWindow } from "./schedule.ts";

// All rows, scopes and versions are synthetic.
const schedule: CheckSchedule = checkScheduleSchema.parse({
  checkId: "synthetic-orders-check", version: 1, timezone: "Europe/London", runAt: "03:00", cutoffLagMinutes: 120,
  coverage: { lookbackDays: 3 },
  expectedDatasets: [
    { scope: "synthetic-store-a", grain: "order", amountField: "net-sales", currencies: ["GBP"] },
    { scope: "synthetic-store-a", grain: "shipment", amountField: "label-cost", currencies: ["GBP"] },
  ],
});
const AT = Date.parse("2027-02-12T06:00:00Z");
const DAY = "2027-02-11";
const row = (key: string, amountMinor: number, extra: Partial<ReconciliationRow> = {}): ReconciliationRow =>
  ({ key, scope: "synthetic-store-a", grain: "order", period: DAY, currency: "GBP", amountMinor, read: "complete", ...extra });
const read = (side: ReadCoverage["side"], state: ReadCoverage["state"] = "complete", extra: Partial<ReadCoverage> = {}): ReadCoverage =>
  ({ side, scope: "synthetic-store-a", grain: "order", period: DAY, state, version: `synthetic-${side}-v7`, readAt: "2027-02-12T05:00:00Z", ...extra });
const input = (extra: Partial<CheckInput> = {}): CheckInput => ({
  runId: "synthetic-run-1", checkId: schedule.checkId, scheduleVersion: 1, periods: [DAY],
  coverage: [read("source"), read("mirror")], sourceRows: [], mirrorRows: [], ...extra });
const orders = (result: ReturnType<typeof compareMirror>, currency = "GBP") =>
  result.comparisons.find(c => c.group.scope === "synthetic-store-a" && c.group.grain === "order" && c.group.currency === currency)!;
const envelope = ({ comparisons, conflicts }: { comparisons: unknown[]; conflicts: unknown[] }, coverage: "complete" | "partial" = "complete") => ({
  scope: { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" }, revision: "synthetic-revision-1",
  observedAt: new Date(AT).toISOString(), coverage, roles: [], tasks: [], takeovers: [], permissions: [], reports: [], attribution: [], handoffs: [],
  comparisons, conflicts });

describe("mirror reconciliation comparator", () => {
  it("AC2: matches complete reads on keys, counts and money totals", () => {
    const result = compareMirror(schedule, input({ sourceRows: [row("order-1", 1250), row("order-2", -300)],
      mirrorRows: [row("order-2", -300), row("order-1", 1250)] }), AT);
    const c = orders(result);
    expect(c.outcome).toBe("matched");
    expect(c.comparison).toMatchObject({ grain: "order", currency: "GBP", sourceCount: 2, mirrorCount: 2, coverage: "complete",
      sourceAmount: { minorUnits: 950, currency: "GBP" }, mirrorAmount: { minorUnits: 950, currency: "GBP" },
      period: { startAt: "2027-02-11T00:00:00.000Z", endAt: "2027-02-12T00:00:00.000Z", timezone: "Europe/London" },
      cutoff: "2027-02-12T02:00:00.000Z", observedAt: "2027-02-12T06:00:00.000Z" });
    expect(result.findings).toEqual([]);
    // The shipment dataset was never read, so the run cannot be clean.
    expect(result.outcome).toBe("incomplete");
  });

  it("AC2: keeps scope, grain, period and currency apart and never mixes currencies", () => {
    const result = compareMirror(schedule, input({
      periods: [DAY, "2027-02-10"],
      coverage: [read("source"), read("mirror"), read("source", "complete", { period: "2027-02-10" }), read("mirror", "complete", { period: "2027-02-10" })],
      sourceRows: [row("order-1", 1000), row("order-2", 700, { currency: "EUR" }), row("order-3", 50, { period: "2027-02-10" })],
      mirrorRows: [row("order-1", 1000), row("order-2", 700, { currency: "EUR" }), row("order-3", 50, { period: "2027-02-10" })] }), AT);
    const orderGroups = result.comparisons.filter(c => c.group.grain === "order").map(c => [c.group.period, c.group.currency, c.comparison.sourceAmount]);
    expect(orderGroups).toEqual(expect.arrayContaining([
      [DAY, "GBP", { minorUnits: 1000, currency: "GBP" }], [DAY, "EUR", { minorUnits: 700, currency: "EUR" }],
      ["2027-02-10", "GBP", { minorUnits: 50, currency: "GBP" }]]));
    expect(new Set(result.comparisons.map(c => c.comparison.id)).size).toBe(result.comparisons.length);
    for (const c of result.comparisons) for (const a of [c.comparison.sourceAmount, c.comparison.mirrorAmount]) if (a) expect(a.currency).toBe(c.comparison.currency);
  });

  it("AC3: classifies missing-source, missing-mirror, orphan, duplicate and amount differences", () => {
    const result = compareMirror(schedule, input({
      sourceRows: [row("order-1", 1000), row("order-2", 500), row("order-3", 200), row("order-3", 200)],
      mirrorRows: [row("order-1", 1100), row("order-4", 900), row("order-5", 300), row("order-5", 300),
        row("order-9", 10, { scope: "synthetic-retired-store" })] }), AT);
    const by = (category: string) => result.findings.filter(f => f.conflict.category === category).map(f => ({ key: f.recordKey, side: f.side,
      field: f.conflict.field, source: f.conflict.sourceValue, mirror: f.conflict.mirrorValue, ownership: f.conflict.ownership }));
    expect(by("amount")).toEqual([{ key: "order-1", side: "both", field: "net-sales", ownership: "source",
      source: { kind: "money", minorUnits: 1000, currency: "GBP" }, mirror: { kind: "money", minorUnits: 1100, currency: "GBP" } }]);
    expect(by("missing_mirror").map(f => f.key).sort()).toEqual(["order-2", "order-3"]);
    expect(by("missing_source").map(f => [f.key, f.ownership]).sort()).toEqual([["order-4", "unknown"], ["order-5", "unknown"]].sort());
    expect(by("duplicate").map(f => [f.key, f.side, f.source, f.mirror]).sort()).toEqual([
      ["order-3", "source", { kind: "count", value: 2 }, null], ["order-5", "mirror", null, { kind: "count", value: 2 }]]);
    expect(by("orphan")).toEqual([{ key: "order-9", side: "mirror", field: "record-key", ownership: "unknown",
      source: { kind: "presence", value: "unknown" }, mirror: { kind: "presence", value: "present" } }]);
    expect(orders(result).outcome).toBe("differences");
    const orphanGroup = result.comparisons.find(c => !c.group.expected)!;
    // No source dataset is expected for the orphan's scope, so its source side is unknown rather than zero.
    expect(orphanGroup).toMatchObject({ outcome: "unknown", comparison: { sourceCount: null, sourceAmount: null, coverage: "unknown" } });
    for (const f of result.findings) expect(f.conflict).toMatchObject({ state: "open", repairAllowed: false, receiptRef: null });
  });

  it("AC4: a partial source read raises no missing-source finding and never reports a clean zero", () => {
    const result = compareMirror(schedule, input({ coverage: [read("source", "partial"), read("mirror")],
      mirrorRows: [row("order-1", 400)] }), AT);
    const c = orders(result);
    expect(c.outcome).toBe("incomplete");
    expect(c.comparison).toMatchObject({ coverage: "partial", sourceCount: null, sourceAmount: null, mirrorCount: 1 });
    expect(result.findings).toEqual([]);
    expect(result.outcome).toBe("incomplete");
  });

  it("AC4: a complete mirror still proves a missing-mirror key while the group stays incomplete", () => {
    const result = compareMirror(schedule, input({ coverage: [read("source", "partial"), read("mirror")], sourceRows: [row("order-1", 400)] }), AT);
    expect(result.findings.map(f => f.conflict.category)).toEqual(["missing_mirror"]);
    expect(orders(result).outcome).toBe("incomplete");
  });

  it("AC4: an unread or failed dataset is unknown with null counts and totals", () => {
    const unread = compareMirror(schedule, input({ coverage: [] }), AT);
    expect(orders(unread)).toMatchObject({ outcome: "unknown",
      comparison: { coverage: "unknown", sourceCount: null, mirrorCount: null, sourceAmount: null, mirrorAmount: null, sourceVersion: "source-unread" } });
    const failed = compareMirror(schedule, input({ coverage: [read("source"), read("mirror", "failed")], sourceRows: [row("order-1", 1)] }), AT);
    expect(orders(failed)).toMatchObject({ outcome: "unknown", comparison: { coverage: "failed", mirrorCount: null } });
    expect(failed.findings).toEqual([]);
  });

  it("AC4: a complete read that finished before the cutoff is treated as partial", () => {
    const early = compareMirror(schedule, input({ coverage: [read("source", "complete", { readAt: "2027-02-12T01:59:00Z" }), read("mirror")] }), AT);
    expect(orders(early)).toMatchObject({ outcome: "incomplete", comparison: { coverage: "partial", sourceCount: null } });
  });

  it("AC4: a partially read row keeps the count known but the total unknown", () => {
    const result = compareMirror(schedule, input({ sourceRows: [row("order-1", 100, { read: "partial" })], mirrorRows: [row("order-1", 999)] }), AT);
    expect(orders(result)).toMatchObject({ outcome: "incomplete",
      comparison: { coverage: "partial", sourceCount: 1, mirrorCount: 1, sourceAmount: null, mirrorAmount: { minorUnits: 999 } } });
    expect(result.findings).toEqual([]);
  });

  it("reports a known zero only when both sides were read completely", () => {
    const both = { coverage: [read("source"), read("mirror"), read("source", "complete", { grain: "shipment" }), read("mirror", "complete", { grain: "shipment" })] };
    const result = compareMirror(schedule, input(both), AT);
    expect(result.outcome).toBe("matched");
    expect(orders(result).comparison).toMatchObject({ sourceCount: 0, mirrorCount: 0, sourceAmount: { minorUnits: 0 }, mirrorAmount: { minorUnits: 0 } });
  });

  it("produces output that parses with the operations-control comparison and conflict schemas and a source snapshot", () => {
    const result = compareMirror(schedule, input({ coverage: [read("source"), read("mirror", "partial")],
      sourceRows: [row("order-1", 1000), row("order-1", 1000)], mirrorRows: [row("order-2", 5), row("order-7", 1, { scope: "synthetic-retired-store" })] }), AT);
    expect(result.findings.length).toBeGreaterThan(0);
    for (const c of result.comparisons) expect(reconciliationComparisonSchema.safeParse(c.comparison).success).toBe(true);
    for (const f of result.findings) expect(reconciliationConflictSchema.safeParse(f.conflict).success).toBe(true);
    const slice = toOperationsControlSlice(result);
    expect(slice.truncated).toBe(false);
    expect(operationsControlSourceSchema.safeParse(envelope(slice)).error?.issues).toBeUndefined();
    expect(JSON.stringify(slice)).not.toContain("order-1");
  });

  it("caps a snapshot slice at the schema limit and flags it as truncated", () => {
    const sourceRows = Array.from({ length: 120 }, (_, i) => row(`order-${i}`, i));
    const result = compareMirror(schedule, input({ sourceRows }), AT);
    expect(result.findings).toHaveLength(120);
    const slice = toOperationsControlSlice(result);
    expect(slice).toMatchObject({ truncated: true });
    expect(slice.conflicts).toHaveLength(100);
    expect(operationsControlSourceSchema.safeParse(envelope(slice, "partial")).error?.issues).toBeUndefined();
  });

  it("gives identical findings the same fingerprint and conflict id on every run", () => {
    const data = { sourceRows: [row("order-1", 1000)], mirrorRows: [row("order-1", 900)] };
    const first = compareMirror(schedule, input(data), AT), second = compareMirror(schedule, input({ ...data, runId: "synthetic-run-2" }), AT + 3_600_000);
    expect(second.findings.map(f => [f.fingerprint, f.conflict.id])).toEqual(first.findings.map(f => [f.fingerprint, f.conflict.id]));
    expect(second.comparisons.map(c => c.comparison.id)).toEqual(first.comparisons.map(c => c.comparison.id));
    const changed = compareMirror(schedule, input({ ...data, mirrorRows: [row("order-1", 800)] }), AT);
    expect(changed.findings[0]!.fingerprint).not.toBe(first.findings[0]!.fingerprint);
  });

  it("refuses periods before their cutoff, stale schedules, rows outside the run and unexpected source datasets", () => {
    expect(() => compareMirror(schedule, input(), Date.parse("2027-02-12T01:59:00Z"))).toThrow("PERIOD_NOT_DUE");
    expect(() => compareMirror(schedule, input({ scheduleVersion: 2 }), AT)).toThrow("STALE_SCHEDULE_VERSION");
    expect(() => compareMirror(schedule, input({ checkId: "synthetic-other" }), AT)).toThrow("CHECK_SCHEDULE_MISMATCH");
    expect(() => compareMirror(schedule, input({ sourceRows: [row("order-1", 1, { period: "2027-02-09" })] }), AT)).toThrow("ROW_PERIOD_OUTSIDE_RUN");
    expect(() => compareMirror(schedule, input({ sourceRows: [row("order-1", 1, { scope: "synthetic-other" })] }), AT)).toThrow("SOURCE_DATASET_NOT_EXPECTED");
    expect(() => compareMirror(schedule, input({ coverage: [read("source", "complete", { readAt: "2027-02-12T07:00:00Z" })] }), AT)).toThrow("READ_IN_FUTURE");
    expect(() => compareMirror(schedule, input({ sourceRows: [row("order-1", 1.5)] }), AT)).toThrow("INVALID_CHECK_INPUT");
    expect(() => compareMirror(schedule, input({ sourceRows: [row("order-1", Number.MAX_SAFE_INTEGER), row("order-2", 1)] }), AT)).toThrow("AMOUNT_TOTAL_UNSAFE");
  });
});

describe("AC1: check schedule record", () => {
  it("validates timezone, cutoff, coverage and expected datasets", () => {
    expect(schedule.expectedDatasets).toHaveLength(2);
    expect(checkScheduleSchema.safeParse({ ...schedule, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(checkScheduleSchema.safeParse({ ...schedule, expectedDatasets: [] }).success).toBe(false);
    expect(checkScheduleSchema.safeParse({ ...schedule, expectedDatasets: [schedule.expectedDatasets[0], schedule.expectedDatasets[0]] }).success).toBe(false);
    expect(checkScheduleSchema.safeParse({ ...schedule, coverage: { lookbackDays: 0 } }).success).toBe(false);
  });

  it("derives local-day periods, cutoffs and due periods in the schedule timezone, across a DST change", () => {
    // Europe/London springs forward on 2027-03-28, a 23-hour day.
    const w = periodWindow(schedule, "2027-03-28");
    expect([new Date(w.startAt).toISOString(), new Date(w.endAt).toISOString(), new Date(w.cutoff).toISOString()])
      .toEqual(["2027-03-28T00:00:00.000Z", "2027-03-28T23:00:00.000Z", "2027-03-29T01:00:00.000Z"]);
    expect(duePeriods(schedule, Date.parse("2027-03-29T00:59:00Z"))).toEqual(["2027-03-25", "2027-03-26", "2027-03-27"]);
    expect(duePeriods(schedule, Date.parse("2027-03-29T01:00:00Z"))).toEqual(["2027-03-26", "2027-03-27", "2027-03-28"]);
    expect(new Date(nextRunAt(schedule, Date.parse("2027-03-29T01:00:00Z"))).toISOString()).toBe("2027-03-29T02:00:00.000Z");
    const tokyo = { ...schedule, timezone: "Asia/Tokyo" };
    expect(new Date(periodWindow(tokyo, DAY).startAt).toISOString()).toBe("2027-02-10T15:00:00.000Z");
  });
});
