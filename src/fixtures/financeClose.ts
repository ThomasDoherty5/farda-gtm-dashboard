/**
 * Month-end close package fixtures — SYNTHETIC. Extends the close dataset in `finance.ts` with the lifecycle, report package,
 * reconciliation difference, late adjustment and commission reporting detail the close acceptance asks for. These are not drawn in
 * the Figma source 7:683, so the screen that shows them says so. Amounts are minor units. Nothing here exports, signs off or pays:
 * every figure and receipt is fixture data, and "TEST-*" references are local fixture ids, not provider or QuickBooks identifiers.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import { ledgerDemo, ledgerTotals, STATE_LABEL, type CloseCheck, type CommissionState, type PeriodClose } from "./finance";
import { known, notApplicable, unknown, usd } from "./values";

export const PERIOD_STATUSES = ["open", "reconciling", "blocked", "awaitingCpa", "readyToExport", "exporting", "failed", "closed", "reopened"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const PERIOD_STATUS_LABEL: Record<PeriodStatus, string> = {
  open: "Open",
  reconciling: "Reconciling",
  blocked: "Blocked",
  awaitingCpa: "Awaiting CPA",
  readyToExport: "Ready to export",
  exporting: "Exporting",
  failed: "Failed",
  closed: "Closed",
  reopened: "Reopened",
};

export type CpaState = "notRequested" | "requested" | "signedOff";
export type ExportState = "none" | "exporting" | "failed" | "exported";

/** What decides the lifecycle state. The state is derived from these so it can never contradict the evidence beside it. */
export type LifecycleInput = {
  started: boolean;
  /** A late adjustment has been posted against an exported, signed-off close and its new version is not closed yet. */
  adjustmentOpen: boolean;
  /** A hard stop other than a difference: incomplete landed cost, a provider/QBO reference mismatch, or a named blocker. */
  hardBlocked: boolean;
  unresolvedDifferences: number;
  cpa: CpaState;
  exportState: ExportState;
};

/**
 * Precedence: a reopened period is reopened until its new version closes; a signed-off, fully exported package with nothing
 * outstanding is closed; then export outcomes; then hard stops; then open differences; then the CPA gate; then export.
 */
export function lifecycleStatusOf(i: LifecycleInput): PeriodStatus {
  if (i.adjustmentOpen) return "reopened";
  if (i.exportState === "exported" && i.cpa === "signedOff" && !i.hardBlocked && i.unresolvedDifferences === 0) return "closed";
  if (i.exportState === "failed") return "failed";
  if (i.exportState === "exporting") return "exporting";
  if (!i.started) return "open";
  if (i.hardBlocked) return "blocked";
  if (i.unresolvedDifferences > 0) return "reconciling";
  if (i.cpa !== "signedOff") return "awaitingCpa";
  return "readyToExport";
}

export type ReportStatus = "notGenerated" | "queued" | "exporting" | "exported" | "failed" | "superseded";
export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = { notGenerated: "Not generated", queued: "Queued", exporting: "Exporting", exported: "Exported", failed: "Export failed", superseded: "Superseded" };

export type PackageReport = {
  name: string;
  /** The files the export must produce, named before it runs so a missing one is visible. */
  expectedFiles: string[];
  status: ReportStatus;
  version: string | null;
  /** The export receipt. Null until an export actually ran; never invented. */
  exportEvidence: string | null;
  note: string | null;
};

export type PackageVersion = {
  version: string;
  figures: VersionFigures;
  /** A frozen package is a prior close. Later adjustments create a new version and never edit it. */
  frozen: boolean;
  closedAt: string | null;
  cpaSignOff: string | null;
  reports: PackageReport[];
};

export type Difference = {
  payout: string;
  expected: number;
  difference: number;
  owner: string | null;
  reason: string | null;
  correctionRef: string | null;
  resolvedAt: string | null;
  providerRef: string;
  qboRef: string | null;
};

export type ReferenceState = "matched" | "mismatch" | "missing";
export const referenceState = (d: Pick<Difference, "providerRef" | "qboRef">): ReferenceState => (d.qboRef === null ? "missing" : d.qboRef === d.providerRef ? "matched" : "mismatch");
/** A difference is resolved only when someone owns it, the reason and linked correction are recorded, and it has a resolved time. */
export const differenceResolved = (d: Difference) => Boolean(d.owner && d.reason && d.correctionRef && d.resolvedAt);

