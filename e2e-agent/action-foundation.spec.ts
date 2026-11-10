import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { approvalFixture, approvalTestScope as scope } from "../src/creator-agent/approvals/fixtures.testkit.ts";
import { actionDomainFixture } from "../src/creator-agent/actions/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";
import { DispatchError, type DispatchHandler } from "../src/creator-agent/jobs/dispatchSchema.ts";

// Entirely fictional source adapters. Browser actions traverse the actual scoped HTTP/SQLite service.
const workerToken = "synthetic-browser-fixture-machine-worker-not-a-production-secret";
let app: ReturnType<typeof createAgentServer>, a: ReturnType<typeof approvalFixture>, d: ReturnType<typeof actionDomainFixture>;
let calls = 0, unknown = false;
let preview: Awaited<ReturnType<ReturnType<typeof createAgentServer>["actionFoundation"]["execute"]>>;

// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}) => {
  calls = 0; unknown = false; a = approvalFixture(); d = actionDomainFixture(3);
  const now = Date.now(); a.state.now = now; d.tick(now - d.now());
  a.policy.observedAt = a.at(); a.policy.validUntil = a.until();
  a.draft.actionKind = "synthetic-local-task"; a.command.actionKind = a.draft.actionKind; a.draft.phase = "other";
  a.draft.acquisitionTerms = null; a.draft.effects.sendsCreator = false; a.draft.sourceValidUntil = a.until(); a.draft.expiresAt = a.until();
  for (const gate of Object.values(a.draft.gates)) if (gate?.state === "satisfied") gate.validUntil = a.until();
  a.draft.items = [0, 1, 2].map(n => ({ ...a.draft.items[0]!, itemRef: "synthetic:item-" + n, targetRef: "synthetic:task-" + n }));
  a.draft.bounds.maxItems = 3; a.command.selectionRefs = a.draft.items.map(item => item.itemRef);
  for (const human of a.humans.values()) { human.observedAt = a.at(); human.validUntil = a.until(); }
  a.humans.set("agent-reviewer", { ...structuredClone(a.humans.get("synthetic:requester")!), principalRef: "agent-reviewer", roles: ["founder"] });
  d.source.scope = scope; d.source.observedAt = a.at(); d.source.validUntil = a.until(); d.source.phase = "effective-l-minus-4";
  d.source.launchDate = new Date(now + 4 * 86_400_000).toISOString().slice(0, 10);
  d.snapshot.scope = scope; d.snapshot.asOf = a.at(); d.snapshot.validUntil = a.until();
  const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Fictional local artifact; no money, inventory, provider calls or quota consumption." };
  const handler: DispatchHandler = { policyVersion: a.policy.version, idempotency: "source-enforced", sourceEffect: "localArtifact", provider: na,
    resources: () => ({ budget: na, stock: na, quota: na }), budgets: { maxItems: 100, maxSteps: 1000, maxAttempts: 2, maxRunMs: 300000, leaseMs: 10000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async c => { calls++; return unknown ? { state: "unknown", reasonCode: "SYNTHETIC_LOST_ACK" } : { state: "applied", receipt: {
      receiptRef: "synthetic-local-artifact-" + c.intent.approval.itemRef, dispatchKey: c.dispatchKey, payloadHash: c.intent.approval.payloadHash,
      handlerRef: c.intent.handlerRef, providerBindingHash: c.providerBindingHash, sourceEffect: "localArtifact", observedAt: a.at() } }; },
    reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_SOURCE_UNAVAILABLE" }) };
  app = createAgentServer({ databasePath: ":memory:", workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => a.state.now },
    actionFoundation: { approvals: { sources: a.sources, registry: a.options.registry, currentPolicy: a.options.currentPolicy },
      registry: new Map([[a.draft.actionKind, { handlerRef: "synthetic-local-task.v1" }]]), handlers: new Map([["synthetic-local-task.v1", handler]]),
      ledger: d.ledger, readinessTargetRef: d.source.targetRef, readiness: { ...d.readiness, write: async intent => {
        const result = await d.readiness.write(intent); a.state.now = d.now(); return result;
      } }, worker: { token: workerToken, workerRef: "synthetic-browser-worker", resolve: async (s, runRef) => ({ scope: s, runRef,
        workerRef: "synthetic-browser-worker", authorityVersion: "synthetic-worker-v1", observedAt: a.at(), validUntil: a.until() }),
        assertCurrent: proof => { if (proof.authorityVersion !== "synthetic-worker-v1") throw new DispatchError("FORBIDDEN", 403); } } } });
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
  preview = await app.actionFoundation.execute({ schemaVersion: SCHEMA_VERSION, requestId: "synthetic-native-preview",
    requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" },
    operation: "previewAction", actionKind: a.draft.actionKind, entityRefs: [], expectedVersion: a.command.entityVersion,
    approvalRef: null, manifestRef: null, runRef: null, idempotencyKey: "synthetic-browser-preview",
    payload: { entityRef: a.command.entityRef, entityVersion: a.command.entityVersion, selectionRefs: a.command.selectionRefs } }, "agent-reviewer");
});
test.afterEach(async () => { await app.close(); a.db.close(); });
async function login(page: Page) {
  expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + SYNTHETIC_REVIEW_TOKEN } })).ok()).toBe(true);
}
async function worker(runRef: string) {
  return fetch(`http://127.0.0.1:${process.env.E2E_AGENT_SERVER_PORT}/v1/worker/dispatch`, {
    method: "POST", headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" }, body: JSON.stringify({ runRef }) });
}
async function approve() {
  const current = app.actionFoundation.approvals.readApproval(preview.approvalRef!)!;
  const event = a.event(current); await app.actionFoundation.approvals.observeDecision(event.locator, { ingressRef: "synthetic-trusted-source-ingress" });
}
async function capture(page: Page, directory: string, name: string) {
  mkdirSync(directory, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.screenshot({ path: `${directory}/${name}-${width}.png`, fullPage: true });
  }
}
async function compareOriginal(page: Page, name: string, original: string | undefined) {
  if (!original) return; // Private originals are intentionally absent from public CI artifacts.
  const out = resolve(".handoff/approval-foundation/original-comparisons", name); mkdirSync(out, { recursive: true });
  const state = resolve(out, "synthetic-session.json");
  await page.context().storageState({ path: state });
  try {
    const result = await promisify(execFile)(process.execPath, ["scripts/compare-figma.mjs", new URL(page.url()).pathname + new URL(page.url()).search, original], {
      env: { ...process.env, BASE_URL: new URL(page.url()).origin, FIGMA_COMPARE_BROWSER_CHANNEL: process.env.E2E_AGENT_BROWSER_CHANNEL,
        FIGMA_COMPARE_STORAGE_STATE: state, FIGMA_COMPARE_OUTPUT_DIR: out }, timeout: 60000 });
    writeFileSync(resolve(out, "comparison.json"), result.stdout);
  } finally { rmSync(state, { force: true }); }
}

test("native approval and finite batch controls use actual HTTP, separate worker authority and local artifact receipts", async ({ page }, info) => {
  test.setTimeout(180000); const dir = process.env.FARDA_ACTION_PROOF_DIR ?? info.outputPath("foundation-evidence");
  await login(page); await page.goto("/approvals/" + preview.approvalRef);
  await expect(page.getByRole("table", { name: "Exact approved manifest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve this version" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Queue selected approved items" })).toBeDisabled();
  await capture(page, dir, "approval-pending");
  await page.getByRole("button", { name: "Request source approval" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Command acknowledged" })).toBeVisible(); expect(calls).toBe(0);
  await approve(); await page.getByRole("button", { name: "Refresh approval evidence" }).click();
  await expect(page.getByRole("button", { name: "Queue selected approved items" })).toBeEnabled();
  await capture(page, dir, "approval-approved");
  await compareOriginal(page, "approval", process.env.FARDA_COMPARE_APPROVAL);
  await page.getByRole("button", { name: "Queue selected approved items" }).click();
  const link = page.getByRole("link", { name: "Open recorded run" }); await expect(link).toBeVisible(); expect(calls).toBe(0);
  await link.click(); await expect(page.getByRole("heading", { name: "Exact work, step by step." })).toBeVisible();
  await page.getByRole("button", { name: "Pause run", exact: true }).click(); await expect(page.getByTestId("native-run-status")).toHaveText("New work paused");
  await page.getByRole("button", { name: "Resume guarded work" }).click();
  const runRef = page.url().split("/runs/")[1]!.split("?")[0]!;
  await capture(page, dir, "run-queued"); expect((await worker(runRef)).status).toBe(200);
  await page.getByRole("button", { name: "Refresh run evidence" }).click();
  await expect(page.getByTestId("native-run-status")).toHaveText("All item receipts confirmed");
  expect(calls).toBe(3); await expect(page.getByRole("table", { name: "Finite run item outcomes" })).toContainText("Local artifact confirmed");
  await capture(page, dir, "run-local-artifacts");
  a.humans.get("agent-reviewer")!.active = false;
  await page.getByRole("button", { name: "Refresh run evidence" }).click();
  await expect(page.getByRole("table", { name: "Finite run item outcomes" })).toHaveCount(0);
  writeFileSync(`${dir}/provenance.json`, JSON.stringify({ source: "Actual local HTTP/SQLite with explicitly fictional source adapters and three local-artifact receipts", providerCalls: 0, businessWrites: 0, localArtifactCount: calls }, null, 2));
});

test("native launch lost acknowledgment recovers exact original source receipt after reload without browser-persisted rationale", async ({ page }, info) => {
  test.setTimeout(180000); const dir = process.env.FARDA_ACTION_PROOF_DIR ?? info.outputPath("foundation-evidence");
  await login(page); await page.goto("/launch?view=control");
  await expect(page.getByRole("table", { name: "Launch gates", exact: true })).toBeVisible(); await capture(page, dir, "launch-current");
  await compareOriginal(page, "launch", process.env.FARDA_COMPARE_LAUNCH);
  const gates = page.locator('[role="region"][aria-label="Launch gates"][tabindex="0"]');
  await gates.focus(); await page.keyboard.press("ArrowRight"); await expect.poll(() => gates.evaluate(e => e.scrollLeft)).toBeGreaterThan(0);
  const keys: string[] = []; await page.route("**/v1/action", async route => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (keys.length === 1) { const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.fulfill({ status: 502, contentType: "application/json", json: { code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain", retryable: false } });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Record in Notion", exact: true }).click();
  await page.getByLabel("Rationale", { exact: true }).fill("Fictional private readiness rationale for receipt recovery");
  await capture(page, dir, "launch-record-dialog");
  const dialog = page.getByRole("dialog", { name: "Record a launch-readiness decision" });
  await dialog.getByRole("button", { name: "Close", exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Record decision", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect.poll(() => d.state.writes).toBe(1); await expect(page).toHaveURL(/readinessRequestKey=/);
  // Test-only inspection verifies that neither storage area contains the protected rationale; no storage mutation occurs.
  // eslint-disable-next-line no-restricted-globals
  expect(await page.evaluate(() => JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]))).not.toContain("Fictional private readiness rationale");
  await page.reload(); await expect(page.getByText("The exact Notion readiness receipt is verified. No release was granted.", { exact: true })).toBeVisible();
  expect(keys).toHaveLength(1); expect(d.state.writes).toBe(1); expect(calls).toBe(0);
  await capture(page, dir, "launch-recovered-receipt");
  await page.getByRole("button", { name: "Finish reconciliation" }).click(); await expect(page).not.toHaveURL(/readinessRequestKey=/);
});

test("native run uncertainty stays source-reconciliation-only with immutable original key and failed current access clears data", async ({ page }, info) => {
  test.setTimeout(180000); const dir = process.env.FARDA_ACTION_PROOF_DIR ?? info.outputPath("foundation-evidence");
  await app.actionFoundation.approvals.requestDecision({ approvalRef: preview.approvalRef!, expectedVersion: 1 }, { principalRef: "agent-reviewer" }, "synthetic-source-request");
  await approve(); unknown = true;
  const current = app.actionFoundation.approvals.readApproval(preview.approvalRef!)!;
  const run = await app.actionFoundation.execute({ schemaVersion: SCHEMA_VERSION, requestId: "synthetic-unknown-handoff",
    requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" }, operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction",
    entityRefs: [], expectedVersion: app.actionFoundation.service.approvalVersion(current), approvalRef: preview.approvalRef, manifestRef: preview.manifestRef,
    runRef: null, idempotencyKey: "synthetic-uncertain-batch", payload: {} }, "agent-reviewer");
  expect((await worker(run.runRef!)).status).toBe(502); expect(calls).toBe(3);
  await login(page); await page.goto(`/runs/${run.runRef}?tab=recovery`);
  await expect(page.getByRole("heading", { name: "Confirm before trying again." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue guarded original work" })).toBeDisabled();
  await capture(page, dir, "run-uncertain-recovery");
  expect((await worker(run.runRef!)).status).toBe(502); expect(calls).toBe(3);
  a.humans.get("agent-reviewer")!.active = false;
  await page.getByRole("button", { name: "Refresh run evidence" }).click();
  await expect(page.getByRole("table", { name: "Finite run item outcomes" })).toHaveCount(0);
  expect(app.actionFoundation.dispatch.read(run.runRef!, false).executionCertainty).toBe("uncertain");
});
