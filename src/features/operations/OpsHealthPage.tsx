import { NativeOperationsGrant } from "./NativeOperationsGrant";
import { operationsEvidenceLabel, operationsHref, operationsContext } from "./nativeRead";
import { Link, useSearchParams } from "react-router-dom";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import type { HealthGroup, OpsHealth } from "@/adapter/opsHealth";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoney } from "@/components/MetricValue";
import { Badge } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { FlatTable, HalfColumns, Notice, Page, PageHeader, Panel } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { figure } from "./format";
import type { Money } from "@/adapter/contract";

const days = (g: HealthGroup["orderToShipped"], complete: boolean) =>
  !complete && (g.sample === 0 || g.days.value === 0) ? "Unknown" : figure(g.days, (d) => `${d} days`);
const orderCost = (g: HealthGroup, complete: boolean) => complete ? figure(g.costPerOrder, formatMoney) : "Unknown";
/** Spend against its cap. A cap of zero is "no cap set", never a percentage of nothing. */
const finUsage = (cost: Money, cap: Money) => (cap.minorUnits > 0 ? `${formatMoney(cost)} of ${formatMoney(cap)} cap (${Math.round((100 * cost.minorUnits) / cap.minorUnits)}%)` : `${formatMoney(cost)} spent, no cap set`);
const trend = (now: number, before: number) => (now === before ? "no change" : `${now > before ? "+" : "−"}${Math.abs(now - before)}`);

const groupRows = (groups: HealthGroup[], complete: boolean) =>
  groups.map((g) => ({
    key: g.key,
    cells: [g.key, days(g.orderToShipped, complete), days(g.shippedToDelivered, complete), orderCost(g, complete), leftOut(g, complete)],
  }));
/** What a group leaves out of its averages, so a shorter sample is never mistaken for a full one. */
const leftOut = (g: HealthGroup, complete: boolean) => {
  if (!complete) return "Unknown";
  const items = [g.costUnread ? `${g.costUnread} shipped without a cost` : null, g.deliveredWithoutAcceptance ? `${g.deliveredWithoutAcceptance} delivered without a carrier scan` : null].filter((x): x is string => x !== null);
  return items.length ? <>{items.map((x) => <div key={x}>{x}</div>)}</> : "None";
};
const COLUMNS = [{ label: "Group", width: 180 }, { label: "Order to shipped", width: 170 }, { label: "Shipped to delivered", width: 190 }, { label: "Shipping cost per order", width: 200 }, { label: "Left out of averages", width: 220 }];

/**
 * Issues and fulfillment health (THO-271). This view has no Figma source: it is built from the design-system components and
 * makes no fidelity claim. The demo derives its figures from a fixture ledger. Native reads disclose source coverage.
 */
export function OpsHealthPage() {
  const [search] = useSearchParams();
  const { adapter } = useScope();
  const demo = adapter.kind === "demo";
  const filters: Record<string, string> = {};
  if (!demo) for (const name of ["home", "startAt", "endAt", "timezone"]) { const value = search.get(name); if (value !== null) filters[name] = value; }
  const query = useView<Record<string, string>, OpsHealth>("opsHealth", filters);
  const res = !demo && query.isError ? undefined : query.data;
  const d = res?.data ?? null;
  const counted = res?.coverage.complete === true && res.coverage.expectedCount !== null && res.coverage.expectedCount === res.coverage.observedCount;
  const complete = demo || (res?.dataState === "ready" && counted);
  const empty = res?.dataState === "empty" && res.coverage.complete === true && (demo || (counted && res.coverage.observedCount === 0));
  return (
    <Page aria-labelledby="health-title">
      <PageHeader id="health-title" title="Issues and fulfillment health" subtitle="Support handoffs, refunds, and how fast orders ship and arrive.">
        <LinkButton to={operationsHref("/analytics/fulfillment", operationsContext(search, d))} variant="secondary" style={{ minWidth: 200 }}>Fulfillment overview</LinkButton>
      </PageHeader>
      {query.isPending && <SkeletonCard label="Loading health figures…" />}
      {query.isError && <ViewError error={query.error} subject="Health figures" hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !d && (empty ? <EmptyState state="Empty" title="No health data yet"><p>The source responded without shipments or issues.</p></EmptyState> : <EmptyState state="Error" title="Health evidence unavailable" alert><p>Complete source coverage is required to verify an empty period.</p></EmptyState>)}
      {d && <NativeOperationsGrant data={d} refresh={() => { void query.refetch(); }}>
        {!demo && <ReadState res={res} subject="Health evidence" only={["partial", "stale"]} partialSummary="Issue, refund and Fin totals require complete coverage." />}
        <Body d={d} complete={complete} demo={demo} />
      </NativeOperationsGrant>}
    </Page>
  );
}

