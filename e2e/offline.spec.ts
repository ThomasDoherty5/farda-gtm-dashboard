import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** Real browser connectivity (context.setOffline), not an adapter fault: navigator.onLine and the online/offline events. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const status = (page: Page) => page.getByTestId("connection-status");
const violations = async (page: Page) =>
  // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
  (await new AxeBuilder({ page: page as never }).withTags(TAGS).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);

async function layout(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)];
    };
    return Array.from(document.querySelectorAll("main, main h1, main h2, header")).map(rect);
  });
}

test.describe("overview", () => {
  test("offline says figures are stale, shifts nothing, passes axe, and clears on reconnect", async ({ page, context }) => {
    await page.goto("/overview");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
    await expect(status(page)).toBeEmpty();
    const before = await layout(page);
    const bodyBefore = await page.locator("main").innerText();
    await page.evaluate(() => {
      (window as unknown as { shifts: number }).shifts = 0;
      new PerformanceObserver((list) => { for (const e of list.getEntries() as unknown as { hadRecentInput: boolean; value: number }[]) if (!e.hadRecentInput) (window as unknown as { shifts: number }).shifts += e.value; }).observe({ type: "layout-shift", buffered: false });
    });

    await context.setOffline(true);
    await expect(status(page)).toContainText("You're offline");
    await expect(status(page)).toContainText("as of the last successful read");
    await expect(status(page)).toContainText("may be stale");
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await expect.poll(() => layout(page)).toEqual(before);
    expect(await page.evaluate(() => (window as unknown as { shifts: number }).shifts)).toBe(0);
    expect(await page.locator("main").innerText()).toBe(bodyBefore); // nothing became a zero, N/A or blank
    expect(await violations(page)).toEqual([]);
    // Still there after time passes: a live region, not a toast.
    await page.waitForTimeout(1500);
    await expect(status(page)).toContainText("You're offline");

    await context.setOffline(false);
    await expect(status(page)).toBeEmpty();
    await expect.poll(() => layout(page)).toEqual(before);
    expect(await violations(page)).toEqual([]);
  });
});

test.describe("approvals", () => {
  test("approving offline is not sent and never reads as approved; the retry after reconnect succeeds", async ({ page, context }) => {
    await page.goto("/approvals/demo-approval-exact");
    await expect(page.getByTestId("approval-status")).toContainText("Pending");
    await context.setOffline(true);
    await expect(status(page)).toContainText("You're offline");
    expect(await violations(page)).toEqual([]);
    await page.getByRole("button", { name: "Approve this version" }).click();
    const error = page.getByTestId("action-error");
    await expect(error).toContainText("Nothing was sent");
    await expect(page.getByTestId("approval-status")).toContainText("Pending");
    await expect(page.getByTestId("approval-status")).not.toContainText("Approved");
    await expect(page.getByTestId("source-receipt")).toHaveCount(0);

    await context.setOffline(false);
    await expect(status(page)).toBeEmpty();
    await page.getByRole("button", { name: "Approve this version" }).click();
    await expect(page.getByTestId("approval-status")).toContainText("Approved, awaiting dispatch");
  });
});

test.describe("a screen with a save", () => {
  test("a draft saved offline is not saved; saving after reconnect is", async ({ page, context }) => {
    await page.goto("/automations/zap-12/schedule");
    await page.getByLabel("Cadence").selectOption("daily");
    await context.setOffline(true);
    await expect(status(page)).toContainText("You're offline");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Nothing was sent/).first()).toBeVisible();
    await expect(page.getByText(/Saved as version/)).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await context.setOffline(false);
    await expect(status(page)).toBeEmpty();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByTestId("save-status")).toContainText("Saved as version 2");
  });
});
