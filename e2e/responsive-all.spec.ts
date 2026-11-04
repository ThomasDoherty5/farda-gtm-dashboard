import { expect, test } from "@playwright/test";
import { auditLayout, settle } from "./support/layout";
import { extraRecordUrls, routeUrls } from "./support/routes";

const urls = [...routeUrls, ...extraRecordUrls];

/**
 * Every built route at every width from handoff section 11 (FHC-04), plus 320 CSS px for WCAG 1.4.10 reflow.
 * Fails on sideways page scroll, controls that are clipped or overlap, text cut off, scroll regions without a name
 * or keyboard focus, and targets under 24px (WCAG 2.2 SC 2.5.8). Only Operations has native 390 and 1024 designs;
 * the rest are adaptations listed in docs/design-map.md. Runs once, in the desktop project, which sets each width itself.
 */
test.describe("every route fits at every width", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop-1440", "sets its own viewport; one project is enough");
  });

  // 720 is 200% zoom of 1440 (WCAG 1.4.4); 320 is 400% zoom of 1280 (WCAG 1.4.10).
  for (const width of [320, 390, 720, 768, 1024, 1440, 1920]) {
    test(`${urls.length} routes at ${width}px`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      const failures: string[] = [];
      for (const url of urls) {
        await page.goto(url);
        await settle(page, url);
        for (const problem of await page.evaluate(auditLayout)) failures.push(`${url}  ${problem}`);
      }
      expect(failures, `${failures.length} layout problems at ${width}px`).toEqual([]);
    });
  }
});

/**
 * WCAG 1.4.12 text spacing: line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em. Nothing may be cut off,
 * overlap or leave the screen, at a narrow and a wide layout.
 */
test.describe("text spacing", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop-1440", "sets its own viewport; one project is enough");
  });
  for (const width of [390, 1440]) {
    test(`${urls.length} routes keep every control and label with WCAG text spacing at ${width}px`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      const failures: string[] = [];
      for (const url of urls) {
        await page.goto(url);
        await settle(page, url);
        await page.addStyleTag({ content: "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }" });
        for (const problem of await page.evaluate(auditLayout)) failures.push(`${url}  ${problem}`);
      }
      expect(failures, `${failures.length} problems with text spacing at ${width}px`).toEqual([]);
    });
  }
});

/** The shell collapses as the native designs do: "More" ends the 1024 navigation (12:708), "Menu" replaces it at 390 (12:653). */
test.describe("shell navigation by width", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop-1440", "sets its own viewport; one project is enough");
  });
  const primary = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("link");
  test("1440px shows five sections and the profile button", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/operations");
    await expect(primary(page)).toHaveText(["Overview", "Creators", "Operations", "Finance", "Automations"]);
    await expect(page.getByRole("button", { name: "Open workspace menu" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(0);
  });
  test("1024px shows four sections and More", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/operations");
    await expect(primary(page)).toHaveText(["Overview", "Creators", "Operations", "Finance"]);
    await expect(page.getByRole("link", { name: "Operations" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
    const header = await page.locator("header").boundingBox();
    expect(header?.height, "the header stays on one row (Figma 12:710 is 76px)").toBeLessThan(100);
  });
  test("390px shows the brand and Menu only", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/operations");
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await menu.click();
    const dialog = page.getByRole("dialog", { name: "Explore the Farda workspace." });
    await dialog.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Finance" }).click();
    await expect(page).toHaveURL(/\/finance$/);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  });
});
