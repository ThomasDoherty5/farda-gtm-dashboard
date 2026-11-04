import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PAGES = [
  { name: "Content monitor", path: "/content", source: "23:73", height: 1880, ready: "Creator content, without the blind spots." },
  { name: "Watchlist", path: "/creators/watchlist", source: "25:166", height: 1671, ready: "Know who the agent is watching." },
  { name: "Hourly run", path: "/runs/demo-run-hourly", source: "25:307", height: 1791, ready: "Every hourly check leaves evidence." },
  { name: "Post performance", path: "/content/P-001", source: "25:481", height: 1364, ready: "One post. Its evidence and impact." },
] as const;

test.describe("monitoring screens against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  for (const p of PAGES) {
    test(`${p.name} (${p.source}) is the design's height`, async ({ page }) => {
      await page.goto(p.path);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("heading", { name: p.ready })).toBeVisible();
      await expect(page.getByTestId(/^metric-/).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(p.height);
    });
  }

  test("the daily view bars use one scale, 180px for the tallest", async ({ page }) => {
    await page.goto("/content/P-001");
    await page.evaluate(() => document.fonts.ready);
    const bars = page.locator("[class*=barCol] > [class*=bar]");
    await expect(bars).toHaveCount(11);
    const heights = [];
    for (let i = 0; i < 11; i++) heights.push(Math.round((await bars.nth(i).boundingBox())!.height));
    expect(heights).toEqual([11, 21, 32, 42, 53, 64, 85, 106, 127, 169, 180]);
  });
});

test.describe("accessibility", () => {
  for (const p of PAGES) {
    test(`${p.name} has no axe violations`, async ({ page }) => {
      await page.goto(p.path);
      await expect(page.getByRole("heading", { name: p.ready })).toBeVisible();
      const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });
  }
});

test("the monitor's network filter and search survive a reload and Back", async ({ page }) => {
  await page.goto("/content");
  await page.getByRole("button", { name: "All post networks" }).click();
  await page.getByRole("radio", { name: "Instagram" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/network=instagram/);
  await expect(page.getByText(/Showing 1 of 5 posts/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Instagram" }).first()).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "All post networks" })).toBeVisible();
});

test("a search with no match is not shown as zero posts", async ({ page }) => {
  await page.goto("/content");
  await page.getByRole("searchbox", { name: "Search handle or post" }).fill("nobody");
  await expect(page).toHaveURL(/q=nobody/);
  await expect(page.getByText(/isn't zero posts/)).toBeVisible();
});

test("retrying the failed profile is blocked and nothing is shown as retried", async ({ page }) => {
  await page.goto("/runs/demo-run-hourly");
  await page.getByRole("button", { name: "Retry failed profile" }).click();
  await expect(page.getByText(/Not retried: @everyday\.lee needs its source session reconnected first/)).toBeVisible();
});

test("post GMV is stated apart from net sales, and a missing GMV is unknown, not zero", async ({ page }) => {
  await page.goto("/content/P-001");
  await expect(page.getByTestId("metric-net-sales")).toHaveText("$2,015");
  await expect(page.getByTestId("gmv-note")).toContainText("TikTok-reported GMV $3,100");
  await expect(page.getByTestId("gmv-note")).toContainText("never relabeled as net sales");
  await page.goto("/content/P-003");
  await expect(page.getByTestId("gmv-note")).toContainText("unknown, not $0");
  await expect(page.getByTestId("metric-net-sales")).toHaveText("$995");
});