export type AdjustmentDirection = "reversal" | "addition";
export const ADJUSTMENT_DIRECTION_LABEL: Record<AdjustmentDirection, string> = { reversal: "Reversal (reduces commission)", addition: "Addition (increases commission)" };

/** The ledger figures behind one package version, in minor units. A frozen version's figures never change. */
export type VersionFigures = {
  accrual: number;
  reversals: number;
  /** Expense is recognized at accrual: accrual less reversals. Cash paid does not reduce it again. */
  netCommissionExpense: number;
  creatorPaid: number;
  outstandingLiability: number;
  /** A reversal after payout cannot lower the paid amount (the receipt is immutable). It is tracked here until the source confirms how it is recovered. */
  pendingRecovery: number;
};

export type LateAdjustment = {
  id: string;
  postedAt: string;
  /** The size of the adjustment. Its sign is the direction, never the amount. */
  amount: Money;
  direction: AdjustmentDirection;
  reason: string;
  /** The source-confirmed evidence the adjustment links to. */
  sourceEvidence: string;
  linkedReceipt: string;
  effect: "reopened";
  priorVersion: string;
  newVersion: string;
  cpaSignOff: "Requested" | "Not requested";
};

export type PaidReceipt = { receipt: string; groupId: string; amount: Money; immutable: true };

export type SplitRow = {
  id: string;
  provider: string;
  kind: "commission" | "historical";
  currency: string;
  period: string;
  accrual: ProvenanceValue<number>;
  reversals: ProvenanceValue<number>;
  processingFees: ProvenanceValue<number>;
  merchantBilled: ProvenanceValue<number>;
  merchantPaid: ProvenanceValue<number>;
  creatorPayout: ProvenanceValue<number>;
  outstanding: ProvenanceValue<number>;
  /** Held, disputed, waiting and failed amounts. They stay inside the outstanding liability and are listed, never shown as zero. */
  unresolved: { label: string; amount: number }[];
  note: string;
};

/** Commission expense is recognized at accrual. A later cash settlement is a different measure and never reduces it again. */
export const netCommissionExpense = (r: Pick<SplitRow, "accrual" | "reversals"> & Partial<SplitRow>): number | null =>
  r.accrual.state === "known" && r.accrual.value !== null && r.reversals.state === "known" && r.reversals.value !== null ? r.accrual.value - r.reversals.value : null;

export type BlockerCode = "UNRESOLVED_DIFFERENCE" | "REFERENCE_MISMATCH" | "REFERENCE_MISSING" | "LANDED_COST_INCOMPLETE" | "CPA_SIGN_OFF_PENDING" | "EXPORT_INCOMPLETE" | "ADJUSTMENT_REVIEW_OPEN";
export type CloseBlocker = { reason: BlockerCode; text: string };

export type ClosePackage = {
  datasetKey: "finance-demo";
  version: string;
  period: string;
  label: string;
  scenario: string;
  status: PeriodStatus;
  blockers: CloseBlocker[];
  cpa: { state: CpaState; signedAt: string | null };
  exportState: ExportState;
  /** Which commission dataset the figures below come from. It is a different dataset from the dashboard's $12,596 example; the two are never added. */
  commissionCohort: { label: string; orders: number; note: string };
  landedCost: { complete: boolean; missingSkus: string[] };
  differences: Difference[];
  /** Oldest first. Earlier versions are frozen. */
  versions: PackageVersion[];
  adjustment: LateAdjustment | null;
  paidReceipts: PaidReceipt[];
  commissionSplit: SplitRow[];
};

const REPORT_FILES: { name: string; slug: string }[] = [
  { name: "Profit & loss", slug: "profit-and-loss" },
  { name: "Balance sheet", slug: "balance-sheet" },
  { name: "Cash flow", slug: "cash-flow" },
  { name: "Sales tax", slug: "sales-tax" },
  { name: "Inventory valuation", slug: "inventory-valuation" },
  { name: "Payout reconciliation", slug: "payout-reconciliation" },
  { name: "Accounts payable aging", slug: "accounts-payable-aging" },
];

