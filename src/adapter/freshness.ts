import type { FreshnessState, ReadResponse } from "./contract";

export type SourceFreshness = ReadResponse<unknown>["sourceFreshness"][number];

/**
 * D-13. The server's explicit `freshnessState` wins. When a server does not send one, the state is derived from what the
 * entry already says, and only where that is unambiguous:
 *  - no successful sync and no reason: `neverSynced`;
 *  - a stale reason code: `error` (the source did not sync in time; D-13 has no separate stale state);
 *  - a successful sync and no reason: `current`.
 * `partial` and `noChange` cannot be derived from an entry, so a fallback never returns them. No entry means no verdict (null).
 */
export function freshnessStateOf(entry: SourceFreshness | undefined | null): FreshnessState | null {
  if (!entry) return null;
  if (entry.freshnessState) return entry.freshnessState;
  if (entry.staleReasonCode) return "error";
  return entry.lastSourceSuccessAt ? "current" : "neverSynced";
}

/** The sentence a stale banner leads with: the server's reason code when there is one, otherwise what the state says. */
export function staleReasonText(entry: SourceFreshness | undefined | null): string {
  if (entry?.staleReasonCode) return entry.staleReasonCode;
  const state = freshnessStateOf(entry);
  if (state === "neverSynced") return "This source has never synced";
  if (state === "error") return "The last sync failed";
  if (state === "partial") return "Only part of this source has synced";
  return "Reason unknown";
}
