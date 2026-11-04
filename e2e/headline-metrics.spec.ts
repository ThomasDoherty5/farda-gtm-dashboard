import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("headline acquisition metrics", () => {
  test("definitions and calculation evidence open from the attribution page", async ({ page }) => {
    await page.goto("/analytics/attribution");
    await expect(page.getByTestId("metric-cac")).toContainText("$25.00");
    await expect(page.getByTestId("metric-mer")).toContainText("1.80×");
    await page.getByRole("button", { name: "Metric definitions" }).click();
    const dict = page.getByTestId("metric-dictionary");
    await expect(dict).toContainText("headline-metrics@1");
    await expect(dict.getByTestId("definition-blendedCac")).toContainText("Refunds:");
    await expect(dict.locator('[data-case="normal"]')).toContainText("CAC $25.00");
    await expect(dict.locator('[data-case="unknown-spend"]')).toContainText("CAC N/A · an input is unknown");
    await expect(dict.locator('[data-case="refund"]')).toContainText("MER 1.79×");
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dict).toBeHidden();
  });

  test("the CAC versus contribution comparison states its bases and shows no gap", async ({ page }) => {
    await page.goto("/analytics/attribution");
    await expect(page.getByTestId("cac-basis-note")).toContainText("not a profit per customer");
    await expect(page.getByText("Different bases")).toBeVisible();
    await expect(page.getByText(/\bgap\b/)).toHaveCount(0);
  });
});
