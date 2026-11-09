import { Link } from "react-router-dom";
import type { NativeLaunchReconciliation } from "@/creator-agent/analytics/views";
import { Badge } from "@/components/Badge";
import { Fact, NativeAnalyticsEvidence, nativeCount, nativeMoney, nativeMultiple, nativePercent } from "./NativeAnalyticsEvidence";
import { reportingRoute, trafficReportingRoute } from "./reportingPeriod";
import { Card, SectionHeading, Table } from "./parts";
import styles from "./Analytics.module.css";
const routes: Record<string, string> = { overviewSummary: "/overview", attribution: "/analytics/attribution", paidMedia: "/analytics/paid-media", launchSnapshot: "/launch" };
export function NativeReconciliation({ data, refresh, refreshing }: { data: NativeLaunchReconciliation; refresh: () => void; refreshing: boolean }) {
  const routeFor = (cell: NativeLaunchReconciliation["matrix"][number]["cells"][number]) => cell.cohortRef !== data.cohortRef ? null : cell.viewKey === "customerJourney" ? trafficReportingRoute(cell.period) : routes[cell.viewKey] ? reportingRoute(routes[cell.viewKey]!, cell.period) : null;
  const problems = data.matrix.filter(row => row.comparison.state !== "matches").length;
  return <>
    <NativeAnalyticsEvidence data={data} refresh={refresh} refreshing={refreshing} />
    <Card labelledBy="fresh-title" className={styles.gap18} testId="freshness"><SectionHeading id="fresh-title" title="Each source has its own freshness" note="Access authority and observation freshness are independent." />
      <Table caption="Source freshness" columns={[{ label: "Source", width: 240 }, { label: "Coverage", width: 150 }, { label: "Source time", width: 220 }, { label: "Observed", width: 220 }, { label: "Current until", width: 220 }, { label: "Freshness limit", width: 180 }]} rows={data.sources.map(source => ({ key: source.proofRef, cells: [source.owner, source.coverage, source.sourceAsOf ?? "Unknown", source.observedAt, source.validUntil, `${source.maxAgeMs / 60_000} minutes`] }))} />
    </Card>
    <Card labelledBy="matrix-title" className={styles.gap18} testId="matrix"><SectionHeading id="matrix-title" title={!data.matrix.length ? "No qualified comparisons supplied" : problems ? `${problems} of ${data.matrix.length} supplied figures need attention` : "Every supplied comparison matches"} note="Only exact values with the same cohort, window, currency and definition can match. This is not a claim that all domain coverage is complete." />
      {data.matrix.length ? <Table caption="Overview to detail reconciliation matrix" columns={[{ label: "Metric", width: 220 }, { label: "Status", width: 160 }, { label: "Where it appears", width: 800 }]} rows={data.matrix.map(row => ({ key: row.metricId, cells: [row.metricId, <Badge key="status" tone={row.comparison.state === "matches" ? "success" : row.comparison.state === "differs" ? "danger" : "warning"}>{row.comparison.state === "unknown" ? "Not reconciled" : row.comparison.state}</Badge>, <div key="cells">{row.cells.map((cell, index) => <p key={cell.viewKey + index} className={styles.small}>{routeFor(cell) ? <Link to={routeFor(cell)!}>{cell.viewKey}</Link> : cell.viewKey} · <Fact fact={cell.value} format={row.unit === "minorUnits" ? value => nativeMoney({ minorUnits: value, currency: "USD" }) : row.unit === "percent" ? nativePercent : row.unit === "multiple" ? nativeMultiple : nativeCount} /> · {cell.period.startAt} to {cell.period.endAt} ({cell.period.timezone})</p>)}<p className={styles.small}>{row.comparison.reasonCodes.join(" · ")}</p></div>] }))} /> : <p>Reconciliation Unknown; an empty comparison set is never evidence that pages agree.</p>}
      <p className={styles.small}>Comparison observed {data.asOf}. Reading this matrix changes no orders, ledger facts or source definitions.</p>
    </Card>
  </>;
}
