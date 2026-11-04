import { readFileSync, writeFileSync } from "node:fs";
import { screen, waitFor, within } from "@testing-library/react";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { renderRoute } from "@/test/renderWithAdapter";
import { sourceScreens } from "./manifest.generated";
import { concreteUrl, coverageRows, renderCoverageDoc } from "./screenCoverage";

const DOC = "docs/screen-coverage.md";
const DESIGN_MAP = readFileSync("docs/design-map.md", "utf8");

describe("screen coverage map (VIS-01)", () => {
  const rows = coverageRows();
  const built: Record<string, boolean> = {};
  const recorded: Record<string, boolean> = {};

  it("has one row per manifest source, each with a distinct source node", () => {
    expect(rows).toHaveLength(sourceScreens.length);
    expect(new Set(rows.map((r) => r.sourceNodeId)).size).toBe(sourceScreens.length);
  });

  it("gives every parameterised source a demo record, and every address no unresolved parameter", () => {
    for (const source of sourceScreens) expect(concreteUrl(source), source.sourceNodeId).not.toMatch(/:\w+/);
  });

  it.each(sourceScreens.map((s) => [`${s.sourceNodeId} ${s.screen}`, s] as const))("%s renders from its demo URL", async (_name, source) => {
    renderRoute(concreteUrl(source), createDemoAdapter());
    // A loading page already has a heading; wait until the page that replaces it is the one in the document.
    await waitFor(() => {
      expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 })).toBeInTheDocument();
      expect(within(screen.getByRole("main")).queryByRole("status", { name: /loading/i })).toBeNull();
    }, { timeout: 5000 });
    const main = screen.getByRole("main");
    built[source.sourceNodeId] = within(main).queryByText(/Not built yet/) === null;
    recorded[source.sourceNodeId] = DESIGN_MAP.includes(source.sourceNodeId);
  });

  it("has a recorded comparison in docs/design-map.md for every built source", () => {
    const missing = rows.filter((r) => built[r.sourceNodeId] && !recorded[r.sourceNodeId]).map((r) => r.sourceNodeId);
    expect(missing).toEqual([]);
  });

  it("matches docs/screen-coverage.md", () => {
    const doc = renderCoverageDoc(rows, built, recorded);
    if (process.env.UPDATE_SCREEN_COVERAGE) writeFileSync(DOC, doc);
    expect(readFileSync(DOC, "utf8")).toBe(doc);
  });
});
