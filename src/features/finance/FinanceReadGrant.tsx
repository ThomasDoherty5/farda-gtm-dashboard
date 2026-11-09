import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { financeReadAccessSchema } from "@/adapter/viewSchemas/finance";
import { SourceReadGrant } from "@/components/SourceReadGrant";
import { Page, PageHeader } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";

export type FinanceReadQuery<T = unknown> = UseQueryResult<ReadResponse<T>, Error>;

/** Guard the complete legacy finance subtree, including local dialogs. Business
 * freshness remains in the envelope; only a qualified native access deadline
 * controls retention. Errors unmount prior content, even if the query retains it. */
export function FinanceReadGrant({ query, title, titleId, children }: {
  query: FinanceReadQuery; title: string; titleId: string; children: ReactNode;
}) {
  const { adapter } = useScope();
  if (query.isError && query.error) return <Page aria-labelledby={titleId}>
    <PageHeader id={titleId} title={title} />
    <ViewError error={query.error} subject={title} hasPriorData={false} onRetry={() => { void query.refetch(); }} />
  </Page>;
  const data: unknown = query.data?.data;
  if (adapter.kind === "demo" || data == null) return children;
  const record = typeof data === "object" ? data as { datasetKey?: unknown; readAccess?: unknown } : null;
  const grant = financeReadAccessSchema.safeParse(record?.readAccess);
  // An invalid/missing grant is refused; it must never inherit the optional
  // compatibility behavior of SourceReadGrant used by unrelated view families.
  const validUntil = record?.datasetKey === "finance-native" && grant.success ? grant.data.validUntil : "invalid";
  return <SourceReadGrant validUntil={validUntil} title={title} titleId={titleId}
    refresh={() => { void query.refetch(); }}>{children}</SourceReadGrant>;
}
