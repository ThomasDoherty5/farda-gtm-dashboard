import { expect, test as base, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { digest } from "../src/creator-agent/config.ts";
import { offerPolicyFixture } from "../src/creator-agent/offers/policyFixture.testkit.ts";
import { createRuntimeTestkit, syntheticRuntimeRegistration, runtimeSyntheticScope as scope } from "../src/creator-agent/jobs/runtime.testkit.ts";
import { RuntimeError } from "../src/creator-agent/jobs/runtimeSchema.ts";
import { runtimeApiAckSchema, safeRuntimeRunSchema } from "../src/creator-agent/jobs/runtimeViews.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";

// Actual service, source-owned runtime and shared SQLite. All policies, actors, source events and prices are fictional.
// No real provider, creator contact, approval adoption or financial effect is exercised.
const test = base.extend<{ runtimeCadence: "event" | "daily" | "hourly" }>({ runtimeCadence: ["event", { option: true }] });
const machineToken = "synthetic-policy-runtime-machine-not-for-deployment";
let directory: string, app: ReturnType<typeof createAgentServer>;
let offers: ReturnType<typeof offerPolicyFixture>, kit: ReturnType<typeof createRuntimeTestkit>;
let actorActive: boolean, sourceResolved: boolean;
let captures: { file: string; width: number; height: number; sha256: string; state: string }[];
const service = () => `http://127.0.0.1:${process.env.E2E_AGENT_SERVER_PORT}`;

test.beforeEach(async ({ runtimeCadence }) => {
  directory = mkdtempSync(join(tmpdir(), "farda-policy-runtime-browser-"));
  offers = offerPolicyFixture(join(directory, "native.sqlite"), scope);
  actorActive = true; sourceResolved = false; captures = [];
  const policy = offers.source.state.current;
  policy.pricing.version = "synthetic-source-prices-v2";
  policy.pricing.bundles = [
    { id: "single", units: 1, merchandiseMinor: 4200, shippingMinor: 750 },
    { id: "duo", units: 2, merchandiseMinor: 7600, shippingMinor: 850 },
    { id: "trio", units: 3, merchandiseMinor: 9900, shippingMinor: 950 },
  ];
  offers.terms.pricingVersion = policy.pricing.version;
  // Do not call fixture.save(): no scorecard or qualification is invented for this browser offer.
  offers.repo.saveFromAdapter("synthetic-source-offer", null, offers.terms, "synthetic-source-offer-save");
  const registration = runtimeCadence === "daily" ? syntheticRuntimeRegistration({ cadence: {
    kind: "calendar", draft: { cadence: "daily", localTime: "10:00", timezone: "UTC", activeCohortOverride: false },
    draftVersion: "j1-d1", startsAt: "2026-11-05T10:00:00Z" } }) : runtimeCadence === "hourly" ?
    syntheticRuntimeRegistration({ family: "J08", membership: "enrolled-only", cadence: { kind: "hourly", timezone: "UTC", minute: 0, startsAt: "2026-11-05T00:00:00Z" } }) :
    syntheticRuntimeRegistration({ family: "registered-business", cadence: { kind: "event", eventType: "synthetic-source-event" } });
  kit = createRuntimeTestkit(offers.store.database, { registration, now: offers.now });
  await kit.initialize();
  const resolveTakeover = kit.authority.resolveTakeover, assertTakeover = kit.authority.assertTakeover;
  kit.authority.resolveTakeover = async request => {
    if (!sourceResolved || request.receiptRef !== "receipt:synthetic-human-resolution")
      throw new RuntimeError("SYNTHETIC_RESOLUTION_NOT_VERIFIED", 403);
    return resolveTakeover(request);
  };
  kit.authority.assertTakeover = (proof, now) => {
    if (!sourceResolved) throw new RuntimeError("SYNTHETIC_RESOLUTION_NOT_VERIFIED", 403);
    assertTakeover(proof, now);
  };
  const at = () => new Date(offers.now()).toISOString(), until = () => new Date(offers.now() + 60_000).toISOString();
  app = createAgentServer({
    databasePath: join(directory, "native.sqlite"), workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    commercialPolicy: offers.source.source, offerAuthority: offers.auth, operations: { now: offers.now },
    actionFoundation: { approvals: { sources: {
      resolveActor: async principalRef => ({ scope, principalRef, personRef: "synthetic-reader-person", roles: ["viewer"],
        active: true, directoryVersion: "synthetic-reader-directory", observedAt: at(), validUntil: until() }),
      assertCurrent: proof => {
        if (!actorActive || digest(proof.scope) !== digest(scope) || proof.actor.personRef !== "synthetic-reader-person")
          throw new Error("Synthetic named source access withdrawn");
      },
    } } },
    runtime: { registry: kit.registry, authority: kit.authority,
      machine: { token: machineToken, workerRef: kit.machine.workerRef,
        resolve: async (actualScope, operation, input) => ({ scope: actualScope, workerRef: kit.machine.workerRef, operation,
          inputHash: digest(input), proofRef: "synthetic-runtime-machine-proof", observedAt: at(), validUntil: until() }),
        assertCurrent: () => kit.machine.assertCurrent(),
      } },
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve);
  });
});
test.afterEach(async () => {
  try { await app?.close(); } finally { offers?.store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
});

async function login(page: Page, token = SYNTHETIC_REVIEW_TOKEN) {
  expect((await page.request.get("/v1/session", { headers: { authorization: "Bearer " + token } })).status()).toBe(200);
}
async function machine(operation: string, input: unknown) {
  const response = await fetch(service() + "/v1/runtime/machine", { method: "POST",
    headers: { authorization: "Bearer " + machineToken, "content-type": "application/json" },
    body: JSON.stringify({ operation, input }) });
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return runtimeApiAckSchema.parse(body);
}
async function fire(event: string, intendedAt = new Date(offers.now() - 3_600_000).toISOString()) {
  return machine("fire", { registrationRef: kit.registration.registrationRef, registrationVersion: kit.registration.version,
    intendedAt, triggerEventRef: event });
}
async function readRun(runRef: string) {
  const response = await fetch(service() + "/v1/read", { method: "POST",
    headers: { authorization: "Bearer " + SYNTHETIC_READ_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-runtime-proof-read",
      requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment },
      viewKey: "runDetail", filters: { runId: runRef }, period: null, sort: [], page: { limit: 50, cursor: null } }) });
  const body = await response.json() as { data: unknown; dataState: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return { data: safeRuntimeRunSchema.parse(body.data), dataState: body.dataState };
}
const proofDirectory = (info: TestInfo) => process.env.FARDA_POLICY_RUNTIME_PROOF_DIR ?? info.outputPath("policy-runtime-evidence");
const originalComparisonStates = new Set(["offer-source-held", "runtime-completed", "runtime-recovery-held", "runtime-daily-schedule", "runtime-hourly-backlog"]);
async function compareOriginal(page: Page, state: string) {
  const configured = process.env.FARDA_POLICY_RUNTIME_COMPARE_DIR;
  if (!configured || !originalComparisonStates.has(state)) return;
  const privateRoot = resolve(".handoff") + sep, directory = resolve(configured);
  if (!directory.startsWith(privateRoot)) throw new Error("Original comparisons must remain in the ignored private handoff directory.");
  // Caller-owned private mapping, never bundled or copied into a public test artifact.
  const originals: unknown = JSON.parse(readFileSync(join(directory, "originals.json"), "utf8"));
  const original = originals && typeof originals === "object" ? (originals as Record<string, unknown>)[state] : undefined;
  if (typeof original !== "string" || !resolve(original).startsWith(privateRoot)) throw new Error("Missing private original capture mapping.");
  const output = join(directory, state), authState = join(output, "auth-state.json");
  mkdirSync(output, { recursive: true });
  try {
    writeFileSync(authState, JSON.stringify(await page.context().storageState()), { mode: 0o600 });
    const location = new URL(page.url()), environment = { ...process.env };
    delete environment.SEGMENTS;
    const result = await promisify(execFile)(process.execPath,
      ["scripts/compare-figma.mjs", location.pathname + location.search, resolve(original)], {
        env: { ...environment, BASE_URL: location.origin, FIGMA_COMPARE_BROWSER_CHANNEL: process.env.E2E_AGENT_BROWSER_CHANNEL,
          FIGMA_COMPARE_STORAGE_STATE: authState, FIGMA_COMPARE_OUTPUT_DIR: output }, timeout: 60000,
      });
    const metrics: unknown = JSON.parse(result.stdout);
    writeFileSync(join(output, "metrics.json"), JSON.stringify({ state, fullFrame: true, crop: null, segments: null,
      claim: "Source-state adaptation comparison; differing heights mean the script percentage covers the common rectangle, not the entire union.",
      metrics }, null, 2));
    if (result.stderr) writeFileSync(join(output, "comparison-stderr.txt"), result.stderr);
  } finally { rmSync(authState, { force: true }); }
}
async function capture(page: Page, info: TestInfo, state: string) {
  const output = proofDirectory(info); mkdirSync(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const result = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    const path = join(output, `${state}-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    const png = readFileSync(path);
    captures.push({ file: basename(path), width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      sha256: createHash("sha256").update(png).digest("hex"), state });
    if (width === 1440) await compareOriginal(page, state);
  }
  writeFileSync(join(output, `provenance-${info.testId.replace(/[^a-zA-Z0-9]/g, "").slice(-40)}.json`), JSON.stringify({
    source: "Actual authenticated dashboard HTTP and shared SQLite with fictional source-owned policy/runtime bindings.",
    providerBusinessWrites: 0, sourceContacts: 0, adoptedCompanyPolicy: false, fabricatedScorecards: 0,
    sourceMapping: { offer: "65:634", run: "5:13", recovery: "5:156", scheduling: "14:911" },
    visualClaim: "Native source-state adaptations; no pixel-parity claim and no original Figma media included.",
    captures,
  }, null, 2));
}
async function keyboardTable(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  const region = page.locator(`[role="region"][aria-label="${name}"][tabindex="0"]`);
  await region.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await region.evaluate(element => { element.scrollLeft = 0; });
}

test("saved source catalogue stays distinct from candidate prices and unavailable qualification", async ({ page }, info) => {
  test.setTimeout(120000);
  await login(page); await page.goto("/offers/synthetic-source-offer");
  await expect(page.getByRole("heading", { name: "Terms that make sense." })).toBeVisible();
  await expect(page.getByText("No saved route-matched assessment", { exact: false })).toBeVisible();
  const prices = page.getByRole("table", { name: "Buyer prices" });
  await expect(prices).toContainText("$42.00"); await expect(prices).toContainText("$49.50");
  await expect(prices).not.toContainText("$34.99");
  await expect(page.getByText("Saved source buyer prices · synthetic-source-prices-v2", { exact: false })).toBeVisible();
  expect(app.store.latest(offers.terms.creatorId)).toBeNull();
  await capture(page, info, "offer-source-held");
  await keyboardTable(page, "Buyer prices");
  await page.getByRole("button", { name: "Review commitment", exact: true }).focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Review commitment", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("source-confirmed terms and separate fulfillment approvals");
  await capture(page, info, "offer-review-local-only");
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review commitment", exact: true })).toBeFocused();
  await login(page, SYNTHETIC_READ_TOKEN); await page.reload();
  await expect(page.getByRole("button", { name: "Save offer draft", exact: true })).toBeDisabled();
  await expect(prices).toContainText("$42.00");
});

test("registered completed and partial source windows show actual observations and unknown billing", async ({ page }, info) => {
  test.setTimeout(120000);
  const completedRef = (await fire("synthetic-completed-window")).runRefs[0]!;
  await machine("work", { runRef: completedRef, maxItems: 1 });
  const completed = await readRun(completedRef);
  expect(completed.data).toMatchObject({ state: "completed", sourceCoverage: "complete",
    usage: { invocations: { directApi: 1 }, ordinaryZapTasks: null, observedCostMinor: null } });
  await login(page, SYNTHETIC_READ_TOKEN); await page.goto("/runs/" + completedRef);
  await expect(page.getByRole("heading", { name: "Registered source run", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Registered work items" })).toContainText("Observation recorded");
  await expect(page.getByRole("heading", { name: "Measured usage and unknown costs", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume source work", exact: true })).toBeDisabled();
  await expect(page.getByText("Not applicable · event-driven", { exact: true })).toBeVisible();
  await expect(page.getByText("Global backlog total", { exact: true })).toHaveCount(0);
  await capture(page, info, "runtime-completed");
  await keyboardTable(page, "Registered work items");
  await machine("work", { runRef: completedRef, maxItems: 1 }); expect(kit.state.sourceCalls).toBe(1);
  kit.state.partial = true;
  const partialRef = (await fire("synthetic-partial-window")).runRefs[0]!;
  await machine("work", { runRef: partialRef, maxItems: 1 });
  const partial = await readRun(partialRef);
  expect(partial).toMatchObject({ dataState: "partial", data: { sourceCoverage: "partial", hasContinuation: true } });
  await page.goto("/runs/" + partialRef);
  await expect(page.getByText("Partial · total unknown", { exact: true })).toBeVisible();
  await expect(page.getByText("Continuation remains", { exact: true })).toBeVisible();
  await capture(page, info, "runtime-partial");
  const next = (await machine("continue", { runRef: partialRef })).runRefs[0]!;
  expect(next).not.toBe(partialRef);
  await machine("work", { runRef: next, maxItems: 1 });
  expect((await readRun(next)).data).toMatchObject({ sourceCoverage: "complete", hasContinuation: false, state: "completed" });
});

test("source takeover stays held through reload and resumes only from its exact receipt; access loss clears the view", async ({ page }, info) => {
  test.setTimeout(120000);
  await kit.verify("api", "Unsupported");
  kit.registry.executors.set(kit.registration.browserExecutorRef!, { mode: "observe", execute: async context =>
    context.invoke("browser", async () => {
      kit.state.sourceCalls++;
      return sourceResolved ? { state: "completed", recordCount: 1, evidenceRefs: ["synthetic-recovered-source"], sourceReceiptRef: "receipt:synthetic-recovered-source" }
        : { state: "takeover", kind: "mfa", handoffRef: "synthetic-source-handoff", ownerRef: "owner:synthetic-runtime", reasonCode: "SOURCE_MFA" };
    }) });
  const runRef = (await fire("synthetic-takeover-window")).runRefs[0]!;
  await machine("work", { runRef });
  const held = await readRun(runRef);
  expect(held.data.state).toBe("held"); expect(held.data.takeovers).toHaveLength(1);
  await login(page); await page.goto("/runs/" + runRef);
  await expect(page.getByText("mfa", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Source access needs verification.");
  await expect(page.getByRole("alert")).not.toContainText("original action may already be applied");
  await expect(page.getByRole("button", { name: "Resume source work", exact: true })).toBeDisabled();
  await capture(page, info, "runtime-source-takeover");
  await page.getByRole("link", { name: "Recovery", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Resume from verified evidence.", exact: true })).toBeVisible();
  const checklist = page.getByRole("region", { name: "Resolve the source state", exact: true });
  for (const step of ["Verify the same registered window", "Compare saved evidence and checkpoint", "Retain the original attempt", "Use the named source owner"])
    await expect(checklist).toContainText(step);
  await page.reload(); await expect(page.getByText("mfa", { exact: true })).toBeVisible();
  await capture(page, info, "runtime-recovery-held");
  await machine("work", { runRef }); expect(kit.state.sourceCalls).toBe(1);
  sourceResolved = true;
  const takeover = held.data.takeovers[0]!;
  const resolution = { runRef, itemRef: takeover.itemRef, expectedVersion: takeover.version,
    receiptRef: "receipt:synthetic-human-resolution", requestKey: "synthetic-takeover-recovery" };
  await machine("takeover", resolution); await machine("takeover", resolution);
  await machine("work", { runRef }); expect(kit.state.sourceCalls).toBe(2);
  await page.getByRole("button", { name: "Refresh run evidence", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("table", { name: "Registered work items" })).toContainText("Observation recorded");
  await expect(page.getByText("mfa", { exact: true })).toHaveCount(0);
  await capture(page, info, "runtime-recovered");
  actorActive = false;
  await page.getByRole("button", { name: "Refresh run evidence", exact: true }).click();
  await expect(page.getByRole("table", { name: "Registered work items" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Measured usage and unknown costs", exact: true })).toHaveCount(0);
  await capture(page, info, "runtime-access-denied");
  expect(kit.state.sourceCalls).toBe(2);
});


async function inspectTriggerWithKeyboard(page: Page) {
  const summary = page.locator("summary", { hasText: "Trigger evidence references" });
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(summary.locator("..")).toHaveAttribute("open", "");
  await expect(summary.locator("..")).toContainText(/trigger-[a-f0-9]{64}/);
  await page.keyboard.press("Enter"); await expect(summary.locator("..")).not.toHaveAttribute("open", "");
}

test.describe("registered daily scheduling", () => {
  test.use({ runtimeCadence: "daily" });
  test("actual daily trigger evidence distinguishes one admitted run from the remaining scanned due work", async ({ page }, info) => {
    test.setTimeout(120000);
    const runRef = (await fire("synthetic-daily-scheduled-window", "2026-11-06T10:00:00Z")).runRefs[0]!;
    await machine("work", { runRef, maxItems: 1 });
    const result = await readRun(runRef);
    expect(result.data.scheduling).toMatchObject({ cadence: { kind: "calendar", cadence: "daily", localTime: "10:00", timezone: "UTC" },
      backlog: { state: "observed", unadmittedInScannedRange: 1, scannedSlots: 2, scanComplete: true, scanCursor: null, total: null,
        oldestUnadmittedAt: "2026-11-05T10:00:00.000Z", scannedThrough: "2026-11-06T10:00:00.000Z" } });
    await login(page, SYNTHETIC_READ_TOKEN); await page.goto("/runs/" + runRef);
    await expect(page.getByText("Daily at 10:00", { exact: true })).toBeVisible();
    const backlog = page.getByRole("region", { name: "Due work in the inspected range", exact: true });
    await expect(backlog).toContainText("Inspected range complete");
    await expect(backlog.locator("dt", { hasText: "Unadmitted in inspected range" }).locator("..")).toHaveText("Unadmitted in inspected range1");
    await expect(backlog.locator("dt", { hasText: "Global backlog total" }).locator("..")).toHaveText("Global backlog totalUnknown");
    await inspectTriggerWithKeyboard(page);
    await expect(page.getByRole("button", { name: /enable|activate|save schedule/i })).toHaveCount(0);
    await capture(page, info, "runtime-daily-schedule");
    expect(kit.state.sourceCalls).toBe(1);
  });
});

test.describe("registered hourly scheduling", () => {
  test.use({ runtimeCadence: "hourly" });
  test("actual hourly inspection discloses its finite 24-slot range, continuation and unknown global backlog", async ({ page }, info) => {
    test.setTimeout(120000);
    const runRef = (await fire("synthetic-hourly-scheduled-window")).runRefs[0]!;
    const result = await readRun(runRef);
    expect(result.data.scheduling).toMatchObject({ cadence: { kind: "hourly", minute: 0, timezone: "UTC" },
      backlog: { state: "observed", unadmittedInScannedRange: 24, scannedSlots: 24, scanComplete: false,
        scannedThrough: "2026-11-05T23:00:00.000Z", scanCursor: "2026-11-06T00:00:00.000Z", total: null } });
    await login(page, SYNTHETIC_READ_TOKEN); await page.goto("/runs/" + runRef);
    await expect(page.getByText("Hourly at minute 00", { exact: true })).toBeVisible();
    const backlog = page.getByRole("region", { name: "Due work in the inspected range", exact: true });
    await expect(backlog).toContainText("Partial due-work scan");
    await expect(backlog.locator("dt", { hasText: "Slots inspected" }).locator("..")).toHaveText("Slots inspected24");
    await expect(backlog.locator("dt", { hasText: "Global backlog total" }).locator("..")).toHaveText("Global backlog totalUnknown");
    await inspectTriggerWithKeyboard(page);
    await capture(page, info, "runtime-hourly-backlog");
    actorActive = false; await page.getByRole("button", { name: "Refresh run evidence", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Registered trigger and cadence", exact: true })).toHaveCount(0);
    await expect(backlog).toHaveCount(0);
    expect(kit.state.sourceCalls).toBe(0);
  });
});
