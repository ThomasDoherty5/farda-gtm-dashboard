import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { Kpi } from "@/components/Kpi";
import { BarRows, Divider, HalfColumns, Page, PageHeader, Panel } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { homeLabel, type FulfillmentAnalytics } from "@/fixtures/operations";
import { figure, minutesAgoLabel, reasonText } from "./format";
import styles from "./Operations.module.css";

const PERIODS = [{ value: "14", label: "Last 14 days" }, { value: "7", label: "Last 7 days" }];
const SCALE_PX = 6.75;

/**
 * Fulfillment analytics (Figma source 12:808, owner THO-301). Every figure is derived from the daily rows, so the cards,
 * the chart and its table can't disagree. A comparison the data can't support reads N/A, never zero.
 */
export function FulfillmentAnalyticsPage() {
  const [search, setSearch] = useSearchParams();
  const days = search.get("days") === "7" ? 7 : 14;
  const query = useView<{ days: number }, FulfillmentAnalytics>("fulfillmentAnalytics", { days });
  const data = query.data?.data ?? null;
  return (
    <Page aria-labelledby="fulfillment-title" data-figma-source="12:808">
      <PageHeader id="fulfillment-title" title="Fulfillment overview" subtitle="The full journey from paid to delivered — at a glance.">
        <FilterButton name="Period" bare title="Choose a period" options={PERIODS} value={String(days)} width={172} onChange={(v) => { const next = new URLSearchParams(search); if (v === "14") next.delete("days"); else next.set("days", v); setSearch(next); }} />
        <LinkButton to="/operations" style={{ minWidth: 200 }}>Open operations</LinkButton>
      </PageHeader>
      <ReadState res={query.data} subject="Fulfillment analytics" only={["stale"]} />
      {query.isPending && <SkeletonCard label="Loading fulfillment analytics…" />}
      {query.isError && <ViewError error={query.error} subject="Fulfillment analytics" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && !data && <EmptyState state="Empty" title="No fulfillment data yet"><p>The source responded, but no shipments fall in this period.</p></EmptyState>}
      {data && <Body data={data} partial={query.data?.dataState === "partial"} />}
    </Page>
  );
}

