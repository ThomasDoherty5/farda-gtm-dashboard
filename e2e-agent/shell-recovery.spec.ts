import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { newOfferTerms, type OfferTerms } from "../src/creator-agent/offers/contract.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";

const port = Number(process.env.E2E_AGENT_SERVER_PORT);
const base = `http://127.0.0.1:${port}`;
const id = "synthetic-shell-offer";
const route = "/offers/" + id + "?from=review";
let app: ReturnType<typeof createAgentServer>;

async function seed(terms: OfferTerms, expectedVersion: string | null, key: string) {
  const response = await fetch(base + "/v1/offers/" + id, { method: "POST", headers: { authorization: "Bearer " + SYNTHETIC_REVIEW_TOKEN,
    "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ terms, expectedVersion }) });
  expect(response.status).toBe(200);
  return (await response.json()).version as string;
}
async function session(page: Page, token: string) {
  expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + token } })).ok()).toBe(true);
}
test.beforeEach(async () => {
  app = createAgentServer({ databasePath: ":memory:", workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN });
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(port, "127.0.0.1", resolve); });
});
test.afterEach(async () => { await app.close(); });

test("a native 409 keeps the offer field, route and context until explicit reload; Keep task restores the draft", async ({ page }) => {
  const terms = newOfferTerms("synthetic-shell-creator", "website", "synthetic-shell-brief");
  const version = await seed(terms, null, "seed-initial-version");
  await session(page, SYNTHETIC_REVIEW_TOKEN);
  await page.goto(route);
  const field = page.getByRole("textbox", { name: "Provider program reference" });
  await field.fill("program:local-edits");
  await seed({ ...terms, programRef: "program:other-reviewer" }, version, "seed-concurrent-version");
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/v1/save" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save offer draft" }).click();
  expect((await response).status()).toBe(409);
  await expect(field).toHaveValue("program:local-edits");
  await expect(page).toHaveURL(/\/offers\/synthetic-shell-offer\?from=review$/);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Operations" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard your edits?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep task" }).click();
  await expect(field).toHaveValue("program:local-edits");
  await expect(page).toHaveURL(/\/offers\/synthetic-shell-offer\?from=review$/);
  await page.getByRole("button", { name: "Load latest saved terms" }).first().click();
  await expect(field).toHaveValue("program:other-reviewer");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Operations" }).click();
  await expect(page).toHaveURL(/\/operations$/);
});

test("a native 403 after session downgrade clears the protected draft without submitting a second save", async ({ page }) => {
  await seed(newOfferTerms("synthetic-shell-creator", "website", "synthetic-shell-brief"), null, "seed-access-version");
  await session(page, SYNTHETIC_REVIEW_TOKEN);
  await page.goto(route);
  const field = page.getByRole("textbox", { name: "Provider program reference" });
  await field.fill("program:revoked-unsaved-value");
  await session(page, SYNTHETIC_READ_TOKEN);
  const writes: number[] = [];
  page.on("response", r => { if (new URL(r.url()).pathname === "/v1/save" && r.request().method() === "POST") writes.push(r.status()); });
  const forbidden = page.waitForResponse(r => new URL(r.url()).pathname === "/v1/save" && r.status() === 403);
  await page.getByRole("button", { name: "Save offer draft" }).click();
  await forbidden;
  await expect.poll(() => page.locator("input").evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).not.toContain("program:revoked-unsaved-value");
  await expect(page).toHaveURL(/\/offers\/synthetic-shell-offer\?from=review$/);
  expect(writes).toEqual([403]);
  const source = await fetch(base + "/v1/offers/" + id, { headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN } });
  expect((await source.json()).terms.programRef).toBeNull();
});
