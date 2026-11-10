import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createDemoAdapter } from "./demoAdapter";
import type { ReadRequest, ReadResponse, RequestedScope } from "./contract";
import { AdapterError } from "./errors";
import { usePagedView } from "./usePagedView";
import { ScopeProvider } from "./scope";
import { assertScopeMatches, dropProtectedData, protectedRead, useView } from "./useView";
import { scriptedAdapter, testClient } from "@/test/renderWithAdapter";
import { ViewError } from "@/components/ViewError";

const response = (request: ReadRequest<unknown>, data: string, accountIds = request.requestedScope.accountIds): ReadResponse<unknown> => ({
  schemaVersion: request.schemaVersion,
  requestId: request.requestId,
  scope: { ...request.requestedScope, accountIds, authorizationScopeVersion: "1" },
  dataVersion: "1",
  dataState: "ready",
  data,
  sourceFreshness: [],
  coverage: { expectedCount: null, observedCount: null, missingCount: null, complete: null, reasonCodes: [] },
  capabilities: [],
  page: { nextCursor: null, hasMore: false },
  refresh: { nextPollAfterMs: null },
});

const denied = (code: string) => new AdapterError({ code, message: code, requestId: null, correlationId: null, retryable: false, retryAfterMs: null });

function View() {
  const query = useView<object, string>("view", {});
  return (
    <>
      <p data-testid="data">{query.data?.data ?? "none"}</p>
      <p data-testid="error">{query.error?.message ?? "none"}</p>
      <button onClick={() => void query.refetch()}>refetch</button>
    </>
  );
}

const scope = (accountIds: string[]): RequestedScope => ({ workspaceId: "w", accountIds, environment: "demo" });

