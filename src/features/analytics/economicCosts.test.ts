import { describe, expect, it } from "vitest";
import { allocateCosts, type CostBucket, type CostScope } from "./economicCosts";
import { aov, blendedCac, contributionPerOrder, periodHeadline } from "./headlineMetrics";
import { attributionDemo, type AttributionData } from "@/fixtures/analytics";

const scope: CostScope = { cohortId: "fixture-all-acquisition", currency: "USD", period: { start: "2026-09-30", end: "2026-10-29", timezone: "America/Los_Angeles" }, coverage: "complete" };
const event = (overrides: Partial<CostBucket> = {}): CostBucket => ({ key: "commission", cohortId: scope.cohortId, label: "Synthetic earned commission", obligationId: "synthetic:commission-A",
  evidenceId: "synthetic:commission-accrual", currency: "USD", period: scope.period, basis: "accrued", minorUnits: 1750, alsoInCash: false, cashId: null, ...overrides });

describe("economic-event allocation", () => {
  it("counts an explicitly linked accrual and its paid receipt once in economic cost and once in cash", () => {
    const accrued = event(), paid = event({ evidenceId: "synthetic:payment-A", basis: "paid", alsoInCash: true, cashId: "synthetic:settlement-A" });
    const gift = event({ key: "gift", evidenceId: "synthetic:gift-COGS", obligationId: "synthetic:gift-A", basis: "estimated", minorUnits: 800 });
    const result = allocateCosts([paid, gift, accrued, paid], scope);
    expect(result).toMatchObject({ state: "provisional", totalMinor: 2550, cashPaidMinor: 1750, byBasis: { paid: 1750, accrued: 0, estimated: 800 },
      duplicates: ["synthetic:payment-A"], diagnostics: [] });
    expect(allocateCosts([paid, accrued, gift, paid].reverse(), scope)).toEqual(result);
  });
  it("preserves distinct obligations in the same bucket/amount instead of guessing identity from similarity", () => {
    const first = event(), second = event({ obligationId: "synthetic:commission-B", evidenceId: "synthetic:second-accrual" });
    expect(allocateCosts([first, second], scope)).toMatchObject({ totalMinor: 3500, cashPaidMinor: 0, state: "known" });
  });
  it.each([
    ["obligation amount", event({ evidenceId: "synthetic:new-evidence", minorUnits: 1800 }), "OBLIGATION_AMOUNT_CONFLICT"],
    ["evidence identity", event({ obligationId: "synthetic:commission-B" }), "EVIDENCE_CONFLICT"],
    ["mixed currency", event({ currency: "EUR" }), "CURRENCY_MISMATCH"],
    ["invalid currency", event({ currency: "ZZZ" }), "INVALID_CURRENCY"],
    ["foreign cohort", event({ cohortId: "synthetic-other-cohort" }), "COST_COHORT_MISMATCH"],
    ["different timezone", event({ period: { ...scope.period, timezone: "UTC" } }), "REPORTING_WINDOW_MISMATCH"],
    ["mixed periods", event({ period: { start: "2026-10-01", end: "2026-10-29", timezone: "America/Los_Angeles" } }), "REPORTING_WINDOW_MISMATCH"],
    ["invalid date", event({ period: { start: "2026-02-30", end: "2026-10-29", timezone: "America/Los_Angeles" } }), "INVALID_REPORTING_WINDOW"],
    ["missing identity", event({ obligationId: undefined }), "MISSING_OBLIGATION_OR_EVIDENCE_ID"],
    ["missing cash identity", event({ basis: "paid", alsoInCash: true }), "CASH_IDENTITY_UNRESOLVED"],
    ["unverified cash amount", event({ basis: "estimated", alsoInCash: true, cashId: "synthetic:cash" }), "ESTIMATED_CASH_UNVERIFIED"],
    ["unknown amount", event({ minorUnits: null }), "UNKNOWN_OR_INVALID_AMOUNT"],
  ] as const)("holds %s conflicts in either source order", (_label, bad, issue) => {
    const rows = [event(), bad, bad], result = allocateCosts(rows, scope);
    expect(result.state).toBe("unresolved"); expect(result.totalMinor).toBeNull(); expect(result.cashPaidMinor).toBeNull();
    expect(result.diagnostics).toContain(issue);
    expect(allocateCosts([...rows].reverse(), scope)).toEqual(result);
  });
  it("refuses ambiguous settlement ownership and unallocated partial/multiple payments", () => {
    const a = event({ basis: "paid", alsoInCash: true, cashId: "synthetic:cash", evidenceId: "synthetic:A" });
    expect(allocateCosts([a, {...a, evidenceId: "synthetic:B", obligationId: "synthetic:other" }], scope).diagnostics).toContain("CASH_ALLOCATION_CONFLICT");
    expect(allocateCosts([a, {...a, evidenceId: "synthetic:B", cashId: "synthetic:second-cash" }], scope).diagnostics).toContain("MULTIPLE_SETTLEMENTS_UNRECONCILED");
  });
  it("preserves evidenced zero and refuses to infer zero from missing rows, partial coverage or unsafe totals", () => {
    expect(allocateCosts([], scope).totalMinor).toBeNull();
    expect(allocateCosts([event()]).totalMinor).toBeNull();
    expect(allocateCosts([event({ minorUnits: 0 })], scope).totalMinor).toBe(0);
    expect(allocateCosts([event()], {...scope, coverage: "partial"}).totalMinor).toBeNull();
    expect(allocateCosts([event({ minorUnits: Number.MAX_SAFE_INTEGER }), event({ evidenceId: "synthetic:another", obligationId: "synthetic:other" })], scope).diagnostics).toContain("AMOUNT_OUT_OF_RANGE");
  });
});
describe("cohort-bound headlines", () => {
  it.each(["obligationId", "evidenceId", "cashId"] as const)("holds padded %s rather than counting distinct cost or cash", field => {
    const first = event({ basis: "paid", cashId: "cash-1" });
    const padded = { ...first, evidenceId: "second-observation", [field]: first[field] + " " };
    for (const rows of [[first, padded], [padded, first]]) {
      expect(allocateCosts(rows, scope)).toMatchObject({ totalMinor: null, cashPaidMinor: null, diagnostics: ["INVALID_ECONOMIC_IDENTITY"] });
    }
  });
  it.each(["reportScope", "receiptScope", "retainedCustomerScope"] as const)("unbound %s only permits independently scoped metrics", field => {
    const data: AttributionData = structuredClone(attributionDemo);
    delete data[field];
    const result = periodHeadline(data);
    expect(result.cac.value !== null).toBe(field === "receiptScope");
    expect(result.mer.value !== null).toBe(field === "retainedCustomerScope");
  });
  it.each(["cohort", "window", "timezone", "currency", "dataset"] as const)("checks observation %s independently for each numerator or denominator", difference => {
    const data: AttributionData = structuredClone(attributionDemo);
    const receipt = data.receiptScope!;
    const alter = (binding: typeof receipt) => {
      switch (difference) {
        case "cohort": binding.cohortId = "different-cohort"; break;
        case "window": binding.period = { ...binding.period, start: "2026-10-01" }; break;
        case "timezone": binding.period = { ...binding.period, timezone: "UTC" }; break;
        case "currency": binding.currency = "EUR"; break;
        case "dataset": binding.source = "source"; break;
      }
    };
    alter(receipt);
    expect(periodHeadline(data).mer.value).toBeNull();
    expect(periodHeadline(data).cac.value).toBe(2500);
    alter(data.retainedCustomerScope!);
    expect(periodHeadline(data).cac.value).toBeNull();
  });
  it("retains the signed refund loss and rejects fractional customer/order denominators", () => {
    expect(contributionPerOrder(-925, 1)).toMatchObject({ state: "known", value: -925 });
    expect(aov(1200, 1.5).value).toBeNull(); expect(blendedCac(1200, 1.5).value).toBeNull();
  });
  it("holds legacy source amounts without cost evidence, and preserves every observed state separately", () => {
    const data: AttributionData = structuredClone(attributionDemo); data.datasetKey = "attribution-observed";
    expect(periodHeadline(data).diagnostics).toContain("SOURCE_DATASET_MISMATCH");
    delete data.headlineEvidence;
    expect(periodHeadline(data).cac.value).toBeNull();
    for (const scope of [data.reportScope, data.receiptScope, data.retainedCustomerScope]) scope!.source = "source";
    data.headlineEvidence = { ...structuredClone(attributionDemo.headlineEvidence), source: "source", retention: "immature", landedCost: "incomplete" };
    expect(periodHeadline(data).cac).toMatchObject({ state: "provisional", value: 2500, reasonCode: "RETENTION_IMMATURE" });
    expect(periodHeadline(data).mer).toMatchObject({ state: "provisional", reasonCode: "LANDED_COST_INCOMPLETE" });
    data.headlineEvidence.retention = "unknown";
    expect(periodHeadline(data).cac.value).toBeNull();
    data.headlineEvidence.cohortWindow = { start: "2026-10-01", end: "2026-10-29", timezone: "America/Los_Angeles" };
    expect(periodHeadline(data)).toMatchObject({ cost: null, diagnostics: ["COHORT_SCOPE_MISMATCH"] });
  });
});
