import { useState } from "react";
import { useParams } from "react-router-dom";
import { AdapterError } from "@/adapter/errors";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { TextField } from "@/components/Field";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoneyExact } from "@/components/MetricValue";
import { Divider, FactList, Note, Notice, PageHeader, Panel, Steps, TwoColumns } from "@/components/Panels";
import { ActionError, blockedReason, SourceDialog } from "@/features/approvals/shared";
import { homeLabel, type ShippingExceptionDetail } from "@/fixtures/operations";
import type { ReadResponse } from "@/adapter/contract";
import { figure } from "./format";
import { RecordShell } from "./RecordShell";
import styles from "./Operations.module.css";

type Choice = "refund" | "replacement";

/**
 * Shipping exception (Figma source 4:317, owner THO-301). Resolution happens in the source. The one in-app intent records which
 * path the operator chose, with an actor, a reason and the expected version. A recorded choice is queued, never an executed refund or shipment.
 */
export function ShippingExceptionPage() {
  const { shipmentId = "", exceptionId = "" } = useParams();
  const query = useView<{ shipmentId: string; exceptionId: string }, ShippingExceptionDetail>("shippingException", { shipmentId, exceptionId });
  const [source, setSource] = useState<string | null>(null);
  return (
    <RecordShell query={query} id="shipment-title" title={`Shipment ${shipmentId}`} subject="shipment exception" figma="4:317">
      {(res, e) => (
        <>
          <PageHeader id="shipment-title" title={`Shipment ${e.shipmentRef}`} subtitle="Shipping / Exception review · Source: Shippo + warehouse">
            <DecisionButton res={res} exception={e} />
            <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 168 }} onClick={() => setSource("Open Shippo")}>Open Shippo</Button>
            <Button aria-haspopup="dialog" style={{ minWidth: 210 }} onClick={() => setSource("Open the support case")}>Open support case</Button>
          </PageHeader>
          <Notice tone={e.notice.tone} label={e.notice.label} title={e.notice.title} role="alert">{e.notice.text}</Notice>
          {e.decision && (
            <Alert state="info" title={`Next step recorded: ${e.decision.choice}`} testId="decision-recorded">
              <p>{e.decision.state}</p>
              <p>Reason: {e.decision.reason}</p>
            </Alert>
          )}
          <KpiRow>
            <Kpi label="Carrier state" context={e.carrierEventLabel} testId="metric-Carrier state">{e.carrierState}</Kpi>
            <Kpi label="Home" context="Ship-from location · address protected" testId="metric-Home">{homeLabel(e.home)}</Kpi>
            <Kpi label="Shipping cost" context={e.shippingCostContext} testId="metric-Shipping cost">{figure(e.shippingCost, formatMoneyExact)}</Kpi>
            <Kpi label="Last sync" context={e.lastSyncContext} testId="metric-Last sync">{e.lastSyncLabel}</Kpi>
          </KpiRow>
          <TwoColumns>
            <Panel title="Carrier timeline" subtitle="Event time and sync time are different" roomy>
              <Steps label="Carrier timeline" steps={e.events} />
              <Divider />
              <Note>{e.postingClockNote}</Note>
            </Panel>
            <Panel title="Resolve in the source" subtitle="Operator action required">
              <FactList label="Exception ownership" rows={[["Owner", e.owner], ["Order key", e.orderKey], ["Alert", e.alert], ["Support case", e.supportCase]]} />
              <Divider />
              <ol className={styles.checklist}>{e.steps.map((step, i) => <li key={step}>{i + 1}. {step}</li>)}</ol>
              <Button aria-haspopup="dialog" style={{ minWidth: 238, alignSelf: "flex-start" }} onClick={() => setSource("Open the case in Intercom")}>Open case in Intercom</Button>
            </Panel>
          </TwoColumns>
          <Notice tone="violet" label="Source" title="Safe recovery">Duplicate tracking events are ignored by event key. A replacement is a new shipment, not a replay of the original label purchase.</Notice>
          <SourceDialog open={source !== null} title={source ?? ""} url={null} onClose={() => setSource(null)} />
        </>
      )}
    </RecordShell>
  );
}

function DecisionButton({ res, exception }: { res: ReadResponse<ShippingExceptionDetail>; exception: ShippingExceptionDetail }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [reason, setReason] = useState("");
  const action = useAction<{ shipmentRef: string; exceptionId: string; decision: Choice | null; reason: string }>();
  const blocked = blockedReason(res, "recordShippingDecision");
  const fieldErrors = action.error instanceof AdapterError ? (action.error.body.fieldErrors ?? {}) : {};
  const conflict = action.error instanceof AdapterError && action.error.category === "conflict";

  const submit = () =>
    action.mutate(
      { operation: "requestApproval", actionKind: "recordShippingDecision", entityRefs: [], expectedVersion: exception.version, approvalRef: null, manifestRef: null, payload: { shipmentRef: exception.shipmentRef, exceptionId: exception.exceptionId, decision: choice, reason } },
      { onSuccess: () => { setOpen(false); setChoice(null); setReason(""); } },
    );

  return (
    <>
      <Button variant="secondary" aria-haspopup="dialog" disabledReason={blocked} style={{ minWidth: 176 }} onClick={() => { action.reset(); setOpen(true); }}>Record next step</Button>
      <Dialog open={open} title="Record the next step" badge="Demo" onClose={() => setOpen(false)}>
        <p>This records your choice and reason against version {exception.version}. It does not refund, ship or change anything in Shopify or Shippo.</p>
        <form className={styles.stack} onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
          <fieldset className={styles.optionsRow} aria-describedby={fieldErrors.decision ? "decision-error" : undefined}>
            <legend>Next step</legend>
            {(["refund", "replacement"] as const).map((c) => (
              <label key={c} className={styles.option}>
                <input type="radio" name="next-step" checked={choice === c} onChange={() => setChoice(c)} />
                {c === "refund" ? "Refund the order" : "Send a replacement (new order and shipment key)"}
              </label>
            ))}
            {fieldErrors.decision && <span id="decision-error" role="alert" className={styles.holdReason}>{fieldErrors.decision}</span>}
          </fieldset>
          <TextField label="Reason" helpText="Operational reason only. No customer details." multiline rows={3} value={reason} onChange={setReason} error={fieldErrors.reason ?? null} />
          {action.error && <ActionError error={action.error} />}
          {conflict && <Button variant="secondary" type="button" onClick={() => { action.reset(); setOpen(false); }}>Reload the record</Button>}
          <Button type="submit" loading={action.isPending}>Record next step</Button>
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>Cancel</Button>
        </form>
      </Dialog>
    </>
  );
}
