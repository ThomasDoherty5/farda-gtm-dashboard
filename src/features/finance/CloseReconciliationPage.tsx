import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import type { ReadResponse } from "@/adapter/contract";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { formatMoneyExact } from "@/components/MetricValue";
import { Divider, FactList, FlatTable, HalfColumns, Meter, Note, Notice, PageHeader, Panel, TwoColumns } from "@/components/Panels";
import { SourceDialog, blockedReason } from "@/features/approvals/shared";
import { RecordShell } from "@/features/operations/RecordShell";
import type { CloseState, PeriodClose } from "@/fixtures/finance";
import { PERIOD_STATUS_LABEL, type PeriodStatus } from "@/fixtures/financeClose";
import { usd } from "@/fixtures/values";
import { ClosePackagePage } from "./ClosePackagePage";
import { ManifestView, MonthsView } from "./CloseViews";
import { FinanceNav } from "./FinanceNav";
import styles from "./Finance.module.css";

const exact = (minor: number) => formatMoneyExact(usd(minor));
/** The Figma wording for a month that really is open ("Open month"); every other state uses its own name. */
const statusWords = (status: PeriodStatus) => (status === "open" ? "Open month" : PERIOD_STATUS_LABEL[status]);
const COUNT_WORDS = ["no", "one", "two"];
const noticeBody = (c: PeriodClose) =>
  c.exceptions.length > 0
    ? `Resolve the ${COUNT_WORDS[c.exceptions.length] ?? c.exceptions.length} unmatched payout${c.exceptions.length === 1 ? "" : "s"} before CPA review.`
    : c.status === "closed"
      ? "Every check is complete and the report package is exported. A closed period is locked."
      : "No payouts are unmatched. The checks below still stand between this month and its close.";

const TONE: Record<CloseState, BadgeTone> = { complete: "success", unmatched: "warning", waiting: "neutral", blocked: "neutral" };

/**
 * Close and reconciliation (Figma source 7:683, owner THO-303). Read-only: a month is closed by its accounting package and a CPA
 * sign-off, never by a count here. Progress is derived from the checks, official records are the QuickBooks exports, and a failed
 * export keeps the month visible as incomplete.
 */
export function CloseReconciliationPage() {
  const { period = "" } = useParams();
  const [search] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const view = search.get("view");
  if (view === "package") return <ClosePackagePage period={period} scenario={scenario} />;
  if (view === "months") return <MonthsView />;
  if (view === "manifest") return <ManifestView />;
  return <CloseSummary period={period} scenario={scenario} />;
}

function CloseSummary({ period, scenario }: { period: string; scenario: string | undefined }) {
  const query = useView<{ period: string; scenario?: string }, PeriodClose>("periodClose", scenario ? { period, scenario } : { period });
  const [dialog, setDialog] = useState<null | "reconciliation" | { source: string }>(null);
  return (
    <RecordShell query={query} id="close-title" title={`Close ${period}`} subject="accounting period" figma="7:683">
      {(res, c) => <Body res={res} c={c} scenario={scenario} dialog={dialog} setDialog={setDialog} />}
    </RecordShell>
  );
}

