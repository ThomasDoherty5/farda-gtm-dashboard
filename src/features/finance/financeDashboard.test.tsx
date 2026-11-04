import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import type { FardaAdapter } from "@/adapter/adapter";
import { financeDashboardDemo, periodCloseDemo, runwayOf } from "@/fixtures/finance";
import { renderRoute } from "@/test/renderWithAdapter";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});

const open = (path: string, adapter: FardaAdapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  return { router, user: userEvent.setup() };
};
const metric = (label: string) => screen.getByTestId(`metric-${label}`);

describe("runway", () => {
  it("is verified cash over average burn, to one decimal", () => {
    const r = runwayOf(financeDashboardDemo());
    expect(r.months).toBeCloseTo(46200 / 5800, 5);
    expect(r.months!.toFixed(1)).toBe("8.0");
  });

  it("says why when there is too little history", () => {
    const r = runwayOf(financeDashboardDemo("insufficient"));
    expect(r.months).toBeNull();
    expect(r.reason).toBe("Burn needs 3 months of history; 1 available.");
  });

  it("is N/A when cash is not being spent, never infinite", () => {
    const r = runwayOf(financeDashboardDemo("zeroburn"));
    expect(r.months).toBeNull();
    expect(r.reason).toMatch(/no runway to count/);
  });

  it("never uses the historical $70,000 raised as current cash", () => {
    const d = financeDashboardDemo();
    expect(d.historicalRaised).toBe(7000000);
    expect(d.cash.value).toBe(4620000);
    expect(runwayOf({ ...d, cash: { ...d.cash, state: "unknown", value: null, reasonCode: "CASH_NOT_READ" } }).reason).toBe("Current cash is unknown.");
  });
});

