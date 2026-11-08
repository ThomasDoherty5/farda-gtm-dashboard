import { useState } from "react";
import { z } from "zod";
import { scopeKey, useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { useAction } from "@/adapter/useAction";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SelectField, TextField } from "@/components/Field";
import { FactList } from "@/components/Panels";
import type { FulfillmentKind, FulfillmentProposal } from "@/creator-agent/fulfillmentDomain/contract";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { formatMoneyExact } from "@/components/MetricValue";
import styles from "./Operations.module.css";
const markerSchema = z.object({ requestKey: z.string().min(1), kind: z.enum(["shippingDecision", "returnTask"]), targetRef: z.string().min(1), planRef: z.string().min(1), version: z.string().min(1) }).strict();
type Marker = z.infer<typeof markerSchema>;
type Payload = { kind: FulfillmentKind; targetRef: string; planRef: string; reason: string };
export function NativeFulfillmentControl({ kind, targetRef, label }: { kind: FulfillmentKind; targetRef: string | null; label: string }) {
  const ctx = useScope();
  const [open, setOpen] = useState(false);
  if (!targetRef) return <Button disabledReason="A source-owned proposal target was not supplied. Refresh source evidence before preparing an action.">{label}</Button>;
  return <><Button aria-haspopup="dialog" onClick={() => setOpen(true)}>{label}</Button><Dialog open={open} title={kind === "returnTask" ? "Prepare the source return plan" : "Record the next step"} onClose={() => setOpen(false)}>{open && <Proposal key={JSON.stringify([...scopeKey(ctx), kind, targetRef])} kind={kind} targetRef={targetRef} />}<Button variant="secondary" onClick={() => setOpen(false)}>Close plan review</Button></Dialog></>;
}
function Proposal({ kind, targetRef }: { kind: FulfillmentKind; targetRef: string }) {
  const ctx = useScope();
  const storageKey = JSON.stringify(["native-fulfillment-preview-v1", ...scopeKey(ctx), kind, targetRef]);
  const [retained, setRetained] = useState<{ marker: Marker | null; invalid: boolean }>(() => { try { const raw = sessionStorage.getItem(storageKey); if (raw === null) return { marker: null, invalid: false }; const parsed = markerSchema.safeParse(JSON.parse(raw)); return parsed.success && parsed.data.kind === kind && parsed.data.targetRef === targetRef ? { marker: parsed.data, invalid: false } : { marker: null, invalid: true }; } catch { return { marker: null, invalid: true }; } });
  const marker = retained.marker;
  const query = useView<{ kind: FulfillmentKind; targetRef: string; requestKey?: string }, FulfillmentProposal>("fulfillmentProposal", { kind, targetRef, ...(marker ? { requestKey: marker.requestKey } : {}) });
  const data = query.data?.data;
  const leased = useSourceLease(data?.source.validUntil);
  const [planRef, setPlanRef] = useState(marker?.planRef ?? ""), [reason, setReason] = useState("");
  const [quantity, setQuantity] = useState(""), [disposition, setDisposition] = useState(""), [resolution, setResolution] = useState("");
  const action = useAction<Payload>();
  const plan = data?.plans.find(item => item.planRef === planRef);
  const originalRetry = !!marker && data?.recovery?.requestKey === marker.requestKey && data.recovery.state === "absent" && data.version === marker.version;
  const hold = retained.invalid ? "The original request marker cannot be safely recovered. Contact the source owner; do not start another request." : !leased || query.data?.dataState !== "ready" ? "Refresh current complete source authority." : data?.capability.state !== "available" ? "Current source authority does not permit this preview." : marker && !originalRetry ? "Check the original request. A second preview must not replace an uncertain request." : !plan ? "Choose an exact source-reviewed plan." : plan.capability.state !== "available" ? plan.capability.reasonCodes.join(" · ") || "This source plan is held." : !reason.trim() ? "Enter a minimal operational reason." : reason.length > 500 ? "Keep the reason within 500 characters." : undefined;
  const submit = () => {
    if (hold || !data || !plan || action.isPending || Date.parse(data.source.validUntil) <= Date.now()) return;
    const original: Marker = marker ?? { requestKey: crypto.randomUUID(), kind, targetRef, planRef: plan.planRef, version: data.version };
    if (!marker) try { sessionStorage.setItem(storageKey, JSON.stringify(original)); } catch { setRetained({ marker: null, invalid: true }); return; }
    setRetained({ marker: original, invalid: false });
    action.mutate({ operation: "previewAction", actionKind: "previewFulfillmentDecision", entityRefs: [], expectedVersion: original.version, approvalRef: null, manifestRef: null, idempotencyKey: original.requestKey, payload: { kind, targetRef, planRef: original.planRef, reason: reason.trim() } });
  };
  const change = (setter: (value: string) => void) => (value: string) => { if (!marker) { setter(value); setPlanRef(""); } };
  if (!data || query.isError || !leased || data.target.kind !== kind || data.target.ref !== targetRef) return <div role="status"><p>{query.isPending ? "Reading current source plans…" : "Source plans are unavailable or expired. No request is submitted automatically; check any original request before retrying."}</p><Button variant="secondary" onClick={() => { void query.refetch(); }}>Refresh source plans</Button></div>;
  const choices = data.plans.filter(item => (!quantity || String(item.inspectedQuantity) === quantity) && (!disposition || item.disposition === disposition) && (!resolution || item.remedy.kind === resolution));
  const recovery = data.recovery;
  const approvalRef = recovery?.state === "recorded" && recovery.requestKey === marker?.requestKey ? recovery.approvalRef : action.data?.approvalRef;
  return <div className={styles.stack}>
    <p>{data.source.synthetic ? "Synthetic source evidence" : "Source evidence"} · observed {new Date(data.source.observedAt).toLocaleString()}. A preview creates an approval manifest; it does not refund, restock, replace, label or ship.</p>
    {marker ? <section aria-label="Original preview request"><p role="status">Original request: {recovery?.state ?? "checking"}. {recovery?.state === "pending" ? "Wait for source reconciliation; do not submit another preview." : "Keep this original key and plan. Source review is required before any retry."}</p><Button variant="secondary" onClick={() => { void query.refetch(); }}>Check original request</Button>{originalRetry && <><p>The source reports no applied preview for this key. Re-enter the exact original reason to retry this same plan and version. The original reason was not saved in this browser; a conflicting late request will be rejected.</p><TextField label="Original operational reason" value={reason} onChange={setReason} helpText="Re-enter the original reason. Do not add customer details." /></>}</section> : <>
      {kind === "returnTask" && <><SelectField label="Inspected quantity" value={quantity} onChange={change(setQuantity)} options={[{ value: "", label: "Choose a source-inspected quantity" }, ...[...new Set(data.plans.flatMap(item => item.inspectedQuantity === null ? [] : [String(item.inspectedQuantity)]))].map(value => ({ value, label: value }))]} /><SelectField label="Disposition" value={disposition} onChange={change(setDisposition)} options={[{ value: "", label: "Choose a source disposition" }, ...[...new Set(data.plans.map(item => item.disposition))].map(value => ({ value, label: value }))]} /></>}
      <SelectField label="Resolution" value={resolution} onChange={change(setResolution)} options={[{ value: "", label: "Choose refund or replacement" }, ...[...new Set(data.plans.map(item => item.remedy.kind))].map(value => ({ value, label: value }))]} />
      <SelectField label="Exact source plan" value={planRef} onChange={setPlanRef} options={[{ value: "", label: "Choose a bounded source plan" }, ...choices.map(item => ({ value: item.planRef, label: item.summary }))]} />
      <TextField label="Reason" helpText="Minimal operational reason only. Do not copy customer details or conversation text. This draft is not stored in the browser." value={reason} onChange={setReason} />
    </>}
    {plan && <PlanFacts plan={plan} />}
    {data.capability.reasonCodes.length > 0 && <p role="status">{data.capability.reasonCodes.join(" · ")}</p>}
    {action.isError && <p role="alert">The preview did not return a confirmed outcome. Check the original request; do not create a replacement key.</p>}
    {approvalRef ? <LinkButton to={`/approvals/${encodeURIComponent(approvalRef)}`}>Review exact approval manifest</LinkButton> : (!marker || originalRetry) && <Button disabledReason={hold} loading={action.isPending} onClick={submit}>{marker ? "Retry original preview" : "Preview exact source plan"}</Button>}
  </div>;
}
function PlanFacts({ plan }: { plan: FulfillmentProposal["plans"][number] }) {
  const remedy = plan.remedy;
  return <FactList label="Exact source-reviewed effects" rows={[
    ["Disposition", plan.disposition], ["Inspected quantity", plan.inspectedQuantity === null ? "Not applicable" : String(plan.inspectedQuantity)], ["Inspection evidence", plan.inspectionEvidenceRef ?? "Not applicable"],
    ...(remedy.kind === "refund" ? [["Refund", formatMoneyExact(remedy.amount)], ["Remaining refundable", formatMoneyExact(remedy.remainingRefundable)], ["Original order", remedy.orderRef], ["Order lines", remedy.lineRefs.join(", ")], ["Balance version", remedy.balanceVersion]] : [["Replacement item", remedy.skuRef], ["Quantity", String(remedy.quantity)], ["Shipping home", remedy.home], ["Available source stock", String(remedy.availableQuantity)], ["Stock evidence", remedy.stockEvidenceRef], ["Stock version", remedy.stockVersion], ["Cost bound", formatMoneyExact(remedy.costBound)], ["Original order", remedy.originalOrderRef ?? "Unknown"], ["Original shipment", remedy.originalShipmentRef], ["New order", remedy.newOrderRef], ["New shipment", remedy.newShipmentRef], ["Address authority", remedy.addressRef]]) as [string, string][],
  ]} />;
}
