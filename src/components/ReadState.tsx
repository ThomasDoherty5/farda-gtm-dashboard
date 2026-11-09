import type { ReadResponse } from "@/adapter/contract";
import { Alert } from "./Alert";
import { EmptyState } from "./EmptyState";

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

/**
 * What a read says about its own completeness, in words (FX-03, FX-05, FX-06). Stale and partial data stay on the page, labeled;
 * an empty read is a successful answer of "nothing", not a failure and not a zero. Ready data shows nothing.
 * A page that already draws its own notice for a state doesn't add this one.
 */
type Kind = "stale" | "partial" | "empty";

export function ReadState({ res, subject, only, partialSummary }: { partialSummary?: string; res: ReadResponse<unknown> | undefined; subject: string; /** Limit to these states, where the page already draws its own notice for the others. */ only?: Kind[] }) {
  if (!res) return null;
  const shows = (k: Kind) => !only || only.includes(k);
  if (res.dataState === "stale" && shows("stale")) {
    const last = when(res.sourceFreshness.map((f) => f.lastSourceSuccessAt).filter(Boolean).sort().pop());
    return (
      <Alert state="warning" title="This view may be out of date" testId="view-stale">
        <p>{subject} shows the last successful read{last ? `, from ${last}` : ", and when that was is unknown"}. It is not current, and nothing here claims a fresh sync.</p>
      </Alert>
    );
  }
  if (res.dataState === "partial" && shows("partial")) {
    const { expectedCount: expected, observedCount: seen } = res.coverage;
    return (
      <Alert state="warning" title="Some data is missing" testId="view-partial">
        <p>{expected !== null && seen !== null ? `${subject} covers ${seen} of ${expected} expected rows.` : `How much of ${subject.toLowerCase()} is covered is unknown.`} {partialSummary ?? "Totals below cover only what was read, and values that weren't read show as unknown or N/A, never zero."}</p>
      </Alert>
    );
  }
  if (res.dataState === "empty" && res.data === null && shows("empty")) {
    return (
      <EmptyState state="Empty" title={`Nothing to show for ${subject.toLowerCase()}`}>
        <p>The read succeeded and returned no rows. That is not an error, and it is not zero.</p>
      </EmptyState>
    );
  }
  return null;
}
