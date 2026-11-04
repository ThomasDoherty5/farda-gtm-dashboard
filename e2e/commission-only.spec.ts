import { expect, test } from "@playwright/test";

// Commission-only wording on the existing screens. Server-side enforcement is covered in the adapter unit tests.

test("the recruitment workbench refuses an upfront fee and says why", async ({ page }) => {
  await page.goto("/creators/social-cat/recruitment");
  await expect(page.getByTestId("metric-Historical allocation")).toBeVisible();
  await page.getByLabel("Affiliate terms").fill("15% · $150 upfront");
  await expect(page.getByText("New acquisition has no upfront or guaranteed fee. Use $0, or remove it.")).toBeVisible();
});

test("the TikTok invitation refuses a flat fee beside the commission", async ({ page }) => {
  await page.goto("/creators/tiktok/invitations/new");
  await expect(page.getByTestId("metric-Creator fit score")).toBeVisible();
  await page.getByLabel("Commission").fill("12% plus flat fee");
  await expect(page.getByText("New acquisition has no upfront or guaranteed fee.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send request · blocked" })).toBeVisible();
});

test("historical gifted, paid and hybrid stay readable, and cannot start new acquisition", async ({ page }) => {
  await page.goto("/creators/social-cat");
  for (const name of ["Gifted · history", "Paid · history", "Hybrid · history"]) {
    const tab = page.getByText(name).first();
    await expect(tab).toHaveAttribute("aria-disabled", "true");
    await expect(tab).toHaveAccessibleDescription(/no new gifted-only, paid or hybrid acquisition can start here/);
  }
});
