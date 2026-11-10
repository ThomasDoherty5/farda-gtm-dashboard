import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { financeRecord } from "@/creator-agent/finance/fixtures.testkit";
import type { FardaAdapter } from "@/adapter/adapter";
import { financeDashboardDemo, runwayOf } from "@/fixtures/finance";
import { periodCloseDemo } from "@/fixtures/financeClose";
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

describe("dashboard unit economics", () => {
  const facts = (name: string) => within(document.querySelector(`dl[aria-label="${name}"]`) as HTMLElement);
  const fact = (label: string, list = "Unit economics") => facts(list).getByText(label, { selector: "dt" }).nextElementSibling!;
  const unit = async () => within(await screen.findByTestId("unit-economics"));

  it("calculates CAC payback in orders and says it is provisional while creator costs and attribution are incomplete", async () => {
    open("/finance");
    await unit();
    expect(fact("CAC payback")).toHaveTextContent("1.76 orders · Provisional · Creator costs partly allocated · Attribution coverage incomplete");
    expect(fact("Creator costs · attribution")).toHaveTextContent("6 of 8 creators · 352 of 400 orders");
    expect(fact("Pre-marketing contribution / order")).toHaveTextContent("$14.20");
    expect(metric("Pre-marketing contribution")).toHaveTextContent("$14.20");
    expect(screen.queryByText("Awaiting creator allocation")).not.toBeInTheDocument();
  });

  it("gives an explained N/A for zero orders, never $0 economics", async () => {
    open("/finance?scenario=zeroorders");
    await unit();
    expect(fact("Gross margin")).toHaveTextContent("N/A · No net revenue in the period");
    expect(fact("Pre-marketing contribution / order")).toHaveTextContent("N/A · No valid orders in the cohort");
    expect(fact("CAC payback")).toHaveTextContent("N/A · No new customers in the cohort");
    expect(metric("Pre-marketing contribution")).toHaveTextContent("N/A");
  });

  it("marks margin, contribution and payback provisional while a landed cost is missing", async () => {
    open("/finance?scenario=landedincomplete");
    await unit();
    expect(fact("Gross margin")).toHaveTextContent("65.0% · Provisional · Landed cost incomplete");
    expect(fact("CAC payback")).toHaveTextContent(/^1\.76 orders · Provisional · Landed cost incomplete/);
  });

  it("says no subscription revenue only when verified, and unknown when the source is not read", async () => {
    open("/finance");
    expect(await screen.findByTestId("subscription-state")).toHaveTextContent("No subscription revenue");
    expect(screen.getByTestId("subscription-state")).toHaveAttribute("data-state", "none");
  });

  it("keeps an unread subscription source unknown, not 'none'", async () => {
    open("/finance?scenario=subscriptionunread");
    expect(await screen.findByTestId("subscription-state")).toHaveTextContent("Subscription revenue unknown");
    expect(screen.queryByText("No subscription revenue")).not.toBeInTheDocument();
    expect(screen.getByText(/Subscription source not read \(SUBSCRIPTION_SOURCE_NOT_READ\)\. Unknown, not zero\./)).toBeInTheDocument();
  });

  it("shows the definitions as proposed, the pilot's commission as not applicable, and the forecast's own version", async () => {
    const { user } = open("/finance");
    await user.click(await screen.findByRole("button", { name: "View metric definitions" }));
    const dialog = within(screen.getByRole("dialog", { name: "Metric definitions" }));
    expect(dialog.getByText(/^Proposed · finance-unit-economics@1 · not adopted\. No adopted finance policy exists in this repository, and these definitions have not been reviewed by a CPA\.$/)).toBeInTheDocument();
    expect(fact("Accrued commission · acquisition", "Cohort cost components")).toHaveTextContent("N/A · pilot cohort only; see the commission ledger");
    expect(fact("Landed COGS · contribution", "Cohort cost components")).toHaveTextContent("$4,410.00");
    expect(fact("Actuals", "Actuals and forecast")).toHaveTextContent("Source version fin1 · management P&L");
    expect(fact("Forecast", "Actuals and forecast")).toHaveTextContent("forecast-illustrative@1 · illustrative");
    expect(fact("CAC payback", "Unit-economics definitions")).toHaveTextContent(/^CAC ÷ Pre-marketing contribution per order\./);
  });

  it("lists per-component costs that sum to each group total in the definitions dialog", async () => {
    const { user } = open("/finance");
    await user.click(await screen.findByRole("button", { name: "View metric definitions" }));
    expect(fact("Total contribution costs", "Cohort cost components")).toHaveTextContent("$6,916.00");
    expect(fact("Total acquisition costs", "Cohort cost components")).toHaveTextContent("$7,000.00");
  });

  it("accepts a live record without the optional add-ons: the P&L shows and unit economics read not reported", async () => {
    const frozen = { ...financeRecord("financeDashboard") };
    for (const key of ["unitEconomics", "subscriptions", "forecastPlan"]) delete frozen[key];
    const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
      if (request.kind !== "read" || request.envelope.viewKey !== "financeDashboard") throw new Error("Unexpected finance operation");
      return respondWith(request.envelope, { ...frozen, readAccess: { validUntil: "2999-01-01T00:00:00.000Z" } }, { dataVersion: "synthetic-live-frozen" });
    } } });
    const { user } = open("/finance", adapter);
    expect(await screen.findByTestId("pnl-table")).toBeInTheDocument();
    expect(fact("Gross margin")).toHaveTextContent("90.0% · Provisional · Landed-cost completeness not reported");
    expect(fact("CAC payback")).toHaveTextContent("N/A · Unit-economics inputs are not reported");
    expect(fact("Creator costs · attribution")).toHaveTextContent("Not reported");
    expect(screen.getByTestId("subscription-state")).toHaveTextContent("Subscription revenue unknown");
    await user.click(screen.getByRole("button", { name: "View metric definitions" }));
    expect(fact("Forecast", "Actuals and forecast")).toHaveTextContent("No forecast plan reported");
  });

  it("applies the same unknown semantics to a live source record", async () => {
    const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
      if (request.kind !== "read" || request.envelope.viewKey !== "financeDashboard") throw new Error("Unexpected finance operation");
      return respondWith(request.envelope, { ...financeRecord("financeDashboard"), readAccess: { validUntil: "2999-01-01T00:00:00.000Z" } }, { dataVersion: "synthetic-live" });
    } } });
    open("/finance", adapter);
    await unit();
    expect(fact("Gross margin")).toHaveTextContent("90.0% · Provisional · Landed cost incomplete");
    expect(fact("Pre-marketing contribution / order")).toHaveTextContent("N/A · Customer shipping unknown · Provider fees unknown · Fulfillment unknown");
    expect(fact("CAC payback")).toHaveTextContent("N/A · Paid media unknown");
    expect(fact("Creator costs · attribution")).toHaveTextContent("creators unknown · orders unknown");
    expect(screen.getByTestId("subscription-state")).toHaveTextContent("Subscription revenue unknown");
  });
});

