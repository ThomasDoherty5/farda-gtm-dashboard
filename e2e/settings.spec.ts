import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  return { x: Math.round(b!.x), y: Math.round(b!.y), w: Math.round(b!.width), h: Math.round(b!.height) };
};

/** The five THO-305 sources: route, a landmark that proves the data rendered, and Figma's page height at 1440. */
const screens = [
  { name: "Connections", path: "/settings/connections", ready: "source-systems" },
  { name: "Team permissions", path: "/settings/team", ready: "role-matrix" },
  { name: "Automation runs", path: "/automations", ready: "run-list" },
  { name: "Zap/report schedule", path: "/automations/zap-12/schedule", ready: "zap-pipeline" },
  { name: "Channel capabilities", path: "/settings/capabilities", ready: "capability-matrix" },
] as const;

test.describe("against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");

  test("Automation runs matches 14:637 in height, cards and table rows", async ({ page }) => {
    await page.goto("/automations");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId("run-list")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(2072);
    expect(await box(page.getByTestId("run-list"))).toMatchObject({ x: 72, w: 1296, h: 598 });
    expect(await box(page.getByRole("link", { name: "Request task" }).or(page.getByRole("button", { name: "Request task" })))).toMatchObject({ x: 1146, w: 176, h: 44 });
    const rows = page.getByTestId("run-list").getByRole("row");
    expect(await box(rows.nth(1))).toMatchObject({ w: 1248, h: 63 });
    expect(await box(page.getByTestId("metric-Running").locator("xpath=ancestor::dl[1]"))).toMatchObject({ x: 400, w: 312, h: 152 });
  });

  test("Channel capabilities matches 66:641 in height", async ({ page }) => {
    await page.goto("/settings/capabilities");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId("capability-matrix")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(2015);
    expect(await box(page.getByTestId("capability-matrix"))).toMatchObject({ x: 72, w: 1296 });
    await expect(page.getByRole("link", { name: "Capabilities", exact: true })).toHaveCSS("background-color", "rgb(240, 236, 255)");
  });

  test("Team permissions and Connections place their two columns at 824 and 448", async ({ page }) => {
    for (const [path, left, right] of [["/settings/team", "role-matrix", "owner-coverage"], ["/settings/connections", "source-systems", "freshness"]] as const) {
      await page.goto(path);
      await expect(page.getByTestId(left)).toBeVisible();
      expect(await box(page.getByTestId(left))).toMatchObject({ x: 72, w: 824 });
      expect(await box(page.getByTestId(right))).toMatchObject({ x: 920, w: 448 });
    }
  });
});

for (const s of screens) {
  test(`${s.name}: deep link, reload and no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(s.path);
    await expect(page.getByTestId(s.ready)).toBeVisible();
    await expect(page.getByTestId("demo-banner")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId(s.ready)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`${s.name}: no accessibility violations`, async ({ page }) => {
    await page.goto(s.path);
    await expect(page.getByTestId(s.ready)).toBeVisible();
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  test(`${s.name}: no horizontal overflow at 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(s.path);
    await expect(page.getByTestId(s.ready)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("the setup dialog restores its trigger's focus and survives Back and Forward", async ({ page }) => {
  await page.goto("/settings/connections");
  const trigger = page.getByRole("button", { name: "Open setup" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: /Setup · Intercom/ })).toBeVisible();
  await expect(page).toHaveURL(/connection=intercom/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.goBack();
  await expect(page).not.toHaveURL(/connection=/);
});

test("run filters survive a reload and clear with one control", async ({ page }) => {
  await page.goto("/automations");
  await page.getByRole("button", { name: "Platform: All platforms" }).click();
  await page.getByRole("radio", { name: "Zapier" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/platform=zapier/);
  await expect(page.getByTestId("run-count")).toHaveText("Showing 2 of 7 example runs for the current filters.");
  await page.reload();
  await expect(page.getByRole("button", { name: "Platform: Zapier" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/platform=/);
});

test("Request task creates an approval request and dispatches nothing", async ({ page }) => {
  await page.goto("/automations");
  await page.getByRole("button", { name: "Request task" }).click();
  const dialog = page.getByRole("dialog", { name: "Request a task" });
  await dialog.getByLabel("Job type").selectOption("hourly-check");
  await dialog.getByLabel("Account").selectOption("tiktok-shop");
  await dialog.getByLabel("Entity or scope").fill("Enrolled creators");
  await dialog.getByLabel("Reason").fill("Check inbox and posts on the hour");
  await dialog.getByRole("button", { name: "Create approval request" }).click();
  await expect(dialog.getByTestId("task-status")).toContainText("nothing was dispatched");
});

test("a saved schedule draft is a new version, and the schedule stays paused", async ({ page }) => {
  await page.goto("/automations/zap-12/schedule");
  await page.getByLabel("Cadence").selectOption("daily");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByTestId("save-status")).toContainText("Saved as version 2");
  await expect(page.getByRole("button", { name: "Enable schedule" })).toHaveAttribute("aria-disabled", "true");
});

test("capability tabs live in the URL and keep Back working", async ({ page }) => {
  await page.goto("/settings/capabilities");
  await page.getByRole("link", { name: "Access evidence" }).click();
  await expect(page).toHaveURL(/tab=access/);
  await expect(page.getByTestId("access-evidence")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("capability-matrix")).toBeVisible();
});
