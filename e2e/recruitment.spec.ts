import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const REC = "/creators/social-cat/recruitment";
const INV = "/creators/tiktok/invitations/new";
const BATCH = "/batches/demo-batch-tt-024";
const READY: Record<string, string> = { [REC]: "Historical allocation", [INV]: "Creator fit score", [BATCH]: "Selected prospects" };
const ready = (page: Page, url: string) => expect(page.getByTestId(`metric-${READY[url.split("?")[0]!]}`)).toBeVisible();

test.describe("recruitment screens against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    return { x: Math.round(b!.x), y: Math.round(b!.y), w: Math.round(b!.width), h: Math.round(b!.height) };
  };
  const height = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight);
  test("Social Cat recruitment (38:131): panels sit where the design puts them", async ({ page }) => {
    await page.goto(REC);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, REC);
    // 18px taller than Figma's 2719: the gated buttons' reasons are visible text and wrap one more line (design-map.md).
    expect(await height(page)).toBe(2737);
    expect(await box(page.getByTestId("metric-Historical allocation").locator("xpath=ancestor::dl[1]"))).toMatchObject({ x: 72, y: 538, w: 312, h: 152 });
    expect(await box(page.getByTestId("recruit-queue"))).toMatchObject({ x: 97, y: 819, w: 784, h: 369 });
    expect(await box(page.getByRole("link", { name: "Recruitment queue" }))).toMatchObject({ x: 508, y: 238, w: 206, h: 44 });
  });

  test("TikTok invitation (38:348): size and fields", async ({ page }) => {
    await page.goto(INV);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, INV);
    expect(await height(page)).toBe(2658);
    expect(await box(page.getByRole("textbox", { name: "Creator" }))).toMatchObject({ x: 97, w: 376, h: 48 });
    expect(await box(page.getByRole("textbox", { name: "Product" }))).toMatchObject({ x: 505, w: 376, h: 48 });
    expect(await box(page.getByRole("button", { name: "Send request · blocked" }))).toMatchObject({ w: 396, h: 44 });
  });

  test("Bulk batch detail (66:821): size, bars and table", async ({ page }) => {
    await page.goto(BATCH);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, BATCH);
    expect(await height(page)).toBe(2298);
    expect(await box(page.getByTestId("metric-Selected prospects").locator("xpath=ancestor::dl[1]"))).toMatchObject({ x: 72, w: 312, h: 170 });
    const segments = page.getByTestId("status-bar").locator("li");
    expect(Math.round((await segments.first().boundingBox())!.width)).toBe(821);
    expect(await box(page.getByTestId("items-region"))).toMatchObject({ x: 97, w: 1248 });
    expect(await box(page.getByRole("link", { name: "Batch detail" }))).toMatchObject({ w: 116, h: 44 });
    await expect(page.getByRole("link", { name: "Automations" })).toHaveCSS("background-color", "rgb(101, 71, 245)");
  });
});

test("a recruitment filter survives a reload and Back", async ({ page }) => {
  await page.goto(REC);
  await page.getByRole("button", { name: "Publishing networks: Instagram + TikTok" }).click();
  await page.getByRole("radio", { name: "TikTok", exact: true }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/networks=tiktok/);
  await expect(page.getByTestId("metric-Historical allocation")).toHaveText("5");
  await page.reload();
  await expect(page.getByRole("button", { name: "Publishing networks: TikTok" })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("metric-Historical allocation")).toHaveText("22");
});

test("an edited draft asks before leaving, and Keep task keeps the edit", async ({ page }) => {
  await page.goto(REC);
  const rights = page.getByLabel("Rights");
  await rights.fill("Rights agreed");
  await page.getByRole("link", { name: "TikTok dashboard" }).click();
  const guard = page.getByRole("dialog", { name: "Discard your edits?" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Keep task" }).click();
  await expect(page).toHaveURL(/recruitment/);
  await expect(rights).toHaveValue("Rights agreed");
});

test("a typed invitation window becomes an exact request in the review", async ({ page }) => {
  await page.goto(INV);
  await page.getByLabel("Invitation starts").fill("2026-11-10 09:00 PT");
  await page.getByLabel("Invitation expires").fill("2026-11-17 09:00 PT");
  await page.getByRole("button", { name: "Review exact request" }).first().click();
  const review = page.getByRole("dialog", { name: "Review exact request" });
  await expect(review).toContainText("Nov 10, 2026");
  await expect(review.getByRole("alert")).toContainText("Source capability is unverified");
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(page.getByRole("button", { name: "Review exact request" }).first()).toBeFocused();
});

test("pausing new work holds the queued items and keeps the confirmed ones", async ({ page }) => {
  await page.goto(BATCH);
  await page.getByRole("button", { name: "Pause new work" }).click();
  await page.getByRole("dialog", { name: "Pause new work" }).getByRole("button", { name: "Pause new work" }).click();
  await expect(page.getByTestId("action-ack")).toContainText("New work is paused.");
  await expect(page.getByTestId("status-sentence")).toContainText("16 confirmed + 0 queued + 2 running + 2 reconciliation + 1 login blocked + 3 paused");
  await expect(page.getByRole("button", { name: "Pause new work" })).toHaveAttribute("aria-disabled", "true");
});

test("canceling unsent items leaves confirmed sends alone", async ({ page }) => {
  await page.goto(BATCH);
  await page.getByRole("button", { name: "Cancel unsent items" }).click();
  const preview = page.getByRole("dialog", { name: "Cancel unsent items" });
  await expect(preview).toContainText("3 unsent items will be canceled");
  await preview.getByRole("button", { name: "Cancel unsent" }).click();
  await expect(page.getByTestId("status-sentence")).toContainText("+ 3 canceled");
  await expect(page.getByText("Confirmed · 16")).toBeVisible();
});

for (const url of [REC, `${REC}?networks=instagram&route=inbound`, INV, BATCH, `${BATCH}?tab=capacity`, `${BATCH}?tab=exceptions`]) {
  test(`no accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await page.getByRole("heading", { level: 1 }).waitFor();
    if (!url.includes("tab=")) await ready(page, url);
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("no accessibility violations with a review dialog open", async ({ page }) => {
  await page.goto(INV);
  await page.getByRole("button", { name: "Review exact request" }).first().click();
  await expect(page.getByRole("dialog", { name: "Review exact request" })).toBeVisible();
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

for (const url of [REC, INV, BATCH]) {
  test(`no horizontal overflow at 320px on ${url}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(url);
    await ready(page, url);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test.describe("TikTok sample requests", () => {
  test("a verified decision shows TikTok's receipt, a denied one hands off, and axe is clean", async ({ page }) => {
    await page.goto(`${BATCH}?tab=samples`);
    await expect(page.getByTestId("samples-tab")).toBeVisible();
    await page.getByRole("button", { name: "Approve sample SR-001" }).click();
    await expect(page.getByTestId("sample-ack")).toContainText("Receipt demo-tiktok-sample-receipt-SR-001");
    await page.getByRole("button", { name: "Approve sample SR-003" }).click();
    await expect(page.getByTestId("sample-handoff")).toContainText("Nothing was decided");
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});
