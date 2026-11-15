import { FinanceReadGrant, type FinanceReadQuery } from "./FinanceReadGrant";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Period } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
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
import { financeHeadlines } from "@/creator-agent/finance/headlines";
import { reportingRoute, useReportingPeriod } from "@/features/analytics/reportingPeriod";
import { figure } from "@/features/operations/format";
import { runwayOf, type FinanceDashboard } from "@/fixtures/finance";
import { usd } from "@/fixtures/values";
import styles from "./Finance.module.css";
import { explain, figureText, financeEconomicsOf, ueFormat, type FinanceDisplayRecord } from "./unitEconomics";

const payoutCount = (n: number) => `${n} ${n === 1 ? "payout" : "payouts"}`;

const whole = (minor: number) => formatMoney(usd(minor));
const k = (minor: number) => `$${(minor / 100000).toFixed(1)}k`;
const MONTHS = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan"];
// Geometry of Figma 20:409: gridlines at y 20, 130 and 240 stand for $70k, $35k and $0, and each month is a 120px column.
const Y0 = 240;
const PER_K = 220 / 70;
const yOf = (minor: number) => Y0 - (minor / 100000) * PER_K;
const xOf = (i: number) => 60 + 120 * i;

/**
 * Finance analytics (Figma source 12:1006, owner THO-303). The demo preserves the original
 * illustrative trajectory. Native cash balances use the accounting report and its observations.
 */
export function FinanceAnalyticsPage() {
  const [search] = useSearchParams();
  const { adapter } = useScope();
  const period = useReportingPeriod();
  const native = adapter.kind !== "demo";
  const scenario = search.get("scenario") ?? undefined;
  const filters = period ? { startAt: period.startAt, endAt: period.endAt, timezone: period.timezone } : !native && scenario ? { scenario } : {};
  const query = useView<typeof filters, FinanceDisplayRecord>("financeDashboard", filters);
  return <FinanceReadGrant query={query} title="Financial pulse" titleId="pulse-title"><FinanceAnalyticsContent query={query} native={native} requestedPeriod={period} /></FinanceReadGrant>;
}

function FinanceAnalyticsContent({ query, native, requestedPeriod }: { query: FinanceReadQuery<FinanceDisplayRecord>; native: boolean; requestedPeriod: Period | null }) {
  const [dialog, setDialog] = useState(false);
  const res = query.data;
  const data = res?.data ?? null;
  const context = data?.summaryContext;
  const observedAt = res?.sourceFreshness.find(row => row.sourceRef.source === "finance-source")?.observedAt ?? data?.provenance?.observedAt;
  return (
    <Page aria-labelledby="pulse-title" data-figma-source="12:1006">
      <PageHeader id="pulse-title" title="Financial pulse" subtitle="Cash, margin and reconciliation in one clear view.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 180 }} onClick={() => setDialog(true)}>{native ? "Reporting period" : "Last 30 days"}</Button>
        <LinkButton to={reportingRoute("/finance", context?.period ?? requestedPeriod)} style={{ minWidth: 200 }}>View statements</LinkButton>
      </PageHeader>
      <ReadState res={query.data} subject="Finance analytics" only={["partial"]} />
      {query.isPending && <SkeletonCard label="Loading financial pulse…" />}
      {query.isError && <ViewError error={query.error} subject="Financial pulse" hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !data && <EmptyState state="Empty" title="No finance data yet"><p>The finance source returned no management report for this period.</p></EmptyState>}
      {res && data && <Body data={data} stale={res.dataState === "stale"} coverageComplete={res.coverage.complete === true} observedAt={observedAt} />}
      <Dialog open={dialog} title={native ? "Reporting period" : "The 30-day window"} onClose={() => setDialog(false)}>
        {native ? <p>{context ? `${context.period.startAt} to ${context.period.endAt} (exclusive) · ${context.period.timezone} · ${context.accountingBasis} basis. Accounting policy ${context.policy.state}.` : "The finance source has not supplied a qualified reporting period."}</p>
          : <p>The figures cover the 30 days ending Oct 29, 2026. The demo holds no other window.</p>}
        <Button variant="secondary" onClick={() => setDialog(false)}>Close</Button>
      </Dialog>
    </Page>
  );
}

