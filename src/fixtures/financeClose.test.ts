import { ledgerDemo, ledgerTotals } from "./finance";
import { CLOSE_PACKAGE_SCENARIOS, closePackageDemo, commissionSplitDemo, DEFAULT_CLOSE_SCENARIO, differenceResolved, figuresAfter, isCloseScenario, lifecycleStatusOf, manifestDemo, monthsDemo, netCommissionExpense, paidReceiptsDemo, periodCloseDemo, PERIOD_STATUSES, PERIOD_STATUS_LABEL, referenceState, type LifecycleInput } from "./financeClose";

const pkg = (scenario?: string) => closePackageDemo("2026-10", scenario)!;
const summary = (scenario?: string) => periodCloseDemo("2026-10", scenario)!;
const base: LifecycleInput = { started: true, adjustmentOpen: false, hardBlocked: false, unresolvedDifferences: 0, cpa: "notRequested", exportState: "none" };

describe("close lifecycle", () => {
  it("reaches each of the nine states, and only through the evidence", () => {
    const byScenario = Object.fromEntries(CLOSE_PACKAGE_SCENARIOS.map((s) => [s, pkg(s).status]));
    expect(byScenario).toEqual({ open: "open", reconciling: "reconciling", awaitingcpa: "awaitingCpa", readytoexport: "readyToExport", exporting: "exporting", exportfailed: "failed", partialexport: "failed", closed: "closed", lateadjustment: "reopened", landedcost: "blocked", refmismatch: "blocked" });
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
    const [v1] = pkg("open").versions;
    expect(v1!.reports.map((r) => r.name)).toEqual(["Profit & loss", "Balance sheet", "Cash flow", "Sales tax", "Inventory valuation", "Payout reconciliation", "Accounts payable aging"]);
    for (const r of v1!.reports) {
      expect(r.expectedFiles).toHaveLength(2);
      expect(r.expectedFiles.map((f) => f.split(".").pop())).toEqual(["pdf", "xlsx"]);
      expect(r.status).toBe("notGenerated");
      expect(r.exportEvidence).toBeNull();
      expect(r.version).toBeNull();
    }
  });

  it("shows a failed export with no receipt invented for any report", () => {
    const [v1] = pkg("exportfailed").versions;
    expect(v1!.reports.every((r) => r.status === "failed" && r.exportEvidence === null)).toBe(true);
  });

  it("shows a partly failed export with receipts only for the reports that exported", () => {
    const [v1] = pkg("partialexport").versions;
    expect(v1!.reports.filter((r) => r.exportEvidence).map((r) => r.name)).toEqual(["Profit & loss", "Balance sheet"]);
    expect(v1!.reports.filter((r) => r.status === "failed")).toHaveLength(5);
  });

  it("keeps inventory valuation ungenerated while landed cost is incomplete", () => {
    const p = pkg("landedcost");
    expect(p.landedCost).toEqual({ complete: false, missingSkus: ["TEST-SKU-0004", "TEST-SKU-0007"] });
    expect(p.blockers.map((b) => b.reason)).toContain("LANDED_COST_INCOMPLETE");
    expect(p.versions[0]!.reports.find((r) => r.name === "Inventory valuation")).toMatchObject({ status: "notGenerated", exportEvidence: null });
  });
});

