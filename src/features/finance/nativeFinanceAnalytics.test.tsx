import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { respondWith } from "@/adapter/demoViews";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { financeRecord } from "@/creator-agent/finance/fixtures.testkit";
import type { FinanceSummaryContext } from "@/creator-agent/finance/headlines";
import { renderRoute } from "@/test/renderWithAdapter";

const filters = { startAt: "2026-09-01T07:00:00Z", endAt: "2026-10-01T07:00:00Z", timezone: "America/Los_Angeles" };
const periodQuery = new URLSearchParams({ "report-start": filters.startAt, "report-end": filters.endAt, "report-zone": filters.timezone });
const observedCash = [{ month: "July 2026", minor: -150000 }, { month: "September 2026", minor: 8025000 }];

function open(cashHistory: typeof observedCash, policyState: FinanceSummaryContext["policy"]["state"] = "adopted") {
  const fixture = financeRecord("financeDashboard");
  const summaryContext: FinanceSummaryContext = {
    period: { ...filters, basis: "eventTime" }, source: "quickbooks", currency: "USD", accountingBasis: "cash",
    policy: { state: policyState, version: "synthetic-policy-v1", evidenceRef: "synthetic-policy-receipt" },
    cashAsOf: "2026-11-06T10:00:00.000Z", forecastState: "approved",
  };
  const data = { ...fixture, cashHistory, summaryContext, burn: { ...fixture.cash as object, value: 5000 }, burnHistoryMonths: 3,
    closeSummary: { period: "2026-09", label: "Synthetic September", unmatchedPayouts: 0, cpaSignOff: "Pending" }, payouts: [],
    readAccess: { validUntil: new Date(Date.now() + 60000).toISOString() } };
  const requests: unknown[] = [];
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read" || request.envelope.viewKey !== "financeDashboard") throw new Error("Unexpected finance operation");
    requests.push(request.envelope.filters);
    return respondWith(request.envelope, data, { dataVersion: "synthetic-finance-analytics-v1" });
  } } });
  renderRoute(`/analytics/finance?${periodQuery}&scenario=insufficient`, adapter);
  return requests;
}

afterEach(cleanup);

describe("native Finance Analytics", () => {
  it("keeps the selected source period, close month and observed cash scale", async () => {
    const requests = open(observedCash);
    const cash = await screen.findByTestId("metric-Cash available");
    expect(requests).toEqual([filters]);
    expect(cash).toHaveTextContent("$100");
    expect(cash.nextElementSibling).toHaveTextContent("As of 2026-11-06T10:00:00.000Z");
    expect(screen.getByTestId("metric-Runway")).toHaveTextContent("2.0 months");
    expect(screen.getByTestId("source-freshness")).toHaveTextContent(/Synthetic test data.*America\/Los_Angeles.*cash basis.*Last source observation 2026-11-06T11:00:00.000Z/);
    expect(screen.getByRole("link", { name: "View statements" })).toHaveAttribute("href", `/finance?${periodQuery}`);
    expect(screen.getByRole("link", { name: "Review month-end close" })).toHaveAttribute("href", "/finance/close/2026-09");

    const chart = within(screen.getByRole("region", { name: "Cash trajectory chart" }));
    const graphic = chart.getByRole("img", { name: "Observed cash in July 2026 was -$1,500 and in September 2026 was $80,250." });
    expect(graphic.querySelector("[stroke-dasharray]")).toBeNull();
    expect(chart.getByText("$39,375")).toBeInTheDocument();
    const table = within(chart.getByRole("table", { name: "Observed cash by month." }));
    expect(table.getAllByRole("row").slice(1).map(row => row.textContent)).toEqual(["July 2026-$1,500Observed", "September 2026$80,250Observed"]);
    expect(screen.getByTestId("metric-Payouts matched")).toHaveTextContent("Payout reconciliation unavailable");
  });

  it("keeps current cash available when the source returns no historical points", async () => {
    open([]);
    expect(await screen.findByTestId("metric-Cash available")).toHaveTextContent("$100");
    expect(screen.getByText("Observed cash history is unavailable for this report.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Cash trajectory chart" })).not.toBeInTheDocument();
  });

  it("holds cash, runway and historical points under an unadopted accounting definition", async () => {
    open(observedCash, "pending");
    expect(await screen.findByTestId("metric-Cash available")).toHaveTextContent("N/A");
    expect(screen.getByTestId("metric-Runway")).toHaveTextContent("N/A");
    expect(screen.getByTestId("metric-Gross margin")).toHaveTextContent("N/A");
    expect(screen.queryByRole("region", { name: "Cash trajectory chart" })).not.toBeInTheDocument();
  });
});
