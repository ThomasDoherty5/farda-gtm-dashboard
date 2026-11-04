import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SelectField, TextField } from "@/components/Field";
import { formatMoneyExact } from "@/components/MetricValue";
import { Divider, FactList, FlatTable, HalfColumns, Note, Notice, PageHeader, Panel, Steps, TwoColumns } from "@/components/Panels";
import { ActionError, blockedReason, EXECUTION_LABELS, LeaveGuard, SourceDialog } from "@/features/approvals/shared";
import type { ReturnDetail, ReturnDisposition, ReturnResolution } from "@/fixtures/operations";
import { RecordShell } from "./RecordShell";
import styles from "./Operations.module.css";

type Draft = { disposition: ReturnDisposition; resolution: ReturnResolution; reason: string };
type Payload = Draft & { returnRef: string };

const money = (m: { minorUnits: number; currency: string }) => formatMoneyExact(m);

/**
 * Return and replacement (Figma sources 12:292 active and 12:431 resolved, owner THO-301). The record's state decides which one shows.
 * The fields are a draft of a proposal. Preparing the task asks for approval; it does not refund, restock or ship, and closing
 * needs source receipts that a click can never supply.
 */
export function ReturnPage() {
  const { returnId = "" } = useParams();
  const [search] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const query = useView<{ returnId: string; scenario?: string }, ReturnDetail>("returnDetail", scenario ? { returnId, scenario } : { returnId });
  return (
    <RecordShell query={query} id="return-title" title={`Return ${returnId}`} subject="return" figma="12:292">
      {(res, r) => (r.state === "resolved" && r.resolved ? <Resolved r={r} /> : <Active key={r.version} res={res} r={r} />)}
    </RecordShell>
  );
}

function Resolved({ r }: { r: ReturnDetail }) {
  const [source, setSource] = useState<string | null>(null);
  const done = r.resolved!;
  return (
    <>
      <PageHeader id="return-title" title="Return resolved" subtitle={`${r.returnRef} · All source receipts match · Synthetic success state`}>
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 194 }} onClick={() => setSource("View the source case")}>View source case</Button>
        <LinkButton to={`/support/cases/${done.caseRef}`} style={{ minWidth: 190 }}>Back to support</LinkButton>
      </PageHeader>
      <Notice tone="violet" label="Source" title="Return closed with source evidence">One unit was restocked, the {money(done.refunded)} refund settled, and QuickBooks recorded the reversal. The event chain is retained.</Notice>
      <TwoColumns>
        <Panel title="The completed chain" subtitle="Each success links to a source-owned record" testId="return-chain">
          <FlatTable
            caption="The completed chain"
            columns={[{ label: "Outcome", width: 310 }, { label: "Receipt", width: 236 }, { label: "Confirmed", width: 230 }]}
            rows={done.chain.map((c) => ({ key: c.receipt, cells: [c.outcome, c.receipt, c.confirmedAt] }))}
          />
        </Panel>
        <Panel id="closed-title" header={<h2 id="closed-title" className={styles.badgeHeading}><Badge tone="success" width={112}>Closed</Badge></h2>} testId="return-summary">
          <p className={styles.amount} data-testid="metric-Refunded">{money(done.refunded)} refunded</p>
          <FactList label="Return summary" rows={[["Returned units", done.returnedUnits], ["Restocked units", done.restockedUnits], ["Retained order units", done.retainedUnits], ["Replacement", done.replacement]]} />
          <Divider />
          <p className={styles.panelText}>If the outcome changes, reopen the case in Intercom and create a new action. Do not edit earlier receipts.</p>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 224, alignSelf: "flex-start" }} onClick={() => setSource("Open the case to reopen")}>Open case to reopen</Button>
        </Panel>
      </TwoColumns>
      <SourceDialog open={source !== null} title={source ?? ""} url={null} onClose={() => setSource(null)} />
    </>
  );
}

const DISPOSITIONS = (units: number): { value: ReturnDisposition; label: string }[] => [
  { value: "restock", label: `Restock · ${units} unit${units === 1 ? "" : "s"}` },
  { value: "quarantine", label: `Quarantine · ${units} unit${units === 1 ? "" : "s"}` },
];
const RESOLUTIONS = (amount: string): { value: ReturnResolution; label: string }[] => [
  { value: "refund", label: `Refund · ${amount}` },
  { value: "replacement", label: "Replacement · new order and shipment key" },
];

