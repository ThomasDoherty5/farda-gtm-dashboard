// @vitest-environment node
// Actual HTTP/SQLite regressions: no provider effects or simulated persistence.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import {
  nativeEmailFlowSchema, saveReceiptSchema, type LifecycleViewKey, type NativeEmailFlow, type SaveReceipt,
} from "./lifecycle/contract.ts";
import { lifecycleSourceFixture, lifecycleTestSource, lifecycleTestScope, lifecycleTestTime } from "./lifecycle/fixtures.testkit.ts";
import { LifecycleError } from "./lifecycle/source.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";

const ROTATED_READER = "synthetic-rotated-reader-not-a-secret-0003";
const ROTATED_REVIEWER = "synthetic-rotated-reviewer-not-a-secret-0004";
const requestedScope = {
  workspaceId: lifecycleTestScope.workspaceId,
  accountIds: [lifecycleTestScope.accountId],
  environment: "sandbox" as const,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  // Restore the DB observer before shutdown; it must not affect another test.
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function harness() {
  const state = {
    now: lifecycleTestTime,
    source: lifecycleSourceFixture(),
    reads: 0, permitted: true, permissionVersion: "synthetic-access-v1",
  };
  type SourcePause = { captured: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  let nextPause: SourcePause | null = null;
  const releases = new Set<() => void>();
  const options: AgentServerOptions = {
    databasePath: ":memory:",
    workspaceId: lifecycleTestScope.workspaceId,
    accountId: lifecycleTestScope.accountId,
    readToken: SYNTHETIC_READ_TOKEN,
    reviewToken: SYNTHETIC_REVIEW_TOKEN,
    operations: { now: () => state.now },
    lifecycleSource: {
      async read(binding, signal) {
        state.reads++;
        const captured = await lifecycleTestSource(async () => structuredClone(state.source), () => state.now).read(binding, signal);
        const result = captured as { authority: { permissionVersion: string } };
        result.authority.permissionVersion = state.permissionVersion;
        const pause = nextPause; nextPause = null;
        if (pause) { pause.captured.resolve(); await pause.release.promise; }
        return result;
      },
      assertCurrent(result) {
        if (!state.permitted || result.authority.permissionVersion !== state.permissionVersion) throw new LifecycleError("SOURCE_AUTHORITY_DENIED", 403);
        if (result.authority.sourceVersion !== state.source.version) throw new LifecycleError("SOURCE_VERSION_CHANGED", 409);
      },
    },
  };
  // Retain this exact object. Mutating a cloned helper argument would not
  // exercise the live authorize(req) closure and could produce false evidence.
  const app = createAgentServer(options);
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected actual fixture HTTP address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    for (const release of releases) release();
    await app.close();
  });

  const request = async (path: string, body: unknown, token: string) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: z.record(z.unknown()).parse(await response.json()) };
  };
  const read = (viewKey: LifecycleViewKey, filters: unknown, token = options.readToken) =>
    request("/v1/read", {
      schemaVersion: SCHEMA_VERSION, operation: "readView",
      requestId: "synthetic-lifecycle-authority-read", requestedScope,
      viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 50 },
    }, token);
  const captureNextSourceRead = () => {
    if (nextPause) throw new Error("Only one explicitly armed source pause is allowed");
    const pause: SourcePause = { captured: deferred(), release: deferred() };
    nextPause = pause;
    const release = () => { pause.release.resolve(); releases.delete(release); };
    releases.add(release);
    return { captured: pause.captured.promise, release };
  };
  const revisionCount = () => Number(app.store.database.prepare(
    "SELECT count(*) AS n FROM lifecycle_draft_revisions",
  ).get()?.n ?? 0);
  const successReceiptCount = () => Number(app.store.database.prepare(
    "SELECT count(*) AS n FROM lifecycle_draft_requests WHERE state='recorded'",
  ).get()?.n ?? 0);
  const persistedReceipt = (key: string): SaveReceipt | null => {
    const row = app.store.database.prepare(
      "SELECT receipt FROM lifecycle_draft_requests WHERE request_key=? AND state='recorded'",
    ).get(key);
    return typeof row?.receipt === "string" ? saveReceiptSchema.parse(JSON.parse(row.receipt)) : null;
  };
  return { app, options, state, request, read, captureNextSourceRead, revisionCount, successReceiptCount, persistedReceipt };
}

