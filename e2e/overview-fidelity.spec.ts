import { expect, test, type Locator, type Page } from "@playwright/test";
import { openSection, openWorkspaceMenu } from "./support/nav";

/** Geometry and styles read from Figma source 10:217 and Button set 2:69, at the 1440 design width. */
test.describe("Overview against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");

  const box = async (locator: Locator) => {
    const b = await locator.boundingBox();
    if (!b) throw new Error("Element has no box");
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const css = (locator: Locator, property: string) => locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
  const open = async (page: Page) => {
    await page.goto("/overview");
    await expect(page.getByTestId("metric-Net receipts")).toHaveText("$12,596");
    await page.evaluate(() => document.fonts.ready);
  };

  test("panels sit where the design puts them", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(1381);
    expect(await box(page.locator("main"))).toMatchObject({ x: 40, y: 116, w: 1360 });
    expect(await box(page.getByTestId("sales-card"))).toMatchObject({ x: 468, y: 290, w: 900 });
    expect(await box(page.getByTestId("share-card"))).toMatchObject({ x: 72, y: 794, w: 376 });
    expect(await box(page.getByTestId("growth-card"))).toMatchObject({ x: 468, y: 794, w: 484 });
    expect(await box(page.getByTestId("activity-card"))).toMatchObject({ x: 972, y: 794, w: 396 });
    expect(await box(page.getByRole("button", { name: "Last 30 days" }))).toMatchObject({ w: 172, h: 44 });
    expect(await box(page.getByRole("button", { name: "Export report" }))).toMatchObject({ w: 166, h: 44 });
  });

  test("chart bars are plotted from the data at the design's scale", async ({ page }) => {
    await open(page);
    const bars = page.getByTestId("sales-card").locator('[title^="Oct 5:"] span');
    const [shopify, tiktok] = await Promise.all([bars.nth(0).boundingBox(), bars.nth(1).boundingBox()]);
    expect(shopify!.height).toBeCloseTo(87.17, 0);
    expect(tiktok!.height).toBeCloseTo(34.1, 0);
    expect(shopify!.width).toBe(9);
    expect(tiktok!.x - shopify!.x).toBe(11);
  });

  test("text uses the design's styles", async ({ page }) => {
    await open(page);
    const h1 = page.getByRole("heading", { level: 1 });
    expect(await css(h1, "font-size")).toBe("30px");
    expect(await css(h1, "font-weight")).toBe("600");
    expect(await css(h1, "line-height")).toBe("38px");
    expect(await css(h1, "font-family")).toContain("Inter");
    expect(await css(page.getByTestId("metric-Net receipts"), "font-size")).toBe("32px");
  });

  test("Button states match set 2:69", async ({ page }) => {
    await open(page);
    const primary = page.getByRole("button", { name: "Export report" });
    const secondary = page.getByRole("button", { name: "Last 30 days" });
    expect(await css(primary, "background-color")).toBe("rgb(101, 71, 245)");
    expect(await css(primary, "color")).toBe("rgb(255, 255, 255)");
    expect(await css(primary, "border-radius")).toBe("999px");
    expect(await css(secondary, "background-color")).toBe("rgb(255, 255, 255)");
    expect(await css(secondary, "border-top-color")).toBe("rgb(226, 226, 233)");

    await primary.hover();
    await expect(primary).toHaveCSS("opacity", "0.9");
    await page.mouse.down();
    await expect(primary).toHaveCSS("background-color", "rgb(23, 24, 28)");
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.keyboard.press("Escape");

    await page.goto("/approvals/demo-approval-expired");
    const disabled = page.getByRole("button", { name: "Approve this version" });
    await expect(disabled).toHaveCSS("background-color", "rgb(247, 247, 250)");
    await expect(disabled).toHaveCSS("color", "rgb(104, 105, 117)");
  });

  test("Button's Ghost, Focus and Loading states match set 2:69", async ({ page }) => {
    await page.goto("/runs/demo-run-uncertain?tab=recovery");
    const ghost = page.getByRole("button", { name: "Keep paused" });
    await expect(ghost).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(ghost).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await expect(ghost).toHaveCSS("color", "rgb(23, 24, 28)");

    await page.goto("/overview");
    await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
    const primary = page.getByRole("button", { name: "Export report" });
    await page.keyboard.press("Tab");
    await primary.focus();
    await page.getByRole("button", { name: "Last 30 days" }).focus();
    await page.keyboard.press("Tab");
    await expect(primary).toBeFocused();
    await expect(primary).toHaveCSS("box-shadow", "rgb(240, 236, 255) 0px 0px 0px 4px inset");
    await expect(primary).toHaveCSS("outline-style", "solid");

    // The Loading behavior is covered in Button.test.tsx. Here the busy attribute is set by hand to check its Figma styling.
    await page.goto("/overview");
    const busy = page.getByRole("button", { name: "Export report" });
    await busy.evaluate((el) => el.setAttribute("aria-busy", "true"));
    await expect(busy).toHaveCSS("background-color", "rgb(101, 71, 245)");
    await expect(busy).toHaveCSS("cursor", "progress");
  });

  test("the current section uses the active nav style", async ({ page }) => {
    await open(page);
    const active = page.getByRole("link", { name: "Overview" });
    await expect(active).toHaveCSS("background-color", "rgb(101, 71, 245)");
    expect(await box(active)).toMatchObject({ x: 246, w: 122, h: 44 });
    expect(await css(page.getByRole("link", { name: "Creators" }), "background-color")).toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("Overview controls", () => {
  test("links go where the prototype goes", async ({ page }) => {
    const cases: [string, RegExp][] = [
      ["View channel report →", /\/analytics\/attribution$/],
      ["Explore unit economics →", /\/analytics\/finance$/],
      ["View content monitor", /\/content$/],
      ["View definitions →", /\/analytics\/attribution$/],
      ["Launch date unset", /\/launch\?view=snapshot$/],
      ["TikTok Shop", /\/creators\/tiktok\?view=dashboard$/],
      ["Creators", /\/creators\/social-cat\?view=dashboard$/],
    ];
    for (const [name, url] of cases) {
      await page.goto("/overview");
      if (name === "Creators") await openSection(page, name);
      else await page.getByRole("link", { name, exact: true }).click();
      await expect(page, name).toHaveURL(url);
    }
  });

  test("the period dialog is honest, traps focus, and returns it on close", async ({ page }) => {
    await page.goto("/overview");
    await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
    const trigger = page.getByRole("button", { name: "Last 30 days" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "A consistent reporting window." });
    await expect(dialog).toContainText("Sep 30 – Oct 29, 2026");
    await dialog.getByRole("button", { name: "Keep demo period" }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
  });

  test("export says no file is generated, and Escape closes it", async ({ page }) => {
    const downloads: unknown[] = [];
    page.on("download", (d) => downloads.push(d));
    await page.goto("/overview");
    await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");
    const trigger = page.getByRole("button", { name: "Export report" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Report preview" });
    await expect(dialog).toContainText("no file is generated");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(downloads).toEqual([]);
  });

  test("the workspace menu reaches screens outside the primary nav", async ({ page }) => {
    await page.goto("/overview");
    await openWorkspaceMenu(page);
    await page.getByRole("dialog").getByRole("link", { name: "Approvals" }).click();
    await expect(page).toHaveURL(/\/approvals$/);
    await expect(page.getByRole("dialog")).toBeHidden();
    const creators = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Creators" });
    if (await creators.isVisible()) await expect(creators).toHaveAttribute("aria-current", "true");
    else {
      // The header has collapsed into the menu (Figma 12:708, 12:653): the section is marked there.
      await openWorkspaceMenu(page);
      await expect(page.getByRole("dialog").getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Creators" })).toHaveAttribute("aria-current", "true");
    }
  });

  test("the chart's scroll region works from the keyboard on a narrow screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/overview");
    const region = page.getByRole("region", { name: "Daily net receipts chart" });
    await region.focus();
    await expect(region).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

for (const url of ["/overview", "/overview?fixture=FX-06"]) {
  test(`no accessibility violations with a dialog open on ${url}`, async ({ page }) => {
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    await page.goto(url);
    await page.getByRole("button", { name: "Export report" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
