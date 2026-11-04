import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = [
  "/inventory",
  "/inventory?scenario=conflict",
  "/inventory?scenario=delayed",
  "/inventory?home=H2",
  "/support/cases/TEST-ISS-021",
  "/support/cases/TEST-ISS-018",
  "/support/cases/TEST-ISS-016",
];

test.describe("stock and support against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  for (const [node, url, height] of [["7:129", "/inventory", 1454], ["7:317", "/support/cases/TEST-ISS-021", 1389]] as const) {
    test(`${url} is ${height}px tall like ${node}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 400 });
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    });
  }

  test("panels sit where 7:129 and 7:317 put them", async ({ page }) => {
    const box = async (loc: ReturnType<typeof page.locator>) => { const b = (await loc.boundingBox())!; return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) }; };
    await page.goto("/inventory");
    await expect(page.getByTestId("metric-On hand")).toBeVisible();
    expect(await box(page.getByTestId("stock-table-panel"))).toMatchObject({ x: 72, w: 1296 });
    expect(await box(page.getByTestId("movement-log"))).toMatchObject({ x: 72, w: 824 });
    expect(await box(page.getByTestId("transfer-panel"))).toMatchObject({ x: 920, w: 448 });
    await page.goto("/support/cases/TEST-ISS-021");
    await expect(page.getByTestId("metric-Returns")).toBeVisible();
    expect(await box(page.getByTestId("handoff-queue"))).toMatchObject({ x: 72, w: 824 });
    expect(await box(page.getByTestId("case-panel"))).toMatchObject({ x: 920, w: 448 });
    expect(await box(page.getByTestId("issue-mix"))).toMatchObject({ x: 72, w: 636 });
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

test("no horizontal overflow at 320px on stock and support", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const url of ROUTES) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), url).toBeLessThanOrEqual(0);
  }
});

test("a transfer request is queued, not moved, and the dialog returns focus", async ({ page }) => {
  await page.goto("/inventory");
  const trigger = page.getByRole("button", { name: "Request transfer" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Request a stock transfer" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByLabel("From").selectOption("H1");
  await dialog.getByLabel("To").selectOption("H2");
  await dialog.getByLabel("Units").fill("200");
  await dialog.getByLabel("Reason").fill("Rebalance stock");
  await dialog.getByRole("button", { name: "Request transfer" }).click();
  await expect(dialog.getByText("Only 86 available at Home H1.").first()).toBeVisible();
  await dialog.getByLabel("Units").fill("10");
  await dialog.getByRole("button", { name: "Request transfer" }).click();
  await expect(page.getByTestId("pending-requests")).toContainText("No stock has moved");
  await expect(page.getByTestId("metric-On hand")).toHaveText("196");
});

test("a support case selection survives a reload and Back", async ({ page }) => {
  await page.goto("/support/cases/TEST-ISS-021");
  await page.getByTestId("queue-table").getByRole("link", { name: /TEST-ISS-018/ }).click();
  await expect(page).toHaveURL(/TEST-ISS-018/);
  await expect(page.getByTestId("case-panel")).toContainText("Return in review");
  await page.reload();
  await expect(page.getByTestId("case-panel")).toContainText("Return in review");
  await page.goBack();
  await expect(page.getByTestId("case-panel")).toContainText("Human handoff");
});
