import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Money, ProvenanceValue, ReadResponse } from "@/adapter/contract";
import { staleReasonText } from "@/adapter/freshness";
import { useScope } from "@/adapter/scope";
import { useSourceLease } from "@/adapter/useSourceLease";
import type { NativeOverviewSummary } from "@/creator-agent/analytics/views";
import { NativeOverview } from "./NativeOverview";
import { ReportingPeriodForm, reportingRoute, useReportingPeriod } from "@/features/analytics/reportingPeriod";
import { nativePeriod } from "@/features/analytics/NativeAnalyticsEvidence";
import { useView } from "@/adapter/useView";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { MetricValue, formatCompact, formatCount, formatMoney, formatMoneyExact } from "@/components/MetricValue";
import { ViewError } from "@/components/ViewError";
import type { OverviewData } from "@/fixtures/overview";
import type { Measure } from "@/adapter/viewSchemas/analytics";
import { SourceStates } from "@/features/analytics/parts";
import { axisMax, engagementRate, weeklyTotals } from "./metrics";
import styles from "./OverviewPage.module.css";

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" }).format(new Date(iso));
const shortDate = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const usd = (minorUnits: number) => formatMoney({ minorUnits, currency: "USD" });
const exactOrNa = (minorUnits: number | null) => (minorUnits === null ? "N/A" : formatMoneyExact({ minorUnits, currency: "USD" }));
/** Daily rows with every value known. A served day with an unreported channel draws no bar, never a zero bar. */
const completeDaily = (data: OverviewData) => data.daily.every((d) => d.shopify !== null && d.tiktok !== null) ? data.daily as { date: string; shopify: number; tiktok: number }[] : [];
const measureOf = (data: OverviewData, key: string): Measure | null => (data.datasetKey === "overview-observed" ? data.measures.find((m) => m.key === key) ?? null : null);
/** Server-computed measure text. N/A always says why; a ratio states its numerator and denominator. */
const MEASURE_REASONS: Record<string, string> = {
  CREATOR_COST_SOURCE_UNCONFIGURED: "creator costs are not connected",
  AD_PLATFORM_SOURCE_UNCONFIGURED: "ad platforms are not connected",
  ZERO_DENOMINATOR: "zero denominator",
};
function measureText(m: Measure, format: (v: number) => string) {
  if (m.state === "known" && m.value !== null) return format(m.value);
  return `N/A · ${(m.reasonCode && MEASURE_REASONS[m.reasonCode]) ?? "an input is unknown"}`;
}
const pct = (part: number, whole: number) => (whole === 0 ? 0 : (100 * part) / whole);

/** Performance overview (Figma source 10:217, owner THO-293). */
export function OverviewPage() {
  const { adapter } = useScope();
  const selectedPeriod = useReportingPeriod();
  const query = useView<Record<string, never>, OverviewData | NativeOverviewSummary>("overviewSummary", {}, selectedPeriod);
  const [dialog, setDialog] = useState<"period" | "export" | null>(null);
  const demo = adapter.kind === "demo";
  const report = query.isError ? null : query.data?.data;
  const native = report?.datasetKey === "analytics-native" ? report : null;
  const expired = useSourceLease(native?.provenance.validUntil);
  const period = native && !expired ? nativePeriod(native) : report && "periodLabel" in report ? report.periodLabel : null;

  return (
    <section aria-labelledby="overview-title" data-figma-source="10:217" className={styles.page}>
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          <h1 id="overview-title">Overview</h1>
          <p>Every channel. Every creator. One clear picture.</p>
        </div>
        <Button variant="secondary" className={styles.periodButton} aria-haspopup="dialog" onClick={() => setDialog("period")}>{native ? "Reporting period" : "Last 30 days"}</Button>
        <Button className={styles.exportButton} aria-haspopup="dialog" onClick={() => setDialog("export")}>Export report</Button>
      </div>
      {query.isPending && <SkeletonCard label="Loading overview…" />}
      {query.isError && <ViewError error={query.error} subject="The overview" hasPriorData={false} onRetry={() => void query.refetch()} />}
      {expired && <EmptyState state="Error" title="Reporting access lease expired" alert><p>Refresh to verify current access before viewing reporting evidence.</p><Button onClick={() => void query.refetch()}>Refresh reporting evidence</Button></EmptyState>}
      {!query.isError && !expired && query.data && (native ? <NativeOverview data={native} refresh={() => void query.refetch()} refreshing={query.isFetching} /> : <Body res={query.data as ReadResponse<OverviewData>} demo={demo} />)}

      <Dialog open={dialog === "period"} title="A consistent reporting window." badge={demo ? "Demo" : undefined} onClose={() => setDialog(null)}>
        <p>{period ? `${demo ? "This demo uses" : "The source-selected period is"} ${period}. ` : "Reporting window Unknown. "}Keep the same period across revenue, costs and attribution. Incomplete source periods stay labeled.</p>
        {!demo && dialog === "period" && <ReportingPeriodForm onApplied={() => setDialog(null)} />}
        <LinkButton to={reportingRoute("/analytics/attribution", selectedPeriod)}>View analytics workspace</LinkButton>
        <Button variant="secondary" onClick={() => setDialog(null)}>{demo ? "Keep demo period" : "Close"}</Button>
      </Dialog>
      <Dialog open={dialog === "export"} title="Report preview" badge={demo ? "Demo" : undefined} onClose={() => setDialog(null)}>
        <p>{demo ? `The demo period is ${period ?? "one fixed window"}. Metrics are illustrative, and no file is generated. ` : "Export isn't connected yet, and no file is generated. "}Production exports retain the period, source freshness, and metric definitions.</p>
        <LinkButton to={reportingRoute("/analytics/attribution", native?.period ?? selectedPeriod)}>View performance report</LinkButton>
        <LinkButton to="/finance/close/2026-10">View month-end package</LinkButton>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close preview</Button>
      </Dialog>
    </section>
  );
}