function Body({ data, partial }: { data: FulfillmentAnalytics; partial: boolean }) {
  const shipped = data.daily.reduce((sum, d) => sum + d.shipped, 0);
  const best = data.daily.reduce((a, b) => (b.shipped > a.shipped ? b : a));
  const prior = data.shippedPrior;
  const change = prior.state === "known" && prior.value ? `${shipped >= prior.value ? "+" : "−"}${(Math.abs((100 * (shipped - prior.value)) / prior.value)).toFixed(1)}% vs prior ${data.periodDays} days (${prior.value})` : null;
  const lowHomes = data.stock.filter((s) => s.available < s.threshold);
  const summary = `Orders shipped and open backlog per day over the last ${data.periodDays} days. ${shipped} shipped in total; best day ${best.label}, ${best.shipped} orders.`;

  return (
    <>
      <p className={styles.meta}>{`Demo data  ·  ${data.source}  ·  Synced ${minutesAgoLabel(data.syncedMinutesAgo)}  ·  ${data.homes} shipping homes`}</p>
      {partial && <p className={styles.meta} role="status">Some data is missing. Showing {data.periodDays} of 14 days the demo holds; the delivery mix and the prior period weren't read for this period.</p>}
      <div className={styles.analytics}>
        <div className={styles.kpiStack}>
          <Kpi label="Orders shipped" context={change ?? reasonText(prior) ?? ""} testId="metric-Orders shipped">{shipped}</Kpi>
          <Kpi label="On-time dispatch" context="Within the 2-day target" testId="metric-On-time dispatch">{figure(data.onTimePct, (p) => `${p}%`)}</Kpi>
          <Kpi label="Awaiting handoff" context={`${data.overdue} overdue · owner action required`} testId="metric-Awaiting handoff">{figure(data.awaitingHandoff, String)}</Kpi>
        </div>
        <Panel id="throughput-title" header={<><div className={styles.legend}><h2 id="throughput-title" className={styles.chartTitle}>Shipping throughput</h2><span className={styles.chartGap} aria-hidden="true" /><span aria-hidden="true" className={styles.badgeRow}><Badge tone="violet" width={112}>Shipped</Badge><Badge width={148}>Open backlog</Badge></span></div></>} roomy testId="throughput">
          <p className={styles.meta}>Orders per day · completed handoffs and remaining queue</p>
          <div className={styles.plotScroll} role="region" aria-label="Shipping throughput chart" tabIndex={0}>
            <div className={styles.plot} style={{ "--days": data.daily.length } as React.CSSProperties} role="img" aria-label={summary}>
              {data.daily.map((d) => (
                <div key={d.label} className={styles.day}>
                  <div className={styles.bars}>
                    <span className={styles.bar} data-kind="backlog" style={{ height: d.backlog * SCALE_PX }} />
                    <span className={styles.bar} data-kind="shipped" style={{ height: d.shipped * SCALE_PX }} />
                  </div>
                  <span className={styles.dayLabel}>{d.label}</span>
                </div>
              ))}
            </div>
            <table className="visually-hidden">
              <caption>Orders shipped and open backlog per day</caption>
              <thead><tr><th scope="col">Day</th><th scope="col">Shipped</th><th scope="col">Open backlog</th></tr></thead>
              <tbody>{data.daily.map((d) => <tr key={d.label}><th scope="row">{d.label}</th><td>{d.shipped}</td><td>{d.backlog}</td></tr>)}</tbody>
            </table>
          </div>
          <Divider />
          <dl className={styles.best}><dt>Best dispatch day</dt><dd data-testid="best-day">{best.shipped} orders · {best.label.length > 2 ? best.label : `Oct ${best.label}`}</dd></dl>
        </Panel>
      </div>
      <HalfColumns>
        <Panel title="Stock at every home" subtitle={`Solid = available · light = reserved · scale ${data.scaleUnits} units`} roomy testId="stock-at-homes">
          <ul className={styles.homeList}>
            {data.stock.map((s) => {
              const low = s.available < s.threshold;
              return (
                <li key={s.home} className={styles.homeStock}>
                  <dl className={`${styles.best} ${styles.homeLine}`}><dt>{homeLabel(s.home)}</dt><dd>{s.available} available · {s.reserved} reserved</dd></dl>
                  <div className={styles.track} role="img" aria-label={`${homeLabel(s.home)}: ${s.available} available and ${s.reserved} reserved of a ${data.scaleUnits}-unit scale`}>
                    <span data-kind={low ? "low" : "available"} style={{ width: `${(100 * s.available) / data.scaleUnits}%` }} />
                    <span data-kind="reserved" style={{ width: `${(100 * s.reserved) / data.scaleUnits}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
          {lowHomes.map((s) => <p key={s.home} className={styles.warn}>{homeLabel(s.home)} · {s.available} available · below {s.threshold}-unit threshold</p>)}
          <LinkButton variant="secondary" to="/inventory" style={{ minWidth: 180, alignSelf: "flex-start" }}>View inventory</LinkButton>
        </Panel>
        <Panel title="Delivery experience" subtitle={`Share of delivered orders (%) · last ${data.periodDays} days`} roomy testId="delivery">
          <div className={styles.deliveryMetric}><p data-testid="metric-Average transit">{figure(data.avgTransitDays, (d) => `${d} days`)}</p><p>average transit</p></div>
          {data.transit ? (
            <BarRows label="Share of delivered orders by transit time" max={60} gap={20} rows={data.transit.map((t) => ({ label: t.label, value: t.share, warn: t.warn }))} />
          ) : (
            <p className={styles.meta}>N/A. The demo holds no delivery mix for this period.</p>
          )}
          <p className={styles.dangerText}>{data.exceptions.lost + data.exceptions.returned} active exceptions · {data.exceptions.lost} lost, {data.exceptions.returned} returned</p>
          <LinkButton to="/shipments/TEST-SP-0093/exceptions/TEST-EVT-129" style={{ minWidth: 206, alignSelf: "flex-start" }}>Review exceptions</LinkButton>
        </Panel>
      </HalfColumns>
    </>
  );
}
