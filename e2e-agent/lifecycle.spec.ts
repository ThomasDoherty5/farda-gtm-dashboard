import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { lifecycleSourceFixture, lifecycleTestScope } from "../src/creator-agent/lifecycle/fixtures.testkit.ts";
import { LifecycleError } from "../src/creator-agent/lifecycle/source.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";
import type { NativeEmailFlow } from "../src/creator-agent/lifecycle/contract.ts";
import {screenReaderCheckpoint} from "./support/screen-reader";

async function listen(app: ReturnType<typeof createAgentServer>) {
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
}
async function login(page: Page) { expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + SYNTHETIC_REVIEW_TOKEN } })).ok()).toBe(true); }
const options = { databasePath: ":memory:", workspaceId: lifecycleTestScope.workspaceId, accountId: lifecycleTestScope.accountId, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN };

test("seven native lifecycle views use actual HTTP and SQLite, with locked gates, source states, keyboard and responsive evidence", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  let snapshot: ReturnType<typeof lifecycleSourceFixture> | null = lifecycleSourceFixture(lifecycleTestScope, Date.now()), denied = false;
  const app = createAgentServer({ ...options, lifecycleSource: async () => { if (denied) throw new LifecycleError("FORBIDDEN", 403); return structuredClone(snapshot); } });
  await listen(app);
  const dir = process.env.FARDA_LIFECYCLE_PROOF_DIR ?? testInfo.outputPath("lifecycle-evidence"); mkdirSync(dir, { recursive: true });
  const audit: unknown[] = [];
  const capture = async (name: string, title: string) => {
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await expect(page.getByText("Source current", { exact: true })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      await page.screenshot({ path: `${dir}/native-${name}-${width}.png`, fullPage: true }); audit.push({ name, width, violations: axe.violations.length });
    }
  };
  try {
    await login(page); await page.goto("/customers/lifecycle"); await capture("overview", "From first interest to everyday use.");
    await page.getByRole("link", { name: "Setup help", exact: true }).focus(); await page.keyboard.press("Enter");
    await capture("setup", "Setup help, with a clean exit."); expect(await page.getByRole("button", { name: "Save draft" }).count()).toBe(0);
    for (const [flow, title] of [["early-access", "A welcome that leads to launch."], ["abandoned-checkout", "Recover intent, without over-sending."], ["review-request", "Ask after the product arrives."]]) {
      await page.goto(`/customers/flows/${flow}`); await capture(flow!, title!);
      const policies = page.getByRole("checkbox"); await expect(policies).toHaveCount(3);
      for (const checkbox of await policies.all()) { await expect(checkbox).toBeChecked(); await expect(checkbox).toHaveAttribute("aria-readonly", "true"); await checkbox.focus(); await page.keyboard.press("Space"); await expect(checkbox).toBeChecked(); }
      await screenReaderCheckpoint(page,flow+"-locked-policy",policies.first(),["Recheck consent before send","checked"]);
      await page.getByRole("button", { name: "Preview template", exact: true }).focus(); await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Template preview" }) })).toContainText("Synthetic preview");
      await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Preview template", exact: true })).toBeFocused();
      await screenReaderCheckpoint(page,flow+"-dialog-focus-return",page.getByRole("button",{name:"Preview template",exact:true}),["Preview template","button"]);
      await page.getByLabel("Local draft title").fill("ab");
      await screenReaderCheckpoint(page,flow+"-validation",page.getByLabel("Local draft title"),["Local draft title","invalid","String must contain at least 3"],"KP_Enter",async()=>{
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        await expect(page.getByLabel("Local draft title")).toHaveAttribute("aria-invalid", "true");
      });
      await page.getByLabel("Local draft title").fill(`Reviewed ${flow} draft`); await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Draft persistence confirmed" })).toBeVisible();
      await screenReaderCheckpoint(page,flow+"-save-announcement",page.getByRole("button",{name:"Continue editing",exact:true}),["Draft persistence confirmed","Continue editing"]);
      await page.getByRole("button", { name: "Continue editing", exact: true }).click(); await page.reload();
      await expect(page.getByLabel("Local draft title")).toHaveValue(`Reviewed ${flow} draft`);
      await page.getByRole("button", { name: "Event handling", exact: true }).click();
      await expect(page.getByRole("table", { name: "Source-owned flow outcomes" })).toContainText("queued");
      await expect(page.getByRole("table", { name: "Source-owned flow outcomes" })).toContainText("suppressed"); await page.keyboard.press("Escape");
    }
    await page.goto("/customers/consent"); await capture("consent", "A clear view of who is eligible.");
    await page.getByRole("button", { name: "Review exclusions" }).focus(); await page.keyboard.press("Enter"); await expect(page.locator("#exclusions")).toBeFocused();
    const scroll = page.locator('[role="region"][aria-label="Why an enrollment stops"]'); await scroll.focus(); await page.keyboard.press("ArrowRight");
    await expect.poll(() => scroll.evaluate(e => e.scrollLeft)).toBeGreaterThan(0);
    // Orca's first-cell navigation subsequently resets horizontal position.
    await screenReaderCheckpoint(page,"consent-table-alternative",scroll,["Why an enrollment stops"]);
    await page.goto("/customers/activation"); await capture("activation", "Measure setup, then sustained use.");
    await expect(page.getByRole("region", { name: "First-week cohort" })).toContainText("do not prove ingestion");
    if(process.env.FARDA_SCREEN_READER_LOG){
      await screenReaderCheckpoint(page,"activation-cohort-dialog",page.getByRole("button",{name:"View cohort",exact:true}),["Cohort","dialog"],"Return");
      await expect(page.getByRole("dialog",{name:"Cohort",exact:true})).toContainText("Synthetic matched 14-day source cohort");
      await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"View cohort",exact:true})).toBeFocused();
    }
    snapshot = lifecycleSourceFixture(lifecycleTestScope, Date.now()); snapshot.version = "synthetic-zero-source";
    for (const key of ["total", "eligible", "withdrawn", "suppressed", "unknown"] as const) snapshot.consent![key] = { value: 0, missingReason: null };
    for (const key of ["delivered", "paired", "weekOne", "pairingFailureEvents"] as const) snapshot.activation![key] = { value: 0, missingReason: null };
    await page.goto("/customers/consent"); await expect(page.getByText("The observed population is zero. No percentage distribution is defined.")).toBeVisible();
    await page.goto("/customers/activation"); await expect(page.getByRole("progressbar")).toHaveCount(0); await expect(page.getByText("0 active / 0 paired", { exact: true })).toBeVisible();
    snapshot = null; await page.goto("/customers/flows/early-access"); await expect(page.getByText("Source unavailable", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Local draft title")).toHaveCount(0); await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("button", { name: "Draft history", exact: true }).click(); await expect(page.getByRole("table", { name: "Immutable draft revisions" })).toContainText("Reviewed early-access draft"); await page.keyboard.press("Escape");
    denied = true; await page.reload(); await expect(page.getByRole("alert").first()).toBeVisible(); await expect(page.getByRole("button", { name: "Draft history", exact: true })).toHaveCount(0);
    denied = false; snapshot = lifecycleSourceFixture(lifecycleTestScope, Date.now()); snapshot.version = "synthetic-recovered-source"; await page.reload();
    await expect(page.getByLabel("Local draft title")).toHaveValue("Reviewed early-access draft");
    writeFileSync(`${dir}/native-browser-proof.json`, JSON.stringify({ audit, source: "Actual local HTTP service and scoped SQLite; injected fictional aggregate authority", providerActions: 0 }, null, 2));
  } finally { await app.close(); }
});

