import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

const PAGES = [
  { name: "Content quality scorecard", path: "/creators/demo-creator-1/assessments/demo-assessment-content", source: "37:74", height: 2125, ready: "Priority score." },
  { name: "TikTok commerce scorecard", path: "/creators/demo-creator-1/assessments/demo-assessment-tiktok", source: "37:251", height: 2143, ready: "Priority score." },
  { name: "Offer and economics", path: "/offers/demo-offer-1", source: "65:634", height: 2080, ready: "The upside needs a downside test." },
  { name: "Social Cat commerce scorecard", path: "/creators/demo-creator-1/assessments/demo-assessment-sc-commerce", source: "65:814", height: 2284, ready: "A score you can explain." },
] as const;

test.describe("scorecards and offer against Figma at 1440", () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, "Figma's reference is 1440 wide");
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    return { x: Math.round(b!.x), w: Math.round(b!.width), h: Math.round(b!.height) };
  };

  for (const p of PAGES) {
    test(`${p.name} (${p.source}) is the design's height`, async ({ page }) => {
      await page.goto(p.path);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("heading", { name: p.ready })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(p.height);
    });
  }

  test("the weighted score card and gauge sit where 37:74 puts them", async ({ page }) => {
    await page.goto(PAGES[0].path);
    await page.evaluate(() => document.fonts.ready);
    expect(await box(page.locator("section[aria-labelledby=priority-title]"))).toMatchObject({ x: 72, w: 400, h: 557 });
    expect(await box(page.getByRole("img", { name: "Score 84 of 100" }))).toMatchObject({ w: 180, h: 180 });
  });

  test("the offer's waterfall draws every bar to one scale", async ({ page }) => {
    await page.goto(PAGES[2].path);
    await page.evaluate(() => document.fonts.ready);
    const bars = page.locator("[class*=chartBar]");
    await expect(bars).toHaveCount(7);
    const heights = [];
    for (let i = 0; i < 7; i++) heights.push((await box(bars.nth(i))).h);
    expect(heights).toEqual([244, 110, 37, 1, 1, 4, 93]);
  });
});

test.describe("accessibility", () => {
  for (const p of PAGES) {
    test(`${p.name} has no axe violations`, async ({ page }) => {
      await page.goto(p.path);
      await expect(page.getByRole("heading", { name: p.ready })).toBeVisible();
      const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });
  }
});

test("saving an offer draft shows the acknowledged version and keeps the edit", async ({ page }) => {
  await page.goto("/offers/demo-offer-1");
  const field = page.getByLabel("Commission type");
  await field.fill("12% of eligible merchandise");
  await expect(page.getByText(/Approval readiness is cleared/)).toBeVisible();
  await page.getByRole("button", { name: "Save offer draft" }).click();
  await expect(page.getByText(/Draft saved as version v2/)).toBeVisible();
  await expect(field).toHaveValue("12% of eligible merchandise");
});

test("an invalid commission can't be saved", async ({ page }) => {
  await page.goto("/offers/demo-offer-1");
  await page.getByLabel("Commission type").fill("150%");
  await page.getByRole("button", { name: "Save offer draft" }).click();
  await expect(page.getByText("The percentage must be above 0 and at most 100.")).toBeVisible();
  await expect(page.getByText(/Draft saved as version/)).toHaveCount(0);
});

test("Hold candidate stays read-only and explains why", async ({ page }) => {
  await page.goto("/creators/demo-creator-1/assessments/demo-assessment-content");
  const hold = page.getByRole("button", { name: "Hold candidate" });
  await expect(hold).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText(/Hold candidate is read-only: no current opportunity/)).toBeVisible();
});
