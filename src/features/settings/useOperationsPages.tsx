import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { usePagedView } from "@/adapter/usePagedView";
import { scopeKey, useScope } from "@/adapter/scope";
import { SCHEMA_VERSION, type ReadResponse } from "@/adapter/contract";
import { AdapterError, mustClearProtectedData } from "@/adapter/errors";
import { Button } from "@/components/Button";
import type { SavedBindings, SavedRuns } from "@/creator-agent/operationsView";

type SettingsFilters = { tab?: string; q?: string; state?: string };
type Saved = SavedBindings | SavedRuns;
function isSaved(value: unknown): value is Saved {
  return !!value && typeof value === "object" && "kind" in value && (value.kind === "saved-bindings" || value.kind === "saved-runs");
}

export function useOperationsPages<T>(view: string, filters: SettingsFilters = {}) {
  const context = useScope(), client = useQueryClient();
  const selectedFilters = context.adapter.kind === "demo" ? {} : filters;
  const query = usePagedView<SettingsFilters, T | Saved>(view, selectedFilters, null, 25);
  const cacheKey = JSON.stringify([...scopeKey(context), SCHEMA_VERSION, "cursor-pages", view, selectedFilters, null, 25]);
  useEffect(() => () => {
    const key = JSON.parse(cacheKey) as unknown[];
    void client.cancelQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: key, exact: true });
  }, [client, cacheKey]);
  const pages = query.data?.pages ?? [];
  const last = pages.at(-1);
  let data = last;
  if (last && isSaved(last.data)) {
    const saved = last.data;
    if (saved.kind === "saved-bindings") {
      const records = pages.flatMap(p => isSaved(p.data) && p.data.kind === saved.kind ? p.data.records : []);
      data = { ...last, data: { ...saved, records } };
    } else {
      const collected = pages.flatMap(p => isSaved(p.data) && p.data.kind === "saved-runs" ? [p.data] : []);
      data = { ...last, data: { ...saved, records: collected.flatMap(p => p.records), jobs: collected.flatMap(p => p.jobs) } };
    }
  }
  if (query.error instanceof AdapterError && mustClearProtectedData(query.error.category)) data = undefined;
  const restart = () => client.resetQueries({ queryKey: JSON.parse(cacheKey), exact: true });
  const paging = last && isSaved(last.data) ? <section aria-label="Saved records pagination">
    <p role="status">{query.isFetchingNextPage ? "Loading the next page…" : query.isFetchNextPageError ? "The next page could not be loaded." :
      query.hasNextPage ? "More saved records are available." : "All saved records in this snapshot have been displayed."}</p>
    {query.isFetchNextPageError && <Button variant="secondary" onClick={() => void restart()}>Restart list</Button>}
    {query.hasNextPage && !(query.error instanceof AdapterError && ["INVALID_OPERATIONS_CURSOR","OPERATIONS_CURSOR_EXPIRED"].includes(query.error.body.code)) &&
      <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage({cancelRefetch:false})}>{query.isFetchNextPageError ? "Retry next page" : "Load more"}</Button>}
  </section> : null;
  return { ...query, data: data as ReadResponse<T> | undefined, paging, restart };
}

export function useSavedDisplayFilters(tab?: string) {
  const [params] = useSearchParams();
  return { ...(tab ? { tab } : {}), ...(params.get("savedSearch") ? { q: params.get("savedSearch")!.slice(0,120) } : {}),
    ...(params.get("savedState") ? { state: params.get("savedState")!.slice(0,50) } : {}) };
}
