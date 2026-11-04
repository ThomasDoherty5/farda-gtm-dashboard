import { ledgerDemo, ledgerTotals } from "./finance";
import { CLOSE_PACKAGE_SCENARIOS, closePackageDemo, commissionSplitDemo, differenceResolved, lifecycleStatusOf, netCommissionExpense, paidReceiptsDemo, PERIOD_STATUSES, referenceState, type LifecycleInput } from "./financeClose";

const pkg = (scenario?: string) => closePackageDemo("2026-10", scenario)!;
const base: LifecycleInput = { started: true, adjustmentOpen: false, hardBlocked: false, unresolvedDifferences: 0, cpa: "notRequested", exportState: "none" };

describe("close lifecycle", () => {
  it("reaches each of the nine states, and only through the evidence", () => {
    const byScenario = Object.fromEntries(CLOSE_PACKAGE_SCENARIOS.map((s) => [s, pkg(s).status]));
    expect(byScenario).toEqual({ open: "open", reconciling: "reconciling", awaitingcpa: "awaitingCpa", readytoexport: "readyToExport", exporting: "exporting", exportfailed: "failed", closed: "closed", lateadjustment: "reopened", landedcost: "blocked", refmismatch: "blocked" });
    expect(new Set(Object.values(byScenario))).toEqual(new Set(PERIOD_STATUSES));
  });

  it("orders the states: reopened beats closed, a failed export beats a blocker, and differences come before the CPA gate", () => {
    expect(lifecycleStatusOf({ ...base, adjustmentOpen: true, cpa: "signedOff", exportState: "exported" })).toBe("reopened");
    expect(lifecycleStatusOf({ ...base, cpa: "signedOff", exportState: "exported" })).toBe("closed");
    expect(lifecycleStatusOf({ ...base, cpa: "signedOff", exportState: "failed", hardBlocked: true })).toBe("failed");
    expect(lifecycleStatusOf({ ...base, unresolvedDifferences: 1, cpa: "requested" })).toBe("reconciling");
    expect(lifecycleStatusOf({ ...base, hardBlocked: true, unresolvedDifferences: 1 })).toBe("blocked");
    expect(lifecycleStatusOf({ ...base, cpa: "requested" })).toBe("awaitingCpa");
    expect(lifecycleStatusOf({ ...base, cpa: "signedOff" })).toBe("readyToExport");
    expect(lifecycleStatusOf({ ...base, started: false })).toBe("open");
  });

  it("never reports closed while a difference, blocker, missing sign-off or missing export remains", () => {
    expect(lifecycleStatusOf({ ...base, cpa: "signedOff", exportState: "exported", unresolvedDifferences: 1 })).not.toBe("closed");
    expect(lifecycleStatusOf({ ...base, cpa: "signedOff", exportState: "exported", hardBlocked: true })).not.toBe("closed");
    expect(lifecycleStatusOf({ ...base, cpa: "requested", exportState: "exported" })).not.toBe("closed");
    expect(lifecycleStatusOf({ ...base, cpa: "signedOff", exportState: "exporting" })).not.toBe("closed");
  });

  it("closes only with every report exported, with a version and an export receipt, and no blockers", () => {
    for (const s of CLOSE_PACKAGE_SCENARIOS) {
      const p = pkg(s);
      const current = p.versions[p.versions.length - 1]!;
      if (p.status === "closed") {
        expect(p.blockers).toEqual([]);
        expect(current.reports.every((r) => r.status === "exported" && r.version === current.version && r.exportEvidence)).toBe(true);
      } else {
        expect(p.blockers.length === 0 && p.status !== "open", s).toBe(false);
        expect(current.reports.every((r) => r.status === "exported"), s).toBe(false);
      }
    }
  });
});

describe("report package", () => {
  it("names the expected PDF and Excel files for all seven reports before anything is exported", () => {
    const [v1] = pkg("reconciling").versions;
    expect(v1!.reports.map((r) => r.name)).toEqual(["Profit & loss", "Balance sheet", "Cash flow", "Sales tax", "Inventory valuation", "Payout reconciliation", "Accounts payable aging"]);
    for (const r of v1!.reports) {
      expect(r.expectedFiles).toHaveLength(2);
      expect(r.expectedFiles.map((f) => f.split(".").pop())).toEqual(["pdf", "xlsx"]);
      expect(r.status).toBe("notGenerated");
      expect(r.exportEvidence).toBeNull();
      expect(r.version).toBeNull();
    }
  });

  it("shows a partly failed export with receipts only for the reports that exported", () => {
    const [v1] = pkg("exportfailed").versions;
    expect(v1!.reports.filter((r) => r.exportEvidence).map((r) => r.name)).toEqual(["Profit & loss", "Balance sheet"]);
    expect(v1!.reports.filter((r) => r.status === "failed")).toHaveLength(5);
  });

  it("keeps inventory valuation ungenerated while landed cost is incomplete", () => {
    const p = pkg("landedcost");
    expect(p.landedCost).toEqual({ complete: false, missingSkus: ["TEST-SKU-0004", "TEST-SKU-0007"] });
    expect(p.blockers.map((b) => b.code)).toContain("LANDED_COST_INCOMPLETE");
    expect(p.versions[0]!.reports.find((r) => r.name === "Inventory valuation")).toMatchObject({ status: "notGenerated", exportEvidence: null });
  });
});

