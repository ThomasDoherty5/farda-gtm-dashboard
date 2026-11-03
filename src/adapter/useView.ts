import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { SCHEMA_VERSION, type Period, type ReadResponse } from "./contract";
import { AdapterError, mustClearProtectedData } from "./errors";
import { scopeKey, useScope } from "./scope";

let requestCounter = 0;

/**
 * Reads one typed view through the adapter. Query keys are scoped by principal, environment,
 * workspace, accounts, schema, view, filters and period. Obsolete requests are aborted, and a
 * response whose verified scope differs from the requested scope is rejected (late-response guard).
 * A 401/403 drops everything cached for the scope, so prior data can't render beside the denial.
 */
export function useView<F, T>(viewKey: string, filters: F, period: Period | null = null) {
  const ctx = useScope();
  const client = useQueryClient();
  return useQuery<ReadResponse<T>, Error>({
    queryKey: [...scopeKey(ctx), SCHEMA_VERSION, viewKey, filters, period],
    retry: (count, error) => !(error instanceof AdapterError && (mustClearProtectedData(error.category) || !error.body.retryable)) && count < 2,
    queryFn: async ({ signal }) => {
      const requestId = `req-${++requestCounter}`;
      try {
        const res = await ctx.adapter.readView<F, T>(
          {
            schemaVersion: SCHEMA_VERSION,
            operation: "readView",
            viewKey,
            requestedScope: ctx.scope,
            filters,
            period,
            sort: [],
            page: { cursor: null, limit: 50 },
            requestId,
          },
          { signal },
        );
        assertScopeMatches(res, ctx.scope);
        return res;
      } catch (error) {
        if (error instanceof AdapterError && mustClearProtectedData(error.category)) dropProtectedData(client, scopeKey(ctx));
        throw error;
      }
    },
  });
}

export function dropProtectedData(client: QueryClient, root: readonly unknown[]) {
  client.removeQueries({ queryKey: root, type: "inactive" });
  for (const query of client.getQueryCache().findAll({ queryKey: root })) query.setState({ data: undefined, dataUpdatedAt: 0 });
}

export function assertScopeMatches(res: ReadResponse<unknown>, requested: { workspaceId: string; accountIds: string[]; environment: string }) {
  const same =
    res.scope.workspaceId === requested.workspaceId &&
    res.scope.environment === requested.environment &&
    [...res.scope.accountIds].sort().join(",") === [...requested.accountIds].sort().join(",");
  if (!same)
    throw new AdapterError({ code: "FORBIDDEN", message: "Response scope did not match the requested scope.", requestId: res.requestId, correlationId: null, retryable: false, retryAfterMs: null });
}
