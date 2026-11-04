import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const axe = async (page: import("@playwright/test").Page) => {
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

test("the shipping view counts what is in transit without confirmed deliveries, and has no axe violations", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1024, "Below 1024px Operations shows its compact layout, which has no shipping view");
  await page.goto("/operations?view=shipping");
  await expect(page.getByRole("heading", { name: "3 in transit" })).toBeVisible();
  await expect(page.getByTestId("sandbox-chain")).toContainText("TEST-TR-012");
  await axe(page);
});

test("restricted customer details: a reviewer is told why, and the dialog has no axe violations", async ({ page }) => {
  await page.goto("/orders/TEST-SH-1042");
  await page.getByRole("button", { name: "Customer details (restricted)" }).click();
  await expect(page.getByTestId("customer-denied")).toContainText("nothing was revealed or logged");
  await axe(page);
});

test("nightly reconciliation: request a repair, the audit trail grows, axe is clean", async ({ page }) => {
  await page.goto("/automations?tab=reconciliation");
  await expect(page.getByTestId("recon-conflicts")).toBeVisible();
  await page.getByRole("button", { name: "Request repair for CONF-001" }).click();
  await expect(page.getByTestId("repair-ack")).toContainText("nothing was changed in either system");
  await expect(page.getByTestId("audit-table").getByRole("row")).toHaveCount(5);
  await axe(page);
});

test("months and the dry-run manifest are addressable and axe-clean", async ({ page }) => {
  for (const view of ["months", "manifest"]) {
    await page.goto(`/finance/close/2026-10?view=${view}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await axe(page);
  }
});

test("the new views do not overflow at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const path of ["/operations?view=shipping", "/automations?tab=reconciliation", "/finance/close/2026-10?view=months", "/finance/close/2026-10?view=manifest"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
