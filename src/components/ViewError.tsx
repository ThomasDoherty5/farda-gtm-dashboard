import type { ReactNode } from "react";
import { AdapterError } from "@/adapter/errors";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";

type Props = { error: Error; subject: string; hasPriorData?: boolean; onRetry?: () => void; parent?: ReactNode };

/** Recovery state for a failed read. The copy depends on the error category, never on raw server text alone. */
export function ViewError({ error, subject, hasPriorData = false, onRetry, parent }: Props) {
  const category = error instanceof AdapterError ? error.category : "unknown";
  const ref = error instanceof AdapterError ? error.body.correlationId : null;
  const copy: Record<string, { title: string; body: string; retry: boolean; state: "Denied" | "Error" }> = {
    unauthenticated: { state: "Denied", title: "Sign in again", body: "Your session ended. No data from the previous session is shown.", retry: false },
    forbidden: { state: "Denied", title: "No access to this account", body: "You don't have permission to view this account's data.", retry: false },
    notFound: { state: "Error", title: "Record not found", body: error.message, retry: false },
    unavailable: { state: "Error", title: "Data unavailable", body: error.message, retry: true },
    unknown: { state: "Error", title: "Something went wrong", body: `${subject} could not be loaded.`, retry: true },
  };
  const c = copy[category] ?? copy.unknown!;
  return (
    <div style={{ marginBottom: "var(--space-16)" }}>
      <EmptyState state={c.state} title={c.title} alert>
        <p>{c.body}</p>
        {hasPriorData && <p>The values below are from the last successful read and may be out of date.</p>}
        {ref && <p style={{ font: "var(--text-small)" }}>Reference: {ref}</p>}
        {c.retry && onRetry && <Button variant="secondary" style={{ width: "100%" }} onClick={onRetry}>Try again</Button>}
        {parent}
      </EmptyState>
    </div>
  );
}
