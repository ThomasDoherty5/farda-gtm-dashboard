import { screen } from "@testing-library/react";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { renderRoute } from "@/test/renderWithAdapter";
import { sourceScreens } from "./manifest.generated";

const concrete = (path: string) => path.replace(/:(\w+)/g, "demo-$1");
const PATHS = [...new Set(sourceScreens.map((s) => s.path))];

/** A control name in words, so two hotspots to one place can be compared. */
const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();

describe("FHC-05 a repeated parent/child hotspot is one action", () => {
  it.each(PATHS.map((p) => [p] as const))("%s has no control nested inside another control", async (path) => {
    renderRoute(concrete(path), createDemoAdapter());
    const main = await screen.findByRole("main");
    await screen.findAllByRole("heading");
    const nested = [...main.querySelectorAll("a a, a button, button a, button button, [role=button] a, [role=button] button, [role=link] a, [role=link] button")].map((el) => `${el.tagName.toLowerCase()} "${nameOf(el)}"`);
    expect(nested).toEqual([]);
  });

  it.each(PATHS.map((p) => [p] as const))("%s never offers two links to one place inside one row, item or card", async (path) => {
    renderRoute(concrete(path), createDemoAdapter());
    const main = await screen.findByRole("main");
    await screen.findAllByRole("heading");
    const repeated: string[] = [];
    for (const container of main.querySelectorAll("li, tr, article, dl, dd, dt")) {
      const seen = new Map<string, string>();
      for (const a of container.querySelectorAll("a[href]")) {
        if (a.closest("li, tr, article, dl, dd, dt") !== container) continue; // count a link only in its own nearest container
        const href = a.getAttribute("href")!;
        if (seen.has(href)) repeated.push(`${href}: "${seen.get(href)}" and "${nameOf(a)}"`);
        else seen.set(href, nameOf(a));
      }
    }
    expect(repeated).toEqual([]);
  });
});
