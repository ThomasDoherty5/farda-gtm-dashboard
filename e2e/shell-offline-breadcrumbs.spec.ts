import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("going offline mid-session says so, keeps nothing misleading, and recovers when the browser reconnects", async ({ page, context }) => {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId("offline-banner")).toContainText("You're offline");
  await page.getByRole("link", { name: "Finance", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "You're offline" })).toHaveCount(0);
  await expect(page.getByRole("main")).toContainText(/Gross profit|profit/i);
});

test("a write made offline is refused and says nothing was sent", async ({ page, context }) => {
  await page.goto("/approvals/demo-approval-exact");
  await expect(page.getByTestId("approval-status")).toContainText("Pending");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Approve this version" }).click();
  await expect(page.getByTestId("action-error")).toContainText("Nothing was sent");
  await expect(page.getByTestId("approval-status")).toContainText("Pending");
  await context.setOffline(false);
});

test("breadcrumbs name the section, page and record, and have no axe violations", async ({ page }) => {
  await page.goto("/orders/TEST-SH-1042");
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toContainText("Operations");
  await expect(crumbs).toContainText("Order detail");
  await expect(crumbs.locator("[aria-current=page]")).toHaveText("TEST-SH-1042");
  await expect(crumbs.getByRole("link")).toHaveCount(0);
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("the breadcrumb adds no height: the header is the same size on a page with and without a record", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1440, "Header height is measured at the design width");
  const heights: number[] = [];
  for (const path of ["/overview", "/orders/TEST-SH-1042", "/finance"]) {
    await page.goto(path);
    heights.push(await page.locator("header").first().evaluate((el) => Math.round(el.getBoundingClientRect().height)));
  }
  expect(new Set(heights).size).toBe(1);
});
