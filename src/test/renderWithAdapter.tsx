import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, RouterProvider, createMemoryRouter } from "react-router-dom";
import type { FardaAdapter } from "@/adapter/adapter";
import type { Environment, ReadRequest, ReadResponse } from "@/adapter/contract";
import { ScopeProvider } from "@/adapter/scope";
import { AdapterError } from "@/adapter/errors";
import { buildRoutes } from "@/routes/router";

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

/** Renders the real route tree at a path. Needed by anything using data-router features. */
export function renderRoute(path: string, adapter: FardaAdapter, client = testClient()) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <ScopeProvider adapter={adapter} scope={scopeFor(adapter.environment)} principal="tester">
        <RouterProvider router={router} useTransitions={false} />
      </ScopeProvider>
    </QueryClientProvider>,
  );
  return router;
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
    submitAction: async (request) => {
      throw new AdapterError({ code: "INTEGRATION_PENDING", message: "No scripted action.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
    },
    saveResource: async (request) => {
      throw new AdapterError({ code: "INTEGRATION_PENDING", message: "No scripted save.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
    },
  };
}