const reports = (period: string, version: string, status: ReportStatus, overrides: Partial<Record<string, Partial<PackageReport>>> = {}): PackageReport[] =>
  REPORT_FILES.map((r, i) => ({
    name: r.name,
    expectedFiles: [`${r.slug}-${period}.pdf`, `${r.slug}-${period}.xlsx`],
    status,
    version: status === "notGenerated" ? null : version,
    exportEvidence: status === "exported" ? `TEST-EXPORT-${period}-${version}-${String(i + 1).padStart(2, "0")}` : null,
    note: null,
    ...overrides[r.name],
  }));

const baseDifferences = (): Difference[] => [
  { payout: "TEST-PO-SH-021", expected: 148640, difference: 1200, owner: "Finance", reason: null, correctionRef: null, resolvedAt: null, providerRef: "TEST-PO-SH-021", qboRef: null },
  { payout: "TEST-PO-TT-018", expected: 64275, difference: 625, owner: "Finance", reason: null, correctionRef: null, resolvedAt: null, providerRef: "TEST-PO-TT-018", qboRef: null },
];
const resolvedDifferences = (): Difference[] =>
  baseDifferences().map((d, i) => ({ ...d, reason: i === 0 ? "Processing fee timing" : "Refund posted after the payout cut-off", correctionRef: `TEST-CORR-${String(i + 1).padStart(4, "0")}`, resolvedAt: `2026-11-0${i + 2}T16:00:00.000Z`, qboRef: d.providerRef }));

const CLOSED_AT = "2026-11-03T18:00:00.000Z";
const SIGNED_AT = "2026-11-03T17:30:00.000Z";

/** The scenario shown when none is asked for: the October dry-run month as the Figma close screen draws it, still open. */
export const DEFAULT_CLOSE_SCENARIO = "open";
export const CLOSE_PACKAGE_SCENARIOS = ["open", "reconciling", "awaitingcpa", "readytoexport", "exporting", "exportfailed", "partialexport", "closed", "lateadjustment", "landedcost", "refmismatch"] as const;

/** An unknown scenario is rejected, never quietly shown as another one. */
export const isCloseScenario = (s: string): boolean => (CLOSE_PACKAGE_SCENARIOS as readonly string[]).includes(s);

export function paidReceiptsDemo(): PaidReceipt[] {
  return ledgerDemo().groups.filter((g) => g.state === "paid" && g.evidence.receipt).map((g) => ({ receipt: g.evidence.receipt!, groupId: g.id, amount: usd(g.earned - g.reversed), immutable: true as const }));
}

/** Reporting split by provider, currency and period, derived from the ledger rows. Unknown stays N/A; held and disputed amounts stay listed. */
export function commissionSplitDemo(period: string): SplitRow[] {
  const ledger = ledgerDemo();
  const t = ledgerTotals(ledger);
  const unresolved = (["held", "disputed", "awaitingProvider"] as CommissionState[])
    .map((s) => ({ label: STATE_LABEL[s], amount: t[s === "awaitingProvider" ? "awaiting" : s] }))
    .filter((u) => u.amount > 0);
  return [
    {
      id: "collabs-usd",
      provider: "Collabs",
      kind: "commission",
      currency: ledger.currency,
      period,
      accrual: known(t.earned),
      reversals: known(t.reversed),
      processingFees: known(t.fee),
      merchantBilled: unknown("INVOICE_NOT_MATCHED"),
      merchantPaid: unknown("CASH_NOT_RECONCILED"),
      creatorPayout: known(t.paid),
      outstanding: known(t.accrued - t.paid),
      unresolved,
      note: "Billing and cash stay N/A until an authoritative statement is matched. Cash settlement does not reduce commission expense again.",
    },
    {
      id: "tiktok-usd",
      provider: "TikTok Shop",
      kind: "commission",
      currency: ledger.currency,
      period,
      accrual: unknown("TIKTOK_SETTLEMENT_NOT_READ"),
      reversals: unknown("TIKTOK_SETTLEMENT_NOT_READ"),
      processingFees: unknown("TIKTOK_SETTLEMENT_NOT_READ"),
      merchantBilled: unknown("TIKTOK_SETTLEMENT_NOT_READ"),
      merchantPaid: unknown("TIKTOK_SETTLEMENT_NOT_READ"),
      creatorPayout: unknown("TIKTOK_SETTLEMENT_NOT_READ"),
      outstanding: unknown("TIKTOK_SETTLEMENT_NOT_READ"),
      unresolved: [],
      note: "The connected settlement has not been read, so nothing is reported. This is not a zero liability.",
    },
    {
      id: "historical-usd",
      provider: "Historical fixed fee (read-only)",
      kind: "historical",
      currency: ledger.currency,
      period,
      accrual: known(ledger.economics.historicalFixedFee),
      reversals: notApplicable("HISTORICAL_OBLIGATION"),
      processingFees: notApplicable("HISTORICAL_OBLIGATION"),
      merchantBilled: notApplicable("HISTORICAL_OBLIGATION"),
      merchantPaid: notApplicable("HISTORICAL_OBLIGATION"),
      creatorPayout: known(0),
      outstanding: known(ledger.economics.historicalFixedFee),
      unresolved: [{ label: "Payment awaiting founder approval", amount: ledger.economics.historicalFixedFee }],
      note: "A fixed fee from before commission-only acquisition, kept read-only. It is already accrued as an expense and outstanding. Paying it still awaits founder approval, and approval is not a payment: nothing has been paid.",
    },
  ];
}

