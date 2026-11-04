import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { Kpi } from "@/components/Kpi";
import { formatMoney } from "@/components/MetricValue";
import { BarRows, Divider, FactList, FlatTable, HalfColumns, Meter, Page, PageHeader, Panel } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { figure } from "@/features/operations/format";
import { runwayOf, type FinanceDashboard } from "@/fixtures/finance";
import { usd } from "@/fixtures/values";
import styles from "./Finance.module.css";

const whole = (minor: number) => formatMoney(usd(minor));
const k = (minor: number) => `$${(minor / 100000).toFixed(1)}k`;
const MONTHS = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan"];
// Geometry of Figma 20:409: gridlines at y 20, 130 and 240 stand for $70k, $35k and $0, and each month is a 120px column.
const Y0 = 240;
const PER_K = 220 / 70;
const yOf = (minor: number) => Y0 - (minor / 100000) * PER_K;
const xOf = (i: number) => 60 + 120 * i;

/**
 * Finance analytics (Figma source 12:1006, owner THO-303). Read-only. The cash chart is drawn from the plotted source points, so the
 * axis, the labels and the table agree; the projection is a dashed, illustrative line that needs three months of burn history,
 * and the historical $70,000 raised is context beside current cash, never the cash itself.
 */
export function FinanceAnalyticsPage() {
  const [search] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const query = useView<{ scenario?: string }, FinanceDashboard>("financeDashboard", scenario ? { scenario } : {});
  const [dialog, setDialog] = useState(false);
  const res = query.data;
  const data = res?.data ?? null;
  return (
    <Page aria-labelledby="pulse-title" data-figma-source="12:1006">
      <PageHeader id="pulse-title" title="Financial pulse" subtitle="Cash, margin and reconciliation in one clear view.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 180 }} onClick={() => setDialog(true)}>Last 30 days</Button>
        <LinkButton to="/finance" style={{ minWidth: 200 }}>View statements</LinkButton>
      </PageHeader>
      <ReadState res={query.data} subject="Finance analytics" only={["partial"]} />
      {query.isPending && <SkeletonCard label="Loading financial pulse…" />}
      {query.isError && <ViewError error={query.error} subject="Financial pulse" hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !data && <EmptyState state="Empty" title="No finance data yet"><p>QuickBooks responded, but no management report exists for this period.</p></EmptyState>}
      {res && data && <Body data={data} stale={res.dataState === "stale"} />}
      <Dialog open={dialog} title="The 30-day window" onClose={() => setDialog(false)}>
        <p>The figures cover the 30 days ending Oct 29, 2026. The demo holds no other window.</p>
        <Button variant="secondary" onClick={() => setDialog(false)}>Close</Button>
      </Dialog>
    </Page>
  );
}

