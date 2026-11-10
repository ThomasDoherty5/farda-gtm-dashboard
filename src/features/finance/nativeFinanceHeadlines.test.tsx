import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { financeRecord } from "@/creator-agent/finance/fixtures.testkit";
import type { FinanceSummaryContext } from "@/creator-agent/finance/headlines";
import { renderRoute } from "@/test/renderWithAdapter";

afterEach(cleanup);
function open(forecastState: FinanceSummaryContext["forecastState"], policyState: FinanceSummaryContext["policy"]["state"] = "adopted") {
  const data = { ...financeRecord("financeDashboard"), forecastRevenue: 20000,
    readAccess: { validUntil: new Date(Date.now() + 60_000).toISOString() },
    summaryContext: { period: { startAt: "2026-10-01T00:00:00Z", endAt: "2026-10-31T00:00:00Z", timezone: "UTC", basis: "eventTime" },
      source: "quickbooks", currency: "USD", accountingBasis: "accrual",
      policy: { state: policyState, version: "fictional-policy-v1", evidenceRef: "fictional-policy-receipt" },
      cashAsOf: "2026-11-06T11:00:00Z", forecastState } };
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read" || request.envelope.viewKey !== "financeDashboard") throw new Error("Unexpected finance operation");
    return respondWith(request.envelope, data, { dataVersion: "fictional-native-finance-v1", capabilities: [] });
  } } });
  renderRoute("/finance", adapter);
}
describe("native Finance forecast reconciliation", () => {
  it("withholds a missing forecast even if a backing numeric field remains populated", async () => {
    open("missing");
    const cash = await screen.findByTestId("cash");
    expect(within(cash).getByText("$0.1k / N/A")).toBeInTheDocument();
    expect(within(cash).queryByText("$0.1k / $0.2k")).not.toBeInTheDocument();
    expect(within(cash).queryByRole("img", { name: /Revenue actual/ })).not.toBeInTheDocument();
  });
  it("labels a source-approved comparison without a demo forecast claim", async () => {
    open("approved");
    const cash = await screen.findByTestId("cash");
    expect(within(cash).getByText("$0.1k / $0.2k")).toBeInTheDocument();
    expect(within(cash).getByRole("img", { name: "Revenue actual is 50% of the approved forecast" })).toBeInTheDocument();
    expect(within(cash).queryByRole("img", { name: /illustrative forecast/ })).not.toBeInTheDocument();
  });
  it("keeps proposed forecasts separate from approved comparisons", async () => {
    open("proposed");
    const cash = await screen.findByTestId("cash");
    expect(within(cash).getByText("$0.1k / $0.2k")).toBeInTheDocument();
    expect(within(cash).getByText(/Forecast proposed/)).toBeInTheDocument();
    expect(within(cash).queryByRole("img", { name: /Revenue actual/ })).not.toBeInTheDocument();
  });
  it("does not compare actuals and forecasts under an unadopted accounting definition", async () => {
    open("approved", "pending");
    const cash = await screen.findByTestId("cash");
    expect(within(cash).getByText("N/A / N/A")).toBeInTheDocument();
    expect(within(cash).queryByRole("img", { name: /Revenue actual/ })).not.toBeInTheDocument();
  });
});