/** A difference with any work recorded on it. Detecting a difference and assigning it an owner is not work on it. */
const workRecorded = (d: Difference) => Boolean(d.reason || d.correctionRef || d.resolvedAt);

/** Payouts that are not matched: unresolved differences, plus resolved ones whose provider and QuickBooks references disagree. */
export function unmatchedPayouts(differences: Difference[]): Difference[] {
  return differences.filter((d) => !differenceResolved(d) || referenceState(d) !== "matched");
}

const figuresOf = (): VersionFigures => {
  const [collabs] = commissionSplitDemo("2026-10");
  const accrual = collabs!.accrual.value ?? 0;
  const reversals = collabs!.reversals.value ?? 0;
  return { accrual, reversals, netCommissionExpense: accrual - reversals, creatorPaid: collabs!.creatorPayout.value ?? 0, outstandingLiability: collabs!.outstanding.value ?? 0, pendingRecovery: 0 };
};

/** v2 figures: v1 plus the adjustment, in its direction. A reversal after payout cannot lower what was paid, so it is tracked as pending recovery. */
export function figuresAfter(v1: VersionFigures, direction: AdjustmentDirection, minor: number): VersionFigures {
  if (direction === "reversal") {
    return { ...v1, reversals: v1.reversals + minor, netCommissionExpense: v1.netCommissionExpense - minor, pendingRecovery: v1.pendingRecovery + minor };
  }
  return { ...v1, accrual: v1.accrual + minor, netCommissionExpense: v1.netCommissionExpense + minor, outstandingLiability: v1.outstandingLiability + minor };
}

