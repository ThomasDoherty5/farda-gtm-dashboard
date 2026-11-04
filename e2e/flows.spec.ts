import { expect, test, type Page } from "@playwright/test";

/**
 * The main journeys, each walked by clicking from screen to screen the way the prototype's flows do, with the honest state checked
 * at each stop. They run on the desktop project: the same links exist on mobile, but the checks here are about state, not layout.
 * What the prototype draws and the app doesn't is listed in docs/design-map.md ("Prototype flow coverage").
 */
test.skip(({ viewport }) => (viewport?.width ?? 0) < 1000, "Journeys run at desktop width; mobile layout is covered by responsive.spec.ts");

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
const path = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;

test("flow 5 · approval: pending, approved is not sent, sent only with a source receipt", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/approvals");
  await page.getByRole("link", { name: "Exact approval, then send" }).click();
  const status = page.getByTestId("approval-status");
  await expect(status).toContainText("Pending");
  // Nothing offers to send before the approval is decided.
  await expect(page.getByRole("button", { name: "Send approved action" })).toHaveCount(0);
  await page.getByRole("button", { name: "Approve this version" }).click();
  await expect(status).toContainText("Approved, awaiting dispatch");
  await expect(page.getByTestId("source-receipt")).toHaveCount(0);
  await page.getByRole("button", { name: "Send approved action" }).click();
  await expect(page.getByTestId("source-receipt")).toContainText("synthetic demo receipt");
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  expect(errors).toEqual([]);
});

test("flow 11 · recovery: an unknown outcome stays unknown until the source shows a receipt", async ({ page }) => {
  await page.goto("/approvals/demo-approval-uncertain");
  await page.getByRole("button", { name: "Approve this version" }).click();
  await page.getByRole("button", { name: "Send approved action" }).click();
  await expect(page.getByTestId("approval-status")).toContainText("Outcome unknown");
  await expect(page.getByTestId("source-receipt")).toHaveCount(0);
  await page.getByRole("link", { name: "Open recovery" }).click();
  await expect(page).toHaveURL(/\/runs\/demo-run-uncertain\?tab=recovery$/);
  // The recovery controls give no way to claim an outcome before the source has been checked.
  await expect(page.getByRole("button", { name: "Record confirmed sent" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Check the source" }).click();
  await expect(page.getByTestId("reconciliation")).toContainText("demo-source-receipt-prior");
  await page.getByRole("button", { name: "Record confirmed sent" }).click();
  await expect(page.getByTestId("run-status")).toContainText("Sent, source receipt on file");
});

test("flow 3 · acquisition journey: pipeline, evidence, invitation, collaboration", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/creators/pipeline");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Pipeline to evidence. A saved draft is not a completed review.
  await page.getByRole("link", { name: "Review evidence" }).first().click();
  await expect(page).toHaveURL(/\/creators\/[^/]+\/evidence\/[^/]+$/);
  await page.getByLabel("Original video URL").fill("https://www.instagram.com/reel/FLOWREEL001/");
  await page.getByRole("button", { name: "Add time-coded observation" }).click();
  const dialog = page.getByRole("dialog", { name: "Add time-coded observation" });
  await dialog.getByLabel("From (m:ss)").fill("0:00");
  await dialog.getByLabel("To (m:ss)").fill("0:08");
  await dialog.getByLabel("Observation").fill("Opens on a desk setup.");
  await dialog.getByRole("button", { name: "Add observation" }).click();
  await page.getByRole("button", { name: "Save partial review" }).first().click();
  await expect(page.getByTestId("save-status")).toContainText("A saved draft is not a completed review");
  await expect(page.getByRole("button", { name: "Mark watched" }).first()).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("readiness")).toContainText("No completed review exists");

  // Evidence to the TikTok dashboard, then to the invitation.
  await page.getByRole("link", { name: "TikTok Shop" }).first().click();
  await expect(page).toHaveURL(/\/creators\/tiktok/);
  await page.getByRole("link", { name: "Prepare invitation" }).first().click();
  await expect(page).toHaveURL(/\/creators\/tiktok\/invitations\/new$/);
  await expect(page.getByTestId("demo-banner")).toBeVisible();

  // Invitation to the creator's collaboration, through the Social Cat lifecycle.
  await page.getByRole("link", { name: "Social Cat dashboard" }).first().click();
  await expect(page).toHaveURL(/\/creators\/social-cat\?view=dashboard$/);
  await page.getByRole("link", { name: "Open creator lifecycle" }).first().click();
  await expect(page).toHaveURL(/\/creators\/social-cat\?view=board$/);
  await page.getByRole("link", { name: /View collaboration/ }).first().click();
  await expect(page).toHaveURL(/\/collaborations\/[^/?]+\?tab=overview$/);
  await page.getByRole("link", { name: "Content", exact: true }).first().click();
  await expect(page).toHaveURL(/tab=content$/);
  expect(errors).toEqual([]);
});

test("flow 7 · finance close: an open month stays open, and a statement match is queued, not reconciled", async ({ page }) => {
  await page.goto("/finance");
  await page.getByRole("link", { name: "Open month-end close" }).first().click();
  await expect(page).toHaveURL(/\/finance\/close\/2026-10$/);
  await expect(page.getByTestId("close-notice")).toContainText("Open month");
  await expect(page.getByTestId("metric-Close progress")).toHaveText(/^\d+ \/ \d+$/);
  await page.getByRole("button", { name: "Open reconciliation" }).click();
  const reconciliation = page.getByRole("dialog", { name: /reconciliation/i });
  await expect(reconciliation).toContainText("Opening this does not close the books");
  await reconciliation.getByRole("link", { name: "Payout reconciliation" }).click();
  await expect(page).toHaveURL(/\/finance\/settlements\/COMM-DEMO-D$/);
  await page.getByRole("button", { name: "Match statement" }).click();
  const dialog = page.getByRole("dialog", { name: "Match the provider statement" });
  await dialog.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByTestId("match-status")).toContainText("Nothing is marked reconciled");
  await expect(page.getByTestId("metric-Ledger reconciliation")).toHaveText("Pending");
});

test("flow 6 · operations returns: prepared is not approved, close is gated, and a resolved return links back to support", async ({ page }) => {
  await page.goto("/operations");
  await page.getByRole("link", { name: "View order" }).first().click();
  await expect(page).toHaveURL(/\/orders\/TEST-SH-1042$/);

  await page.goto("/returns/TEST-RET-028");
  await page.getByRole("button", { name: "Prepare browser task" }).click();
  await expect(page.getByTestId("proposal-status")).toContainText("waiting for approval");
  await expect(page.getByRole("button", { name: /Close unavailable/ })).toHaveAttribute("aria-disabled", "true");

  await page.goto("/returns/TEST-RET-028?scenario=resolved");
  await expect(page.getByTestId("return-chain")).toBeVisible();
  await expect(page.getByTestId("metric-Refunded")).toContainText("refunded");
  await page.getByRole("button", { name: "Open case to reopen" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("link", { name: "Back to support" }).click();
  await expect(page).toHaveURL(/\/support\/cases\//);
  expect(path(page)).toMatch(/^\/support\/cases\//);
});
