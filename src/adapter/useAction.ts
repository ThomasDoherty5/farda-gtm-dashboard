import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { SCHEMA_VERSION, type ActionRequest, type ActionResponse } from "./contract";
import { offlineNotSent } from "./connectivity";
import { AdapterError, mustClearProtectedData } from "./errors";
import { scopeKey, useScope } from "./scope";
import { dropProtectedData } from "./useView";

export type ActionInput<P> = Pick<ActionRequest<P>, "operation" | "actionKind" | "entityRefs" | "expectedVersion" | "approvalRef" | "manifestRef" | "runRef" | "payload"> & {idempotencyKey?:string};

let requestCounter = 0;

/**
 * Submits one action intent. The same logical action keeps one idempotency key through retries,
 * and a changed payload or version gets a new one. Success here means the server acknowledged the
 * intent, not that a source action happened; read the returned state and receipts.
 * Reads refetch afterward so capabilities and versions come from the server. Authorization loss clears protected
 * cached data and fences any older reads that are still in flight.
 */
export function useAction<P>() {
  const ctx = useScope();
  const client = useQueryClient();
  const keys = useRef(new Map<string, string>());
  // networkMode "always": TanStack would otherwise pause the write and send it silently on reconnect. Offline it fails as not sent.
  return useMutation<ActionResponse, Error, ActionInput<P>>({
    networkMode: "always",
    mutationFn: (input) => {
      const logical = JSON.stringify([input.operation, input.actionKind, input.approvalRef, input.expectedVersion, input.payload]);
      const idempotencyKey = input.idempotencyKey ?? keys.current.get(logical) ?? crypto.randomUUID();
      keys.current.set(logical, idempotencyKey);
      if (!onlineManager.isOnline()) throw offlineNotSent(`act-offline-${++requestCounter}`);
      return ctx.adapter.submitAction<P>({ ...input, schemaVersion: SCHEMA_VERSION, requestedScope: ctx.scope, idempotencyKey, requestId: `act-${++requestCounter}` });
    },
    onSettled: async (_data, error) => {
      if (error instanceof AdapterError && mustClearProtectedData(error.category)) dropProtectedData(client, scopeKey(ctx));
      else if (!(error instanceof AdapterError && error.body.code === "OFFLINE_NOT_SENT")) await client.invalidateQueries({ queryKey: scopeKey(ctx) });
    },
  });
}
