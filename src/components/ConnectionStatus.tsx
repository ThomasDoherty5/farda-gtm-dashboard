import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { lastSuccessfulRead, OFFLINE_ACTION_REASON, useOnline } from "@/adapter/connectivity";
import { scopeKey, useScope } from "@/adapter/scope";
import styles from "./ConnectionStatus.module.css";

/**
 * Shared offline status. The live region (aria-live, deliberately without role="status", which pages and tests already use for loading) is always mounted so assistive technology announces the change,
 * and it stays until connectivity returns (it is not a toast). It is fixed to the viewport, so it never moves page content.
 * It says what the figures are; it changes none of them, and unknown values stay unknown.
 */
export function ConnectionStatus() {
  const online = useOnline();
  const client = useQueryClient();
  const ctx = useScope();
  // Read once when the browser goes offline: the last successful read is fixed from then on.
  const lastRead = useMemo(() => (online ? null : lastSuccessfulRead(client, scopeKey(ctx))), [online, client, ctx]);
  const when = lastRead === null ? null : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(lastRead);
  return (
    <div aria-live="polite" aria-atomic="true" data-testid="connection-status" data-online={online} className={online ? styles.hidden : styles.offline}>
      {!online && (
        <>
          <strong>You're offline.</strong>{" "}
          {when ? `Figures are as of the last successful read (${when}) and may be stale.` : "No figures have loaded yet, so none are shown as current."} {OFFLINE_ACTION_REASON} Reads refresh when the connection returns.
        </>
      )}
    </div>
  );
}
