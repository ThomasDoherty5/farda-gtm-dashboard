import { screen, within } from "@testing-library/react";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { renderRoute } from "@/test/renderWithAdapter";
import { breadcrumbsFor } from "./breadcrumbs";
import { sourceScreens } from "./manifest.generated";

const concrete = (path: string) => path.replace(/:(\w+)/g, "demo-$1");

describe("FE00-04 breadcrumbs", () => {
  it("names the section, the page and the record", () => {
    expect(breadcrumbsFor("/orders/TEST-SH-1042")).toEqual([{ label: "Operations" }, { label: "Order detail" }, { label: "TEST-SH-1042" }]);
    expect(breadcrumbsFor("/overview")).toEqual([{ label: "Overview" }, { label: "Performance overview" }]);
  });

  it("a query value selects the right page name on a shared path", () => {
    expect(breadcrumbsFor("/launch", "?view=control").at(-1)!.label).toBe("Launch control");
    expect(breadcrumbsFor("/launch", "?view=snapshot").at(-1)!.label).toBe("Launch snapshot");
    expect(breadcrumbsFor("/creators/tiktok", "?view=board").at(-1)!.label).toBe("TikTok current funnel");
  });

  it("drops the design code from a screen name", () => {
    expect(breadcrumbsFor("/creators/discovery").at(-1)!.label).toBe("Daily sourcing and invitation plan");
  });

  it("does not label every registered cadence as an hourly run", () => {
    expect(breadcrumbsFor("/runs/rt-run-synthetic").at(-2)?.label).toBe("Registered source run");
    expect(breadcrumbsFor("/runs/demo-run").at(-2)?.label).toBe("Hourly run");
  });

  it("an address outside the manifest says so rather than inventing a trail", () => {
    expect(breadcrumbsFor("/not-a-route")).toEqual([{ label: "Page not found" }]);
  });

  it.each([...new Set(sourceScreens.map((s) => s.path))].map((p) => [p] as const))("%s renders a trail that ends in the current page and adds no link", async (path) => {
    renderRoute(concrete(path), createDemoAdapter());
    const nav = await screen.findByRole("navigation", { name: "Breadcrumb" });
    const items = within(nav).getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(within(nav).queryAllByRole("link")).toEqual([]);
    expect(items.at(-1)!.querySelector('[aria-current="page"]')).not.toBeNull();
  });
});
