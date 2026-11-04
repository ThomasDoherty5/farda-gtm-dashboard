import type { ReadResponse } from "@/adapter/contract";
import { HEALTH_LABEL, classifySource, isHealthy, overallHealth, sourceLabel, watermarkText } from "./freshness";

type Entry = ReadResponse<unknown>["sourceFreshness"][number];
const ref = (source: string) => ({ source, accountId: "a", sourceId: null, canonicalId: null, url: null, identityState: "resolved" as const, provenanceRef: "p" });
const entry = (source: string, o: Partial<Omit<Entry, "sourceRef">> = {}): Entry => ({ sourceRef: ref(source), lastSourceSuccessAt: "2026-11-02T17:00:00.000Z", observedAt: "2026-11-02T17:00:00.000Z", mirroredAt: null, staleReasonCode: null, ...o });
const fmt = (iso: string) => `@${iso.slice(0, 10)}`;

describe("source freshness states (GTM275-07)", () => {
  it("a source with a recent success and no code is current", () => {
    expect(classifySource(entry("shopify"))).toBe("current");
  });

  it("never synced is a source with no successful sync on record, not a zero and not a failure", () => {
    const e = entry("ad-platforms", { lastSourceSuccessAt: null, observedAt: null });
    expect(classifySource(e)).toBe("never-synced");
    expect(watermarkText(e, fmt)).toMatch(/No successful sync yet.*not zero/);
  });

  it("no change is a successful check that found nothing new, apart from never synced and from error", () => {
    const e = entry("tiktok-shop", { lastSourceSuccessAt: "2026-11-02T09:00:00.000Z", staleReasonCode: "SOURCE_NO_CHANGE" });
    expect(classifySource(e)).toBe("no-change");
    expect(isHealthy("no-change")).toBe(true);
    expect(watermarkText(e, fmt)).toBe("Checked @2026-11-02; nothing new since @2026-11-02.");
  });

  it("partial and stale are not healthy and say what the figures cover", () => {
    expect(classifySource(entry("creator-monitor", { staleReasonCode: "SOURCE_ROWS_DEFERRED" }))).toBe("partial");
    expect(classifySource(entry("creator-monitor", { staleReasonCode: "PARTIAL_COVERAGE" }))).toBe("partial");
    expect(classifySource(entry("shopify", { staleReasonCode: "SOURCE_SYNC_DELAYED" }))).toBe("stale");
    expect(isHealthy("partial")).toBe(false);
    expect(isHealthy("stale")).toBe(false);
  });

  it("an error stops figures at the last success, and a failure with no success is still an error", () => {
    const e = entry("quickbooks", { lastSourceSuccessAt: "2026-10-28T12:00:00.000Z", staleReasonCode: "SOURCE_SYNC_FAILED" });
    expect(classifySource(e)).toBe("error");
    expect(watermarkText(e, fmt)).toBe("The latest attempt failed. Figures stop at the last success, @2026-10-28.");
    const never = entry("quickbooks", { lastSourceSuccessAt: null, observedAt: null, staleReasonCode: "AUTH_EXPIRED" });
    expect(classifySource(never)).toBe("error");
    expect(watermarkText(never, fmt)).toMatch(/no successful sync/);
  });

  it("a code the app does not know is stale, never healthy", () => {
    expect(classifySource(entry("shopify", { staleReasonCode: "SOMETHING_NEW" }))).toBe("stale");
  });

  it("the overall answer is the worst source, whatever order they arrive in", () => {
    const newestHealthy = [entry("shopify"), entry("tiktok-shop", { staleReasonCode: "SOURCE_NO_CHANGE" }), entry("quickbooks", { staleReasonCode: "SOURCE_SYNC_FAILED" })];
    expect(classifySource(newestHealthy[0]!)).toBe("current");
    expect(overallHealth(newestHealthy)).toBe("error");
    expect(overallHealth([...newestHealthy].reverse())).toBe("error");
    expect(overallHealth([entry("a", { staleReasonCode: "SOURCE_NO_CHANGE" }), entry("b")])).toBe("no-change");
    expect(overallHealth([entry("a", { staleReasonCode: "SOURCE_ROWS_DEFERRED" }), entry("b", { lastSourceSuccessAt: null, observedAt: null })])).toBe("never-synced");
    expect(overallHealth([entry("a"), entry("b")])).toBe("current");
  });

  it("no sources reported means no overall answer, not a healthy one", () => {
    expect(overallHealth([])).toBeNull();
  });

  it("every state has its own label, and unknown sources keep their id", () => {
    expect(new Set(Object.values(HEALTH_LABEL)).size).toBe(6);
    expect(sourceLabel("shopify")).toBe("Shopify orders");
    expect(sourceLabel("some-new-source")).toBe("some-new-source");
  });
});
