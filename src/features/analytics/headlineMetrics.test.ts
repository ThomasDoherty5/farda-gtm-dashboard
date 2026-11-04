import { describe, expect, it } from "vitest";
import { attributionDemo, paidMediaDemo } from "@/fixtures/analytics";
import { metricDictionaryDemo as dict } from "@/fixtures/headlineMetrics";
import { overviewOriginal } from "@/fixtures/overview";
import { allocateCosts, aov, blendedCac, evaluateCase, mer, platformRoas } from "./headlineMetrics";

describe("headline metric calculators, hand-checked", () => {
  it("$7,000 / 280 = $25 CAC and $12,596 / $7,000 is about 1.80 MER", () => {
    expect(blendedCac(700_000, 280)).toEqual({ state: "known", value: 2500, reasonCode: null });
    const m = mer(1_259_600, 700_000);
    expect(m.state).toBe("known");
    expect(m.value).toBeCloseTo(1.7994, 4);
    expect(aov(1_259_600, 400).value).toBe(3149);
  });

  it("a zero or unknown denominator is N/A and never zero", () => {
    expect(blendedCac(700_000, 0)).toEqual({ state: "notApplicable", value: null, reasonCode: "ZERO_DENOMINATOR" });
    expect(mer(1_000, 0).state).toBe("notApplicable");
    expect(aov(1_000, null)).toEqual({ state: "notApplicable", value: null, reasonCode: "UNKNOWN_INPUT" });
    expect(blendedCac(null, 280).value).toBeNull();
    expect(platformRoas(480_000, 0).state).toBe("notApplicable");
  });

  it("a known zero numerator stays zero", () => {
    expect(blendedCac(0, 20)).toMatchObject({ state: "known", value: 0 });
    expect(mer(0, 100_000)).toMatchObject({ state: "known", value: 0 });
  });

  it("incomplete landed cost or immature retention make a value provisional, keeping the value", () => {
    expect(blendedCac(700_000, 280, "RETENTION_IMMATURE")).toEqual({ state: "provisional", value: 2500, reasonCode: "RETENTION_IMMATURE" });
    expect(mer(1_259_600, 700_000, "LANDED_COST_INCOMPLETE").state).toBe("provisional");
  });

  it("platform ROAS uses only that platform's value and spend", () => {
    const [meta, tiktok] = paidMediaDemo.channels;
    expect(platformRoas(meta!.platformPurchaseValue.minorUnits, meta!.spend.minorUnits).value).toBeCloseTo(2.1, 10);
    expect(platformRoas(tiktok!.platformPurchaseValue.minorUnits, tiktok!.spend.minorUnits).value).toBeCloseTo(2.4, 10);
    // Summed platform value over summed spend would be a different, blended number that nothing on the page shows.
    expect(platformRoas(11_100_00, 5_000_00).value).not.toBe(platformRoas(meta!.platformPurchaseValue.minorUnits, meta!.spend.minorUnits).value);
  });
});

describe("metric dictionary and cases (headline-metrics-cases)", () => {
  it("is versioned and defines all four headline metrics with every required field", () => {
    expect(dict.version).toBe("headline-metrics@1");
    expect(dict.entries.map((e) => e.key)).toEqual(["aov", "blendedCac", "mer", "platformRoas"]);
    for (const e of dict.entries) {
      for (const f of [e.numerator, e.denominator, e.source, e.currency, e.window, e.costBuckets, e.refundTreatment]) expect(f.trim().length).toBeGreaterThan(0);
    }
    expect(dict.related.map((r) => r.label)).toEqual(["Cost per retained order", "Cost per retained unit"]);
  });

  it("every case computes to its hand-calculated text", () => {
    for (const c of dict.cases) expect(evaluateCase(c.input), c.id).toEqual(c.expected);
  });

  it("covers normal, unknown, zero and refund cases", () => {
    expect(dict.cases.map((c) => c.id)).toEqual(expect.arrayContaining(["normal", "unknown-spend", "known-zero-spend", "zero-customers", "refund"]));
  });

  it("the normal case reconciles to the original fixture without reading it", () => {
    const n = dict.cases.find((c) => c.id === "normal")!.input;
    expect(n.netReceiptsMinor).toBe(overviewOriginal.netReceipts.value!.minorUnits);
    expect(n.acquisitionCostMinor).toBe(overviewOriginal.marketingSpend.minorUnits);
    expect(n.newRetainedCustomers).toBe(overviewOriginal.newRetainedCustomers);
    expect(n.validOrders).toBe(overviewOriginal.orders.value);
    expect(attributionDemo.marketingSpend.minorUnits).toBe(n.acquisitionCostMinor);
  });

  it("allocation: each bucket is counted once, tagged paid or estimated, and reconciles to the $7,000 and to paid media", () => {
    const a = allocateCosts(dict.buckets);
    expect(a.duplicates).toEqual([]);
    expect(a.totalMinor).toBe(overviewOriginal.marketingSpend.minorUnits);
    expect(a.byBasis).toEqual({ paid: 500_000, accrued: 0, estimated: 200_000 });
    expect(a.byBasis.paid).toBe(paidMediaDemo.channels.reduce((s, c) => s + c.spend.minorUnits, 0));
    expect(a.byBasis.estimated).toBe(paidMediaDemo.creatorSampleEconomics.minorUnits);
  });

  it("a repeated bucket is reported as a double count and not added", () => {
    const [media] = dict.buckets;
    const a = allocateCosts([media!, media!]);
    expect(a.duplicates).toEqual(["media"]);
    expect(a.totalMinor).toBe(media!.minorUnits);
  });
});
