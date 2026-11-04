/**
 * Source-specific freshness (GTM275). One source's state never describes another's. "Never synced", "no change since the last sync",
 * "partial" and "error" are different from each other and from merely old, because each changes what the numbers mean.
 */
export type FreshnessState = "fresh" | "stale" | "noChange" | "neverSynced" | "partial" | "error";

export type FreshnessInput = { lastSourceSuccessAt: string | null; staleReasonCode: string | null };

export const STALE_AFTER_HOURS = 24;

export function classifyFreshness(f: FreshnessInput, nowIso: string, staleAfterHours = STALE_AFTER_HOURS): FreshnessState {
  const reason = f.staleReasonCode ?? "";
  if (/^(SOURCE_)?ERROR|SYNC_FAILED|AUTH_FAILED/.test(reason)) return "error";
  if (f.lastSourceSuccessAt === null) return "neverSynced";
  if (reason === "NO_CHANGE") return "noChange";
  if (reason === "PARTIAL_ROWS" || reason === "SOURCE_ROWS_DEFERRED") return "partial";
  const ageHours = (Date.parse(nowIso) - Date.parse(f.lastSourceSuccessAt)) / 3_600_000;
  return ageHours > staleAfterHours ? "stale" : "fresh";
}

export type FreshnessWords = { label: string; tone: "success" | "neutral" | "warning" | "danger"; meaning: string; valuesAreCurrent: boolean };

/** What each state tells the reader. Only fresh and no-change values may be read as current. */
export const FRESHNESS_WORDS: Record<FreshnessState, FreshnessWords> = {
  fresh: { label: "Fresh", tone: "success", meaning: "Synced within the freshness window.", valuesAreCurrent: true },
  noChange: { label: "No change", tone: "success", meaning: "The last sync succeeded and found nothing new. The values are current, not stale.", valuesAreCurrent: true },
  stale: { label: "Stale", tone: "warning", meaning: "The last good sync is older than the freshness window. Values are from then, not now.", valuesAreCurrent: false },
  partial: { label: "Partial", tone: "warning", meaning: "Some rows did not arrive. Totals cover only the rows observed.", valuesAreCurrent: false },
  error: { label: "Error", tone: "danger", meaning: "The last sync failed. Values shown are the last good ones, not current.", valuesAreCurrent: false },
  neverSynced: { label: "Never synced", tone: "neutral", meaning: "No sync has succeeded yet. Its metrics are N/A, not zero.", valuesAreCurrent: false },
};
