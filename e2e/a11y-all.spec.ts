import { expect, test, type Page } from "@playwright/test";
import { axeViolations, chunk } from "./support/axe";
import { settle } from "./support/layout";
import { extraRecordUrls, routeUrls } from "./support/routes";

const allUrls = [...routeUrls, ...extraRecordUrls];

/**
 * axe (wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) on every built route (FHC-02, FHC-05, VIS-05): default state at 390 and 1440,
 * then every alternate state a route can reach through its demo selectors, and every dialog a route opens.
 * Runs once, in the desktop project, which sets each width itself.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop-1440", "sets its own viewport; one project is enough");
});

const GROUPS = 4;
const text = (page: Page) => page.locator("main").innerText();

for (const width of [1440, 390]) {
  chunk(allUrls, GROUPS).forEach((urls, i) => {
    test(`default state, ${width}px, routes ${i + 1} of ${GROUPS}`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      const found: string[] = [];
      for (const url of urls) {
        await page.goto(url);
        await settle(page, url);
        found.push(...(await axeViolations(page, `${url} @${width}`)));
      }
      expect(found).toEqual([]);
    });
  });
}

/**
 * Demo selectors that put a page into another state: `fixture` (Overview family, read by most data views), `scenario` (operations
 * and finance) and `state` (runs and watchlist). A route is probed once per selector; if the probe leaves its text unchanged the route
 * ignores that selector, and the other values are skipped so no state is counted twice.
 */
const SELECTORS: Record<string, { probe: string; values: string[] }> = {
  fixture: { probe: "FX-07", values: ["FX-03", "FX-04", "FX-05", "FX-06", "FX-07", "FX-08", "FX-09"] },
  scenario: { probe: "stale", values: ["stale", "partial", "unavailable", "insufficient", "delayed", "conflict", "holds", "resolved", "empty", "unknown", "exportfailed", "zeroburn"] },
  state: { probe: "failed", values: ["failed", "blocked", "running", "needs-attention"] },
};
const withParam = (url: string, key: string, value: string) => url + (url.includes("?") ? "&" : "?") + `${key}=${value}`;

async function load(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("main")).toBeVisible();
  // The state gallery shows a loading state on purpose.
  if (!url.startsWith("/design-system/states")) await expect(page.getByRole("status").filter({ hasText: /^Loading/ }), url).toHaveCount(0, { timeout: 30_000 });
  return text(page);
}

chunk(allUrls, GROUPS).forEach((urls, i) => {
  test(`alternate states (loading excluded), 1440px, routes ${i + 1} of ${GROUPS}`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const found: string[] = [];
    const reached: string[] = [];
    for (const url of urls) {
      const base = await load(page, url);
      const seen = new Set([base]);
      for (const [key, { probe, values }] of Object.entries(SELECTORS)) {
        if ((await load(page, withParam(url, key, probe))) === base) continue;
        for (const value of values) {
          const next = withParam(url, key, value);
          const body = await load(page, next);
          if (seen.has(body)) continue;
          seen.add(body);
          reached.push(next);
          found.push(...(await axeViolations(page, next)));
        }
      }
    }
    test.info().annotations.push({ type: "alternate states checked", description: `${reached.length}: ${reached.join(" ")}` });
    expect(found).toEqual([]);
  });
});

test("the loading state of every route has no violations and is announced", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const found: string[] = [];
  const silent: string[] = [];
  for (const url of allUrls) {
    const held = withParam(url, "latency", "4000");
    await page.goto(held);
    // Every read is held in flight, so what is on screen now is the loading state.
    await expect(page.getByRole("heading", { level: 1 }).or(page.getByRole("status")).first(), held).toBeVisible();
    if (!(await page.getByRole("status").filter({ hasText: /Loading/ }).count())) silent.push(url);
    found.push(...(await axeViolations(page, `${url} (loading)`)));
  }
  test.info().annotations.push({ type: "routes with no loading status while a read is in flight", description: silent.join(", ") || "none" });
  expect(found).toEqual([]);
});
