import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { renderRoute } from "@/test/renderWithAdapter";
import { attributionDemo, paidMediaDemo, type AttributionData, type PaidMediaData } from "@/fixtures/analytics";
import { metricDictionaryDemo } from "@/fixtures/headlineMetrics";

function render(data: AttributionData | PaidMediaData, path: string) {
  const adapter = createLiveAdapter("sandbox", { transport: { async send(req) {
    if (req.kind !== "read") throw new Error("Unexpected source mutation");
    return respondWith(req.envelope, req.envelope.viewKey === "metricDictionary" ? metricDictionaryDemo : data, { dataVersion: "synthetic-source-case" });
  } } });
  renderRoute(path, adapter);
}
function source(): AttributionData {
  return { ...structuredClone(attributionDemo), datasetKey: "attribution-observed",
    headlineEvidence: { ...structuredClone(attributionDemo.headlineEvidence), source: "source", sourceRef: "synthetic:period-ledger" } };
}
describe("headline source records through the live adapter", () => {
  it("holds conflicting obligations, shows signed contribution and exposes the refund revision and diagnostics", async () => {
    const user = userEvent.setup();
    const d = source(), e = d.headlineEvidence!;
    d.contribution = { ...d.contribution, value: { currency: "USD", minorUnits: -925 } }; d.orders = { ...d.orders, value: 1 };
    e.refundRevision = "synthetic:refund-v2";
    e.costs.push({ ...e.costs[0]!, evidenceId: "synthetic:second-receipt", minorUnits: 600000 });
    render(d, "/analytics/attribution");
    expect(await screen.findByTestId("metric-cac")).toHaveTextContent("N/A"); expect(screen.getByTestId("metric-mer")).toHaveTextContent("N/A");
    expect(screen.getByText(/Contribution \/ order/).closest("div")).toHaveTextContent("-$9.25");
    await user.click(screen.getByRole("button", { name: "Metric definitions" }));
    const period = await screen.findByTestId("period-economic-evidence");
    expect(period).toHaveTextContent("obligation amount conflict"); expect(period).toHaveTextContent("synthetic:refund-v2");
    expect(period).toHaveTextContent("Source record"); expect(period).toHaveTextContent("Linked cash receipts Unknown");
  });
  it("holds unknown customer counts, distinguishes known zero, and renders empty receipt history", async () => {
    const d = source(); d.newRetainedCustomers = null; d.weeks = []; d.attribution = [];
    d.marketingSpend = null; d.headlineEvidence!.costs = [];
    render(d, "/analytics/attribution");
    expect(await screen.findByTestId("metric-cac")).toHaveTextContent("N/A"); expect(screen.getByTestId("metric-mer")).toHaveTextContent("N/A");
    expect(screen.getByText("Weekly receipt observations unavailable.")).toBeInTheDocument();
  });
  it("reports a sourced per-platform window and a known-zero ROAS without assigning another platform’s value", async () => {
    const user = userEvent.setup();
    const d: PaidMediaData = { ...structuredClone(paidMediaDemo), datasetKey: "paid-media-observed" };
    d.channels[0]!.platformPurchaseValue = { currency: "USD", minorUnits: 0 };
    d.channels[0]!.attributionWindow = { label: "7-day click", sourceRef: "synthetic:platform-report" };
    d.channels[1]!.platformPurchaseValue = null;
    render(d, "/analytics/paid-media");
    expect(await screen.findByText("0.00×")).toBeInTheDocument(); expect(screen.getByText(/Meta \$0 \(7-day click\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open ad source" }));
    expect(within(screen.getByText("Ad source", { selector: "h2" }).closest("dialog")!).getByText("7-day click · synthetic:platform-report")).toBeInTheDocument();
  });
  it("rejects a foreign-currency platform numerator before rendering a ratio", async () => {
    const d: PaidMediaData = structuredClone(paidMediaDemo); d.channels[0]!.platformPurchaseValue = { currency: "EUR", minorUnits: 630000 };
    render(d, "/analytics/paid-media");
    expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByTestId("metric-media-spend")).not.toBeInTheDocument();
  });
});
