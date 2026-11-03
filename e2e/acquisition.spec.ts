import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

test.describe("daily sourcing against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    return { x: Math.round(b!.x), w: Math.round(b!.width), h: Math.round(b!.height) };
  };

  test("panels and controls sit where 102:555 puts them", async ({ page }) => {
    await page.goto("/creators/discovery");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId("metric-Schedule")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(2065);
    expect(await box(page.getByTestId("metric-Schedule").locator("xpath=ancestor::dl[1]"))).toMatchObject({ x: 72, h: 152 });
    expect(await box(page.getByRole("button", { name: /Sources:/ }))).toMatchObject({ x: 72, w: 252, h: 44 });
    expect(await box(page.getByRole("button", { name: "Preview sample batch" }))).toMatchObject({ w: 220, h: 44 });
    expect(await box(page.getByRole("link", { name: "Daily sourcing" }))).toMatchObject({ w: 130, h: 44 });
    await expect(page.getByRole("link", { name: "Daily sourcing" })).toHaveCSS("background-color", "rgb(240, 236, 255)");
  });
});

test("filters survive a reload and Back", async ({ page }) => {
  await page.goto("/creators/discovery");
  await page.getByRole("button", { name: /Sources:/ }).click();
  await page.getByRole("radio", { name: "Social Cat" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/sources=social-cat/);
  await page.reload();
  await expect(page.getByRole("button", { name: "Sources: Social Cat" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Sources: SC + TikTok Shop" })).toBeVisible();
});

test("the batch dialog traps focus and returns it on close", async ({ page }) => {
  await page.goto("/creators/discovery");
  const trigger = page.getByRole("button", { name: "Preview sample batch" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: /Approved finite batch/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const url of ["/creators/discovery", "/creators/discovery?sources=tiktok-shop"]) {
  test(`no accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId("metric-Schedule")).toBeVisible();
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("no horizontal overflow at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/creators/discovery");
  await expect(page.getByTestId("metric-Schedule")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
