/**
 * Month status history and the dry-run report manifest (FIN274-02, FIN274-03, FIN-EVIDENCE) — SYNTHETIC. No period here is closed
 * in a real ledger, and no report exists. No tax rule is invented: the CPA tax-policy reference is "Not set" until a CPA provides one.
 */
export type MonthStatus = "open" | "closed" | "reopened" | "revised";
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

export const monthsDemo: MonthRow[] = [
  { period: "2026-07", label: "July 2026", status: "closed", signedRevision: 1, signedAt: "2026-08-12", reopenedAt: null, revisions: [{ n: 1, at: "2026-08-12", reason: "Original close", supersedes: null }], taxNote: TAX },
  { period: "2026-08", label: "August 2026", status: "reopened", signedRevision: null, signedAt: null, reopenedAt: "2026-10-02", revisions: [{ n: 1, at: "2026-09-10", reason: "Original close", supersedes: null }], taxNote: `${TAX} Reopened for a late processor adjustment; it needs a new sign-off.` },
  { period: "2026-09", label: "September 2026", status: "revised", signedRevision: 2, signedAt: "2026-10-21", reopenedAt: null, revisions: [{ n: 1, at: "2026-10-09", reason: "Original close", supersedes: null }, { n: 2, at: "2026-10-21", reason: "A late refund was posted", supersedes: 1 }], taxNote: TAX },
  { period: "2026-10", label: "October 2026", status: "open", signedRevision: null, signedAt: null, reopenedAt: null, revisions: [], taxNote: `${TAX} The dry-run month is not signed off.` },
];

export type ManifestRow = { report: string; period: string; basis: string; source: string; state: "Not generated"; generatedAt: null; checksum: null; policyRef: CpaTaxPolicy };
export type Manifest = { datasetKey: "finance-manifest-demo"; manifestId: string; period: string; label: string; synthetic: true; policy: CpaTaxPolicy; rows: ManifestRow[] };

const REPORTS = ["Profit & loss", "Balance sheet", "Cash flow", "Sales tax", "Inventory valuation", "Payout reconciliation"];
export const manifestDemo = (policy: CpaTaxPolicy = CPA_POLICY_NOT_SET): Manifest => ({
  datasetKey: "finance-manifest-demo",
  manifestId: "DRYRUN-2026-10-M0",
  period: "2026-10",
  label: "October 2026 dry run",
  synthetic: true,
  policy,
  rows: REPORTS.map((report) => ({ report, period: "2026-10", basis: "Set in the accounting package; not read here", source: "QuickBooks (synthetic dry run, not connected)", state: "Not generated" as const, generatedAt: null, checksum: null, policyRef: policy })),
});
