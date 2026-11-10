import { useRegisterOperationsCohort } from "./OperationsCohortContext";
import { HeldOperationButton } from "./HeldOperationButton";
import { NativeOperationsGrant } from "./NativeOperationsGrant";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { ReadState } from "@/components/ReadState";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoneyExact } from "@/components/MetricValue";
import { Divider, FactList, FlatTable, HalfColumns, Meter, Notice, Page, PageHeader, Panel, TwoColumns } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { SourceDialog } from "@/features/approvals/shared";
import { HOMES, homeLabel, type Home } from "@/fixtures/operations";
import { dispatchEligible, oldestQueueFirst, operationsContext, operationsEvidenceLabel, operationsHref, queueDetailPath, stockAvailable, stockLow, type NativeQueueRow, type OperationsOverviewRead } from "./nativeRead";
import { ShippingHubPage } from "./shippingHub/ShippingHubPage";
import { OpsTabs } from "./OpsTabs";
import { ShippingPanels } from "./ShippingPanels";
import { MobileOperations, TabletOperations } from "./OperationsCompact";
import { useLayout, type Layout } from "./useLayout";
import { figure, minutesAgoLabel, minutesBetween, reasonText, waitingLabel } from "./format";
import styles from "./Operations.module.css";

const HOME_OPTIONS = [{ value: "all", label: "All homes" }, ...HOMES.map((h) => ({ value: h, label: homeLabel(h) }))];
/** The issues and fulfillment health view (no Figma source) lives on the fulfillment route. */
const HEALTH_PATH = "/analytics/fulfillment?view=health";
const VIEWS = ["overview", "orders", "shipping"] as const;
type View = (typeof VIEWS)[number];

const parseHome = (raw: string | null): Home | "all" => (HOMES.includes(raw as Home) ? (raw as Home) : "all");
const parseView = (raw: string | null): View => (VIEWS.includes(raw as View) ? (raw as View) : "overview");

/**
 * Operations overview (Figma source 4:6, owner THO-301; 390 and 1024 variants 12:653 and 12:708).
 * Read work only. Operational records are changed in their source and come back through the mirror.
 */
export function OperationsPage() {
  const [search] = useSearchParams();
  return search.get("view") === "hub" ? <ShippingHubPage /> : <OperationsOverviewPage />;
}