function Active({ res, r }: { res: ReadResponse<ReturnDetail>; r: ReturnDetail }) {
  const [source, setSource] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const saved: Draft = r.selected;
  const [draft, setDraft] = useState<Draft>(saved);
  const action = useAction<Payload>();
  const dirty = draft.disposition !== saved.disposition || draft.resolution !== saved.resolution || draft.reason !== saved.reason;
  const fieldErrors = action.error instanceof AdapterError ? (action.error.body.fieldErrors ?? {}) : {};
  const prepareBlocked = blockedReason(res, "prepareReturnTask");
  const closeBlocked = blockedReason(res, "closeReturn");
  const amount = money(r.refundAmount);

  const prepare = () =>
    action.mutate({ operation: "requestApproval", actionKind: "prepareReturnTask", entityRefs: [], expectedVersion: r.version, approvalRef: null, manifestRef: null, payload: { returnRef: r.returnRef, ...draft } });

  return (
    <>
      <LeaveGuard dirty={dirty} subject="return proposal" />
      <PageHeader id="return-title" title={`Return ${r.returnRef}`} subtitle={`Support / Returns · Order ${r.orderKey} · One unit returned`}>
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 200 }} onClick={() => setSource("Open the source case")}>Open source case</Button>
        <Button loading={action.isPending} disabledReason={prepareBlocked} style={{ minWidth: 224 }} onClick={prepare}>Prepare browser task</Button>
      </PageHeader>
      <Notice tone="warning" label="Review" title="Inspection complete · Refund is not posted yet">Review the selected stock disposition and refund. Source receipts are required before this case can close.</Notice>
      {action.error && <ActionError error={action.error} />}
      {(action.data || r.proposal) && (
        <Alert state="info" title={action.data ? EXECUTION_LABELS[action.data.state] : "Prepared, waiting for approval"} testId="proposal-status">
          <p>{r.proposal?.state ?? "Prepared and waiting for approval. Nothing has been refunded, restocked or shipped."}</p>
        </Alert>
      )}
      <TwoColumns>
        <Panel id="return-lifecycle" title="From request to reconciled outcome" subtitle="Every branch keeps the original order and return key" roomy>
          <Steps label="Return lifecycle" steps={r.lifecycle} />
        </Panel>
        <Panel title="Prepare the source action" subtitle="Read the proposed changes before execution" testId="return-form">
          <SelectField label="Disposition" helpText={fieldErrors.disposition ?? "Quarantine damaged or unverified stock."} error={fieldErrors.disposition ?? null} value={draft.disposition} onChange={(v) => setDraft({ ...draft, disposition: v as ReturnDisposition })} options={DISPOSITIONS(r.inspection.units)} />
          <SelectField label="Resolution" helpText="Alternative: replacement with a new order and shipment key." error={fieldErrors.resolution ?? null} value={draft.resolution} onChange={(v) => setDraft({ ...draft, resolution: v as ReturnResolution })} options={RESOLUTIONS(amount)} />
          <TextField label="Reason" helpText="No customer conversation text is copied here." error={fieldErrors.reason ?? null} value={draft.reason} onChange={(v) => setDraft({ ...draft, reason: v })} />
          {dirty && <Button variant="ghost" onClick={() => setDraft(saved)} style={{ alignSelf: "flex-start" }}>Reset to the source's selection</Button>}
          <Divider />
          <span><Badge tone="warning" width={224}>{r.sourceReview}</Badge></span>
          <Button aria-haspopup="dialog" style={{ minWidth: 216, alignSelf: "flex-start" }} onClick={() => setSource("Review in Shopify")}>Review in Shopify</Button>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 230, alignSelf: "flex-start" }} onClick={() => setSource("Open the stock movement")}>Open stock movement</Button>
        </Panel>
      </TwoColumns>
      <HalfColumns>
        <Panel title="If a replacement is chosen" subtitle="A replacement creates a linked new shipment">
          <FactList wide label="Replacement links" rows={[["Original order", r.orderKey], ["Replacement order", "Created in source after review"], ["New shipment", "New label and tracking key"]]} />
          <Note>Do not replay the original purchase-label step. Keep the original return receipt, stock disposition and replacement cost linked.</Note>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 266, alignSelf: "flex-start" }} onClick={() => setPreview(true)}>Preview replacement plan</Button>
        </Panel>
        <Panel title="Close with evidence" subtitle="A browser click alone is not completion">
          <FactList wide label="Closing evidence" rows={[["Inventory receipt", r.pending.inventoryReceipt], ["Refund settlement", r.pending.refundSettlement], ["QuickBooks posting", r.pending.quickbooksPosting], ["Case state", r.pending.caseState]]} />
          <Button disabledReason={closeBlocked ? "Needs the inventory receipt, refund settlement and QuickBooks posting." : null} style={{ minWidth: 202, alignSelf: "flex-start" }}>Close unavailable</Button>
          <Note>Reopen from the source if the outcome is disputed or the replacement fails. Preserve the earlier decision history.</Note>
        </Panel>
      </HalfColumns>
      <Dialog open={preview} title="Replacement plan preview" badge="Preview only" onClose={() => setPreview(false)}>
        <p>Original order {r.orderKey} and return {r.returnRef}. Replacement items: {r.units} × Farda device · Graphite. A replacement gets a new order and shipment key, created in the source after review; address access stays in Shopify.</p>
        <p>This preview refunds nothing and ships nothing. The refund of {amount} would not also be issued.</p>
        <Button variant="secondary" onClick={() => setPreview(false)}>Close preview</Button>
      </Dialog>
      <SourceDialog open={source !== null} title={source ?? ""} url={null} onClose={() => setSource(null)} />
    </>
  );
}
