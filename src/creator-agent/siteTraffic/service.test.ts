// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest } from "../config.ts";
import { createSiteTrafficService } from "./service.ts";
import { SiteTrafficError } from "./source.ts";
import { nativeSiteTrafficViewSchema } from "./views.ts";
import { siteTrafficFixture, trafficTestRef, trafficTestScope, trafficTestKey } from "./fixtures.testkit.ts";

const open: ReturnType<typeof siteTrafficFixture>[] = [];
const fixture = (options: Parameters<typeof siteTrafficFixture>[0] = {}) => { const value = siteTrafficFixture(options); open.push(value); return value; };
afterEach(() => { for (const value of open.splice(0)) value.close(); });
const seed = (w: ReturnType<typeof siteTrafficFixture>) => w.service.importSource(w.input, w.machine, w.caller);
const second = (w: ReturnType<typeof siteTrafficFixture>, number = 2) => ({ ...w.input, importRef: trafficTestRef(`import-${number}`), requestKey: trafficTestRef(`request-${number}`) });
const read = (w: ReturnType<typeof siteTrafficFixture>) => w.service.read(w.filters, w.principal);

describe("Shopify aggregate traffic owner", () => {
  it("keeps the unconfigured account/calendar/actual import unknown without guessing a store timezone", async () => {
    const w = fixture(), service = createSiteTrafficService({ db: w.store.database, scope: trafficTestScope, referenceKey: trafficTestKey, now: () => w.state.now });
    const result = await service.read(w.filters, w.principal); result.assertCurrent();
    expect(result.data).toMatchObject({ datasetKey: "site-traffic-native", period: null, capability: { state: "unconfigured", accountRef: null, timezone: null }, measures: { sessions: { state: "unknown", value: null } }, imports: { firstActualImport: { state: "pending", receipt: null } } });
    expect(result.data.rates.storeOrderConversion.percent).toBeNull();
    await expect(service.importSource(w.input, w.machine, w.caller)).rejects.toMatchObject({ code: "TRAFFIC_SOURCE_UNCONFIGURED" });
  });
  it("imports a real normalized-report parser fixture and reconciles 260/16000 =1.625%, separately from converted sessions and clicks", async () => {
    const w = fixture(); const imported = await seed(w), result = await read(w); imported.assertCurrent(); result.assertCurrent();
    expect(imported.receipt).toMatchObject({ inserted: 2, replaced: 0, synthetic: true, sourceEffect: "localAggregate" });
    expect(result.data.rates.storeOrderConversion).toMatchObject({ state: "known", percent: 1.625, numerator: 260, denominator: 16000, provisional: false });
    expect(result.data.rates.providerConversion).toMatchObject({ percent: 1, numerator: 160, denominator: 16000 });
    expect(result.data.rates.addToCart.percent).toBe(10); expect(result.data.rates.checkoutCompletion.percent).toBe(40);
    expect(result.data.measures.productViewEvents.value).toBe(3); expect(result.data.measures.cartAddEvents.value).toBe(5000);
    expect(result.data.clickComparison).toMatchObject({ state: "comparable", creatorClicks: { value: 7000 }, storefrontSessions: { value: 16000 } });
    expect(result.data.imports.firstActualImport).toEqual({ state: "pending", receipt: null });
    expect(nativeSiteTrafficViewSchema.safeParse(result.data).success).toBe(true);
    const text = JSON.stringify(result.data); for (const privateValue of [w.machine.principalRef, w.machine.bindingRef, w.input.requestKey, w.state.report.definition.sourceAccountRef, "requestDigest", "grantVersion", "reportDigest"]) expect(text).not.toContain(privateValue);
  });
  it("does not substitute a global 400-order aggregate or TikTok mirror ownership", async () => {
    const w = fixture(); await seed(w);
    w.state.ordersTransform = value => ({ ...value, count: 400, origin: "allCommerce" });
    const result = await read(w);
    expect(result.data.measures.sessions.value).toBe(16000);
    expect(result.data.rates.storeOrderConversion).toMatchObject({ state: "unknown", percent: null, reasonCodes: ["ORDER_COHORT_MISMATCH"] });
  });
  it("makes zero denominators N/A rather than a zero conversion rate", async () => {
    const w = fixture(); Object.assign(w.state.report.partitions[0]!.rows[0]!.counters, { sessions: 0, cartSessions: 0, checkoutSessions: 0, completedCheckoutSessions: 0 });
    await seed(w); const result = await read(w);
    expect(result.data.measures.sessions).toMatchObject({ state: "known", value: 0 });
    expect(result.data.rates.storeOrderConversion).toMatchObject({ state: "notApplicable", percent: null, reasonCodes: ["ZERO_DENOMINATOR"] });
    expect(result.data.rates.checkoutCompletion.state).toBe("notApplicable");
  });
  it("does not duplicate a source file, advances neither source-as-of nor row import time, and replaces a revised day", async () => {
    const w = fixture(); const first = await seed(w); w.state.now += 1000;
    const duplicate = await w.service.importSource(second(w), w.machine, w.caller);
    expect(duplicate.receipt).toMatchObject({ inserted: 0, replaced: 0, unchanged: 2 });
    expect((await read(w)).data.freshness.importedAt).toBe(first.receipt.importedAt);
    expect((await read(w)).data.measures.sessions.value).toBe(16000);
    w.state.report.partitions[0]!.revision = 2; w.state.report.partitions[0]!.rows[0]!.counters.sessions = 20000;
    const revision = await w.service.importSource(second(w, 3), w.machine, w.caller);
    expect(revision.receipt).toMatchObject({ replaced: 2, unchanged: 0 });
    expect((await read(w)).data.measures.sessions.value).toBe(20000);
  });
  it("rejects same revision/different material and older replacement without changing totals", async () => {
    const w = fixture(); await seed(w); w.state.report.partitions[0]!.rows[0]!.counters.sessions = 17000;
    await expect(w.service.importSource(second(w), w.machine, w.caller)).rejects.toMatchObject({ code: "TRAFFIC_REVISION_CONFLICT" });
    expect((await read(w)).data.measures.sessions.value).toBe(16000);
    w.state.report.partitions[0]!.revision = 2; await w.service.importSource(second(w, 3), w.machine, w.caller);
    w.state.report.partitions[0]!.revision = 1; w.state.report.partitions[0]!.rows[0]!.counters.sessions = 16000;
    await expect(w.service.importSource(second(w, 4), w.machine, w.caller)).rejects.toMatchObject({ code: "TRAFFIC_OLDER_REVISION" });
    expect((await read(w)).data.measures.sessions.value).toBe(17000);
  });
  it("recovers the immutable original receipt after restart and a new definition without reading/reimporting the report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traffic-evidence-"));
    try {
      const first = siteTrafficFixture({ databasePath: join(directory, "aggregate.sqlite") });
      const original = await seed(first); first.close();
      const restarted = siteTrafficFixture({ databasePath: join(directory, "aggregate.sqlite") });
      try {
        restarted.state.report.definition.version = digest("fictional-new-definition"); restarted.state.sourceVersion = digest("fictional-new-source-version");
        const recovered = await seed(restarted); recovered.assertCurrent();
        expect(recovered.receipt).toEqual(original.receipt); expect(restarted.state.importReads).toBe(0);
        await expect(restarted.service.importSource({ ...restarted.input, importRef: trafficTestRef("different-file") }, restarted.machine, restarted.caller)).rejects.toMatchObject({ code: "TRAFFIC_IMPORT_KEY_REUSED" });
      } finally { restarted.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("requires current machine permission even for pure original-receipt recovery", async () => {
    const w = fixture(); await seed(w); w.state.machineDenied = true;
    await expect(seed(w)).rejects.toMatchObject({ status: 403 }); expect(w.state.importReads).toBe(1);
    await expect(w.service.importSource(w.input, w.principal as never, w.caller)).rejects.toMatchObject({ code: "TRAFFIC_IMPORT_CALLER_DENIED", status: 403 });
  });
  it("rolls back rows and receipt if the caller grant is revoked at the final transaction fence", async () => {
    const w = fixture();
    await expect(w.service.importSource(w.input, w.machine, { assertCallerCurrent() {
      if (Number(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_imports").get()?.n) > 0) throw new SiteTrafficError("TRAFFIC_IMPORT_CALLER_DENIED", 403);
    } })).rejects.toMatchObject({ code: "TRAFFIC_IMPORT_CALLER_DENIED" });
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_rows").get()?.n).toBe(0);
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_imports").get()?.n).toBe(0);
  });
  it("retains partial-day rates as provisional only for matching observed order coverage", async () => {
    const w = fixture(), day = w.state.report.partitions[0]!;
    day.coverage = "partial"; day.replaceSegments = false; day.observedThrough = "2026-11-08T20:00:00Z";
    await seed(w); expect((await read(w)).data.rates.storeOrderConversion).toMatchObject({ state: "known", percent: 1.625, provisional: true });
    w.state.ordersTransform = value => ({ ...value, coverageThrough: value.request.window.endAt });
    expect((await read(w)).data.rates.storeOrderConversion).toMatchObject({ state: "unknown", percent: null });
  });
  it("does not advance omitted segment coverage or clocks during a partial replacement", async () => {
    const w = fixture(); await seed(w); const before = await read(w), selected = before.data.segments.find(segment => segment.channel === "creator")!;
    const original = await w.service.read({ period: null, segment: { kind: "utm", segmentRef: selected.segmentRef } }, w.principal);
    const partition = w.state.report.partitions[0]!; partition.revision = 2; partition.coverage = "partial"; partition.replaceSegments = false; partition.rows = [partition.rows[0]!]; partition.sourceAsOf = new Date(w.state.now).toISOString();
    await w.service.importSource(second(w), w.machine, w.caller);
    const after = await w.service.read({ period: null, segment: { kind: "utm", segmentRef: selected.segmentRef } }, w.principal);
    expect(after.data.measures.sessions).toMatchObject({ value: 3000, provisional: true }); expect(after.data.coverage.state).toBe("partial");
    expect(after.data.freshness.sourceAsOf).toBe(original.data.freshness.sourceAsOf); expect(after.data.days[0]!.revision).toBe(1);
    expect(after.data.rates.storeOrderConversion.state).toBe("unknown");
    expect(after.data.clickComparison.state).toBe("unknown");
  });
  it("establishes a removed segment zero only from an explicit complete segment replacement", async () => {
    const w = fixture(); await seed(w); const selected = (await read(w)).data.segments.find(segment => segment.channel === "creator")!;
    w.state.report.partitions[0]!.revision = 2; w.state.report.partitions[0]!.rows = [w.state.report.partitions[0]!.rows[0]!];
    const receipt = await w.service.importSource(second(w), w.machine, w.caller); expect(receipt.receipt.removed).toBe(1);
    const result = await w.service.read({ period: null, segment: { kind: "utm", segmentRef: selected.segmentRef } }, w.principal);
    expect(result.data.measures.sessions).toMatchObject({ state: "known", value: 0, provisional: false });
  });
  it("rejects exact requested calendar or opaque segment mismatch", async () => {
    const w = fixture(); await seed(w);
    await expect(w.service.read({ ...w.filters, period: { startDay: "2026-11-08", endDayExclusive: "2026-11-09", timezone: "UTC" } }, w.principal)).rejects.toMatchObject({ code: "TRAFFIC_WINDOW_CHANGED" });
    await expect(w.service.read({ period: null, segment: { kind: "utm", segmentRef: "traffic-segment-" + digest("unapproved") } }, w.principal)).rejects.toMatchObject({ code: "TRAFFIC_SEGMENT_CHANGED" });
  });
  it("rejects source or permission changes during aggregate awaits and after projection", async () => {
    const w = fixture(); await seed(w); w.state.beforeOrders = () => { w.state.denied = true; };
    await expect(read(w)).rejects.toMatchObject({ status: 403 });
    w.state.denied = false; w.state.beforeOrders = null; const result = await read(w);
    w.state.permissionVersion = digest("revoked-permission-version"); expect(() => result.assertCurrent()).toThrow("TRAFFIC_SOURCE_CHANGED");
  });
  it("fences a concurrent import and a source lease crossing before final HTTP publication", async () => {
    const w = fixture(); await seed(w); const result = await read(w);
    w.state.report.partitions[0]!.revision = 2; w.state.report.partitions[0]!.rows[0]!.counters.sessions = 17000;
    await w.service.importSource(second(w), w.machine, w.caller); expect(() => result.assertCurrent()).toThrow("TRAFFIC_IMPORT_CHANGED");
    const current = await read(w); w.state.now += 300_000; expect(() => current.assertCurrent()).toThrow("TRAFFIC_SOURCE_STALE");
  });
  it.each(["promise", "nonvoid"])("rejects a %s final source assertion", async mode => {
    const w = fixture(); w.source.assertCurrent = mode === "promise" ? async () => undefined : () => true as never;
    await expect(read(w)).rejects.toMatchObject({ code: "TRAFFIC_SOURCE_CHANGED" });
  });
  it("keeps unsupported access and missing imports visibly distinct", async () => {
    const w = fixture(); const empty = await read(w); expect(empty.data.coverage.state).toBe("missing"); expect(empty.data.measures.sessions.value).toBeNull();
    w.state.capabilityState = "unsupported"; const unsupported = await read(w);
    expect(unsupported.data.capability).toMatchObject({ state: "unsupported", reasonCodes: ["ACCESS_UNSUPPORTED"], timezone: null });
    expect(unsupported.data.imports.firstActualImport.state).toBe("pending");
  });
  it("keeps blocked/absent-UTM clicks separate and does not claim a fabricated match", async () => {
    const w = fixture(); await seed(w); w.state.clicksTransform = value => ({ ...value, attribution: "blocked", reasonCodes: ["TRACKING_BLOCKED"] });
    const result = await read(w); expect(result.data.clickComparison).toMatchObject({ state: "unknown", attribution: "blocked", reasonCodes: ["TRACKING_BLOCKED"] });
    expect(result.data.measures.sessions.value).toBe(16000); expect(result.data.clickComparison.creatorClicks.value).toBe(7000);
  });
  it.each([401, 403])("preserves a connected owner's %s denial without publishing protected cached data or raw exception text", async status => {
    const w = fixture(); await seed(w);
    w.state.beforeClicks = () => { throw Object.assign(new Error("private-source-detail"), { status }); };
    await expect(read(w)).rejects.toMatchObject({ code: "TRAFFIC_SOURCE_DENIED", status, message: "TRAFFIC_SOURCE_DENIED" });
  });
  it("normalizes an injected owner's arbitrary typed error code instead of exposing private strings", async () => {
    const w = fixture(); w.state.beforeCapability = () => { throw new SiteTrafficError("private@example.invalid", 403); };
    await expect(read(w)).rejects.toMatchObject({ code: "TRAFFIC_SOURCE_UNAVAILABLE", status: 403, message: "TRAFFIC_SOURCE_UNAVAILABLE" });
  });
});
