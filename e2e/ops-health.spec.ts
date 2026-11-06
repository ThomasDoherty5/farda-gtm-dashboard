import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const URL = "/analytics/fulfillment?view=health";

test("health view shows the derived figures and never presents an unknown outcome as success", async ({ page }) => {
  await page.goto(URL);
  await expect(page.getByRole("heading", { level: 1, name: "Issues and fulfillment health" })).toBeVisible();
  await expect(page.getByTestId("health-notice")).toContainText("no Figma source");
  await expect(page.getByTestId("metric-Order to shipped")).toContainText("1.2 days");
  await expect(page.getByTestId("metric-Shipped to delivered")).toContainText("3.4 days");
  await expect(page.getByTestId("metric-Shipping cost per order")).toContainText("$6.85");
  await expect(page.getByTestId("health-by-home").getByRole("row", { name: /Home H2/ })).toContainText("1.4 days");
  const exceptions = page.getByTestId("order-exceptions-table");
  await expect(exceptions.getByRole("row", { name: /TEST-SH-1048/ })).toContainText("Label uncertain");
  await expect(exceptions.getByRole("row", { name: /TEST-SH-1048/ })).toContainText("not shipped");
  await expect(exceptions.getByText("Delivered", { exact: true })).toHaveCount(0);
});

test("an exception order opens the same order the Operations screens use", async ({ page }) => {
  await page.goto(URL);
  await page.getByTestId("order-exceptions-table").getByRole("link", { name: "TEST-SH-1031" }).click();
  await expect(page).toHaveURL(/\/orders\/TEST-SH-1031$/);
  await expect(page.getByText("Shipment marked lost").first()).toBeVisible();
  await expect(page.getByText(/Not delivered\. The carrier reported it lost/)).toBeVisible();
});

test("the Figma-measured fulfillment overview is unchanged without the health view", async ({ page }) => {
  await page.goto("/analytics/fulfillment");
  await expect(page.getByTestId("metric-Orders shipped")).toContainText("329");
  await expect(page.getByTestId("health-notice")).toHaveCount(0);
});

test("no accessibility violations on the health view", async ({ page }) => {
  await page.goto(URL);
  await expect(page.getByTestId("metric-Order to shipped")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("no horizontal overflow at 320px on the health view", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(URL);
  await expect(page.getByTestId("metric-Order to shipped")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("the Operations page links to the health view", async ({ page }) => {
  const viewport = page.viewportSize()!;
  const widths = viewport.width >= 1180 ? [viewport.width, 1024] : [viewport.width];
  for (const width of widths) {
    await page.setViewportSize({ ...viewport, width });
    await page.goto("/operations");

    let navigation = page.getByRole("main");
    if (width < 1180) {
      const menu = page.getByRole("button", { name: width < 768 ? "Menu" : "More", exact: true });
      await menu.focus();
      await page.keyboard.press("Enter");
      navigation = page.getByRole("dialog").getByRole("navigation", { name: "Operations home and health" });
    }
    const link = navigation.getByRole("link", { name: "Issues and fulfillment health", exact: true });
    await expect(link).toHaveAttribute("href", URL);
    await link.click();
    await expect(page).toHaveURL(/\/analytics\/fulfillment\?view=health$/);
    await expect(page.getByRole("heading", { level: 1, name: "Issues and fulfillment health" })).toBeVisible();
  }
});
