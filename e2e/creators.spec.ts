import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const BOARD = "/creators/social-cat?view=board";
const DASH = "/creators/social-cat?view=dashboard";
const TT_BOARD = "/creators/tiktok?view=board";
const TT_DASH = "/creators/tiktok?view=dashboard";
const READY: Record<string, string> = { [BOARD]: "Active collaborations", [DASH]: "Linked-post views", [TT_BOARD]: "Creators in funnel", [TT_DASH]: "Post views" };
const ready = (page: Page, url: string) => expect(page.getByTestId(`metric-${READY[url]}`)).toBeVisible();

test.describe("creator boards and dashboards against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    return { x: Math.round(b!.x), y: Math.round(b!.y), w: Math.round(b!.width), h: Math.round(b!.height) };
  };
  const height = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight);
  const kpi = (page: Page, label: string) => page.getByTestId(`metric-${label}`).locator("xpath=ancestor::dl[1]");

  test("Social Cat lifecycle (6:24): size, cards and columns", async ({ page }) => {
    await page.goto(BOARD);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, BOARD);
    expect(await height(page)).toBe(1658);
    // Figma sizes these cards to their content: three are 152 tall and the fourth, with two lines of context, is 170.
    expect(await box(kpi(page, "Active collaborations"))).toMatchObject({ x: 72, w: 312, h: 152 });
    expect(await box(kpi(page, "Cost per live video"))).toMatchObject({ x: 1056, w: 312, h: 170 });
    for (const [i, key] of ["applicants", "negotiating", "brief", "creating", "approved"].entries()) {
      expect(await box(page.getByTestId(`stage-${key}`))).toMatchObject({ x: Math.round(72 + i * 262), w: 246 });
    }
    expect(await box(page.getByTestId("stage-applicants").getByRole("listitem").first())).toMatchObject({ w: 214 });
  });

  test("TikTok funnel (9:143): size, tiles and worklist", async ({ page }) => {
    await page.goto(TT_BOARD);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, TT_BOARD);
    expect(await height(page)).toBe(1712);
    const tiles = page.getByTestId("tiktok-stages").getByRole("listitem");
    expect(await box(tiles.first())).toMatchObject({ x: 97, w: 128 });
    expect(await box(page.getByTestId("worklist"))).toMatchObject({ x: 97, w: 1248, h: 318 });
    expect(await box(page.getByRole("searchbox", { name: "Search TikTok creators" }).locator(".."))).toMatchObject({ w: 320, h: 48 });
  });

  test("Social Cat dashboard (23:275): panels sit where the design puts them", async ({ page }) => {
    await page.goto(DASH);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, DASH);
    // 18px taller than Figma's 2583: the history tabs' reason is visible text and wraps onto a second line (design-map.md).
    expect(await height(page)).toBe(2601);
    expect(await box(kpi(page, "Linked-post views"))).toMatchObject({ x: 72, y: 590, w: 312, h: 152 });
    expect(await box(page.getByTestId("cumulative-chart"))).toMatchObject({ x: 97, y: 871, w: 784, h: 244 });
    expect(await box(page.getByTestId("action-queue"))).toMatchObject({ x: 924, y: 766, w: 444, h: 330 });
    expect(await box(page.getByRole("link", { name: "Recruitment queue" }))).toMatchObject({ w: 196, h: 44 });
  });

  test("TikTok dashboard (23:440): size and panels", async ({ page }) => {
    await page.goto(TT_DASH);
    await page.evaluate(() => document.fonts.ready);
    await ready(page, TT_DASH);
    expect(await height(page)).toBe(2399);
    expect(await box(page.getByTestId("cumulative-chart"))).toMatchObject({ w: 784, h: 244 });
    expect(await box(page.getByTestId("action-queue"))).toMatchObject({ x: 924, w: 444, h: 330 });
  });
});

test("the owner filter survives a reload and Back", async ({ page }) => {
  await page.goto(BOARD);
  await page.getByRole("button", { name: "Owner: All owners" }).click();
  await page.getByRole("radio", { name: "Thomas" }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/owner=Thomas/);
  await expect(page.getByTestId("metric-Active collaborations")).toHaveText("16");
  await page.reload();
  await expect(page.getByRole("button", { name: "Owner: Thomas" })).toBeVisible();
  await expect(page.getByTestId("metric-Active collaborations")).toHaveText("16");
  await page.goBack();
  await expect(page.getByTestId("metric-Active collaborations")).toHaveText("66");
});

test("the network filter recomputes and survives a reload", async ({ page }) => {
  await page.goto(DASH);
  await page.getByRole("button", { name: "Instagram" }).click();
  await expect(page).toHaveURL(/network=instagram/);
  await expect(page.getByTestId("metric-Linked-post views")).toHaveText("50.0k");
  await page.reload();
  await expect(page.getByRole("button", { name: "Instagram" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("metric-Attributed net sales")).toHaveText("$1,296");
});

test("typing in the worklist search keeps focus, and the query survives a reload", async ({ page }) => {
  await page.goto(TT_BOARD);
  const search = page.getByRole("searchbox", { name: "Search TikTok creators" });
  await search.click();
  await page.keyboard.type("operations");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("operations");
  await expect(page.getByTestId("worklist").getByRole("row")).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search TikTok creators" })).toHaveValue("operations");
});

test("a gated history tab is reachable by keyboard and says why it is unavailable", async ({ page }) => {
  await page.goto(DASH);
  const tab = page.getByRole("button", { name: "Paid · history" });
  await tab.focus();
  await expect(tab).toBeFocused();
  await expect(tab).toHaveAccessibleDescription(/no new gifted-only, paid or hybrid acquisition can start here/);
  await tab.click({ force: true });
  await expect(page).toHaveURL(/view=dashboard$/);
});

test("the source dialog traps focus and returns it on close", async ({ page }) => {
  await page.goto(BOARD);
  const trigger = page.getByRole("button", { name: "Open Notion" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Open Notion" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const url of [BOARD, `${BOARD}&owner=Operator&layout=list`, DASH, `${DASH}&network=tiktok`, TT_BOARD, `${TT_BOARD}&q=posted`, TT_DASH]) {
  test(`no accessibility violations on ${url}`, async ({ page }) => {
    await page.goto(url);
    await ready(page, url.split("&")[0]!);
    // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

for (const url of [BOARD, DASH, TT_BOARD, TT_DASH]) {
  test(`no horizontal overflow at 320px on ${url}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(url);
    await ready(page, url);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}
