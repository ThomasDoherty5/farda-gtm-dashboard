/** Fictional provider data; exercises the actual HTTP server and its own SQLite. No real source connection. */
import assert from "node:assert/strict";
import { parameterSetSchema } from "./mediaControl/contract.ts";
import { createAgentServer } from "./server.ts";
import { canonicalMediaFixture } from "./media/canonicalFixture.testkit.ts";
import { MEDIA_STAGE_ACTION, type CanonicalMediaAction } from "./media/canonicalContract.ts";
import { SCHEMA_VERSION, type ActionResponse } from "../adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";
import type { ActionFoundationBindings } from "./actionFoundation.ts";

const workerToken = "synthetic-media-worker-token-not-for-deployment", relayToken = "synthetic-media-relay-token-not-for-deployment";
export async function createMediaHttpFixture(configured = true, capMinor = 150000, options: { port?: number } = {}) {
  const world = await canonicalMediaFixture(), a = world.approval, scope = world.scope;
  a.humans.set("agent-reviewer", { ...structuredClone(a.humans.get("synthetic:requester")!), principalRef: "agent-reviewer" });
  const bindings: ActionFoundationBindings = { approvals: { sources: a.sources, currentPolicy: a.options.currentPolicy }, resources: world.resources,
    decisionRelay: { token: relayToken, ingressRef: "synthetic-media-relay" }, worker: { token: workerToken, workerRef: "synthetic-media-worker",
      resolve: async (actualScope, runRef) => ({ scope: actualScope, runRef, workerRef: "synthetic-media-worker", authorityVersion: "synthetic-worker-v1", observedAt: a.at(), validUntil: a.until() }),
      assertCurrent: proof => { if (proof.authorityVersion !== "synthetic-worker-v1") throw new Error("Synthetic worker authority changed."); } } };
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: scope.workspaceId, accountId: scope.accountId, readToken: reader, reviewToken: reviewer,
    operations: { now: () => a.state.now, resolveReceipt: ref => world.receipts.get(ref) ?? null }, actionFoundation: bindings,
    ...(configured ? { mediaDomain: { readers: world.kernel.mediaAuthority, controlReaders: world.kernel.authority,
      source: world.source, stageSource: world.stageSource, registration: world.registration } } : {}) });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { try { await app.close(); }
    catch(error) { if(!(error instanceof Error) || !("code" in error) || error.code!=="ERR_SERVER_NOT_RUNNING") throw error; }
    finally { a.db.close(); } })();
  try {
  if (app.mediaDomain) {
    // Provider facts remain fictional. All business records, J04 receipts and jobs exercised below belong to the HTTP application's own SQLite.
    world.kernel.media = app.mediaDomain.repository; world.kernel.control = app.mediaDomain.controller;
    const stagePolicy=parameterSetSchema.parse(world.kernel.params).stagePolicy;
    if(!stagePolicy)throw new Error("Missing synthetic adopted stage policy.");
    stagePolicy.value[0]!.capMinor=capMinor;world.kernel.params.stagePolicy=stagePolicy;
    app.mediaDomain.controller.proposeStage(world.kernel.terms({capMinor,allocations:world.kernel.terms().allocations.map(row=>({...row,capMinor:capMinor/2}))}), "synthetic-http-stage-intent");
    for (const account of world.registration.accounts) for (const pair of Object.values(account.bindings)) for (const binding of [pair.execute, pair.reconcile]) {
      const row = app.operations.ledger.register({ binding, ownerRef: "owner:synthetic-media-source", costBasis: { state: "unknown", reasonCode: "SYNTHETIC_COST_UNKNOWN" } }, 0);
      const receipt = [...world.receipts.values()].find(item => JSON.stringify(item.binding) === JSON.stringify(binding));
      if (!receipt) throw new Error("Missing exact synthetic source receipt."); await app.operations.ledger.verify(row.capabilityId, receipt.receiptRef, 1);
    }
  }
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(options.port ?? 0, "127.0.0.1", resolve); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Missing synthetic HTTP address.");
  const port=address.port;
  async function http(path: string, raw?: unknown, token = reviewer) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: raw === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(raw === undefined ? {} : { "content-type": "application/json" }) }, ...(raw === undefined ? {} : { body: JSON.stringify(raw) }) });
    const text = await response.text(); return { status: response.status, text, body: JSON.parse(text) as unknown };
  }
  let sequence = 0;
  const base = () => ({ schemaVersion: SCHEMA_VERSION, requestId: `synthetic-media-request-${++sequence}`, requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment },
    entityRefs: [], expectedVersion: "0", approvalRef: null, manifestRef: null, runRef: null, idempotencyKey: `synthetic-media-key-${sequence}` });
  async function action(raw: unknown) { const response = await http("/v1/action", raw); assert.equal(response.status, 200, response.text); return response.body as ActionResponse; }
  async function request(actionKind: CanonicalMediaAction | typeof MEDIA_STAGE_ACTION, entityRef: string) {
    const version = actionKind === MEDIA_STAGE_ACTION ? String(app.mediaDomain!.controller.canonicalStageRequest(entityRef).revision)
      : app.mediaDomain!.repository.canonicalRequest(entityRef, actionKind).entityVersion;
    const p = await action({ ...base(), expectedVersion:version, operation: "previewAction", actionKind, payload: { entityRef, entityVersion: version, selectionRefs: [entityRef] } });
    const requested = await action({ ...base(), operation: "requestApproval", actionKind: "requestApproval", approvalRef: p.approvalRef, manifestRef: p.manifestRef,
      expectedVersion: p.payloadVersion, payload: {} }); return { p, requested };
  }
  async function approve(actionKind: CanonicalMediaAction | typeof MEDIA_STAGE_ACTION, entityRef: string) {
    const { p, requested } = await request(actionKind, entityRef), record = app.actionFoundation.approvals.readApproval(requested.approvalRef!)!;
    const event = a.event(record, "approved", "synthetic:founder", `synthetic-http-event-${sequence}`);
    const observed = await http("/v1/approvals/observe", event.locator, relayToken); assert.equal(observed.status, 200, observed.text);
    const command = { ...base(), operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", approvalRef: p.approvalRef, manifestRef: p.manifestRef,
      expectedVersion: requested.payloadVersion, payload: {} };
    return { command, queued: await action(command), requested };
  }
  async function run(actionKind: CanonicalMediaAction | typeof MEDIA_STAGE_ACTION, entityRef: string) {
    const approved = await approve(actionKind, entityRef), executed = await http("/v1/worker/dispatch", { runRef: approved.queued.runRef }, workerToken);
    assert.equal(executed.status, 200, executed.text); return { ...approved, executed };
  }
  function prepare(provider: "meta" | "tiktok" = "meta") {
    // The private owning job proposes a local intent; no provider operation or approval is issued here.
    const template = world.kernel.prepare(provider), raw = JSON.parse(String(a.db.prepare("SELECT body FROM media_campaigns WHERE campaign_id=?").get(template.campaignId)!.body));
    return app.mediaDomain!.repository.prepare(raw.input, `synthetic-http-campaign-${sequence++}`);
  }
  return { world, a, app, http, action, base, prepare, request, approve, run, close, origin: `http://127.0.0.1:${port}` };
  } catch(error) { await close(); throw error; }
}