function Body({ d, complete, demo }: { d: OpsHealth; complete: boolean; demo: boolean }) {
  const { issues, fulfillment: f } = d;
  const [search] = useSearchParams();
  const context = operationsContext(search, d);
  const week = issues.tags.reduce((n, t) => ({ now: n.now + t.thisWeek, before: n.before + t.lastWeek }), { now: 0, before: 0 });
  const shipSample = f.all.orderToShipped.sample;
  const deliverySample = f.all.shippedToDelivered.sample;
  const shipContext = complete ? `${shipSample} shipped orders in the sample ledger` : shipSample > 0 ? `Observed handoff samples · ${shipSample}` : "Handoff timing unavailable";
  const deliveryContext = complete ? `${deliverySample} delivered in the sample ledger · carrier delivery time${f.all.deliveredWithoutAcceptance ? ` · ${f.all.deliveredWithoutAcceptance} delivered without a carrier scan left out` : ""}`
    : deliverySample > 0 ? `Observed delivery samples · ${deliverySample}` : "Delivery timing unavailable";
  const costContext = complete ? f.all.costUnread ? `${f.all.costUnread} shipped order excluded: cost not read` : "Every shipped order has a cost" : "Complete order-cost coverage required";
  return (
    <>
      <Notice tone="violet" label={operationsEvidenceLabel(d)} title={`${operationsEvidenceLabel(d)} · no Figma source`} testId="health-notice">
        {demo ? `Built from a demo shipment ledger and issue tags. This view has no Figma frame, so no design fidelity is claimed. These counts come from a sample ledger of ${d.integrity.shipments} shipments, not the period total on the Fulfillment overview, so the two numbers differ. A shipment counts as shipped when the carrier accepts it, not when a label is bought.`
          : `Shipment timing uses carrier acceptance and delivery events. ${complete ? `This sample ledger covers ${d.integrity.shipments} shipments.` : "Fulfillment figures cover observed samples only."}`}
      </Notice>
      <KpiRow>
        <Kpi label="Order to shipped" context={shipContext} testId="metric-Order to shipped">{days(f.all.orderToShipped, complete)}</Kpi>
        <Kpi label="Shipped to delivered" context={deliveryContext} testId="metric-Shipped to delivered">{days(f.all.shippedToDelivered, complete)}</Kpi>
        <Kpi label="Shipping cost per order" context={costContext} testId="metric-Shipping cost per order">{orderCost(f.all, complete)}</Kpi>
        <Kpi label="Refunds with a receipt" context={complete ? `${issues.refunds.orders} orders · ${issues.refunds.pending.length} approved, no receipt yet` : "Complete refund coverage required"} testId="metric-Refunds">{complete ? formatMoney(issues.refunds.total) : "Unknown"}</Kpi>
      </KpiRow>
      <HalfColumns>
        <Panel title="By home" subtitle={complete ? "Averages over shipped or delivered orders" : "Observed timing samples"} testId="by-home">
          <FlatTable caption="Fulfillment health by home" columns={COLUMNS} rows={groupRows(f.byHome, complete)} testId="health-by-home" />
        </Panel>
        <Panel title="By carrier" subtitle={demo ? "Carriers are placeholders in the demo" : "Source-reported carrier groups"} testId="by-carrier">
          <FlatTable caption="Fulfillment health by carrier" columns={COLUMNS} rows={groupRows(f.byCarrier, complete)} testId="health-by-carrier" />
        </Panel>
      </HalfColumns>
      <HalfColumns>
        <Panel title="Issues by tag" subtitle={complete ? `This week vs last week · ${week.now} vs ${week.before}` : "Weekly issue totals unavailable"} testId="issues-by-tag">
          {complete && <FlatTable
            caption="Issues by tag, this week and last week"
            columns={[{ label: "Tag", width: 220 }, { label: "This week", width: 120 }, { label: "Last week", width: 120 }, { label: "Change", width: 120 }]}
            rows={issues.tags.map((t) => ({ key: t.tag, cells: [t.tag, String(t.thisWeek), String(t.lastWeek), trend(t.thisWeek, t.lastWeek)] }))}
          />}
          <p data-testid="fin-usage">{complete ? `Fin: ${issues.fin.resolutions} resolutions · ${finUsage(issues.fin.cost, issues.fin.cap)} · ${issues.fin.periodLabel}` : "Fin resolutions and spend unavailable."}</p>
          <Link to={demo ? "/support/cases/TEST-ISS-021" : "/support/cases/queue"}>{demo ? "Open the handoff queue" : "Open the all-time handoff queue"}</Link>
        </Panel>
        <Panel title="Orders that did not ship cleanly" subtitle="One order, reservation and shipment identity" testId="order-exceptions">
          <FlatTable
            caption="Orders with an exception, with their reservation and shipment"
            columns={[{ label: "Order", width: 150 }, { label: "State", width: 170 }, { label: "Reservation", width: 150 }, { label: "Shipment", width: 140 }, { label: "What it means", width: 340 }]}
            rows={d.orders.map((o) => ({
              key: o.orderRef,
              cells: [<Link key="o" to={operationsHref(`/orders/${encodeURIComponent(o.orderRef)}`, context)}>{o.orderRef}</Link>, <Badge key="s" tone={o.state === "Lost" || o.state === "Returned" ? "danger" : "warning"} width={150}>{o.state}</Badge>, o.reservationRef, o.shipmentRef ?? (complete ? "No shipment" : "Shipment unknown"), o.note],
            }))}
            testId="order-exceptions-table"
          />
          <p data-testid="ledger-integrity">{complete ? `${d.integrity.shipments} shipments · ${d.integrity.stockDecrements} stock decrements · ${d.integrity.duplicatesIgnored} duplicate events ignored · ${d.integrity.outOfOrder} shipment with out-of-order events` : "Complete shipment and stock counts unavailable."}</p>
        </Panel>
      </HalfColumns>
    </>
  );
}