describe("finance dashboard", () => {
  it("derives gross profit, net income, margin and runway from the source rows", async () => {
    open("/finance");
    expect(await screen.findByTestId("metric-Cash balance")).toHaveTextContent("$46,200");
    expect(screen.getByText("$70,000 raised · as of Oct 29")).toBeInTheDocument();
    expect(metric("Monthly burn")).toHaveTextContent("$5,800");
    expect(metric("Runway")).toHaveTextContent("8.0 months");
    const rows = within(screen.getByTestId("pnl-table")).getAllByRole("row").slice(1).map((r) => [within(r).getByRole("rowheader").textContent, within(r).getAllByRole("cell")[0]!.textContent]);
    expect(rows).toEqual([["Net revenue", "$12,596"], ["Cost of goods sold", "−$4,410"], ["Gross profit", "$8,186"], ["Operating expenses", "−$9,906"], ["Net income", "−$1,720"]]);
    expect(screen.getByText("65.0%")).toBeInTheDocument();
  });

  it("shows year-to-date as awaiting data, never as zero", async () => {
    open("/finance");
    const table = await screen.findByTestId("pnl-table");
    expect(within(table).getAllByText("Awaiting data")).toHaveLength(5);
    expect(within(table).queryByText("$0")).not.toBeInTheDocument();
  });

  it("keeps cash separate from revenue and labels the forecast illustrative", async () => {
    open("/finance");
    const cash = await screen.findByTestId("cash");
    expect(within(cash).getByText("Do not confuse cash with revenue")).toBeInTheDocument();
    expect(within(cash).getByText("Forecast is illustrative until rebaselined.")).toBeInTheDocument();
    expect(within(cash).getByText("$12.6k / $14.0k")).toBeInTheDocument();
  });

  it("reports runway as N/A with its reason when burn has too little history", async () => {
    open("/finance?scenario=insufficient");
    expect(await screen.findByTestId("metric-Runway")).toHaveTextContent("N/A");
    expect(screen.getByText("Burn needs 3 months of history; 1 available.")).toBeInTheDocument();
    expect(metric("Monthly burn")).toHaveTextContent("N/A");
  });

  it("says nothing is closed here: the close is a read-only summary that links to the checklist", async () => {
    open("/finance");
    const summary = await screen.findByTestId("close-summary");
    expect(within(summary).getByText("October · In progress")).toBeInTheDocument();
    expect(within(summary).getByRole("link", { name: "Open month-end close" })).toHaveAttribute("href", "/finance/close/2026-10");
    expect(screen.getByText("MRR and ARR appear only when subscription orders exist.")).toBeInTheDocument();
  });

  it("keeps the commission pilot separate and links to its own screens", async () => {
    open("/finance");
    const panel = await screen.findByTestId("compensation");
    expect(within(panel).getByText(/The original dashboard cohort is unchanged/)).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Commission ledger" })).toHaveAttribute("href", "/finance/commissions");
    expect(screen.queryByRole("button", { name: /^pay\b/i })).not.toBeInTheDocument();
  });

  it("says the mirror is behind when stale", async () => {
    open("/finance?scenario=stale");
    expect(await screen.findByTestId("source-freshness")).toHaveTextContent(/behind its source/);
  });

  it("shows an unreachable QuickBooks as a recoverable error, and no figures", async () => {
    open("/finance?scenario=unavailable");
    expect(await screen.findByRole("alert")).toHaveTextContent(/QuickBooks could not be reached/);
    expect(screen.queryByTestId("metric-Cash balance")).not.toBeInTheDocument();
  });

  it("never falls back to demo data on a live route", async () => {
    open("/finance", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-Cash balance")).not.toBeInTheDocument();
  });
});

describe("close and reconciliation", () => {
  const PATH = "/finance/close/2026-10";

  it("derives progress from the checks and never closes the period itself", async () => {
    open(PATH);
    expect(await screen.findByTestId("metric-Close progress")).toHaveTextContent("4 / 7");
    expect(screen.getByText("Reconciling · 4 of 7 checks complete")).toBeInTheDocument();
    expect(screen.getByText("Not requested")).toBeInTheDocument();
    expect(screen.getByText("Reconciling", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close (the )?(period|month|books)|sign off|approve/i })).not.toBeInTheDocument();
    const d = periodCloseDemo("2026-10")!;
    expect(d.checks.filter((c) => c.state === "complete")).toHaveLength(4);
  });

  it("separates the CPA owner and shows a blocked sign-off, not a completed one", async () => {
    open(PATH);
    const table = await screen.findByTestId("checklist-table");
    const row = within(table).getByText("CPA sign-off and period close").closest("tr")!;
    expect(within(row).getByText("Blocked")).toBeInTheDocument();
    expect(within(row).getByText("CPA")).toBeInTheDocument();
    expect(within(table).getByText("2 unmatched")).toBeInTheDocument();
  });

  it("shows unmatched payouts with their differences, and says unmatched is not lost money", async () => {
    open(PATH);
    const panel = await screen.findByTestId("exceptions");
    expect(within(panel).getByText("TEST-PO-SH-021")).toBeInTheDocument();
    expect(within(panel).getByText("$1,486.40")).toBeInTheDocument();
    expect(within(panel).getByText("$12.00")).toBeInTheDocument();
    expect(within(panel).getByText(/Unmatched does not mean lost money/)).toBeInTheDocument();
  });

  it("keeps every report awaiting the close", async () => {
    open(PATH);
    const reports = await screen.findByTestId("reports");
    expect(within(reports).getAllByText("Awaiting close")).toHaveLength(6);
  });

  it("shows an export failure as incomplete and never as a finished package", async () => {
    open(`${PATH}?scenario=exportfailed`);
    expect(await screen.findByTestId("close-notice")).toHaveTextContent("The report export failed, so the month stays incomplete.");
    expect(within(screen.getByTestId("reports")).getAllByText("Export failed: rerun pending")).toHaveLength(6);
    expect(within(screen.getByTestId("checklist-table")).getByText("Export failed")).toBeInTheDocument();
  });

  it("opens the reconciliation read only, with the posting owner, and says it does not close the books (CTRL-171)", async () => {
    const { user } = open(PATH);
    await user.click(await screen.findByRole("button", { name: "Open reconciliation" }));
    expect(screen.getByText(/Opening this does not close the books/)).toBeInTheDocument();
    expect(screen.getAllByText(/posting owner: Finance/)).toHaveLength(2);
    expect(screen.getByText("Not set")).toBeInTheDocument();
  });

  it("marks the current section with aria-current and adds no history entry (CTRL-170)", async () => {
    const { router } = open(PATH);
    await screen.findByTestId("metric-Close progress");
    const before = router.state.historyAction;
    expect(within(screen.getByRole("navigation", { name: "Finance sections" })).getByRole("link", { name: "Month-end" })).toHaveAttribute("aria-current", "page");
    expect(router.state.historyAction).toBe(before);
  });

  it("keeps the heading and says so for a period that does not exist", async () => {
    open("/finance/close/1999-01");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Close 1999-01");
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("Record not found");
  });
});

