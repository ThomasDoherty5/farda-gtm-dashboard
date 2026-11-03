import type { ReactNode } from "react";
import { AdapterError } from "@/adapter/errors";
import { Button } from "./Button";

type Props = { error: Error; subject: string; hasPriorData?: boolean; onRetry?: () => void; parent?: ReactNode };

/** Recovery state for a failed read. The copy depends on the error category, never on raw server text alone. */
export function ViewError({ error, subject, hasPriorData = false, onRetry, parent }: Props) {
  const category = error instanceof AdapterError ? error.category : "unknown";
  const ref = error instanceof AdapterError ? error.body.correlationId : null;
  const copy: Record<string, { title: string; body: string; retry: boolean }> = {
    unauthenticated: { title: "Sign in again", body: "Your session ended. No data from the previous session is shown.", retry: false },
    forbidden: { title: "No access to this account", body: "You don't have permission to view this account's data.", retry: false },
    notFound: { title: "Record not found", body: error.message, retry: false },
    unavailable: { title: "Data unavailable", body: error.message, retry: true },
    unknown: { title: "Something went wrong", body: `${subject} could not be loaded.`, retry: true },
  };
  const c = copy[category] ?? copy.unknown!;
  return (
    <div role="alert">
      <h2 style={{ font: "var(--text-h2)" }}>{c.title}</h2>
      <p>{c.body}</p>
      {hasPriorData && <p>The values below are from the last successful read and may be out of date.</p>}
      {ref && <p style={{ font: "var(--text-small)" }}>Reference: {ref}</p>}
      {c.retry && onRetry && <Button onClick={onRetry}>Try again</Button>}
      {parent}
    </div>
  );
}
