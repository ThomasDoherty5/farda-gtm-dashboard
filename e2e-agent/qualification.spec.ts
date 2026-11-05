import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, request as apiRequest, test } from "@playwright/test";
import { syntheticAgentEvidence } from "../src/test/creatorQualification";
import { POLICY_VERSION } from "../src/creator-agent/assessmentSchema";

const service = `http://127.0.0.1:${process.env.E2E_AGENT_SERVER_PORT}`;
const app = `http://127.0.0.1:${process.env.E2E_AGENT_APP_PORT}`;
const creatorId = "synthetic-browser-creator";
const evidenceId = "synthetic-post-1";
const workspaceId = "synthetic-agent-browser-workspace";
const accountId = "synthetic-agent-browser-account";
const route = `/creators/${creatorId}/evidence/${evidenceId}`;
let directory: string | null = null;
let database = "";
// These credentials exist only in the test worker and child environment, never in a bundle or committed config.
const reader = randomBytes(32).toString("hex");
const reviewer = randomBytes(32).toString("hex");
let child: ChildProcess | null = null;
let startup = "";

async function startService() {
  startup = "";
  child = spawn(process.execPath, ["tools/creator-agent/run.mjs"], {
    env: { ...process.env, FARDA_AGENT_PORT: process.env.E2E_AGENT_SERVER_PORT, FARDA_AGENT_DATABASE: database,
      FARDA_AGENT_READ_TOKEN: reader, FARDA_AGENT_REVIEW_TOKEN: reviewer,
      FARDA_AGENT_WORKSPACE_ID: workspaceId, FARDA_AGENT_ACCOUNT_ID: accountId,
      FARDA_AGENT_ORIGIN: app, FARDA_AGENT_SECURE_COOKIES: "false", FARDA_AGENT_CONFIG: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { startup = (startup + chunk.toString()).slice(-8_000); });
  await expect.poll(async () => {
    if (child?.exitCode !== null) throw new Error(`Agent exited during startup: ${startup}`);
    try { return (await fetch(`${service}/health`)).status; } catch { return 0; }
  }, { timeout: 20_000, intervals: [100, 250, 500] }).toBe(200);
}

async function stopService() {
  const running = child;
  child = null;
  if (!running || running.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { running.kill("SIGKILL"); }, 3_000);
    running.once("exit", () => { clearTimeout(timer); resolve(); });
    running.kill("SIGTERM");
  });
}

test.beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "farda-agent-browser-")); database = join(directory, "evidence.sqlite"); });
test.afterAll(async () => { await stopService(); if (directory) rmSync(directory, { recursive: true, force: true }); });

test("the real agent persists its assessment and the existing evidence screen reads it without browser credentials or invented sales", async ({ page, context }, testInfo) => {
  await startService();
  const machine = await apiRequest.newContext({ baseURL: service, extraHTTPHeaders: { authorization: `Bearer ${reviewer}` } });
  try {
    const packet = syntheticAgentEvidence({ creatorId, evidenceRevision: "synthetic-browser-evidence-1", ratings: { routine: 0, demo: 4 } });
    const seeded = await machine.put(`/v1/creators/${creatorId}`, { headers: { "Idempotency-Key": randomUUID() }, data: { expectedVersion: 0, policyVersion: POLICY_VERSION, configHash: null, packet } });
    expect(seeded.status()).toBe(200);
    const receipt = await seeded.json();
    expect(receipt.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.assessment.criteria.routine).toBe(0);
    expect(receipt.assessment.config.status).toBe("unbound");

    const signIn = async () => {
      const answer = await context.request.get(`${service}/v1/session`, { headers: { authorization: `Basic ${Buffer.from(`reader:${reader}`).toString("base64")}` } });
      expect(answer.status()).toBe(200);
      expect(await context.cookies(app)).toEqual([expect.objectContaining({ name: "farda_agent", httpOnly: true, sameSite: "Strict" })]);
    };
    await signIn();
    const readAnswer = page.waitForResponse((response) => response.url() === `${app}/v1/read` && response.request().method() === "POST");
    await page.goto(route);
    const response = await readAnswer;
    expect(response.status()).toBe(200);
    expect(response.request().headers().authorization).toBeUndefined();
    const envelope = await response.json();
    expect(response.request().postDataJSON().requestedScope).toEqual({ workspaceId, accountIds: [accountId], environment: "sandbox" });
    expect(envelope.scope).toMatchObject({ workspaceId, accountIds: [accountId], environment: "sandbox" });
    expect(envelope.data.qualification.evidenceRevision).toBe(packet.evidenceRevision);
    expect(envelope.data.agentEvidence.creatorId).toBe(creatorId);
    await expect(page.getByTestId("metric-Routine compatibility")).toHaveText("0 / 5");
    await expect(page.getByTestId("metric-Creative quality")).toHaveText("4 / 5");
    await expect(page.getByTestId("metric-Published model")).toHaveText("Pending");
    await expect(page.getByTestId("metric-Commerce confidence")).toHaveText("Unknown");
    await expect(page.getByRole("button", { name: "Mark watched" }).first()).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("button", { name: "Inspect model status" }).click();
    const dialog = page.getByRole("dialog", { name: "Model status" });
    await expect(dialog.getByTestId("agent-qualification")).toContainText("Hold");
    await expect(dialog.getByRole("region", { name: "Agent assessment versions" })).toContainText(POLICY_VERSION);
    await expect(dialog.getByRole("region", { name: "Server-selected recent metadata baseline" })).toContainText("40 · exact");
    await expect(dialog.getByRole("region", { name: `Observed comment rows ${evidenceId}` })).toContainText("Prompted keyword");
    await expect(dialog.getByRole("region", { name: "Server video review provenance" })).toContainText("3 sampled points · 0s continuous coverage");
    await expect(dialog).toContainText("not verified Farda orders");
    expect(await page.evaluate(() => ({ local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie }))).toEqual({ local: 0, session: 0, cookie: "" });
    const afterRead = await (await machine.get(`/v1/creators/${creatorId}`)).json();
    expect(afterRead.runId).toBe(receipt.runId);
    expect(afterRead.revision).toBe(1);
    const receiptPath = testInfo.outputPath("actual-agent-receipt.json");
    writeFileSync(receiptPath, JSON.stringify({ runId: receipt.runId, revision: receipt.revision, evidenceRevision: packet.evidenceRevision, policyVersion: POLICY_VERSION, configStatus: receipt.assessment.config.status, workspaceId, accountId, source: "actual Node/SQLite service with synthetic reviewed evidence" }, null, 2));
    await testInfo.attach("actual-agent-receipt", { contentType: "application/json", path: receiptPath });
    console.info(`Actual agent sandbox receipt: ${receipt.runId}; revision ${receipt.revision}; policy ${POLICY_VERSION}.`);

    // Restart the actual service against the same SQLite file: the run survives, an in-memory session does not.
    await stopService();
    await startService();
    const persisted = await (await machine.get(`/v1/creators/${creatorId}`)).json();
    expect(persisted.runId).toBe(receipt.runId);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
    await expect(page.locator("[data-testid^='metric-']")).toHaveCount(0);
    await signIn();
    await page.reload();
    await expect(page.getByTestId("metric-Routine compatibility")).toHaveText("0 / 5");

    await stopService();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Data unavailable" })).toBeVisible();
    await expect(page.locator("[data-testid^='metric-']")).toHaveCount(0);
    await expect(page.getByTestId("agent-qualification")).toHaveCount(0);
    expect(await page.locator("main").innerText()).not.toMatch(/synthetic-browser-creator|\bDemo data\b/);
  } finally { await machine.dispose(); }
});
