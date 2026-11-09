import { useId, type ReactNode } from "react";
import { useScope } from "@/adapter/scope";
import { PageHeader } from "@/components/Panels";
import { Button } from "@/components/Button";
import { useSourceLease } from "@/features/commercial/useSourceLease";

/** A source display lease never grants disclosure, shipping, refund, or stock authority. */
export function NativeOperationsGrant({ data, refresh, children, title, titleId }: { data: unknown; refresh: () => void; children: ReactNode; title?: string; titleId?: string }) {
  const { adapter } = useScope();
  const fallbackTitleId = useId();
  const record = data && typeof data === "object" ? data as { datasetKey?: unknown; provenance?: { validUntil?: unknown; version?: unknown } } : null;
  const validUntil = typeof record?.provenance?.validUntil === "string" ? record.provenance.validUntil : null;
  const leased = useSourceLease(validUntil);
  const native = adapter.kind !== "demo" && record?.datasetKey === "operations-native";
  if (native && (!leased || typeof record?.provenance?.version !== "string")) return <>{title && <PageHeader id={titleId ?? fallbackTitleId} title={title} />}<div role="alert"><p>Source access is unavailable or expired. Refresh to verify the current operational evidence.</p><Button variant="secondary" onClick={refresh}>Refresh source evidence</Button></div></>;
  return children;
}