function Body({ res, c, scenario, dialog, setDialog }: { res: ReadResponse<PeriodClose>; c: PeriodClose; scenario: string | undefined; dialog: null | "reconciliation" | { source: string }; setDialog: (d: null | "reconciliation" | { source: string }) => void }) {
  const done = c.checks.filter((k) => k.state === "complete").length;
  const total = c.checks.length;
  const unmatched = c.checks.find((k) => k.state === "unmatched");
  const blocked = blockedReason(res, "closePeriod");
  const complete = done === total;
  return (
    <>
      <PageHeader id="close-title" title={`${c.label} close`} subtitle="Finance / Month-end · Evidence before sign-off.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 210 }} onClick={() => setDialog({ source: "Open QuickBooks" })}>Open QuickBooks</Button>
        <Button aria-haspopup="dialog" style={{ minWidth: 210 }} onClick={() => setDialog({ source: "View the report folder" })}>View report folder</Button>
      </PageHeader>
      <FinanceNav current="close" />
      <Notice tone="warning" label="Review" title={`${statusWords(c.status)} · ${done} of ${total} checks complete`} testId="close-notice">
        {c.exportFailed ? "The report export failed, so the month stays incomplete. " : ""}{noticeBody(c)} Official records are the QuickBooks exports linked below.
      </Notice>
      <TwoColumns>
        <Panel title="Close checklist" subtitle="Source: Notion close template · accountable owner on every step" testId="checklist">
          <FlatTable
            caption="Close checklist"
            testId="checklist-table"
            columns={[{ label: "Check", width: 456 }, { label: "Owner", width: 148 }, { label: "State", width: 172 }]}
            rows={c.checks.map((k) => ({ key: k.check, cells: [k.check, k.owner, <Badge key="s" tone={TONE[k.state]} width={140}>{k.label}</Badge>] }))}
          />
        </Panel>
        <Panel title="October 2026" subtitle="Synthetic dry-run period" roomy testId="progress">
          <p className={styles.progressValue} data-testid="metric-Close progress">{done} / {total}</p>
          <Meter percent={(100 * done) / total} label={`${done} of ${total} checks complete`} />
          <FactList label="Close status" rows={[["Close owner", c.closeOwner], ["CPA review", c.cpaReview], ["Period status", PERIOD_STATUS_LABEL[c.status]]]} />
          <Divider />
          <Note>A closed period is locked in the ledger. Reopen only through the source review process.</Note>
          <Button aria-haspopup="dialog" style={{ minWidth: 230, alignSelf: "flex-start" }} onClick={() => setDialog({ source: "Open the close checklist" })}>Open close checklist</Button>
          {!complete && <p className="visually-hidden">{blocked}</p>}
        </Panel>
      </TwoColumns>
      <HalfColumns>
        <Panel title="Reconciliation exceptions" subtitle="Match source payout, ledger posting and bank receipt" testId="exceptions">
          <FlatTable
            caption="Reconciliation exceptions"
            columns={[{ label: "Payout", width: 296 }, { label: "Expected", width: 146 }, { label: "Difference", width: 146 }]}
            rows={c.exceptions.map((x) => ({ key: x.payout, cells: [x.payout, exact(x.expected), exact(x.difference)] }))}
          />
          <Note>Unmatched does not mean lost money. Inspect fees, timing, refunds and currency in QuickBooks.</Note>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 226, alignSelf: "flex-start" }} onClick={() => setDialog("reconciliation")}>Open reconciliation</Button>
        </Panel>
        <section id="reports" aria-labelledby="reports-title">
          <Panel id="reports-title" title="One complete report package" subtitle="Generated reports retain period and export timestamp" testId="reports">
            <FactList wide label="Report package" rows={c.reports.map((r) => [r.name, r.state])} />
            <Divider />
            <Note>Export failure keeps the month visible as incomplete. A rerun must preserve the period and report{" "}<br />identity.</Note>
          </Panel>
        </section>
      </HalfColumns>
      <Dialog open={dialog === "reconciliation"} title={`${c.label} reconciliation`} badge="Read only" onClose={() => setDialog(null)}>
        <p>{unmatched ? unmatched.label : "No unmatched payouts"}. Each stays with its posting owner until the source difference is explained.</p>
        <FactList label="Unmatched items" rows={c.exceptions.map((x) => [x.payout, `${exact(x.expected)} expected · ${exact(x.difference)} difference · posting owner: Finance`] as [string, string])} />
        <FactList label="Policy" rows={[["CPA tax-policy reference", "Not set"], ["Difference evidence", "Fees, timing, refunds and currency, in QuickBooks"]]} />
        <p>Opening this does not close the books.</p>
        <LinkButton variant="secondary" to="/finance/settlements/COMM-DEMO-D">Payout reconciliation</LinkButton>
        <LinkButton variant="secondary" to={`/finance/close/${c.period}?view=package${scenario ? `&scenario=${scenario}` : ""}`}>Close package and corrections</LinkButton>
        <LinkButton variant="secondary" to="/finance/close/2026-10?view=months">Months and revisions</LinkButton>
        <LinkButton variant="secondary" to="/finance/close/2026-10?view=manifest">Dry-run manifest</LinkButton>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <SourceDialog open={Boolean(dialog && typeof dialog === "object")} title={dialog && typeof dialog === "object" ? dialog.source : ""} url={null} onClose={() => setDialog(null)} />
    </>
  );
}
