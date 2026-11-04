import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { AdapterError } from "./errors";

/** Browser connectivity as TanStack Query sees it (it follows the window online/offline events). */
export function useOnline(): boolean {
  return useSyncExternalStore((cb) => onlineManager.subscribe(cb), () => onlineManager.isOnline(), () => true);
}

/** Why backend actions are unavailable while offline. Shown beside disabled controls and in the shared status. */
export const OFFLINE_ACTION_REASON = "You're offline. Changes can't be sent until the connection returns.";

/**
 * A write attempted offline never reaches the backend. It fails as "not sent" (executionCertainty notApplied),
 * so nothing reads as approved, saved or sent. A retry reuses the same idempotency key.
 */
export function offlineNotSent(requestId: string): AdapterError {
  return new AdapterError({ code: "OFFLINE_NOT_SENT", message: `${OFFLINE_ACTION_REASON} Nothing was sent.`, requestId, correlationId: null, retryable: true, retryAfterMs: null, executionCertainty: "notApplied" });
}

/** Latest successful read under a scope root, or null when none exists. Never a zero. */
export function lastSuccessfulRead(client: QueryClient, root: readonly unknown[]): number | null {
  const times = client.getQueryCache().findAll({ queryKey: root }).filter((q) => q.state.data !== undefined && q.state.dataUpdatedAt > 0).map((q) => q.state.dataUpdatedAt);
  return times.length ? Math.max(...times) : null;
}
