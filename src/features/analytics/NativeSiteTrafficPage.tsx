import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SelectField } from "@/components/Field";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import type { NativeSiteTrafficView, TrafficCountView, TrafficPublicSegment, TrafficRateView } from "@/creator-agent/siteTraffic/views";
import { BarList, Card, DetailRow, KpiCard, KpiGrid, Notice, PageHeader, SectionHeading, Table, ViewShell, count } from "./parts";
import styles from "./Analytics.module.css";

/** Browser selection is only a request; the source validates the calendar and approved segment. */
export function siteTrafficFilters(params: URLSearchParams): unknown {
  const allowed = new Set(["segment", "startDay", "endDayExclusive", "timezone"]);
  if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) return { invalidTrafficFilter: true };
  const segment = params.get("segment");
  const dates = ["startDay", "endDayExclusive", "timezone"].map(key => params.get(key));
  if ((segment !== null && !/^traffic-segment-[a-f0-9]{64}$/.test(segment)) || (dates.some(value => value !== null) && !dates.every(Boolean))) return { invalidTrafficFilter: true };
  return {
    period: dates.every(Boolean) ? { startDay: dates[0], endDayExclusive: dates[1], timezone: dates[2] } : null,
    segment: segment ? { kind: "utm", segmentRef: segment } : { kind: "all" },
  };
}