function saveRequest(data: NativeEmailFlow, idempotencyKey: string) {
  const config = data.sourceConfig;
  if (!config) throw new Error("Expected current fictional source catalog");
  const event = config.entryEvents[0], timing = config.timingRules[0], template = config.templates[0];
  if (!event || !timing || !template) throw new Error("Expected exact source-owned catalog selections");
  return {
    schemaVersion: SCHEMA_VERSION, operation: "saveResource",
    requestId: "synthetic-lifecycle-authority-save", requestedScope,
    resourceKind: "configurationDraft", resourceRef: "flow-early-access",
    expectedVersion: data.draftVersion, idempotencyKey,
    payload: {
      entryEventRef: event.ref, timingRuleRef: timing.ref, timezone: timing.timezone,
      templateRef: template.ref, templateVersion: template.version,
      templateName: "Synthetic current authority draft",
    },
  };
}

function expectNoProtectedSuccess(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("data");
  expect(body).not.toHaveProperty("record");
  expect(body).not.toHaveProperty("resourceVersion");
  expect(body).not.toHaveProperty("persistedAt");
  expect(body).not.toHaveProperty("persistedByRef");
  expect(body.code).toEqual(expect.any(String));
  const serialized = JSON.stringify(body);
  for (const token of [SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, ROTATED_READER, ROTATED_REVIEWER])
    expect(serialized).not.toContain(token);
}

