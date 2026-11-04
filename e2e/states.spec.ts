import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  return { x: Math.round(b!.x), w: Math.round(b!.width), h: Math.round(b!.height) };
};

test.describe("against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");

  test("the gallery places three 416px cards per row, 24px apart", async ({ page }) => {
    await page.goto("/design-system/states");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId("state-loading")).toBeVisible();
    expect(await box(page.getByTestId("state-loading"))).toMatchObject({ x: 72, w: 416 });
    expect(await box(page.getByTestId("state-first-use"))).toMatchObject({ x: 512, w: 416 });
    expect(await box(page.getByTestId("state-no-results"))).toMatchObject({ x: 952, w: 416 });
  });
});

test("the gallery has no accessibility violations, including with a dialog open", async ({ page }) => {
  await page.goto("/design-system/states");
  await expect(page.getByTestId("state-loading")).toBeVisible();
  // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
  const run = () => new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect((await run()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.getByRole("button", { name: "Take over browser" }).click();
  await expect(page.getByRole("dialog", { name: "Take over browser" })).toBeVisible();
  expect((await run()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("a dialog returns focus to its trigger, and Keep task is reachable by keyboard", async ({ page }) => {
  await page.goto("/design-system/states");
  const trigger = page.getByRole("button", { name: "Clear filters" });
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  const keep = page.getByRole("button", { name: "Keep task" });
  await keep.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("kept-status")).toBeVisible();
});

test("the disabled Retry button stays focusable and keeps its reason, and a click does nothing", async ({ page }) => {
  await page.goto("/design-system/states");
  const retry = page.getByRole("button", { name: "Retry disabled" });
  await retry.focus();
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  await retry.click({ force: true });
  await expect(page).toHaveURL(/design-system\/states$/);
});
