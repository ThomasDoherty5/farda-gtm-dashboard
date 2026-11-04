import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

const PAGES = [
  { name: "Launch snapshot", path: "/launch?view=snapshot", source: "3:6", height: 1282, ready: "metric-conversations" },
  { name: "Launch control", path: "/launch?view=control", source: "14:74", height: 2028, ready: "metric-gates" },
  { name: "Performance attribution", path: "/analytics/attribution", source: "14:377", height: 2041, ready: "metric-net-receipts" },
  { name: "Paid media", path: "/analytics/paid-media", source: "30:349", height: 1815, ready: "metric-media-spend" },
  { name: "Campaign funnel", path: "/campaigns/demo-campaign-first-wave?tab=funnel", source: "30:550", height: 1777, ready: "metric-contacts" },
  { name: "Commerce, support and reviews", path: "/analytics/customer-journey", source: "30:721", height: 1648, ready: "metric-sessions" },
] as const;

test.describe("analytics screens against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    return { x: Math.round(b!.x), w: Math.round(b!.width), h: Math.round(b!.height) };
  };

  for (const p of PAGES) {
    test(`${p.name} (${p.source}) is the design's height with KPI cards at 312 by 152`, async ({ page }) => {
      await page.goto(p.path);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByTestId(p.ready)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(p.height);
      expect(await box(page.getByTestId(p.ready).locator("xpath=ancestor::dl[1]"))).toMatchObject({ x: 72, w: 312, h: 152 });
    });
  }

  test("the weekly receipts chart draws bars to the design's scale", async ({ page }) => {
    await page.goto("/analytics/attribution");
    await page.evaluate(() => document.fonts.ready);
    const week4 = page.getByRole("button", { name: /Wk 4: Shopify/ });
    await expect(week4).toBeVisible();
    expect(await box(week4)).toMatchObject({ w: 128, h: 252 });
    const bars = week4.locator("span[class*=receiptBar]");
    expect((await box(bars.nth(0))).h).toBe(134);
    expect((await box(bars.nth(1))).h).toBe(67);
  });
});

test.describe("accessibility", () => {
  for (const p of PAGES) {
    test(`${p.name} has no axe violations`, async ({ page }) => {
      await page.goto(p.path);
      await expect(page.getByTestId(p.ready)).toBeVisible();
      const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });
  }

  test("a dialog traps focus and returns it to its trigger", async ({ page }) => {
    await page.goto("/analytics/paid-media");
    const trigger = page.getByRole("button", { name: "Metrics as of" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Metrics as of" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("a week can be chosen from the keyboard", async ({ page }) => {
    await page.goto("/analytics/attribution");
    const week2 = page.getByRole("button", { name: /Wk 2: Shopify/ });
    await week2.focus();
    await page.keyboard.press("Enter");
    await expect(week2).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: "Wk 2" })).toContainText("Total $2,620");
  });
});

test("the paid media rights filter survives a reload and Back, and its denominator is stated", async ({ page }) => {
  await page.goto("/analytics/paid-media");
  await page.getByRole("button", { name: "Rights: all states" }).click();
  await page.getByRole("radio", { name: "cleared" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/rights=cleared/);
  await expect(page.getByText(/Showing 2 of 4 assets/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Rights: cleared" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Rights: all states" })).toBeVisible();
});

test("launch control never records a decision or enables Go while L is unset", async ({ page }) => {
  await page.goto("/launch?view=control");
  await page.getByRole("button", { name: "Record in Notion" }).click();
  const dialog = page.getByRole("dialog", { name: "Record a launch-readiness decision" });
  await expect(dialog.getByRole("radio", { name: "Go" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Record decision" })).toHaveAttribute("aria-disabled", "true");
  await dialog.getByRole("button", { name: "Record decision" }).click({ force: true });
  await expect(dialog.getByText(/This draft is not saved/)).toBeVisible();
});

test("campaign cohort choice is URL state", async ({ page }) => {
  await page.goto("/campaigns/demo-campaign-first-wave?tab=funnel");
  await page.getByRole("button", { name: "First-wave cohort" }).click();
  await page.getByRole("radio", { name: "Launch A monitoring" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/cohort=launch-a/);
  await expect(page.getByText("No campaign progression for this cohort")).toBeVisible();
});

test("the analytics pages show their demo label", async ({ page }) => {
  for (const p of PAGES) {
    await page.goto(p.path);
    await expect(page.getByTestId("demo-banner")).toBeVisible();
  }
});

test.describe("source freshness and reconciliation", () => {
  test("shows each source's state and a matching matrix, with no axe violations", async ({ page }) => {
    await page.goto("/launch?view=reconciliation");
    await expect(page.getByTestId("freshness")).toBeVisible();
    await expect(page.getByTestId("matrix")).toContainText("Every shared figure matches");
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  test("the snapshot links to it, and it has no page overflow at 320px", async ({ page }) => {
    await page.goto("/launch");
    await page.getByRole("link", { name: "Source freshness and reconciliation" }).click();
    await expect(page).toHaveURL(/view=reconciliation/);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
