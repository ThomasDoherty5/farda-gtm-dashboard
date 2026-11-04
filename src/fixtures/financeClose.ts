/**
 * Month-end close package fixtures — SYNTHETIC. Extends the close dataset in `finance.ts` with the lifecycle, report package,
 * reconciliation difference, late adjustment and commission reporting detail the close acceptance asks for. These are not drawn in
 * the Figma source 7:683, so the screen that shows them says so. Amounts are minor units. Nothing here exports, signs off or pays:
 * every figure and receipt is fixture data, and "TEST-*" references are local fixture ids, not provider or QuickBooks identifiers.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import { ledgerDemo, ledgerTotals, STATE_LABEL, type CommissionState } from "./finance";
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

export type LateAdjustment = {
  id: string;
  postedAt: string;
  amount: Money;
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
export type CloseBlocker = { code: BlockerCode; text: string };

export type ClosePackage = {
  datasetKey: "finance-demo";
  version: string;
  period: string;
  label: string;
  scenario: string;
  status: PeriodStatus;
  blockers: CloseBlocker[];
  cpa: { state: CpaState; signedAt: string | null };
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

export const CLOSE_PACKAGE_SCENARIOS = ["open", "reconciling", "awaitingcpa", "readytoexport", "exporting", "exportfailed", "closed", "lateadjustment", "landedcost", "refmismatch"] as const;

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
      unresolved: [{ label: "Awaiting founder approval", amount: ledger.economics.historicalFixedFee }],
      note: "An accepted obligation from before commission-only acquisition. Nothing has been paid; approval is not a payment.",
    },
  ];
}

export function closePackageDemo(period: string, scenario = "reconciling"): ClosePackage | null {
  if (period !== "2026-10") return null;
  const s = (CLOSE_PACKAGE_SCENARIOS as readonly string[]).includes(scenario) ? scenario : "reconciling";
  let differences = baseDifferences();
  let cpa: ClosePackage["cpa"] = { state: "notRequested", signedAt: null };
  let exportState: ExportState = "none";
  let landedCost: ClosePackage["landedCost"] = { complete: true, missingSkus: [] };
  let started = true;
  let adjustment: LateAdjustment | null = null;
  const v1: PackageVersion = { version: "v1", frozen: false, closedAt: null, cpaSignOff: null, reports: reports(period, "v1", "notGenerated") };
  const versions: PackageVersion[] = [v1];

  if (s === "open") {
    started = false;
    differences = [];
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
        reason: "Provider reversal confirmed after the payout",
        sourceEvidence: "Provider adjustment line TEST-STMT-ADJ-0001",
        linkedReceipt: "TEST-RCPT-0090",
        effect: "reopened",
        priorVersion: "v1",
        newVersion: "v2",
        cpaSignOff: "Requested",
      };
      versions.push({ version: "v2", frozen: false, closedAt: null, cpaSignOff: null, reports: reports(period, "v2", "notGenerated") });
      cpa = { state: "requested", signedAt: null };
      exportState = "none";
    }
  }

  const unresolvedDifferences = differences.filter((d) => !differenceResolved(d)).length;
  const refIssues = differences.filter((d) => differenceResolved(d) && referenceState(d) !== "matched");
  const hardBlocked = !landedCost.complete || refIssues.length > 0;
  const status = lifecycleStatusOf({ started, adjustmentOpen: adjustment !== null, hardBlocked, unresolvedDifferences, cpa: cpa.state, exportState });

  const blockers: CloseBlocker[] = [];
  if (adjustment) blockers.push({ code: "ADJUSTMENT_REVIEW_OPEN", text: `Late adjustment ${adjustment.id} reopened review as ${adjustment.newVersion}. The ${adjustment.priorVersion} package is preserved.` });
  if (unresolvedDifferences > 0) blockers.push({ code: "UNRESOLVED_DIFFERENCE", text: `${unresolvedDifferences} reconciliation difference${unresolvedDifferences === 1 ? "" : "s"} still need a reason, a linked correction and a resolved time.` });
  for (const d of refIssues) blockers.push({ code: referenceState(d) === "mismatch" ? "REFERENCE_MISMATCH" : "REFERENCE_MISSING", text: `${d.payout}: provider reference ${d.providerRef} does not match QuickBooks reference ${d.qboRef ?? "(none)"}.` });
  if (!landedCost.complete) blockers.push({ code: "LANDED_COST_INCOMPLETE", text: `Landed cost is missing for ${landedCost.missingSkus.length} SKUs (${landedCost.missingSkus.join(", ")}). Inventory can't be reported as final.` });
  if (!adjustment && started && cpa.state !== "signedOff") blockers.push({ code: "CPA_SIGN_OFF_PENDING", text: cpa.state === "requested" ? "CPA sign-off was requested and has not been received." : "CPA sign-off has not been requested." });
  if (!adjustment && started && exportState !== "exported") blockers.push({ code: "EXPORT_INCOMPLETE", text: exportState === "failed" ? "The export failed. Rerun it for the same period and report identities." : "The report package has not been exported." });

  return {
    datasetKey: "finance-demo",
    version: "pkg1",
    period,
    label: "October",
    scenario: s,
    status,
    blockers,
    cpa,
    landedCost,
    differences,
    versions,
    adjustment,
    paidReceipts: paidReceiptsDemo(),
    commissionSplit: commissionSplitDemo(period),
  };
}
