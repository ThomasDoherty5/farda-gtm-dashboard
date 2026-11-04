import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = [
  "/operations",
  "/operations?scenario=holds",
  "/operations?home=H2",
  "/orders/TEST-SH-1042",
  "/orders/TEST-SH-1031",
  "/orders/TEST-SC-0081",
  "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129",
  "/returns/TEST-RET-028",
  "/returns/TEST-RET-028?scenario=resolved",
  "/analytics/fulfillment",
  "/analytics/fulfillment?days=7",
];

test.describe("operations screens against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  // Page heights of the Figma frames. The active return is taller on purpose (see docs/design-map.md).
  const HEIGHTS: [string, string, number][] = [
    ["4:6", "/operations", 1452],
    ["4:171", "/orders/TEST-SH-1042", 1331],
    ["4:317", "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129", 1119],
    ["12:431", "/returns/TEST-RET-028?scenario=resolved", 846],
    ["12:808", "/analytics/fulfillment", 1287],
  ];
  for (const [node, url, height] of HEIGHTS) {
    test(`${url} is ${height}px tall like ${node}`, async ({ page }) => {
      // A short viewport, so scrollHeight is the page, not the window.
      await page.setViewportSize({ width: 1440, height: 400 });
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    });
  }

  test("panels and buttons sit where 4:6 puts them", async ({ page }) => {
    await page.goto("/operations");
    await expect(page.getByTestId("metric-To ship")).toBeVisible();
    const box = async (loc: ReturnType<typeof page.locator>) => { const b = (await loc.boundingBox())!; return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) }; };
    expect(await box(page.getByTestId("metric-To ship").locator("xpath=ancestor::dl[1]"))).toMatchObject({ x: 72, w: 312, h: 152 });
    expect(await box(page.getByTestId("queue-panel"))).toMatchObject({ x: 72, w: 824 });
    expect(await box(page.getByTestId("stock-panel"))).toMatchObject({ x: 920, w: 448 });
    expect(await box(page.getByRole("button", { name: /Home:/ }))).toMatchObject({ w: 160, h: 44 });
    expect(await box(page.getByRole("button", { name: "Open warehouse" }))).toMatchObject({ w: 190, h: 44 });
    await expect(page.getByRole("link", { name: "Overview", exact: true }).last()).toHaveCSS("background-color", "rgb(101, 71, 245)");
  });

  test("the throughput chart scales 6.75px per order, as in 12:808", async ({ page }) => {
    await page.goto("/analytics/fulfillment");
    const bar = page.locator('[data-kind="shipped"]').nth(6);
    await expect(bar).toBeVisible();
    expect(Math.round((await bar.boundingBox())!.height)).toBe(216);
  });
});

test.describe("responsive Operations designs", () => {
  test("1024 shows the tablet composition (Figma 12:708)", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/operations");
    await expect(page.getByTestId("metric-To ship")).toBeVisible();
    await expect(page.getByTestId("metric-Time to ship")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open source" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(1078);
  });

  test("390 shows the phone composition (Figma 12:653)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/operations?home=H2");
    await expect(page.getByRole("heading", { name: "Ship next" })).toBeVisible();
    await expect(page.getByTestId("low-stock")).toContainText("H2 is low on stock");
    await expect(page.getByTestId("metric-To ship")).toHaveText("6");
    await expect(page.getByTestId("metric-Available")).toHaveText("18");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

for (const url of ROUTES) {
  test(`no accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("no horizontal overflow at 320px on any operations screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const url of ROUTES) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), url).toBeLessThanOrEqual(0);
  }
});

test("home scope survives a reload and Back", async ({ page }) => {
  test.skip((await page.evaluate(() => window.innerWidth).catch(() => 1440)) < 1180, "the home control is on the 1440 design");
  await page.goto("/operations");
  await page.getByRole("button", { name: /Home:/ }).click();
  await page.getByRole("radio", { name: "Home H2" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/home=H2/);
  await page.reload();
  await expect(page.getByTestId("metric-To ship")).toHaveText("6");
  await page.goBack();
  await expect(page.getByTestId("metric-To ship")).toHaveText("18");
});

test("recording a shipping decision shows it queued, and the dialog returns focus", async ({ page }) => {
  await page.goto("/shipments/TEST-SP-0093/exceptions/TEST-EVT-129");
  const trigger = page.getByRole("button", { name: "Record next step" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Record the next step" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("radio", { name: /Refund the order/ }).check();
  await dialog.getByLabel("Reason").fill("Carrier confirmed lost");
  await dialog.getByRole("button", { name: "Record next step" }).click();
  await expect(page.getByTestId("decision-recorded")).toContainText("Nothing has been refunded or shipped");
  await expect(page.getByRole("button", { name: "Record next step" })).toHaveAttribute("aria-disabled", "true");
});
