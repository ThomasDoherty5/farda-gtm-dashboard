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
  test.setTimeout(60_000); // Bounded allowance for 201 sequential synthetic HTTP seeds and five browser pages.
  await startService();
  const machine = await apiRequest.newContext({ baseURL: service, extraHTTPHeaders: { authorization: `Bearer ${reviewer}` } });
  try {
    const packet = syntheticAgentEvidence({ creatorId, evidenceRevision: "synthetic-browser-evidence-1", ratings: { routine: 0, demo: 4 } });
    const capabilities = await machine.get("/v1/capabilities");
    expect(capabilities.status()).toBe(200);
    const available = await capabilities.json() as { models: { modelId: string; configHash: string | null }[] };
    const configHash = available.models.find((model) => model.modelId === "WEBSITE-AFFILIATE-v3")?.configHash;
    expect(configHash).toBe("048db012fb33cf8aa5f5ec8e02e31ab56d08e32fb7e4259cf2c329dea71697e6");
    const expectedRuns = new Set<string>();
    let oldestQueueRecord: { creatorId: string; runId: string } | undefined;
    // These are synthetic reviewed packets, not discovered or qualified live creators.
    // Seed the journey's main creator last so it remains visible on the first page.
    for (let index = 0; index < 200; index++) {
      const queueCreatorId = `synthetic-browser-queue-${String(index).padStart(3, "0")}`;
      const queuePacket = syntheticAgentEvidence({ creatorId: queueCreatorId, evidenceRevision: "synthetic-browser-pagination-1", ratings: { routine: 0, demo: 4 } });
      const result = await machine.put(`/v1/creators/${queueCreatorId}`, { headers: { "Idempotency-Key": randomUUID() }, data: { expectedVersion: 0, policyVersion: POLICY_VERSION, configHash, packet: queuePacket } });
      expect(result.status()).toBe(200);
      const saved = await result.json();
      expect(saved.runId).toMatch(/^[0-9a-f-]{36}$/);
      expectedRuns.add(saved.runId);
      oldestQueueRecord ??= { creatorId: queueCreatorId, runId: saved.runId };
      await result.dispose();
    }
    const seeded = await machine.put(`/v1/creators/${creatorId}`, { headers: { "Idempotency-Key": randomUUID() }, data: { expectedVersion: 0, policyVersion: POLICY_VERSION, configHash, packet } });
    expect(seeded.status()).toBe(200);
    const receipt = await seeded.json();
    expect(receipt.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.assessment.criteria.routine).toBe(0);
    expect(receipt.assessment.config).toMatchObject({ status: "bound", version: "2026-11-04.launch-v1", hash: configHash });
    expect(receipt.assessment.state).toBe("hold");
    expect(receipt.assessment.score.total).toBeNull(); // No noncritical source proof or verified sales are supplied.
    expectedRuns.add(receipt.runId);
    expect(expectedRuns.size).toBe(201);

    const signIn = async () => {
      const answer = await context.request.get(`${service}/v1/session`, { headers: { authorization: `Basic ${Buffer.from(`reader:${reader}`).toString("base64")}` } });
      expect(answer.status()).toBe(200);
      expect(await context.cookies(app)).toEqual([expect.objectContaining({ name: "farda_agent", httpOnly: true, sameSite: "Strict" })]);
    };
    await signIn();
    const sourcingAnswer = page.waitForResponse((response) => response.url() === `${app}/v1/read` && response.request().method() === "POST" && response.request().postDataJSON().viewKey === "discoverySummary");
    await page.goto("/creators/discovery");
    const sourcing = await sourcingAnswer;
    expect(sourcing.status()).toBe(200);
    expect(sourcing.request().headers().authorization).toBeUndefined();
    expect(sourcing.request().postDataJSON().requestedScope).toEqual({ workspaceId, accountIds: [accountId], environment: "sandbox" });
    const sourcingEnvelope = await sourcing.json();
    expect(sourcingEnvelope.scope).toMatchObject({ workspaceId, accountIds: [accountId], environment: "sandbox" });
    expect(sourcingEnvelope.data.kind).toBe("agent-sourcing");
    expect(sourcingEnvelope.data.records).toContainEqual(expect.objectContaining({ creatorId, runId: receipt.runId, evidenceId }));
    expect(sourcing.request().postDataJSON().page).toEqual({ cursor: null, limit: 50 });
    expect(sourcingEnvelope.data.snapshot).toMatchObject({ offset: 0, limit: 50, returnedCount: 50, total: 201 });
    expect(sourcingEnvelope.data.records).toHaveLength(50);
    expect(sourcingEnvelope.data.partial).toBe(true);
    expect(sourcingEnvelope.page.hasMore).toBe(true);
    const snapshot = sourcingEnvelope.data.snapshot;
    const snapshotRows = [...sourcingEnvelope.data.records];
    const pageSizes = [snapshotRows.length];
    await expect(page.getByText("Showing 50 of 201 saved creators. This is a partial list.")).toBeVisible();

    // A new revision after page one must not change snapshot membership/order/run identity.
    // When its old saved run is reached, the server must withhold current evidence navigation.
    expect(oldestQueueRecord).toBeDefined();
    const oldest = oldestQueueRecord!;
    const revisedPacket = syntheticAgentEvidence({ creatorId: oldest.creatorId, evidenceRevision: "synthetic-browser-pagination-2", ratings: { routine: 0, demo: 3 } });
    const revisedAnswer = await machine.put(`/v1/creators/${oldest.creatorId}`, { headers: { "Idempotency-Key": randomUUID() }, data: { expectedVersion: 1, policyVersion: POLICY_VERSION, configHash, packet: revisedPacket } });
    expect(revisedAnswer.status()).toBe(200);
    const revisedReceipt = await revisedAnswer.json();
    expect(revisedReceipt.revision).toBe(2);
    expect(revisedReceipt.runId).not.toBe(oldest.runId);
    await revisedAnswer.dispose();

    let nextCursor = sourcingEnvelope.page.nextCursor;
    for (const loaded of [100, 150, 200, 201]) {
      expect(typeof nextCursor).toBe("string");
      expect(nextCursor.length).toBeGreaterThan(32);
      const requestedCursor = nextCursor;
      const nextAnswer = page.waitForResponse((response) => response.url() === `${app}/v1/read` && response.request().method() === "POST" && response.request().postDataJSON().viewKey === "discoverySummary" && response.request().postDataJSON().page.cursor === requestedCursor);
      await page.getByRole("button", { name: "Load more creators" }).click();
      const next = await nextAnswer;
      expect(next.status()).toBe(200);
      expect(next.request().headers().authorization).toBeUndefined();
      expect(next.request().postDataJSON().page).toEqual({ cursor: requestedCursor, limit: 50 });
      expect(next.request().postDataJSON().requestedScope).toEqual({ workspaceId, accountIds: [accountId], environment: "sandbox" });
      const nextEnvelope = await next.json();
      const count = loaded === 201 ? 1 : 50;
      expect(nextEnvelope.scope).toMatchObject({ workspaceId, accountIds: [accountId], environment: "sandbox" });
      expect(nextEnvelope.data.snapshot).toEqual({ ...snapshot, offset: snapshotRows.length, returnedCount: count });
      expect(nextEnvelope.data.records).toHaveLength(count);
      expect(nextEnvelope.data.total).toBe(201);
      expect(nextEnvelope.data.partial).toBe(true); // Each page is a partial response even when the UI finishes accumulating.
      expect(nextEnvelope.coverage).toMatchObject({ expectedCount: 201, observedCount: count, missingCount: 201 - count, complete: false });
      expect(nextEnvelope.page.hasMore).toBe(loaded < 201);
      if (loaded === 201) expect(nextEnvelope.page.nextCursor).toBeNull();
      snapshotRows.push(...nextEnvelope.data.records);
      pageSizes.push(count);
      nextCursor = nextEnvelope.page.nextCursor;
      await expect(page.getByText(`Showing ${loaded} of 201 saved creators. ${loaded === 201 ? "All saved creators in this snapshot are loaded." : "This is a partial list."}`)).toBeVisible();
    }
    expect(snapshotRows).toHaveLength(201);
    expect(new Set(snapshotRows.map((record) => record.runId))).toEqual(expectedRuns);
    expect(new Set(snapshotRows.map((record) => record.creatorId)).size).toBe(201);
    expect(snapshotRows.some((record) => record.runId === revisedReceipt.runId)).toBe(false);
    expect(snapshotRows.find((record) => record.runId === oldest.runId)).toMatchObject({ state: "reviewNeeded", stale: true, superseded: true, evidenceId: null });
    const sourceTable = page.getByRole("region", { name: "Saved creator sourcing records" });
    const savedLinks = sourceTable.locator('a[href*="/assessments/"]');
    await expect(savedLinks).toHaveCount(201);
    expect(new Set(await savedLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href")))).size).toBe(201);
    await expect(page.getByRole("button", { name: "Load more creators" })).toHaveCount(0);
    const supersededPath = `/creators/${oldest.creatorId}/assessments/${oldest.runId}`;
    const supersededRow = sourceTable.getByRole("row").filter({ has: page.locator(`a[href="${supersededPath}"]`) });
    await expect(supersededRow).toContainText("Review needed · superseded");
    await expect(supersededRow.getByRole("link", { name: "Review source evidence" })).toHaveCount(0);

    const assessmentPath = `/creators/${creatorId}/assessments/${receipt.runId}`;
    const assessmentLink = page.locator(`a[href="${assessmentPath}"]`).first();
    await expect(assessmentLink).toBeVisible();
    const assessmentAnswer = page.waitForResponse((response) => response.url() === `${app}/v1/read` && response.request().method() === "POST" && response.request().postDataJSON().viewKey === "assessmentRecord");
    await assessmentLink.click();
    await expect(page).toHaveURL(`${app}${assessmentPath}`);
    const assessment = await assessmentAnswer;
    expect(assessment.status()).toBe(200);
    expect(assessment.request().headers().authorization).toBeUndefined();
    expect(assessment.request().postDataJSON().filters).toEqual({ creatorId, assessmentId: receipt.runId });
    expect(assessment.request().postDataJSON().requestedScope).toEqual({ workspaceId, accountIds: [accountId], environment: "sandbox" });
    const assessmentEnvelope = await assessment.json();
    expect(assessmentEnvelope.scope).toMatchObject({ workspaceId, accountIds: [accountId], environment: "sandbox" });
    expect(assessmentEnvelope.data).toMatchObject({ kind: "creator-v3", evidenceId, qualification: { state: "hold", config: { status: "bound", version: "2026-11-04.launch-v1", hash: configHash } } });
    const assessmentDetails = page.getByTestId("agent-qualification");
    await expect(assessmentDetails).toBeVisible();
    await expect(assessmentDetails).toContainText("Hold");
    await expect(assessmentDetails.getByRole("region", { name: "Agent assessment versions" })).toContainText("bound");
    await expect(assessmentDetails.getByRole("region", { name: "Agent assessment versions" })).toContainText("2026-11-04.launch-v1");
    const assessmentWeights = assessmentDetails.getByRole("region", { name: "Saved criterion weights" });
    await expect(assessmentWeights).toContainText("25%");
    await expect(assessmentWeights.locator("input, select, textarea, button")).toHaveCount(0);
    const assessmentGates = assessmentDetails.getByRole("region", { name: "Server qualification gates" });
    await expect(assessmentGates).toContainText("ROUTINE_FLOOR");
    await expect(assessmentGates).toContainText("fail");
    await expect(assessmentGates.locator("input, select, textarea, button")).toHaveCount(0);

    const evidenceLink = page.locator(`a[href="${route}"]`).first();
    await expect(evidenceLink).toBeVisible();
    const readAnswer = page.waitForResponse((response) => response.url() === `${app}/v1/read` && response.request().method() === "POST" && response.request().postDataJSON().viewKey === "evidenceRecord");
    await evidenceLink.click();
    await expect(page).toHaveURL(`${app}${route}`);
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
    await expect(page.getByTestId("metric-Saved model")).toHaveText("Bound when assessed");
    await expect(page.getByTestId("metric-Commerce confidence")).toHaveText("Unknown");
    await expect(page.getByRole("button", { name: "Mark watched" }).first()).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("button", { name: "Inspect model status" }).click();
    const dialog = page.getByRole("dialog", { name: "Model status" });
    await expect(dialog.getByTestId("agent-qualification")).toContainText("Hold");
    await expect(dialog.getByRole("region", { name: "Agent assessment versions" })).toContainText(POLICY_VERSION);
    await expect(dialog.getByRole("region", { name: "Agent assessment versions" })).toContainText("2026-11-04.launch-v1");
    await expect(dialog.getByRole("region", { name: "Saved criterion weights" })).toContainText("Contextual / routine fit");
    await expect(dialog.getByRole("region", { name: "Saved criterion weights" })).toContainText("25%");
    await expect(dialog.getByRole("region", { name: "Saved aggregate bands" })).toContainText("priorityReview");
    await expect(dialog.getByRole("region", { name: "Saved criterion weights" }).locator("input, select, textarea, button")).toHaveCount(0);
    await expect(dialog.getByRole("region", { name: "Server qualification gates" })).toContainText("ROUTINE_FLOOR");
    await expect(dialog.getByRole("region", { name: "Server qualification gates" })).toContainText("fail");
    await expect(dialog.getByRole("region", { name: "Server qualification gates" }).locator("input, select, textarea, button")).toHaveCount(0);
    await expect(dialog.getByRole("region", { name: "Server-selected recent metadata baseline" })).toContainText("40 · exact");
    await expect(dialog.getByRole("region", { name: `Observed comment rows ${evidenceId}` })).toContainText("Prompted keyword");
    await expect(dialog.getByRole("region", { name: "Server video review provenance" })).toContainText("3 sampled points · 0s continuous coverage");
    await expect(dialog).toContainText("not verified Farda orders");
    expect(await page.evaluate(() => ({ local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie }))).toEqual({ local: 0, session: 0, cookie: "" });
    const afterRead = await (await machine.get(`/v1/creators/${creatorId}`)).json();
    expect(afterRead.runId).toBe(receipt.runId);
    expect(afterRead.revision).toBe(1);
    const receiptPath = testInfo.outputPath("actual-agent-receipt.json");
    writeFileSync(receiptPath, JSON.stringify({ runId: receipt.runId, revision: receipt.revision, evidenceRevision: packet.evidenceRevision, policyVersion: POLICY_VERSION, configStatus: receipt.assessment.config.status, configVersion: receipt.assessment.config.version, configHash, baselineHash: receipt.assessment.config.baselineHash, numericHash: receipt.assessment.config.numericHash, score: receipt.assessment.score.total, state: receipt.assessment.state, workspaceId, accountId, assessmentPath, evidencePath: route, pagination: { snapshotId: snapshot.id, asOf: snapshot.asOf, creators: snapshotRows.length, pageCount: pageSizes.length, pageSizes, uniqueRunCount: new Set(snapshotRows.map((record) => record.runId)).size, supersededRunId: oldest.runId, excludedLaterRunId: revisedReceipt.runId }, journey: "201-creator snapshot to exact saved assessment to evidence", source: "actual Node/SQLite service with synthetic reviewed evidence" }, null, 2));
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

test("authenticated acquisition views show the actual empty scoped ledger at desktop and phone widths", async ({ page, context }, testInfo) => {
  await startService();
  try {
    const auth = await context.request.get(`${service}/v1/session`, { headers: { authorization: `Bearer ${reader}` } });
    expect(auth.status()).toBe(200);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      const read = page.waitForResponse(res => res.url().endsWith("/v1/read") && res.request().postDataJSON()?.viewKey === "pipelineSummary");
      await page.goto("/creators/pipeline");
      const answer = await read;
      expect(answer.status()).toBe(200);
      expect(await answer.json()).toMatchObject({ dataState: "empty", data: { coverage: { opportunities: 0 } } });
      await expect(page.getByTestId("live-acquisition")).toBeVisible();
      await expect(page.getByText("No acquisition events match", { exact: true })).toBeVisible();
      await expect(page.getByRole("main")).not.toContainText(/Mature synthetic cohort|Illustrative cohort/);
      await testInfo.attach(`acquisition-empty-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    }
  } finally { await stopService(); }
});

test("a reviewer saves a real offer and the reader sees retained reward evidence as unknown after restart", async ({ page, context }, testInfo) => {
  await startService();
  try {
    expect((await context.request.get(`${service}/v1/session`, { headers: { authorization: `Bearer ${reviewer}` } })).status()).toBe(200);
    await page.goto("/offers/new");
    await page.getByLabel("Creator ID").fill("synthetic-offer-browser");
    await page.getByLabel("Production brief reference").fill("synthetic-browser-brief");
    const saved = page.waitForResponse(res => res.url().endsWith("/v1/save") && res.request().method() === "POST");
    await page.getByRole("button", { name: "Create offer draft" }).click();
    const ack = await saved;
    expect(ack.status()).toBe(200);
    const receipt = await ack.json();
    expect(receipt).toMatchObject({ resourceVersion: "v1", record: { state: "proposed", acceptedRef: null, provider: null } });
    await expect(page.getByRole("heading", { name: "Terms that make sense." })).toBeVisible();
    await testInfo.attach("saved-offer-desktop", { body: await page.screenshot(), contentType: "image/png" });
    await stopService(); await startService();
    expect((await context.request.get(`${service}/v1/session`, { headers: { authorization: `Bearer ${reader}` } })).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Terms that make sense." })).toBeVisible();
    const rewards = page.waitForResponse(res => res.url().endsWith("/v1/read") && res.request().postDataJSON()?.viewKey === "offerRewards");
    await page.getByRole("link", { name: "Milestone rewards" }).click();
    const result = await rewards;
    expect(result.status()).toBe(200);
    expect(await result.json()).toMatchObject({ data: { kind: "agent-rewards", status: "unobserved",
      maturedMinor: null, contributionMinor: null, earnedMinor: null } });
    await expect(page.getByRole("heading", { name: "Milestone rewards" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await testInfo.attach("reward-evidence-phone", { body: await page.screenshot(), contentType: "image/png" });
  } finally { await stopService(); }
});

test("selected saved scorecards preview their exact runs and require review after supersession", async ({ page, context }, testInfo) => {
  await startService();
  const machine = await apiRequest.newContext({ baseURL: service, extraHTTPHeaders: { authorization: `Bearer ${reviewer}` } });
  try {
    const id = "synthetic-finite-" + randomUUID();
    const capabilities = await (await machine.get("/v1/capabilities")).json();
    const hash = capabilities.models.find((m: {modelId: string}) => m.modelId === "WEBSITE-AFFILIATE-v3").configHash;
    const save = (revision: number) => machine.put(`/v1/creators/${id}`, {
      headers: { "idempotency-key": randomUUID() },
      data: { expectedVersion: revision, policyVersion: POLICY_VERSION, configHash: hash,
        packet: syntheticAgentEvidence({ creatorId: id, evidenceRevision: `finite-${revision}`, ratings: { routine: 3, demo: 4 } }) },
    });
    const first = await save(0);
    expect(first.status()).toBe(200);
    const receipt = await first.json();
    expect((await context.request.get(`${service}/v1/session`, { headers: { authorization: `Bearer ${reader}` } })).status()).toBe(200);
    await page.goto("/creators/discovery");
    await page.getByRole("checkbox", {name: `Select ${id} for preview`}).check();
    const request = page.waitForResponse(r => r.url().endsWith("/v1/read") && r.request().postDataJSON()?.viewKey === "batchDetail");
    await page.getByRole("link",{name:"Preview 1 selected"}).click();
    const response = await request;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ data: { selectedCount: 1, dispatchAuthorized: false,
      items: [{ creatorId: id, runId: receipt.runId, modelId: "WEBSITE-AFFILIATE-v3", configHash: hash }] } });
    const table = page.getByRole("region",{name:"Selected invitation assessments"});
    await expect(table).toContainText("Acceptance unverified");
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      await expect(table.getByRole("link",{name:id})).toBeVisible();
      await testInfo.attach(`finite-preview-${width}`, {body:await page.screenshot(), contentType:"image/png"});
    }
    expect((await save(1)).status()).toBe(200);
    await page.reload();
    await expect(table).toContainText("Stale · review needed");
    await expect(table.getByRole("link",{name:"View evidence"})).toHaveCount(0);
  } finally { await machine.dispose(); await stopService(); }
});