test("a malformed acknowledgment and failed read survive reload with the original key until exact durable readback", async ({ page }) => {
  const snapshot = lifecycleSourceFixture(lifecycleTestScope, Date.now());
  const app = createAgentServer({ ...options, lifecycleSource: async () => structuredClone(snapshot) }); await listen(app);
  let writes = 0, blockReadback = true;
  try {
    await login(page);
    await page.route("**/v1/save", async route => {
      writes++; const response = await route.fetch(), body = await response.json();
      body.record.requestKey = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      await route.fulfill({ response, json: body });
    });
    await page.route("**/v1/read", async route => { const input = route.request().postDataJSON(); if (blockReadback && input.filters?.draftRequestKey) await route.abort("failed"); else await route.continue(); });
    await page.goto("/customers/flows/early-access"); await page.getByLabel("Local draft title").fill("Uncertain original draft");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("draftRequestKey")).not.toBeNull(); const key = new URL(page.url()).searchParams.get("draftRequestKey");
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.reload(); await expect(page.getByRole("alert").first()).toBeVisible(); expect(new URL(page.url()).searchParams.get("draftRequestKey")).toBe(key);
    blockReadback = false; await page.reload(); await expect(page.getByRole("heading", { name: "Draft persistence confirmed" })).toBeVisible();
    expect(writes).toBe(1); await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("button", { name: "Continue editing", exact: true }).click(); await expect(page.getByLabel("Local draft title")).toHaveValue("Uncertain original draft");
    expect(await page.evaluate(() => [Object.keys(window.localStorage), Object.keys(window.sessionStorage)])).toEqual([[], []]);
  } finally { await app.close(); }
});

