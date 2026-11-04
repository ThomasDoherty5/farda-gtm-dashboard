import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { sourceScreens } from "../src/routes/manifest.generated";
import { openSection } from "./support/nav";

/** Fails the test on any console error or unhandled rejection in the page. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

const concrete = (path: string) => path.replace(/:(\w+)/g, "demo-$1");

test("Overview renders the labeled demo dataset", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
  await expect(page.getByTestId("metric-Net receipts")).toHaveText("$12,596");
  await expect(page.getByTestId("metric-Engagement rate")).toHaveText("5.0%");
  expect(errors).toEqual([]);
});

test("every manifest route deep-links and survives a refresh", async ({ page }) => {
  test.slow();
  const errors = watchErrors(page);
  const urls = [...new Set(sourceScreens.map((s) => concrete(s.path) + (Object.keys(s.query).length ? `?${new URLSearchParams(s.query)}` : "")))];
  for (const url of urls) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 }), url).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Back and Forward restore the route", async ({ page }) => {
  await page.goto("/overview");
  await openSection(page, "Finance");
  await expect(page).toHaveURL(/\/finance$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
  await page.goForward();
  await expect(page).toHaveURL(/\/finance$/);
});

test("selecting the current section adds no history entry (CTRL-220)", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
  const before = await page.evaluate(() => history.length);
  await openSection(page, "Overview");
  expect(await page.evaluate(() => history.length)).toBe(before);
});

test("the skip link moves focus past the navigation", async ({ page }) => {
  await page.goto("/overview");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

for (const [fixture, heading] of [
  ["FX-03", "No matching records"],
  ["FX-08", "No access to this account"],
  ["FX-09", "Sign in again"],
] as const) {
  test(`${fixture} renders "${heading}"`, async ({ page }) => {
    await page.goto(`/overview?fixture=${fixture}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByTestId("metric-Paid orders")).toHaveCount(0);
  });
}

test("the page does not overflow horizontally at 320px (WCAG reflow)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const url of ["/overview", "/finance", "/creators"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
});

for (const url of ["/overview", "/overview?fixture=FX-04", "/overview?fixture=FX-08", "/finance", "/operations"]) {
  test(`no automatically detectable accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