export function closePackageDemo(period: string, scenario: string = DEFAULT_CLOSE_SCENARIO): ClosePackage | null {
  if (period !== "2026-10") return null;
  if (!isCloseScenario(scenario)) throw new RangeError(`Unknown close scenario "${scenario}".`);
  const s = scenario;
  let differences = baseDifferences();
  let cpa: ClosePackage["cpa"] = { state: "notRequested", signedAt: null };
  let exportState: ExportState = "none";
  let landedCost: ClosePackage["landedCost"] = { complete: true, missingSkus: [] };
  let adjustment: LateAdjustment | null = null;
  const v1: PackageVersion = { version: "v1", figures: figuresOf(), frozen: false, closedAt: null, cpaSignOff: null, reports: reports(period, "v1", "notGenerated") };
  const versions: PackageVersion[] = [v1];

  if (s === "reconciling") {
    // Work has begun: one payout is explained, corrected and matched; the other has a reason but no correction yet.
    differences = resolvedDifferences().map((d, i) => (i === 0 ? d : { ...d, correctionRef: null, resolvedAt: null, qboRef: null }));
  } else if (s === "landedcost") {
    differences = resolvedDifferences();
    landedCost = { complete: false, missingSkus: ["TEST-SKU-0004", "TEST-SKU-0007"] };
    v1.reports = reports(period, "v1", "notGenerated", { "Inventory valuation": { note: "Landed cost is incomplete, so inventory value can't be reported." } });
  } else if (s === "refmismatch") {
    differences = resolvedDifferences().map((d, i) => (i === 0 ? { ...d, qboRef: "TEST-QBO-DEP-9921" } : d));
  } else if (s === "awaitingcpa") {
    differences = resolvedDifferences();
    cpa = { state: "requested", signedAt: null };
  } else if (s === "readytoexport") {
    differences = resolvedDifferences();
    cpa = { state: "signedOff", signedAt: SIGNED_AT };
    v1.reports = reports(period, "v1", "queued");
    v1.cpaSignOff = SIGNED_AT;
  } else if (s === "exporting") {
    differences = resolvedDifferences();
    cpa = { state: "signedOff", signedAt: SIGNED_AT };
    exportState = "exporting";
    v1.reports = reports(period, "v1", "exporting");
    v1.cpaSignOff = SIGNED_AT;
  } else if (s === "exportfailed") {
    // Every report failed: nothing was exported that the package can vouch for.
    differences = resolvedDifferences();
    cpa = { state: "signedOff", signedAt: SIGNED_AT };
    exportState = "failed";
    v1.reports = reports(period, "v1", "failed");
    v1.cpaSignOff = SIGNED_AT;
  } else if (s === "partialexport") {
    // Two reports exported and carry receipts; the rest failed. The package is still failed, not partly closed.
    differences = resolvedDifferences();
    cpa = { state: "signedOff", signedAt: SIGNED_AT };
    exportState = "failed";
    v1.reports = reports(period, "v1", "failed", { "Profit & loss": { status: "exported", exportEvidence: `TEST-EXPORT-${period}-v1-01` }, "Balance sheet": { status: "exported", exportEvidence: `TEST-EXPORT-${period}-v1-02` } });
    v1.cpaSignOff = SIGNED_AT;
  } else if (s === "closed" || s === "lateadjustment") {
    differences = resolvedDifferences();
    cpa = { state: "signedOff", signedAt: SIGNED_AT };
    exportState = "exported";
    Object.assign(v1, { frozen: true, closedAt: CLOSED_AT, cpaSignOff: SIGNED_AT, reports: reports(period, "v1", "exported") });
    if (s === "lateadjustment") {
      adjustment = {
        id: "TEST-ADJ-0001",
        postedAt: "2026-11-04T09:00:00.000Z",
        amount: usd(3000),
        direction: "reversal",
        reason: "Provider reversal confirmed after the payout",
        sourceEvidence: "Provider adjustment line TEST-STMT-ADJ-0001",
        linkedReceipt: "TEST-RCPT-0090",
        effect: "reopened",
        priorVersion: "v1",
        newVersion: "v2",
        cpaSignOff: "Requested",
      };
      versions.push({ version: "v2", figures: figuresAfter(v1.figures, adjustment.direction, adjustment.amount.minorUnits), frozen: false, closedAt: null, cpaSignOff: null, reports: reports(period, "v2", "notGenerated") });
      cpa = { state: "requested", signedAt: null };
      exportState = "none";
    }
  }

  const unresolvedDifferences = differences.filter((d) => !differenceResolved(d)).length;
  const refIssues = differences.filter((d) => differenceResolved(d) && referenceState(d) !== "matched");
  const hardBlocked = !landedCost.complete || refIssues.length > 0;
  // The period has started only when some work is on record: a worked difference, a CPA request, an export, or a posted adjustment.
  const started = differences.some(workRecorded) || cpa.state !== "notRequested" || exportState !== "none" || adjustment !== null;
  const status = lifecycleStatusOf({ started, adjustmentOpen: adjustment !== null, hardBlocked, unresolvedDifferences, cpa: cpa.state, exportState });

  const blockers: CloseBlocker[] = [];
  if (adjustment) blockers.push({ reason: "ADJUSTMENT_REVIEW_OPEN", text: `Late adjustment ${adjustment.id} reopened review as ${adjustment.newVersion}. The ${adjustment.priorVersion} package is preserved.` });
  if (unresolvedDifferences > 0) blockers.push({ reason: "UNRESOLVED_DIFFERENCE", text: `${unresolvedDifferences} reconciliation difference${unresolvedDifferences === 1 ? "" : "s"} still need a reason, a linked correction and a resolved time.` });
  for (const d of refIssues) blockers.push({ reason: referenceState(d) === "mismatch" ? "REFERENCE_MISMATCH" : "REFERENCE_MISSING", text: `${d.payout}: provider reference ${d.providerRef} does not match QuickBooks reference ${d.qboRef ?? "(none)"}.` });
  if (!landedCost.complete) blockers.push({ reason: "LANDED_COST_INCOMPLETE", text: `Landed cost is missing for ${landedCost.missingSkus.length} SKUs (${landedCost.missingSkus.join(", ")}). Inventory can't be reported as final.` });
  if (!adjustment && cpa.state !== "signedOff") blockers.push({ reason: "CPA_SIGN_OFF_PENDING", text: cpa.state === "requested" ? "CPA sign-off was requested and has not been received." : "CPA sign-off has not been requested." });
  if (!adjustment && exportState !== "exported") blockers.push({ reason: "EXPORT_INCOMPLETE", text: exportState === "failed" ? "The export failed. Rerun it for the same period and report identities." : "The report package has not been exported." });

  const ledger = ledgerDemo();
  return {
    datasetKey: "finance-demo",
    version: "pkg1",
    period,
    label: "October",
    scenario: s,
    status,
    blockers,
    cpa,
    exportState,
    commissionCohort: {
      label: ledger.cohortLabel,
      orders: ledger.orders.initial,
      note: `Commission figures come from the ${ledger.cohortLabel} ledger (${ledger.orders.initial} orders). The dashboard's $12,596 receipts belong to the original example dataset. The two are separate datasets and are never added together.`,
    },
    landedCost,
    differences,
    versions,
    adjustment,
    paidReceipts: paidReceiptsDemo(),
    commissionSplit: commissionSplitDemo(period),
  };
}