describe("close and reconciliation", () => {
  const PATH = "/finance/close/2026-10";

  it("derives progress from the checks and never closes the period itself", async () => {
    open(PATH);
    expect(await screen.findByTestId("metric-Close progress")).toHaveTextContent("4 / 7");
    expect(screen.getByText("Open month · 4 of 7 checks complete")).toBeInTheDocument();
    expect(screen.getByText("Not requested")).toBeInTheDocument();
    expect(screen.getByText("Open", { selector: "dd" })).toBeInTheDocument();
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

  it("labels margin and contribution provisional while a landed cost is missing, like the dashboard", async () => {
    open("/analytics/finance?scenario=landedincomplete");
    expect(await screen.findByTestId("metric-Gross margin")).toHaveTextContent("65.0%");
    expect(metric("Gross margin").nextElementSibling).toHaveTextContent("Provisional · Landed cost incomplete · $8,186 gross profit / $12,596 receipts");
    expect(screen.getByTestId("contribution-per-order")).toHaveTextContent(/^Pre-marketing contribution: \$14\.20\/order · Provisional · Landed cost incomplete\./);
  });

  it("gives margin and contribution an explained N/A for zero orders, like the dashboard", async () => {
    open("/analytics/finance?scenario=zeroorders");
    expect(await screen.findByTestId("metric-Gross margin")).toHaveTextContent("N/A");
    expect(metric("Gross margin").nextElementSibling).toHaveTextContent("No net revenue in the period");
    expect(screen.getByTestId("contribution-per-order")).toHaveTextContent(/^Pre-marketing contribution: N\/A · No valid orders in the cohort\./);
  });

  it("draws no breakdown bars for zero orders, never the default $5,680 contribution", async () => {
    open("/analytics/finance?scenario=zeroorders");
    const panel = within(await screen.findByTestId("breakdown"));
    expect(panel.getByTestId("breakdown-empty")).toHaveTextContent("No breakdown: the source reports no receipts to split for this period.");
    expect(panel.queryByRole("list", { name: "Order contribution breakdown" })).not.toBeInTheDocument();
    expect(panel.queryByText(/5680|5,680/)).not.toBeInTheDocument();
    expect(financeDashboardDemo("zeroorders").costBreakdown).toEqual([]);
  });

  it("derives the default contribution from the cost rows, matching the dashboard", async () => {
    open("/analytics/finance");
    expect(await screen.findByTestId("contribution-per-order")).toHaveTextContent(/^Pre-marketing contribution: \$14\.20\/order\. Contribution after/);
    expect(metric("Gross margin").nextElementSibling).toHaveTextContent(/^\$8,186 gross profit \/ \$12,596 receipts$/);
  });

  it("applies the same unknown semantics to a live source record", async () => {
    const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
      if (request.kind !== "read" || request.envelope.viewKey !== "financeDashboard") throw new Error("Unexpected finance operation");
      return respondWith(request.envelope, { ...financeRecord("financeDashboard"), readAccess: { validUntil: "2999-01-01T00:00:00.000Z" } }, { dataVersion: "synthetic-live" });
    } } });
    open("/analytics/finance", adapter);
    expect(await screen.findByTestId("metric-Gross margin")).toHaveTextContent("90.0%");
    expect(metric("Gross margin").nextElementSibling).toHaveTextContent(/^Provisional · Landed cost incomplete/);
    expect(screen.getByTestId("contribution-per-order")).toHaveTextContent(/^Pre-marketing contribution: N\/A · Customer shipping unknown/);
  });

  it("never falls back to demo data on a live route", async () => {
    open("/analytics/finance", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-Cash available")).not.toBeInTheDocument();
  });
});
