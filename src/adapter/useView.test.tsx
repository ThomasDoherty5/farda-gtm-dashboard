import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createDemoAdapter } from "./demoAdapter";
import type { ReadRequest, ReadResponse, RequestedScope } from "./contract";
import { AdapterError } from "./errors";
import { ScopeProvider } from "./scope";
import { assertScopeMatches, useView } from "./useView";
import { scriptedAdapter, testClient } from "@/test/renderWithAdapter";

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
});