const valueText = (metric: TrafficCountView) => metric.value === null ? "Unknown" : count(metric.value);
const rateText = (metric: TrafficRateView) => metric.percent === null ? "N/A" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(metric.percent)}%`;
const stateNote = (metric: TrafficCountView | TrafficRateView) => metric.reasonCodes.includes("SOURCE_STALE") ? "Retained · source no longer current" : metric.provisional ? "Provisional · partial source coverage" : metric.state === "known" ? "Matching source cohort" : "Requires compatible source counts";
const segmentText = (segment: TrafficPublicSegment) => segment.kind === "all" ? "All storefront traffic" : `${segment.channel ?? "Unattributed"} · ${segment.campaign ?? "unknown"}`;
const stamp = (value: string | null) => value ?? "Unknown";
const periodText = (data: NativeSiteTrafficView) => data.period ? `${data.period.startDay} to ${data.period.endDayExclusive} (end exclusive), ${data.period.timezone}` : "Reporting window and timezone pending";
const accessText = (data: NativeSiteTrafficView) => data.capability.state === "unsupported"
  ? "The connected source does not support the required Shopify traffic report. Sessions and conversion remain unavailable."
  : data.capability.state === "unconfigured"
    ? "Qualified Shopify account and reporting access pending."
    : "Qualified traffic reporting access is available; imported evidence is evaluated separately.";

export function retainedTrafficEvidence(data: NativeSiteTrafficView): NativeSiteTrafficView {
  const retained = structuredClone(data);
  retained.freshness.state = "stale";
  for (const metric of Object.values(retained.measures)) if (metric.state === "known") {
    metric.provisional = true;
    metric.reasonCodes = [...new Set([...metric.reasonCodes, "SOURCE_STALE" as const])];
  }
  for (const rate of Object.values(retained.rates)) {
    rate.state = "unknown"; rate.percent = null; rate.provisional = true; rate.reasonCodes = ["SOURCE_STALE"];
  }
  retained.clickComparison.state = "unknown";
  retained.clickComparison.reasonCodes = [...new Set([...retained.clickComparison.reasonCodes, "SOURCE_STALE" as const])];
  return retained;
}

/** Native counterpart of the complete original 30:721 commerce/experience screen. */
export function NativeSiteTrafficPage() {
  const [params, setParams] = useSearchParams();
  const query = useView<unknown, NativeSiteTrafficView>("customerJourney", siteTrafficFilters(params));
  const [dialog, setDialog] = useState<"definitions" | "source" | null>(null);
  const data = query.data?.data;
  const current = useSourceLease(data?.provenance.validUntil);
  const expired = Boolean(data && (query.isError || data.capability.state === "ready" && !current));
  const displayed = data && expired ? retainedTrafficEvidence(data) : data;
  const supportReason = "A current support queue is not connected to this aggregate report.";
  return (
    <section aria-labelledby="journey-title" data-figma-source="30:721" className={styles.page}>
      <PageHeader id="journey-title" title="Watch the journey after the click." subtitle="Commerce and experience · conversion, support load, returns and review outcomes.">
        <Button variant="secondary" style={{ minWidth: 192 }} aria-haspopup="dialog" onClick={() => setDialog("definitions")}>Cohort definitions</Button>
        <Button style={{ minWidth: 176 }} disabledReason={supportReason} reasonFor="traffic-support-hold">Open support</Button>
      </PageHeader>
      {expired && <Notice tone="warning" title="Retained source evidence">The source could not be revalidated or its permission/freshness window expired. Counts below are historical; conversion and attribution remain unavailable until refreshed. <Button variant="secondary" onClick={() => void query.refetch()} loading={query.isFetching}>Refresh traffic evidence</Button></Notice>}
      <ViewShell query={query} subject="Commerce, support and reviews" emptyTitle="No traffic evidence" emptyBody="The source returned no report for this selection. Counts remain unknown.">
        {d => <TrafficBody data={displayed ?? d} openSource={() => setDialog("source")} selectSegment={segment => {
          const next = new URLSearchParams(params);
          if (segment === "all") next.delete("segment"); else next.set("segment", segment);
          setParams(next);
        }} />}
      </ViewShell>
      <p className={styles.small} id="traffic-support-hold">{supportReason}</p>
      <Dialog open={dialog !== null} title={dialog === "source" ? "Commerce source evidence" : "Cohort definitions"} badge={data?.provenance.synthetic ? "Fictional test" : "Source evidence"} onClose={() => setDialog(null)}>
        {displayed ? <TrafficDefinitions data={displayed} showDaily={dialog === "source"} /> : <p>Current source evidence is unavailable. No previous account data is displayed.</p>}
        <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>Refresh source</Button>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
    </section>
  );
}

function TrafficBody({ data, openSource, selectSegment }: { data: NativeSiteTrafficView; openSource: () => void; selectSegment: (segment: string) => void }) {
  const { measures, rates } = data;
  const observations = [
    { key: "sessions", label: "Sessions", metric: measures.sessions, note: "Unique sessions in the selected cohort" },
    { key: "views", label: "Product viewed", metric: measures.productViewEvents, note: "Repeated events; not a unique-session count" },
    { key: "checkout", label: "Checkout started", metric: measures.checkoutSessions, note: "Unique sessions reaching checkout" },
    { key: "orders", label: "Valid orders", metric: measures.shopifyOrders, note: "Shopify storefront-origin orders only" },
  ];
  const scale = Math.max(1, ...observations.map(row => row.metric.value ?? 0));
  const pending = data.imports.firstActualImport.state === "pending";
  return <>
    <Notice tone={data.provenance.synthetic ? "violet" : "warning"} title={data.capability.state === "unsupported" ? "Shopify traffic access unsupported" : data.capability.state === "unconfigured" ? "Shopify traffic source pending" : data.provenance.synthetic ? "Fictional test evidence · each metric keeps its own cohort" : "Source evidence · each metric keeps its own cohort"}>
      {data.capability.state !== "ready" && <>{accessText(data)}{data.provenance.synthetic ? " This is fictional test evidence." : ""}{" "}</>}
      {periodText(data)}. Coverage: {data.coverage.state}; freshness: {data.freshness.state}. {pending ? "First validated actual import is still pending." : "A validated actual import is recorded."}
    </Notice>
    <KpiGrid>
      <KpiCard label="Website sessions" context={stateNote(measures.sessions)} testId="metric-sessions">{valueText(measures.sessions)}</KpiCard>
      <KpiCard label="Store conversion" context={`${valueText(measures.shopifyOrders)} Shopify orders ÷ ${valueText(measures.sessions)} sessions${rates.storeOrderConversion.provisional ? " · provisional" : ""}`} testId="metric-conversion">{rateText(rates.storeOrderConversion)}</KpiCard>
      <KpiCard label="Support load" context="Needs a qualified delivered-unit cohort" testId="metric-support-load">N/A</KpiCard>
      <KpiCard label="Average rating" context="Needs the ratings feed" testId="metric-rating">N/A</KpiCard>
    </KpiGrid>
    <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
      <Card labelledBy="flow-title" className={styles.card20}>
        <SectionHeading id="flow-title" title={measures.sessions.value === null ? "Store conversion awaits traffic evidence" : `${valueText(measures.shopifyOrders)} valid orders from ${valueText(measures.sessions)} sessions`} note="One selected source; event and session measures remain distinct." />
        <BarList label="Store conversion measures" rows={observations.map(row => ({ key: row.key, label: row.label, value: valueText(row.metric), note: row.note, share: (row.metric.value ?? 0) / scale }))} />
        <p className={styles.small}>Bar lengths use the largest observed count as a display scale. These are different measures, not a required descending funnel.</p>
        <hr className={styles.divider} />
        <DetailRow label="Shopify net receipts" value="Unknown" />
        <DetailRow label="Shopify AOV" value="N/A · matching net receipts unavailable" />
        <DetailRow label="Add-to-cart session rate" value={`${rateText(rates.addToCart)} · ${stateNote(rates.addToCart)}`} />
        <DetailRow label="Checkout completion" value={`${rateText(rates.checkoutCompletion)} · ${stateNote(rates.checkoutCompletion)}`} />
        <p className={styles.small}>TikTok Shop orders and TikTok-origin Shopify mirrors are excluded. Store conversion uses matching storefront orders and sessions; global orders are not its numerator.</p>
        <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 250 }} aria-haspopup="dialog" onClick={openSource}>Open commerce source</Button></div>
      </Card>
      <Card labelledBy="support-title" className={styles.card20}>
        <SectionHeading id="support-title" title="Support categories" note="Support reporting requires its own delivered-unit cohort · no message text." />
        <BarList label="Support tickets by category" rows={["Setup", "Shipping", "Hardware", "Return / refund"].map(label => ({ key: label, label, value: "Unknown", share: 0 }))} />
        <p className={styles.small}>Traffic sessions do not establish ticket counts or support outcomes.</p>
        <hr className={styles.divider} />
        <DetailRow label="Resolved by Fin" value="Unknown" /><DetailRow label="Resolved by people" value="Unknown" /><DetailRow label="Open / handed off" value="Unknown" />
        <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 250 }} disabledReason="Support queue not connected to this report." reasonFor="traffic-support-hold">Review support queue</Button></div>
      </Card>
    </div>
    <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
      <Card labelledBy="returns-title" className={styles.card20}>
        <SectionHeading id="returns-title" title="A return ends with a verified outcome" note="Return rate needs a qualified delivered-unit cohort." />
        <p className={styles.metric} data-testid="metric-return-rate">N/A</p>
        <DetailRow label="Received and inspected" value="Unknown" /><DetailRow label="Awaiting inspection" value="Unknown" /><DetailRow label="Restocked from inspected" value="Unknown" /><DetailRow label="Quarantined from inspected" value="Unknown" />
        <p className={styles.small}>Refunds and physical returns are separate events. Restock only after inspection; replacements link the original order. Source Orders owns refund and retained-unit totals.</p>
        <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 232 }} disabledReason="A verified return reference is required to open return evidence.">Open return cases</Button></div>
      </Card>
      <Card labelledBy="reviews-title" className={styles.card20}>
        <SectionHeading id="reviews-title" title="Rated reviews unavailable" note="Ratings-only feed · latest unique platform + review ID. All-time ratings and delivered cohorts stay separate." />
        <BarList label="Reviews by star rating" rows={[5, 4, 3, 2, 1].map(star => ({ key: String(star), label: `${star} ${star === 1 ? "star" : "stars"}`, value: "Unknown", share: 0 }))} />
        <hr className={styles.divider} />
        <p className={styles.small}>Unrated reviews are excluded from the average. Review requests pause during unresolved support/returns. Low-rating follow-up stays in the source tool with an accountable owner.</p>
        <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 250 }} disabledReason="The current ratings source is not connected to this report.">Open review outcomes</Button></div>
      </Card>
    </div>
    <Notice tone="warning" title="Unknown is not zero">
      Missing source counters remain unknown; zero sessions produce N/A rates. Partial coverage is provisional. Creator clicks and storefront sessions are different measures. Support, returns and ratings require their own source evidence.
    </Notice>
    <Card labelledBy="traffic-source-title">
      <SectionHeading id="traffic-source-title" title="Traffic source and coverage" note={periodText(data)} />
      {data.segments.length > 0 && <SelectField label="Traffic segment" value={data.selectedSegment?.kind === "utm" ? data.selectedSegment.segmentRef : "all"} onChange={selectSegment}
        options={data.segments.map((segment, index) => ({ value: segment.kind === "all" ? "all" : segment.segmentRef, label: `${segmentText(segment)}${segment.kind === "utm" ? ` · ${index + 1}` : ""}` }))} />}
      <DetailRow label="Source as of" value={stamp(data.freshness.sourceAsOf)} /><DetailRow label="Imported at" value={stamp(data.freshness.importedAt)} />
      <DetailRow label="Daily coverage" value={`${data.coverage.observedDays} of ${data.coverage.expectedDays ?? "unknown"} expected days · ${data.coverage.state}`} />
      <DetailRow label="Comparable counts through" value={stamp(data.coverage.observedThrough)} />
      <DetailRow label="Creator tracked clicks" value={`${valueText(data.clickComparison.creatorClicks)} · ${data.clickComparison.state}`} />
      <DetailRow label="Compared storefront sessions" value={valueText(data.clickComparison.storefrontSessions)} />
      <p className={styles.small}>{data.clickComparison.attribution === "sourceApprovedUtm" ? "The source approved this UTM grouping; it does not identify individual customers." : "No creator-level attribution is inferred from missing, blocked or unattributed traffic."}</p>
      <DetailRow label="First validated actual import" value={pending ? "Pending" : stamp(data.imports.firstActualImport.receipt?.importedAt ?? null)} />
    </Card>
  </>;
}

/** Shared source-backed explanation for the commerce and performance definition controls. */
export function TrafficDefinitions({ data, showDaily = false }: { data: NativeSiteTrafficView; showDaily?: boolean }) {
  const definition = data.capability.definition;
  return <>
    <dl className={styles.defs} style={{ overflowWrap: "anywhere" }}>
      <div><dt>Selection and window</dt><dd>{periodText(data)}. {data.selectedSegment ? segmentText(data.selectedSegment) : "Segment unavailable"}. Coverage: {data.coverage.state}.</dd></div>
      <div><dt>Source</dt><dd>{definition ? `${definition.provider} · ${definition.transport} · ${definition.accountRef}` : "Qualified Shopify account and report identity unavailable."}</dd></div>
      {data.capability.state !== "ready" && <div><dt>Reporting access</dt><dd>{accessText(data)}</dd></div>}
      <div><dt>Store conversion</dt><dd>Shopify storefront-origin orders divided by matching storefront sessions. TikTok Shop and TikTok-origin Shopify mirrors are excluded. {rateText(data.rates.storeOrderConversion)}; {stateNote(data.rates.storeOrderConversion)}.</dd></div>
      <div><dt>Session rates</dt><dd>Cart rate: sessions with cart additions ÷ storefront sessions. Checkout completion: sessions completing checkout ÷ sessions reaching checkout. Repeated product-view or cart events never replace these denominators.</dd></div>
      <div><dt>Provider session conversion</dt><dd>{rateText(data.rates.providerConversion)}: converted sessions ÷ storefront sessions, separate from the order-count ratio. {stateNote(data.rates.providerConversion)}.</dd></div>
      <div><dt>Creator click comparison</dt><dd>{data.clickComparison.measure}. {data.clickComparison.period ? `${data.clickComparison.period.startDay} to ${data.clickComparison.period.endDayExclusive} (end exclusive), ${data.clickComparison.period.timezone}` : "Click reporting window unknown"}. Click source as of: {stamp(data.clickComparison.sourceAsOf)}. Comparison: {data.clickComparison.state}.</dd></div>
      <div><dt>Coverage and freshness</dt><dd>{data.coverage.observedDays} of {data.coverage.expectedDays ?? "unknown"} days; {data.freshness.state}. Compatible observation prefix through {stamp(data.coverage.observedThrough)}. Source as of {stamp(data.freshness.sourceAsOf)}; imported at {stamp(data.freshness.importedAt)}.</dd></div>
      <div><dt>First validated actual import</dt><dd>{data.imports.firstActualImport.state === "pending" ? "Pending. Fictional tests do not validate a live Shopify import." : `Recorded at ${stamp(data.imports.firstActualImport.receipt?.importedAt ?? null)}.`}</dd></div>
      {definition && <><div><dt>Definition version</dt><dd style={{ overflowWrap: "anywhere" }}>{definition.version}</dd></div><div><dt>Measurement basis</dt><dd style={{ overflowWrap: "anywhere" }}>{definition.measurementVersion}. Bot traffic {definition.botFilter}; source-qualified additive daily counts. Source freshness limit: {definition.freshnessMaxAgeMs / 60_000} minutes.</dd></div>
        <div><dt>Provider counter IDs</dt><dd style={{ overflowWrap: "anywhere" }}>{definition.counterIds.sessions}; {definition.counterIds.cartSessions}; {definition.counterIds.checkoutSessions}; {definition.counterIds.completedCheckoutSessions}. Session unit: {definition.counterIds.sessionUnit}; repeated-event unit: {definition.counterIds.eventUnit}.</dd></div></>}
    </dl>
    <p>Support and returns use their own delivered-unit cohorts; ratings use their own all-time source. No traffic total substitutes for those denominators.</p>
    {showDaily && (data.days.length ? <div style={{ width: "100%", minWidth: 0 }}><Table caption="Imported storefront daily aggregates" columns={[{ label: "Calendar day", width: 160 }, { label: "Sessions", width: 120 }, { label: "Coverage", width: 120 }, { label: "Source as of", width: 240 }, { label: "Revision", width: 100 }]} rows={data.days.map(row => ({ key: `${row.day}:${row.segment.segmentRef}`, cells: [row.day, row.counters.sessions === null ? "Unknown" : count(row.counters.sessions), row.coverage, row.sourceAsOf, String(row.revision)] }))} /></div> : <p>No daily source aggregates have been imported for this selection.</p>)}
  </>;
}

/** The performance definitions control reads the same source owner; financial and traffic windows are explicitly separate. */
export function NativeTrafficDefinitionRead() {
  const query = useView<unknown, NativeSiteTrafficView>("customerJourney", { period: null, segment: { kind: "all" } });
  const data = query.data?.data;
  const current = useSourceLease(data?.provenance.validUntil);
  return <section aria-labelledby="performance-traffic-definitions">
    <h3 id="performance-traffic-definitions" className={styles.label}>Store traffic definitions</h3>
    <p className={styles.small}>This traffic report states its own source calendar. It does not change the financial reporting period or assign unattributed orders.</p>
    <ViewShell query={query} subject="Store traffic definitions" emptyTitle="Traffic definitions pending" emptyBody="A qualified traffic source has not returned a reporting definition.">
      {d => <TrafficDefinitions data={query.isError || d.capability.state === "ready" && !current ? retainedTrafficEvidence(d) : d} />}
    </ViewShell>
    <LinkButton variant="secondary" to="/analytics/customer-journey">Open traffic evidence</LinkButton>
  </section>;
}
