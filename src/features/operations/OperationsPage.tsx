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
import { HOMES, homeLabel, type Home, type OperationsOverview, type QueueRow } from "@/fixtures/operations";
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
  const { adapter } = useScope();
  const [search, setSearch] = useSearchParams();
  const [sourceOpen, setSourceOpen] = useState(false);
  const layout = useLayout();
  const scenario = search.get("scenario") ?? undefined;
  const home = parseHome(search.get("home"));
  const query = useView<{ scenario?: string }, OperationsOverview>("operationsOverview", scenario ? { scenario } : {});
  const setHome = (value: string) => {
    const next = new URLSearchParams(search);
    if (value === "all") next.delete("home");
    else next.set("home", value);
    setSearch(next);
  };
  return (
    <Page aria-labelledby="ops-title" data-figma-source="4:6">
      {layout === "desktop" ? (
        <PageHeader id="ops-title" title="Operations" subtitle="The right next action, for every order and every home.">
          <FilterButton name="Home" bare title="Choose a home" options={HOME_OPTIONS} value={home} onChange={setHome} width={160} />
          <LinkButton variant="secondary" to={HEALTH_PATH} style={{ minWidth: 190 }}>Issues and fulfillment health</LinkButton>
          <Button aria-haspopup="dialog" style={{ minWidth: 190 }} onClick={() => setSourceOpen(true)}>Open warehouse</Button>
        </PageHeader>
      ) : (
        <PageHeader id="ops-title" title="Operations">
          {layout === "mobile" && <LinkButton variant="secondary" to={HEALTH_PATH} style={{ minWidth: 174 }}>Health view</LinkButton>}
          {layout === "tablet" && <><LinkButton variant="secondary" to={HEALTH_PATH} style={{ minWidth: 174 }}>Health view</LinkButton><Button aria-haspopup="dialog" style={{ minWidth: 174 }} onClick={() => setSourceOpen(true)}>Open source</Button></>}
        </PageHeader>
      )}
      {/* A partial or stale read is said in words, not only by a badge. */}
      <ReadState res={query.data} subject="Operations" only={["partial"]} />
      {query.isPending && <SkeletonCard label="Loading operations…" />}
      {query.isError && <ViewError error={query.error} subject="Operations" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data &&
        (query.data.data ? (
          <Body res={query.data as ReadResponse<OperationsOverview>} data={query.data.data} layout={layout} home={home} demo={adapter.kind === "demo"} />
        ) : (
          <EmptyState state="Empty" title="No operations data yet"><p>The warehouse mirror responded, but it holds no records for this scope.</p></EmptyState>
        ))}
      <SourceDialog open={sourceOpen} title="Open the warehouse sheet" url={null} onClose={() => setSourceOpen(false)} />
    </Page>
  );
}