describe("reconciliation differences", () => {
  it("resolves only with an owner, a reason, a linked correction and a resolved time", () => {
    const [open, other] = pkg("reconciling").differences;
    expect(differenceResolved(open!)).toBe(false);
    expect(differenceResolved(other!)).toBe(false);
    const [done] = pkg("closed").differences;
    expect(differenceResolved(done!)).toBe(true);
    for (const missing of ["owner", "reason", "correctionRef", "resolvedAt"] as const) expect(differenceResolved({ ...done!, [missing]: null })).toBe(false);
  });

  it("treats a provider reference that differs from QuickBooks as a blocker, and a missing one as unmatched", () => {
    expect(referenceState({ providerRef: "A", qboRef: "A" })).toBe("matched");
    expect(referenceState({ providerRef: "A", qboRef: "B" })).toBe("mismatch");
    expect(referenceState({ providerRef: "A", qboRef: null })).toBe("missing");
    const p = pkg("refmismatch");
    expect(p.status).toBe("blocked");
    expect(p.blockers.map((b) => b.code)).toContain("REFERENCE_MISMATCH");
    expect(p.differences.every(differenceResolved)).toBe(true);
  });
});

describe("late adjustment", () => {
  it("reopens review as a new version and leaves the prior close unchanged", () => {
    const closed = pkg("closed");
    const late = pkg("lateadjustment");
    expect(late.status).toBe("reopened");
    expect(late.versions.map((v) => v.version)).toEqual(["v1", "v2"]);
    expect(late.versions[0]).toEqual(closed.versions[0]);
    expect(late.versions[0]).toMatchObject({ frozen: true, cpaSignOff: expect.any(String) });
    expect(late.versions[1]).toMatchObject({ frozen: false, closedAt: null, cpaSignOff: null });
    expect(late.versions[1]!.reports.every((r) => r.status === "notGenerated")).toBe(true);
    expect(late.adjustment).toMatchObject({ priorVersion: "v1", newVersion: "v2", effect: "reopened", cpaSignOff: "Requested" });
    expect(late.blockers.map((b) => b.code)).toEqual(["ADJUSTMENT_REVIEW_OPEN"]);
  });

  it("links to a paid receipt without changing it", () => {
    const late = pkg("lateadjustment");
    expect(late.paidReceipts).toEqual(pkg("closed").paidReceipts);
    expect(late.paidReceipts).toEqual(paidReceiptsDemo());
    expect(late.paidReceipts).toEqual([expect.objectContaining({ receipt: "TEST-RCPT-0090", immutable: true })]);
    expect(late.adjustment!.linkedReceipt).toBe(late.paidReceipts[0]!.receipt);
  });
});

describe("commission reporting split", () => {
  const rows = commissionSplitDemo("2026-10");
  const [collabs, tiktok, historical] = rows;

  it("derives the Collabs row from the ledger and reconciles outstanding to the unresolved states", () => {
    const t = ledgerTotals(ledgerDemo());
    expect(collabs!.accrual.value).toBe(t.earned);
    expect(collabs!.reversals.value).toBe(t.reversed);
    expect(collabs!.creatorPayout.value).toBe(t.paid);
    expect(collabs!.outstanding.value).toBe(t.accrued - t.paid);
    expect(collabs!.unresolved.reduce((n, u) => n + u.amount, 0)).toBe(collabs!.outstanding.value);
    expect(collabs!.unresolved.map((u) => u.label)).toEqual(["Held", "Disputed", "Awaiting provider"]);
  });

  it("keeps billing and cash unknown until a statement is matched, never zero", () => {
    expect(collabs!.merchantBilled).toMatchObject({ state: "unknown", value: null });
    expect(collabs!.merchantPaid).toMatchObject({ state: "unknown", value: null });
  });

  it("reports an unread provider as unknown on every measure, not a zero liability", () => {
    for (const k of ["accrual", "reversals", "processingFees", "merchantBilled", "merchantPaid", "creatorPayout", "outstanding"] as const) expect(tiktok![k]).toMatchObject({ state: "unknown", value: null });
    expect(netCommissionExpense(tiktok!)).toBeNull();
  });

  it("keeps the accepted historical fee separate, outstanding and unpaid", () => {
    expect(historical).toMatchObject({ kind: "historical" });
    expect(historical!.outstanding.value).toBe(15000);
    expect(historical!.creatorPayout).toMatchObject({ state: "known", value: 0 });
    expect(historical!.merchantBilled.state).toBe("notApplicable");
    expect(historical!.unresolved).toEqual([{ label: "Awaiting founder approval", amount: 15000 }]);
  });

  it("recognizes expense at accrual, so cash paid does not reduce it again", () => {
    expect(netCommissionExpense(collabs!)).toBe(27000);
    expect(netCommissionExpense({ ...collabs!, creatorPayout: { ...collabs!.creatorPayout, value: 0 } })).toBe(27000);
  });

  it("is keyed by provider, currency and period", () => {
    expect(new Set(rows.map((r) => `${r.provider}|${r.currency}|${r.period}`)).size).toBe(rows.length);
    expect(rows.every((r) => r.currency === "USD" && r.period === "2026-10")).toBe(true);
  });
});

it("has no package for an unknown period", () => {
  expect(closePackageDemo("1999-01")).toBeNull();
});
