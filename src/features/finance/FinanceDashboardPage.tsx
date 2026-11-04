import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoney, formatMoneyExact } from "@/components/MetricValue";
import { Divider, FactList, FlatTable, HalfColumns, Meter, Notice, Page, PageHeader, Panel } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { SourceDialog } from "@/features/approvals/shared";
import { figure } from "@/features/operations/format";
import { runwayOf, type FinanceDashboard } from "@/fixtures/finance";
import { usd } from "@/fixtures/values";
import { FinanceNav } from "./FinanceNav";
import styles from "./Finance.module.css";

const whole = (minor: number) => formatMoney(usd(minor));
const exact = (minor: number) => formatMoneyExact(usd(minor));
const signed = (minor: number) => `${minor < 0 ? "−" : ""}${whole(Math.abs(minor))}`;
const compact = (minor: number) => `$${(minor / 100000).toFixed(1)}k`;

/**
 * Finance dashboard (Figma source 7:510, owner THO-303). Read-only management figures from QuickBooks. Net income, gross profit,
 * margin and runway are derived here from the source rows; year-to-date is unknown until its report arrives, never zero; and runway
 * is N/A with a reason when burn has too little history or isn't positive. The historical $70,000 raised is never used as current cash.
 */
export function FinanceDashboardPage() {
  const [search] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const query = useView<{ scenario?: string }, FinanceDashboard>("financeDashboard", scenario ? { scenario } : {});
  const [dialog, setDialog] = useState<null | "period" | "definitions" | { source: string }>(null);
  const res = query.data;
  const data = res?.data ?? null;
  return (
    <Page aria-labelledby="finance-title" data-figma-source="7:510">
      <PageHeader id="finance-title" title="Finance" subtitle="Know your cash, understand your margin, close with confidence.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 176 }} onClick={() => setDialog("period")}>Last 30 days</Button>
        <Button aria-haspopup="dialog" style={{ minWidth: 210 }} onClick={() => setDialog({ source: "Open QuickBooks" })}>Open QuickBooks</Button>
      </PageHeader>
      <FinanceNav current="overview" />
      <ReadState res={query.data} subject="The finance dashboard" only={["partial"]} />
      {query.isPending && <SkeletonCard label="Loading finance…" />}
      {query.isError && <ViewError error={query.error} subject="Finance" hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !data && <EmptyState state="Empty" title="No finance data yet"><p>QuickBooks responded, but no management report exists for this period.</p></EmptyState>}
      {res && data && <Body data={data} stale={res.dataState === "stale"} setDialog={setDialog} />}
      <Dialog open={dialog === "period"} title="The 30-day window" onClose={() => setDialog(null)}>
        <p>The figures cover the 30 days ending Oct 29, 2026. Calendar-month and year-to-date figures await their source reports, so there is no other period to choose in the demo.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <Dialog open={dialog === "definitions"} title="Metric definitions" badge="Read only" onClose={() => setDialog(null)}>
        <p>Gross margin is gross profit over net revenue. Pre-marketing contribution per order excludes acquisition and fixed spend. Burn is the average net cash out over the last three months, using the approved cash-flow definition. Runway is verified current cash divided by that burn, and reads N/A when there is too little history or no net spend.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <SourceDialog open={Boolean(dialog && typeof dialog === "object")} title={dialog && typeof dialog === "object" ? dialog.source : ""} url={null} onClose={() => setDialog(null)} />
    </Page>
  );
}