function Body({ res, data, layout, home, demo }: { res: ReadResponse<OperationsOverview>; data: OperationsOverview; layout: Layout; home: Home | "all"; demo: boolean }) {
  const [search] = useSearchParams();
  const view = parseView(search.get("view"));
  const tabTo = (v: View) => {
    const next = new URLSearchParams(search);
    if (v === "overview") next.delete("view");
    else next.set("view", v);
    const qs = next.toString();
    return `/operations${qs ? `?${qs}` : ""}`;
  };

  const summary = home === "all" ? data.all : data.byHome[home];
  const scopeLabel = home === "all" ? null : homeLabel(home);
  const inScope = (row: { home: Home }) => home === "all" || row.home === home;
  const allRows = data.queue.rows.filter(inScope);
  const ready = allRows.filter((r) => !r.hold && (view !== "orders" || r.kind === "order"));
  const held = allRows.filter((r) => r.hold);
  const stock = data.stock.filter(inScope);
  const exceptions = data.exceptions.filter(inScope);
  const low = stock.filter((s) => s.onHand - s.reserved < s.threshold);
  const lastSync = data.source.lastSyncedAt;
  const behind = lastSync ? minutesBetween(data.source.observedAt, lastSync) : null;
  const staleSource = res.dataState === "stale" || behind === null || behind > 60;
  const sourceNote = "Operational records are read-only here. Change them in the source; Zapier brings the update back.";

  if (layout !== "desktop") {
    const Compact = layout === "mobile" ? MobileOperations : TabletOperations;
    return <Compact data={data} home={home} ready={ready} syncedMinutesAgo={behind} stale={staleSource} />;
  }

  return (
    <>
      <OpsTabs current={view} hrefs={{ overview: tabTo("overview"), orders: tabTo("orders"), shipping: tabTo("shipping") }} />

      <Notice tone={staleSource ? "warning" : "violet"} label={staleSource ? "Behind" : "Source"} title={`${data.source.label} · ${lastSync ? `Synced ${minutesAgoLabel(behind ?? 0)}` : "No successful sync recorded"}`} role={staleSource ? "status" : undefined} testId="source-freshness">
        {staleSource ? `The mirror is behind its source, so the figures below may be out of date. ${sourceNote}` : sourceNote}
      </Notice>

      <KpiRow>
        <Kpi label="To ship" context={`${figure(summary.waitingOverTwoDays, String)} waiting more than 2 days`} testId="metric-To ship">{figure(summary.toShip, String)}</Kpi>
        <Kpi label="Shipped today" context={scopeLabel ? `At ${scopeLabel}` : "Across 3 shipping homes"} testId="metric-Shipped today">{figure(summary.shippedToday, String)}</Kpi>
        <Kpi label="Time to ship" context={reasonText(summary.timeToShipDays) ?? "7-day average · order to carrier"} testId="metric-Time to ship">{figure(summary.timeToShipDays, (d) => `${d} days`)}</Kpi>
        <Kpi label="Open issues" context={scopeLabel ? "Issues are not assigned to a home" : `${data.needHumanResponse} need a human response`} testId="metric-Open issues">{scopeLabel ? "N/A" : figure(data.openIssues, String)}</Kpi>
      </KpiRow>

      {view !== "shipping" && (
        <TwoColumns>
          <Panel id="queue-title" title={view === "orders" ? "Orders ready to leave home" : "Ready to leave home"} subtitle={`Orders and approved samples · oldest first${data.queue.total > allRows.length && home === "all" ? ` · showing ${ready.length} of ${data.queue.total}` : ""}`} testId="queue-panel">
            {ready.length ? (
              <FlatTable
                caption="Ready to leave home"
                columns={[{ label: "Order / sample", width: 230 }, { label: "Home", width: 150 }, { label: "Waiting", width: 170 }, { label: "Next action", width: 226 }]}
                rows={ready.map((r) => queueRow(r, data.warnAfterHours))}
                testId="queue-table"
              />
            ) : (
              <p className={styles.stat}>Nothing is waiting to leave {scopeLabel ?? "any home"}. That is a known zero from the warehouse mirror, not a missing read.</p>
            )}
          </Panel>
          <Panel title="Stock by home" subtitle="Available = on hand − reserved" roomy testId="stock-panel">
            <ul className={styles.stockList}>
              {stock.map((s) => {
                const available = s.onHand - s.reserved;
                return (
                  <li key={s.home} className={styles.stockRow}>
                    <div className={styles.stockLine}><span>{homeLabel(s.home)}</span><span>{available} available</span></div>
                    <Meter percent={(100 * available) / s.capacity} tone={available < s.threshold ? "warning" : undefined} label={`${homeLabel(s.home)}: ${available} available of ${s.capacity}`} />
                  </li>
                );
              })}
            </ul>
            <Divider />
            {low.map((s) => <p key={s.home} className={styles.warn}>{homeLabel(s.home)} is below its {s.threshold}-unit threshold.</p>)}
            <LinkButton variant="secondary" to="/inventory" style={{ minWidth: 154, alignSelf: "flex-start" }}>View stock</LinkButton>
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
              cells: [<Link key="r" className={styles.link} to={`/orders/${r.ref}`}>{r.ref}</Link>, homeLabel(r.home), <span key="h"><Badge tone="warning">Held</Badge><span className={styles.holdReason}> {r.hold!.reason}. {r.hold!.sourceAction}.</span></span>],
            }))}
          />
        </Panel>
      )}

      <HalfColumns>
        <Panel title={exceptions.length === 1 ? "1 shipment needs attention" : `${exceptions.length} shipments need attention`} subtitle="Live red alerts are routed to #ops-alerts" testId="exceptions-panel">
          {exceptions.length > 0 && (
            <FactList rows={exceptions.map((e) => [e.shipmentRef, <Link key={e.shipmentRef} className={styles.link} to={`/shipments/${e.shipmentRef}/exceptions/${e.exceptionId}`}>{e.state} · {homeLabel(e.home)}</Link>])} label="Shipments needing attention" />
          )}
          {exceptions.length > 0 && <LinkButton to={`/shipments/${exceptions[0]!.shipmentRef}/exceptions/${exceptions[0]!.exceptionId}`} style={{ minWidth: 190, alignSelf: "flex-start" }}>Review exceptions</LinkButton>}
        </Panel>
        <Panel title="A clear path to delivered" subtitle={`Last 7 days${demo ? " · synthetic sample data" : ""}`} testId="health-panel">
          <FactList wide label="Fulfillment health" rows={[
            ["Carrier transit", figure(data.health.carrierTransitDays, (d) => `${d} days average`)],
            ["Shipping cost", figure(data.health.shippingCostPerOrder, (m) => `${formatMoneyExact(m)} per order`)],
            ["On-time handoff", figure(data.health.onTimeHandoffPct, (p) => `${p}% within 2 days`)],
          ]} />
        </Panel>
      </HalfColumns>
      {view === "shipping" && <ShippingPanels />}
    </>
  );
}


function queueRow(r: QueueRow, warnAfterHours: number) {
  const over = r.waitingHours > warnAfterHours;
  const href = `/orders/${r.ref}`;
  return {
    key: r.ref,
    cells: [
      <span key="ref" className={styles.queueRef}>{r.ref}</span>,
      homeLabel(r.home),
      over ? <Badge key="w" tone="danger" width={112}>{waitingLabel(r.waitingHours)}</Badge> : <span key="w" className={styles.waiting}>{waitingLabel(r.waitingHours)}</span>,
      <LinkButton key="a" to={href} variant={over ? "secondary" : "ghost"} style={{ minWidth: 136 }}>{r.kind === "sample" ? "View sample" : "View order"}</LinkButton>,
    ],
  };
}
