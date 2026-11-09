import { SourceReadGrant } from "@/components/SourceReadGrant";
import { NativeOperationsGrant } from "./NativeOperationsGrant";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReadResponse } from "@/adapter/contract";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { Page, PageHeader } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";

/**
 * The frame every operations record page shares: an always-present h1, a loading skeleton, a typed read error
 * and an empty state. The record itself renders only when the adapter returned data.
 */
export function RecordShell<T>({ query, id, title, subject, figma, children }: { query: UseQueryResult<ReadResponse<T>, Error>; id: string; title: string; subject: string; figma: string; children: (res: ReadResponse<T>, data: T) => ReactNode }) {
  const res = query.data;
  const data = query.isError ? null : res?.data ?? null;
  const access = data && typeof data === "object" && "readAccess" in data ? data.readAccess as { validUntil?: string } | null : null;
  return (
    <Page aria-labelledby={id} data-figma-source={figma}>
      {!(res && data) && <PageHeader id={id} title={title} />}
      <ReadState res={query.isError ? undefined : res} subject={`This ${subject}`} only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label={`Loading ${subject}…`} />}
      {query.isError && <ViewError error={query.error} subject={subject} hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !data && !query.isError && (res.dataState === "empty" && res.coverage.complete ? <EmptyState state="Empty" title={`No ${subject} yet`}><p>The source responded, but holds no record for this address.</p></EmptyState> : <EmptyState state="Error" title={`${subject} unavailable`} alert><p>The source has not confirmed a complete current record. Missing evidence does not prove that no record exists.</p></EmptyState>)}
      {res && data && <SourceReadGrant validUntil={access?.validUntil} title={title} titleId={id} refresh={() => { void query.refetch(); }}><NativeOperationsGrant title={title} titleId={id} data={data} refresh={() => { void query.refetch(); }}>{children(res, data)}</NativeOperationsGrant></SourceReadGrant>}
    </Page>
  );
}
