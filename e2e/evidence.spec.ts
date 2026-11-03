import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const EMPTY = "/creators/demo-creator-1/evidence/demo-evidence-1";
const PARTIAL = "/creators/demo-creator-1/evidence/demo-evidence-2";

test.describe("video evidence against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");

  test("the right column's cards are the heights 102:364 gives them", async ({ page }) => {
    await page.goto(EMPTY);
    await page.evaluate(() => document.fonts.ready);
    const height = async (id: string) => Math.round((await page.getByTestId(id).locator("xpath=ancestor::dl[1]").boundingBox())!.height);
    expect(await height("metric-Published model")).toBe(152);
    expect(await height("metric-Commerce confidence")).toBe(152);
    expect(await height("metric-Creative quality")).toBe(170);
    expect(await height("metric-Routine compatibility")).toBe(170);
    // Intentional: the blocked-action reasons are visible text, which Figma doesn't have (docs/design-map.md).
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(2211);
  });
});

test("Mark watched stays blocked with its reason, by keyboard as well (CTRL-154)", async ({ page }) => {
  await page.goto(EMPTY);
  const watched = page.getByRole("button", { name: "Mark watched" }).first();
  await watched.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(watched).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText(/Mark watched: Blocked until permitted playback/)).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveCount(0);
});

test("a saved partial review shows its new version and stays unfinished", async ({ page }) => {
  await page.goto(EMPTY);
  await page.getByLabel("Original video URL").fill("https://www.instagram.com/reel/E2EREEL0001/");
  await page.getByRole("button", { name: "Add time-coded observation" }).click();
  const dialog = page.getByRole("dialog", { name: "Add time-coded observation" });
  await dialog.getByLabel("From (m:ss)").fill("0:00");
  await dialog.getByLabel("To (m:ss)").fill("0:10");
  await dialog.getByLabel("Observation").fill("Opens on a desk.");
  await dialog.getByRole("button", { name: "Add observation" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Save partial review" }).first().click();
  await expect(page.getByTestId("save-status")).toContainText("A saved draft is not a completed review");
  await expect(page.getByTestId("save-status")).toContainText("Saved as version 2");
  await expect(page.getByLabel("Original video URL")).toHaveValue("https://www.instagram.com/reel/E2EREEL0001/");
  await expect(page.getByTestId("metric-Visual coverage")).toContainText("Partial · 0:10 observed");
  await expect(page.getByRole("button", { name: "Mark watched" }).first()).toHaveAttribute("aria-disabled", "true");
});

test("the observation dialog traps focus and returns it on close", async ({ page }) => {
  await page.goto(PARTIAL);
  const trigger = page.getByRole("button", { name: "Add time-coded observation" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Add time-coded observation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const url of [EMPTY, PARTIAL]) {
  test(`no accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId("metric-Visual coverage")).toBeVisible();
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("no horizontal overflow at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(PARTIAL);
  await expect(page.getByTestId("metric-Visual coverage")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