describe("lifecycle caller authority at actual HTTP publication and durable commit", () => {
  it.each([
    ["lifecycleOverview", {}],
    ["emailFlow", { flow: "early-access" }],
    ["consentEligibility", {}],
    ["activationRetention", {}],
  ] as const)("refuses captured %s evidence after its reader credential is revoked", async (viewKey, filters) => {
    const h = await harness();
    const control = await h.read(viewKey, filters, SYNTHETIC_READ_TOKEN);
    expect(control.status).toBe(200);
    expect(control.body).toHaveProperty("data");
    const gate = h.captureNextSourceRead();
    const pending = h.read(viewKey, filters, SYNTHETIC_READ_TOKEN);
    await gate.captured;
    h.options.readToken = ROTATED_READER;
    gate.release();
    const denied = await pending;

    expect(denied.status).toBe(401);
    expect(denied.body.executionCertainty).toBe("notApplied");
    expectNoProtectedSuccess(denied.body);
    // Source/clock/coverage stayed usable; this refusal is caller authority.
    const fresh = await h.read(viewKey, filters, ROTATED_READER);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toHaveProperty("data");
    expect(h.revisionCount()).toBe(0);
    expect(h.successReceiptCount()).toBe(0);
  });

  it("refuses a fresh exact draft before commit if its reviewer token rotates while the snapshot is in flight", async () => {
    const h = await harness();
    const before = await h.read("emailFlow", { flow: "early-access" }, SYNTHETIC_REVIEW_TOKEN);
    expect(before.status).toBe(200);
    const original = saveRequest(nativeEmailFlowSchema.parse(before.body.data), "synthetic-precommit-revocation");
    const gate = h.captureNextSourceRead();
    const pending = h.request("/v1/save", original, SYNTHETIC_REVIEW_TOKEN);
    await gate.captured;
    h.options.reviewToken = ROTATED_REVIEWER;
    gate.release();
    const denied = await pending;

    expect(denied.status).toBe(401);
    expect(denied.body.executionCertainty).toBe("notApplied");
    expectNoProtectedSuccess(denied.body);
    expect(h.revisionCount()).toBe(0);
    expect(h.successReceiptCount()).toBe(0);
    expect(h.persistedReceipt(original.idempotencyKey)).toBeNull();

    const fresh = await h.read("emailFlow", {
      flow: "early-access", draftRequestKey: original.idempotencyKey,
    }, ROTATED_REVIEWER);
    expect(fresh.status).toBe(200);
    const view = nativeEmailFlowSchema.parse(fresh.body.data);
    expect(view.draft).toBeNull();
    expect(view.history.total).toBe(0);
    expect(view.requestedSave?.receipt).toBeNull();
    expect(view.requestedSave?.state).not.toBe("applied");
    // Do not turn an absent request row into a terminal rebase/new-key grant.
    // This case makes no second save and does not infer retry authority.
  });

  it("suppresses a postcommit success after token rotation and recovers only the original immutable receipt under current authorization", async () => {
    const h = await harness();
    const before = await h.read("emailFlow", { flow: "early-access" }, SYNTHETIC_REVIEW_TOKEN);
    expect(before.status).toBe(200);
    const original = saveRequest(nativeEmailFlowSchema.parse(before.body.data), "synthetic-postcommit-revocation");
    const db = h.app.store.database;
    const actualExec = db.exec.bind(db);
    let rotatedAfterCommit = 0;
    let committedReceiptJson: string | null = null;

    const observer = vi.spyOn(db, "exec").mockImplementation((sql: string) => {
      actualExec(sql); // Execute the actual transaction; never synthesize state.
      if (sql.trim().toUpperCase() !== "COMMIT" || rotatedAfterCommit !== 0) return;
      const row = db.prepare(
        "SELECT state,receipt FROM lifecycle_draft_requests WHERE request_key=?",
      ).get(original.idempotencyKey);
      if (row?.state === "recorded" && typeof row.receipt === "string") {
        // The source-observation transaction cannot enter this branch because
        // this fresh request has no receipt until the draft transaction commits.
        committedReceiptJson = row.receipt;
        rotatedAfterCommit++;
        h.options.reviewToken = ROTATED_REVIEWER;
      }
    });
    const denied = await h.request("/v1/save", original, SYNTHETIC_REVIEW_TOKEN);
    observer.mockRestore();

    expect(rotatedAfterCommit).toBe(1);
    expect(committedReceiptJson).not.toBeNull();
    const committed = saveReceiptSchema.parse(JSON.parse(committedReceiptJson!));
    expect(denied.status).toBe(401);
    expect(denied.body.executionCertainty).toBe("uncertain");
    expectNoProtectedSuccess(denied.body);
    expect(h.revisionCount()).toBe(1);
    expect(h.successReceiptCount()).toBe(1);
    expect(h.persistedReceipt(original.idempotencyKey)).toEqual(committed);
    expect(committed).toMatchObject({
      requestKey: original.idempotencyKey, expectedVersion: original.expectedVersion,
      persistedByRef: "agent-reviewer", resourceRef: original.resourceRef,
      record: { revision: 1, payload: original.payload },
    });

    const readsBeforeDeniedLookup = h.state.reads;
    const deniedLookup = await h.read("emailFlow", {
      flow: "early-access", draftRequestKey: original.idempotencyKey,
    }, SYNTHETIC_REVIEW_TOKEN);
    expect(deniedLookup.status).toBe(401);
    expectNoProtectedSuccess(deniedLookup.body);
    expect(h.state.reads).toBe(readsBeforeDeniedLookup);

    // A newly observed source version is allowed to change current readiness;
    // it must never substitute a newer draft/version for the original receipt.
    h.state.now++;
    h.state.source.version = "synthetic-later-source-version";
    h.state.source.observedAt = new Date(h.state.now).toISOString();
    const recovered = await h.read("emailFlow", {
      flow: "early-access", draftRequestKey: original.idempotencyKey,
    }, ROTATED_REVIEWER);
    expect(recovered.status).toBe(200);
    const view = nativeEmailFlowSchema.parse(recovered.body.data);
    expect(view.currentSourceMatch).toBe(false);
    expect(view.requestedSave).toMatchObject({
      state: "applied", disposition: "recorded", requestKey: original.idempotencyKey,
      actorRef: "agent-reviewer", expectedVersion: original.expectedVersion,
      original: { expectedVersion: original.expectedVersion, payload: original.payload },
      receipt: committed,
    });
    expect(view.requestedSave?.receipt).toEqual(committed);
    expect(h.revisionCount()).toBe(1);
    expect(h.successReceiptCount()).toBe(1);
    expect(h.persistedReceipt(original.idempotencyKey)).toEqual(committed);
    // Recovery is READ ONLY: no second POST/v1/save, rebase or new key.
  });
});