function Body({ res, demo }: { res: ReadResponse<OverviewData>; demo: boolean }) {
  const freshness = res.sourceFreshness[0];
  return (
    <>
      {res.dataState === "stale" && (
        <Alert state="warning" title="Source data is stale">
          <p>{staleReasonText(freshness)}. Values below are from the last successful sync, {freshness?.lastSourceSuccessAt ? dateTime(freshness.lastSourceSuccessAt) : "at an unknown time"}, not current.</p>
        </Alert>
      )}
      {res.dataState === "partial" && (
        <Alert state="warning" title="Partial data">
          <p>{res.coverage.observedCount} of {res.coverage.expectedCount} source records are available. Totals cover only those records.</p>
        </Alert>
      )}
      {res.data?.datasetKey === "overview-observed" && <SourceStates sources={res.data.sources} />}
      {res.dataState === "empty" || !res.data ? (
        <EmptyState state="Empty" title="No matching records"><p>The source responded, but nothing matches the current filters.</p></EmptyState>
      ) : (
        <Dashboard data={res.data} demo={demo} />
      )}
    </>
  );
}

function Dashboard({ data, demo }: { data: OverviewData; demo: boolean }) {
  return (
    <>
      <div className={styles.context}>
        {demo && <Badge tone="violet" width={160}>Demo performance</Badge>}
        <p>{data.periodLabel}</p>
        {demo && <><p aria-hidden="true">·</p><p>Illustrative figures · not connected analytics</p></>}
        <span className={styles.contextSpace} />
        <Badge width={166} to="/launch?view=snapshot">Launch date unset</Badge>
      </div>
      <div className={styles.primary}>
        <Kpis data={data} />
        <SalesByChannel data={data} />
      </div>
      <div className={styles.secondary}>
        <ChannelShare data={data} />
        <Efficiency data={data} />
        <CreatorActivity data={data} demo={demo} />
      </div>
      <footer className={styles.footer}>
        {demo && <p>Demo data · weekly mini bars; final bucket = 2 days</p>}
        <span className={styles.footerSpace} />
        <p>Contribution definition: proposed · before marketing</p>
        <p aria-hidden="true">·</p>
        <Link to="/analytics/attribution" className={styles.textLink}>View definitions →</Link>
      </footer>
    </>
  );
}

/** A value only when its state is known. A derived figure is computed only when every input is known; otherwise it is N/A. */
const knownOf = <T,>(v: ProvenanceValue<T>): T | null => (v.state === "known" ? v.value : null);
function marginOf(data: OverviewData): number | null {
  const net = knownOf(data.netReceipts)?.minorUnits ?? null, contribution = knownOf(data.contribution)?.minorUnits ?? null;
  return net !== null && contribution !== null && net > 0 ? pct(contribution, net) : null;
}
/** Average net receipts per order: both inputs known, and orders above zero. */
function averageText(data: OverviewData) {
  const net = knownOf(data.netReceipts)?.minorUnits ?? null, orders = knownOf(data.orders);
  if (net === null || orders === null) return "Average net receipts N/A";
  return orders ? `${formatMoneyExact({ minorUnits: Math.round(net / orders), currency: "USD" })} average net receipts` : "No average without orders";
}

