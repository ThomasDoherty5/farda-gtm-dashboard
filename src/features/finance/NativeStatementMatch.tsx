import { useState } from "react";
import { z } from "zod";
import { scopeKey, useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import type { NativeSettlement, SettlementRecord } from "@/creator-agent/settlements/contract";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { exactMoney } from "./NativeFinance";
import styles from "./Finance.module.css";
const markerSchema = z.object({ key: z.string().min(1), version: z.string().min(1), payload: z.object({ entityRef: z.string().min(1), entityVersion: z.string().min(1), selectionRefs: z.array(z.string().min(1)).min(1).max(100) }).strict() }).strict();
type Marker = z.infer<typeof markerSchema>;
export function SettlementMatchDialog({ data, record, open, onClose }: { data: NativeSettlement; record: SettlementRecord; open: boolean; onClose: () => void }) {
  const ctx = useScope();
  const storageKey = JSON.stringify(["native-statement-match-v1", ...scopeKey(ctx), record.ref]);
  const [marker, setMarker] = useState<Marker | null>(() => { try { const raw = sessionStorage.getItem(storageKey); const parsed = markerSchema.safeParse(raw ? JSON.parse(raw) : null); return parsed.success && parsed.data.payload.entityRef === record.ref ? parsed.data : null; } catch { return null; } });
  const [selected, setSelected] = useState<string[]>(marker?.payload.selectionRefs ?? []);
  const [storageError, setStorageError] = useState(false);
  const action = useAction<Marker["payload"]>();
  const leased = useSourceLease(data.source.validUntil);
  const hold = !data.capabilities.match ? "The source has not granted statement-matching authority." : !leased || data.source.state !== "current" ? "Refresh current source evidence before matching." : !selected.length ? "Choose an eligible source candidate." : !marker && selected.some(ref => !record.candidates.some(candidate => candidate.ref === ref && !candidate.problem)) ? "A selected source candidate is unavailable or has an unresolved problem." : undefined;
  const send = () => {
    if (hold || action.isPending || Date.parse(data.source.validUntil ?? "") <= Date.now()) return;
    const original = marker ?? { key: crypto.randomUUID(), version: record.version, payload: { entityRef: record.ref, entityVersion: record.version, selectionRefs: [...selected].sort() } };
    if (!marker) { try { sessionStorage.setItem(storageKey, JSON.stringify(original)); } catch { setStorageError(true); return; } setMarker(original); }
    action.mutate({ operation: "previewAction", actionKind: "settlement.matchStatement", entityRefs: [], expectedVersion: original.version, approvalRef: null, manifestRef: null, payload: original.payload, idempotencyKey: original.key });
  };
  return <Dialog open={open} title="Match provider statement" onClose={onClose}>
    <p>Review exact provider statement candidates, amount, currency and period. A request creates an immutable approval preview; it does not mark a payout reconciled.</p>
    <fieldset className={styles.candidates}><legend>Source candidates</legend>{record.candidates.map(candidate => <label key={candidate.ref}><input type="checkbox" checked={selected.includes(candidate.ref)} disabled={!!candidate.problem || !!marker} onChange={event => setSelected(prior => event.target.checked ? [...prior, candidate.ref] : prior.filter(ref => ref !== candidate.ref))} /><span>{candidate.statementRef} → {candidate.componentRef}<br />{exactMoney(candidate.amount)} · {candidate.periodStart} to {candidate.periodEnd}<br />Evidence {candidate.evidenceRef}{candidate.problem && <><br />Unresolved: {candidate.problem}</>}</span></label>)}{!record.candidates.length && <p>No authorized statement candidates were returned.</p>}</fieldset>
    {storageError && <p role="alert">The original request could not be retained. Nothing was sent. Enable session storage before requesting a preview.</p>}
    {marker && <p role="status">This selection is bound to its original request and source version. Checking it reuses the same proposal command; it cannot dispatch or release a payout.</p>}
    {action.isError && <p role="alert">No confirmed preview was returned. Check the original proposal before changing the selection or starting another request.</p>}
    {action.data?.approvalRef ? <><p role="status">Approval preview returned. Review the canonical manifest and current approval status before any further step.</p><LinkButton to={`/approvals/${encodeURIComponent(action.data.approvalRef)}`}>Review exact approval preview</LinkButton></> : <Button disabledReason={action.isPending ? "The original preview request is in progress." : hold} onClick={send}>{marker ? "Check original match proposal" : "Preview exact match"}</Button>}
    <Button variant="secondary" onClick={onClose}>Close matching</Button>
  </Dialog>;
}
