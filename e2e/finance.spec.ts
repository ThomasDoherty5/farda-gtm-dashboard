import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = [
  "/finance/commissions",
  "/finance/commissions?scenario=partial",
  "/finance/settlements/COMM-DEMO-D",
  "/finance/settlements/TT-NATIVE-DEMO",
  "/finance/settlements/TT-NATIVE-DEMO?tab=samples",
  "/finance/payables/PAY-0012",
];

test.describe("settlement screens against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  for (const [node, url, height] of [
    ["65:1037", "/finance/commissions", 2185],
    ["66:252", "/finance/settlements/COMM-DEMO-D", 2111],
    ["66:447", "/finance/settlements/TT-NATIVE-DEMO", 2194],
    ["9:551", "/finance/payables/PAY-0012", 1506],
  ] as const) {
    test(`${url} is ${height}px tall like ${node}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 400 });
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    });
  }

  test("the waterfall scales 224px to net sales, as in 65:1037", async ({ page }) => {
    await page.goto("/finance/commissions");
    const bars = page.locator('[class*="wfBar"]');
    await expect(bars.first()).toBeVisible();
    expect(Math.round((await bars.nth(0).boundingBox())!.height)).toBe(224);
    expect(Math.round((await bars.nth(1).boundingBox())!.height)).toBe(101);
    expect(Math.round((await bars.nth(6).boundingBox())!.height)).toBe(58);
  });

  test("TikTok's route chips are the widths 66:447 gives them, 16px apart", async ({ page }) => {
    await page.goto("/finance/settlements/TT-NATIVE-DEMO");
    const chips = page.locator('ul[aria-label="Browser task route"] > li');
    await expect(chips).toHaveCount(4);
    const boxes = [] as { x: number; w: number }[];
    for (let i = 0; i < 4; i++) { const b = (await chips.nth(i).boundingBox())!; boxes.push({ x: Math.round(b.x), w: Math.round(b.width) }); }
    expect(boxes.map((b) => b.w)).toEqual([232, 246, 246, 172]);
    for (let i = 1; i < 4; i++) expect(boxes[i]!.x - (boxes[i - 1]!.x + boxes[i - 1]!.w)).toBe(16);
  });

  test("panels sit where the Figma frames put them", async ({ page }) => {
    const box = async (loc: ReturnType<typeof page.locator>) => { const b = (await loc.boundingBox())!; return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) }; };
    await page.goto("/finance/settlements/COMM-DEMO-D");
    await expect(page.getByTestId("paid-receipt")).toBeVisible();
    expect(await box(page.getByTestId("paid-receipt"))).toMatchObject({ x: 72, w: 1296, h: 588 });
    await page.goto("/finance/payables/PAY-0012");
    await expect(page.getByTestId("payment-request")).toBeVisible();
    expect(await box(page.getByTestId("payment-request"))).toMatchObject({ x: 72, w: 760, h: 601 });
    expect(await box(page.getByTestId("recovery"))).toMatchObject({ x: 852, w: 516, h: 314 });
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

test("no horizontal overflow at 320px on the finance settlement screens", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const url of ROUTES) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), url).toBeLessThanOrEqual(0);
  }
});

test("the ledger exports the whole snapshot as a UTF-8 CSV", async ({ page }) => {
  await page.goto("/finance/commissions");
  await page.getByRole("button", { name: "Export ledger" }).click();
  const dialog = page.getByRole("dialog", { name: "Export the commission ledger" });
  await expect(dialog.getByText("4 of 4")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toBe("commission-ledger-led1.csv");
  const path = await download.path();
  const text = (await import("node:fs")).readFileSync(path!, "utf8");
  expect(text.startsWith("﻿ledger_group,state,")).toBe(true);
  expect(text).toContain("COMM-DEMO-D,Paid,60000,60000,9000,0,9000,15,USD");
  await expect(dialog.getByRole("status")).toContainText("Nothing was sent anywhere");
});

test("a partial snapshot can't be exported", async ({ page }) => {
  await page.goto("/finance/commissions?scenario=partial");
  await page.getByRole("button", { name: "Export ledger" }).click();
  const dialog = page.getByRole("dialog", { name: "Export the commission ledger" });
  await expect(dialog.getByRole("button", { name: "Download CSV" })).toHaveAttribute("aria-disabled", "true");
});

test("a statement match is queued for review, and nothing is marked reconciled", async ({ page }) => {
  await page.goto("/finance/settlements/COMM-DEMO-D");
  const trigger = page.getByRole("button", { name: "Match statement" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Match the provider statement" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog.getByRole("checkbox", { name: /STMT-DEMO-0002/ })).toBeDisabled();
  await dialog.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByTestId("match-status")).toContainText("Nothing is marked reconciled");
  await expect(page.getByTestId("metric-Ledger reconciliation")).toHaveText("Pending");
});

test("the historical offer models are read only, and a tab is a URL", async ({ page }) => {
  await page.goto("/finance/settlements/TT-NATIVE-DEMO");
  await expect(page.getByText("Flat fee + commission")).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("link", { name: "Samples" }).click();
  await expect(page).toHaveURL(/tab=samples/);
  await page.reload();
  await expect(page.getByTestId("tab-panel")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("rates")).toBeVisible();
});
