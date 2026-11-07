// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "./server.ts";
import { canonicalRewardFixture } from "./rewards/canonicalFixture.testkit.ts";
import { redemptionViewSchema } from "./rewards/contract.ts";
import { REWARD_ACTION } from "./rewards/canonicalContract.ts";
import { SCHEMA_VERSION, type ActionResponse } from "../adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";
import type { ActionFoundationBindings } from "./actionFoundation.ts";

const workerToken = "synthetic-reward-worker-token-not-for-deployment";
const relayToken = "synthetic-reward-relay-token-not-for-deployment";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** The fixture supplies fictional native sources only. All records exercised below belong to the actual HTTP server's own SQLite. */
async function fixture(physical = false, configured = true) {
  const world = await canonicalRewardFixture(":memory:", physical), a = world.approval, scope = world.scope;
  const directory = mkdtempSync(join(tmpdir(), "farda-reward-action-http-")), databasePath = join(directory, "native.sqlite");
  a.humans.set("agent-reviewer", { ...structuredClone(a.humans.get("synthetic:requester")!), principalRef: "agent-reviewer" });
  const bindings: ActionFoundationBindings = {
    approvals: { sources: a.sources, currentPolicy: a.options.currentPolicy },
    resources: world.resources,
    decisionRelay: { token: relayToken, ingressRef: "synthetic-reward-relay" },
    worker: { token: workerToken, workerRef: "synthetic-reward-worker",
      resolve: async (actualScope, runRef) => ({ scope: actualScope, runRef, workerRef: "synthetic-reward-worker",
        authorityVersion: "synthetic-worker-v1", observedAt: a.at(), validUntil: a.until() }),
      assertCurrent: proof => { if (proof.authorityVersion !== "synthetic-worker-v1") throw new Error("Synthetic worker authority changed"); } },
  };
  // Deliberately omit nested commercialPolicy: server must inject the one configured shared source.
  const authority = { entitlement: world.authority.entitlement, quote: world.authority.quote, provider: world.authority.provider,
    outcome: world.authority.outcome, cashMovement: world.authority.cashMovement };
  const app = createAgentServer({ databasePath, workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: reader, reviewToken: reviewer, rewardAuthority: authority,
    operations: { now: () => a.state.now, resolveReceipt: ref => world.capabilityReceipts.get(ref) ?? null },
    actionFoundation: bindings,
    ...(configured ? { commercialPolicy: world.commercialPolicy, rewardDomain: { source: world.source, registration: world.registration } } : {}),
  });
  cleanups.push(async () => {
    try { await app.close(); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING") throw error; }
    finally { a.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  for (const binding of configured ? [world.registration.binding, world.registration.reconcileBinding] : []) {
    const row = app.operations.ledger.register({ binding, ownerRef: "owner:synthetic-provider", costBasis: { state: "unknown", reasonCode: "SYNTHETIC_NO_COST_BASIS" } }, 0);
    await app.operations.ledger.verify(row.capabilityId, "receipt:" + binding.mode, 1);
  }
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Missing synthetic server address");
  const origin = "http://127.0.0.1:" + address.port;
  async function http(path: string, raw?: unknown, token = reviewer, key?: string) {
    const response = await fetch(origin + path, { method: raw === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + token, ...(raw === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}) }, ...(raw === undefined ? {} : { body: JSON.stringify(raw) }) });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as unknown };
  }
  const preparedResponse = await http("/v1/rewards/redemptions", world.request, reviewer, "synthetic-http-prepare");
  expect(preparedResponse.status, preparedResponse.text).toBe(200);
  const prepared = redemptionViewSchema.parse(preparedResponse.body);
  const base = { schemaVersion: SCHEMA_VERSION, requestId: "synthetic-reward-http", requestedScope: {
    workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment },
    entityRefs: [], expectedVersion: String(prepared.revision), approvalRef: null, manifestRef: null, runRef: null,
    idempotencyKey: "synthetic-reward-preview" };
  const preview = { ...base, operation: "previewAction", actionKind: REWARD_ACTION,
    payload: { entityRef: prepared.redemptionId, entityVersion: String(prepared.revision), selectionRefs: [prepared.redemptionId] } };
  async function action(raw: unknown) {
    const response = await http("/v1/action", raw);
    expect(response.status, response.text).toBe(200);
    return response.body as ActionResponse;
  }
  async function request() {
    const p = await action(preview);
    const requested = await action({ ...base, operation: "requestApproval", actionKind: "requestApproval",
      approvalRef: p.approvalRef, manifestRef: p.manifestRef, expectedVersion: p.payloadVersion,
      idempotencyKey: "synthetic-reward-request", payload: {} });
    return { p, requested };
  }
  async function approve() {
    const { p, requested } = await request();
    const record = app.actionFoundation.approvals.readApproval(requested.approvalRef!)!;
    const event = a.event(record, "approved", "synthetic:founder");
    const observed = await http("/v1/approvals/observe", event.locator, relayToken);
    expect(observed.status, observed.text).toBe(200);
    const command = { ...base, operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction",
      approvalRef: p.approvalRef, manifestRef: p.manifestRef, expectedVersion: requested.payloadVersion,
      idempotencyKey: "synthetic-reward-handoff", payload: {} };
    return { command, requested, queued: await action(command) };
  }
  return { world, a, scope, app, http, action, base, preview, prepared, request, approve };
}

describe("canonical reward through actual authenticated HTTP and the shared SQLite", () => {
  it.each([false, true])("runs one founder-approved native reward; physical=%s", async physical => {
    const f = await fixture(physical);
    expect(f.prepared.state).toBe("awaiting-approval");
    expect(f.prepared.option).not.toBeNull();
    const { queued, command, requested } = await f.approve();
    expect(queued.state).toBe("queued"); expect(f.world.state.calls).toBe(0);
    const approval = f.app.actionFoundation.approvals.readApproval(requested.approvalRef!)!;
    expect(approval.manifest.draft.phase).toBe("rewardRedemption");
    expect(approval.manifest.draft.bounds.maxSpendMinor).toBe(30000);
    for (const token of [reader, reviewer, relayToken])
      expect((await f.http("/v1/worker/dispatch", { runRef: queued.runRef }, token)).status).toBe(401);
    const result = await f.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken);
    expect(result.status, result.text).toBe(200);
    expect(result.body).toMatchObject({ state: "completed", executionCertainty: "applied", receiptCount: 1, outcomeLinksVerified: true });
    expect(f.world.state.calls).toBe(1);
    const recordResponse = await f.http("/v1/rewards/redemptions/" + f.prepared.redemptionId, undefined, reader);
    const record = redemptionViewSchema.parse(recordResponse.body);
    expect(record.state).toBe("purchased"); expect(record.money.chargedMinor).toBe(26900);
    const stock = [...f.world.grants.values()].filter(grant => grant.dimension === "stock");
    expect(stock).toHaveLength(physical ? 1 : 0);
    expect(record.receipts.physicalAllocationRef).toBe(physical ? stock[0]!.grantRef : null);
    expect((await f.action(command)).state).toBe("succeeded");
    expect((await f.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken)).status).toBe(200);
    expect(f.world.state.calls).toBe(1);
    const linked = f.app.actionFoundation.approvals.readApproval(requested.approvalRef!)!;
    expect(linked.outbox.filter(box => box.kind === "outcome")).toEqual([expect.objectContaining({ state: "recorded" })]);
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM approval_decisions").get()?.n).toBe(1);
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(1);
    expect(f.world.approval.db.prepare("SELECT COUNT(*) n FROM approval_decisions").get()?.n).toBe(0);
    expect(f.world.approval.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(0);
    const retired = await f.http("/v1/rewards/redemptions/" + f.prepared.redemptionId + "/purchase", {}, reviewer, "synthetic-retired-purchase");
    expect(retired).toMatchObject({ status: 409, body: { code: "CANONICAL_REWARD_ACTION_REQUIRED", executionCertainty: "uncertain" } });
  });

  it("holds nonfounder approval below $500 and refuses app approval", async () => {
    const f = await fixture(), { requested } = await f.request();
    const event = f.a.event(f.app.actionFoundation.approvals.readApproval(requested.approvalRef!)!, "approved", "synthetic:reviewer");
    const observed = await f.http("/v1/approvals/observe", event.locator, relayToken);
    expect(observed.status, observed.text).toBe(403);
    expect(observed.body).toMatchObject({ code: "FORBIDDEN", executionCertainty: "uncertain" });
    const appDecision = await f.http("/v1/action", { ...f.base, operation: "decideApproval", actionKind: "decideApproval",
      approvalRef: requested.approvalRef, manifestRef: requested.manifestRef, expectedVersion: requested.payloadVersion,
      idempotencyKey: "synthetic-app-decision", payload: { decision: "approved" } });
    expect(appDecision.status, appDecision.text).toBe(403);
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM approval_decisions").get()?.n).toBe(0);
    expect(f.world.state.calls).toBe(0);
  });

  it("holds unconfigured policy/domain instead of manufacturing candidate reward permission", async () => {
    const f = await fixture(false, false);
    expect(f.prepared.state).toBe("held"); expect(f.prepared.option).toBeNull();
    expect(f.prepared.heldReasons).toContain("REWARD_TERMS_UNAVAILABLE");
    const preview = await f.http("/v1/action", f.preview);
    expect(preview.status).not.toBe(200);
    const retired = await f.http("/v1/rewards/redemptions/" + f.prepared.redemptionId + "/decisions", { decisionRef: "synthetic-forged-approval" }, reviewer, "synthetic-retired-decision");
    expect(retired).toMatchObject({ status: 409, body: { code: "CANONICAL_REWARD_ACTION_REQUIRED" } });
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM approval_decisions").get()?.n).toBe(0);
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(0);
    expect(f.world.state.calls).toBe(0);
  });

  it("rechecks withdrawn source permission at the machine boundary without losing earned liability", async () => {
    const f = await fixture(), { queued } = await f.approve();
    f.world.state.denySource = true;
    const result = await f.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken);
    expect(result.status).not.toBe(200); expect(f.world.state.calls).toBe(0);
    const record = redemptionViewSchema.parse((await f.http("/v1/rewards/redemptions/" + f.prepared.redemptionId, undefined, reader)).body);
    expect(record.money.outstandingLiabilityMinor).toBe(30000);
  });
});