describe("lifecycle exact source grants at the real HTTP boundary", () => {
  it.each(["read", "save"] as const)("refuses a captured %s when the owner's current permission was withdrawn", async operation => {
    const h = await harness();
    const before = await h.read("emailFlow", { flow: "early-access" }, SYNTHETIC_REVIEW_TOKEN);
    const input = saveRequest(nativeEmailFlowSchema.parse(before.body.data), "synthetic-source-denial");
    const gate = h.captureNextSourceRead();
    const pending = operation === "read" ? h.read("emailFlow", { flow: "early-access" }, SYNTHETIC_REVIEW_TOKEN)
      : h.request("/v1/save", input, SYNTHETIC_REVIEW_TOKEN);
    await gate.captured; h.state.permitted = false; gate.release();
    const denied = await pending;
    expect(denied.status).toBe(403); expect(denied.body.executionCertainty).toBe("notApplied");
    expectNoProtectedSuccess(denied.body); expect(h.revisionCount()).toBe(0); expect(h.successReceiptCount()).toBe(0);
  });

  it.each(["principalRef", "requestDigest", "operation", "sourceVersion", "scope", "future", "expired"])("rejects a manipulated source binding: %s", async field => {
    const h = await harness(), source = h.options.lifecycleSource!, read = source.read.bind(source);
    source.read = async (binding, signal) => {
      const result = await read(binding, signal) as { authority: Record<string, unknown> };
      const values: Record<string, unknown> = { principalRef: "agent-reviewer", requestDigest: "0".repeat(64), operation: "save", sourceVersion: "other-source",
        scope: { ...lifecycleTestScope, accountId: "other-account" }, future: new Date(h.state.now + 1).toISOString(), expired: new Date(h.state.now).toISOString() };
      result.authority[field === "future" ? "observedAt" : field === "expired" ? "validUntil" : field] = values[field];
      return result;
    };
    const denied = await h.read("consentEligibility", {});
    expect([403, 502]).toContain(denied.status); expectNoProtectedSuccess(denied.body);
  });

  it.each(["missing", "async", "nonvoid"])("requires an actual synchronous void source assertion (%s)", async kind => {
    const h = await harness(), source = h.options.lifecycleSource!;
    if (kind === "missing") Object.assign(source, { assertCurrent: undefined });
    if (kind === "async") source.assertCurrent = async () => {};
    if (kind === "nonvoid") source.assertCurrent = () => "not-an-assertion";
    const denied = await h.read("lifecycleOverview", {});
    expect(denied.status).toBe(502); expectNoProtectedSuccess(denied.body);
  });

  it("does not disclose provider exception text, arbitrary codes or attached private fields", async () => {
    const h = await harness(), source = h.options.lifecycleSource!;
    source.assertCurrent = () => { throw new LifecycleError(SYNTHETIC_READ_TOKEN, 403, { currentVersion: SYNTHETIC_REVIEW_TOKEN, fieldErrors: { token: ROTATED_READER } }); };
    const denied = await h.read("activationRetention", {});
    expect(denied.status).toBe(403); expect(denied.body.code).toBe("SOURCE_AUTHORITY_DENIED");
    expect(denied.body).not.toHaveProperty("currentVersion"); expect(denied.body).not.toHaveProperty("fieldErrors"); expectNoProtectedSuccess(denied.body);
  });
});
