import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import type { RequestedScope } from "@/adapter/contract";
import type { FardaAdapter } from "@/adapter/adapter";
import { AppErrorBoundary } from "@/components/RenderError";
import { ScopeProvider } from "@/adapter/scope";
import { DEMO_ACCOUNT, DEMO_WORKSPACE } from "@/fixtures/overview";
import { buildRoutes } from "@/routes/router";

export function App({ adapter, queryClient, session }: { adapter: FardaAdapter; queryClient?: QueryClient; session?: { scope: RequestedScope; principal: string } | null }) {
  const client = useMemo(() => queryClient ?? new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } }), [queryClient]);
  const router = useMemo(() => createBrowserRouter(buildRoutes()), []);
  // Demo scope is fixed. Live scope comes from the authenticated session (THO-283), never from the URL.
  const scope = useMemo(() => adapter.kind === "demo" ? { workspaceId: DEMO_WORKSPACE, accountIds: [DEMO_ACCOUNT], environment: adapter.environment } : session?.scope ?? { workspaceId: "unbound", accountIds: [], environment: adapter.environment }, [adapter.environment, adapter.kind, session]);
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={client}>
        <ScopeProvider adapter={adapter} scope={scope} principal={adapter.kind === "demo" ? "demo-user" : session?.principal ?? "unbound-session"}>
          <RouterProvider router={router} useTransitions={false} />
        </ScopeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
