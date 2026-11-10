import type { ReactNode } from "react";
import { useSourceLease } from "@/adapter/useSourceLease";
import { Button } from "./Button";

/** Display-only access expiry. Removing children also closes their protected
 * dialogs; a refresh must obtain a new owner grant, never extend this one. */
export function SourceReadGrant({ validUntil, title, titleId, refresh, children }: {
  validUntil?: string | null; title: string; titleId?: string; refresh: () => void; children: ReactNode;
}) {
  const expired = useSourceLease(validUntil);
  if (!expired) return children;
  return <section aria-labelledby={titleId}>
    <h1 id={titleId}>{title}</h1>
    <div role="alert"><p>Source access has expired. Refresh to verify the current evidence.</p></div>
    <Button variant="secondary" onClick={refresh}>Refresh source evidence</Button>
  </section>;
}
