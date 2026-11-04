import { describe, expect, it } from "vitest";
import { freshnessStateOf, staleReasonText, type SourceFreshness } from "./freshness";

const ref = { source: "s", accountId: "a", sourceId: null, canonicalId: null, url: null, identityState: "resolved" as const, provenanceRef: "p" };
const entry = (over: Partial<SourceFreshness> = {}): SourceFreshness => ({ sourceRef: ref, lastSourceSuccessAt: "2026-11-04T10:00:00.000Z", observedAt: null, mirroredAt: null, staleReasonCode: null, ...over });

describe("freshnessStateOf (D-13)", () => {
  it("uses the server's explicit state over anything it could derive", () => {
    expect(freshnessStateOf(entry({ freshnessState: "noChange", staleReasonCode: "SOURCE_SYNC_DELAYED" }))).toBe("noChange");
    expect(freshnessStateOf(entry({ freshnessState: "partial", lastSourceSuccessAt: null }))).toBe("partial");
  });
  it("falls back to the reason-code mapping when the field is absent", () => {
    expect(freshnessStateOf(entry())).toBe("current");
    expect(freshnessStateOf(entry({ staleReasonCode: "SOURCE_SYNC_DELAYED" }))).toBe("error");
    expect(freshnessStateOf(entry({ lastSourceSuccessAt: null }))).toBe("neverSynced");
  });
  it("gives no verdict for no entry, and never guesses partial or noChange", () => {
    expect(freshnessStateOf(undefined)).toBeNull();
    for (const e of [entry(), entry({ staleReasonCode: "X" }), entry({ lastSourceSuccessAt: null })]) expect(["partial", "noChange"]).not.toContain(freshnessStateOf(e));
  });
});

describe("staleReasonText", () => {
  it("leads with the reason code, then with what the state says, then admits it is unknown", () => {
    expect(staleReasonText(entry({ staleReasonCode: "SOURCE_SYNC_DELAYED" }))).toBe("SOURCE_SYNC_DELAYED");
    expect(staleReasonText(entry({ lastSourceSuccessAt: null }))).toMatch(/never synced/);
    expect(staleReasonText(entry({ freshnessState: "error" }))).toMatch(/failed/);
    expect(staleReasonText(undefined)).toBe("Reason unknown");
  });
});
