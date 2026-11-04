import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { allDemoRoutes } from "../src/test/demoRoutes";

/**
 * Contract states in a real browser (fixtures FX-01 to FX-15 and the control contract's state rows). The unit matrix
 * (src/routes/contractStates.test.tsx) drives every route with injected faults; this spec proves the parts only a built
 * bundle can: the live adapter with nothing connected on every route, and the named fixtures on the routes that read them.
 */
const livePort = Number(process.env.E2E_PORT ?? 4173) + 1;
const DATA = "table, dl, [data-testid^='metric-'], [role='img']";
const dataCount = (page: Page) => page.locator("main").locator(DATA).count();
const mainText = (page: Page) => page.locator("main").innerText();

test.describe("integration-pending: the live adapter, with nothing connected", () => {
  test.use({ baseURL: `http://localhost:${livePort}` });

  for (const route of allDemoRoutes().filter((r) => r !== "/design-system/states")) {
    test(`${route} says nothing is connected, and shows no demo data`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(route);
      await expect(page.getByRole("alert").first()).toBeVisible();
      await expect(page.getByRole("alert").first()).toContainText(/not connected|unavailable/i);
      expect(await dataCount(page), "protected data is on the page").toBe(0);
      await expect(page.getByTestId("demo-banner")).toHaveCount(0);
      expect(await mainText(page)).not.toMatch(/Demo data|synthetic demo|@demo\.creator/i);
      expect(errors).toEqual([]);
    });
  }

  test("the failure states have no accessibility violations", async ({ page }) => {
    for (const route of ["/overview", "/finance", "/operations", "/creators/pipeline"]) {
      await page.goto(route);
      await expect(page.getByRole("alert").first()).toBeVisible();
      const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations, route).toEqual([]);
    }
  });
});

test.describe("named fixtures on the routes that read them", () => {
  const ROUTES = ["/overview", "/analytics/attribution", "/analytics/paid-media", "/analytics/customer-journey", "/content", "/creators/watchlist"];
  const CASES: [string, RegExp][] = [
    ["FX-03", /nothing|\bempty\b|no matching|no .{0,30}(data|records?)/i],
    ["FX-05", /missing|partial|incomplete|covers? only|showing \d+ of|not all/i],
    ["FX-06", /out of date|\bstale\b|\bbehind\b|not current|last successful/i],
  ];
  for (const route of ROUTES) {
    for (const [fixture, says] of CASES) {
      test(`${route}?fixture=${fixture} says so in words`, async ({ page }) => {
        await page.goto(`${route}${route.includes("?") ? "&" : "?"}fixture=${fixture}`);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await expect.poll(() => mainText(page)).toMatch(says);
      });
    }
    for (const [fixture, says] of [["FX-08", /no access|permission/i], ["FX-09", /sign in/i]] as const) {
      test(`${route}?fixture=${fixture} says so and shows no protected data`, async ({ page }) => {
        await page.goto(`${route}${route.includes("?") ? "&" : "?"}fixture=${fixture}`);
        await expect(page.getByRole("alert").first()).toBeVisible();
        await expect.poll(() => mainText(page)).toMatch(says);
        expect(await dataCount(page)).toBe(0);
        // A failed read is not still loading.
        await expect(page.locator("main").getByText(/^Loading/)).toHaveCount(0);
      });
    }
  }
});

test("every route labels demo data", async ({ page }) => {
  for (const route of allDemoRoutes()) {
    await page.goto(route);
    await expect(page.getByTestId("demo-banner"), route).toContainText(/demo/i);
  }
});
