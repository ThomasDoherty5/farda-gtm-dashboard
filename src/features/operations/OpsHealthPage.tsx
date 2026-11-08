import { NativeOperationsGrant } from "./NativeOperationsGrant";
import { operationsEvidenceLabel, operationsHref, operationsContext } from "./nativeRead";
import { Link, useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import type { HealthGroup, OpsHealth } from "@/adapter/opsHealth";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoney } from "@/components/MetricValue";
import { Badge } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { FlatTable, HalfColumns, Notice, Page, PageHeader, Panel } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { figure } from "./format";
import type { Money } from "@/adapter/contract";

const days = (g: { days: Parameters<typeof figure<number>>[0] }) => figure(g.days, (d) => `${d} days`);
/** Spend against its cap. A cap of zero is "no cap set", never a percentage of nothing. */
const finUsage = (cost: Money, cap: Money) => (cap.minorUnits > 0 ? `${formatMoney(cost)} of ${formatMoney(cap)} cap (${Math.round((100 * cost.minorUnits) / cap.minorUnits)}%)` : `${formatMoney(cost)} spent, no cap set`);
const trend = (now: number, before: number) => (now === before ? "no change" : `${now > before ? "+" : "−"}${Math.abs(now - before)}`);

const groupRows = (groups: HealthGroup[]) =>
  groups.map((g) => ({
    key: g.key,
    cells: [g.key, days(g.orderToShipped), days(g.shippedToDelivered), figure(g.costPerOrder, (m) => formatMoney(m)), leftOut(g)],
  }));
/** What a group leaves out of its averages, so a shorter sample is never mistaken for a full one. */
const leftOut = (g: HealthGroup) => {
  const items = [g.costUnread ? `${g.costUnread} shipped without a cost` : null, g.deliveredWithoutAcceptance ? `${g.deliveredWithoutAcceptance} delivered without a carrier scan` : null].filter((x): x is string => x !== null);
  return items.length ? <>{items.map((x) => <div key={x}>{x}</div>)}</> : "None";
};
const COLUMNS = [{ label: "Group", width: 180 }, { label: "Order to shipped", width: 170 }, { label: "Shipped to delivered", width: 190 }, { label: "Shipping cost per order", width: 200 }, { label: "Left out of averages", width: 220 }];

/**
 * Issues and fulfillment health (THO-271). This view has no Figma source: it is built from the design-system components and
 * makes no fidelity claim. Every average is derived from the shipment ledger, so the tables can't disagree with the Operations screens.
 */
export function OpsHealthPage() {
  const [search] = useSearchParams();
  const query = useView<Record<string, never>, OpsHealth>("opsHealth", {});
  const d = query.data?.data ?? null;
  return (
    <Page aria-labelledby="health-title">
      <PageHeader id="health-title" title="Issues and fulfillment health" subtitle="Support handoffs, refunds, and how fast orders ship and arrive.">
        <LinkButton to={operationsHref("/analytics/fulfillment", search)} variant="secondary" style={{ minWidth: 200 }}>Fulfillment overview</LinkButton>
      </PageHeader>
      {query.isPending && <SkeletonCard label="Loading health figures…" />}
      {query.isError && <ViewError error={query.error} subject="Health figures" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && !d && (query.data.dataState === "empty" && query.data.coverage.complete ? <EmptyState state="Empty" title="No health data yet"><p>The source responded without shipments or issues.</p></EmptyState> : <EmptyState state="Error" title="Health evidence unavailable" alert><p>Incomplete or stale evidence cannot establish that no shipments or issues exist.</p></EmptyState>)}
      {d && <NativeOperationsGrant data={d} refresh={() => { void query.refetch(); }}><Body d={d} /></NativeOperationsGrant>}
    </Page>
  );
}

