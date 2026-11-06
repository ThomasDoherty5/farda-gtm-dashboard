import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { assetTestScope, syntheticAsset, syntheticAssetAuthority } from "../src/creator-agent/assetTestFixtures.ts";
import { syntheticPortfolioPacket } from "../src/creator-agent/portfolioTestFixtures.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";

const port = Number(process.env.E2E_AGENT_SERVER_PORT);
const service = `http://127.0.0.1:${port}`;
const firstId = "synthetic-collaboration-a";
const secondId = "synthetic-collaboration-b";
let app: ReturnType<typeof createAgentServer>;

async function seed(path: string, key: string, body: unknown) {
  const response = await fetch(service + path, {
    method: "POST", headers: { authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}`, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
  expect(response.status, `Fixture request to ${path} returned ${response.status}`).toBe(200);
}

test.beforeAll(async () => {
  const { authority } = syntheticAssetAuthority();
  app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    ...assetTestScope, assetAuthority: { ...authority, currentRights: async () => null } });
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(port, "127.0.0.1", resolve); });
  const packet = syntheticPortfolioPacket();
  const creator = packet.creators[0]!;
  creator.collaborations = [{ ...creator.collaborations[0]!, collaborationId: firstId }];
  await seed("/v1/portfolio/reviews", "synthetic-browser-review", { scope: assetTestScope, expectedVersion: 0, packet });

  // Two collaborations share both creator and campaign, but only the first owns the review and these files.
  for (let i = 0; i < 25; i++) {
    const assetId = `synthetic-a-${String(i).padStart(2, "0")}`;
    const submission = syntheticAsset({ assetId, creatorId: creator.creatorId, collaborationId: firstId, campaignId: packet.campaignId });
    await seed("/v1/assets/ingest", assetId, { scope: assetTestScope, expectedVersion: 0, submission });
  }
  const derivative = syntheticAsset({ assetId: "synthetic-a-cut", creatorId: creator.creatorId, collaborationId: firstId, campaignId: packet.campaignId,
    lineage: { parentAssetId: "synthetic-a-00", parentVersion: 1, changes: ["cut"], editorRef: "synthetic-editor", provenanceRef: "synthetic-edit" } });
  await seed("/v1/assets/ingest", "synthetic-derivative", { scope: assetTestScope, expectedVersion: 0, submission: derivative });
  const other = syntheticAsset({ assetId: "synthetic-b-only", creatorId: creator.creatorId, collaborationId: secondId, campaignId: packet.campaignId });
  await seed("/v1/assets/ingest", "synthetic-b-only", { scope: assetTestScope, expectedVersion: 0, submission: other });
});
test.afterAll(async () => { if (app) await app.close(); });

async function signIn(page: Page) {
  const response = await page.request.get("/v1/session", { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
  expect(response.ok()).toBe(true);
}

test("the authenticated route pages saved evidence, isolates collaborations and renders a confirmed empty local result", async ({ page }) => {
  await signIn(page);
  await page.goto(`/collaborations/${firstId}?tab=overview`);
  const evidence = page.getByTestId("collaboration-evidence");
  await expect(evidence).toContainText("Showing 25 of 27 saved records");
  await expect(evidence).not.toContainText("synthetic-b-only");
  const more = evidence.getByRole("button", { name: "Load more evidence" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(evidence).toContainText("Showing 27 of 27 saved records");
  await expect(evidence).toContainText("Portfolio recommendation");
  await expect(evidence).toContainText("synthetic-a-00 · version 1");
  await expect(evidence).toContainText("Unverified");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/collaborations/${secondId}?tab=content`);
  await expect(evidence).toContainText("Showing 1 of 1 saved records");
  await expect(evidence).toContainText("synthetic-b-only");
  await expect(evidence).not.toContainText("synthetic-a-cut");
  await expect(evidence).not.toContainText("Portfolio recommendation");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".handoff/figma/collaboration-sandbox-evidence-mobile.png", fullPage: true });
  await page.goto("/collaborations/synthetic-empty?tab=overview");
  await expect(evidence).toContainText("No matching records in the saved asset and portfolio stores.");
});

test("losing the reader session during paging clears previously visible saved records", async ({ page, context }) => {
  await signIn(page);
  await page.goto(`/collaborations/${firstId}?tab=content`);
  const evidence = page.getByTestId("collaboration-evidence");
  await expect(evidence).toContainText("synthetic-a-00");
  await context.clearCookies();
  await evidence.getByRole("button", { name: "Load more evidence" }).click();
  await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("synthetic-a-00");
});
