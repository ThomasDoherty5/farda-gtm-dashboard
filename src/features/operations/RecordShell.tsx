import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReadResponse } from "@/adapter/contract";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { Page, PageHeader } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";

/**
 * The frame every operations record page shares: an always-present h1, a loading skeleton, a typed read error
 * and an empty state. The record itself renders only when the adapter returned data.
 */
export function RecordShell<T>({ query, id, title, subject, figma, children }: { query: UseQueryResult<ReadResponse<T>, Error>; id: string; title: string; subject: string; figma: string; children: (res: ReadResponse<T>, data: T) => ReactNode }) {
  const res = query.data;
  const data = res?.data ?? null;
  return (
    <Page aria-labelledby={id} data-figma-source={figma}>
      {!(res && data) && <PageHeader id={id} title={title} />}
      {query.isPending && <SkeletonCard label={`Loading ${subject}…`} />}
      {query.isError && <ViewError error={query.error} subject={subject} hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !data && <EmptyState state="Empty" title={`No ${subject} yet`}><p>The source responded, but holds no record for this address.</p></EmptyState>}
      {res && data && children(res, data)}
    </Page>
  );
}