describe("finance analytics", () => {
  it("states cash, margin and runway from the same figures as the dashboard", async () => {
    open("/analytics/finance");
    expect(await screen.findByTestId("metric-Cash available")).toHaveTextContent("$46,200");
    expect(metric("Gross margin")).toHaveTextContent("65.0%");
    expect(screen.getByText("$8,186 gross profit / $12,596 receipts")).toBeInTheDocument();
    expect(metric("Runway")).toHaveTextContent("8.0 months");
    expect(screen.getByText("At $5,800 average monthly burn")).toBeInTheDocument();
  });

  it("draws the observed points and the projection from the data, and says which is which", async () => {
    open("/analytics/finance");
    const table = await screen.findByRole("table", { name: /Cash by month/ });
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual(["Jul$63,600Observed", "Aug$57,800Observed", "Sep$52,000Observed", "Oct$46,200Observed", "Nov$40,400Illustrative", "Dec$34,600Illustrative", "Jan$28,800Illustrative"]);
    expect(screen.getByRole("img", { name: /Observed cash fell from \$63\.6k in Jul to \$46\.2k in Oct\. An illustrative projection reaches \$28\.8k by Jan at \$5,800 a month/ })).toBeInTheDocument();
    expect(screen.getByText("$46,200 / $70,000")).toBeInTheDocument();
  });

  it("draws no projection when burn has too little history", async () => {
    open("/analytics/finance?scenario=insufficient");
    const table = await screen.findByRole("table", { name: /Cash by month/ });
    expect(within(table).queryByText("Illustrative")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /No projection is drawn/ })).toBeInTheDocument();
    expect(metric("Runway")).toHaveTextContent("N/A");
  });

  it("splits the 30-day receipts exactly across the breakdown", async () => {
    open("/analytics/finance");
    const d = financeDashboardDemo();
    expect(d.costBreakdown.reduce((n, c) => n + c.minor, 0)).toBe(d.pnl.revenue);
    const list = within(await screen.findByTestId("breakdown")).getByRole("list", { name: "Order contribution breakdown" });
    expect(within(list).getAllByRole("img").map((i) => i.getAttribute("aria-label"))).toEqual(["Contribution: $5680", "Landed COGS: $4410", "Shipping: $1164", "Transaction fees: $812", "Fulfillment: $530"]);
  });

  it("derives the matched share and the differences to resolve from the channel rows", async () => {
    open("/analytics/finance");
    expect(await screen.findByTestId("metric-Payouts matched")).toHaveTextContent("92% matched");
    expect(screen.getByText("2 differences to resolve")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review month-end close" })).toHaveAttribute("href", "/finance/close/2026-10");
  });

  it("never falls back to demo data on a live route", async () => {
    open("/analytics/finance", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-Cash available")).not.toBeInTheDocument();
  });
});