function OperationsOverviewPage() {
  const { adapter } = useScope();
  const [search, setSearch] = useSearchParams();
  const [sourceOpen, setSourceOpen] = useState(false);
  const layout = useLayout();
  const scenario = search.get("scenario") ?? undefined;
  const home = parseHome(search.get("home"));
  const filters: Record<string, string> = {};
  if (adapter.kind === "demo") { if (scenario) filters.scenario = scenario; }
  else for (const name of ["home", "startAt", "endAt", "timezone"]) { const value = search.get(name); if (value !== null) filters[name] = value; }
  const query = useView<Record<string, string>, OperationsOverviewRead>("operationsOverview", filters);
  const reportingScope = query.data?.data?.reportingScope;
  const renderedHome = adapter.kind === "demo" ? home : reportingScope?.home ?? home;
  const setHome = (value: string) => {
    const next = new URLSearchParams(search);
    if (adapter.kind !== "demo") {
      if (!reportingScope) return;
      next.set("home", value); next.set("startAt", reportingScope.startAt); next.set("endAt", reportingScope.endAt); next.set("timezone", reportingScope.timezone);
    } else if (value === "all") next.delete("home");
    else next.set("home", value);
    setSearch(next);
  };
  return (
    <Page aria-labelledby="ops-title" data-figma-source="4:6">
      {layout === "desktop" ? (
        <PageHeader id="ops-title" title="Operations" subtitle="The right next action, for every order and every home.">
          {adapter.kind === "demo" || reportingScope ? <FilterButton name="Home" bare title="Choose a home" options={HOME_OPTIONS} value={renderedHome} onChange={setHome} width={160} /> : <Button variant="secondary" disabledReason="A source-bound home and reporting period were not supplied.">Home: All homes</Button>}
          {adapter.kind === "demo" && <LinkButton variant="secondary" to={operationsHref(HEALTH_PATH, operationsContext(search, query.data?.data))} style={{ minWidth: 190 }}>Issues and fulfillment health</LinkButton>}
          <HeldOperationButton disabledReason={adapter.kind === "demo" ? undefined : "A verified warehouse source link was not supplied."} aria-haspopup="dialog" style={{ minWidth: 190 }} onClick={() => setSourceOpen(true)}>Open warehouse</HeldOperationButton>
        </PageHeader>
      ) : (
        <div className={styles.compactHeading}>
          <h1 id="ops-title">Operations</h1>
          {layout === "tablet" && <HeldOperationButton disabledReason={adapter.kind === "demo" ? undefined : "A verified warehouse source link was not supplied."} aria-haspopup="dialog" style={{ minWidth: 174 }} onClick={() => setSourceOpen(true)}>Open source</HeldOperationButton>}
        </div>
      )}
      {/* A partial or stale read is said in words, not only by a badge. */}
      <ReadState res={query.data} subject="Operations" only={["partial"]} partialSummary={adapter.kind === "demo" ? undefined : "The visible queue is incomplete. Independently reported source totals can exceed these returned rows. Missing values remain unknown or N/A, never zero."} />
      {query.isPending && <SkeletonCard label="Loading operations…" />}
      {query.isError && <ViewError error={query.error} subject="Operations" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data &&
        (query.data.data ? (
          <NativeOperationsGrant data={query.data.data} refresh={() => { void query.refetch(); }}><Body reportingLabel={reportingScope ? `${reportingScope.startAt.slice(0,10)} to ${reportingScope.endAt.slice(0,10)} · ${reportingScope.timezone} · ${reportingScope.basis === "requestedAt" ? "request cohort" : "event cohort"}` : null} res={query.data as ReadResponse<OperationsOverviewRead>} data={query.data.data} layout={layout} home={renderedHome} demo={adapter.kind === "demo"} /></NativeOperationsGrant>
        ) : (
          query.data.dataState === "empty" && query.data.coverage.complete ? <EmptyState state="Empty" title="No operations data yet"><p>The warehouse mirror responded, but it holds no records for this scope.</p></EmptyState> : <EmptyState state="Error" title="Operations evidence unavailable" alert><p>Incomplete or stale evidence cannot establish that no records exist.</p></EmptyState>
        ))}
      <SourceDialog open={sourceOpen} title="Open the warehouse sheet" url={null} onClose={() => setSourceOpen(false)} />
    </Page>
  );
}

