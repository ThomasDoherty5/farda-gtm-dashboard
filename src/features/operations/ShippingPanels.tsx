import type { NativeOperationsShipment } from "@/adapter/viewSchemas/nativeOperations";
import { isOperationsRecordPath, operationsEvidenceLabel, operationsHref, operationsContext } from "./nativeRead";
import { NativeOperationsGrant } from "./NativeOperationsGrant";
import { Link, useSearchParams } from "react-router-dom";
import { useScope } from "@/adapter/scope";
import { ReadState } from "@/components/ReadState";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ViewError } from "@/components/ViewError";
import { FlatTable, Panel } from "@/components/Panels";
import { EXCEPTION_KINDS, type CarrierState, type ChainStep, type OpsException, type Shipment } from "@/fixtures/opsShipping";
import { waitingLabel } from "./format";
import styles from "./Operations.module.css";

export type ShippingData = { datasetKey: "operations-shipping-demo" | "operations-native"; shipments: (Shipment | NativeOperationsShipment)[]; exceptions: OpsException[]; chain: ChainStep[] };

const isInTransit = (row: { carrierState: CarrierState }) => ["inTransit", "outForDelivery", "deliveredUnconfirmed"].includes(row.carrierState);

const CARRIER: Record<CarrierState, string> = {
  labelCreated: "Label created",
  inTransit: "In transit",
  outForDelivery: "Out for delivery",
  deliveredUnconfirmed: "Delivered, not confirmed by the carrier",
  delivered: "Delivered, confirmed",
  lost: "Lost",
  returned: "Returned",
};

/** Counts per exception kind, derived from the rows. A kind with no rows is a known 0 from this read. */
export const exceptionCounts = (rows: OpsException[]) => Object.fromEntries(EXCEPTION_KINDS.map((k) => [k.kind, rows.filter((r) => r.kind === k.kind).length])) as Record<OpsException["kind"], number>;