function Body({ d }: { d: OpsHealth }) {
  const { issues, fulfillment: f } = d;
  const [search] = useSearchParams();
  const context = operationsContext(search, d);
  const demo = operationsEvidenceLabel(d) === "Demo data";
  const week = issues.tags.reduce((n, t) => ({ now: n.now + t.thisWeek, before: n.before + t.lastWeek }), { now: 0, before: 0 });
  return (
    <>
      <Notice tone="violet" label={operationsEvidenceLabel(d)} title={`${operationsEvidenceLabel(d)} · no Figma source`} testId="health-notice">
        {`Built from ${demo ? "a demo shipment ledger" : "source-reported shipment evidence"} and issue tags. This view has no Figma frame, so no design fidelity is claimed. These counts come from a sample ledger of ${d.integrity.shipments} shipments, not the period total on the Fulfillment overview, so the two numbers differ. A shipment counts as shipped when the carrier accepts it, not when a label is bought.`}
      </Notice>
      <KpiRow>
        <Kpi label="Order to shipped" context={`${f.all.orderToShipped.sample} shipped orders in the sample ledger`} testId="metric-Order to shipped">{days(f.all.orderToShipped)}</Kpi>
        <Kpi label="Shipped to delivered" context={`${f.all.shippedToDelivered.sample} delivered in the sample ledger · carrier delivery time${f.all.deliveredWithoutAcceptance ? ` · ${f.all.deliveredWithoutAcceptance} delivered without a carrier scan left out` : ""}`} testId="metric-Shipped to delivered">{days(f.all.shippedToDelivered)}</Kpi>
        <Kpi label="Shipping cost per order" context={f.all.costUnread ? `${f.all.costUnread} shipped order excluded: cost not read` : "Every shipped order has a cost"} testId="metric-Shipping cost per order">{figure(f.all.costPerOrder, (m) => formatMoney(m))}</Kpi>
        <Kpi label="Refunds with a receipt" context={`${issues.refunds.orders} orders · ${issues.refunds.pending.length} approved, no receipt yet`} testId="metric-Refunds">{formatMoney(issues.refunds.total)}</Kpi>
      </KpiRow>
      <HalfColumns>
        <Panel title="By home" subtitle="Averages over shipped or delivered orders" testId="by-home">
          <FlatTable caption="Fulfillment health by home" columns={COLUMNS} rows={groupRows(f.byHome)} testId="health-by-home" />
        </Panel>
        <Panel title="By carrier" subtitle={demo ? "Carriers are placeholders in the demo" : "Source-reported carrier groups"} testId="by-carrier">
          <FlatTable caption="Fulfillment health by carrier" columns={COLUMNS} rows={groupRows(f.byCarrier)} testId="health-by-carrier" />
        </Panel>
      </HalfColumns>
      <HalfColumns>
        <Panel title="Issues by tag" subtitle={`This week vs last week · ${week.now} vs ${week.before}`} testId="issues-by-tag">
          <FlatTable
            caption="Issues by tag, this week and last week"
            columns={[{ label: "Tag", width: 220 }, { label: "This week", width: 120 }, { label: "Last week", width: 120 }, { label: "Change", width: 120 }]}
            rows={issues.tags.map((t) => ({ key: t.tag, cells: [t.tag, String(t.thisWeek), String(t.lastWeek), trend(t.thisWeek, t.lastWeek)] }))}
          />
          <p data-testid="fin-usage">{`Fin: ${issues.fin.resolutions} resolutions · ${finUsage(issues.fin.cost, issues.fin.cap)} · ${issues.fin.periodLabel}`}</p>
          <Link to={demo ? "/support/cases/TEST-ISS-021" : operationsHref("/operations?view=shipping", context)}>Open the handoff queue</Link>
        </Panel>
        <Panel title="Orders that did not ship cleanly" subtitle="One order, reservation and shipment identity" testId="order-exceptions">
          <FlatTable
            caption="Orders with an exception, with their reservation and shipment"
            columns={[{ label: "Order", width: 150 }, { label: "State", width: 170 }, { label: "Reservation", width: 150 }, { label: "Shipment", width: 140 }, { label: "What it means", width: 340 }]}
            rows={d.orders.map((o) => ({
              key: o.orderRef,
              cells: [<Link key="o" to={operationsHref(`/orders/${encodeURIComponent(o.orderRef)}`, context)}>{o.orderRef}</Link>, <Badge key="s" tone={o.state === "Lost" || o.state === "Returned" ? "danger" : "warning"} width={150}>{o.state}</Badge>, o.reservationRef, o.shipmentRef ?? "No shipment", o.note],
            }))}
            testId="order-exceptions-table"
          />
          <p data-testid="ledger-integrity">{`${d.integrity.shipments} shipments · ${d.integrity.stockDecrements} stock decrements · ${d.integrity.duplicatesIgnored} duplicate events ignored · ${d.integrity.outOfOrder} shipment with out-of-order events`}</p>
        </Panel>
      </HalfColumns>
    </>
  );
}
