import { useState } from "react";
import { Link } from "react-router-dom";
import type { NativeOverviewSummary, OverviewDomains } from "@/creator-agent/analytics/views";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { DataTable } from "@/components/DataTable";
import { MetricValue } from "@/components/MetricValue";
import { Fact, nativeCount, nativeMoney, nativeMultiple, nativePercent } from "@/features/analytics/NativeAnalyticsEvidence";
import { reportingRoute } from "@/features/analytics/reportingPeriod";
import styles from "./OverviewPage.module.css";

const number = (value: number | null | undefined, format = nativeCount) => value === null || value === undefined ? "N/A" : format(value);
function OwnerStamp({ owner }: { owner: OverviewDomains[keyof OverviewDomains] }) {
  return <p className={styles.note}>{owner.state} · {owner.synthetic === true ? "Synthetic source" : owner.synthetic === false ? "Source evidence" : "Source stage unavailable"}. {owner.reason?.replaceAll("_", " ").toLowerCase()}{owner.observedAt ? ` · observed ${owner.observedAt}` : ""}</p>;
}
export function monitorOverviewRoute(data: NativeOverviewSummary) {
  const campaign = data.domains?.activity.data?.selection?.campaign;
  return campaign && data.period ? reportingRoute(`/content?campaign=${encodeURIComponent(campaign)}`, data.period) : null;
}
/** Summary additions follow the original full overview; its chart/KPI grid stays intact.
 * Figures are projections of the owning readers, never browser-computed business totals. */