function Body({ res, data, layout, home, demo, reportingLabel }: { reportingLabel: string | null; res: ReadResponse<OperationsOverviewRead>; data: OperationsOverviewRead; layout: Layout; home: Home | "all"; demo: boolean }) {
  useRegisterOperationsCohort(demo ? null : data.reportingScope);
  const [urlSearch] = useSearchParams();
  const search = operationsContext(urlSearch, data);
  const view = parseView(search.get("view"));
  const tabTo = (v: View) => {
    const next = new URLSearchParams(search);
    if (v === "overview") next.delete("view");
    else next.set("view", v);
    const qs = next.toString();
    return `/operations${qs ? `?${qs}` : ""}`;
  };

  const summary = home === "all" ? data.all : data.byHome[home];
  const basis = demo ? null : data.summaryBasis;
  const scopeLabel = home === "all" ? null : homeLabel(home);
  const inScope = (row: { home: Home }) => home === "all" || row.home === home;
  const allRows = oldestQueueFirst(data.queue.rows.filter(inScope));
  const matching = allRows.filter((r) => dispatchEligible(r, !demo) && (view !== "orders" || r.kind === "order"));
  const ready = home === "all" && view === "overview" ? matching.slice(0, 5) : matching;
  const held = allRows.filter((r) => !dispatchEligible(r, !demo));
  const stock = data.stock.filter(inScope);
  const exceptions = data.exceptions.filter(inScope);
  const low = stock.filter(stockLow);
  const lastSync = data.source.lastSyncedAt;
  const behind = lastSync ? minutesBetween(data.source.observedAt, lastSync) : null;
  const staleSource = res.dataState === "stale" || behind === null || behind > 60;
  const sourceNote = demo ? "Operational records are read-only here. Change them in the source; Zapier brings the update back." : `${operationsEvidenceLabel(data)}. Operational source observations are read-only; no shipping, stock movement or refund is authorized here.`;

  if (layout !== "desktop") {
    const Compact = layout === "mobile" ? MobileOperations : TabletOperations;
    return <>
      {reportingLabel && <p className={styles.meta}>Source period: {reportingLabel}</p>}
      {basis && <p className={styles.meta}>Latency: {basis.latency.definition} · {basis.latency.denominator} eligible shipments. Shipping cost: {basis.shippingCost.definition} · {basis.shippingCost.denominator} eligible orders.</p>}
      {view === "shipping" ? <><nav aria-label="Operations sections" className={styles.compactTabs}><LinkButton variant="ghost" to={tabTo("overview")}>Overview</LinkButton><LinkButton variant="ghost" to={tabTo("orders")}>To ship</LinkButton><LinkButton to={tabTo("shipping")} aria-current="page">Shipping</LinkButton></nav><ShippingPanels reportingContext={search} /></> : <>
        <Compact data={data} demo={demo} home={home} view={view} overviewTo={tabTo("overview")} ordersTo={tabTo("orders")} ready={ready} held={held} syncedMinutesAgo={behind} stale={staleSource} complete={demo || res.coverage.complete === true && res.dataState !== "stale" && res.dataState !== "partial"} />
      </>}
    </>;
  }

  return (
    <>
      {reportingLabel && <p className={styles.meta}>Source period: {reportingLabel}</p>}
      {basis && <p className={styles.meta}>Latency: {basis.latency.definition} · {basis.latency.denominator} eligible shipments. Shipping cost: {basis.shippingCost.definition} · {basis.shippingCost.denominator} eligible orders.</p>}
      <OpsTabs current={view} hrefs={{ overview: tabTo("overview"), orders: tabTo("orders"), shipping: tabTo("shipping") }} />

      <Notice tone={staleSource ? "warning" : "violet"} label={staleSource ? "Behind" : "Source"} title={`${data.source.label} · ${lastSync ? `Synced ${minutesAgoLabel(behind ?? 0)}` : "No successful sync recorded"}`} role={staleSource ? "status" : undefined} testId="source-freshness">
        {staleSource ? `The mirror is behind its source, so the figures below may be out of date. ${sourceNote}` : sourceNote}
      </Notice>

      <KpiRow>
        <Kpi label="To ship" context={`${figure(summary.waitingOverTwoDays, String)} waiting more than 2 days`} testId="metric-To ship">{figure(summary.toShip, String)}</Kpi>
        <Kpi label="Shipped today" context={scopeLabel ? `At ${scopeLabel}` : "Across 3 shipping homes"} testId="metric-Shipped today">{figure(summary.shippedToday, String)}</Kpi>
        <Kpi label="Time to ship" context={reasonText(summary.timeToShipDays) ?? (demo ? "7-day average · order to carrier" : basis ? `${basis.latency.definition} · ${basis.latency.denominator} eligible shipments` : "Source denominator unavailable")} testId="metric-Time to ship">{figure(summary.timeToShipDays, (d) => `${d} days`)}</Kpi>
        <Kpi label="Open issues" context={scopeLabel ? "Issues are not assigned to a home" : `${data.needHumanResponse} need a human response`} testId="metric-Open issues">{scopeLabel ? "N/A" : figure(data.openIssues, String)}</Kpi>
      </KpiRow>

      {view !== "shipping" && (
        <TwoColumns>
          <Panel id="queue-title" title={view === "orders" ? "Orders ready to leave home" : "Ready to leave home"} subtitle={`Orders and approved samples · oldest first${data.queue.total > allRows.length && home === "all" ? ` · showing ${ready.length} of ${data.queue.total}` : ""}`} testId="queue-panel">
            {ready.length ? (
              <FlatTable
                caption="Ready to leave home"
                columns={[{ label: "Order / sample", width: 230 }, { label: "Home", width: 150 }, { label: "Waiting", width: 170 }, { label: "Next action", width: 226 }]}
                rows={ready.map((r) => queueRow(r, data.warnAfterHours, search, !demo))}
                testId="queue-table"
              />
            ) : (
              <p className={styles.stat}>No eligible dispatch rows were returned for {scopeLabel ?? "all homes"}. {res.coverage.complete ? "The source reports no eligible records in this complete scope." : "Source coverage is incomplete; absence of rows is not a known zero."}</p>
            )}
          </Panel>
          <Panel title="Stock by home" subtitle="Available = on hand − reserved" roomy testId="stock-panel">
            <ul className={styles.stockList}>
              {stock.map((s) => {
                const available = stockAvailable(s);
                return (
                  <li key={s.home} className={styles.stockRow}>
                    <div className={styles.stockLine}><span>{homeLabel(s.home)}</span><span>{available === null ? "Unknown availability" : `${available} available`}</span></div>
                    {available !== null && s.capacity !== null && s.capacity > 0 ? <Meter percent={(100 * available) / s.capacity} tone={stockLow(s) ? "warning" : undefined} label={`${homeLabel(s.home)}: ${available} available of ${s.capacity}`} /> : <span className={styles.stat}>Stock capacity or availability is unknown.</span>}
                  </li>
                );
              })}
            </ul>
            <Divider />
            {low.map((s) => <p key={s.home} className={styles.warn}>{homeLabel(s.home)} is below its {s.threshold}-unit threshold.</p>)}
            <LinkButton variant="secondary" to={operationsHref("/inventory", search)} style={{ minWidth: 154, alignSelf: "flex-start" }}>View stock</LinkButton>
          </Panel>
        </TwoColumns>
      )}

      {held.length > 0 && (
        <Panel id="held-title" title={`${held.length} held, not ready to leave home`} subtitle="Each hold names its reason and the source action that clears it" testId="held-panel">
          <FlatTable
            caption="Held from dispatch"
            columns={[{ label: "Order / sample", width: 230 }, { label: "Home", width: 150 }, { label: "Hold", width: 396 }]}
            rows={held.map((r) => ({
              key: r.ref,
              cells: [<span key="r">{queueDetailPath(r, !demo) ? <Link className={styles.link} to={operationsHref(queueDetailPath(r, !demo)!, search)}>{r.ref}</Link> : r.ref}</span>, homeLabel(r.home), <span key="h"><Badge tone="warning">Held</Badge><span className={styles.holdReason}> {r.hold?.reason ?? "Dispatch eligibility is unknown"}. {r.hold?.sourceAction ?? "Refresh the source approval, identity, label and stock evidence"}.</span></span>],
            }))}
          />
        </Panel>
      )}

      <HalfColumns>
        <Panel title={exceptions.length === 1 ? "1 shipment needs attention" : `${exceptions.length} shipments need attention`} subtitle={demo ? "Live red alerts are routed to #ops-alerts" : "Source-reported lost and returned shipments"} testId="exceptions-panel">
          {exceptions.length > 0 && (
            <FactList rows={exceptions.map((e) => [e.shipmentRef, <Link key={e.shipmentRef} className={styles.link} to={operationsHref(`/shipments/${encodeURIComponent(e.shipmentRef)}/exceptions/${encodeURIComponent(e.exceptionId)}`, search)}>{e.state} · {homeLabel(e.home)}</Link>])} label="Shipments needing attention" />
          )}
          {exceptions.length > 0 && <LinkButton to={operationsHref(`/shipments/${encodeURIComponent(exceptions[0]!.shipmentRef)}/exceptions/${encodeURIComponent(exceptions[0]!.exceptionId)}`, search)} style={{ minWidth: 190, alignSelf: "flex-start" }}>Review exceptions</LinkButton>}
        </Panel>
        <Panel title="A clear path to delivered" subtitle={demo ? "Last 7 days · synthetic sample data" : reportingLabel ?? "Source period unavailable"} testId="health-panel">
          <FactList wide label="Fulfillment health" rows={[
            ["Carrier transit", figure(data.health.carrierTransitDays, (d) => `${d} days average`)],
            ["Shipping cost", figure(data.health.shippingCostPerOrder, (m) => `${formatMoneyExact(m)} per order`)],
            ["On-time handoff", figure(data.health.onTimeHandoffPct, (p) => `${p}% within 2 days`)],
          ]} />
        </Panel>
      </HalfColumns>
      {view === "shipping" && <ShippingPanels reportingContext={search} />}
    </>
  );
}


function queueRow(r: NativeQueueRow, warnAfterHours: number, search: URLSearchParams, native: boolean) {
  const over = r.waitingHours > warnAfterHours;
  const detail = queueDetailPath(r, native);
  const href = detail ? operationsHref(detail, search) : null;
  return {
    key: r.ref,
    cells: [
      <span key="ref" className={styles.queueRef}>{r.ref}</span>,
      homeLabel(r.home),
      over ? <Badge key="w" tone="danger" width={112}>{waitingLabel(r.waitingHours)}</Badge> : <span key="w" className={styles.waiting}>{waitingLabel(r.waitingHours)}</span>,
      href ? <LinkButton key="a" to={href} variant={over ? "secondary" : "ghost"} style={{ minWidth: 136 }}>{r.kind === "sample" ? "View sample" : "View order"}</LinkButton> : <Button key="a" variant="secondary" disabledReason="An exact source detail reference was not supplied.">View source record</Button>,
    ],
  };
}
