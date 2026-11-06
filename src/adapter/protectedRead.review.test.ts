import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { dropProtectedData, protectedRead } from "./useView";

it("does not publish a response when authorization is cleared between its guard and the query cache commit", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = ["farda", "synthetic-reviewer", "sandbox", "synthetic-workspace", "synthetic-account"];
  const queryKey = [...root, "review-view"];
  const observer = new QueryObserver(client, { queryKey, queryFn: () => {
    const reading = protectedRead(client, root, "synthetic-review-request", () => Promise.resolve("protected old response"));
    // This runs after protectedRead's await resumes, but before its promise is committed by QueryObserver.
    queueMicrotask(() => dropProtectedData(client, root));
    return reading;
  } });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false));
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(client.getQueryData(queryKey)).toBeUndefined();
    observer.setOptions({ queryKey, queryFn: () => protectedRead(client, root, "synthetic-new-request", () => Promise.resolve("fresh authorized response")) });
    await observer.refetch();
    expect(client.getQueryData(queryKey)).toBe("fresh authorized response");
  } finally { unsubscribe(); client.clear(); }
});