function Body({ data, stale, coverageComplete, observedAt }: { data: FinanceDisplayRecord; stale: boolean; coverageComplete: boolean; observedAt?: string }) {
  const p = data.pnl;
  const gross = p.revenue - p.cogs;
  const native = data.datasetKey === "finance-native";
  const context = data.summaryContext;
  const headline = native ? financeHeadlines(data) : null;
  const { margin, perOrder } = financeEconomicsOf(data);
  const runway = headline ? { months: headline.runwayMonths, reason: headline.runwayReason } : runwayOf(data as FinanceDashboard);
  const cash = headline ? headline.cash === null ? "N/A" : whole(headline.cash) : figure(data.cash, whole);
  const cashAsOf = context?.cashAsOf;
  const cashContext = native ? headline?.reason ?? (cashAsOf ? `As of ${cashAsOf}` : "Cash observation unavailable") : `${whole(data.historicalRaised)} total capital raised`;
  const burn = data.burn.state === "known" && data.burn.value !== null && data.burnHistoryMonths >= data.burnWindowMonths ? data.burn.value : null;
  const breakdown = headline?.actualRevenue === null ? [] : data.costBreakdown;
  const peak = breakdown.reduce((max, row) => Math.max(max, row.minor), 0);
  const matched = data.payouts.reduce((n, r) => n + r.matched, 0);
  const review = data.payouts.reduce((n, r) => n + r.needsReview, 0);
  const matchedPct = matched + review > 0 ? Math.round((100 * matched) / (matched + review)) : null;
  const payoutEvidence = !native || coverageComplete || matchedPct !== null;
  const closePeriod = data.closeSummary.period;
  const closeRoute = !native || /^\d{4}-(0[1-9]|1[0-2])$/.test(closePeriod) ? `/finance/close/${closePeriod}` : null;
  const balances = headline?.reason ? [] : data.cashHistory;
  const source = data.provenance?.evidenceStage === "synthetic" ? "Synthetic test data" : context ? "QuickBooks · Management P&L" : "Finance source report";
  const nativeMeta = [source, context ? `${context.period.startAt} to ${context.period.endAt} (exclusive) · ${context.period.timezone} · ${context.accountingBasis} basis` : "Qualified reporting period unavailable", observedAt ? `Last source observation ${observedAt}` : "Source observation time unavailable"].join("  ·  ");
  const demoMeta = `Demo data  ·  ${data.period.label}  ·  Management P&L  ·  Last synced 6:00 AM PT`;
  return (
    <>
      <p className={styles.metaLine} data-testid="source-freshness" role={stale ? "status" : undefined}>{`${native ? nativeMeta : demoMeta}${stale ? "  ·  Behind its source" : ""}`}</p>
      <div className={styles.analytics}>
        <div className={styles.kpiStack}>
          <Kpi label="Cash available" context={cashContext} testId="metric-Cash available">{cash}</Kpi>
          <Kpi label="Gross margin" context={margin.state === "notApplicable" ? explain(margin) : `${margin.state === "provisional" ? `Provisional · ${explain(margin)} · ` : ""}${whole(gross)} gross profit / ${whole(p.revenue)} receipts`} testId="metric-Gross margin">{margin.value === null ? "N/A" : ueFormat.percent(margin.value)}</Kpi>
          <Kpi label="Runway" context={runway.reason ?? `At ${whole(burn!)} average monthly burn`} testId="metric-Runway">{runway.months === null ? "N/A" : `${runway.months.toFixed(1)} months`}</Kpi>
        </div>
        <Panel
          id="trajectory-title"
          testId="trajectory"
          header={
            <div className={styles.chartHead}>
              <h2 id="trajectory-title" className={styles.h3}>Cash trajectory</h2>
              <span className={styles.chartGap} aria-hidden="true" />
              <span className={styles.badgeRow} aria-hidden="true">{(!native || balances.length > 0) && <Badge tone="violet" width={104}>Actual</Badge>}{!native && <Badge width={136}>Illustrative</Badge>}</span>
            </div>
          }
        >
          <p className={styles.footnote}>{native ? balances.length > 0 ? "Observed cash balances · Forecast points unavailable." : "Observed cash history is unavailable for this report."
            : <>Demo observed balances in solid violet · future dashed values assume {burn !== null ? whole(burn) : "no"} monthly burn.</>}</p>
          <CashChart balances={balances} native={native} burn={burn} />
          <Divider />
          <FactList wide labelWidth={354} label={native ? "Cash balance" : "Cash and capital raised"} rows={native ? [["Current cash", cash]] : [["Current cash / raised", `${cash} / ${whole(data.historicalRaised)}`]]} />
        </Panel>
      </div>
      <HalfColumns>
        <Panel title={native ? "Order contribution breakdown" : `Where ${whole(p.revenue)} goes`} subtitle={native ? "Reported costs · before marketing and fixed expense" : "Last 30 days · before marketing and fixed expense"} testId="breakdown">
          {breakdown.length === 0
            ? <p className={styles.footnote} data-testid="breakdown-empty">{native ? "The contribution breakdown is unavailable for this report." : "No breakdown: the source reports no receipts to split for this period."}</p>
            : <BarRows label="Order contribution breakdown" max={native ? Math.max(1, peak) : 600000} gap={16} trackTop={0} widths={[126, 350, 80]} rows={breakdown.map((c) => ({ label: c.label, value: c.minor, display: native ? whole(c.minor) : whole(c.minor).replace(",", "") }))} />}
          <p className={styles.footnote} data-testid="contribution-per-order">{perOrder.state === "notApplicable" ? `Pre-marketing contribution: ${figureText(perOrder, ueFormat.money)}.` : `Pre-marketing contribution: ${ueFormat.money(perOrder.value!)}/order${perOrder.state === "provisional" ? ` · Provisional · ${explain(perOrder)}` : ""}.`} Contribution after attributed creator cost awaits allocation.</p>
          {!native && peak > 600000 && <p className="visually-hidden">A value exceeds the bar scale.</p>}
        </Panel>
        <Panel title="Payout reconciliation" subtitle={native ? "Reported payouts · source payout → ledger → bank" : "Match source payout → ledger → bank"} testId="payouts">
          <p className={styles.bigValue} data-testid="metric-Payouts matched">{!payoutEvidence ? "Payout reconciliation unavailable" : matchedPct === null ? "No payouts to match" : `${matchedPct}% matched`}</p>
          {payoutEvidence && <>
            <Meter percent={matchedPct ?? 0} label={`${matched} of ${matched + review} payouts matched`} />
            <FlatTable
              caption="Payout reconciliation by channel"
              columns={[{ label: "Channel", width: 266 }, { label: "Matched", width: 160 }, { label: "Needs review", width: 162 }]}
              rows={data.payouts.map((r) => ({ key: r.channel, cells: [r.channel, payoutCount(r.matched), payoutCount(r.needsReview)] }))}
            />
            <span><Badge tone="warning" width={242}>{review} differences to resolve</Badge></span>
          </>}
          {closeRoute ? <LinkButton to={closeRoute} style={{ minWidth: 254, alignSelf: "flex-start" }}>Review month-end close</LinkButton> : <p className={styles.footnote}>The close period is unavailable for this report.</p>}
        </Panel>
      </HalfColumns>
    </>
  );
}

