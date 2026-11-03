import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { FardaAdapter } from "@/adapter/adapter";
import type { Environment, ReadRequest, ReadResponse } from "@/adapter/contract";
import { ScopeProvider } from "@/adapter/scope";

export const testClient = () => new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });

export const scopeFor = (environment: Environment = "demo", accountIds = ["a"]) => ({ workspaceId: "w", accountIds, environment });

export function renderWithAdapter(ui: ReactElement, adapter: FardaAdapter, client = testClient()) {
  const tree = (node: ReactElement) => (
    <QueryClientProvider client={client}>
      <ScopeProvider adapter={adapter} scope={scopeFor(adapter.environment)} principal="tester">
        <MemoryRouter>{node}</MemoryRouter>
      </ScopeProvider>
    </QueryClientProvider>
  );
  return { ...render(tree(ui)), client };
}

/** An adapter whose reads are answered by the test, one call at a time. */
export function scriptedAdapter(answer: (request: ReadRequest<unknown>, call: number) => Promise<ReadResponse<unknown>>, kind: FardaAdapter["kind"] = "demo"): FardaAdapter & { calls: ReadRequest<unknown>[] } {
  const calls: ReadRequest<unknown>[] = [];
  return {
    environment: "demo",
    kind,
    calls,
    readView: (async (request: ReadRequest<unknown>) => {
      calls.push(request);
      return answer(request, calls.length);
    }) as FardaAdapter["readView"],
  };
}
