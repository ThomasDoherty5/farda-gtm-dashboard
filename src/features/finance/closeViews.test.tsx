import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { CPA_POLICY_NOT_SET, cpaPolicyLabel, currentRevision, isLocked, manifestDemo, monthsDemo, supersededBy } from "@/fixtures/financeClose";
import { renderRoute } from "@/test/renderWithAdapter";

const rows = (id: string) => within(screen.getByTestId(id)).getAllByRole("row").slice(1);

describe("FIN274-02 / 03 months: open, closed, reopened, revised", () => {
  const by = (period: string) => monthsDemo().find((m) => m.period === period)!;
  it("covers all four statuses", () => {
    expect(monthsDemo().map((m) => m.status).sort()).toEqual(["closed", "open", "reopened", "revised"]);
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
    expect(r.map((x) => x.firstElementChild!.textContent)).toEqual(["Profit & loss", "Balance sheet", "Cash flow", "Sales tax", "Inventory valuation", "Payout reconciliation", "Accounts payable aging"]);
    expect(r[1]).toHaveTextContent("balance-sheet-2026-10.pdf, balance-sheet-2026-10.xlsx");
    for (const row of r) {
      expect(row).toHaveTextContent("Not generated · no timestamp or checksum");
      expect(row).toHaveTextContent("CPA tax-policy reference: Not set");
    }
  });

  it("matches the close page's own report package", async () => {
    const m = manifestDemo();
    renderRoute("/finance/close/2026-10", createDemoAdapter());
    const pkg = await screen.findByTestId("reports");
    // The close page lists six reports; the manifest lists those six and the seventh the package adds.
    const listed = within(pkg).getAllByRole("term").map((t) => t.textContent);
    expect(listed).toHaveLength(6);
    for (const name of listed) expect(m.rows.map((row) => row.report)).toContain(name);
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
