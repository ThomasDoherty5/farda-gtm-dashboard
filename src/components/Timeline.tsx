import type { ReactNode } from "react";

/** An ordered sequence with an accessible name. Explicit list semantics survive visual marker removal. */
export function Timeline({ label, className, children }: { label: string; className: string | undefined; children: ReactNode }) {
  return <ol role="list" aria-label={label} className={className}>{children}</ol>;
}