function Body({ data, stale }: { data: FinanceDashboard; stale: boolean }) {
  const p = data.pnl;
  const gross = p.revenue - p.cogs;
  const runway = runwayOf(data);
  const burn = data.burn.state === "known" && data.burn.value !== null && data.burnHistoryMonths >= data.burnWindowMonths ? data.burn.value : null;
  const current = data.cashHistory[data.cashHistory.length - 1]!;
  const future = burn !== null && burn > 0 ? [1, 2, 3].map((n) => ({ month: MONTHS[data.cashHistory.length - 1 + n]!, minor: Math.max(current.minor - burn * n, 0) })) : [];
  const peak = Math.max(...data.costBreakdown.map((c) => c.minor));
  const matched = data.payouts.reduce((n, r) => n + r.matched, 0);
  const review = data.payouts.reduce((n, r) => n + r.needsReview, 0);
  const matchedPct = Math.round((100 * matched) / (matched + review));
  const actual = data.cashHistory.map((c, i) => ({ ...c, x: xOf(i), y: yOf(c.minor) }));
  const line = actual.map((a) => `${a.x} ${a.y}`).join("L");
  const projected = [{ x: xOf(actual.length - 1), y: actual[actual.length - 1]!.y }, ...future.map((f, i) => ({ x: xOf(actual.length + i), y: yOf(f.minor) }))];
  const summary = `Observed cash fell from ${k(data.cashHistory[0]!.minor)} in ${data.cashHistory[0]!.month} to ${k(current.minor)} in ${current.month}.${future.length ? ` An illustrative projection reaches ${k(future[future.length - 1]!.minor)} by ${future[future.length - 1]!.month} at ${whole(burn!)} a month.` : " No projection is drawn: burn needs more history."}`;
  return (
    <>
      <p className={styles.metaLine} data-testid="source-freshness" role={stale ? "status" : undefined}>{`Demo data  ·  ${data.period.label}  ·  Management P&L  ·  Last synced 6:00 AM PT${stale ? "  ·  Behind its source" : ""}`}</p>
      <div className={styles.analytics}>
        <div className={styles.kpiStack}>
          <Kpi label="Cash available" context={`${whole(data.historicalRaised)} total capital raised`} testId="metric-Cash available">{figure(data.cash, whole)}</Kpi>
          <Kpi label="Gross margin" context={`${whole(gross)} gross profit / ${whole(p.revenue)} receipts`} testId="metric-Gross margin">{((100 * gross) / p.revenue).toFixed(1)}%</Kpi>
          <Kpi label="Runway" context={runway.reason ?? `At ${whole(burn!)} average monthly burn`} testId="metric-Runway">{runway.months === null ? "N/A" : `${runway.months.toFixed(1)} months`}</Kpi>
        </div>
        <Panel
          id="trajectory-title"
          testId="trajectory"
          header={
            <div className={styles.chartHead}>
              <h2 id="trajectory-title" className={styles.h3}>Cash trajectory</h2>
              <span className={styles.chartGap} aria-hidden="true" />
              <span className={styles.badgeRow} aria-hidden="true"><Badge tone="violet" width={104}>Actual</Badge><Badge width={136}>Illustrative</Badge></span>
            </div>
          }
        >
          <p className={styles.footnote}>Demo observed balances in solid violet · future dashed values assume {burn !== null ? whole(burn) : "no"} monthly burn.</p>
          <div className={styles.plotScroll} role="region" aria-label="Cash trajectory chart" tabIndex={0}>
            <div className={styles.cashChart}>
              <svg viewBox="0 0 844 260" width="844" height="260" role="img" aria-label={summary} className={styles.cashSvg}>
                {[20, 130, 240].map((y) => <line key={y} x1="48" x2="828" y1={y} y2={y} stroke="#EBE8F4" />)}
                <path d={`M${line}L${actual[actual.length - 1]!.x} ${Y0}L${actual[0]!.x} ${Y0}Z`} fill="#F0EBFF" />
                <path d={`M${line}`} fill="none" stroke="#6547F5" strokeWidth="5" strokeLinecap="round" />
                {projected.length > 1 && <path d={`M${projected.map((q) => `${q.x} ${q.y}`).join("L")}`} fill="none" stroke="#A594F8" strokeWidth="4" strokeDasharray="10 10" />}
                <circle cx={actual[actual.length - 1]!.x} cy={actual[actual.length - 1]!.y} r="7" fill="#6547F5" />
              </svg>
              {[...actual.map((a) => ({ ...a, solid: true })), ...future.map((f, i) => ({ ...f, x: xOf(actual.length + i), y: yOf(f.minor), solid: false }))].map((pt) => (
                <span key={pt.month} className={styles.cashLabel} data-solid={pt.solid} style={{ left: pt.x - 45, top: pt.y - 28 }}>{k(pt.minor)}</span>
              ))}
              {["$70k", "$35k", "$0"].map((l, i) => <span key={l} className={styles.cashAxis} style={{ top: 12 + 110 * i }}>{l}</span>)}
              <div className={styles.months} aria-hidden="true">{MONTHS.map((m) => <span key={m}>{m}</span>)}</div>
            </div>
            <table className="visually-hidden">
              <caption>Cash by month. The first four are observed; any others are illustrative.</caption>
              <thead><tr><th scope="col">Month</th><th scope="col">Cash</th><th scope="col">Basis</th></tr></thead>
              <tbody>{[...actual.map((a) => [a.month, a.minor, "Observed"] as const), ...future.map((f) => [f.month, f.minor, "Illustrative"] as const)].map(([m, v, b]) => <tr key={m}><th scope="row">{m}</th><td>{whole(v)}</td><td>{b}</td></tr>)}</tbody>
            </table>
          </div>
          <Divider />
          <FactList wide labelWidth={354} label="Cash and capital raised" rows={[["Current cash / raised", `${figure(data.cash, whole)} / ${whole(data.historicalRaised)}`]]} />
        </Panel>
      </div>
      <HalfColumns>
        <Panel title={`Where ${whole(p.revenue)} goes`} subtitle="Last 30 days · before marketing and fixed expense" testId="breakdown">
          <BarRows label="Order contribution breakdown" max={600000} gap={16} widths={[126, 350, 80]} rows={data.costBreakdown.map((c) => ({ label: c.label, value: c.minor, display: whole(c.minor).replace(",", "") }))} />
          <p className={styles.footnote}>Pre-marketing contribution: {formatMoney({ minorUnits: data.contributionPerOrder, currency: "USD" })}/order. Contribution after attributed creator cost awaits allocation.</p>
          {peak > 600000 && <p className="visually-hidden">A value exceeds the bar scale.</p>}
        </Panel>
        <Panel title="Payout reconciliation" subtitle="Match source payout → ledger → bank" testId="payouts">
          <p className={styles.bigValue} data-testid="metric-Payouts matched">{matchedPct}% matched</p>
          <Meter percent={matchedPct} label={`${matched} of ${matched + review} payouts matched`} />
          <FlatTable
            caption="Payout reconciliation by channel"
            columns={[{ label: "Channel", width: 266 }, { label: "Matched", width: 160 }, { label: "Needs review", width: 162 }]}
            rows={data.payouts.map((r) => ({ key: r.channel, cells: [r.channel, `${r.matched} payouts`, `${r.needsReview} payout`] }))}
          />
          <span><Badge tone="warning" width={242}>{review} differences to resolve</Badge></span>
          <LinkButton to="/finance/close/2026-10" style={{ minWidth: 254, alignSelf: "flex-start" }}>Review month-end close</LinkButton>
        </Panel>
      </HalfColumns>
    </>
  );
}
