import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { attributionSchema } from "@/adapter/viewSchemas/analytics";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { renderRoute } from "@/test/renderWithAdapter";
import { attributionDemo, type AttributionData, type MetricObservationScope } from "@/fixtures/analytics";
import { metricDictionaryDemo } from "@/fixtures/headlineMetrics";
import { allocateCosts, type CostBucket } from "./economicCosts";
import { periodHeadline } from "./headlineMetrics";

function observedReport(): AttributionData {
  const data = structuredClone(attributionDemo);
  const period = data.reportScope.period;
  function scoped(sourceRef: string): MetricObservationScope {
    return { source: "source", sourceRef, currency: "USD", cohortId: data.reportScope.cohortId, period: { ...period } };
  }
  return attributionSchema.parse({
    ...data, datasetKey: "attribution-observed", reportScope: scoped("synthetic:report"),
    receiptScope: scoped("synthetic:receipts"), retainedCustomerScope: scoped("synthetic:retained"),
    headlineEvidence: { ...data.headlineEvidence, source: "source", sourceRef: "synthetic:cost-ledger" },
  });
}

describe("headline economic review regressions", () => {
  it("refuses October obligations for a November report even when amounts and customer counts happen to match", () => {
    const data = observedReport();
    expect(periodHeadline(data).cac.value).toBe(2500);
    expect(periodHeadline(data).mer.value).toBeCloseTo(1.7994, 4);
    const november = { start: "2026-11-01", end: "2026-11-30", timezone: "America/Los_Angeles" };
    for (const key of ["reportScope", "receiptScope", "retainedCustomerScope"] as const) {
      data[key] = { ...data[key]!, period: november };
    }
    data.periodLabel = "November 2026";
    const result = periodHeadline(attributionSchema.parse(data));
    expect(result.cac.value).toBeNull();
    expect(result.mer.value).toBeNull();
    expect(result.diagnostics).toContain("COHORT_SCOPE_MISMATCH");
  });

  it("requires separate receipt and customer cohort identities even when their dates are identical", () => {
    const data = observedReport();
    data.receiptScope = { ...data.receiptScope!, cohortId: "other-cohort" };
    const receipts = periodHeadline(attributionSchema.parse(data));
    expect(receipts.cac.value).toBe(2500);
    expect(receipts.mer.value).toBeNull();
    const next = observedReport();
    next.retainedCustomerScope = { ...next.retainedCustomerScope!, cohortId: "other-cohort" };
    const customers = periodHeadline(attributionSchema.parse(next));
    expect(customers.cac.value).toBeNull();
    expect(customers.mer.value).toBeCloseTo(1.7994, 4);
  });

  it.each(["obligationId", "evidenceId", "cashId"] as const)("holds malformed financial identity with padded %s", (field) => {
    const scope = metricDictionaryDemo.allocationScope!;
    const row: CostBucket = {
      key: "synthetic-fee", label: "Synthetic $17.50", basis: "accrued", alsoInCash: false, minorUnits: 1750,
      cohortId: scope.cohortId, period: scope.period, currency: "USD",
      obligationId: "obligation", evidenceId: "original", cashId: null,
    };
    const padded: CostBucket = field === "cashId"
      ? { ...row, basis: "paid", alsoInCash: true, evidenceId: "payment", cashId: "settlement " }
      : { ...row, evidenceId: "second", [field]: row[field] + " " };
    for (const rows of [[row, padded], [padded, row]]) {
      const allocation = allocateCosts(rows, scope);
      expect(allocation).toMatchObject({ state: "unresolved", totalMinor: null, cashPaidMinor: null });
      expect(allocation.diagnostics).toContain("INVALID_ECONOMIC_IDENTITY");
    }
  });

  it("never relabels a reconciled euro dictionary total as US dollars in the definitions dialog", async () => {
    const dictionary = structuredClone(metricDictionaryDemo);
    dictionary.allocationScope = { ...dictionary.allocationScope!, currency: "EUR" };
    dictionary.buckets = dictionary.buckets.map(row => ({ ...row, currency: "EUR" }));
    expect(allocateCosts(dictionary.buckets, dictionary.allocationScope).totalMinor).toBe(700_000);
    const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
      if (request.kind !== "read") throw new Error("Unexpected write");
      return respondWith(request.envelope, request.envelope.viewKey === "metricDictionary" ? dictionary : observedReport(),
        { dataVersion: "synthetic-review-example" });
    } } });
    const user = userEvent.setup();
    renderRoute("/analytics/attribution", adapter);
    await user.click(await screen.findByRole("button", { name: "Metric definitions" }));
    const dialog = await screen.findByTestId("metric-dictionary");
    const total = within(dialog).getByText(/^Illustrative cost allocation/);
    expect(total).not.toHaveTextContent(/\$\s*7,000/);
    expect(total).toHaveTextContent(/EUR|€|unavailable|unsupported|unknown/i);
  });
});
