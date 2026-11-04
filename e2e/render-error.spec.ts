import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * A screen that throws while rendering. The built app has no throwing route, so the test makes currency formatting
 * throw while a session flag is set. Overview formats Net receipts, so it fails the way a bad shape from an adapter would.
 */
const FLAG = "farda-test-render-throw";
async function armThrow(page: Page) {
  await page.addInitScript((flag) => {
    const original = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, "format")!;
    Object.defineProperty(Intl.NumberFormat.prototype, "format", {
      ...original,
      get() {
        const format = original.get!.call(this) as (n: number) => string;
        return (n: number) => {
          if (sessionStorage.getItem(flag)) throw new TypeError("provider-id-9f3a leaked in a message");
          return format(n);
        };
      },
    });
  }, FLAG);
  await page.goto("/settings/team");
  await page.evaluate((flag) => sessionStorage.setItem(flag, "1"), FLAG);
}
const disarm = (page: Page) => page.evaluate((flag) => sessionStorage.removeItem(flag), FLAG);

test("a render error shows an honest, accessible error state inside the shell", async ({ page }) => {
  await armThrow(page);
  await page.goto("/overview");
  const heading = page.getByRole("heading", { level: 1, name: "Something went wrong on this screen" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  const alert = page.getByRole("alert");
  await expect(alert.getByText("Error", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  // Route kept, no partial data, no raw error.
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByTestId("metric-Paid orders")).toHaveCount(0);
  const text = (await page.locator("body").innerText()) ?? "";
  expect(text).not.toMatch(/provider-id|leaked|TypeError|node_modules|\.tsx?:\d+/);
  expect(text).not.toMatch(/success|approved|sent/i);

  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("other screens still work once the failing cause is gone", async ({ page }) => {
  await armThrow(page);
  await page.goto("/overview");
  await expect(page.getByTestId("render-error")).toBeVisible();
  await disarm(page);
  await page.reload(); // fresh document, flag cleared
  await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
  await expect(page.getByTestId("render-error")).toHaveCount(0);
  await page.getByRole("link", { name: "Finance", exact: true }).click();
  await expect(page).toHaveURL(/\/finance$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("render-error")).toHaveCount(0);
});

test("navigating from the error state to another screen clears it without a reload", async ({ page }) => {
  await armThrow(page);
  await page.goto("/overview");
  await expect(page.getByTestId("render-error")).toBeVisible();
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(page).toHaveURL(/\/automations$/);
  await expect(page.getByTestId("render-error")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack();
  // Back to the screen that still throws: the error state returns instead of stale content.
  await expect(page.getByTestId("render-error")).toBeVisible();
});

test("Reload recovers once the cause is gone", async ({ page }) => {
  await armThrow(page);
  await page.goto("/overview");
  await expect(page.getByTestId("render-error")).toBeVisible();
  await disarm(page);
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
});