const CHECK_LABEL: Record<ExportState, string> = { none: "Waiting", exporting: "Exporting", failed: "Export failed", exported: "Complete" };

/**
 * The close summary, derived from the same package as the "Close package and corrections" view so the two cannot disagree.
 * Nothing here is stored: status, checks, exceptions, CPA review and the report list all come from the package evidence.
 */
export function periodCloseDemo(period: string, scenario?: string): PeriodClose | null {
  const p = closePackageDemo(period, scenario);
  if (!p) return null;
  const current = p.versions[p.versions.length - 1]!;
  const exceptions = unmatchedPayouts(p.differences);
  const closed = p.status === "closed";
  const payout: CloseCheck =
    exceptions.length === 0 ? { check: "Payouts matched to bank", owner: "Finance", state: "complete", label: "Complete" } : { check: "Payouts matched to bank", owner: "Finance", state: "unmatched", label: `${exceptions.length} unmatched` };
  const exportCheck: CloseCheck = {
    check: "Reports exported to Drive",
    owner: "Finance",
    state: p.exportState === "exported" ? "complete" : p.exportState === "failed" ? "blocked" : "waiting",
    label: p.adjustment ? "Waiting" : CHECK_LABEL[p.exportState],
  };
  const signOff: CloseCheck = closed
    ? { check: "CPA sign-off and period close", owner: "CPA", state: "complete", label: "Complete" }
    : p.cpa.state === "requested"
      ? { check: "CPA sign-off and period close", owner: "CPA", state: "waiting", label: "Awaiting CPA" }
      : p.cpa.state === "signedOff"
        ? { check: "CPA sign-off and period close", owner: "CPA", state: "waiting", label: "Signed off" }
        : { check: "CPA sign-off and period close", owner: "CPA", state: "blocked", label: "Blocked" };
  return {
    datasetKey: "finance-demo",
    version: "close1",
    period,
    label: p.label,
    checks: [
      { check: "Sales, fees and refunds posted", owner: "Finance", state: "complete", label: "Complete" },
      p.landedCost.complete
        ? { check: "Inventory & sample COGS checked", owner: "Finance", state: "complete", label: "Complete" }
        : { check: "Inventory & sample COGS checked", owner: "Finance", state: "blocked", label: "Landed cost incomplete" },
      { check: "Creator and media costs posted", owner: "Finance", state: "complete", label: "Complete" },
      { check: "Sales tax reviewed", owner: "CPA", state: "complete", label: "Complete" },
      payout,
      exportCheck,
      signOff,
    ],
    closeOwner: "Finance lead",
    cpaReview: p.cpa.state === "signedOff" ? "Signed off" : p.cpa.state === "requested" ? "Requested" : "Not requested",
    status: p.status,
    exceptions: exceptions.map((d) => ({ payout: d.payout, expected: d.expected, difference: d.difference })),
    reports: current.reports.slice(0, 6).map((r) => ({
      name: r.name,
      state: r.status === "exported" ? `Exported (${r.exportEvidence})` : r.status === "failed" ? "Export failed: rerun pending" : r.status === "exporting" ? "Exporting" : r.status === "queued" ? "Queued for export" : "Awaiting close",
    })),
    exportFailed: p.exportState === "failed",
  };
}

