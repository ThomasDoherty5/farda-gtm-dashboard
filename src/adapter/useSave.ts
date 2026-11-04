import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { SCHEMA_VERSION, type SaveResourceRequest, type SaveResourceResponse } from "./contract";
import { offlineNotSent } from "./connectivity";
import { AdapterError } from "./errors";
import { scopeKey, useScope } from "./scope";
import { dropProtectedData } from "./useView";

export type SaveInput<P> = Pick<SaveResourceRequest<P>, "resourceKind" | "resourceRef" | "expectedVersion" | "payload">;

let requestCounter = 0;

/**
 * Saves one versioned resource without dispatching anything. A retry of the same logical save keeps one
 * idempotency key; a changed payload or version gets a new one. Success means the server returned the
 * persisted version, which is what the page then shows. Reads refetch afterward; a 401 clears protected data.
 */
export function useSave<P, T>() {
  const ctx = useScope();
  const client = useQueryClient();
  const keys = useRef(new Map<string, string>());
  // networkMode "always": TanStack would otherwise pause the write and send it silently on reconnect. Offline it fails as not sent.
  return useMutation<SaveResourceResponse<T>, Error, SaveInput<P>>({
    networkMode: "always",
    mutationFn: (input) => {
      const logical = JSON.stringify([input.resourceKind, input.resourceRef, input.expectedVersion, input.payload]);
      const idempotencyKey = keys.current.get(logical) ?? crypto.randomUUID();
      keys.current.set(logical, idempotencyKey);
      if (!onlineManager.isOnline()) throw offlineNotSent(`save-offline-${++requestCounter}`);
      return ctx.adapter.saveResource<P, T>({ ...input, schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: ctx.scope, idempotencyKey, requestId: `save-${++requestCounter}` });
    },
    onSettled: async (_data, error) => {
      if (error instanceof AdapterError && error.category === "unauthenticated") dropProtectedData(client, scopeKey(ctx));
      else if (!(error instanceof AdapterError && error.body.code === "OFFLINE_NOT_SENT")) await client.invalidateQueries({ queryKey: scopeKey(ctx) });
    },
  });
}
