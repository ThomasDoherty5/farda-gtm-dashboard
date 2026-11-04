import type { ReadResponse } from "@/adapter/contract";

/**
 * Source-specific freshness (GTM275-07). Each source reports its own last successful coverage, so one healthy row
 * never stands for the rest. "No change" is a successful check that found nothing new; it is not "never synced"
 * (nothing has ever been read) and it is not a failure.
 *
 * The status codes below are this app's proposal for what the server sends in `staleReasonCode`; THO-283 freezes them.
 * A code that is not listed is treated as stale, never as healthy.
 */
export type SourceHealth = "current" | "no-change" | "stale" | "partial" | "error" | "never-synced";

type Entry = ReadResponse<unknown>["sourceFreshness"][number];

const CODE_STATE: Record<string, SourceHealth> = {
  SOURCE_NO_CHANGE: "no-change",
  SOURCE_ROWS_DEFERRED: "partial",
  PARTIAL_COVERAGE: "partial",
  SOURCE_SYNC_FAILED: "error",
  SOURCE_UNAVAILABLE: "error",
  AUTH_EXPIRED: "error",
  SOURCE_SYNC_DELAYED: "stale",
};

export function classifySource(entry: Entry): SourceHealth {
  const fromCode = entry.staleReasonCode ? (CODE_STATE[entry.staleReasonCode] ?? "stale") : null;
  // A failure with no success on record is still a failure, and says so; it is not "never synced".
  if (fromCode === "error") return "error";
  if (entry.lastSourceSuccessAt === null) return "never-synced";
  return fromCode ?? "current";
}

/** Worst first. The overall answer is the worst source, never the newest or the first. */
const SEVERITY: SourceHealth[] = ["error", "never-synced", "partial", "stale", "no-change", "current"];
export const isHealthy = (s: SourceHealth) => s === "current" || s === "no-change";

export function overallHealth(entries: Entry[]): SourceHealth | null {
  if (entries.length === 0) return null;
  return entries.map(classifySource).sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b))[0]!;
}

export const HEALTH_LABEL: Record<SourceHealth, string> = {
  current: "Current",
  "no-change": "No change since last check",
  stale: "Stale",
  partial: "Partial",
  error: "Last attempt failed",
  "never-synced": "Never synced",
};

const SOURCE_LABEL: Record<string, string> = {
  shopify: "Shopify orders",
  "tiktok-shop": "TikTok Shop orders",
  "creator-monitor": "Creator post snapshots",
  "ad-platforms": "Ad platforms",
  quickbooks: "QuickBooks",
};
export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source;

/** What each state may claim about the data. Never-synced and failed sources claim no figures at all. */
export function watermarkText(entry: Entry, format: (iso: string) => string): string {
  const state = classifySource(entry);
  const last = entry.lastSourceSuccessAt;
  switch (state) {
    case "never-synced": return "No successful sync yet. Nothing from this source is counted, and it is not zero.";
    case "error": return last ? `The latest attempt failed. Figures stop at the last success, ${format(last)}.` : "The latest attempt failed, and there has been no successful sync.";
    case "no-change": return `Checked ${entry.observedAt ? format(entry.observedAt) : "at an unknown time"}; nothing new since ${format(last!)}.`;
    case "partial": return `Only part of this source is loaded as of ${format(last!)}. Totals cover just those records.`;
    case "stale": return `Not current. Last successful sync ${format(last!)}.`;
    case "current": return `Last successful sync ${format(last!)}.`;
  }
}
