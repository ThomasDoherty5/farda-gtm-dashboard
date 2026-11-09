// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import { trafficDaySchema, trafficFiltersSchema, trafficReportSchema, trafficWindowSchema } from "./contract.ts";
import { parseTrafficReport } from "./parser.ts";
import { siteTrafficFixture, trafficTestRef } from "./fixtures.testkit.ts";
import { createSiteTrafficService } from "./service.ts";

const open: ReturnType<typeof siteTrafficFixture>[] = [];
const fixture = () => { const value = siteTrafficFixture(); open.push(value); return value; };
afterEach(() => { for (const value of open.splice(0)) value.close(); });
const seed = (w: ReturnType<typeof siteTrafficFixture>) => w.service.importSource(w.input, w.machine, w.caller);
const read = (w: ReturnType<typeof siteTrafficFixture>) => w.service.read(w.filters, w.principal);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("traffic normalized source and publication boundaries", () => {
  it.each([
    { startDay: "2026-03-08", endDayExclusive: "2026-03-09", timezone: "America/Los_Angeles", startAt: "2026-03-08T08:00:00Z", endAt: "2026-03-09T07:00:00Z", hours: 23 },
    { startDay: "2026-11-01", endDayExclusive: "2026-11-02", timezone: "America/Los_Angeles", startAt: "2026-11-01T07:00:00Z", endAt: "2026-11-02T08:00:00Z", hours: 25 },
  ])("preserves the source-calendar $hours-hour daylight-saving day", async ({ hours, ...window }) => {
    expect(trafficWindowSchema.parse(window)).toEqual(window);
    expect((Date.parse(window.endAt) - Date.parse(window.startAt)) / 3600000).toBe(hours);
    const w = fixture(), day = w.state.report.partitions[0]!;
    Object.assign(day, { day: window.startDay, startAt: window.startAt, endAt: window.endAt, observedThrough: window.endAt, sourceAsOf: window.endAt });
    w.state.now = Date.parse(window.endAt) + 3600000;
    await seed(w); const result = await read(w); expect(result.data.period).toEqual(window); expect(result.data.rates.storeOrderConversion.percent).toBe(1.625);
    expect(trafficWindowSchema.safeParse({ ...window, startAt: window.startDay + "T00:00:00Z" }).success).toBe(false);
  });
  it.each(["2026-02-30", "2026-13-01", "not-a-date"])("rejects malformed day %s without date-parser exceptions", value => {
    expect(trafficDaySchema.safeParse(value).success).toBe(false);
    expect(trafficFiltersSchema.safeParse({ period: { startDay: value, endDayExclusive: "2026-11-09", timezone: "America/Los_Angeles" }, segment: { kind: "all" } }).success).toBe(false);
  });
  it("rejects unknown timezones and exact midnight substitution", () => {
    expect(trafficWindowSchema.safeParse({ startDay: "2026-11-08", endDayExclusive: "2026-11-09", timezone: "Invented/Zone", startAt: "2026-11-08T08:00:00Z", endAt: "2026-11-09T08:00:00Z" }).success).toBe(false);
    const w = fixture(); const report = structuredClone(w.state.report); report.partitions[0]!.startAt = "2026-11-08T00:00:00Z";
    expect(trafficReportSchema.safeParse(report).success).toBe(false);
  });
  it("accepts equivalent ISO instants for complete coverage", async () => {
    const w = fixture(); w.state.report.partitions[0]!.observedThrough = "2026-11-09T08:00:00.000Z";
    await seed(w); const result = await read(w); expect(result.data.coverage.state).toBe("complete"); expect(result.data.rates.storeOrderConversion.provisional).toBe(false);
  });
  it.each(["health-condition", "person@example.invalid", "+15555550199", "https://example.invalid/?email=private"])("rejects sensitive/free-text segment material %s before any aggregate write", async value => {
    const w = fixture(), report = structuredClone(w.state.report) as unknown as { partitions: Array<{ rows: Array<{ segment: Record<string, unknown> }> }> };
    report.partitions[0]!.rows[1]!.segment.campaign = value; w.state.rawBody = JSON.stringify(report);
    await expect(seed(w)).rejects.toMatchObject({ code: "TRAFFIC_REPORT_INVALID", status: 422 });
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_rows").get()?.n).toBe(0);
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_imports").get()?.n).toBe(0);
  });
  it("rejects user-level/extra fields, duplicate day/segment, unsupported raw CSV and oversized UTF-8 input", () => {
    const w = fixture(), report = w.state.report;
    expect(() => parseTrafficReport(JSON.stringify({ ...report, customerId: "private-customer" }))).toThrow("TRAFFIC_REPORT_INVALID");
    expect(() => parseTrafficReport(JSON.stringify({ ...report, partitions: [report.partitions[0], report.partitions[0]] }))).toThrow("TRAFFIC_REPORT_INVALID");
    const duplicate = structuredClone(report); duplicate.partitions[0]!.rows.push(duplicate.partitions[0]!.rows[0]!);
    expect(() => parseTrafficReport(JSON.stringify(duplicate))).toThrow("TRAFFIC_REPORT_INVALID");
    expect(() => parseTrafficReport("day,sessions\n2026-11-08,16000")).toThrow("TRAFFIC_REPORT_INVALID");
    expect(() => parseTrafficReport("é".repeat(500001))).toThrow("TRAFFIC_REPORT_TOO_LARGE");
  });
  it("rejects a future source-as-of and incompatible unique-session cohort atomically", async () => {
    const w = fixture(); w.state.report.partitions[0]!.sourceAsOf = new Date(w.state.now + 1).toISOString();
    await expect(seed(w)).rejects.toMatchObject({ code: "TRAFFIC_REPORT_FUTURE", status: 422 });
    w.state.report.partitions[0]!.sourceAsOf = "2026-11-09T08:00:00Z"; w.state.report.partitions[0]!.sessionCohortRef = trafficTestRef("different-cohort");
    await expect(seed(w)).rejects.toMatchObject({ code: "TRAFFIC_REPORT_INVALID" });
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_rows").get()?.n).toBe(0);
  });
  it("does not let a reused definition version silently change metric/filter material", async () => {
    const w = fixture(); await seed(w); w.state.report.definition.filterHash = digest("different-report-filter");
    await expect(read(w)).rejects.toMatchObject({ code: "TRAFFIC_DEFINITION_VERSION_REUSED" });
    await expect(w.service.importSource({ ...w.input, requestKey: trafficTestRef("different-request") }, w.machine, w.caller)).rejects.toMatchObject({ code: "TRAFFIC_DEFINITION_VERSION_REUSED" });
  });
  it("fences an initially empty read when a conflicting first definition import commits during the click await", async () => {
    const w = fixture(), originalSourceVersion = w.state.sourceVersion, originalPermissionVersion = w.state.permissionVersion;
    w.state.beforeClicks = async () => {
      // Deliberately malformed owner: material changes without a definition or authority version change.
      w.state.report.definition.filterHash = digest("conflicting-first-import-filter");
      await seed(w);
    };
    await expect(read(w)).rejects.toMatchObject({ code: "TRAFFIC_DEFINITION_VERSION_REUSED" });
    expect(w.state.sourceVersion).toBe(originalSourceVersion); expect(w.state.permissionVersion).toBe(originalPermissionVersion);
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_imports").get()?.n).toBe(1);
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_rows").get()?.n).toBe(2);
  });
  it("keeps a missing day unknown rather than summing a partial window into a complete total", async () => {
    const w = fixture(); await seed(w);
    w.state.capabilityTransform = value => ({ ...value, currentWindow: { ...value.currentWindow!, endDayExclusive: "2026-11-10", endAt: "2026-11-10T08:00:00Z" } });
    const result = await read(w);
    expect(result.data.coverage).toMatchObject({ state: "partial", expectedDays: 2, observedDays: 1 });
    expect(result.data.measures.sessions).toMatchObject({ state: "unknown", value: null });
    expect(result.data.rates.storeOrderConversion.percent).toBeNull();
  });
  it("keeps a missing compatible stage counter N/A and rejects a mismatched click account/window", async () => {
    const w = fixture(); w.state.report.partitions[0]!.rows[0]!.counters.cartSessions = null; await seed(w);
    w.state.clicksTransform = value => ({ ...value, request: { ...value.request, sourceAccountRef: trafficTestRef("other-store") } });
    const result = await read(w);
    expect(result.data.rates.addToCart).toMatchObject({ state: "unknown", percent: null, reasonCodes: ["COUNTER_UNAVAILABLE"] });
    expect(result.data.clickComparison).toMatchObject({ state: "unknown", creatorClicks: { value: null }, reasonCodes: ["CLICK_WINDOW_MISMATCH"] });
    expect(result.data.rates.storeOrderConversion.percent).toBe(1.625);
  });
  it("rejects unique-session subsets larger than their cohort without forcing event/product counters into that hierarchy", () => {
    const w = fixture(); expect(trafficReportSchema.safeParse(w.state.report).success).toBe(true);
    w.state.report.partitions[0]!.rows[0]!.counters.completedCheckoutSessions = 401;
    expect(trafficReportSchema.safeParse(w.state.report).success).toBe(false);
    w.state.report.partitions[0]!.rows[0]!.counters.completedCheckoutSessions = 160;
    w.state.report.partitions[0]!.rows[0]!.counters.cartSessions = 16001;
    expect(trafficReportSchema.safeParse(w.state.report).success).toBe(false);
  });
  it("retains old counts as stale and withholds rates; a read cannot outlive its metric freshness deadline", async () => {
    const w = fixture(); w.state.report.definition.freshnessMaxAgeMs = 4 * 3600000 + 1000; await seed(w);
    const result = await read(w); w.state.now += 1000;
    expect(() => result.assertCurrent()).toThrow("TRAFFIC_PUBLICATION_EXPIRED");
    const stale = await read(w); expect(stale.data.freshness.state).toBe("stale"); expect(stale.data.measures.sessions.value).toBe(16000);
    expect(stale.data.rates.storeOrderConversion).toMatchObject({ state: "unknown", percent: null, reasonCodes: ["SOURCE_STALE"] });
  });
  it("never commits an import whose machine/source permission is revoked during a source await", async () => {
    const w = fixture(), entered = deferred(), release = deferred();
    w.state.beforeReport = async () => { entered.resolve(); await release.promise; };
    const request = seed(w); await entered.promise; w.state.machineDenied = true; release.resolve();
    await expect(request).rejects.toMatchObject({ status: 403 });
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_rows").get()?.n).toBe(0);
  });
  it("bounds a hung owner and never publishes its late result", async () => {
    const w = fixture(), release = deferred(); w.state.beforeCapability = () => release.promise;
    const service = createSiteTrafficService({ db: w.store.database, ...w.bindings, timeoutMs: 5 });
    await expect(service.read(w.filters, w.principal)).rejects.toMatchObject({ code: "SOURCE_READ_TIMEOUT", status: 504 });
    release.resolve(); expect(w.state.importReads).toBe(0);
  });
  it("cancels a pending report import without a partial row or receipt commit", async () => {
    const w = fixture(), entered = deferred(), release = deferred(), controller = new AbortController();
    w.state.beforeReport = async () => { entered.resolve(); await release.promise; };
    const request = w.service.importSource(w.input, w.machine, { ...w.caller, signal: controller.signal });
    await entered.promise; controller.abort();
    await expect(request).rejects.toMatchObject({ code: "REQUEST_CANCELLED", status: 499 }); release.resolve();
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_rows").get()?.n).toBe(0);
  });
  it("rejects a cross-account response or missing synchronous source fence", async () => {
    const w = fixture(); w.state.capabilityTransform = value => ({ ...value, authority: { ...value.authority, binding: { ...value.authority.binding, scope: { ...value.authority.binding.scope, accountId: "different-account" } } } });
    await expect(read(w)).rejects.toMatchObject({ code: "TRAFFIC_SOURCE_BINDING_DENIED", status: 403 });
    w.state.capabilityTransform = null; w.source.assertCurrent = undefined as never;
    await expect(read(w)).rejects.toMatchObject({ code: "TRAFFIC_SOURCE_FENCE_UNAVAILABLE" });
  });
});
