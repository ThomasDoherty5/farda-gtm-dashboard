import { useState } from "react";
import type { ReadResponse } from "@/adapter/contract";
import { scopeKey, useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { ledgerExportRequestFilters, type LedgerExportRequestView, type LedgerExportArtifactView } from "@/creator-agent/actions/exportViews";
import type { NativeCommissionLedger } from "@/creator-agent/settlements/contract";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { FactList } from "@/components/Panels";
import { useSourceLease } from "@/features/commercial/useSourceLease";

type Marker = { requestKey: string; expectedVersion: string; payload: { format: "csv"; filters: NonNullable<NativeCommissionLedger["export"]>["filters"] } };
export function NativeExportDialog({ open, data, response, onClose }: { open: boolean; data: NativeCommissionLedger; response: ReadResponse<NativeCommissionLedger>; onClose: () => void }) {
  const ctx = useScope();
  const storageKey = JSON.stringify(["native-ledger-export-v1", ...scopeKey(ctx)]);
  const [marker, setMarker] = useState<Marker | null>(() => { try { const raw = sessionStorage.getItem(storageKey); if (!raw) return null; const parsed = ledgerExportRequestFilters.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : null; } catch { return null; } });
  const [storageError, setStorageError] = useState(false);
  const action = useAction<Marker["payload"]>();
  const leased = useSourceLease(data.source.validUntil);
  const hold = !data.capabilities.export ? "This source has not granted export authority." : !data.export ? "No authorized export snapshot was returned." : !leased || data.source.state !== "current" || response.dataState === "stale" ? "Refresh current source evidence before requesting an export." : undefined;
  const send = (original: Marker) => {
    if (hold || action.isPending || original.expectedVersion !== data.export?.sourceVersion || Date.parse(data.source.validUntil ?? "") <= Date.now()) return;
    action.mutate({ operation: "exportSnapshot", actionKind: "exportLedger", expectedVersion: original.expectedVersion, entityRefs: [], approvalRef: null, manifestRef: null, payload: original.payload, idempotencyKey: original.requestKey });
  };
  const start = () => {
    if (hold || !data.export || marker) return;
    const original: Marker = { requestKey: crypto.randomUUID(), expectedVersion: data.export.sourceVersion, payload: { format: "csv", filters: data.export.filters } };
    try { sessionStorage.setItem(storageKey, JSON.stringify(original)); } catch { setStorageError(true); return; }
    setMarker(original); send(original);
  };
  return <Dialog open={open} title="Export the commission ledger" onClose={onClose}>
    <p>Export covers the entire authorized filtered source snapshot, including rows beyond the visible page. It contains permitted financial references and no customer personal data.</p>
    <FactList label="Export scope" rows={[["Visible rows", String(data.coverage.returned)], ["Source total", data.coverage.total === null ? "Unknown" : String(data.coverage.total)], ["Currency", data.export?.filters.currency ?? data.currency ?? "Unknown"], ["Period", data.export ? `${data.export.filters.startAt} to ${data.export.filters.endAt}` : "Unknown"], ["Timezone", data.export?.filters.timezone ?? "Unknown"], ["Snapshot version", data.export?.sourceVersion ?? "Not supplied"]]} />
    {storageError && <p role="alert">The original request could not be retained in this browser. Nothing was sent. Enable session storage before requesting an export.</p>}
    {!marker ? <Button disabledReason={hold} onClick={start}>Request CSV export</Button> : <ExportRecovery key={marker.requestKey} marker={marker} pending={action.isPending} hold={hold ?? (marker.expectedVersion !== data.export?.sourceVersion ? "The source version changed. Inspect the original export; do not rebase its request." : undefined)} retry={() => send(marker)} />}
    {action.isError && <p role="alert">The request did not return a confirmed artifact. Check the original request below before retrying.</p>}
    <Button variant="secondary" onClick={onClose}>Close export</Button>
  </Dialog>;
}
function ExportRecovery({ marker, pending, hold, retry }: { marker: Marker; pending: boolean; hold?: string; retry: () => void }) {
  const query = useView<Marker, LedgerExportRequestView>("ledgerExportRequest", marker);
  const [download, setDownload] = useState(false);
  const result = query.data?.data;
  return <section aria-label="Original export request">
    <p>Original snapshot {marker.expectedVersion} · {marker.payload.filters.currency} · {marker.payload.filters.startAt} to {marker.payload.filters.endAt}</p>
    <p role="status">{query.isPending ? "Checking original request…" : query.isError ? "Original request is unavailable. No new export was started." : `Original request: ${result?.state ?? "unknown"}.`}</p>
    {result && <p>Progress: {result.progress.processedRows ?? "Unknown"} of {result.progress.totalRows ?? "unknown"} source rows. {result.reasonCodes.join(" · ")}</p>}
    <Button variant="secondary" disabledReason={query.isFetching ? "Checking original request." : undefined} onClick={() => { void query.refetch(); }}>Check original request</Button>
    {result && (result.state === "absent" || result.state === "failed") && <Button disabledReason={pending ? "The original request is in progress." : hold} onClick={retry}>Retry original export request</Button>}
    {result?.state === "succeeded" && result.receipt && <><FactList label="Export receipt" rows={[["Rows", String(result.receipt.rowCount)], ["As of", result.receipt.asOf], ["Expires", result.receipt.expiresAt], ["SHA-256", result.receipt.sha256]]} /><Button variant="secondary" disabledReason={hold} onClick={() => setDownload(true)}>Retrieve authorized CSV</Button>{download && <ExportArtifact artifactRef={result.receipt.artifactRef} requestKey={marker.requestKey} allowed={!hold} />}</>}
  </section>;
}
function ExportArtifact({ artifactRef, requestKey, allowed }: { artifactRef: string; requestKey: string; allowed: boolean }) {
  const query = useView<{ artifactRef: string }, LedgerExportArtifactView>("ledgerExportArtifact", { artifactRef });
  const artifact = query.data?.data;
  const leased = useSourceLease(artifact?.receipt.expiresAt);
  const ready = allowed && !query.isError && leased && artifact?.receipt.artifactRef === artifactRef && artifact.receipt.requestKey === requestKey;
  const save = () => {
    if (!ready || !artifact || Date.parse(artifact.receipt.expiresAt) <= Date.now()) return;
    const url = URL.createObjectURL(new Blob([artifact.body], { type: artifact.receipt.contentType }));
    const link = document.createElement("a"); link.href = url; link.download = "commission-ledger.csv"; link.click(); URL.revokeObjectURL(url);
  };
  return <><p role="status">{query.isPending ? "Verifying artifact access…" : ready ? "Whole-snapshot CSV verified by the source service." : "Artifact access is unavailable or expired. Refresh source evidence."}</p><Button disabledReason={ready ? undefined : "A current authorized server artifact is required."} onClick={save}>Download CSV</Button></>;
}
