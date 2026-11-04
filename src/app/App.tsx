import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import type { FardaAdapter } from "@/adapter/adapter";
import { AppErrorBoundary } from "@/components/RenderError";
import { ScopeProvider } from "@/adapter/scope";
import { DEMO_ACCOUNT, DEMO_WORKSPACE } from "@/fixtures/overview";
import { buildRoutes } from "@/routes/router";

export function App({ adapter, queryClient }: { adapter: FardaAdapter; queryClient?: QueryClient }) {
  const client = useMemo(() => queryClient ?? new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } }), [queryClient]);
  const router = useMemo(() => createBrowserRouter(buildRoutes()), []);
  // Demo scope is fixed. Live scope comes from the authenticated session (THO-283), never from the URL.
  const scope = useMemo(() => ({ workspaceId: DEMO_WORKSPACE, accountIds: [DEMO_ACCOUNT], environment: adapter.environment }), [adapter.environment]);
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={client}>
        <ScopeProvider adapter={adapter} scope={scope} principal={adapter.kind === "demo" ? "demo-user" : "session"}>
          <RouterProvider router={router} />
        </ScopeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
