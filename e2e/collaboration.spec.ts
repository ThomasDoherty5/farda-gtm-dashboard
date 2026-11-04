import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const OVERVIEW = "/collaborations/demo-collaboration-1?tab=overview";
const CONTENT = "/collaborations/demo-collaboration-1?tab=content";
const ready = (page: Page, url: string) => expect(page.getByTestId(url.endsWith("content") ? "checklist" : "timeline")).toBeVisible();

test.describe("collaboration screens against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    return { x: Math.round(b!.x), y: Math.round(b!.y), w: Math.round(b!.width), h: Math.round(b!.height) };
  };
  const height = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight);

  test("collaboration detail (9:299): size, panels and tabs", async ({ page }) => {
    await page.goto(OVERVIEW);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, OVERVIEW);
    expect(await height(page)).toBe(1675);
    expect(await box(page.getByTestId("timeline").locator("xpath=ancestor::section[1]"))).toMatchObject({ x: 72, w: 832 });
    const tabs = page.getByRole("navigation", { name: "Collaboration views" });
    expect(await box(tabs.getByRole("link", { name: "Brief" }))).toMatchObject({ x: 230, y: 238, w: 146, h: 44 });
    await expect(tabs.getByRole("link", { name: "Overview" })).toHaveCSS("background-color", "rgb(240, 236, 255)");
  });

  test("content review (9:436): size, columns and the blocked decision", async ({ page }) => {
    await page.goto(CONTENT);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, CONTENT);
    expect(await height(page)).toBe(1599);
    expect(await box(page.getByTestId("checklist").locator("xpath=ancestor::section[1]"))).toMatchObject({ x: 72, w: 760 });
    expect(await box(page.getByTestId("rights-register"))).toMatchObject({ x: 852, w: 516 });
    expect(await box(page.getByRole("button", { name: "Approve content" }))).toMatchObject({ w: 468, h: 44 });
  });
});

test("a tab selection survives a reload and Back", async ({ page }) => {
  await page.goto(OVERVIEW);
  await ready(page, OVERVIEW);
  await page.getByRole("navigation", { name: "Collaboration views" }).getByRole("link", { name: "Messages" }).click();
  await expect(page).toHaveURL(/tab=messages/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("timeline")).toBeVisible();
});

test("closing a collaboration only queues a request, and focus returns to the trigger", async ({ page }) => {
  await page.goto(OVERVIEW);
  const trigger = page.getByRole("button", { name: "Close collaboration" });
  await trigger.click();
  const form = page.getByRole("dialog", { name: "Close collaboration" });
  await form.getByRole("button", { name: "Request closure" }).click();
  await expect(form.getByText("Outcome is required.")).toBeVisible();
  await form.getByLabel("Outcome").selectOption("Completed");
  await form.getByLabel("Reason").fill("Delivered and settled");
  await form.getByRole("button", { name: "Request closure" }).click();
  await expect(page.getByTestId("action-ack")).toContainText("Nothing has been sent, closed or suppressed");
  await expect(page.getByTestId("queued-requests")).toContainText("Close as Completed");
  await expect(form).toBeHidden();
});

test("the dialog closes on Escape and returns focus", async ({ page }) => {
  await page.goto(CONTENT);
  const trigger = page.getByRole("button", { name: "Reject with reason" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Reject with reason" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("the blocked approval stays blocked by keyboard and says why", async ({ page }) => {
  await page.goto(CONTENT);
  const approve = page.getByRole("button", { name: "Approve content" });
  await approve.focus();
  await expect(approve).toBeFocused();
  await expect(approve).toHaveAccessibleDescription("Acceptance remains blocked while the required license is missing.");
  await approve.click({ force: true });
  await expect(page.getByTestId("action-ack")).toHaveCount(0);
});

for (const url of [OVERVIEW, CONTENT, "/collaborations/demo-collaboration-1?tab=rights", "/collaborations/demo-collaboration-1?tab=payments"]) {
  test(`no accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await page.getByRole("heading", { level: 1 }).waitFor();
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("no accessibility violations with a command dialog open", async ({ page }) => {
  await page.goto(OVERVIEW);
  await page.getByRole("button", { name: "Queue next action" }).click();
  await expect(page.getByRole("dialog", { name: "Queue next action" })).toBeVisible();
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

for (const url of [OVERVIEW, CONTENT]) {
  test(`no horizontal overflow at 320px on ${url}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(url);
    await ready(page, url);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

const VOLUNTARY = "/collaborations/demo-collaboration-2?tab=overview";

test("a voluntary collaboration shows an observation window, not a posting due date, and offers no reminder", async ({ page }) => {
  await page.goto(VOLUNTARY);
  await expect(page.getByTestId("timeline")).toBeVisible();
  await expect(page.getByTestId("posting-terms")).toHaveAttribute("data-obligation", "voluntary");
  await expect(page.getByTestId("posting-obligation")).toHaveText("None under the accepted terms");
  await expect(page.getByTestId("observation-window")).toHaveText("Until 13 Nov 2026");
  await expect(page.getByTestId("sample-cost")).toContainText("$18.40");
  await expect(page.getByText("Posting due", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("review-after")).toHaveCount(0);
  await page.getByRole("button", { name: "Queue next action" }).click();
  const options = page.getByLabel("Next action").locator("option");
  await expect(options).toHaveText(["Record a note in the source"]);
});

test("the committed collaboration still shows its posting due date and where today falls", async ({ page }) => {
  await page.goto(OVERVIEW);
  await expect(page.getByTestId("posting-terms")).toHaveAttribute("data-obligation", "committed");
  await expect(page.getByTestId("review-after")).toHaveText("07 Nov 2026");
  await expect(page.getByTestId("posting-status")).toHaveText("· Due today");
});

test("a voluntary collaboration has no content review, and its content tab says why", async ({ page }) => {
  await page.goto("/collaborations/demo-collaboration-2?tab=content");
  await expect(page.getByTestId("no-submission")).toContainText("No content submitted");
  await expect(page.getByTestId("checklist")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve content" })).toHaveCount(0);
});

for (const [name, url] of [["voluntary overview", VOLUNTARY], ["voluntary content", "/collaborations/demo-collaboration-2?tab=content"]] as const) {
  test(`no accessibility violations on the ${name}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
}