export function OverviewOwnerSummaries({ data }: { data: NativeOverviewSummary }) {
  const [review, setReview] = useState(false), d = data.domains;
  if (!d) return <p className={styles.note}>Cross-domain readers have not returned a qualified summary.</p>;
  const ops = d.operations.data, finance = d.finance.data, creators = d.creators.data, portfolio = d.portfolio.data;
  const opsParams = new URLSearchParams(ops ? { home: ops.scope.home, startAt: ops.scope.startAt, endAt: ops.scope.endAt, timezone: ops.scope.timezone } : {});
  const hubParams = new URLSearchParams({ view: "hub", "ship-recipient": "all", "ship-purpose": "all", "ship-location": ops?.scope.home ?? "all",
    ...(ops ? { "ship-start": ops.scope.startAt, "ship-end": ops.scope.endAt, "ship-timezone": ops.scope.timezone } : {}) });
  return <div className={styles.ownerSummaries} aria-label="Reconciled domain summaries">
    <section className={styles.card} aria-labelledby="overview-creators"><h2 id="overview-creators" className={styles.cardTitle}>Creator economics</h2>
      <OwnerStamp owner={d.creators}/><dl className={styles.creatorMetrics}>
        <div><dt>Attributed net sales</dt><dd>{creators ? <Fact fact={creators.attributedNetSales} format={nativeMoney}/> : "N/A"}</dd></div>
        <div><dt>Attributed orders</dt><dd>{creators ? <Fact fact={creators.attributedOrders} format={nativeCount}/> : "N/A"}</dd></div>
      </dl><p className={styles.note}>Canonical creator-code attribution · same report cohort. Cost coverage: {creators?.costCoverage ?? "unknown"}; landed cost: {creators?.landedCost ?? "unknown"}; retention: {creators?.retention ?? "unknown"}.</p>
      {creators?.roi.length ? <DataTable caption="Creator return on cost" minWidth={280} columns={[{label:"Creator"},{label:"ROI"}]} rows={creators.roi.map((c,i)=>[`Creator ${i+1}`,<Fact key={c.creatorRef} fact={c.roi} format={nativeMultiple}/>])}/> : <p className={styles.note}>ROI N/A · no qualified creator cost basis.</p>}
      <Link className={styles.textLink} to={reportingRoute("/analytics/attribution", data.period)}>Review creator attribution and cost definitions →</Link>
      <p className={styles.note}>New acquisition is commission-only. Samples, paid media and historical obligations remain separate cost components.</p>
    </section>
    <section className={styles.card} aria-labelledby="overview-logistics"><h2 id="overview-logistics" className={styles.cardTitle}>Shipping and operations</h2>
      <OwnerStamp owner={d.operations}/><dl className={styles.creatorMetrics}>
        <div><dt>Shipments</dt><dd data-testid="overview-shipping-count">{number(ops?.shipments)}</dd></div>
        <div><dt>Open issues</dt><dd>{ops ? <MetricValue value={ops.openIssues} format={nativeCount}/> : "N/A"}</dd></div>
        <div><dt>Time to ship</dt><dd>{ops ? <MetricValue value={ops.timeToShipDays} format={n=>`${n} days`}/> : "N/A"}</dd></div>
        <div><dt>Shipping cost / order</dt><dd>{ops ? <MetricValue value={ops.shippingCostPerOrder} format={nativeMoney}/> : "N/A"}</dd></div>
      </dl><p className={styles.note}>{ops ? `${ops.scope.home === "all" ? "All homes" : ops.scope.home} · ${ops.scope.startAt} to ${ops.scope.endAt} (exclusive) · ${ops.scope.timezone} · ${ops.scope.basis}. Latency and cost retain the Operations source denominator.` : "Home, period and denominator require qualified Operations evidence."}</p>
      {ops?.summaryBasis && <p className={styles.note}>Latency: {ops.summaryBasis.latency.definition} · {ops.summaryBasis.latency.denominator} eligible shipments. Shipping cost: {ops.summaryBasis.shippingCost.definition} · {ops.summaryBasis.shippingCost.denominator} eligible orders.</p>}
      {ops ? <Link className={styles.textLink} to={`/operations?${opsParams}`}>Review the same Operations scope →</Link> : <p className={styles.note}>Operations drilldown held until the reporting scope is qualified.</p>}
      {ops?.scope.basis === "requestedAt" ? <Link className={styles.textLink} to={`/operations?${hubParams}`}>Inspect customer and creator shipments →</Link> : <p className={styles.note}>A matching request-time scope is required for the unified shipping hub drilldown.</p>}
    </section>
    <section className={styles.card} aria-labelledby="overview-finance"><h2 id="overview-finance" className={styles.cardTitle}>Finance</h2>
      <OwnerStamp owner={d.finance}/><dl className={styles.creatorMetrics}>
        <div><dt>Gross margin</dt><dd data-testid="overview-finance-margin">{number(finance?.grossMargin, nativePercent)}</dd></div>
        <div><dt>Cash</dt><dd data-testid="overview-finance-cash">{number(finance?.cash,n=>nativeMoney({minorUnits:n,currency:"USD"}))}</dd></div>
        <div><dt>Runway</dt><dd data-testid="overview-finance-runway">{number(finance?.runwayMonths,n=>`${n.toFixed(1)} months`)}</dd></div>
        <div><dt>Actual revenue</dt><dd>{number(finance?.actualRevenue,n=>nativeMoney({minorUnits:n,currency:"USD"}))}</dd></div>
      </dl><p className={styles.note}>{finance ? `QuickBooks · ${finance.context.accountingBasis} basis · accounting definition ${finance.context.policy.state}. Cash as of ${finance.context.cashAsOf}.` : "Approved accounting period and definition unavailable."}</p>
      <p className={styles.note}>{finance?.runwayReason ?? "Runway uses current cash / average net cash burn."} Forecast: {number(finance?.forecastRevenue,n=>nativeMoney({minorUnits:n,currency:"USD"}))} · {finance?.context.forecastState ?? "unavailable"}.</p>
      <Link className={styles.textLink} to={reportingRoute("/finance", data.period)}>Review the same Finance period →</Link>
    </section>
    <section className={styles.card} aria-labelledby="overview-portfolio"><h2 id="overview-portfolio" className={styles.cardTitle}>Creator portfolio</h2>
      <OwnerStamp owner={d.portfolio}/><dl className={styles.creatorMetrics}>
        <div><dt>Reviewed creators</dt><dd>{number(portfolio?.creators)}</dd></div>
        <div><dt>Verified publications</dt><dd>{number(portfolio?.verifiedPublications)}</dd></div>
        <div><dt>Mature retained contribution</dt><dd>{portfolio?.matureRetainedContribution ? nativeMoney(portfolio.matureRetainedContribution) : "N/A"}</dd></div>
        <div><dt>Immature collaborations</dt><dd>{number(portfolio?.immatureCollaborations)}</dd></div>
      </dl><p className={styles.note}>Source-owned review dimensions overlap; they are not exclusive pipeline stages. Organic sales and paid-creative evidence remain separate. No sourcing-like threshold is used.</p>
      {portfolio ? <><DataTable caption="Overlapping portfolio dimensions" minWidth={280} columns={[{label:"Dimension"},{label:"Creators"}]} rows={portfolio.dimensions.map(d=>[d.dimension.replaceAll("-"," "),d.creators])}/><Button variant="secondary" onClick={()=>setReview(true)}>Inspect portfolio review</Button></> : <p className={styles.note}>Portfolio review N/A · no qualified source revision.</p>}
      <Dialog open={review&&!!portfolio} title="Source-owned portfolio review" onClose={()=>setReview(false)}>
        {portfolio&&<><p>Objective: {portfolio.objective}. Same reporting cohort and window. These are proposals; approval, contact eligibility and provider execution remain with their existing owners.</p>
          <DataTable caption="Portfolio recommendations" minWidth={620} columns={[{label:"Creator"},{label:"Proposed action"},{label:"Next review"},{label:"Open obligations"},{label:"Uncertainty"}]} rows={portfolio.recommendations.map((r,i)=>[`Creator ${i+1}`,r.action,r.nextReviewAt,r.outstandingObligations,r.uncertainty.join(" · ")||"None reported"])}/>
          <p className={styles.note}>Review {portfolio.reviewRef} · version {portfolio.reviewVersion}. Existing commissions and obligations are preserved.</p></>}
        <Button variant="secondary" onClick={()=>setReview(false)}>Close portfolio review</Button>
      </Dialog>
    </section>
  </div>;
}
