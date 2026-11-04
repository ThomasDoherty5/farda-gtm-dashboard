import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

test.describe("full acquisition pipeline against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    return { x: Math.round(b!.x), y: Math.round(b!.y), w: Math.round(b!.width), h: Math.round(b!.height) };
  };

  test("panels, funnel bars and cards sit where 102:74 puts them", async ({ page }) => {
    await page.goto("/creators/pipeline");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId("metric-Confirmed invitations")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(2552);
    const kpi = (label: string) => page.getByTestId(`metric-${label}`).locator("xpath=ancestor::dl[1]");
    expect(await box(kpi("Confirmed invitations"))).toMatchObject({ x: 72, y: 486, w: 312, h: 170 });
    expect(await box(page.getByTestId("funnel"))).toMatchObject({ x: 72, w: 1296, h: 614 });
    // Bars share one scale: 120 -> 220px, so every count is count * 11/6 px tall.
    const chart = page.getByTestId("funnel-discovered").locator("xpath=ancestor::div[1]");
    const origin = await box(chart);
    expect(origin.w).toBe(1248);
    for (const [key, count] of [["discovered", 120], ["qualified", 72], ["confirmedSent", 54], ["retained", 12]] as const) {
      const bar = await box(page.getByTestId(`funnel-${key}`).locator("span").first());
      expect(bar.h).toBe(Math.round((count * 220) / 120));
      expect(bar.y + bar.h).toBe(origin.y + 272);
      expect(bar.w).toBe(104);
    }
    expect(await box(page.getByTestId("stage-Video review").locator("xpath=ancestor::dl[1]"))).toMatchObject({ h: 152 });
    expect(await box(page.getByRole("link", { name: "Reconcile uncertain sends" }))).toMatchObject({ w: 242, h: 44 });
    await expect(page.getByRole("link", { name: "Pipeline" })).toHaveCSS("background-color", "rgb(240, 236, 255)");
  });
});

test("the source filter survives a reload and Back", async ({ page }) => {
  await page.goto("/creators/pipeline");
  await page.getByRole("button", { name: "Source: Both" }).click();
  await page.getByRole("radio", { name: "Social Cat" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/source=social-cat/);
  await expect(page.getByTestId("metric-Confirmed invitations")).toHaveText("27");
  await page.reload();
  await expect(page.getByRole("button", { name: "Source: Social Cat" })).toBeVisible();
  await expect(page.getByTestId("metric-Confirmed invitations")).toHaveText("27");
  await page.goBack();
  await expect(page.getByRole("button", { name: "Source: Both" })).toBeVisible();
  await expect(page.getByTestId("metric-Confirmed invitations")).toHaveText("54");
});

test("Inspect cohort traps focus and returns it on close", async ({ page }) => {
  await page.goto("/creators/pipeline");
  const trigger = page.getByRole("button", { name: "Inspect cohort" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Inspect cohort" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("table", { name: "Achievement counts by stage" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("the funnel scrolls inside a focusable region on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/creators/pipeline");
  const region = page.getByRole("region", { name: /Opportunity cohort funnel/ });
  await region.focus();
  await expect(region).toBeFocused();
  expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

for (const url of ["/creators/pipeline", "/creators/pipeline?source=tiktok-shop&network=instagram", "/creators/pipeline?route=inbound&policy=policy-2026-10"]) {
  test(`no accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId("metric-Confirmed invitations")).toBeVisible();
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("no accessibility violations with the cohort dialog open", async ({ page }) => {
  await page.goto("/creators/pipeline");
  await page.getByRole("button", { name: "Inspect cohort" }).click();
  await expect(page.getByRole("dialog", { name: "Inspect cohort" })).toBeVisible();
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("no horizontal overflow at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/creators/pipeline");
  await expect(page.getByTestId("metric-Confirmed invitations")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("terminal paths and branches: deep link, axe, and no 320px overflow", async ({ page }) => {
  await page.goto("/creators/pipeline?view=branches");
  await expect(page.getByRole("heading", { name: "Closed paths and optional branches." })).toBeVisible();
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("the pipeline links to its paths and back", async ({ page }) => {
  await page.goto("/creators/pipeline");
  await page.getByRole("link", { name: "Paths and branches" }).click();
  await expect(page).toHaveURL(/view=branches/);
  await page.getByRole("link", { name: "Back to pipeline" }).click();
  await expect(page.getByTestId("metric-Confirmed invitations")).toBeVisible();
});
