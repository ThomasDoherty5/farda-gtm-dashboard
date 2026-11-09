import { expect, test } from "@playwright/test";

test("complete fictional commerce and performance source layouts remain available for private original comparison", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440", "Original source canvas is 1440 px; responsive journeys are covered separately.");
  for (const source of [
    { name: "commerce", path: "/analytics/customer-journey", heading: "Watch the journey after the click." },
    { name: "performance", path: "/analytics/attribution", heading: "Every dollar, in perspective." },
  ]) {
    await page.goto(source.path); await expect(page.getByRole("heading", { name: source.heading, exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`traffic-original-layout-demo-${source.name}.png`), fullPage: true });
  }
});
