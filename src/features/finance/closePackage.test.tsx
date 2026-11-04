import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import type { FardaAdapter } from "@/adapter/adapter";
import { renderRoute } from "@/test/renderWithAdapter";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});

const open = (scenario?: string, adapter: FardaAdapter = createDemoAdapter()) => {
  renderRoute(`/finance/close/2026-10?view=package${scenario ? `&scenario=${scenario}` : ""}`, adapter);
  return userEvent.setup();
};
const NO_CONTROLS = /close (the )?(period|month|books)|sign off|approve|export (now|reports)|pay|rerun/i;

describe("close package", () => {
  it("is reached from the reconciliation dialog and keeps the scenario", async () => {
    renderRoute("/finance/close/2026-10?scenario=exportfailed", createDemoAdapter());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open reconciliation" }));
    expect(screen.getByRole("link", { name: "Close package and corrections" })).toHaveAttribute("href", "/finance/close/2026-10?view=package&scenario=exportfailed");
  });

  it("states the period status, the nine states and why the period is not closed", async () => {
    open();
    expect(await screen.findByTestId("package-notice")).toHaveTextContent("Period status: Open");
    const states = within(screen.getByRole("list", { name: "Close states" })).getAllByRole("listitem");
    expect(states.map((s) => s.textContent?.replace(" (current)", ""))).toEqual(["Open", "Reconciling", "Blocked", "Awaiting CPA", "Ready to export", "Exporting", "Failed", "Closed", "Reopened"]);
    expect(states.filter((s) => s.getAttribute("aria-current") === "step")).toHaveLength(1);
    expect(within(screen.getByTestId("blockers")).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByTestId("blockers")).toHaveTextContent("CPA sign-off has not been requested.");
    expect(screen.getByTestId("lifecycle")).not.toHaveTextContent("CPA_SIGN_OFF_PENDING");
  });

  it("lists the expected files, status, version and export evidence of every report, with none invented", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Report package v1" });
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    const row = within(table).getByText("Balance sheet").closest("tr")!;
    expect(row).toHaveTextContent("balance-sheet-2026-10.pdf, balance-sheet-2026-10.xlsx");
    expect(row).toHaveTextContent("Not generated");
    expect(within(row).getByText("No export evidence")).toBeInTheDocument();
    expect(screen.queryByText(/TEST-EXPORT/)).not.toBeInTheDocument();
  });

  it("shows a failed export as failed with receipts only for what exported", async () => {
    open("exportfailed");
    expect(await screen.findByTestId("package-notice")).toHaveTextContent("Period status: Failed");
    const table = screen.getByRole("table", { name: "Report package v1" });
    expect(within(table).getAllByText("Export failed")).toHaveLength(7);
    expect(screen.queryByText(/TEST-EXPORT/)).not.toBeInTheDocument();
  });

  it("shows a partly failed export with receipts only for what exported", async () => {
    open("partialexport");
    expect(await screen.findByTestId("package-notice")).toHaveTextContent("Period status: Failed");
    const table = screen.getByRole("table", { name: "Report package v1" });
    expect(within(table).getAllByText("Export failed")).toHaveLength(5);
    expect(within(table).getAllByText(/TEST-EXPORT-2026-10-v1-0\d/)).toHaveLength(2);
  });

  it("shows each difference with its owner, reason, correction and resolved time, and says what is missing", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Reconciliation differences" });
    const row = within(table).getByText("TEST-PO-SH-021").closest("tr")!;
    for (const text of ["Finance", "Reason not recorded", "None linked", "Unresolved", "No QuickBooks reference", "$12.00"]) expect(row).toHaveTextContent(text);
  });

  it("shows a resolved difference with every field", async () => {
    open("closed");
    const row = within(await screen.findByRole("table", { name: "Reconciliation differences" })).getByText("TEST-PO-SH-021").closest("tr")!;
    for (const text of ["Processing fee timing", "TEST-CORR-0001", "2026-11-02 16:00 UTC", "Matched"]) expect(row).toHaveTextContent(text);
    expect(screen.getByTestId("package-notice")).toHaveTextContent("Period status: Closed");
  });

  it("blocks on incomplete landed cost and on a provider and QuickBooks mismatch, in words", async () => {
    open("landedcost");
    expect(await screen.findByTestId("blockers")).toHaveTextContent("Landed cost is missing for 2 SKUs (TEST-SKU-0004, TEST-SKU-0007)");
    expect(screen.getByTestId("lifecycle")).toHaveTextContent("Incomplete: TEST-SKU-0004, TEST-SKU-0007");
    expect(screen.getByText("Landed cost is incomplete, so inventory value can't be reported.")).toBeInTheDocument();
  });

  it("blocks on a mismatched reference", async () => {
    open("refmismatch");
    expect(await screen.findByTestId("blockers")).toHaveTextContent("provider reference TEST-PO-SH-021 does not match QuickBooks reference TEST-QBO-DEP-9921");
    expect(within(screen.getByTestId("differences")).getByText("Mismatch")).toBeInTheDocument();
  });

  it("shows a late adjustment reopening review while the prior package and the paid receipt stay as they were", async () => {
    open("lateadjustment");
    expect(await screen.findByTestId("package-notice")).toHaveTextContent("Period status: Reopened");
    const adjustment = screen.getByTestId("adjustment");
    expect(adjustment).toHaveTextContent("TEST-ADJ-0001 · −$30.00");
    expect(adjustment).toHaveTextContent("Reversal (reduces commission)");
    expect(adjustment).toHaveTextContent("TEST-RCPT-0090 (unchanged)");
    expect(adjustment).toHaveTextContent("The prior close and its reports are not rewritten");
    expect(screen.getByTestId("package-v1")).toHaveTextContent("Preserved prior package");
    expect(within(screen.getByTestId("package-v1")).getAllByText("Exported")).toHaveLength(7);
    expect(within(screen.getByTestId("package-v2")).getAllByText("Not generated")).toHaveLength(7);
    expect(within(screen.getByTestId("receipts")).getByText("Immutable")).toBeInTheDocument();
  });

  it("shows v2 figures beside a frozen v1, with the $30 reversal moving expense and leaving what was paid alone", async () => {
    open("lateadjustment");
    const table = await screen.findByRole("table", { name: "Figures by package version" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Measure", "v1 (frozen)", "v2"]);
    const row = (name: string) => within(table).getByText(name).closest("tr")!;
    expect(row("Net commission expense")).toHaveTextContent("$270.00$240.00");
    expect(row("Reversals")).toHaveTextContent("$30.00$60.00");
    expect(row("Paid to creators")).toHaveTextContent("$90.00$90.00");
    expect(row("Pending recovery after payout")).toHaveTextContent("$0.00$30.00");
  });

  it("labels the commission dataset as pilot cohort B and keeps it apart from the $12,596 example", async () => {
    open();
    const note = await screen.findByTestId("cohort-notice");
    expect(note).toHaveTextContent("Affiliate pilot · synthetic cohort B");
    expect(note).toHaveTextContent("50 orders");
    expect(note).toHaveTextContent("$12,596");
    expect(note).toHaveTextContent("never added together");
    expect(screen.getByTestId("split")).toHaveTextContent("Affiliate pilot · synthetic cohort B");
  });

  it("refuses an unknown scenario instead of showing another one", async () => {
    open("recon");
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByTestId("lifecycle")).not.toBeInTheDocument();
  });

  it("splits commission reporting by provider, currency and period and never turns unknown into zero", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Commission reporting split" });
    const collabs = within(table).getByText("Collabs").closest("tr")!;
    expect(collabs).toHaveTextContent("USD · 2026-10");
    expect(collabs).toHaveTextContent("$300.00");
    expect(collabs).toHaveTextContent("$180.00");
    expect(collabs).toHaveTextContent("Held $90.00 · Disputed $30.00 · Awaiting provider $60.00");
    expect(within(collabs).getAllByText(/N\/A/)).toHaveLength(2);
    const tiktok = within(table).getByText("TikTok Shop").closest("tr")!;
    expect(within(tiktok).getAllByText(/N\/A/)).toHaveLength(7);
    expect(tiktok).not.toHaveTextContent("$0");
    expect(within(table).getByText("Historical fixed fee (read-only)").closest("tr")).toHaveTextContent("Payment awaiting founder approval $150.00");
  });

  it("offers no control that closes, signs off, exports or pays", async () => {
    open("readytoexport");
    await screen.findByTestId("package-notice");
    expect(screen.queryByRole("button", { name: NO_CONTROLS })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: NO_CONTROLS })).not.toBeInTheDocument();
  });

  it("shows a missing period honestly and never falls back to demo data on a live route", async () => {
    renderRoute("/finance/close/1999-01?view=package", createDemoAdapter());
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("Record not found");
  });

  it("shows a live route as not connected, with no package", async () => {
    open(undefined, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("lifecycle")).not.toBeInTheDocument();
  });
});
