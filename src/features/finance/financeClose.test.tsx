import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { appendAdjustment, ledgerDemo, netOfAdjustments, type CommissionGroup } from "@/fixtures/finance";
import { CPA_POLICY_NOT_SET, cpaPolicyLabel, currentRevision, isLocked, manifestDemo, monthsDemo, supersededBy } from "@/fixtures/financeClose";
import { renderRoute } from "@/test/renderWithAdapter";

const group = (id: string) => ledgerDemo().groups.find((g) => g.id === id)!;
const rows = (id: string) => within(screen.getByTestId(id)).getAllByRole("row").slice(1);

describe("FE08-03 immutable receipts and appended adjustments", () => {
  it("a paid group already carries its adjustment beside an unchanged receipt", () => {
    const paid = group("COMM-DEMO-D");
    expect(paid.evidence.receipt).toBe("TEST-RCPT-0090");
    expect(paid.adjustments).toEqual([expect.objectContaining({ id: "ADJ-0001", amountMinor: -500, receiptRef: "TEST-RCPT-0090" })]);
    expect(netOfAdjustments(9000, paid)).toBe(8500);
  });

  it("appending an adjustment leaves the receipt and every earlier adjustment exactly as they were", () => {
    const paid = group("COMM-DEMO-D");
    const before = structuredClone(paid);
    const next = appendAdjustment(paid, { id: "ADJ-0002", kind: "reversal", amountMinor: -200, at: "2026-11-01T10:00:00.000Z", reason: "A second refund", receiptRef: "TEST-RCPT-0090" });
    expect(paid).toEqual(before);
    expect(next.evidence).toEqual(before.evidence);
    expect(next.adjustments!.slice(0, 1)).toEqual(before.adjustments);
    expect(next.adjustments).toHaveLength(2);
    expect(netOfAdjustments(9000, next)).toBe(8300);
  });

  it("refuses an adjustment on an unpaid group, a positive one, a reused id or the wrong receipt", () => {
    const adj = { id: "ADJ-0009", kind: "reversal" as const, amountMinor: -100, at: "x", reason: "r", receiptRef: "TEST-RCPT-0090" };
    expect(() => appendAdjustment(group("COMM-DEMO-A") as CommissionGroup, adj)).toThrow(/Only a paid group/);
    expect(() => appendAdjustment(group("COMM-DEMO-D"), { ...adj, amountMinor: 100 })).toThrow(/negative/);
    expect(() => appendAdjustment(group("COMM-DEMO-D"), { ...adj, id: "ADJ-0001" })).toThrow(/never reused/);
    expect(() => appendAdjustment(group("COMM-DEMO-D"), { ...adj, receiptRef: "OTHER" })).toThrow(/receipt it adjusts/);
  });

  it("the settlement evidence names the adjustment and still shows the immutable receipt", async () => {
    const user = userEvent.setup();
    renderRoute("/finance/settlements/COMM-DEMO-D", createDemoAdapter());
    await user.click(await screen.findByRole("button", { name: "Review matching evidence" }));
    const dialog = (await screen.findAllByRole("dialog", { hidden: true })).find((d) => d.querySelector("h2"))!;
    expect(within(dialog).getByText("TEST-RCPT-0090")).toBeInTheDocument();
    expect(within(dialog).getByText(/ADJ-0001: -\$5 \(A customer refund after payout reversed \$5 of commission\)/)).toBeInTheDocument();
  });

  it("a payable with no provider transaction or QuickBooks reference says so, not blank or zero", async () => {
    renderRoute("/finance/payables/PAY-0012", createDemoAdapter());
    await screen.findByText("Settlement evidence");
    expect(screen.getByText("Provider transaction").nextElementSibling).toHaveTextContent("Not available");
    expect(screen.getByText("QuickBooks reference").nextElementSibling).toHaveTextContent("Not posted");
    expect(screen.getByText("Settlement status").nextElementSibling).toHaveTextContent("Not paid");
  });
});

