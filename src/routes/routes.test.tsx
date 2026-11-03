import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import type { FardaAdapter } from "@/adapter/adapter";
import { ScopeProvider } from "@/adapter/scope";
import { scopeFor, testClient } from "@/test/renderWithAdapter";
import { sourceScreens } from "./manifest.generated";
import { navSections } from "./nav";
import { buildRoutes } from "./router";

function renderAt(path: string, adapter: FardaAdapter = createDemoAdapter()) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  render(
    <QueryClientProvider client={testClient()}>
      <ScopeProvider adapter={adapter} scope={scopeFor(adapter.environment)} principal="tester">
        <RouterProvider router={router} />
      </ScopeProvider>
    </QueryClientProvider>,
  );
  return router;
}

const concrete = (path: string) => path.replace(/:(\w+)/g, "demo-$1");

describe("source manifest", () => {
  it("has 60 sources with unique source and prototype nodes", () => {
    expect(sourceScreens).toHaveLength(60);
    expect(new Set(sourceScreens.map((s) => s.sourceNodeId)).size).toBe(60);
    expect(new Set(sourceScreens.map((s) => s.prototypeNodeId)).size).toBe(60);
  });

  it("never uses a prototype clone as a source node", () => {
    const prototypes = new Set(sourceScreens.map((s) => s.prototypeNodeId));
    expect(sourceScreens.filter((s) => prototypes.has(s.sourceNodeId))).toEqual([]);
  });

  it("gives every query-selected source on a shared path a distinct selection", () => {
    const selections = sourceScreens.map((s) => `${s.path}?${new URLSearchParams(s.query)}#${s.variant ?? ""}`);
    expect(new Set(selections).size).toBe(60);
  });

  it("marks historical v2 scorecards read-only", () => {
    const historical = sourceScreens.filter((s) => /-v2 history/.test(s.variant ?? ""));
    expect(historical).toHaveLength(3);
    expect(historical.every((s) => s.scope === "Read-only historical v2 snapshot")).toBe(true);
  });
});

describe("routes", () => {
  it.each(sourceScreens.map((s) => [s.screen, s] as const))("%s has a route that renders with no invented data", async (_name, source) => {
    const query = new URLSearchParams(source.query).toString();
    renderAt(concrete(source.path) + (query ? `?${query}` : ""));
    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("heading", { level: 1 })).toBeInTheDocument();
    if (source.path !== "/overview") {
      expect(within(main).getByText(/Not built yet/)).toBeInTheDocument();
      expect(within(main).getByRole("link", { name: source.sourceNodeId })).toBeInTheDocument();
    }
  });

  it("redirects the root to Overview", async () => {
    const router = renderAt("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/overview"));
  });

  it("shows a recoverable not-found page for an address outside the manifest", async () => {
    renderAt("/not-a-route");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });

  it("restores the previous route on Back", async () => {
    const user = userEvent.setup();
    const router = renderAt("/overview");
    await user.click(screen.getByRole("link", { name: "Finance" }));
    expect(router.state.location.pathname).toBe("/finance");
    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/overview"));
  });
});

describe("shell", () => {
  it("offers a skip link to the main landmark", async () => {
    renderAt("/overview");
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main");
    expect(await screen.findByRole("main")).toHaveAttribute("id", "main");
  });

  it("marks the current section (CTRL-220)", () => {
    renderAt("/overview");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the development state gallery out of primary navigation but routable", async () => {
    expect(navSections.map((s) => s.seg)).not.toContain("design-system");
    renderAt("/design-system/states");
    expect(await screen.findByRole("heading", { name: "Recovery state gallery" })).toBeInTheDocument();
  });

  it("shows the demo label on every demo route", async () => {
    renderAt("/finance");
    expect(await screen.findByTestId("demo-banner")).toHaveTextContent("Demo data");
  });

  it("shows no demo label and no demo values on a live route", async () => {
    renderAt("/overview", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("demo-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("metric-Orders")).not.toBeInTheDocument();
  });
});
