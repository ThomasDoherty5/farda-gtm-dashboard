import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { SCHEMA_VERSION, type Period, type ReadResponse } from "./contract";
import { AdapterError, mustClearProtectedData } from "./errors";
import { scopeKey, useScope } from "./scope";

// A transport may ignore abort. A later denial invalidates reads already in flight for this principal and account scope.
const authEpochs = new WeakMap<QueryClient, Map<string, number>>();
function currentEpoch(client: QueryClient, root: readonly unknown[]) {
  return authEpochs.get(client)?.get(JSON.stringify(root)) ?? 0;
}
export async function protectedRead<T>(client: QueryClient, root: readonly unknown[], requestId: string, read: () => Promise<T>, queryKey?: readonly unknown[]): Promise<T> {
  const started = currentEpoch(client, root);
  let value: T;
  try { value = await read(); }
  catch (error) {
    if (error instanceof AdapterError && mustClearProtectedData(error.category) && started === currentEpoch(client, root))
      dropProtectedData(client, root, queryKey, error);
    throw error;
  }
  if (started !== currentEpoch(client, root)) throw new AdapterError({ code: "SESSION_EXPIRED", message: "Authorization changed while this read was in progress.",
    requestId, correlationId: null, retryable: false, retryAfterMs: null });
  return value;
}

let requestCounter = 0;

/**
 * Reads one typed view through the adapter. Query keys are scoped by principal, environment,
 * workspace, accounts, schema, view, filters and period. Obsolete requests are aborted, and a
 * response whose verified scope differs from the requested scope is rejected (late-response guard).
 * A 401/403 drops everything cached for the scope, so prior data can't render beside the denial.
 * With `keepPrevious`, a changed filter keeps showing the last acknowledged data (`isPlaceholderData`) until the new answer
 * arrives, so a control that lives beside the data isn't torn down by its own change.
 */
export function useView<F, T>(viewKey: string, filters: F, period: Period | null = null, options: { keepPrevious?: boolean; page?: {cursor:string|null;limit:number} } = {}) {
  const ctx = useScope();
  const client = useQueryClient();
  const page = options.page ?? {cursor:null,limit:50};
  const queryKey = [...scopeKey(ctx), SCHEMA_VERSION, viewKey, filters, period, ...(options.page ? [page] : [])];
  return useQuery<ReadResponse<T>, Error>({
    ...(options.keepPrevious ? { placeholderData: keepPreviousData } : {}),
    queryKey,
    // Opt-in: while a changed filter loads, keep the last data from the same scope on screen (flagged by isPlaceholderData).
    // Data from a different principal, environment, workspace or account set is never carried over.
    placeholderData: options.keepPrevious
      ? (previous, previousQuery) => {
          const root = scopeKey(ctx);
          return previousQuery && root.every((part, i) => previousQuery.queryKey[i] === part) ? previous : undefined;
        }
      : undefined,
    retry: (count, error) => !(error instanceof AdapterError && (mustClearProtectedData(error.category) || !error.body.retryable)) && count < 2,
    queryFn: async ({ signal }) => {
      const requestId = `req-${++requestCounter}`;
      return protectedRead(client, scopeKey(ctx), requestId, async () => {
        const res = await ctx.adapter.readView<F, T>(
          {
            schemaVersion: SCHEMA_VERSION,
            operation: "readView",
            viewKey,
            requestedScope: ctx.scope,
            filters,
            period,
            sort: [],
            page,
            requestId,
          },
          { signal },
        );
        assertScopeMatches(res, ctx.scope);
        return res;
      }, queryKey);
    },
  });
}

export function dropProtectedData(client: QueryClient, root: readonly unknown[], denyingKey?: readonly unknown[], denial?: AdapterError) {
  const epochs = authEpochs.get(client) ?? new Map<string,number>();
  epochs.set(JSON.stringify(root), currentEpoch(client, root) + 1);
  authEpochs.set(client, epochs);
  client.removeQueries({ queryKey: root, type: "inactive" });
  const denyingQuery = denyingKey && client.getQueryCache().find({queryKey:denyingKey,exact:true});
  const expired = new AdapterError({code:"SESSION_EXPIRED",message:"Authorization changed while this read was in progress.",
    requestId:null,correlationId:null,retryable:false,retryAfterMs:null});
  for (const query of client.getQueryCache().findAll({queryKey:root})) {
    // Cancel the query's publisher as well as its transport. Reverting would briefly restore previously authorized rows.
    if (query !== denyingQuery && query.state.fetchStatus !== "idle") {
      void query.cancel({silent:true,revert:false});
      query.setState({data:undefined,dataUpdatedAt:0,fetchStatus:"idle",status:"error",error:expired});
    } else if (query !== denyingQuery) {
      // A completed ancestor may own the denied nested view. Clearing only its
      // data would unmount that view and lose the sole denial/recovery UI.
      query.setState({data:undefined,dataUpdatedAt:0,fetchStatus:"idle",status:"error",error:denial ?? expired});
    } else query.setState({data:undefined,dataUpdatedAt:0});
  }
}

export function assertScopeMatches(res: ReadResponse<unknown>, requested: { workspaceId: string; accountIds: string[]; environment: string }) {
  const same =
    res.scope.workspaceId === requested.workspaceId &&
    res.scope.environment === requested.environment &&
    [...res.scope.accountIds].sort().join(",") === [...requested.accountIds].sort().join(",");
  if (!same)
    throw new AdapterError({ code: "FORBIDDEN", message: "Response scope did not match the requested scope.", requestId: res.requestId, correlationId: null, retryable: false, retryAfterMs: null });
}