describe("FIN274-02 / 03 months: open, closed, reopened, revised", () => {
  const by = (period: string) => monthsDemo.find((m) => m.period === period)!;
  it("covers all four statuses", () => {
    expect(monthsDemo.map((m) => m.status).sort()).toEqual(["closed", "open", "reopened", "revised"]);
  });
  it("a month is locked only while its current revision is the signed one", () => {
    expect(isLocked(by("2026-07"))).toBe(true);
    expect(isLocked(by("2026-09"))).toBe(true);
    expect(isLocked(by("2026-08"))).toBe(false);
    expect(isLocked(by("2026-10"))).toBe(false);
    expect(isLocked({ ...by("2026-09"), signedRevision: 1 })).toBe(false);
  });
  it("a revision supersedes the earlier one, which stays in the list", () => {
    const sept = by("2026-09");
    expect(currentRevision(sept)).toBe(2);
    expect(supersededBy(sept, 1)).toBe(2);
    expect(sept.revisions).toHaveLength(2);
  });

  it("the page shows each month's status, lock and revisions, and a reopened month is not locked", async () => {
    renderRoute("/finance/close/2026-10?view=months", createDemoAdapter());
    await screen.findByTestId("months-table");
    const r = rows("months-table");
    expect(r).toHaveLength(4);
    expect(r[0]).toHaveTextContent("July 2026ClosedLocked at revision 1");
    expect(r[1]).toHaveTextContent("ReopenedNot locked: reopened, needs a new sign-off");
    expect(r[2]).toHaveTextContent("RevisedLocked at revision 2");
    expect(r[2]).toHaveTextContent("r1 2026-10-09: Original close (superseded by r2, still readable)");
    expect(r[3]).toHaveTextContent("OpenNot locked: still open");
    expect(screen.getByText(/Nothing here is closed in a real ledger/)).toBeInTheDocument();
  });

  it("tax notes are jurisdiction notes that set no rule, and the CPA reference is Not set", async () => {
    renderRoute("/finance/close/2026-10?view=months", createDemoAdapter());
    await screen.findByTestId("tax-notes");
    expect(screen.getByTestId("tax-2026-07")).toHaveTextContent("This app sets no rate or rule");
    expect(screen.getByTestId("tax-2026-08")).toHaveTextContent("Reopened for a late processor adjustment");
    expect(screen.getByText(/CPA tax-policy reference: Not set\. No tax rule or rate is set in this app\./)).toBeInTheDocument();
  });
});

describe("FIN-EVIDENCE dry-run month and report manifest", () => {
  it("lists every report the close would export, synthetic, not generated, with the CPA reference as Not set", async () => {
    renderRoute("/finance/close/2026-10?view=manifest", createDemoAdapter());
    await screen.findByTestId("manifest-table");
    expect(screen.getByTestId("manifest-notice")).toHaveTextContent("DRYRUN-2026-10-M0");
    expect(screen.getByTestId("manifest-notice")).toHaveTextContent("Synthetic and labeled. No report has been generated and no period is closed.");
    const r = rows("manifest-table");
    expect(r.map((x) => x.firstElementChild!.textContent)).toEqual(["Profit & loss", "Balance sheet", "Cash flow", "Sales tax", "Inventory valuation", "Payout reconciliation"]);
    for (const row of r) {
      expect(row).toHaveTextContent("Not generated · no timestamp or checksum");
      expect(row).toHaveTextContent("CPA tax-policy reference: Not set");
    }
  });

  it("matches the close page's own report package", async () => {
    const m = manifestDemo();
    renderRoute("/finance/close/2026-10", createDemoAdapter());
    const pkg = await screen.findByTestId("reports");
    for (const row of m.rows) expect(within(pkg).getByText(row.report)).toBeInTheDocument();
  });

  it("never claims a report exists, and a set reference is shown as set", () => {
    const m = manifestDemo({ reference: "CPA-POLICY-DRAFT-0" });
    expect(m.rows.every((r) => r.generatedAt === null && r.checksum === null && r.state === "Not generated")).toBe(true);
    expect(cpaPolicyLabel(m.policy)).toBe("CPA tax-policy reference: CPA-POLICY-DRAFT-0");
    expect(cpaPolicyLabel(CPA_POLICY_NOT_SET)).toBe("CPA tax-policy reference: Not set");
  });

  it("the reconciliation dialog on the close links to both views", async () => {
    const user = userEvent.setup();
    renderRoute("/finance/close/2026-10", createDemoAdapter());
    await user.click(await screen.findByRole("button", { name: "Open reconciliation" }));
    expect(await screen.findByRole("link", { name: "Months and revisions", hidden: true })).toHaveAttribute("href", "/finance/close/2026-10?view=months");
    expect(screen.getByRole("link", { name: "Dry-run manifest", hidden: true })).toHaveAttribute("href", "/finance/close/2026-10?view=manifest");
  });

  it("shows a pending state and no months or manifest on the live adapter", async () => {
    renderRoute("/finance/close/2026-10?view=months", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("months-table")).not.toBeInTheDocument();
  });
});