/** Shipping detail for the Operations shipping view: what is in transit, which exception kinds are open, and one linked sandbox chain. Read-only. */
export function ShippingPanels({ reportingContext }: { reportingContext?: URLSearchParams } = {}) {
  const { adapter } = useScope();
  const [urlSearch] = useSearchParams();
  const search = reportingContext ?? urlSearch;
  const filters: Record<string, string> = {};
  if (adapter.kind !== "demo") for (const name of ["home", "startAt", "endAt", "timezone"]) { const value = search.get(name); if (value !== null) filters[name] = value; }
  const query = useView<Record<string, string>, ShippingData>("operationsShipping", filters);
  const data = query.data?.data ?? null;
  if (query.isPending) return <SkeletonCard label="Loading shipping evidence…" />;
  if (query.isError) return <ViewError error={query.error} subject="Shipping evidence" onRetry={() => { void query.refetch(); }} />;
  if (!data) {
    const empty=query.data?.dataState==="empty"&&query.data.coverage.complete===true;
    return <EmptyState state={empty?"Empty":"Error"} title={empty?"No shipping data yet":"Shipping evidence unavailable"} alert={!empty}>
      <p>{empty?"The source returned no shipping records for this home and reporting period.":"Incomplete or stale source evidence cannot establish that no shipments exist."}</p>
      <Button variant="secondary" onClick={() => { void query.refetch(); }}>Refresh shipping evidence</Button>
    </EmptyState>;
  }
  const context = operationsContext(search, data);
  const complete = adapter.kind === "demo" || query.data?.coverage.complete === true && query.data.dataState !== "stale";
  const transit = data.shipments.filter(isInTransit);
  const delivered = data.shipments.filter((s) => s.carrierState === "delivered");
  const activeShipments = data.shipments.filter(s => s.carrierState !== "delivered").sort((a, b) => Number(!["lost", "returned"].includes(a.carrierState)) - Number(!["lost", "returned"].includes(b.carrierState)) || a.ref.localeCompare(b.ref));
  const sourceLink = (to: string | null, label: string) => to && isOperationsRecordPath(to) ? <Link className={styles.link} to={operationsHref(to, context)}>{label}</Link> : <Button variant="ghost" disabledReason="A verified internal source record was not supplied.">{label}</Button>;
  const shipmentLink = (row: Shipment | NativeOperationsShipment) => {
    if (!("shipmentDetail" in row) || !row.shipmentDetail || row.shipmentDetail.shipmentRef !== row.ref) return <Button variant="ghost" disabledReason="An exact source shipment destination was not supplied.">{row.ref}</Button>;
    const detail = row.shipmentDetail;
    if (detail.kind === "exception") return sourceLink(`/shipments/${encodeURIComponent(detail.shipmentRef)}/exceptions/${encodeURIComponent(detail.exceptionRef)}`, row.ref);
    const path = operationsHref("/operations?view=hub", context);
    const params = new URLSearchParams(path.split("?")[1]); params.set("ship-query", detail.shipmentRef);
    return <Link className={styles.link} to={`/operations?${params}`}>{row.ref}</Link>;
  };
  const originLink = (row: Shipment | NativeOperationsShipment) => {
    if (!("originDetail" in row)) return row.orderRef;
    const detail = row.originDetail;
    const identity = detail?.kind === "order" ? row.orderRef : row.sampleRef;
    const label = row.orderRef && row.sampleRef ? `Order ${row.orderRef} · Sample ${row.sampleRef}` : row.sampleRef ? `Sample ${row.sampleRef}` : row.orderRef ? `Order ${row.orderRef}` : "Origin unknown";
    return sourceLink(detail && detail.ref === identity ? `/orders/${encodeURIComponent(detail.ref)}` : null, label);
  };
  const counts = exceptionCounts(data.exceptions);
  return (
    <NativeOperationsGrant data={data} refresh={() => { void query.refetch(); }}>
      <ReadState res={query.data} subject="Shipping evidence" only={["partial", "stale"]} />
      {!complete && <p role="status">Counts below describe observed rows only. Full source totals are unknown; missing rows do not establish zero.</p>}
      <Panel id="transit-title" title={`${transit.length} ${complete ? "in transit" : "observed in transit"}`} subtitle={`${delivered.length} confirmed delivered are not counted. A delivery the carrier hasn't confirmed is still in transit.`} testId="in-transit">
        <FlatTable
          caption="Shipments by carrier state"
          testId="shipments-table"
          columns={[{ label: "Shipment", width: 200 }, { label: "Order / sample", width: 200 }, { label: "Carrier state", width: 360 }, { label: "Counts as", width: 140 }]}
          rows={activeShipments.map((s) => ({ key: s.ref, cells: [data.datasetKey === "operations-native" ? shipmentLink(s) : s.ref, originLink(s), `${CARRIER[s.carrierState]}${s.lastScan ? ` · ${s.lastScan}` : ""}`, isInTransit(s) ? <Badge key="b" tone="violet">In transit</Badge> : <Badge key="b">Not in transit</Badge>] }))}
        />
      </Panel>
      <Panel id="exception-kinds-title" title="Exceptions by kind" subtitle={complete ? "Each count is derived from the complete returned rows" : "Observed rows only · complete exception totals unknown"} testId="exception-kinds">
        <ul className={styles.stockList} aria-label="Exception counts">
          {EXCEPTION_KINDS.map((k) => <li key={k.kind} data-testid={`exc-${k.kind}`}><strong>{k.label}</strong> · {counts[k.kind]} · {k.meaning}</li>)}
        </ul>
        <FlatTable
          caption="Open exceptions"
          testId="exceptions-table"
          columns={[{ label: "Record", width: 200 }, { label: "Kind", width: 180 }, { label: "Age", width: 140 }, { label: "Detail", width: 300 }, { label: "Next action", width: 240 }]}
          rows={data.exceptions.map((e) => ({ key: e.id, cells: [e.ref, EXCEPTION_KINDS.find((k) => k.kind === e.kind)!.label, waitingLabel(e.ageHours), e.detail, <span key="l">{sourceLink(e.to, e.next)}</span>] }))}
        />
      </Panel>
      <Panel id="chain-title" title={operationsEvidenceLabel(data) === "Demo data" ? "One linked sandbox walk-through" : "Linked source records"} subtitle="An order, the sample that shares its stock, the shortage that holds it and the transfer that would clear it" testId="sandbox-chain">
        <ol aria-label="Linked sandbox records" className={styles.stockList}>
          {data.chain.map((c) => <li key={c.key} data-testid={`chain-${c.key}`}><strong>{c.label}</strong> · {sourceLink(c.to, c.ref)} · {c.state}</li>)}
        </ol>
        <p className={styles.stat}>{operationsEvidenceLabel(data) === "Demo data" ? "Sandbox records only." : operationsEvidenceLabel(data) + "."} Nothing here moves stock, ships or refunds.</p>
      </Panel>
    </NativeOperationsGrant>
  );
}
