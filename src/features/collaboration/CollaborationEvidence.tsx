import type { ReactNode } from "react";
import type { CollaborationEvidenceData, CollaborationEvidenceRecord } from "@/creator-agent/collaborationEvidence";
import { usePagedView } from "@/adapter/usePagedView";
import { useScope } from "@/adapter/scope";
import { AdapterError, mustClearProtectedData } from "@/adapter/errors";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { SkeletonCard } from "@/components/EmptyState";
import { ViewError } from "@/components/ViewError";
import styles from "./CollaborationEvidence.module.css";

const utc = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long", timeZone: "UTC" });
const instant = (value: string) => <time dateTime={value}>{utc.format(new Date(value))}</time>;
const readable = (value: string) => value.replaceAll("-", " ");

function EvidenceRow({ record }: { record: CollaborationEvidenceRecord }) {
  let title: string;
  let details: [string, ReactNode][];
  switch (record.kind) {
    case "asset":
      title = `Asset ${record.assetId} · version ${record.version}`;
      details = [
        ["File version", record.fileVersion], ["Product revision", `${record.productId} · ${record.productRevision}`],
        ["Parent asset", record.parentAssetId ? `${record.parentAssetId} · version ${record.parentVersion ?? "unknown"}` : "Original submission"],
        ["File availability", record.availability], ["Content review", record.reviewState], ["Usage rights", record.rightsState],
        ["Rights observed", record.rightsObservedAt ? instant(record.rightsObservedAt) : "Unknown"],
      ];
      break;
    case "review":
      title = `Portfolio recommendation · ${readable(record.action)}`;
      details = [["Review reference", `${record.reviewKey} · version ${record.revision}`], ["Creator", record.creatorId],
        ["Evidence source", record.sourceVerified ? "Verified" : "Unverified"], ["Decision status", "Proposal"]];
      break;
    case "decision":
      title = `Portfolio decision · ${record.decision}`;
      details = [["Review reference", `${record.reviewKey} · version ${record.revision}`], ["Creator", record.creatorId],
        ["Action", readable(record.action)], ["Evidence source", record.sourceVerified ? "Verified" : "Unverified"], ["Decision recorded", instant(record.decidedAt)], ["Decision reference", record.linearDecisionRef]];
      break;
    case "participation":
      title = `Participation · ${record.state}`;
      details = [["Creator", record.creatorId], ["Decision reference", record.decisionId],
        ["Occurred", instant(record.occurredAt)], ["Evidence source", record.sourceVerified ? "Verified" : "Unverified"], ["Source receipt", record.sourceReceiptRef]];
      break;
  }
  return <li className={styles.record}>
    <h3>{title}</h3>
    <dl>{[...details, ["Saved at", instant(record.recordedAt)] as [string, ReactNode]].map(([label, value]) =>
      <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </li>;
}

export function CollaborationEvidence({ collaborationId }: { collaborationId: string }) {
  const { adapter } = useScope();
  const query = usePagedView<{ collaborationId: string }, CollaborationEvidenceData>("collaborationEvidence", { collaborationId }, null, 25);
  const pages = query.data?.pages ?? [];
  const denied = query.error instanceof AdapterError && mustClearProtectedData(query.error.category);
  const refresh = () => { void query.refetch(); };
  if (query.isPending) return <SkeletonCard label="Loading saved evidence…" />;
  if (query.error && (denied || !pages.length)) return <ViewError error={query.error} subject="Saved collaboration evidence" onRetry={refresh} />;
  const first = pages[0]?.data;
  if (!first) return <p role="status">The number of saved records is unknown. <Button variant="ghost" onClick={refresh}>Refresh evidence</Button></p>;

  const rows: CollaborationEvidenceRecord[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const data = page.data;
    if (!data || data.collaborationId !== collaborationId || data.offset !== rows.length || data.total !== first.total ||
        data.hasMore !== page.page.hasMore || (data.hasMore && !page.page.nextCursor) ||
        data.records.some(row => {
          const key = `${row.kind}:${row.id}`;
          if (seen.has(key)) return true;
          seen.add(key);
          return false;
        })) {
      return <div role="alert">Saved evidence pages do not match this collaboration and snapshot. <Button variant="secondary" onClick={refresh}>Refresh evidence</Button></div>;
    }
    rows.push(...data.records);
  }
  const partialSource = pages.some(page => page.dataState === "stale" || page.dataState === "unavailable");
  return <div className={styles.evidence} data-testid="collaboration-evidence">
    {adapter.kind === "demo" && <Badge tone="violet" width={180}>Illustrative evidence</Badge>}
    <p className={styles.note}>Asset and portfolio records linked to {collaborationId}. Snapshot {instant(first.observedAt)}.</p>
    {partialSource && <p role="status">Source coverage is incomplete or stale. These are the last saved observations.</p>}
    {rows.length ? <ul aria-label="Saved evidence records" className={styles.list}>{rows.map(row => <EvidenceRow record={row} key={`${row.kind}:${row.id}`} />)}</ul>
      : first.total === 0 && !partialSource ? <p role="status">No matching records in the saved asset and portfolio stores.</p> : <p role="status">Matching records are unavailable for this page.</p>}
    {rows.length > 0 && <p role="status" className={styles.note}>Showing {rows.length} of {first.total} saved records.</p>}
    {query.error && <ViewError error={query.error} subject="Additional saved evidence" hasPriorData={true} onRetry={refresh} />}
    {query.hasNextPage && <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage(); }}>Load more evidence</Button>}
  </div>;
}
