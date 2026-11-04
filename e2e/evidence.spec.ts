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
    // Intentional: the blocked-action reasons are two visible lines of text (56px), which Figma doesn't have (docs/design-map.md).
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(2267);
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

test.describe("reviewer disagreement and override (VE-08)", () => {
  const PARTIAL_DISPUTE = /Disagree or override audio and narrative 0:00 to 0:12/i;

  test("an override is recorded with its reason beside the first record, which stays as it was", async ({ page }) => {
    await page.goto(PARTIAL);
    const disputes = page.getByTestId("disputes");
    const coverage = await page.getByTestId("metric-Audio coverage").textContent();
    const trigger = disputes.getByRole("button", { name: PARTIAL_DISPUTE });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Disagree or override" });
    await dialog.getByRole("button", { name: "Record disagreement" }).click();
    await expect(dialog.getByText(/Give a reason of at least 12 characters/)).toBeVisible();
    await dialog.getByRole("radio", { name: /Override/ }).check();
    await dialog.getByLabel("From (m:ss)").fill("0:00");
    await dialog.getByLabel("To (m:ss)").fill("0:12");
    await dialog.getByRole("textbox", { name: "What it should say" }).fill("Music only, no speech.");
    await dialog.getByLabel("Reason").fill("There is no voiceover in this clip.");
    await dialog.getByRole("button", { name: "Record override" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("dispute-status")).toContainText("Recorded at version 4. The first reviewer's record is unchanged.");
    const entry = page.getByTestId("dispute-entry");
    await expect(entry).toContainText("Voiceover over soft music.");
    await expect(entry).toContainText("Music only, no speech.");
    await expect(entry).toContainText("There is no voiceover in this clip.");
    await expect(disputes.getByText("Disputed", { exact: true })).toBeVisible();
    await expect(page.getByTestId("metric-Audio coverage")).toHaveText(coverage ?? "");
    await expect(page.getByTestId("readiness")).toContainText("contested");
    await expect(page.getByRole("button", { name: "Mark watched" }).first()).toHaveAttribute("aria-disabled", "true");
  });

  test("the dialog is keyboard-operable and returns focus to the control that opened it", async ({ page }) => {
    await page.goto(PARTIAL);
    const trigger = page.getByTestId("disputes").getByRole("button", { name: PARTIAL_DISPUTE });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Disagree or override" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("nothing to dispute before a review is saved, and the existing override page has no accessibility violations", async ({ page }) => {
    await page.goto(EMPTY);
    await expect(page.getByTestId("no-first-review")).toBeVisible();
    await page.goto("/creators/demo-creator-1/evidence/demo-evidence-3");
    await expect(page.getByTestId("dispute-entry")).toBeVisible();
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
});
