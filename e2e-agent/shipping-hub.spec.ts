import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { shippingHubSourceFixture } from "../src/creator-agent/shippingHubRead.testkit.ts";
import { ShippingHubReadError, type ShippingHubSnapshot } from "../src/creator-agent/shippingHubRead.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";

let directory: string, app: ReturnType<typeof createAgentServer>;
let denied = false, revision = "synthetic-hub-v1", partial = false;
let lastSnapshot: ShippingHubSnapshot;
test.beforeEach(async ({ page }) => {
  directory = mkdtempSync(join(tmpdir(), "native-shipping-hub-")); denied = false; partial = false; revision = "synthetic-hub-v1";
  app = createAgentServer({ databasePath: join(directory, "db.sqlite"), workspaceId: "synthetic-hub-workspace", accountId: "synthetic-hub-account",
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    shippingHubSource: {
      async read(binding) {
        const at = Date.now(), packet = shippingHubSourceFixture(binding, at);
        packet.sourceVersion = revision; packet.validUntil = new Date(at + 600_001).toISOString();
        for (const owner of packet.owners) owner.validUntil = packet.validUntil;
        if (partial) { packet.shipments = []; packet.stock = []; packet.coverage = { state: "partial", expectedCount: null, observedCount: 0, reasonCodes: ["OWNER_COVERAGE_INCOMPLETE"] }; }
        lastSnapshot = packet; return packet;
      },
      assertCurrent(snapshot) {
        if (denied) throw new ShippingHubReadError("SOURCE_DENIED", 403);
        if (snapshot.sourceVersion !== revision) throw new ShippingHubReadError("SOURCE_CHANGED", 409);
      },
    },
  });
  await new Promise<void>(resolve => app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve));
  expect((await page.request.get("/v1/session", { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } })).ok()).toBe(true);
});
test.afterEach(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });

test("both recipient types preserve independent origins, delivery proof and held label authority", async ({ page }) => {
  const writes: string[] = []; page.on("request", request => { if (request.method() === "POST" && !request.url().endsWith("/v1/read")) writes.push(request.url()); });
  await page.goto("/operations?view=hub&scenario=unknown");
  const queue = page.getByRole("table", { name: "Shared shipment queue" });
  await expect(queue.getByRole("row")).toHaveCount(7);
  await expect(page.getByTestId("hub-recipients")).toHaveText("6");
  await expect(page.getByRole("status").filter({ hasText: "Synthetic owner evidence · sandbox" })).toBeVisible();
  const creator = queue.getByRole("row").filter({ hasText: "Creator" }).filter({ hasText: "DELIVERED" });
  await creator.getByRole("button").click();
  const detail = page.getByRole("dialog", { name: "Creator shipment" });
  await expect(detail).toContainText("Posting deadline · read-only");
  await expect(detail).toContainText("cannot restart the posting clock");
  await page.keyboard.press("Escape");
  await queue.getByRole("checkbox", { name: "Select visible shipments" }).check();
  await page.getByRole("button", { name: "Review 6 selected", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review label proposals" });
  await expect(review).toContainText("0 reviewable · 6 blocked");
  await expect(review.getByRole("button", { name: "Preview approval draft", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(review.getByRole("button", { name: "Purchase unavailable", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Creators · 3", exact: true }).click();
  await expect(queue.getByRole("row")).toHaveCount(4);
  await page.reload(); await expect(queue.getByRole("row")).toHaveCount(4);
  expect(writes).toEqual([]);
});

test("partial observations never become an empty success or zero total", async ({ page }) => {
  partial = true; await page.goto("/operations?view=hub");
  await expect(page.getByRole("heading", { name: "Shipment coverage incomplete" })).toBeVisible();
  await expect(page.getByTestId("hub-recipients")).toHaveText("Unknown");
  await expect(page.getByTestId("view-partial")).toBeVisible();
  await expect(page.getByText("Dispatch stock Unknown · no qualified stock rows supplied.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Shared shipment queue" })).toHaveCount(0);
});

test("source denial and a failed source refresh remove protected rows and open drawers immediately", async ({ page }) => {
  await page.goto("/operations?view=hub");
  const queue = page.getByRole("table", { name: "Shared shipment queue" }); await expect(queue).toBeVisible();
  await queue.getByRole("row").filter({ hasText: "Creator" }).filter({ hasText: "DELIVERED" }).getByRole("button").click();
  denied = true; await page.getByRole("dialog").getByRole("button", { name: "Refresh source evidence", exact: true }).click();
  await expect(queue).toHaveCount(0); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("hub-recipients")).toHaveCount(0);
  denied = false; await page.reload(); await expect(queue).toBeVisible();
  // The next source read has no current permission, even though the old lease is still valid.
  denied = true; await page.getByRole("button", { name: "Refresh source read", exact: true }).click();
  await expect(queue).toHaveCount(0);
});

test("an expired access lease clears source details without waiting for a network retry", async ({ page }) => {
  await page.clock.install(); await page.goto("/operations?view=hub");
  await expect(page.getByRole("table", { name: "Shared shipment queue" })).toBeVisible();
  expect(Date.parse(lastSnapshot.validUntil) - Date.parse(lastSnapshot.observedAt)).toBe(600_001);
  await page.clock.fastForward(600_002);
  await expect(page.getByRole("heading", { name: "Shipping access lease expired" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Shared shipment queue" })).toHaveCount(0);
  await expect(page.getByTestId("hub-recipients")).toHaveCount(0);
});

test("full source-layout evidence, responsive creator details and actual table and focus-return speech", async ({ page }, info) => {
  test.setTimeout(150_000); await page.goto("/operations?view=hub");
  const queue = page.getByRole("table", { name: "Shared shipment queue" }); await expect(queue).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`shipping-native-complete-${width}.png`), fullPage: true });
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenReaderCheckpoint(page, "shipping-hub-table-headers", page.getByRole("region", { name: "Shared shipment table" }), ["Shared shipment", "Recipient", "Shipment state", "Cost"], "KP_Enter");
  const trigger = queue.getByRole("row").filter({ hasText: "Creator" }).filter({ hasText: "DELIVERED" }).getByRole("button");
  await trigger.focus(); await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "Creator shipment" }); await expect(detail).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(detail.getByRole("heading", { name: "Creator shipment", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`shipping-native-creator-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await screenReaderCheckpoint(page, "shipping-hub-creator-focus-return", trigger, ["Inspect source evidence", "button"]);
});
