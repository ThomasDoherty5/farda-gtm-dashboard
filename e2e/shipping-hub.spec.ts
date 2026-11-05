import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const route = "/operations?view=hub";
test("shared shipping queue and exact review remain accessible without dispatch", async ({ page }, info) => {
  await page.goto(route);
  await expect(page.getByRole("heading", { name: "Shipping hub", exact: true })).toBeVisible();
  const mobile = info.project.name.startsWith("mobile");
  await expect(page.getByRole("checkbox", { name: "Select DEMO-SHIP-C018", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Select DEMO-SHIP-1042", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: mobile ? "Review selected labels" : "Review 2 selected", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The repository's axe dependency resolves a separate playwright-core Page type.
  const before = await new AxeBuilder({ page: page as never }).analyze();
  expect(before.violations).toEqual([]);
  await page.screenshot({ path: `.handoff/figma/shipping-${mobile ? "mobile" : "desktop"}-implementation.png`, fullPage: true });
  await page.getByRole("button", { name: mobile ? "Review selected labels" : "Review 2 selected", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review label proposals" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("2 selected · 1 reviewable · 1 blocked");
  await expect(review.getByRole("button", { name: "Purchase unavailable" })).toHaveAttribute("aria-disabled", "true");
  await review.getByRole("button", { name: "Preview approval draft" }).click();
  await expect(review.getByRole("region", { name: "Approval draft preview" })).toContainText("Draft preview · not submitted");
  expect((await new AxeBuilder({ page: page as never }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(review).not.toBeVisible();
});

test("mobile filters and desktop filters keep typed creator records discoverable", async ({ page }, info) => {
  await page.goto(route);
  if (info.project.name.startsWith("mobile")) {
    await page.getByRole("button", { name: "Filter shipments", exact: true }).click();
    const filters = page.getByRole("dialog", { name: "Filter shipments" });
    await filters.getByLabel("Recipient", { exact: true }).selectOption("creator");
    await filters.getByRole("button", { name: "Show 3 shipments" }).click();
  } else await page.getByRole("link", { name: "Creators · 3", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search shipments" }).fill("C020");
  await expect(page.getByText(/Showing 1 of 1/)).toBeVisible();
  await page.getByRole("button", { name: info.project.name.startsWith("mobile") ? "View shipment" : "Open creator details", exact: true }).click();
  const creator = page.getByRole("dialog", { name: "Creator shipment" });
  await expect(creator).toContainText("Posting deadline · read-only");
  await expect(creator).toContainText("DEMO-CLOCK-C020");
  await expect(creator).toContainText("no commerce order");
  expect(await creator.evaluate(el => el.getBoundingClientRect().width <= innerWidth)).toBe(true);
});