test("an absent original request after reload remains held rather than issuing a new save", async ({ page }) => {
  const snapshot = lifecycleSourceFixture(lifecycleTestScope, Date.now());
  const app = createAgentServer({ ...options, lifecycleSource: async () => snapshot }); await listen(app);
  try {
    await login(page); await page.goto("/customers/flows/early-access?draftRequestKey=bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb");
    await expect(page.getByRole("heading", { name: "Save outcome needs readback" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Retry original request", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Continue editing", exact: true })).toHaveCount(0);
  } finally { await app.close(); }
});

test("no provider binding displays unknown populations and held local forms without demo fallbacks", async ({ page }) => {
  const app = createAgentServer(options); await listen(app);
  try {
    await login(page); await page.goto("/customers/lifecycle");
    await expect(page.getByText("Source unconfigured", { exact: true })).toBeVisible();
    await expect(page.getByText("428", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Early access", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("checkbox")).toHaveCount(3);
    await expect(page.getByLabel("Local draft title")).toHaveCount(0);
  } finally { await app.close(); }
});

test("a version conflict retains original edits and requires exact terminal rejection before rebasing", async ({ page }) => {
  const snapshot = lifecycleSourceFixture(lifecycleTestScope, Date.now());
  const app = createAgentServer({ ...options, lifecycleSource: async () => snapshot }); await listen(app);
  const requestedScope = { workspaceId: lifecycleTestScope.workspaceId, accountIds: [lifecycleTestScope.accountId], environment: "sandbox" };
  const headers = { authorization: "Bearer " + SYNTHETIC_REVIEW_TOKEN };
  try {
    await login(page); await page.goto("/customers/flows/early-access"); await page.getByLabel("Local draft title").fill("Original local correction");
    const read = await page.request.post("/v1/read", { headers, data: { schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "emailFlow", requestedScope, filters: { flow: "early-access" }, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "synthetic-external-read" } });
    expect(read.ok()).toBe(true); const view = (await read.json()).data as NativeEmailFlow, c = view.sourceConfig!, timing = c.timingRules[0]!, template = c.templates[0]!;
    const saved = await page.request.post("/v1/save", { headers, data: { schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope, resourceKind: "configurationDraft", resourceRef: "flow-early-access", expectedVersion: view.draftVersion, idempotencyKey: "synthetic-concurrent-change", requestId: "synthetic-external-save",
      payload: { entryEventRef: c.entryEvents[0]!.ref, timingRuleRef: timing.ref, timezone: timing.timezone, templateRef: template.ref, templateVersion: template.version, templateName: "Concurrent reviewed draft" } } });
    expect(saved.ok()).toBe(true);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Original request rejected" })).toBeVisible();
    await page.getByRole("button", { name: "Continue editing", exact: true }).click();
    await expect(page.getByLabel("Local draft title")).toHaveValue("Original local correction");
    await page.getByRole("button", { name: "Save draft", exact: true }).click(); await expect(page.getByRole("heading", { name: "Draft persistence confirmed" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Draft persistence confirmed" })).toContainText("revision 2");
  } finally { await app.close(); }
});

test("offline save never dispatches on reconnect and can only retry the original request explicitly", async ({ page, context }) => {
  const snapshot = lifecycleSourceFixture(lifecycleTestScope, Date.now());
  const app = createAgentServer({ ...options, lifecycleSource: async () => snapshot }); await listen(app);
  const writes: string[] = [];
  try {
    await login(page); await page.route("**/v1/save", async route => { writes.push(route.request().postDataJSON().idempotencyKey); await route.continue(); });
    await page.goto("/customers/flows/early-access"); await page.getByLabel("Local draft title").fill("Offline original draft");
    await context.setOffline(true); await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("draftRequestKey")).not.toBeNull(); const key = new URL(page.url()).searchParams.get("draftRequestKey");
    await expect(page.getByText("Nothing was sent.", { exact: true })).toBeVisible(); expect(writes).toEqual([]);
    await context.setOffline(false); await expect(page.getByRole("heading", { name: "Save outcome needs readback" })).toBeVisible();
    expect(writes).toEqual([]); await page.getByRole("button", { name: "Retry original request", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Draft persistence confirmed" })).toBeVisible(); expect(writes).toEqual([key]);
  } finally { await context.setOffline(false); await app.close(); }
});
