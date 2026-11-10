import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = [
  "/finance",
  "/finance?scenario=insufficient",
  "/finance?scenario=zeroburn",
  "/finance?scenario=zeroorders",
  "/finance?scenario=subscriptionunread",
  "/finance/close/2026-10",
  "/finance/close/2026-10?scenario=exportfailed",
  "/analytics/finance",
  "/analytics/finance?scenario=insufficient",
];

test.describe("finance dashboard, close and analytics against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  for (const [node, url, height] of [
    ["7:510", "/finance", 1707],
    ["7:683", "/finance/close/2026-10", 1471],
    ["12:1006", "/analytics/finance", 1313],
  ] as const) {
    test(`${url} is ${height}px tall like ${node}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 400 });
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    });
  }

  test("the close status rows are 40px apart, as in 7:683", async ({ page }) => {
    await page.goto("/finance/close/2026-10");
    const rows = page.locator('dl[aria-label="Close status"] > div');
    await expect(rows).toHaveCount(3);
    const y = async (i: number) => Math.round((await rows.nth(i).boundingBox())!.y);
    expect((await y(1)) - (await y(0))).toBe(40);
    expect((await y(2)) - (await y(1))).toBe(40);
  });

  test("the cost bars start at the top of their rows, as in 12:1006", async ({ page }) => {
    await page.goto("/analytics/finance");
    const row = page.locator('ul[aria-label="Order contribution breakdown"] > li').first();
    await expect(row).toBeVisible();
    const top = (await row.boundingBox())!.y;
    const track = (await row.locator(":scope > span").nth(1).boundingBox())!.y;
    expect(Math.round(track - top)).toBe(0);
  });

  test("the cash chart puts $46,200 where 20:409 does", async ({ page }) => {
    await page.goto("/analytics/finance");
    const svg = page.getByRole("img", { name: /Observed cash fell/ });
    await expect(svg).toBeVisible();
    const dot = svg.locator("circle");
    expect(await dot.getAttribute("cx")).toBe("420");
    expect(Number(await dot.getAttribute("cy"))).toBeCloseTo(94.8, 1);
  });
});

for (const url of ROUTES) {
  test(`no accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("no horizontal overflow at 320px on the finance dashboard, close and analytics", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const url of ROUTES) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), url).toBeLessThanOrEqual(0);
  }
});

test("the section navigation moves between the finance screens and keeps Back working", async ({ page }) => {
  await page.goto("/finance");
  await page.getByRole("navigation", { name: "Finance sections" }).getByRole("link", { name: "Month-end" }).click();
  await expect(page).toHaveURL(/\/finance\/close\/2026-10/);
  await expect(page.getByTestId("metric-Close progress")).toHaveText("4 / 7");
  await page.goBack();
  await expect(page.getByTestId("metric-Cash balance")).toBeVisible();
});

test("unit economics explain CAC payback, and the definitions dialog states them as proposed with no axe violations", async ({ page }) => {
  await page.goto("/finance");
  await expect(page.getByTestId("unit-economics")).toContainText("1.76 orders · Provisional · Creator costs partly allocated · Attribution coverage incomplete");
  await expect(page.getByTestId("subscription-state")).toHaveText("No subscription revenue");
  const trigger = page.getByRole("button", { name: "View metric definitions" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Metric definitions" });
  await expect(dialog).toContainText("Proposed · finance-unit-economics@1 · not adopted");
  await expect(dialog).toContainText("N/A · pilot cohort only; see the commission ledger");
  const results = await new AxeBuilder({ page: page as never }).include("dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("opening the reconciliation is read only and returns focus", async ({ page }) => {
  await page.goto("/finance/close/2026-10");
  const trigger = page.getByRole("button", { name: "Open reconciliation" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "October reconciliation" });
  await expect(dialog).toContainText("does not close the books");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
