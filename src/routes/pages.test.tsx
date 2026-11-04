import { render, screen } from "@testing-library/react";
import { sourceScreens } from "./manifest.generated";
import { navSections } from "./nav";
import { PageLoading, implementedPages, sectionPageLoaders } from "./pages";

const manifestPaths = [...new Set(sourceScreens.map((s) => s.path))];

describe("lazy route modules", () => {
  it("has no lazy entry for a path outside the manifest or the section list", () => {
    const sections = new Set(navSections.map((s) => s.seg));
    expect(Object.keys(implementedPages).filter((p) => !manifestPaths.includes(p))).toEqual([]);
    expect(Object.keys(sectionPageLoaders).filter((seg) => !sections.has(seg))).toEqual([]);
  });

  it.each(manifestPaths)("%s resolves its module, or is an explicit placeholder", async (path) => {
    const page = implementedPages[path];
    if (!page) return; // Rendered by RoutePlaceholder; routes.test.tsx checks the "Not built yet" state.
    const module = await page.load();
    expect(typeof module.default).toBe("function");
  });

  it.each(Object.keys(sectionPageLoaders))("section page %s resolves its module", async (seg) => {
    const module = await sectionPageLoaders[seg]!.load();
    expect(typeof module.default).toBe("function");
  });

  it("shows an honest, accessible pending state with no heading and no data", () => {
    render(<PageLoading />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading page");
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
