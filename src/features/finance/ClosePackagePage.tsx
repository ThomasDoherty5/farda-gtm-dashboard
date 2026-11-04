import type { ReactNode } from "react";
import { useView } from "@/adapter/useView";
import { Badge, type BadgeTone } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { formatMoneyExact, MetricValue } from "@/components/MetricValue";
import { FactList, FlatTable, Note, Notice, PageHeader, Panel } from "@/components/Panels";
import { RecordShell } from "@/features/operations/RecordShell";
import { ADJUSTMENT_DIRECTION_LABEL, differenceResolved, PERIOD_STATUSES, PERIOD_STATUS_LABEL, REPORT_STATUS_LABEL, referenceState, type ClosePackage, type PackageVersion, type PeriodStatus, type ReportStatus } from "@/fixtures/financeClose";
import { usd } from "@/fixtures/values";
import { FinanceNav } from "./FinanceNav";
import styles from "./Finance.module.css";

const exact = (minor: number) => formatMoneyExact(usd(minor));
const REPORT_TONE: Record<ReportStatus, BadgeTone> = { notGenerated: "neutral", queued: "neutral", exporting: "violet", exported: "success", failed: "danger", superseded: "neutral" };
const STATUS_TONE: Record<PeriodStatus, BadgeTone> = { open: "neutral", reconciling: "warning", blocked: "danger", awaitingCpa: "warning", readyToExport: "violet", exporting: "violet", failed: "danger", closed: "success", reopened: "warning" };
const REFERENCE_LABEL = { matched: "Matched", mismatch: "Mismatch", missing: "No QuickBooks reference" } as const;
const when = (iso: string | null) => (iso ? iso.replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC") : null);

/**
 * Close package and corrections. Not drawn in Figma 7:683, so the layout is the shared panel and table components, not a design.
 * Read-only evidence: the lifecycle state, the expected files and export evidence of every report, reconciliation differences with
 * their owner, reason, linked correction and resolved time, a late adjustment, and the commission-aware reporting split.
 * No control here closes a period, signs off, exports or pays; those belong to the QuickBooks, CPA and export owners.
 */
export function ClosePackagePage({ period, scenario }: { period: string; scenario: string | undefined }) {
  const query = useView<{ period: string; scenario?: string }, ClosePackage>("closePackage", scenario ? { period, scenario } : { period });
  return (
    <RecordShell query={query} id="package-title" title={`Close package ${period}`} subject="close package" figma="7:683">
      {(_res, p) => <Body p={p} />}
    </RecordShell>
  );
}

function Body({ p }: { p: ClosePackage }) {
  return (
    <>
      <PageHeader id="package-title" title={`${p.label} close package`} subtitle="Finance / Month-end / Package · Evidence, not controls.">
        <LinkButton variant="secondary" to={`/finance/close/${p.period}`}>Back to the month-end close</LinkButton>
      </PageHeader>
      <FinanceNav current="close" />
      <Notice tone="violet" label="Synthetic" title={`Period status: ${PERIOD_STATUS_LABEL[p.status]}`} testId="package-notice">
        Fixture scenario “{p.scenario}”. This detail is not in the Figma source, so it uses the shared components and makes no fidelity claim. Nothing here closes the period, signs off, exports or pays.
      </Notice>
      <Notice tone="violet" label="Dataset" title={`Commission figures: ${p.commissionCohort.label}`} testId="cohort-notice">{p.commissionCohort.note}</Notice>
      <Panel title="Close states" subtitle="The current state is derived from the evidence below" testId="lifecycle">
        <ol className={styles.chips} aria-label="Close states">
          {PERIOD_STATUSES.map((s) => (
            <li key={s} aria-current={s === p.status ? "step" : undefined} data-state={s}>
              <Badge tone={s === p.status ? STATUS_TONE[s] : "neutral"}>{PERIOD_STATUS_LABEL[s]}{s === p.status && <span className="visually-hidden"> (current)</span>}</Badge>
            </li>
          ))}
        </ol>
        {p.blockers.length > 0 ? (
          <ul aria-label="Why the period is not closed" data-testid="blockers">
            {p.blockers.map((b) => <li key={b.reason + b.text} data-reason={b.reason}>{b.text}</li>)}
          </ul>
        ) : (
          <Note>Nothing outstanding in this fixture scenario.</Note>
        )}
        <FactList label="Sign-off and cost evidence" rows={[
          ["CPA sign-off", p.cpa.state === "signedOff" ? `Signed off ${when(p.cpa.signedAt)} (synthetic)` : p.cpa.state === "requested" ? "Requested, not received" : "Not requested"],
          ["Landed cost", p.landedCost.complete ? "Complete" : `Incomplete: ${p.landedCost.missingSkus.join(", ")}`],
        ]} />
      </Panel>
      <FiguresPanel p={p} />
      {p.versions.map((v) => <VersionPanel key={v.version} v={v} latest={v === p.versions[p.versions.length - 1]} />)}
      <Panel title="Reconciliation differences" subtitle="Each needs an owner, a reason, a linked correction and a resolved time" testId="differences">
        <FlatTable
          caption="Reconciliation differences"
          columns={[{ label: "Payout", width: 150 }, { label: "Difference", width: 100 }, { label: "Owner", width: 90 }, { label: "Reason", width: 190 }, { label: "Linked correction", width: 140 }, { label: "Resolved", width: 150 }, { label: "References", width: 170 }]}
          rows={p.differences.map((d) => ({
            key: d.payout,
            cells: [
              d.payout,
              exact(d.difference),
              d.owner ?? "Unassigned",
              d.reason ?? "Reason not recorded",
              d.correctionRef ?? "None linked",
              differenceResolved(d) ? when(d.resolvedAt) : "Unresolved",
              <Badge key="r" tone={referenceState(d) === "matched" ? "success" : "danger"}>{REFERENCE_LABEL[referenceState(d)]}</Badge>,
            ],
          }))}
        />
        {p.differences.length === 0 && <Note>No differences recorded yet. Reconciliation has not started.</Note>}
      </Panel>
      {p.adjustment && (
        <Panel title="Late adjustment" subtitle={`Reopened review as ${p.adjustment.newVersion}; ${p.adjustment.priorVersion} is preserved`} testId="adjustment">
          <FactList label="Late adjustment" rows={[
            ["Adjustment", `${p.adjustment.id} · ${p.adjustment.direction === "reversal" ? "−" : "+"}${exact(p.adjustment.amount.minorUnits)} · posted ${when(p.adjustment.postedAt)}`],
            ["Direction", ADJUSTMENT_DIRECTION_LABEL[p.adjustment.direction]],
            ["Effect on figures", `${p.adjustment.priorVersion} stays as closed. ${p.adjustment.newVersion} shows the adjusted figures above.`],
            ["Reason", p.adjustment.reason],
            ["Source evidence", p.adjustment.sourceEvidence],
            ["Linked paid receipt", `${p.adjustment.linkedReceipt} (unchanged)`],
            ["CPA sign-off", p.adjustment.cpaSignOff],
          ]} />
          <Note>The prior close and its reports are not rewritten. The adjustment is a linked record, and the new version needs its own review and export.</Note>
        </Panel>
      )}
      <Panel title="Paid receipts" subtitle="Immutable. A later reversal is an adjustment, never a rewrite" testId="receipts">
        <FlatTable caption="Paid receipts" columns={[{ label: "Receipt", width: 200 }, { label: "Group", width: 200 }, { label: "Amount", width: 140 }, { label: "State", width: 160 }]} rows={p.paidReceipts.map((r) => ({ key: r.receipt, cells: [r.receipt, r.groupId, exact(r.amount.minorUnits), "Immutable"] }))} />
      </Panel>
      <SplitPanel p={p} />
    </>
  );
}

function VersionPanel({ v, latest }: { v: PackageVersion; latest: boolean }) {
  const title = `Report package ${v.version}`;
  return (
    <Panel title={title} subtitle={v.frozen ? `Preserved prior package · closed ${when(v.closedAt)}` : latest ? "Current package · expected file, status, version and export evidence" : "Package"} testId={`package-${v.version}`}>
      <FlatTable
        caption={title}
        columns={[{ label: "Report", width: 190 }, { label: "Expected files", width: 300 }, { label: "Status", width: 130 }, { label: "Version", width: 80 }, { label: "Export evidence", width: 230 }]}
        rows={v.reports.map((r) => ({
          key: r.name,
          cells: [
            r.name,
            r.expectedFiles.join(", "),
            <Badge key="s" tone={REPORT_TONE[r.status]}>{REPORT_STATUS_LABEL[r.status]}</Badge>,
            r.version ?? "None",
            <span key="e">{r.exportEvidence ?? "No export evidence"}{r.note && <span style={{ display: "block", font: "var(--text-small)", color: "var(--color-muted)" }}>{r.note}</span>}</span>,
          ],
        }))}
      />
      <Note>A manual or browser fallback must meet the same checklist: every expected file, a status, a version and export evidence.</Note>
    </Panel>
  );
}

const FIGURE_ROWS: { label: string; key: keyof PackageVersion["figures"] }[] = [
  { label: "Accrued commission", key: "accrual" },
  { label: "Reversals", key: "reversals" },
  { label: "Net commission expense", key: "netCommissionExpense" },
  { label: "Paid to creators", key: "creatorPaid" },
  { label: "Outstanding liability", key: "outstandingLiability" },
  { label: "Pending recovery after payout", key: "pendingRecovery" },
];

/** The ledger figures behind each package version. A frozen version never changes; a later adjustment shows up in the next version only. */
function FiguresPanel({ p }: { p: ClosePackage }) {
  return (
    <Panel title="Figures by package version" subtitle={`Commission ledger · ${p.commissionCohort.label}`} testId="figures">
      <FlatTable
        caption="Figures by package version"
        columns={[{ label: "Measure", width: 260 }, ...p.versions.map((v) => ({ label: `${v.version}${v.frozen ? " (frozen)" : ""}`, width: 170 }))]}
        rows={FIGURE_ROWS.map((r) => ({ key: r.key, cells: [r.label, ...p.versions.map((v) => exact(v.figures[r.key]))] }))}
      />
      <Note>Expense is recognized at accrual, so cash paid does not reduce it again. A reversal after payout cannot lower what was paid: the receipt is immutable, so the amount waits as pending recovery until the source says how it is settled.</Note>
    </Panel>
  );
}

const pv = (value: Parameters<typeof MetricValue<number>>[0]["value"]): ReactNode => <MetricValue value={value} format={exact} />;

function SplitPanel({ p }: { p: ClosePackage }) {
  return (
    <Panel title="Commission reporting split" subtitle={`By provider, currency and period · ${p.commissionCohort.label}. Unknown is N/A, never $0`} testId="split">
      <FlatTable
        caption="Commission reporting split"
        columns={[{ label: "Provider", width: 170 }, { label: "Currency · period", width: 120 }, { label: "Accrual expense", width: 130 }, { label: "Reversals", width: 110 }, { label: "Processing fees", width: 120 }, { label: "Merchant billed", width: 130 }, { label: "Merchant paid", width: 130 }, { label: "Creator payout", width: 120 }, { label: "Outstanding liability", width: 140 }, { label: "Unresolved inside outstanding", width: 220 }]}
        rows={p.commissionSplit.map((r) => ({
          key: r.id,
          cells: [
            r.provider,
            `${r.currency} · ${r.period}`,
            pv(r.accrual),
            pv(r.reversals),
            pv(r.processingFees),
            pv(r.merchantBilled),
            pv(r.merchantPaid),
            pv(r.creatorPayout),
            pv(r.outstanding),
            r.unresolved.length > 0 ? r.unresolved.map((u) => `${u.label} ${exact(u.amount)}`).join(" · ") : r.outstanding.state === "known" ? "None" : "Not read",
          ],
        }))}
      />
      <ul aria-label="Split notes">{p.commissionSplit.map((r) => <li key={r.id}><strong>{r.provider}:</strong> {r.note}</li>)}</ul>
      <Note>Accrual, merchant billing and cash, creator payout and historical liabilities are separate measures. Held, disputed and waiting amounts stay in the outstanding liability.</Note>
    </Panel>
  );
}
