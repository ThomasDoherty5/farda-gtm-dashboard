import { useState } from "react";
import { useParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Button } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoneyExact } from "@/components/MetricValue";
import { Divider, FactList, FlatTable, Note, Notice, PageHeader, Panel, SectionHeading, Steps, TwoColumns } from "@/components/Panels";
import { SourceDialog } from "@/features/approvals/shared";
import type { OrderDetail } from "@/fixtures/operations";
import { homeLabel } from "@/fixtures/operations";
import { figure, reasonText } from "./format";
import { CustomerReveal } from "./CustomerReveal";
import { RecordShell } from "./RecordShell";
import styles from "./Operations.module.css";

/**
 * Order detail (Figma source 4:171, owner THO-301). A read-only mirror: refunds, cancellations and edits happen in Shopify.
 * The lifecycle keeps paid, label created, carrier accepted, shipped, delivered, return, refund and replacement as separate facts.
 */
export function OrderPage() {
  const { orderId = "" } = useParams();
  const query = useView<{ orderId: string }, OrderDetail>("orderDetail", { orderId });
  const [source, setSource] = useState<string | null>(null);
  return (
    <RecordShell query={query} id="order-title" title={`Order ${orderId}`} subject="order" figma="4:171">
      {(_res, o) => {
        const sample = o.kind === "sample";
        const total = (m: { minorUnits: number; currency: string }) => formatMoneyExact(m);
        return (
          <>
            <PageHeader id="order-title" title={`${sample ? "Sample" : "Order"} ${o.orderRef}`} subtitle={`${sample ? "Samples" : "Orders"} / ${o.orderRef} · Shopify → Sheets → Notion mirror`}>
              <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 168 }} onClick={() => setSource("Open Shopify")}>Open Shopify</Button>
              <Button aria-haspopup="dialog" style={{ minWidth: 190 }} onClick={() => setSource("Open the source row")}>Open source row</Button>
            </PageHeader>
            <Notice tone={o.notice.tone} label={o.notice.label} title={o.notice.title} role={o.notice.tone === "danger" ? "alert" : undefined} testId="order-notice">{o.notice.text}</Notice>
            <KpiRow>
              <Kpi label="Order total" context={reasonText(o.total) ?? o.totalContext} testId="metric-Order total">{figure(o.total, total)}</Kpi>
              <Kpi label="Refunded" context={reasonText(o.refunded) ?? o.refundedContext} testId="metric-Refunded">{figure(o.refunded, total)}</Kpi>
              <Kpi label="Attribution" context={o.attributionContext} testId="metric-Attribution">{o.attributionLabel}</Kpi>
              <Kpi label="Mirror status" context={o.mirror.context} testId="metric-Mirror status">{o.mirror.label}</Kpi>
            </KpiRow>
            <TwoColumns>
              <Panel id="lifecycle-title" title="Fulfillment lifecycle" subtitle="Every event retains its source record key" roomy>
                <Steps label="Fulfillment lifecycle" steps={o.milestones} />
                <Divider />
                <SectionHeading title="Line items" subtitle={<CustomerReveal orderRef={o.orderRef} />} />
                <FlatTable
                  caption="Line items"
                  columns={[{ label: "Item", width: 416 }, { label: "Units", width: 80 }, { label: "Unit price", width: 140 }, { label: "Total", width: 140 }]}
                  rows={o.items.map((item) => ({
                    key: item.name,
                    cells: [item.name, item.units, figure(item.unitPrice, total), figure(item.unitPrice, (m) => total({ ...m, minorUnits: m.minorUnits * item.units }))],
                  }))}
                />
              </Panel>
              <Panel title="Record context" subtitle="Read-only operational mirror">
                <FactList
                  label="Record context"
                  rows={[["Source key", o.sourceKey], ["Home", homeLabel(o.home)], ["Channel", o.channel], ["Collaboration", o.collaboration ?? "None"], ["Discount code", o.discountCode ?? "None"], ["Attribution", o.discountCode ? "Discount code" : o.attributionLabel]]}
                />
                <Divider />
                <Note>Refund, cancel, or edit this order in Shopify. Zapier updates the warehouse and ledger.</Note>
                <Button aria-haspopup="dialog" style={{ minWidth: 210, alignSelf: "flex-start" }} onClick={() => setSource("Open the source order")}>Open source order</Button>
              </Panel>
            </TwoColumns>
            {o.refundPath.length > 0 && (
              <Panel title="Refunds have their own lifecycle" subtitle="A refund does not automatically mean stock is resellable.">
                <ol className={styles.refundStates} aria-label="Refund lifecycle">
                  {o.refundPath.map((step) => (
                    <li key={step.key}>
                      <span><Badge tone={step.reached ? "success" : "neutral"}>{step.label}<span className="visually-hidden">{step.reached ? " · reached" : " · not reached"}</span></Badge></span>
                      <p>{step.note}</p>
                    </li>
                  ))}
                </ol>
              </Panel>
            )}
            <SourceDialog open={source !== null} title={source ?? ""} url={null} onClose={() => setSource(null)} />
          </>
        );
      }}
    </RecordShell>
  );
}