describe("useView", () => {
  it.each(["UNAUTHENTICATED", "FORBIDDEN"])("retains a recoverable %s state when a nested denial clears a completed parent", async code => {
    let rejectNested: () => void = () => {};
    let recovering = false;
    const adapter = scriptedAdapter(async request => {
      if (request.viewKey === "nested" && !recovering)
        return new Promise((_resolve, reject) => { rejectNested = () => reject(denied(code)); });
      return response(request, recovering ? "fresh authorized parent" : "protected parent");
    });
    const client = testClient();
    function Nested() { const query = useView<object, string>("nested", {}); return <p>{query.error?.message ?? "nested loading"}</p>; }
    function Parent() {
      const query = useView<object, string>("parent", {});
      return <>{query.isError && <ViewError error={query.error} subject="Parent" onRetry={() => void query.refetch()} />}
        {query.data && <><p>{query.data.data}</p><Nested /></>}</>;
    }
    render(<QueryClientProvider client={client}><ScopeProvider adapter={adapter} scope={scope(["a"])} principal="p"><Parent /></ScopeProvider></QueryClientProvider>);
    await screen.findByText("nested loading");
    await act(async () => rejectNested());
    await screen.findByRole("heading", { name: code === "FORBIDDEN" ? "No access to this account" : "Sign in again" });
    expect(screen.queryByText("protected parent")).not.toBeInTheDocument();
    expect(screen.queryByText("nested loading")).not.toBeInTheDocument();
    expect(client.getQueryCache().getAll().every(query => query.state.data === undefined)).toBe(true);
    recovering = true;
    await act(async () => screen.getByRole("button", { name: "Check access again" }).click());
    await screen.findByText("fresh authorized parent");
    expect(screen.queryByRole("heading", { name: /No access|Sign in again/ })).not.toBeInTheDocument();
  });
  it("isolates page cursor and limit in both the source request and cache identity",async()=>{
    const requests:ReadRequest<unknown>[]=[];
    const adapter=scriptedAdapter(async request=>{requests.push(request);return response(request,`${request.page.cursor??"first"}/${request.page.limit}`);});
    const client=testClient();
    function Paged({cursor,limit}:{cursor:string|null;limit:number}){const query=useView<object,string>("ledger",{},null,{page:{cursor,limit}});return <p>{query.data?.data}</p>;}
    const tree=(cursor:string|null,limit:number)=><QueryClientProvider client={client}><ScopeProvider adapter={adapter} scope={scope(["a"])} principal="p"><Paged cursor={cursor} limit={limit}/></ScopeProvider></QueryClientProvider>;
    const {rerender}=render(tree(null,25));await screen.findByText("first/25");
    rerender(tree("next",25));await screen.findByText("next/25");
    rerender(tree("next",50));await screen.findByText("next/50");
    expect(requests.map(request=>request.page)).toEqual([{cursor:null,limit:25},{cursor:"next",limit:25},{cursor:"next",limit:50}]);
    expect(client.getQueryCache().getAll()).toHaveLength(3);
  });
  it("cannot publish a 200 when scope authorization is lost between resolving the read and committing the cache", async () => {
    const client = testClient(), root = ["protected","synthetic-scope"], key = [...root,"page"];
    const commits: string[] = [];
    const observer = new QueryObserver(client,{queryKey:key,retry:false,queryFn:async()=>{
      const result = await protectedRead(client,root,"read",async()=>"old protected rows");
      // This models a separate read or save learning of auth loss before TanStack commits the already-resolved response.
      queueMicrotask(()=>dropProtectedData(client,root));
      return result;
    }});
    const unsubscribe = observer.subscribe(s=>{if(s.data)commits.push(s.data);});
    try {
      await waitFor(()=>expect(observer.getCurrentResult().fetchStatus).toBe("idle"));
      expect(client.getQueryData(key)).toBeUndefined();
      expect(commits).not.toContain("old protected rows");
    } finally {unsubscribe();client.clear();}
  });
  it.each(["UNAUTHENTICATED", "FORBIDDEN"])("a concurrent %s fences delayed ordinary and paged reads without poisoning fresh recovery", async code => {
    const pending = new Map<string, () => void>();
    let recovering = false;
    const adapter = scriptedAdapter(async req => {
      if (recovering) return response(req, "fresh after recovery");
      return new Promise((resolve,reject) => pending.set(req.viewKey, () => req.viewKey === "deny"
        ? reject(denied(code)) : resolve(response(req, "old protected rows"))));
    });
    const client = testClient();
    function Concurrent() {
      const one = useView<object,string>("regular", {});
      const paged = usePagedView<object,string>("pages", {});
      const deny = useView<object,string>("deny", {});
      return <><p data-testid="regular-result">{one.data?.data ?? one.error?.message ?? "waiting"}</p>
        <p data-testid="pages-result">{paged.data?.pages[0]?.data ?? paged.error?.message ?? "waiting"}</p>
        <p data-testid="denial">{deny.error?.message}</p></>;
    }
    render(<QueryClientProvider client={client}><ScopeProvider adapter={adapter} scope={scope(["a"])} principal="p"><Concurrent/></ScopeProvider></QueryClientProvider>);
    await waitFor(()=>expect(pending.size).toBe(3));
    await act(async()=>pending.get("deny")!());
    await waitFor(()=>expect(screen.getByTestId("denial")).toHaveTextContent(code));
    await act(async()=>{pending.get("regular")!();pending.get("pages")!();});
    await waitFor(()=>expect(screen.getByTestId("pages-result")).toHaveTextContent("Authorization changed"));
    expect(screen.getByTestId("regular-result")).toHaveTextContent("Authorization changed");
    expect(JSON.stringify(client.getQueryCache().getAll().map(q=>q.state.data))).not.toContain("old protected rows");
    recovering = true;
    await act(async()=>{await client.refetchQueries();});
    await waitFor(()=>expect(screen.getByTestId("regular-result")).toHaveTextContent("fresh after recovery"));
    expect(screen.getByTestId("pages-result")).toHaveTextContent("fresh after recovery");
  });

  it("rejects a response whose verified scope differs from the request", async () => {
    const adapter = scriptedAdapter(async (request) => response(request, "other account's data", ["someone-else"]));
    render(
      <QueryClientProvider client={testClient()}>
        <ScopeProvider adapter={adapter} scope={scope(["a"])} principal="p"><View /></ScopeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("Response scope did not match"));
    expect(screen.getByTestId("data")).toHaveTextContent("none");
  });

  it("treats account order as irrelevant to the scope check", () => {
    const res = response({ requestedScope: scope(["b", "a"]), schemaVersion: "1", requestId: "r" } as ReadRequest<unknown>, "x");
    expect(() => assertScopeMatches(res, scope(["a", "b"]))).not.toThrow();
  });

  it("never paints an old account's late response over the new account (FX-24)", async () => {
    let releaseOld: () => void = () => {};
    const adapter = scriptedAdapter((request) => {
      const account = request.requestedScope.accountIds[0]!;
      if (account === "old") return new Promise((resolve) => { releaseOld = () => resolve(response(request, "old data")); });
      return Promise.resolve(response(request, "new data"));
    });
    const client = testClient();
    const tree = (accounts: string[]) => (
      <QueryClientProvider client={client}>
        <ScopeProvider adapter={adapter} scope={scope(accounts)} principal="p"><View /></ScopeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(["old"]));
    rerender(tree(["new"]));
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("new data"));
    await act(async () => releaseOld());
    expect(screen.getByTestId("data")).toHaveTextContent("new data");
  });

  it("drops the previous scope's cached data when the scope changes", async () => {
    const adapter = scriptedAdapter(async (request) => response(request, `data for ${request.requestedScope.accountIds[0]}`));
    const client = testClient();
    const tree = (accounts: string[]) => (
      <QueryClientProvider client={client}>
        <ScopeProvider adapter={adapter} scope={scope(accounts)} principal="p"><View /></ScopeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(["a"]));
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("data for a"));
    rerender(tree(["b"]));
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("data for b"));
    expect(client.getQueryCache().findAll().every((q) => JSON.stringify(q.queryKey).includes('"b"'))).toBe(true);
  });

  it.each(["SESSION_EXPIRED", "FORBIDDEN"])("clears previously read data after %s (FX-08, FX-09, FX-23)", async (code) => {
    const adapter = scriptedAdapter(async (request, call) => {
      if (call === 1) return response(request, "secret");
      throw denied(code);
    });
    const client = testClient();
    render(
      <QueryClientProvider client={client}>
        <ScopeProvider adapter={adapter} scope={scope(["a"])} principal="p"><View /></ScopeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("secret"));
    await act(async () => screen.getByText("refetch").click());
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent(code));
    expect(screen.getByTestId("data")).toHaveTextContent("none");
    expect(JSON.stringify(client.getQueryCache().findAll().map((q) => q.state.data))).not.toContain("secret");
    expect(adapter.calls).toHaveLength(2);
  });

  it("keeps prior data through a transient outage, so the page can label it stale (FX-07)", async () => {
    const adapter = scriptedAdapter(async (request, call) => {
      if (call === 1) return response(request, "last good");
      throw new AdapterError({ code: "SOURCE_UNAVAILABLE", message: "down", requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    });
    render(
      <QueryClientProvider client={testClient()}>
        <ScopeProvider adapter={adapter} scope={scope(["a"])} principal="p"><View /></ScopeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("last good"));
    await act(async () => screen.getByText("refetch").click());
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("down"));
    expect(screen.getByTestId("data")).toHaveTextContent("last good");
  });

  it("aborts the in-flight read when the view unmounts (FX-26)", async () => {
    let signal: AbortSignal | undefined;
    const adapter = createDemoAdapter({ latencyMs: 10_000 });
    const spy = vi.spyOn(adapter, "readView").mockImplementation((_request, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    const { unmount } = render(
      <QueryClientProvider client={testClient()}>
        <ScopeProvider adapter={adapter} scope={scope(["a"])} principal="p"><View /></ScopeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });

  describe("keepPrevious", () => {
    function Filtered({ filter }: { filter: string }) {
      const query = useView<{ filter: string }, string>("filtered", { filter }, null, { keepPrevious: true });
      return (
        <>
          <p data-testid="data">{query.data?.data ?? "none"}</p>
          <p data-testid="placeholder">{String(query.isPlaceholderData)}</p>
        </>
      );
    }
    const tree = (adapter: ReturnType<typeof scriptedAdapter>, accounts: string[], filter: string, client = testClient()) => (
      <QueryClientProvider client={client}>
        <ScopeProvider adapter={adapter} scope={scope(accounts)} principal="p"><Filtered filter={filter} /></ScopeProvider>
      </QueryClientProvider>
    );

    it("keeps the last data from the same scope while a changed filter loads", async () => {
      let release: (() => void) | undefined;
      const adapter = scriptedAdapter(async (request, call) => {
        if (call === 2) await new Promise<void>((resolve) => { release = resolve; });
        return response(request, `data for ${(request.filters as { filter: string }).filter}`);
      });
      const client = testClient();
      const { rerender } = render(tree(adapter, ["a"], "one", client));
      await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("data for one"));
      rerender(tree(adapter, ["a"], "two", client));
      await waitFor(() => expect(screen.getByTestId("placeholder")).toHaveTextContent("true"));
      expect(screen.getByTestId("data")).toHaveTextContent("data for one");
      await act(async () => release?.());
      await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("data for two"));
    });

    it("never carries data across a scope change", async () => {
      const adapter = scriptedAdapter(async (request, call) => {
        if (call === 2) await new Promise(() => {});
        return response(request, "account a's data");
      });
      const client = testClient();
      const { rerender } = render(tree(adapter, ["a"], "one", client));
      await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("account a's data"));
      rerender(tree(adapter, ["b"], "one", client));
      await waitFor(() => expect(adapter.calls).toHaveLength(2));
      expect(screen.getByTestId("data")).toHaveTextContent("none");
    });
  });
});