function Kpis({ data }: { data: OverviewData }) {
  const weeks = weeklyTotals(completeDaily(data));
  const peak = Math.max(1, ...weeks);
  // A margin needs both figures to be known, and receipts above zero. Otherwise it is N/A, never 0%.
  const margin = marginOf(data);
  const circumference = 2 * Math.PI * 39.6;
  const totalOrders = data.channels.reduce((s, c) => s + c.orders, 0);
  const [mainChannel, secondChannel] = data.channels;
  return (
    <div className={styles.kpis}>
      <div className={`${styles.card} ${styles.kpi} ${styles.hero}`}>
        <dl className={styles.kpiText}>
          <dt>Net receipts</dt>
          <dd data-testid="metric-Net receipts"><MetricValue value={data.netReceipts} format={formatMoney} /></dd>
          <dd className={styles.note}>After refunds · before fees</dd>
        </dl>
        <div className={styles.miniBars} aria-hidden="true">
          {weeks.map((week, i) => <span key={i} style={{ height: `${(week / peak) * 100}%` }} />)}
        </div>
      </div>
      <div className={`${styles.card} ${styles.kpi}`}>
        <dl className={`${styles.kpiText} ${styles.kpiTextWide}`}>
          <dt>Contribution</dt>
          <dd data-testid="metric-Contribution"><MetricValue value={data.contribution} format={formatMoney} /></dd>
          <dd className={styles.note}>Before marketing · {margin === null ? "margin N/A" : `${margin.toFixed(1)}% margin`}</dd>
        </dl>
        <div className={styles.donut} aria-hidden="true">
          <svg width="90" height="90" viewBox="0 0 90 90" fill="none">
            <circle className={styles.donutTrack} cx="45" cy="45" r="39.6" strokeWidth="10.8" />
            <circle className={styles.donutArc} cx="45" cy="45" r="39.6" strokeWidth="10.8" strokeDasharray={`${((margin ?? 0) / 100) * circumference} ${circumference}`} transform="rotate(-90 45 45)" />
          </svg>
          <span>{margin === null ? "N/A" : `${Math.round(margin)}%`}</span>
        </div>
      </div>
      <div className={`${styles.card} ${styles.kpi}`}>
        <dl className={styles.kpiText}>
          <dt>Paid orders</dt>
          <dd data-testid="metric-Paid orders"><MetricValue value={data.orders} format={formatCount} /></dd>
          <dd className={styles.note}>{averageText(data)}</dd>
        </dl>
        {mainChannel && secondChannel && data.orders.state === "known" && (
          // Bubble sizes are fixed as in Figma; the labels carry the values.
          <div className={styles.bubbles} role="img" aria-label={`${mainChannel.label} ${mainChannel.orders} orders, ${secondChannel.label} ${secondChannel.orders} orders`}>
            <span className={`${styles.bubble} ${styles.bubbleMain}`}>{Math.round(pct(mainChannel.orders, totalOrders))}%</span>
            <span className={`${styles.bubble} ${styles.bubbleSecond}`}>{Math.round(pct(secondChannel.orders, totalOrders))}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function SalesByChannel({ data }: { data: { daily: OverviewData["daily"]; channels: { key: string; label: string; netReceipts: Money | null; orders: number | null }[] } }) {
  const { daily, channels } = data;
  const fmt = (v: number | null) => exactOrNa(v);
  const max = useMemo(() => axisMax(daily.flatMap((d) => [d.shopify, d.tiktok]).filter((v): v is number => v !== null), 20_000), [daily]);
  const ticks = [1, 2 / 3, 1 / 3, 0];
  const count = Math.max(1, daily.length);
  const [shopify, tiktok] = channels;
  return (
    <section className={styles.card} aria-labelledby="sales-title" data-testid="sales-card">
      <div className={styles.chartHead}>
        <h2 id="sales-title">Sales by channel</h2>
        <span className={styles.chartSpace} />
        <Badge tone="violet" width={112}>Shopify</Badge>
        <Badge width={128} to="/creators/tiktok?view=dashboard">TikTok Shop</Badge>
      </div>
      <p className={styles.note}>Daily net receipts · USD</p>
      <div className={styles.chartScroll} role="region" aria-label="Daily net receipts chart" tabIndex={0}>
        <div className={styles.chart} aria-hidden="true">
          {ticks.map((t, i) => (
            <span key={t}>
              <span className={styles.axisLabel} style={{ left: 0, top: i === 0 ? 0 : 270 * (1 - t) - 8 }}>{usd(max * t)}</span>
              <span className={styles.grid} style={{ top: 270 * (1 - t) }} />
            </span>
          ))}
          <div className={styles.plot}>
            {daily.map((d, i) => (
              <div key={d.date} className={styles.day} style={{ left: `${(i / count) * 100}%` }} title={`${shortDate(d.date)}: Shopify ${fmt(d.shopify)}, TikTok Shop ${fmt(d.tiktok)}`}>
                {d.shopify !== null && <span className={`${styles.bar} ${styles.barShopify}`} style={{ height: `${(d.shopify / max) * 100}%` }} />}
                {d.tiktok !== null && <span className={`${styles.bar} ${styles.barTiktok}`} style={{ height: `${(d.tiktok / max) * 100}%` }} />}
              </div>
            ))}
          </div>
          {daily.map((d, i) => i % 5 === 0 && <span key={d.date} className={styles.axisLabel} style={{ top: 284, left: `calc(48px + ${i / count} * (100% - 48px))` }}>{shortDate(d.date)}</span>)}
        </div>
      </div>
      <div className="visually-hidden"><table>
        <caption>Daily net receipts by channel, in US dollars</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Shopify</th><th scope="col">TikTok Shop</th></tr></thead>
        <tbody>
          {daily.map((d) => <tr key={d.date}><th scope="row">{shortDate(d.date)}</th><td>{fmt(d.shopify)}</td><td>{fmt(d.tiktok)}</td></tr>)}
        </tbody>
      </table></div>
      <div className={styles.chartTotals}>
        {shopify && <span className={styles.totalShopify} style={{ whiteSpace: "pre" }}>{`${shopify.label}  ${(shopify.netReceipts ? formatMoney(shopify.netReceipts) : "Unknown")}`}</span>}
        {tiktok && <span className={styles.totalTiktok} style={{ whiteSpace: "pre" }}>{`${tiktok.label}  ${(tiktok.netReceipts ? formatMoney(tiktok.netReceipts) : "Unknown")}`}</span>}
        <span className={styles.totalsSpace} />
        <Link to="/analytics/attribution" className={styles.textLink}>View channel report →</Link>
      </div>
    </section>
  );
}

function ChannelShare({ data }: { data: OverviewData }) {
  const total = data.channels.reduce((s, c) => s + c.netReceipts.minorUnits, 0);
  const orders = data.channels.reduce((s, c) => s + c.orders, 0);
  return (
    <section className={styles.card} aria-labelledby="share-title" data-testid="share-card">
      <h2 id="share-title" className={styles.cardTitle}>Where sales come from</h2>
      {data.channels.map((c) => {
        // A share needs every channel's receipts. With one channel unreported, a share of the rest would overstate it.
        const share = data.netReceipts.state === "known" ? pct(c.netReceipts.minorUnits, total) : null;
        return (
          <div key={c.key} className={styles.channel}>
            <div className={styles.channelAmount}><span>{c.label}</span><span>{formatMoney(c.netReceipts)}</span></div>
            <div className={styles.progress} aria-hidden="true"><span style={{ width: `${share ?? 0}%` }} /></div>
            <p className={styles.note}>{share === null ? "Share N/A · another channel is unreported" : `${share.toFixed(1)}% of net receipts`}</p>
          </div>
        );
      })}
      <p className={styles.note}>{data.orders.state === "known" ? `${formatCount(orders)} orders` : "Order total N/A"} · {data.channels.map((c) => `${c.orders} ${c.label.split(" ")[0]}`).join(" / ")}</p>
    </section>
  );
}

function Efficiency({ data }: { data: OverviewData }) {
  const net = knownOf(data.netReceipts)?.minorUnits ?? null;
  const margin = marginOf(data);
  // Served data carries the server's CAC and MER with their own denominators; the demo derives them from its fixed figures.
  const cacMeasure = measureOf(data, "blendedCac"), merMeasure = measureOf(data, "mer");
  const spend = data.marketingSpend?.minorUnits ?? null;
  const cac = cacMeasure ? measureText(cacMeasure, (v) => formatMoneyExact({ minorUnits: Math.round(v), currency: "USD" }))
    : spend !== null && data.newRetainedCustomers ? formatMoneyExact({ minorUnits: Math.round(spend / data.newRetainedCustomers), currency: "USD" }) : "N/A";
  const mer = merMeasure ? measureText(merMeasure, (v) => `${v.toFixed(2)}×`) : spend && net !== null ? `${(net / spend).toFixed(2)}×` : "N/A";
  const cacNote = `${data.marketingSpend ? formatMoney(data.marketingSpend) : "Acquisition cost N/A"} / ${data.newRetainedCustomers ?? "N/A"} new retained customers`;
  return (
    <section className={styles.card} aria-labelledby="growth-title" data-testid="growth-card">
      <h2 id="growth-title" className={styles.cardTitle}>Growth, with discipline.</h2>
      <dl className={styles.pair}>
        <div>
          <dt>Blended CAC</dt>
          <dd className={styles.value} data-testid="metric-Blended CAC">{cac}</dd>
          <dd className={styles.note}>{cacNote}</dd>
        </div>
        <div>
          <dt>Marketing efficiency</dt>
          <dd className={styles.value} data-testid="metric-Marketing efficiency">{mer}</dd>
          <dd className={styles.note}>Net receipts / marketing spend</dd>
        </div>
      </dl>
      <hr className={styles.divider} />
      <div className={styles.progress} aria-hidden="true"><span style={{ width: `${margin ?? 0}%` }} /></div>
      <p className={styles.violetLabel}>{margin === null ? "Contribution margin N/A" : `${margin.toFixed(1)}% contribution before marketing`}</p>
      <p className={styles.note}>Net receipts less product, shipping, transaction and variable fulfilment costs. Proposed definition.</p>
      <Link to="/analytics/finance" className={styles.textLink}>Explore unit economics →</Link>
    </section>
  );
}

function CreatorActivity({ data, demo }: { data: OverviewData; demo: boolean }) {
  const eng = engagementRate(data.posts);
  // A served overview carries no monitor posts (the monitor is its own read), so views are unknown there, never a summed zero.
  const monitorSeparate = data.datasetKey === "overview-observed";
  const views = !monitorSeparate && data.posts.every((p) => p.views !== null) ? data.posts.reduce((s, p) => s + (p.views ?? 0), 0) : null;
  const viewsValue: ProvenanceValue<number> = views === null
    ? { ...data.orders, state: "unknown", value: null, reasonCode: monitorSeparate ? "MONITOR_SEPARATE" : "VIEWS_UNAVAILABLE" }
    : { ...data.orders, value: views };
  const engValue: ProvenanceValue<number> = monitorSeparate ? { ...data.orders, state: "unknown", value: null, reasonCode: "MONITOR_SEPARATE" } : eng.state === "known"
    ? { ...data.orders, value: eng.ratePct }
    : { ...data.orders, state: "notApplicable", value: null, reasonCode: eng.reasonCode === "NO_COMPLETE_POSTS" ? "SHARES_UNAVAILABLE" : eng.reasonCode };
  return (
    <section className={`${styles.card} ${styles.activity}`} aria-labelledby="activity-title" data-testid="activity-card">
      <div className={styles.activityHead}>
        <h2 id="activity-title" className={styles.cardTitle}>Creator activity</h2>
        <Badge tone="violet" width={132}>{data.monitorLabel}</Badge>
      </div>
      <p className={styles.note}>{data.cohortLabel}</p>
      <dl className={styles.creatorMetrics}>
        <div><dt>Views</dt><dd data-testid="metric-Views"><MetricValue value={viewsValue} format={formatCompact} /></dd></div>
        <div><dt>Engagement rate</dt><dd data-testid="metric-Engagement rate"><MetricValue value={engValue} format={(v) => `${v.toFixed(1)}%`} /></dd></div>
        <div><dt>Attributed orders</dt><dd data-testid="metric-Attributed orders"><MetricValue value={data.attributedOrders} format={formatCount} /></dd></div>
        <div><dt>Attributed net sales</dt><dd data-testid="metric-Attributed net sales"><MetricValue value={data.attributedNetSales} format={formatMoney} /></dd></div>
      </dl>
      <hr className={styles.divider} />
      {data.activity.map((a) => <div key={a.handle} className={styles.event}><strong>{a.handle}</strong><span className={styles.note}>{a.note}</span></div>)}
      <p className={styles.note}>{demo ? data.lastCheckedLabel : "Last checked: not connected"}</p>
      <LinkButton to="/content" className={styles.monitorButton}>View content monitor</LinkButton>
    </section>
  );
}