// ---- Months and revisions, and the dry-run report manifest (FIN274-02/03, FIN-EVIDENCE) ----

export type MonthStatus = PeriodStatus | "revised";
export const MONTH_STATUS_LABEL: Record<MonthStatus, string> = { ...PERIOD_STATUS_LABEL, revised: "Revised" };
export type Revision = { n: number; at: string; reason: string; supersedes: number | null };
export type MonthRow = {
  period: string;
  label: string;
  status: MonthStatus;
  /** The revision the CPA last signed off, or null when no revision is signed. */
  signedRevision: number | null;
  signedAt: string | null;
  reopenedAt: string | null;
  revisions: Revision[];
  taxNote: string;
};

export type CpaTaxPolicy = { reference: string | null };
export const CPA_POLICY_NOT_SET: CpaTaxPolicy = { reference: null };
export const cpaPolicyLabel = (p: CpaTaxPolicy) => (p.reference ? `CPA tax-policy reference: ${p.reference}` : "CPA tax-policy reference: Not set");

/** A month is locked only while its current revision is the one a CPA signed off. Reopened and open months can change. */
export const currentRevision = (m: MonthRow) => m.revisions.reduce((a, r) => (r.n > a ? r.n : a), 0);
export const isLocked = (m: MonthRow) => (m.status === "closed" || m.status === "revised") && m.signedRevision !== null && m.signedRevision === currentRevision(m);
/** The revision a reader should use, and the ones it replaced, which stay readable. */
export const supersededBy = (m: MonthRow, n: number) => m.revisions.find((r) => r.supersedes === n)?.n ?? null;

const TAX = "Sales tax follows the jurisdictions recorded in the accounting package. This app sets no rate or rule.";

/** October's status is read from the close package, so the months list can't disagree with the close page or the package. */
export const monthsDemo = (scenario?: string): MonthRow[] => [
  { period: "2026-07", label: "July 2026", status: "closed", signedRevision: 1, signedAt: "2026-08-12", reopenedAt: null, revisions: [{ n: 1, at: "2026-08-12", reason: "Original close", supersedes: null }], taxNote: TAX },
  { period: "2026-08", label: "August 2026", status: "reopened", signedRevision: null, signedAt: null, reopenedAt: "2026-10-02", revisions: [{ n: 1, at: "2026-09-10", reason: "Original close", supersedes: null }], taxNote: `${TAX} Reopened for a late processor adjustment; it needs a new sign-off.` },
  { period: "2026-09", label: "September 2026", status: "revised", signedRevision: 2, signedAt: "2026-10-21", reopenedAt: null, revisions: [{ n: 1, at: "2026-10-09", reason: "Original close", supersedes: null }, { n: 2, at: "2026-10-21", reason: "A late refund was posted", supersedes: 1 }], taxNote: TAX },
  { period: "2026-10", label: "October 2026", status: closePackageDemo("2026-10", scenario)!.status, signedRevision: null, signedAt: null, reopenedAt: null, revisions: [], taxNote: `${TAX} The dry-run month is not signed off.` },
];

export type ManifestRow = { report: string; period: string; basis: string; source: string; expectedFiles: string[]; state: "Not generated"; generatedAt: null; checksum: null; policyRef: CpaTaxPolicy };
export type Manifest = { datasetKey: "finance-manifest-demo"; manifestId: string; period: string; label: string; synthetic: true; policy: CpaTaxPolicy; rows: ManifestRow[] };

/** The manifest lists the same seven reports and expected files as the close package, so the two can't name different reports. */
export const manifestDemo = (policy: CpaTaxPolicy = CPA_POLICY_NOT_SET): Manifest => ({
  datasetKey: "finance-manifest-demo",
  manifestId: "DRYRUN-2026-10-M0",
  period: "2026-10",
  label: "October 2026 dry run",
  synthetic: true,
  policy,
  rows: REPORT_FILES.map((r) => ({ report: r.name, period: "2026-10", basis: "Set in the accounting package; not read here", source: "QuickBooks (synthetic dry run, not connected)", expectedFiles: [`${r.slug}-2026-10.pdf`, `${r.slug}-2026-10.xlsx`], state: "Not generated" as const, generatedAt: null, checksum: null, policyRef: policy })),
});