function Body({ data, stale, setDialog }: { data: FinanceDashboard; stale: boolean; setDialog: (d: null | "period" | "definitions" | { source: string }) => void }) {
  const p = data.pnl;
  const gross = p.revenue - p.cogs;
  const net = gross - p.opex;
  const runway = runwayOf(data);
  const margin = p.revenue > 0 ? (100 * gross) / p.revenue : null; // N/A over zero receipts, never NaN
  const rows: [string, number][] = [["Net revenue", p.revenue], ["Cost of goods sold", -p.cogs], ["Gross profit", gross], ["Operating expenses", -p.opex], ["Net income", net]];
  const actualVsForecast = data.forecastRevenue > 0 ? (100 * p.revenue) / data.forecastRevenue : null;
  const close = data.closeSummary;
  return (
    <>
      <Notice tone={stale ? "warning" : "violet"} label={stale ? "Behind" : "Source"} title="QuickBooks is the official ledger · Management P&L" role={stale ? "status" : undefined} testId="source-freshness">
        {`${data.period.label} · Illustrative management figures. Calendar-month and YTD figures await source reports.${stale ? " The mirror is behind its source." : ""}`}
      </Notice>
      <KpiRow>
        <Kpi label="Cash balance" context={`${whole(data.historicalRaised)} raised · as of ${data.cashAsOf}`} testId="metric-Cash balance">{figure(data.cash, (m) => whole(m))}</Kpi>
        <Kpi label="Monthly burn" context={data.burn.state === "known" ? "Average net cash out · last 3 months" : `Needs ${data.burnWindowMonths} months of history`} testId="metric-Monthly burn">{figure(data.burn, (m) => whole(m))}</Kpi>
        <Kpi label="Runway" context={runway.reason ?? "Current cash / average burn"} testId="metric-Runway">{runway.months === null ? "N/A" : `${runway.months.toFixed(1)} months`}</Kpi>
        <Kpi label="Pre-marketing contribution" context="Per order · creator allocation pending" testId="metric-Pre-marketing contribution">{exact(data.contributionPerOrder)}</Kpi>
      </KpiRow>
      <HalfColumns>
        <Panel title="Profit & loss" subtitle={`${data.period.label} · 30-day management P&L`} testId="pnl">
          <FlatTable
            caption="Profit and loss"
            testId="pnl-table"
            columns={[{ label: "Account", width: 326 }, { label: "30 days", width: 131 }, { label: "YTD", width: 131 }]}
            rows={rows.map(([account, minor]) => ({ key: account, cells: [account, signed(minor), figure(p.ytd, whole).replace("N/A", "Awaiting data")] }))}
          />
        </Panel>
        <Panel title="Cash & obligations" subtitle="Do not confuse cash with revenue" testId="cash">
          <dl className={styles.ledgerRows} aria-label="Cash and obligations">
            <div><dt>Cash</dt><dd>{figure(data.cash, whole)}</dd></div>
            <div><dt>Inventory · demo lot valuation</dt><dd>{whole(data.inventoryValue)}</dd></div>
            <div><dt>Accounts payable</dt><dd>{whole(data.accountsPayable)}</dd></div>
            <div><dt>Sales tax payable</dt><dd>{whole(data.salesTaxPayable)}</dd></div>
          </dl>
          <Divider />
          <p className={styles.sub}>Forecast vs. actual</p>
          <p className={styles.warnText}>Forecast is illustrative until rebaselined.</p>
          <FactList wide label="Forecast vs actual" rows={[["Revenue actual / forecast", `${compact(p.revenue)} / ${compact(data.forecastRevenue)}`]]} />
          {actualVsForecast === null ? <p className={styles.warnText}>No forecast to compare with.</p> : <Meter percent={actualVsForecast} label={`Revenue actual is ${actualVsForecast.toFixed(0)}% of the illustrative forecast`} />}
        </Panel>
      </HalfColumns>
      <HalfColumns>
        <Panel title="Unit economics" subtitle="Pre-marketing contribution excludes acquisition and fixed spend." testId="unit-economics">
          <FactList wide label="Unit economics" rows={[["Gross margin", margin === null ? "N/A" : `${margin.toFixed(1)}%`], ["Pre-marketing contribution / order", exact(data.contributionPerOrder)], ["CAC payback", "Awaiting creator allocation"], ["First-wave sample plan", `${data.samplesPlanned} units · planned allocation`]]} />
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 240, alignSelf: "flex-start" }} onClick={() => setDialog("definitions")}>View metric definitions</Button>
        </Panel>
        <Panel title="Month-end & compliance" subtitle="Review unresolved items before closing" testId="close-summary">
          <span><Badge tone="warning" width={210}>{close.label} · In progress</Badge></span>
          <FactList wide label="Close summary" rows={[["Payouts to reconcile", close.unmatchedPayouts], ["CPA sign-off", close.cpaSignOff]]} />
          <LinkButton to={`/finance/close/${close.period}`} style={{ minWidth: 236, alignSelf: "flex-start" }}>Open month-end close</LinkButton>
          <Divider />
          <h3 className={styles.h3}>No subscription revenue</h3>
          <p className={styles.footnote}>MRR and ARR appear only when subscription orders exist.</p>
        </Panel>
      </HalfColumns>
      <Panel large roomy title="Accrual, cash and provider ownership." subtitle="The original dashboard cohort is unchanged. The separate affiliate pilot has its own commission ledger and cost basis." testId="compensation">
        <p className={styles.footnote}>Recognize gross commission less reversals as expense. Provider cash settlement does not create a second expense or manual payment. Reconcile native billing, fees, payee and QBO references.</p>
        <div className={styles.actionsRow} style={{ gap: 16 }}>
          <LinkButton to="/finance/commissions" style={{ minWidth: 218 }}>Commission ledger</LinkButton>
          <LinkButton variant="secondary" to="/finance/settlements/COMM-DEMO-D" style={{ minWidth: 238 }}>Payout reconciliation</LinkButton>
          <LinkButton variant="ghost" to="/finance/payables/PAY-0012" style={{ minWidth: 210 }}>Direct content fee</LinkButton>
        </div>
      </Panel>
    </>
  );
}

