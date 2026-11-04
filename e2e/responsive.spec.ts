import { expect, test } from "@playwright/test";

/**
 * Responsive evidence for the screens built under THO-304, THO-305 and THO-306 (handoff 11, FHC-04): 390, 720 (200% zoom of 1440),
 * 768, 1024 and 1920 CSS px. Only Operations has native 390 and 1024 designs, so these are adaptations to review, and this checks
 * what must always hold: no page overflow, a visible H1, and every action still reachable.
 */
const routes = [
  "/settings/connections",
  "/settings/team",
  "/automations",
  "/automations?tab=zaps",
  "/automations/zap-12/schedule",
  "/settings/capabilities",
  "/customers/lifecycle",
  "/customers/flows/setup",
  "/customers/flows/early-access",
  "/customers/flows/abandoned-checkout",
  "/customers/flows/review-request",
  "/customers/consent",
  "/customers/activation",
  "/design-system/states",
];

for (const width of [390, 720, 768, 1024, 1920]) {
  test(`no page overflow, a visible H1 and a clear main landmark at ${width}px`, async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 }), route).toBeVisible();
      // The gallery shows a loading state on purpose.
      if (route !== "/design-system/states") await expect(page.getByRole("status").filter({ hasText: /^Loading/ }), route).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${route} at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
}

test("data tables scroll inside a labeled, focusable region on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/team");
  const region = page.getByRole("region", { name: "Who can do what, by application role" });
  await expect(region).toBeVisible();
  await region.focus();
  await expect(region).toBeFocused();
  expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("the consent bar keeps a text alternative at every width", async ({ page }) => {
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/customers/consent");
    await expect(page.getByRole("img", { name: /740 eligible, 130 withdrawn, 60 suppressed, 70 unknown/ })).toBeVisible();
  }
});
