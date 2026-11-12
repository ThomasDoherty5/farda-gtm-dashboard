// @vitest-environment node
import { describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import { operationsControlSourceSchema } from "../operationsControlsSchema.ts";
import { compareMirror, toOperationsControlSlice, type CompareOptions } from "./comparator.ts";
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
const SECRET = "synthetic-test-secret-0123456789abcdef";
const compare = (s: CheckSchedule, raw: unknown, at: number, extra: Partial<CompareOptions> = {}) => compareMirror(s, raw, at, { secret: SECRET, ...extra });
const DAY = "2027-02-11";
const row = (key: string, amountMinor: number, extra: Partial<ReconciliationRow> = {}): ReconciliationRow =>
  ({ key, scope: "synthetic-store-a", grain: "order", period: DAY, currency: "GBP", amountMinor, read: "complete", ...extra });
const read = (side: ReadCoverage["side"], state: ReadCoverage["state"] = "complete", extra: Partial<ReadCoverage> = {}): ReadCoverage =>
  ({ side, scope: "synthetic-store-a", grain: "order", period: DAY, state, version: `synthetic-${side}-v7`, readAt: "2027-02-12T05:00:00Z",
    sourceAsOf: state === "complete" ? extra.readAt ?? "2027-02-12T05:00:00Z" : null, ...extra });
const input = (extra: Partial<CheckInput> = {}): CheckInput => ({
  runId: "synthetic-run-1", checkId: schedule.checkId, scheduleVersion: 1, periods: [DAY],
  coverage: [read("source"), read("mirror")], sourceRows: [], mirrorRows: [], ...extra });
const orders = (result: ReturnType<typeof compare>, currency = "GBP") =>
  result.comparisons.find(c => c.group.scope === "synthetic-store-a" && c.group.grain === "order" && c.group.currency === currency)!;
const envelope = ({ comparisons, conflicts }: { comparisons: unknown[]; conflicts: unknown[] }, coverage: "complete" | "partial" = "complete") => ({
  scope: { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" }, revision: "synthetic-revision-1",
  observedAt: new Date(AT).toISOString(), coverage, roles: [], tasks: [], takeovers: [], permissions: [], reports: [], attribution: [], handoffs: [],
  comparisons, conflicts });

describe("mirror reconciliation comparator", () => {
  it("withholds totals when a fresh poll returns a snapshot from before cutoff", () => {
    const result = compare(schedule, input({
      coverage: [read("source", "complete", { sourceAsOf: "2027-02-12T01:59:00Z" }), read("mirror")],
      sourceRows: [row("order-1", 400)], mirrorRows: [row("order-1", 400)],
    }), AT);
    expect(orders(result)).toMatchObject({ outcome: "incomplete", comparison: { sourceCount: null, sourceAmount: null },
      reads: { source: "2027-02-12T01:59:00.000Z", mirror: "2027-02-12T05:00:00.000Z" } });
    expect(result.outcome).toBe("incomplete");
  });

  it("rejects a complete read with no valid source watermark and an impossible calendar period", () => {
    expect(() => compare(schedule, input({ coverage: [read("source", "complete", { sourceAsOf: null })] }), AT)).toThrow("INVALID_CHECK_INPUT");
    expect(() => compare(schedule, input({ coverage: [read("source", "complete", { sourceAsOf: "2027-02-12T05:01:00Z" })] }), AT)).toThrow("INVALID_CHECK_INPUT");
    expect(() => compare(schedule, input({ periods: ["2027-13-01"] }), AT)).toThrow("INVALID_CHECK_INPUT");
  });

  it("AC2: matches complete reads on keys, counts and money totals", () => {
    const result = compare(schedule, input({ sourceRows: [row("order-1", 1250), row("order-2", -300)],
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
    const result = compare(schedule, input({
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
    const result = compare(schedule, input({
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
    const result = compare(schedule, input({ coverage: [read("source", "partial"), read("mirror")],
      mirrorRows: [row("order-1", 400)] }), AT);
    const c = orders(result);
    expect(c.outcome).toBe("incomplete");
    expect(c.comparison).toMatchObject({ coverage: "partial", sourceCount: null, sourceAmount: null, mirrorCount: 1 });
    expect(result.findings).toEqual([]);
    expect(result.outcome).toBe("incomplete");
  });

  it("AC4: a complete mirror still proves a missing-mirror key while the group stays incomplete", () => {
    const result = compare(schedule, input({ coverage: [read("source", "partial"), read("mirror")], sourceRows: [row("order-1", 400)] }), AT);
    expect(result.findings.map(f => f.conflict.category)).toEqual(["missing_mirror"]);
    expect(orders(result).outcome).toBe("incomplete");
  });

  it("AC4: an unread or failed dataset is unknown with null counts and totals", () => {
    const unread = compare(schedule, input({ coverage: [] }), AT);
    expect(orders(unread)).toMatchObject({ outcome: "unknown",
      comparison: { coverage: "unknown", sourceCount: null, mirrorCount: null, sourceAmount: null, mirrorAmount: null, sourceVersion: "source-unread" } });
    const failed = compare(schedule, input({ coverage: [read("source"), read("mirror", "failed")], sourceRows: [row("order-1", 1)] }), AT);
    expect(orders(failed)).toMatchObject({ outcome: "unknown", comparison: { coverage: "failed", mirrorCount: null } });
    expect(failed.findings).toEqual([]);
  });

  it("AC4: a complete read that finished before the cutoff is treated as partial", () => {
    const early = compare(schedule, input({ coverage: [read("source", "complete", { readAt: "2027-02-12T01:59:00Z" }), read("mirror")] }), AT);
    expect(orders(early)).toMatchObject({ outcome: "incomplete", comparison: { coverage: "partial", sourceCount: null } });
  });

  it("AC4: a partially read row keeps the count known but the total unknown", () => {
    const result = compare(schedule, input({ sourceRows: [row("order-1", 100, { read: "partial" })], mirrorRows: [row("order-1", 999)] }), AT);
    expect(orders(result)).toMatchObject({ outcome: "incomplete",
      comparison: { coverage: "partial", sourceCount: 1, mirrorCount: 1, sourceAmount: null, mirrorAmount: { minorUnits: 999 } } });
    expect(result.findings).toEqual([]);
  });

  it("reports a known zero only when both sides were read completely", () => {
    const both = { coverage: [read("source"), read("mirror"), read("source", "complete", { grain: "shipment" }), read("mirror", "complete", { grain: "shipment" })] };
    const result = compare(schedule, input(both), AT);
    expect(result.outcome).toBe("matched");
    expect(orders(result).comparison).toMatchObject({ sourceCount: 0, mirrorCount: 0, sourceAmount: { minorUnits: 0 }, mirrorAmount: { minorUnits: 0 } });
  });

  it("produces output that parses with the operations-control comparison and conflict schemas and a source snapshot", () => {
    const result = compare(schedule, input({ coverage: [read("source"), read("mirror", "partial")],
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
    const result = compare(schedule, input({ sourceRows }), AT);
    expect(result.findings).toHaveLength(120);
    const slice = toOperationsControlSlice(result);
    expect(slice).toMatchObject({ truncated: true });
    expect(slice.conflicts).toHaveLength(100);
    expect(operationsControlSourceSchema.safeParse(envelope(slice, "partial")).error?.issues).toBeUndefined();
  });

  it("keeps the incident identity stable when the value of a discrepancy changes", () => {
    const data = { sourceRows: [row("order-1", 1000)], mirrorRows: [row("order-1", 900)] };
    const first = compare(schedule, input(data), AT), second = compare(schedule, input({ ...data, runId: "synthetic-run-2" }), AT + 3_600_000);
    expect(second.findings.map(f => [f.fingerprint, f.conflict.id])).toEqual(first.findings.map(f => [f.fingerprint, f.conflict.id]));
    expect(second.comparisons.map(c => c.comparison.id)).toEqual(first.comparisons.map(c => c.comparison.id));
    const changed = compare(schedule, input({ ...data, mirrorRows: [row("order-1", 800)] }), AT);
    expect(changed.findings[0]!.fingerprint).toBe(first.findings[0]!.fingerprint);
    expect(changed.findings[0]!.conflict.mirrorValue).toMatchObject({ minorUnits: 800 });
  });

  it("compares count-only datasets without inventing monetary zeros", () => {
    const countSchedule = { ...schedule, expectedDatasets: [{ ...schedule.expectedDatasets[0]!, amountField: null }] };
    const sourceRows = [row("order-1", 1000)].map(value => ({ ...value, amountMinor: null }));
    const result = compare(countSchedule, input({ sourceRows, mirrorRows: sourceRows }), AT);
    expect(result.outcome).toBe("matched");
    expect(orders(result).comparison).toMatchObject({ sourceCount: 1, mirrorCount: 1, sourceAmount: null, mirrorAmount: null });
    expect(compare(schedule, input({ sourceRows, mirrorRows: sourceRows }), AT).outcome).toBe("incomplete");
  });

  it("refuses periods before their cutoff, stale schedules, rows outside the run and unexpected source datasets", () => {
    expect(() => compare(schedule, input(), Date.parse("2027-02-12T01:59:00Z"))).toThrow("PERIOD_NOT_DUE");
    expect(() => compare(schedule, input({ scheduleVersion: 2 }), AT)).toThrow("STALE_SCHEDULE_VERSION");
    expect(() => compare(schedule, input({ checkId: "synthetic-other" }), AT)).toThrow("CHECK_SCHEDULE_MISMATCH");
    expect(() => compare(schedule, input({ sourceRows: [row("order-1", 1, { period: "2027-02-09" })] }), AT)).toThrow("ROW_PERIOD_OUTSIDE_RUN");
    expect(() => compare(schedule, input({ sourceRows: [row("order-1", 1, { scope: "synthetic-other" })] }), AT)).toThrow("SOURCE_DATASET_NOT_EXPECTED");
    expect(() => compare(schedule, input({ coverage: [read("source", "complete", { readAt: "2027-02-12T07:00:00Z" })] }), AT)).toThrow("READ_IN_FUTURE");
    expect(() => compare(schedule, input({ sourceRows: [row("order-1", 1.5)] }), AT)).toThrow("INVALID_CHECK_INPUT");
    expect(() => compareMirror(schedule, input(), AT, { secret: "short" })).toThrow("INVALID_RECONCILIATION_SECRET");
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

describe("mirror reconciliation comparator after review", () => {
  const retired = (key: string, amountMinor = 10) => row(key, amountMinor, { scope: "synthetic-retired-store" });
  const retiredRead = read("mirror", "complete", { scope: "synthetic-retired-store" });

  it("keys public conflict and comparison ids with the server secret, so a record key cannot be recovered from them", () => {
    const data = input({ sourceRows: [row("order-104217", 1000)], mirrorRows: [] });
    const a = compare(schedule, data, AT), again = compare(schedule, { ...data, runId: "synthetic-run-9" }, AT + 60_000);
    const other = compareMirror(schedule, data, AT, { secret: "synthetic-other-secret-fedcba9876543210" });
    const [finding] = a.findings;
    expect(finding!.conflict.id).toMatch(/^mrf-[a-f0-9]{40}$/);
    // Fixed secret: the same id on every run. Another secret: a different id for the same finding.
    expect(again.findings[0]!.conflict.id).toBe(finding!.conflict.id);
    expect(again.comparisons.map(c => c.comparison.id)).toEqual(a.comparisons.map(c => c.comparison.id));
    expect(other.findings[0]!.conflict.id).not.toBe(finding!.conflict.id);
    expect(other.findings[0]!.fingerprint).toBe(finding!.fingerprint);
    // An unkeyed digest over the guessable inputs, the brute-force route, does not reproduce the public id.
    const conflict = finding!.conflict;
    const guesses = ["order-104216", "order-104217", "order-104218"].map(recordKey => digest({ checkId: schedule.checkId, scope: "synthetic-store-a",
      grain: "order", period: DAY, currency: "GBP", recordKey, side: "mirror", category: conflict.category, field: conflict.field }));
    expect(guesses).toContain(finding!.fingerprint);
    for (const guess of guesses) for (const id of [`mrf-${guess.slice(0, 40)}`, `mrf-${digest(guess).slice(0, 40)}`]) expect(id).not.toBe(conflict.id);
    const published = JSON.stringify(toOperationsControlSlice(a));
    expect(published).not.toContain("104217");
    expect(published).not.toContain(finding!.fingerprint.slice(0, 40));
  });

  it("treats an orphan group's source as known empty once the mirror is fully read, so the orphan can clear", () => {
    const o1 = compare(schedule, input({ coverage: [read("source"), read("mirror"), retiredRead], mirrorRows: [retired("X1")] }), AT);
    const orphanGroup = o1.comparisons.find(c => !c.group.expected)!;
    expect(orphanGroup).toMatchObject({ outcome: "differences", comparison: { coverage: "complete", sourceCount: 0, mirrorCount: 1,
      sourceAmount: null, mirrorAmount: null, sourceVersion: "synthetic-orders-check/schedule/v1" } });
    // X1 has been removed: the group is compared again because it has an open finding, and now matches.
    const o2 = compare(schedule, input({ runId: "synthetic-run-2", coverage: [read("source"), read("mirror"), retiredRead] }), AT,
      { openGroups: [orphanGroup.group] });
    expect(o2.comparisons.find(c => c.comparison.id === orphanGroup.comparison.id)).toMatchObject({ outcome: "matched",
      comparison: { sourceCount: 0, mirrorCount: 0 } });
    // Without a mirror read of that scope it stays unknown rather than clean.
    const unread = compare(schedule, input({ runId: "synthetic-run-3" }), AT, { openGroups: [orphanGroup.group] });
    expect(unread.comparisons.find(c => c.comparison.id === orphanGroup.comparison.id)).toMatchObject({ outcome: "unknown",
      comparison: { sourceCount: null, mirrorCount: null } });
  });

  it("compares an open group again only when its period is in the run", () => {
    const eur = { scope: "synthetic-store-a", grain: "order" as const, period: DAY, currency: "EUR" };
    const result = compare(schedule, input(), AT, { openGroups: [eur, { ...eur, period: "2027-02-01" }] });
    expect(result.comparisons.filter(c => c.group.currency === "EUR").map(c => [c.group.period, c.outcome])).toEqual([[DAY, "matched"]]);
  });

  it("gives duplicates in an orphan group unknown ownership", () => {
    const result = compare(schedule, input({ coverage: [read("source"), read("mirror"), retiredRead], mirrorRows: [retired("X1"), retired("X1")] }), AT);
    expect(result.findings.map(f => [f.conflict.category, f.conflict.ownership]).sort()).toEqual([["duplicate", "unknown"], ["orphan", "unknown"]]);
  });

  it("makes an overflowing total unknown and its group incomplete without aborting the run", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const result = compare(schedule, input({ sourceRows: [row("order-1", big), row("order-2", 1)], mirrorRows: [row("order-1", big), row("order-2", 1)],
      coverage: [read("source"), read("mirror"), read("source", "complete", { grain: "shipment" }), read("mirror", "complete", { grain: "shipment" })] }), AT);
    expect(orders(result)).toMatchObject({ outcome: "incomplete", comparison: { coverage: "partial", sourceCount: 2, sourceAmount: null, mirrorAmount: null } });
    expect(result.comparisons.find(c => c.group.grain === "shipment")!.outcome).toBe("matched");
    expect(result.outcome).toBe("incomplete");
  });

  it("reports when each side of a group was read", () => {
    const result = compare(schedule, input({ coverage: [read("source", "complete", { readAt: "2027-02-12T05:30:00+00:00" })] }), AT);
    expect(orders(result).reads).toEqual({ source: "2027-02-12T05:30:00.000Z", mirror: null });
  });

  it("resolves a local midnight that DST skips to the first instant after it, and a repeated one to its first occurrence", () => {
    const at = (tz: string, date: string) => {
      const w = periodWindow({ timezone: tz, cutoffLagMinutes: 0 }, date);
      return [new Date(w.startAt).toISOString(), new Date(w.endAt).toISOString()];
    };
    // America/Santiago skips 00:00-01:00 on 2027-09-05; America/Havana on 2027-03-14 and repeats it on 2027-11-07.
    expect(at("America/Santiago", "2027-09-05")).toEqual(["2027-09-05T04:00:00.000Z", "2027-09-06T03:00:00.000Z"]);
    expect(at("America/Santiago", "2027-09-04")[1]).toBe("2027-09-05T04:00:00.000Z");
    expect(at("America/Havana", "2027-03-14")).toEqual(["2027-03-14T05:00:00.000Z", "2027-03-15T04:00:00.000Z"]);
    expect(at("America/Havana", "2027-03-13")[1]).toBe("2027-03-14T05:00:00.000Z");
    expect(at("America/Havana", "2027-11-07")[0]).toBe("2027-11-07T04:00:00.000Z");
    expect(at("America/Santiago", "2027-04-04")[0]).toBe("2027-04-04T04:00:00.000Z");
    const santiago = { ...schedule, timezone: "America/Santiago", runAt: "00:30" };
    expect(new Date(nextRunAt(santiago, Date.parse("2027-09-05T03:00:00Z"))).toISOString()).toBe("2027-09-05T04:00:00.000Z");
    const result = compare({ ...schedule, timezone: "America/Santiago", cutoffLagMinutes: 0 }, input({ periods: ["2027-09-05"],
      coverage: [read("source", "complete", { period: "2027-09-05", readAt: "2027-09-06T05:00:00Z" })] }), Date.parse("2027-09-06T06:00:00Z"));
    expect(orders(result).comparison.period).toMatchObject({ startAt: "2027-09-05T04:00:00.000Z", endAt: "2027-09-06T03:00:00.000Z" });
  });
});
