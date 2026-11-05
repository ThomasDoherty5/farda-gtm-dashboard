import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { SCHEMA_VERSION, type Period, type ReadResponse } from "./contract";
import { AdapterError, mustClearProtectedData } from "./errors";
import { scopeKey, useScope } from "./scope";
import { assertScopeMatches, dropProtectedData } from "./useView";

let pagedRequestCounter = 0;

/** Cursor pages remain in the protected query cache, never in component-local accumulated rows. */
export function usePagedView<F, T>(viewKey: string, filters: F, period: Period | null = null, limit = 50) {
  const ctx = useScope();
  const client = useQueryClient();
  return useInfiniteQuery({
    queryKey: [...scopeKey(ctx), SCHEMA_VERSION, "cursor-pages", viewKey, filters, period, limit],
    initialPageParam: null as string | null,
    getNextPageParam: (last: ReadResponse<T>) => last.page.hasMore ? last.page.nextCursor ?? undefined : undefined,
    retry: (count, error) => !(error instanceof AdapterError && (mustClearProtectedData(error.category) || !error.body.retryable)) && count < 2,
    queryFn: async ({ pageParam, signal }): Promise<ReadResponse<T>> => {
      try {
        const res = await ctx.adapter.readView<F, T>({
          schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey,
          requestedScope: ctx.scope, filters, period, sort: [],
          page: { cursor: pageParam, limit }, requestId: `paged-req-${++pagedRequestCounter}`,
        }, { signal });
        assertScopeMatches(res, ctx.scope);
        return res;
      } catch (error) {
        if (error instanceof AdapterError && mustClearProtectedData(error.category)) dropProtectedData(client, scopeKey(ctx));
        throw error;
      }
    },
  });
}
