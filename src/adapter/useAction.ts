import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { SCHEMA_VERSION, type ActionRequest, type ActionResponse } from "./contract";
import { AdapterError } from "./errors";
import { scopeKey, useScope } from "./scope";
import { dropProtectedData } from "./useView";

export type ActionInput<P> = Pick<ActionRequest<P>, "operation" | "actionKind" | "entityRefs" | "expectedVersion" | "approvalRef" | "manifestRef" | "runRef" | "payload">;

let requestCounter = 0;

/**
 * Submits one action intent. The same logical action keeps one idempotency key through retries,
 * and a changed payload or version gets a new one. Success here means the server acknowledged the
 * intent, not that a source action happened; read the returned state and receipts.
 * Reads refetch afterward so capabilities and versions come from the server. A 401 clears protected
 * data instead. A 403 on an action denies that action only, and the refetch re-derives what is allowed.
 */
export function useAction<P>() {
  const ctx = useScope();
  const client = useQueryClient();
  const keys = useRef(new Map<string, string>());
  return useMutation<ActionResponse, Error, ActionInput<P>>({
    mutationFn: (input) => {
      const logical = JSON.stringify([input.operation, input.actionKind, input.approvalRef, input.expectedVersion, input.payload]);
      const idempotencyKey = keys.current.get(logical) ?? crypto.randomUUID();
      keys.current.set(logical, idempotencyKey);
      return ctx.adapter.submitAction<P>({ ...input, schemaVersion: SCHEMA_VERSION, requestedScope: ctx.scope, idempotencyKey, requestId: `act-${++requestCounter}` });
    },
    onSettled: async (_data, error) => {
      if (error instanceof AdapterError && error.category === "unauthenticated") dropProtectedData(client, scopeKey(ctx));
      else await client.invalidateQueries({ queryKey: scopeKey(ctx) });
    },
  });
}
