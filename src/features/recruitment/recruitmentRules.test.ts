import { checkAffiliateTerms, checkCommission, checkCreator, checkDeliveryWindow, checkExpiry, checkProduct, checkSample, checkSampleAllocation, checkStart, isDeliveryUnset, parsePacific, percentOf } from "./recruitmentRules";

const message = (c: { ok: boolean; error?: string }) => (c.ok ? "ok" : c.error);

describe("affiliate terms", () => {
  it("accepts the illustrative draft, with $0 upfront", () => {
    expect(checkAffiliateTerms("Draft 15% · $0 upfront", 30)).toEqual({ ok: true });
    expect(percentOf("Draft 15% · $0 upfront")).toBe(15);
    expect(percentOf("12.5% per sale")).toBe(12.5);
  });
  it("needs a rate, within the program's limit", () => {
    expect(message(checkAffiliateTerms("Draft · $0 upfront", 30))).toMatch(/Enter a per-sale rate/);
    expect(message(checkAffiliateTerms("0%", 30))).toMatch(/above 0%/);
    expect(message(checkAffiliateTerms("45%", 30))).toMatch(/at most 30%/);
  });
  it("refuses an upfront or guaranteed fee, in either word order", () => {
    expect(message(checkAffiliateTerms("15% · $150 upfront", 30))).toMatch(/no upfront or guaranteed fee/);
    expect(message(checkAffiliateTerms("15% plus guaranteed $50", 30))).toMatch(/no upfront or guaranteed fee/);
    expect(checkAffiliateTerms("15% · $0 guaranteed", 30)).toEqual({ ok: true });
  });
});

describe("sample allocation and delivery window", () => {
  it("takes whole units only, one sample per creator at most", () => {
    expect(checkSampleAllocation("1 creator · 1 sample")).toEqual({ ok: true });
    expect(checkSampleAllocation("3 creators, 2 samples")).toEqual({ ok: true });
    expect(message(checkSampleAllocation("1 creator · 1.5 samples"))).toMatch(/whole units/);
    expect(message(checkSampleAllocation("1 creator · 2 samples"))).toMatch(/One sample per creator/);
  });
  it("leaves an unknown window unset and never invents a date", () => {
    expect(isDeliveryUnset("Confirm in the source thread")).toBe(true);
    expect(isDeliveryUnset("")).toBe(true);
    expect(isDeliveryUnset("2026-11-10 to 2026-11-20")).toBe(false);
    expect(checkDeliveryWindow("Confirm in the source thread")).toEqual({ ok: true });
    expect(checkDeliveryWindow("2026-11-10 to 2026-11-20")).toEqual({ ok: true });
    expect(message(checkDeliveryWindow("next week"))).toMatch(/YYYY-MM-DD/);
    expect(message(checkDeliveryWindow("2026-11-20 to 2026-11-10"))).toMatch(/must not end before/);
  });
});

describe("invitation timestamps", () => {
  it("reads Pacific time, with daylight saving", () => {
    expect(parsePacific("2026-11-10 09:00 PT")).toBe("2026-11-10T17:00:00.000Z");
    expect(parsePacific("2026-07-10 09:00 PT")).toBe("2026-07-10T16:00:00.000Z");
  });
  it("rejects a malformed or impossible time", () => {
    expect(parsePacific("Set before approval")).toBeNull();
    expect(parsePacific("2026-02-30 09:00 PT")).toBeNull();
    expect(parsePacific("2026-11-10 25:00 PT")).toBeNull();
    expect(parsePacific("2026-11-10 09:00")).toBeNull();
  });
  it("needs an exact start", () => {
    expect(checkStart("2026-11-10 09:00 PT")).toEqual({ ok: true });
    expect(message(checkStart(""))).toMatch(/exact start/);
  });
  it("needs an end after the start, within the program's limit, and says seven days is only a proposal", () => {
    const start = "2026-11-10 09:00 PT";
    expect(checkExpiry("2026-11-17 09:00 PT", start, 30)).toEqual({ ok: true });
    expect(message(checkExpiry("7-day validity · proposed", start, 30))).toMatch(/only a proposal/);
    expect(message(checkExpiry("2026-11-17 09:00 PT", "", 30))).toMatch(/Set the start first/);
    expect(message(checkExpiry("2026-11-10 09:00 PT", start, 30))).toMatch(/after it starts/);
    expect(message(checkExpiry("2026-12-31 09:00 PT", start, 30))).toMatch(/at most 30 days/);
  });
});

describe("creator, product, commission and sample", () => {
  const creators = [{ handle: "@studio.rae", suppression: "clear" }, { handle: "@blocked.one", suppression: "suppressed" }];
  it("resolves a creator only by the exact handle", () => {
    expect(checkCreator("@studio.rae", creators)).toEqual({ ok: true });
    expect(checkCreator("  @STUDIO.RAE ", creators)).toEqual({ ok: true });
    expect(message(checkCreator("@studio.rae2", creators))).toMatch(/exact handle/);
    expect(message(checkCreator("@blocked.one", creators))).toMatch(/suppressed/);
  });
  it("matches an exact product", () => {
    expect(checkProduct("Farda bottle + companion app", [{ name: "Farda bottle + companion app" }])).toEqual({ ok: true });
    expect(message(checkProduct("Farda bottle", [{ name: "Farda bottle + companion app" }]))).toMatch(/exact provider product/);
  });
  it("takes a per-sale commission and refuses a fee", () => {
    expect(checkCommission("12% · illustrative proposal", 30)).toEqual({ ok: true });
    expect(message(checkCommission("12% plus flat fee", 30))).toMatch(/no upfront or guaranteed fee/);
    expect(message(checkCommission("Proposal", 30))).toMatch(/per-sale rate/);
  });
  it("keeps the sample a separate approval", () => {
    expect(checkSample("Free sample · separate approval")).toEqual({ ok: true });
    expect(checkSample("No sample")).toEqual({ ok: true });
    expect(message(checkSample("Two free samples"))).toMatch(/Free sample/);
  });
});