describe("reconciliation differences", () => {
  it("resolves only with an owner, a reason, a linked correction and a resolved time", () => {
    const [open, other] = pkg("open").differences;
    expect(differenceResolved(open!)).toBe(false);
    expect(differenceResolved(other!)).toBe(false);
    // Work on a difference is not a resolution: "reconciling" has one explained and matched, one with only a reason.
    const [done1, partial] = pkg("reconciling").differences;
    expect(differenceResolved(done1!)).toBe(true);
    expect(partial).toMatchObject({ reason: expect.any(String), correctionRef: null, resolvedAt: null });
    expect(differenceResolved(partial!)).toBe(false);
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
    expect(p.blockers.map((b) => b.reason)).toContain("REFERENCE_MISMATCH");
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
    expect(late.blockers.map((b) => b.reason)).toEqual(["ADJUSTMENT_REVIEW_OPEN"]);
  });

  it("gives the adjustment a direction, and v2 shows figures while v1 stays frozen and equal to the closed package", () => {
    const closed = pkg("closed");
    const late = pkg("lateadjustment");
    expect(late.adjustment).toMatchObject({ direction: "reversal", amount: { minorUnits: 3000 } });
    const [v1, v2] = late.versions;
    expect(v1!.figures).toEqual(closed.versions[0]!.figures);
    expect(v1!.figures).toEqual({ accrual: 30000, reversals: 3000, netCommissionExpense: 27000, creatorPaid: 9000, outstandingLiability: 18000, pendingRecovery: 0 });
    // A reversal lowers commission expense by $30 and leaves what was paid alone; the $30 is tracked until the source says how it is recovered.
    expect(v2!.figures).toEqual({ accrual: 30000, reversals: 6000, netCommissionExpense: 24000, creatorPaid: 9000, outstandingLiability: 18000, pendingRecovery: 3000 });
    expect(v1!.figures.netCommissionExpense - v2!.figures.netCommissionExpense).toBe(3000);
  });

  it("an addition moves figures the other way, and neither direction mutates its input", () => {
    const v1 = pkg("closed").versions[0]!.figures;
    const before = structuredClone(v1);
    expect(figuresAfter(v1, "addition", 3000)).toEqual({ ...v1, accrual: 33000, netCommissionExpense: 30000, outstandingLiability: 21000 });
    expect(figuresAfter(v1, "reversal", 3000).netCommissionExpense).toBe(24000);
    expect(v1).toEqual(before);
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
    expect(historical!.unresolved).toEqual([{ label: "Payment awaiting founder approval", amount: 15000 }]);
    // Already accrued and outstanding, so the note can't call it merely "accepted" while it waits on approval.
    expect(historical!.accrual).toMatchObject({ state: "known", value: 15000 });
    expect(historical!.note).toMatch(/already accrued/);
    expect(historical!.note).toMatch(/awaits founder approval/);
    expect(historical!.note).not.toMatch(/accepted/i);
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

describe("scenarios", () => {
  it("defaults to the open month the Figma close screen draws, and rejects an unknown scenario instead of falling back", () => {
    expect(DEFAULT_CLOSE_SCENARIO).toBe("open");
    expect(pkg().scenario).toBe("open");
    expect(pkg().status).toBe("open");
    expect(isCloseScenario("reconciling")).toBe(true);
    expect(isCloseScenario("recon")).toBe(false);
    expect(() => closePackageDemo("2026-10", "recon")).toThrow(/Unknown close scenario/);
    expect(() => periodCloseDemo("2026-10", "recon")).toThrow(/Unknown close scenario/);
  });

  it("gives every period that is not closed at least one named blocker, so a held close always has a reason", () => {
    for (const s of CLOSE_PACKAGE_SCENARIOS) {
      const p = pkg(s);
      expect(p.blockers.length > 0, s).toBe(p.status !== "closed");
    }
  });

  it("labels the commission dataset as the pilot cohort, apart from the dashboard's $12,596 example", () => {
    const { commissionCohort } = pkg();
    expect(commissionCohort.label).toBe("Affiliate pilot · synthetic cohort B");
    expect(commissionCohort.orders).toBe(50);
    expect(commissionCohort.note).toMatch(/\$12,596/);
    expect(commissionCohort.note).toMatch(/never added together/);
  });
});

describe("the close summary and the package are one story", () => {
  for (const s of CLOSE_PACKAGE_SCENARIOS) {
    it(`agree on status, CPA review, unmatched payouts, export and reports under "${s}"`, () => {
      const p = pkg(s);
      const c = summary(s);
      const current = p.versions[p.versions.length - 1]!;
      expect(c.status, "status").toBe(p.status);
      expect(c.cpaReview).toBe(p.cpa.state === "signedOff" ? "Signed off" : p.cpa.state === "requested" ? "Requested" : "Not requested");
      const unmatched = p.differences.filter((d) => !differenceResolved(d) || referenceState(d) !== "matched");
      expect(c.exceptions.map((x) => x.payout)).toEqual(unmatched.map((d) => d.payout));
      const payoutCheck = c.checks.find((k) => k.check === "Payouts matched to bank")!;
      expect(payoutCheck.state === "complete").toBe(unmatched.length === 0);
      expect(c.exportFailed).toBe(p.exportState === "failed");
      expect(c.checks.find((k) => k.check === "Reports exported to Drive")!.state === "complete").toBe(p.exportState === "exported");
      expect(c.checks.find((k) => k.check === "CPA sign-off and period close")!.state === "complete").toBe(p.status === "closed");
      expect(c.checks.every((k) => k.state === "complete")).toBe(p.status === "closed");
      for (const r of c.reports) {
        const source = current.reports.find((x) => x.name === r.name)!;
        expect(r.state.startsWith("Exported"), r.name).toBe(source.status === "exported");
      }
    });
  }

  it("keeps the Figma numbers for the default month: 4 of 7 checks, two unmatched payouts, CPA not requested", () => {
    const c = summary();
    expect(c.checks.filter((k) => k.state === "complete")).toHaveLength(4);
    expect(c.checks).toHaveLength(7);
    expect(c.exceptions).toHaveLength(2);
    expect(c.cpaReview).toBe("Not requested");
    expect(c.status).toBe("open");
    expect(PERIOD_STATUS_LABEL[c.status]).toBe("Open");
  });

  it("reports an export that failed on the summary as failed, never reconciling, and agrees with the package", () => {
    expect(summary("exportfailed").status).toBe("failed");
    expect(summary("exportfailed").exceptions).toEqual([]);
    expect(pkg("exportfailed").differences.every(differenceResolved)).toBe(true);
  });
});

describe("months and the dry-run manifest", () => {
  it("takes October's status from the package, so the months list can't disagree with the close", () => {
    for (const s of CLOSE_PACKAGE_SCENARIOS) expect(monthsDemo(s).find((m) => m.period === "2026-10")!.status, s).toBe(pkg(s).status);
  });

  it("lists the same seven reports and expected files as the package, none generated", () => {
    const m = manifestDemo();
    expect(m.rows.map((r) => r.report)).toEqual(pkg().versions[0]!.reports.map((r) => r.name));
    expect(m.rows.map((r) => r.expectedFiles)).toEqual(pkg().versions[0]!.reports.map((r) => r.expectedFiles));
    expect(m.rows.every((r) => r.generatedAt === null && r.checksum === null)).toBe(true);
  });
});
