import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { AdapterError } from "@/adapter/errors";
import type { FardaAdapter } from "@/adapter/adapter";
import { ledgerDemo, ledgerTotals, netAccrued } from "@/fixtures/finance";
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

describe("commission ledger", () => {
  it("derives every total from the group rows", async () => {
    open("/finance/commissions");
    expect(await screen.findByTestId("metric-Net eligible sales")).toHaveTextContent("$1,800");
    expect(screen.getByText("$2,000 gross less $200 refunds")).toBeInTheDocument();
    expect(metric("Net accrued commission")).toHaveTextContent("$270");
    expect(screen.getByText("$300 earned less $30 reversals")).toBeInTheDocument();
    expect(metric("Cash commission paid")).toHaveTextContent("$90");
    expect(metric("Estimated contribution")).toHaveTextContent("$462.17");
    expect(screen.getByText("25.68% · before shared overhead")).toBeInTheDocument();
    const t = ledgerTotals(ledgerDemo());
    expect(t.held + t.disputed + t.awaiting + t.paid).toBe(t.accrued);
    expect(t.fee).toBe(783);
  });

  it("keeps held, disputed, awaiting-provider and paid as separate states that sum to the accrual", async () => {
    open("/finance/commissions");
    const bar = await screen.findByRole("list", { name: "Current balances by state" });
    expect(within(bar).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Held $90", "Disputed $30", "Awaiting $60", "Paid $90"]);
    expect(screen.getByText(/= \$270 net accrued/)).toBeInTheDocument();
    const rows = within(screen.getByTestId("ledger-table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[4]!.textContent)).toEqual(["Held", "Disputed", "Awaiting provider", "Paid"]);
    expect(ledgerDemo().groups.map(netAccrued)).toEqual([9000, 3000, 6000, 9000]);
  });

  it("offers no manual Pay action anywhere", async () => {
    open("/finance/commissions");
    await screen.findByTestId("ledger-table");
    expect(screen.queryByRole("button", { name: /^pay\b|pay now|release payment/i })).not.toBeInTheDocument();
    expect(screen.getByText("No manual Pay")).toBeInTheDocument();
  });

  it("opens read-only evidence for a hold, and hands a paid receipt to a source dialog", async () => {
    const { user } = open("/finance/commissions");
    await user.click(await screen.findByRole("button", { name: "Review hold: COMM-DEMO-A" }));
    expect(screen.getByText(/A \$200 refund reversed \$30/)).toBeInTheDocument();
    expect(screen.getByText(/Viewing this changes nothing/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "View receipt: COMM-DEMO-D" }));
    expect(screen.getByText(/No verified link is available/)).toBeInTheDocument();
  });

  it("describes the waterfall in words and as a table", async () => {
    open("/finance/commissions");
    expect(await screen.findByRole("img", { name: /contribution of \$462\.17/ })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Contribution after creator costs, USD" });
    expect(within(table).getAllByRole("row").map((r) => r.textContent)).toContain("Fee estimate-$7.83");
  });

  it("exports the whole snapshot as CSV, and says where it was built", async () => {
    const created: { parts: string[] }[] = [];
    vi.stubGlobal("Blob", class { constructor(public parts: string[]) {} });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: { parts: string[] }) => { created.push(b); return "blob:x"; }, revokeObjectURL: () => undefined }));
    HTMLAnchorElement.prototype.click = vi.fn();
    const { user } = open("/finance/commissions");
    await user.click(await screen.findByRole("button", { name: "Export ledger" }));
    expect(screen.getByText("4 of 4")).toBeInTheDocument();
    expect(screen.getByText(/No customer personal data/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText(/CSV with 4 rows prepared in your browser/)).toBeInTheDocument();
    const text = created[0]!.parts.join("");
    expect(text.split("\r\n")[0]).toBe("﻿ledger_group,state,gross_sales_minor,net_base_minor,earned_minor,reversed_minor,net_accrued_minor,commission_rate_pct,currency,observed_at,ledger_revision");
    expect(text).toContain("COMM-DEMO-A,Held,80000,60000,12000,3000,9000,20,USD");
  });

  it("blocks the export, and never calls it complete, while the snapshot is partial", async () => {
    const { user } = open("/finance/commissions?scenario=partial");
    expect(await screen.findByText(/Showing 3 of 4 groups/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export ledger" }));
    expect(screen.getByText(/3 of 4 \(incomplete\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/incomplete/);
  });

  it("shows an unreachable ledger as a recoverable error with no figures", async () => {
    open("/finance/commissions?scenario=unavailable");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reached/);
    expect(screen.queryByTestId("metric-Net accrued commission")).not.toBeInTheDocument();
  });

  it("never falls back to demo data on a live route", async () => {
    open("/finance/commissions", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-Net accrued commission")).not.toBeInTheDocument();
  });
});

describe("Collabs payout reconciliation", () => {
  const PATH = "/finance/settlements/COMM-DEMO-D";

  it("shows the paid example with the invoice still unmatched and the fee derived", async () => {
    open(PATH);
    expect(await screen.findByTestId("metric-Creator cash paid")).toHaveTextContent("$90");
    expect(metric("Merchant invoice")).toHaveTextContent("Unmatched");
    expect(metric("Fee estimate")).toHaveTextContent("$2.61");
    expect(screen.getByText("2.9% of $90 · tax/FX excluded")).toBeInTheDocument();
    expect(metric("Ledger reconciliation")).toHaveTextContent("Pending");
    expect(screen.getByText("Synthetic settled group · 15 retained orders × $40 eligible merchandise × 15% = $90.")).toBeInTheDocument();
  });

  it("never offers a duplicate manual Pay task, and a paid receipt is only inspected", async () => {
    open(PATH);
    await screen.findByTestId("paid-receipt");
    expect(screen.queryByRole("button", { name: /^pay\b|pay now/i })).not.toBeInTheDocument();
    expect(screen.getByText(/never creates a duplicate manual Pay task/)).toBeInTheDocument();
  });

  it("previews candidate matches, refuses to select a duplicate, and submits for review without marking anything reconciled", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = open(PATH, adapter);
    await user.click(await screen.findByRole("button", { name: "Match statement" }));
    const dialog = screen.getByRole("dialog", { name: "Match the provider statement" });
    expect(within(dialog).getByRole("checkbox", { name: /STMT-DEMO-0001/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /STMT-DEMO-0002/ })).toBeDisabled();
    expect(within(dialog).getByText(/Stays unresolved: duplicate/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Submit for review" }));
    const status = await screen.findByTestId("match-status");
    expect(status).toHaveTextContent("Approval required");
    expect(status).toHaveTextContent("Nothing is marked reconciled and the paid receipt is unchanged.");
    expect(metric("Ledger reconciliation")).toHaveTextContent("Pending");
    expect(spy.mock.calls[0]![0]).toMatchObject({ operation: "requestApproval", actionKind: "reconcileSettlement", expectedVersion: "st1" });
  });

  it("shows a stale version as a conflict", async () => {
    const adapter = createDemoAdapter();
    vi.spyOn(adapter, "submitAction").mockRejectedValueOnce(new AdapterError({ code: "STALE_VERSION", message: "This settlement changed. Reload it before submitting a match.", requestId: "r", correlationId: "c", retryable: false, retryAfterMs: null, executionCertainty: "notApplied" }));
    const { user } = open(PATH, adapter);
    await user.click(await screen.findByRole("button", { name: "Match statement" }));
    await user.click(within(screen.getByRole("dialog", { name: "Match the provider statement" })).getByRole("button", { name: "Submit for review" }));
    expect(await screen.findByTestId("action-error")).toHaveTextContent("This record changed");
  });

  it("opens read-only evidence and crosswalk panels that change nothing (CTRL-119, CTRL-121)", async () => {
    const { user } = open(PATH);
    await user.click(await screen.findByRole("button", { name: "Review matching evidence" }));
    expect(screen.getByText(/does not confirm a match or change a payout/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Open crosswalk" }));
    expect(screen.getByText(/Editing a mapping is a separately authorized action/)).toBeInTheDocument();
  });

  it("keeps the exception scenarios apart from the paid example", async () => {
    open(PATH);
    const list = await screen.findByRole("list", { name: "Settlement exception scenarios" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText(/alternative cases, not the state of the \$90 paid example/)).toBeInTheDocument();
  });

  it("keeps the heading and says so for a settlement that does not exist", async () => {
    open("/finance/settlements/nope");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settlement");
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("Record not found");
  });
});

describe("TikTok native settlement", () => {
  const PATH = "/finance/settlements/TT-NATIVE-DEMO";

  it("shows an unread native rate as Unverified, never as a number, and a proposal as a draft", async () => {
    open(PATH);
    expect(await screen.findByTestId("metric-Active native rate standard")).toHaveTextContent("Unverified");
    expect(metric("Active native rate shopAds")).toHaveTextContent("Unverified");
    expect(metric("Proposed rate standard")).toHaveTextContent("Draft");
    expect(screen.getByText("Standard commission")).toBeInTheDocument();
    expect(screen.getByText("Shop Ads commission")).toBeInTheDocument();
  });

  it("shows historical offer models read only, with the reason, and creates no new offer (CTRL-127, CTRL-128)", async () => {
    open(PATH);
    const group = await screen.findByRole("navigation", { name: "Historical offer models, read only" });
    for (const name of ["Commission only", "Flat fee", "Flat fee + commission"]) {
      const tab = within(group).getByText(name);
      expect(tab).toHaveAttribute("aria-disabled", "true");
      expect(tab).toHaveAccessibleDescription(/Previously accepted flat-fee terms remain auditable/);
    }
    expect(screen.getByText(/current acquisition is commission-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new offer|create offer/i })).not.toBeInTheDocument();
  });

  it("switches tabs through the URL without mutating anything (CTRL-122, CTRL-124)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { router, user } = open(PATH, adapter);
    await user.click(await screen.findByRole("link", { name: "Samples" }));
    expect(router.state.location.search).toBe("?tab=samples");
    expect(await screen.findByTestId("tab-panel")).toHaveTextContent(/never approves, rejects or ships anything/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("opens historical terms read only, and the sample link through a handoff dialog", async () => {
    const { user } = open(PATH);
    await user.click(await screen.findByRole("button", { name: "Review historical terms" }));
    expect(screen.getByText(/offers no manual Pay action/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Open sample request" }));
    expect(screen.getByText(/No verified link is available/)).toBeInTheDocument();
  });
});

describe("historical manual fee settlement", () => {
  const PATH = "/finance/payables/PAY-0012";

  it("keeps approval, execution and reconciliation separate, with only one current step", async () => {
    open(PATH);
    const steps = await screen.findByRole("list", { name: "Payment lifecycle" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.querySelector("p")!.firstChild!.textContent)).toEqual(["Requested", "Founder approval", "Execution", "Settled", "Posted", "Reconciled"]);
    expect(within(steps).getByText("Founder approval").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Execution blocked")).toBeInTheDocument();
  });

  it("shows unknown settlement facts as not available, not paid and not posted", async () => {
    open(PATH);
    await screen.findByTestId("payment-request");
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Not paid")).toBeInTheDocument();
    expect(screen.getByText("Not posted")).toBeInTheDocument();
    expect(screen.getByText("Waiting for settlement")).toBeInTheDocument();
  });

  it("labels the $150 as an existing, accepted obligation, and offers no Pay action", async () => {
    open(PATH);
    expect(await screen.findByText("Existing payable · accepted historical terms")).toBeInTheDocument();
    expect(screen.getByText(/It is not a new acquisition offer or a second payment/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^pay\b|pay now|release payment|execute/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Founder review" })).toHaveAttribute("href", "/approvals/demo-approval-042");
  });

  it("hands the Slack approval to a source dialog that performs no action", async () => {
    const { user } = open(PATH);
    await user.click(await screen.findByRole("button", { name: "Open Slack approval" }));
    expect(screen.getByText(/No verified link is available/)).toBeInTheDocument();
  });

  it("keeps the heading and says so for a payable that does not exist", async () => {
    open("/finance/payables/nope");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Payable nope");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Record not found"), { timeout: 4000 });
  });
});
