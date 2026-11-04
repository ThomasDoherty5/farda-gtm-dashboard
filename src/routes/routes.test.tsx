import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import type { FardaAdapter } from "@/adapter/adapter";
import { renderRoute } from "@/test/renderWithAdapter";
import { sourceScreens } from "./manifest.generated";
import { navSections } from "./nav";

const renderAt = (path: string, adapter: FardaAdapter = createDemoAdapter()) => renderRoute(path, adapter);

/** Overview, approval detail, and the two run tabs. The tabless run path is the hourly variant, not built. */
const BUILT_SOURCES = new Set(["10:217", "6:234", "5:13", "5:156", "102:555", "102:364", "4:6", "4:171", "4:317", "12:292", "12:431", "12:808", "12:653", "12:708", "102:74", "6:24", "9:143", "23:275", "23:440", "38:131", "38:348", "66:821", "9:299", "9:436", "3:6", "14:74", "14:377", "30:349", "30:550", "30:721", "37:74", "37:251", "65:634", "65:814", "23:73", "25:166", "25:307", "25:481", "7:129", "7:317"]);

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
    if (!BUILT_SOURCES.has(source.sourceNodeId)) {
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
    expect(await screen.findByTestId("demo-banner")).toHaveTextContent("Demo workspace");
  });

  it("shows no demo label and no demo values on a live route", async () => {
    renderAt("/overview", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("demo-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("metric-Paid orders")).not.toBeInTheDocument();
  });
});
