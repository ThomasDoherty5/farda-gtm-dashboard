import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PACKAGE = "/finance/close/2026-10?view=package";
const SCENARIOS = ["", "&scenario=open", "&scenario=awaitingcpa", "&scenario=readytoexport", "&scenario=exporting", "&scenario=exportfailed", "&scenario=partialexport", "&scenario=closed", "&scenario=lateadjustment", "&scenario=landedcost", "&scenario=refmismatch"];

test.describe("close package and corrections (fixture scenarios; not in the Figma source)", () => {
  test("the default close page keeps the height Figma 7:683 sets, with the link only inside the dialog", async ({ page, viewport }) => {
    test.skip(viewport?.width !== 1440, "Figma's reference is 1440 wide");
    await page.goto("/finance/close/2026-10");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(1471);
    await expect(page.getByRole("link", { name: "Close package and corrections" })).toHaveCount(0);
  });

  test("opens from the reconciliation dialog, shows the evidence and offers no close, sign-off, export or pay control", async ({ page }) => {
    await page.goto("/finance/close/2026-10");
    await page.getByRole("button", { name: "Open reconciliation" }).click();
    await page.getByRole("link", { name: "Close package and corrections" }).click();
    await expect(page).toHaveURL(/view=package/);
    await expect(page.getByRole("heading", { level: 1, name: "October close package" })).toBeVisible();
    await expect(page.getByTestId("package-notice")).toContainText("Period status: Open");
    await expect(page.getByRole("table", { name: "Report package v1" }).getByRole("row")).toHaveCount(8);
    await expect(page.getByRole("table", { name: "Commission reporting split" })).toContainText("N/A");
    await expect(page.getByRole("button", { name: /close (the )?(period|month|books)|sign off|approve|export|pay|rerun/i })).toHaveCount(0);
  });

  test("the summary and the package behind its link tell one story under every scenario", async ({ page }) => {
    const SUMMARY_SCENARIOS = SCENARIOS.map((s) => s.replace("&scenario=", ""));
    for (const scenario of SUMMARY_SCENARIOS) {
      const query = scenario ? `scenario=${scenario}` : "";
      await page.goto(`/finance/close/2026-10${query ? `?${query}` : ""}`);
      await expect(page.getByTestId("close-notice")).toBeVisible();
      const dd = page.locator('dl[aria-label="Close status"] dd');
      const cpa = (await dd.nth(1).textContent()) ?? "";
      const status = ((await dd.nth(2).textContent()) ?? "").trim();
      const unmatched = await page.getByTestId("exceptions").locator("tbody tr").count();
      await page.goto(`${PACKAGE}${query ? `&${query}` : ""}`);
      await expect(page.getByTestId("package-notice")).toContainText(`Period status: ${status}`);
      const differences = page.getByTestId("differences").locator("tbody tr");
      let notResolved = 0;
      for (let i = 0; i < (await differences.count()); i++) {
        const text = (await differences.nth(i).textContent()) ?? "";
        if (text.includes("Unresolved") || /Mismatch|No QuickBooks reference/.test(text)) notResolved++;
      }
      expect(notResolved, `${scenario || "default"}: unmatched payouts`).toBe(unmatched);
      const lifecycle = (await page.getByTestId("lifecycle").textContent()) ?? "";
      const expected = cpa.includes("Signed off") ? "Signed off" : cpa.includes("Requested") ? "Requested, not received" : "Not requested";
      expect(lifecycle, `${scenario || "default"}: CPA review`).toContain(expected);
    }
  });

  test("keeps the Figma wording when the month really is open, and names the other states", async ({ page }) => {
    await page.goto("/finance/close/2026-10");
    await expect(page.getByTestId("close-notice")).toContainText("Open month · 4 of 7 checks complete");
    await page.goto("/finance/close/2026-10?scenario=closed");
    await expect(page.getByTestId("close-notice")).toContainText("Closed · 7 of 7 checks complete");
    await page.goto("/finance/close/2026-10?scenario=reconciling");
    await expect(page.getByTestId("close-notice")).toContainText("Reconciling");
  });

  test("an unknown scenario is refused, never shown as another one", async ({ page }) => {
    await page.goto(`${PACKAGE}&scenario=reconciliing`);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("lifecycle")).toHaveCount(0);
  });

  test("a late adjustment reopens the period and leaves the prior package and paid receipt as they were", async ({ page }) => {
    await page.goto(`${PACKAGE}&scenario=lateadjustment`);
    await expect(page.getByTestId("package-notice")).toContainText("Reopened");
    await expect(page.getByTestId("package-v1")).toContainText("Preserved prior package");
    await expect(page.getByTestId("package-v1").getByText("Exported")).toHaveCount(7);
    await expect(page.getByTestId("package-v2").getByText("Not generated")).toHaveCount(7);
    await expect(page.getByTestId("adjustment")).toContainText("TEST-RCPT-0090 (unchanged)");
    await expect(page.getByTestId("receipts")).toContainText("Immutable");
  });

  test("months and the dry-run manifest are addressable and axe-clean", async ({ page }) => {
    for (const view of ["months", "manifest"]) {
      await page.goto(`/finance/close/2026-10?view=${view}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), view).toEqual([]);
    }
  });

  test("incomplete landed cost and a reference mismatch block the period", async ({ page }) => {
    await page.goto(`${PACKAGE}&scenario=landedcost`);
    await expect(page.getByTestId("package-notice")).toContainText("Blocked");
    await expect(page.getByTestId("blockers")).toContainText("Landed cost is missing");
    await page.goto(`${PACKAGE}&scenario=refmismatch`);
    await expect(page.getByTestId("blockers")).toContainText("does not match QuickBooks reference");
  });

  for (const scenario of SCENARIOS) {
    test(`no accessibility violations on the package${scenario ? ` (${scenario.slice(10)})` : ""}`, async ({ page }) => {
      await page.goto(PACKAGE + scenario);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });
  }

  test("no horizontal overflow at 320px on any scenario", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const scenario of SCENARIOS) {
      await page.goto(PACKAGE + scenario);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), scenario).toBeLessThanOrEqual(0);
    }
  });
});
