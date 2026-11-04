import { useSyncExternalStore } from "react";
import { AdapterError } from "./errors";

/** Whether the browser says it has a network. Only an explicit `false` counts as offline; an unknown answer is treated as online. */
export const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

const subscribe = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};

/** Re-renders when the browser goes offline or comes back. */
export const useOnline = () => useSyncExternalStore(subscribe, isOnline, () => true);

export const BROWSER_OFFLINE = "BROWSER_OFFLINE";

/**
 * The error every read and write raises while the browser is offline. Nothing was sent, so a retry is safe, and the page says
 * "offline" instead of a vague failure or an endless spinner.
 */
export const offlineError = (requestId: string | null = null) =>
  new AdapterError({ code: BROWSER_OFFLINE, message: "You're offline. Reconnect to load this. Nothing was sent.", requestId, correlationId: null, retryable: true, retryAfterMs: null, executionCertainty: "notApplied" });