function CashChart({ balances, native, burn }: { balances: FinanceDisplayRecord["cashHistory"]; native: boolean; burn: number | null }) {
  const first = balances[0];
  const current = balances[balances.length - 1];
  if (!first || !current) return null;

  const range = balances.reduce(({ low, high }, row) => ({ low: Math.min(low, row.minor), high: Math.max(high, row.minor) }), { low: 0, high: 0 });
  const low = Math.floor(range.low / 100) * 100;
  const high = range.high === range.low ? 100 : Math.ceil(range.high / 100) * 100;
  const y = native ? (minor: number) => Y0 - 220 * ((minor - low) / (high - low)) : yOf;
  const x = native ? (index: number) => 90 + xOf(index) : xOf;
  const axes = native ? [high, (high + low) / 2, low].map(whole) : ["$70k", "$35k", "$0"];
  const width = native ? Math.max(844, x(balances.length - 1) + 60) : 844;
  const months = native ? balances.map(row => row.month) : MONTHS;
  const actual = balances.map((row, i) => ({ ...row, x: x(i), y: y(row.minor), solid: true }));
  const future = !native && burn !== null && burn > 0 ? [1, 2, 3].flatMap(n => {
    const i = balances.length - 1 + n;
    const month = MONTHS[i];
    const minor = Math.max(current.minor - burn * n, 0);
    return month ? [{ month, minor, x: x(i), y: y(minor), solid: false }] : [];
  }) : [];
  const points = [...actual, ...future];
  const projectedEnd = future[future.length - 1];
  const start = actual[0]!;
  const end = actual[actual.length - 1]!;
  const line = actual.map(point => `${point.x} ${point.y}`).join("L");
  const format = native ? whole : k;
  const summary = native ? `Observed cash in ${first.month} was ${format(first.minor)}${balances.length > 1 ? ` and in ${current.month} was ${format(current.minor)}` : ""}.`
    : `Observed cash fell from ${format(first.minor)} in ${first.month} to ${format(current.minor)} in ${current.month}.${projectedEnd ? ` An illustrative projection reaches ${format(projectedEnd.minor)} by ${projectedEnd.month} at ${whole(burn!)} a month.` : " No projection is drawn: burn needs more history."}`;

  return <div className={styles.plotScroll} role="region" aria-label="Cash trajectory chart" tabIndex={0}>
    <div className={styles.cashChart} style={native ? { width } : undefined}>
      <svg viewBox={`0 0 ${width} 260`} width={width} height="260" role="img" aria-label={summary} className={styles.cashSvg}>
        {[20, 130, 240].map(gridline => <line key={gridline} x1={native ? 96 : 48} x2={width - 16} y1={gridline} y2={gridline} stroke="#EBE8F4" />)}
        <path d={`M${line}L${end.x} ${y(0)}L${start.x} ${y(0)}Z`} fill="#F0EBFF" />
        <path d={`M${line}`} fill="none" stroke="#6547F5" strokeWidth="5" strokeLinecap="round" />
        {future.length > 0 && <path d={`M${[end, ...future].map(point => `${point.x} ${point.y}`).join("L")}`} fill="none" stroke="#A594F8" strokeWidth="4" strokeDasharray="10 10" />}
        <circle cx={end.x} cy={end.y} r="7" fill="#6547F5" />
      </svg>
      {points.map((point, i) => <span key={`${point.month}-${i}`} className={styles.cashLabel} data-solid={point.solid} style={{ left: point.x - 45, top: native ? Math.max(0, point.y - 28) : point.y - 28 }}>{format(point.minor)}</span>)}
      {axes.map((label, i) => <span key={i} className={styles.cashAxis} style={{ top: 12 + 110 * i, width: native ? 94 : undefined }}>{label}</span>)}
      <div className={styles.months} aria-hidden="true" style={native ? { left: 90, width: width - 90 } : undefined}>{months.map((month, i) => <span key={`${month}-${i}`}>{month}</span>)}</div>
    </div>
    <div className="visually-hidden"><table>
      <caption>{native ? "Observed cash by month." : "Cash by month. The first four are observed; any others are illustrative."}</caption>
      <thead><tr><th scope="col">Month</th><th scope="col">Cash</th><th scope="col">Basis</th></tr></thead>
      <tbody>{points.map((point, i) => <tr key={`${point.month}-${i}`}><th scope="row">{point.month}</th><td>{whole(point.minor)}</td><td>{point.solid ? "Observed" : "Illustrative"}</td></tr>)}</tbody>
    </table></div>
  </div>;
}
