import { useRef } from "react";
import { HeldOperationButton } from "./HeldOperationButton";
import type { ReturnDetail } from "@/fixtures/operations";
import type { NativeFulfillmentEvent } from "@/adapter/viewSchemas/nativeOperations";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Divider, FactList, FlatTable, HalfColumns, Note, Notice, PageHeader, Panel, TwoColumns } from "@/components/Panels";
import { formatMoneyExact } from "@/components/MetricValue";
import { NativeFulfillmentControl } from "./NativeFulfillmentControl";
import { NativeEventTimeline, nativeEventLabels } from "./NativeEventTimeline";
import { OperationsSourceLink } from "./OperationsSourceLink";
import { operationsEvidenceLabel } from "./nativeRead";
import styles from "./Operations.module.css";
export function NativeReturn({ record }: { record: ReturnDetail & { nativeEvents?: NativeFulfillmentEvent[]; proposalTargetRef?: string | null; completionVerified?: boolean } }) {
  const formRef = useRef<HTMLDivElement>(null);
  const focusPlan = () => { formRef.current?.scrollIntoView?.({ block: "nearest" }); formRef.current?.focus(); };
  const done = record.state === "resolved" && record.completionVerified === true ? record.resolved : null;
  const completedKinds: NativeFulfillmentEvent["kind"][] = ["returnReceived", record.selected.disposition === "restock" ? "inventoryRestocked" : "inventoryQuarantined", ...(record.selected.resolution === "refund" ? ["refundSettled" as const] : ["replacementCreated" as const, "replacementShipped" as const]), "accountingPosted", "caseClosed"];
  const completedEvents = completedKinds.flatMap(kind => (record.nativeEvents ?? []).filter(event => event.kind === kind && event.state === "confirmed" && event.receiptRef && event.sourceRef && event.eventAt));
  return <>
    <PageHeader id="return-title" title={done ? "Return resolved" : `Return ${record.returnRef}`} subtitle={`${record.returnRef} · ${operationsEvidenceLabel(record)} · original order ${record.orderKey}`}>
      <OperationsSourceLink compact data={record} kind="return" targetRef={record.returnRef} label="Open source case" />
      {done && <OperationsSourceLink compact data={record} kind="support" targetRef={done.caseRef} label="Back to support" />}
      {!done && <Button onClick={focusPlan}>Prepare browser task</Button>}
    </PageHeader>
    {record.state === "resolved" && !done && <Notice tone="warning" label="Unverified completion" title="Source reports resolved; completion evidence remains incomplete">Independent inventory, remedy, accounting and case receipts have not all been verified. No closed outcome is confirmed.</Notice>}
    {record.state === "resolved" && !done && <FactList label="Reported historical receipts" rows={(record.resolved?.chain ?? []).map(receipt => [receipt.outcome, `${receipt.receipt} · ${receipt.confirmedAt}`])} />}
    {done ? <>
      <Notice tone="violet" label="Source" title="Return closed with source evidence">{done.restockedUnits} units restocked; {formatMoneyExact(done.refunded)} refund reported. Each source receipt remains independently reviewable.</Notice>
      <TwoColumns><Panel title="The completed chain" subtitle="Each outcome retains its source-owned receipt" testId="return-chain"><FlatTable caption="The completed chain" columns={[{ label: "Outcome", width: 310 }, { label: "Receipt", width: 236 }, { label: "Confirmed", width: 230 }]} rows={completedEvents.map((event, index) => ({ key: `${event.kind}-${event.receiptRef}-${index}`, cells: [nativeEventLabels[event.kind], <span key="receipt">{event.receiptRef}<br />{event.sourceRef}</span>, event.eventAt ? <time key="time" dateTime={event.eventAt} title={event.eventAt} aria-label={event.eventAt}>{new Date(event.eventAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time> : "Unknown"] }))} /></Panel>
        <Panel id="closed-title" header={<h2 id="closed-title" className={styles.badgeHeading}><Badge tone="success" width={112}>Closed</Badge></h2>} testId="return-summary"><p className={styles.amount} data-testid="metric-Refunded">{formatMoneyExact(done.refunded)} refunded</p><FactList label="Return summary" rows={[["Returned units", done.returnedUnits], ["Restocked units", done.restockedUnits], ["Retained order units", done.retainedUnits], ["Replacement", done.replacement]]} /><Divider /><p className={styles.panelText}>Review any later dispute or replacement failure with the source owner. Preserve earlier decisions and receipts.</p><OperationsSourceLink compact data={record} kind="support" targetRef={done.caseRef} label="Open case to reopen" /></Panel></TwoColumns>
    </> : <>
      <Notice tone="warning" label="Review" title="Inspect source evidence before choosing an outcome">Received and inspected quantities, stock disposition, refund and replacement are distinct facts. A preview cannot restock or close this case.</Notice>
      <TwoColumns><Panel id="return-lifecycle" title="From request to reconciled outcome" subtitle="Every branch keeps the original order and return key" roomy><NativeEventTimeline events={record.nativeEvents} expected={["returnAuthorized", "returnReceived", "returnInspected", record.selected.disposition === "restock" ? "inventoryRestocked" : "inventoryQuarantined", ...(record.selected.resolution === "refund" ? ["refundSettled" as const] : ["replacementCreated" as const, "replacementShipped" as const]), "accountingPosted", "caseClosed"]} /></Panel>
        <Panel title="Prepare the source action" subtitle="Read the proposed changes before execution" testId="return-form"><div ref={formRef} tabIndex={-1} role="region" aria-label="Prepare the source return plan"><NativeFulfillmentControl inline kind="returnTask" targetRef={record.state === "resolved" ? null : record.proposalTargetRef ?? null} label="Prepare browser task" /></div><Divider /><FactList label="Current source inspection" rows={[["Received return units", record.units], ["Inspected units", record.inspection.units], ["Inspection evidence", record.inspection.receiptRef], ["Resellable", record.inspection.resellable ? "Resellable · source confirmed" : "Unconfirmed · quarantine required"]]} /><Divider /><OperationsSourceLink compact data={record} kind="return" targetRef={record.returnRef} label="Review in source" /><HeldOperationButton variant="secondary" disabledReason="Exact stock movement link unavailable. Refresh source evidence.">Open stock movement</HeldOperationButton></Panel></TwoColumns>
      <HalfColumns><Panel title="If a replacement is chosen" subtitle="A replacement creates a linked new shipment"><FactList wide label="Replacement links" rows={[["Original order", record.orderKey], ["Replacement order", "Exact new reference must come from the source plan"], ["New shipment", "Distinct source-reviewed shipment reference required"]]} /><Note>Keep the original return receipt, stock evidence, exact replacement item and cost bound linked. A replacement excludes a simultaneous refund.</Note><Button variant="secondary" onClick={focusPlan}>Preview replacement plan</Button></Panel>
        <Panel title="Close with evidence" subtitle="A browser click alone is not completion"><FactList wide label="Closing evidence" rows={[["Inventory receipt", record.pending.inventoryReceipt], ["Refund settlement", record.pending.refundSettlement], ["QuickBooks posting", record.pending.quickbooksPosting], ["Case state", record.pending.caseState]]} /><Button disabledReason="Closure requires current source inventory, remedy, accounting and case receipts. No source closure action is connected.">Close unavailable</Button><Note>Reopen through the source owner if the outcome is disputed. Never alter earlier receipts.</Note></Panel></HalfColumns>
    </>}
  </>;
}
