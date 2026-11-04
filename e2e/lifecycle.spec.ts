import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  return { x: Math.round(b!.x), w: Math.round(b!.width), h: Math.round(b!.height) };
};

/** The seven THO-304 sources: route and a landmark that proves the data rendered. */
const screens = [
  { name: "Customer lifecycle", path: "/customers/lifecycle", ready: "flows" },
  { name: "Setup email", path: "/customers/flows/setup", ready: "flow-steps" },
  { name: "Early-access email", path: "/customers/flows/early-access", ready: "flow-settings" },
  { name: "Abandoned checkout", path: "/customers/flows/abandoned-checkout", ready: "flow-settings" },
  { name: "Review request", path: "/customers/flows/review-request", ready: "flow-settings" },
  { name: "Consent", path: "/customers/consent", ready: "audience" },
  { name: "Activation and retention", path: "/customers/activation", ready: "cohort" },
] as const;

test.describe("against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");

  test("the lifecycle and the flow pages place their cards where Figma does", async ({ page }) => {
    await page.goto("/customers/lifecycle");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId("flows")).toBeVisible();
    expect(await box(page.getByTestId("flows"))).toMatchObject({ x: 72, w: 1296 });
    expect(await box(page.getByTestId("activation-card"))).toMatchObject({ x: 72, w: 636 });
    expect(await box(page.getByTestId("close-loop"))).toMatchObject({ x: 732, w: 636 });

    await page.goto("/customers/flows/early-access");
    await expect(page.getByTestId("flow-settings")).toBeVisible();
    expect(await box(page.getByTestId("flow-steps"))).toMatchObject({ x: 72, w: 832 });
    expect(await box(page.getByTestId("flow-settings"))).toMatchObject({ x: 928, w: 440 });
    expect(await box(page.getByTestId("tests"))).toMatchObject({ x: 72, w: 1296 });
  });

  test("Consent's bar is proportional to its counts", async ({ page }) => {
    await page.goto("/customers/consent");
    await expect(page.getByTestId("consent-bar")).toBeVisible();
    const widths = await page.getByTestId("consent-bar").locator("span").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    const total = widths.reduce((a, b) => a + b, 0);
    expect(widths.map((w) => Math.round((1000 * w) / total))).toEqual([740, 130, 60, 70]);
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

test("the locked policies can't be changed by mouse or keyboard, and are explained", async ({ page }) => {
  await page.goto("/customers/flows/abandoned-checkout");
  const policies = page.getByRole("group", { name: "Mandatory send policies, locked" });
  await expect(policies).toBeVisible();
  const boxes = policies.getByRole("checkbox");
  await expect(boxes).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const b = boxes.nth(i);
    await b.focus();
    await page.keyboard.press("Space");
    await expect(b).toBeChecked();
    await b.click({ force: true });
    await expect(b).toBeChecked();
  }
  await expect(page.getByText(/The server enforces them at send time/)).toBeVisible();
});

test("a draft is saved as a new version and enables nothing", async ({ page }) => {
  await page.goto("/customers/flows/abandoned-checkout");
  await page.getByLabel("Timing").selectOption("24 hours after checkout");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByTestId("save-status")).toContainText("Saved as version 2");
  await expect(page.getByRole("button", { name: /^Enable/ })).toHaveCount(0);
});

test("leaving with an unsaved draft asks first", async ({ page }) => {
  await page.goto("/customers/flows/early-access");
  const template = page.getByLabel("Message template");
  await template.fill("A different template");
  await page.getByRole("link", { name: "Back to lifecycle" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/early-access/);
});

test("the template preview dialog returns focus to its trigger", async ({ page }) => {
  await page.goto("/customers/flows/review-request");
  const trigger = page.getByRole("button", { name: "Preview template" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Template preview" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("flows are reachable from the lifecycle, and Back returns to it", async ({ page }) => {
  await page.goto("/customers/lifecycle");
  await page.getByRole("link", { name: "View flow →" }).click();
  await expect(page).toHaveURL(/flows\/setup$/);
  await expect(page.getByTestId("flow-steps")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("flows")).toBeVisible();
});
