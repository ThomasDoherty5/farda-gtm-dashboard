import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openSection } from "./support/nav";

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

const status = (page: Page) => page.getByTestId("approval-status");

test("exact approval: review, approve, then send with a labeled receipt", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/approvals");
  await page.getByRole("link", { name: "Exact approval, then send" }).click();
  await expect(status(page)).toContainText("Pending");
  await page.getByRole("button", { name: "Approve this version" }).click();
  await expect(status(page)).toContainText("Approved, awaiting dispatch");
  await expect(page.getByTestId("source-receipt")).toHaveCount(0);
  await page.getByRole("button", { name: "Send approved action" }).click();
  await expect(page.getByTestId("source-receipt")).toContainText("synthetic demo receipt");
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  expect(errors).toEqual([]);
});

test("conflict: the changed terms are shown and a fresh decision is required", async ({ page }) => {
  await page.goto("/approvals/demo-approval-conflict");
  await page.getByRole("button", { name: "Approve this version" }).click();
  await expect(page.getByTestId("version-changes")).toContainText("Commission: 15% → 20%");
  await expect(page.getByTestId("approval-version")).toContainText("Version 2");
  await expect(status(page)).toContainText("Pending");
});

test("unknown outcome: send, recover through evidence, and see the original receipt", async ({ page }) => {
  await page.goto("/approvals/demo-approval-uncertain");
  await page.getByRole("button", { name: "Approve this version" }).click();
  await page.getByRole("button", { name: "Send approved action" }).click();
  await expect(status(page)).toContainText("Outcome unknown");
  await page.getByRole("link", { name: "Open recovery" }).click();
  await expect(page).toHaveURL(/\/runs\/demo-run-uncertain\?tab=recovery$/);
  await page.getByRole("button", { name: "Check the source" }).click();
  await expect(page.getByTestId("reconciliation")).toContainText("demo-source-receipt-prior");
  await page.getByRole("button", { name: "Record confirmed sent" }).click();
  await expect(page.getByTestId("run-status")).toContainText("Sent, source receipt on file");
});

test("leaving with unsaved edits asks first; Keep task preserves them and returns focus (CTRL-177)", async ({ page }) => {
  await page.goto("/approvals/demo-approval-exact");
  await page.getByLabel("Reason").fill("Half-written reason");
  await openSection(page, "Finance");

  const dialog = page.getByRole("dialog", { name: "Discard your edits?" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/demo-approval-exact$/);
  await dialog.getByRole("button", { name: "Keep task" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Reason")).toHaveValue("Half-written reason");

  await openSection(page, "Finance");
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(/\/finance$/);
});

test("Escape on the leave dialog keeps the edits", async ({ page }) => {
  await page.goto("/approvals/demo-approval-exact");
  await page.getByLabel("Reason").fill("Keep me");
  await openSection(page, "Finance");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByLabel("Reason")).toHaveValue("Keep me");
  await expect(page).toHaveURL(/demo-approval-exact$/);
});

test("clean pages navigate without a prompt, and Back returns from history", async ({ page }) => {
  await page.goto("/approvals/demo-approval-history");
  await page.getByRole("link", { name: "Approval history" }).click();
  await page.getByRole("link", { name: "View historical approval v1" }).click();
  await expect(page.getByRole("heading", { name: "Version v1" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Approval history" })).toBeVisible();
  await page.goBack();
  await expect(status(page)).toBeVisible();
  await page.reload();
  await expect(status(page)).toBeVisible();
});

test("the approval and recovery pages don't overflow at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const url of ["/approvals/demo-approval-exact", "/runs/demo-run-batch?tab=approval", "/runs/demo-run-uncertain?tab=recovery"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
});

test.describe("against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");

  const box = async (page: Page, name: string, level = 2) => {
    const card = page.getByRole("heading", { level, name }).locator("xpath=ancestor::*[self::section or self::aside][1]");
    const b = await card.boundingBox();
    return { x: Math.round(b!.x), w: Math.round(b!.width) };
  };

  test("approval panels sit where 6:234 puts them", async ({ page }) => {
    await page.goto("/approvals/demo-approval-042");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId("exact-message")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(1609);
    expect(await box(page, "Needs a decision")).toEqual({ x: 72, w: 340 });
    expect(await box(page, "Send a creator brief")).toEqual({ x: 432, w: 936 });
    expect(await box(page, "Decision timeline")).toEqual({ x: 72, w: 1296 });
    await expect(page.getByRole("link", { name: "Creators" })).toHaveCSS("background-color", "rgb(101, 71, 245)");
  });

  test("run panels sit where 5:13 puts them", async ({ page }) => {
    await page.goto("/runs/demo-run-approval?tab=approval");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByText("Ready for a human decision")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(1635);
    expect(await box(page, "From brief to a confirmed send")).toEqual({ x: 72, w: 832 });
    expect(await box(page, "Ready for a human decision")).toEqual({ x: 928, w: 440 });
    await expect(page.getByRole("link", { name: "Automations", exact: true })).toHaveCSS("background-color", "rgb(101, 71, 245)");
  });

  test("recovery panels sit where 5:156 puts them", async ({ page }) => {
    await page.goto("/runs/demo-run-uncertain?tab=recovery");
    await expect(page.getByRole("heading", { name: "Resolve the result" })).toBeVisible();
    expect(await box(page, "Resolve the result")).toEqual({ x: 72, w: 832 });
    expect(await box(page, "Approved, then interrupted")).toEqual({ x: 928, w: 440 });
  });
});

test("links on these screens go where the prototype goes", async ({ page }) => {
  const cases: [string, string, RegExp][] = [
    ["/approvals/demo-approval-042", "Current affiliate terms", /\/offers\/demo-offer$/],
    ["/approvals/demo-approval-042", "Full acquisition funnel", /\/creators\/pipeline$/],
    ["/runs/demo-run-approval?tab=approval", "Daily sourcing", /\/creators\/discovery$/],
    ["/runs/demo-run-approval?tab=approval", "View connection setup", /\/settings\/connections$/],
    ["/runs/demo-run-approval?tab=approval", "Zaps", /\/automations\?tab=zaps$/],
    ["/runs/demo-run-approval?tab=approval", "Reporting", /\/automations\?tab=reporting$/],
  ];
  for (const [from, name, url] of cases) {
    await page.goto(from);
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page, name).toHaveURL(url);
  }
});

for (const url of ["/approvals/demo-approval-042", "/runs/demo-run-approval?tab=approval", "/approvals", "/runs", "/approvals/demo-approval-history?view=history", "/approvals/demo-approval-exact", "/approvals/demo-approval-expired", "/approvals/demo-approval-history?version=v1", "/runs/demo-run-batch?tab=approval", "/runs/demo-run-uncertain?tab=recovery"]) {
  test(`no automatically detectable accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
