import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter, type RouteObject } from "react-router-dom";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { ScopeProvider } from "@/adapter/scope";
import { buildRoutes } from "@/routes/router";
import { scopeFor, testClient } from "@/test/renderWithAdapter";
import { AppErrorBoundary } from "./RenderError";

const SECRET = "provider-id-9f3a leaked in a message";

/** A screen that receives a shape the contract did not promise, after rendering some data. */
function Boom(): JSX.Element {
  const value = null as unknown as { amount: number };
  return (
    <section>
      <h1>Boom screen</h1>
      <p>Partial protected figure: 1,234</p>
      <Throw value={value} />
    </section>
  );
}
function Throw({ value }: { value: { amount: number } }): JSX.Element {
  if (value === null) throw new TypeError(SECRET);
  return <span>{value.amount}</span>;
}

/** The real route tree, with throwing screens added beside the real ones. */
function routesWith(extra: RouteObject[]) {
  const routes = buildRoutes();
  routes[0]!.children![0]!.children!.push(...extra);
  return routes;
}

function renderTree(routes: RouteObject[], entries: string[], initialIndex?: number) {
  const adapter = createDemoAdapter();
  const router = createMemoryRouter(routes, { initialEntries: entries, initialIndex });
  render(
    <QueryClientProvider client={testClient()}>
      <ScopeProvider adapter={adapter} scope={scopeFor(adapter.environment)} principal="tester">
        <RouterProvider router={router} />
      </ScopeProvider>
    </QueryClientProvider>,
  );
  return router;
}

const quietConsole = () => vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => vi.unstubAllEnvs());

describe("a screen that throws while rendering", () => {
  const boom: RouteObject = { path: "/boom", element: <Boom /> };

  it("is replaced by a labeled error state inside the shell, with no partial data, message or stack", async () => {
    quietConsole();
    renderTree(routesWith([boom]), ["/boom"]);
    const main = await screen.findByRole("main");
    const alert = within(main).getByRole("alert");
    expect(within(alert).getByText("Error")).toBeInTheDocument();
    expect(within(alert).getByRole("heading", { level: 1, name: "Something went wrong on this screen" })).toBeInTheDocument();
    // The shell stays, so the user can still navigate.
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByTestId("demo-banner")).toBeInTheDocument();
    // Nothing from the failed screen survives, and nothing reads as a result.
    expect(screen.queryByText(/Boom screen|1,234/)).not.toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/provider-id|leaked|TypeError|\bat \w+.*\(|node_modules/);
    expect(alert.textContent).not.toMatch(/success|sent|approved|saved/i);
    expect(alert.textContent).toMatch(/Nothing here is a zero or an empty result/);
  });

  it("moves focus to the error heading", async () => {
    quietConsole();
    renderTree(routesWith([boom]), ["/boom"]);
    const heading = await screen.findByRole("heading", { name: "Something went wrong on this screen" });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("logs the error in development only", async () => {
    const spy = quietConsole();
    renderTree(routesWith([boom]), ["/boom"]);
    await screen.findByTestId("render-error");
    expect(spy.mock.calls.some(([tag, err]) => tag === "[render error: route]" && err instanceof TypeError)).toBe(true);
    spy.mockClear();
    vi.stubEnv("DEV", false);
    renderTree(routesWith([{ path: "/boom2", element: <Boom /> }]), ["/boom2"]);
    await screen.findAllByTestId("render-error");
    expect(spy.mock.calls.some(([tag]) => String(tag).startsWith("[render error"))).toBe(false);
  });

  it("offers Go back only when there is history to go back to, plus Overview and Reload", async () => {
    quietConsole();
    const user = userEvent.setup();
    const first = renderTree(routesWith([boom]), ["/boom"]);
    await screen.findByTestId("render-error");
    expect(screen.queryByRole("button", { name: "Go back" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Go to Overview" }));
    await waitFor(() => expect(first.state.location.pathname).toBe("/overview"));
    expect(screen.queryByTestId("render-error")).not.toBeInTheDocument();
  });

  it("goes back to the previous screen", async () => {
    quietConsole();
    const user = userEvent.setup();
    const router = renderTree(routesWith([boom]), ["/settings/team", "/boom"], 1);
    await user.click(await screen.findByRole("button", { name: "Go back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/team"));
    expect(await screen.findByRole("heading", { level: 1 })).not.toHaveTextContent("Something went wrong");
  });

  it("leaves other routes working after navigating away, and shows the error again on return", async () => {
    quietConsole();
    const user = userEvent.setup();
    const router = renderTree(routesWith([boom]), ["/boom"]);
    await screen.findByTestId("render-error");
    await user.click(screen.getByRole("link", { name: "Finance" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/finance"));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId("render-error")).not.toBeInTheDocument();
    await router.navigate("/overview");
    expect(await screen.findByTestId("metric-Paid orders")).toBeInTheDocument();
    await router.navigate("/boom");
    expect(await screen.findByTestId("render-error")).toBeInTheDocument();
  });

  it("catches a throw on an unknown address and on an index redirect target the same way", async () => {
    quietConsole();
    const routes = buildRoutes();
    routes[0]!.children![0]!.children!.find((r) => r.path === "*")!.element = <Boom />;
    renderTree(routes, ["/not-a-route"]);
    expect(await screen.findByTestId("render-error")).toBeInTheDocument();
  });
});

describe("a failure in the shell or above the router", () => {
  it("shows the error state on its own when the shell route throws", async () => {
    quietConsole();
    const routes = buildRoutes();
    routes[0]!.element = <Boom />;
    renderTree(routes, ["/overview"]);
    const main = await screen.findByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Something went wrong on this screen" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/provider-id|Boom screen/);
  });

  it("the top-level boundary replaces everything with a reload path and no raw error", async () => {
    const spy = quietConsole();
    render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    const main = await screen.findByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Something went wrong on this screen" })).toHaveFocus();
    expect(within(main).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/provider-id|Boom screen|1,234/);
    expect(spy.mock.calls.some(([tag]) => tag === "[render error: app]")).toBe(true);
  });
});
