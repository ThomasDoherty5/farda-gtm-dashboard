// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "./server.ts";
import { approvalFixture, approvalTestScope as scope } from "./approvals/fixtures.testkit.ts";
import { actionDomainFixture, exportFixturePayload } from "./actions/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";
import { SCHEMA_VERSION, type ActionResponse } from "../adapter/contract.ts";
import type { ActionFoundationBindings } from "./actionFoundation.ts";
import type { DispatchHandler } from "./jobs/dispatchSchema.ts";
import { nativeApprovalViewSchema, nativeRunViewSchema, nativeReadinessViewSchema } from "./actions/views.ts";

const workerToken = "synthetic-separate-worker-token-not-for-deployment";
const relayToken = "synthetic-separate-relay-token-not-for-deployment";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(batch = 2) {
  const a = approvalFixture(), directory = mkdtempSync(join(tmpdir(), "farda-native-actions-http-"));
  const databasePath = join(directory, "actions.sqlite");
  a.draft.actionKind = "synthetic-task"; a.command.actionKind = a.draft.actionKind; a.draft.phase = "other";
  a.draft.acquisitionTerms = null; a.draft.effects.sendsCreator = false;
  a.draft.items = Array.from({ length: batch }, (_, n) => ({ ...a.draft.items[0]!, itemRef: `synthetic:item-${n}`, targetRef: `synthetic:task-${n}` }));
  a.draft.bounds.maxItems = batch; a.command.selectionRefs = a.draft.items.map(item => item.itemRef);
  a.humans.set("agent-reviewer", { ...structuredClone(a.humans.get("synthetic:requester")!), principalRef: "agent-reviewer", roles: ["founder"] });
  const state = { calls: 0, workerActive: true, workerWrongScope: false, workerOverlong: false, revokeDuringEffect: false };
  const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Fictional local task has no stock, money or native provider effect." };
  const handler: DispatchHandler = { policyVersion: a.policy.version, idempotency: "source-enforced", sourceEffect: "localArtifact", provider: na,
    resources: () => ({ budget: na, stock: na, quota: na }),
    budgets: { maxItems: 100, maxSteps: 1000, maxAttempts: 2, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async context => {
      state.calls++; if (state.revokeDuringEffect) state.workerActive = false;
      return { state: "applied", receipt: { receiptRef: "synthetic-local-receipt-" + context.intent.approval.itemRef,
        dispatchKey: context.dispatchKey, payloadHash: context.intent.approval.payloadHash, handlerRef: context.intent.handlerRef,
        providerBindingHash: context.providerBindingHash, sourceEffect: "localArtifact", observedAt: a.at() } };
    }, reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_LOOKUP_UNAVAILABLE" }) };
  const d = actionDomainFixture(81); d.snapshot.scope = scope; d.source.scope = scope;
  const bindings: ActionFoundationBindings = {
    approvals: { sources: a.sources, registry: a.options.registry, currentPolicy: a.options.currentPolicy },
    registry: new Map([[a.draft.actionKind, { handlerRef: "synthetic-task.v1" }]]), handlers: new Map([["synthetic-task.v1", handler]]),
    decisionRelay: { token: relayToken, ingressRef: "synthetic-authenticated-relay" },
    worker: { token: workerToken, workerRef: "synthetic-machine-worker", resolve: async (s, runRef) => ({
      scope: state.workerWrongScope ? { ...s, accountId: "synthetic-foreign-account" } : s, runRef, workerRef: "synthetic-machine-worker",
      authorityVersion: "synthetic-worker-directory-v1", observedAt: a.at(),
      validUntil: new Date(a.state.now + (state.workerOverlong ? 300001 : 10000)).toISOString() }),
      assertCurrent: () => { if (!state.workerActive) throw Object.assign(new Error("Worker revoked"), { status: 403, code: "DISPATCH_WORKER_AUTHORITY_INVALID" }); } },
  };
  let app: ReturnType<typeof createAgentServer>;
  let origin: string;
  async function start(extra: Partial<ActionFoundationBindings> = {}) {
    app = createAgentServer({ databasePath, readToken: reader, reviewToken: reviewer, workspaceId: scope.workspaceId, accountId: scope.accountId,
      operations: { now: () => a.state.now }, actionFoundation: { ...bindings, ...extra } });
    await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("No test address");
    origin = "http://127.0.0.1:" + address.port;
  }
  await start();
  cleanups.push(async () => { await app.close(); a.db.close(); rmSync(directory, { recursive: true, force: true }); });
  async function http(path: string, raw?: unknown, token: string | null = reviewer) {
    const response = await fetch(origin + path, { method: raw === undefined ? "GET" : "POST", headers: {
      ...(token ? { authorization: "Bearer " + token } : {}), ...(raw !== undefined ? { "content-type": "application/json" } : {}) },
      ...(raw === undefined ? {} : { body: JSON.stringify(raw) }) });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }
  const base = { schemaVersion: SCHEMA_VERSION, requestId: "synthetic-http-request", requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment },
    entityRefs: [], expectedVersion: "offer-v1", approvalRef: null, manifestRef: null, runRef: null, idempotencyKey: "synthetic-http-preview" };
  const preview = { ...base, operation: "previewAction", actionKind: a.draft.actionKind,
    payload: { entityRef: a.command.entityRef, entityVersion: a.command.entityVersion, selectionRefs: a.command.selectionRefs } };
  async function act(raw: unknown) { const result = await http("/v1/action", raw); expect(result.status, result.text).toBe(200); return JSON.parse(result.text) as ActionResponse; }
  function read(viewKey: string, filters: unknown) { return http("/v1/read", { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-read",
    requestedScope: base.requestedScope, viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 50 } }); }
  async function approve() {
    const p = await act(preview), request = await act({ ...base, operation: "requestApproval", actionKind: "requestApproval", expectedVersion: p.payloadVersion,
      approvalRef: p.approvalRef, manifestRef: p.manifestRef, idempotencyKey: "synthetic-request-decision", payload: {} });
    const event = a.event(app.actionFoundation.approvals.readApproval(request.approvalRef!)!);
    const observed = await http("/v1/approvals/observe", event.locator, relayToken); expect(observed.status, observed.text).toBe(200);
    return { ...base, operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", expectedVersion: request.payloadVersion,
      approvalRef: p.approvalRef, manifestRef: p.manifestRef, idempotencyKey: "synthetic-dispatch", payload: {} };
  }
  return { a, d, state, handler, bindings, http, read, act, base, preview, approve, app: () => app,
    restart: async (extra: Partial<ActionFoundationBindings> = {}) => { await app.close(); await start(extra); } };
}

describe("actual HTTP/shared SQLite action foundation; fictional sources only", () => {
  it("runs one frozen native batch via a separate authenticated worker, with verified source decisions and outcome links", async () => {
    const w = await fixture(), input = await w.approve();
    const approval = JSON.parse((await w.read("approvalDetail", { approvalId: input.approvalRef })).text);
    expect(nativeApprovalViewSchema.safeParse(approval.data).success).toBe(true);
    expect(approval.capabilities).toContainEqual({ actionKind: "dispatchApprovedAction", state: "available", reasonCodes: [] });
    expect(approval.data.approvedIsSent).toBe(false); expect(w.state.calls).toBe(0);
    const appDecision = await w.http("/v1/action", { ...input, operation: "decideApproval", actionKind: "decideApproval", payload: { decision: "approved" } });
    expect(appDecision.status).toBe(403);
    const queued = await w.act(input); expect(queued.state).toBe("queued"); expect(w.state.calls).toBe(0);
    for (const token of [reviewer, reader, relayToken]) expect((await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, token)).status).toBe(401);
    expect(w.state.calls).toBe(0);
    const done = await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken);
    expect(done.status, done.text).toBe(200); expect(JSON.parse(done.text)).toMatchObject({ state: "completed", receiptCount: 2, outcomeLinksVerified: true });
    expect(w.state.calls).toBe(2);
    const run = await w.read("runDetail", { runId: queued.runRef });
    expect(nativeRunViewSchema.safeParse(JSON.parse(run.text).data).success).toBe(true);
    expect(run.text).not.toContain("synthetic:private-message"); expect(run.text).not.toContain("synthetic:task-");
    expect((await w.act({ ...input, requestId: "synthetic-replay-http" })).state).toBe("succeeded");
    expect((await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken)).status).toBe(200);
    expect(w.state.calls).toBe(2); expect(w.app().store.database.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(1);
  });
  it("holds missing/foreign/overlong worker authority and refuses machine credentials as browser roles", async () => {
    const w = await fixture(1), queued = await w.act(await w.approve());
    w.state.workerWrongScope = true;
    expect((await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken)).status).toBe(403);
    w.state.workerWrongScope = false; w.state.workerOverlong = true;
    expect((await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken)).status).toBe(403);
    expect((await w.http("/v1/action", w.preview, workerToken)).status).toBe(401);
    expect((await w.http("/v1/approvals/observe", { decision: "approved" }, reviewer)).status).toBe(401);
    expect(w.state.calls).toBe(0);
  });
  it("cannot cancel a source-owned dispatch or expose its private references through the legacy operations API", async () => {
    const w = await fixture(1), input = await w.approve(), queued = await w.act(input);
    const run = w.app().operations.jobs.getRun(queued.runRef!), definition = run.definition;
    w.a.humans.get("agent-reviewer")!.active = false;
    const native = await w.http("/v1/action", { ...input, operation: "controlRun", actionKind: "cancelUnsent", runRef: queued.runRef,
      expectedVersion: queued.payloadVersion, idempotencyKey: "synthetic-revoked-cancel", payload: { control: "cancel" } });
    expect(native.status, native.text).toBe(403);
    for (const [path, body] of [
      [`/v1/job-runs/${run.runId}/control`, { command: "cancel" }],
      [`/v1/job-runs/${run.runId}/control`, { command: "pause" }],
      [`/v1/jobs/${definition.jobId}/pause`, { version: definition.version }],
      ["/v1/jobs/register", { definition, expectedVersion: definition.version - 1 }],
      ["/v1/jobs/register", { definition: { ...definition, version: definition.version + 1, mode: "observe", handler: "record-reference.v1", outputSchemaVersion: "job-local-result.v1" }, expectedVersion: definition.version }],
    ] as const) {
      const response = await w.http(path, body);
      expect(response.status, response.text).toBe(403);
      expect(JSON.parse(response.text)).toMatchObject({ code: "SOURCE_ACTION_BOUNDARY_REQUIRED", executionCertainty: "uncertain" });
    }
    for (const path of [`/v1/jobs/${definition.jobId}`, `/v1/job-runs/${run.runId}`, `/v1/job-runs/${run.runId}/history`]) {
      const response = await w.http(path, undefined, reader);
      expect(response.status, response.text).toBe(403);
      expect(response.text).not.toContain("payloadRef"); expect(response.text).not.toContain("itemRef");
    }
    for (const path of ["/v1/jobs", "/v1/job-runs"]) {
      const response = await w.http(path, undefined, reader);
      expect(response.status, response.text).toBe(200);
      expect(JSON.parse(response.text).data).toMatchObject({ records: [], total: 1, partial: true, restrictedCount: 1 });
      expect(response.text).not.toContain(definition.jobId); expect(response.text).not.toContain("payloadRef");
    }
    expect(w.app().operations.jobs.getRun(run.runId).control).toBe("active");
    expect(w.app().store.database.prepare("SELECT COUNT(*) n FROM job_dispatch_controls").get()?.n).toBe(0);
    expect(w.state.calls).toBe(0);
  });
  it("keeps ordinary observation jobs usable while refusing legacy ingress for a source-owned export", async () => {
    const w = await fixture(1), queued = await w.act(await w.approve()), dispatch = w.app().operations.jobs.getRun(queued.runRef!);
    const ordinary = { ...dispatch.definition, jobId: "synthetic-observation-job", version: 1, mode: "observe", handler: "record-reference.v1", outputSchemaVersion: "job-local-result.v1" };
    expect((await w.http("/v1/jobs/register", { definition: ordinary, expectedVersion: 0 })).status).toBe(200);
    const event = { schemaVersion: "job-reference-batch.v1", jobId: ordinary.jobId, jobVersion: 1, eventId: "synthetic-observation-event", eventType: ordinary.eventType,
      eventAt: null, items: [{ itemKey: "synthetic-observation-item", subjectRef: "synthetic-observation-subject", evidenceRef: null }] };
    const observation = w.app().operations.jobs.ingest(event, "synthetic-observation-ingress");
    expect((await w.http(`/v1/job-runs/${observation.runId}/control`, { command: "pause" })).status).toBe(200);
    expect(w.app().operations.jobs.getRun(observation.runId).control).toBe("paused");
    for (const path of ["/v1/jobs", "/v1/job-runs"]) {
      const result = await w.http(path, undefined, reader), data = JSON.parse(result.text).data;
      expect(result.status, result.text).toBe(200); expect(data.records).toHaveLength(1);
      expect(data).toMatchObject({ total: 2, partial: true, restrictedCount: 1 });
      expect(result.text).toContain(ordinary.jobId); expect(result.text).not.toContain(dispatch.definition.jobId);
    }
    const reserved = { ...ordinary, jobId: "synthetic-source-export-job", handler: "export-ledger-snapshot.v1" };
    w.app().operations.jobs.register(reserved, 0);
    for (const path of [`/v1/jobs/${reserved.jobId}`, `/v1/jobs/${reserved.jobId}/pause`])
      expect((await w.http(path, path.endsWith("/pause") ? { version: 1 } : undefined)).status).toBe(403);
    // Include the real ingress key; refusal must be the source boundary, not missing-key validation.
    const address = w.app().server.address(); if (!address || typeof address === "string") throw new Error("Missing test address");
    const ingress = await fetch(`http://127.0.0.1:${address.port}/v1/jobs/ingress`, { method: "POST", headers: { authorization: "Bearer " + reviewer,
      "content-type": "application/json", "idempotency-key": "synthetic-reserved-ingress" }, body: JSON.stringify({ ...event, jobId: reserved.jobId }) });
    expect(ingress.status).toBe(403); expect(await ingress.json()).toMatchObject({ code: "SOURCE_ACTION_BOUNDARY_REQUIRED" });
    expect(w.app().store.database.prepare("SELECT COUNT(*) n FROM job_runs WHERE job_id=?").get(reserved.jobId)?.n).toBe(0);
  });
  it("retains the actual local receipt when worker authority is revoked during the effect", async () => {
    const w = await fixture(1), queued = await w.act(await w.approve()); w.state.revokeDuringEffect = true;
    const result = await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken);
    expect(result.status, result.text).toBe(403); expect(JSON.parse(result.text).executionCertainty).toBe("applied");
    expect(w.state.calls).toBe(1);
    expect(w.app().actionFoundation.dispatch.read(queued.runRef!).items[0]!.receipt?.sourceEffect).toBe("localArtifact");
    w.state.workerActive = true;
    expect((await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken)).status).toBe(200); expect(w.state.calls).toBe(1);
  });
  it("returns typed 502 for an unknown worker outcome and never invokes another effect on replay", async () => {
    const w = await fixture(1), queued = await w.act(await w.approve());
    w.handler.execute = async () => { w.state.calls++; return { state: "unknown", reasonCode: "SYNTHETIC_LOST_ACK" }; };
    for (let n = 0; n < 2; n++) {
      const result = await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken);
      expect(result.status, result.text).toBe(502); expect(JSON.parse(result.text)).toMatchObject({ code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" });
    }
    expect(w.state.calls).toBe(1);
    expect(w.app().actionFoundation.dispatch.read(queued.runRef!).current.state).toBe("uncertain");
    const rotated = await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, "synthetic-rotated-worker-credential-not-a-secret");
    expect(rotated.status).toBe(401); expect(JSON.parse(rotated.text).executionCertainty).toBe("uncertain");
    w.state.workerWrongScope = true;
    const revoked = await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken);
    expect(revoked.status).toBe(403); expect(JSON.parse(revoked.text).executionCertainty).toBe("uncertain");
    expect(w.state.calls).toBe(1);
    await w.restart({ worker: undefined });
    const removed = await w.http("/v1/worker/dispatch", { runRef: queued.runRef }, workerToken);
    expect(removed.status).toBe(502); expect(JSON.parse(removed.text).executionCertainty).toBe("uncertain");
    expect(w.app().actionFoundation.dispatch.read(queued.runRef!, false).executionCertainty).toBe("uncertain"); expect(w.state.calls).toBe(1);
  });
  it("holds a decision's unknown canonical persistence and cannot repeat its attempted write", async () => {
    const w = await fixture(1), preview = await w.act(w.preview);
    const requested = await w.act({ ...w.base, operation: "requestApproval", actionKind: "requestApproval", expectedVersion: preview.payloadVersion,
      approvalRef: preview.approvalRef, manifestRef: preview.manifestRef, idempotencyKey: "synthetic-unknown-decision", payload: {} });
    const event = w.a.event(w.app().actionFoundation.approvals.readApproval(requested.approvalRef!)!); w.a.state.writerUnknown = true;
    const result = await w.http("/v1/approvals/observe", event.locator, relayToken);
    expect(result.status, result.text).toBe(502); expect(JSON.parse(result.text).executionCertainty).toBe("uncertain");
    const writes = w.a.state.writes;
    await w.http("/v1/approvals/observe", event.locator, relayToken);
    expect(w.a.state.writes).toBe(writes); expect(w.state.calls).toBe(0);
    expect(w.app().actionFoundation.approvals.readApproval(requested.approvalRef!)!.current.state).toBe("held");
  });
  it("persists principal admission across restart and never turns a lost-ACK replay refusal into notApplied", async () => {
    const w = await fixture(1), original = await w.act(w.preview);
    const expired = await w.http("/v1/action", w.preview, null);
    expect(expired.status).toBe(401); expect(JSON.parse(expired.text).executionCertainty).toBe("uncertain");
    for (let n = 1; n < 30; n++) await w.act({ ...w.preview, requestId: "synthetic-replay-" + n });
    await w.restart();
    const held = await w.http("/v1/action", w.preview);
    expect(held.status).toBe(429); expect(JSON.parse(held.text)).toMatchObject({ code: "RATE_LIMITED", executionCertainty: "uncertain" });
    expect(held.headers.get("retry-after")).toBe("60");
    expect(w.app().store.database.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);
    expect((await w.read("approvalDetail", { approvalId: original.approvalRef })).status).toBe(200);
    w.a.state.now += 60000; expect((await w.act(w.preview)).actionRef).toBe(original.actionRef);
  });
  it("exports the whole authorized ledger as a private CSV download and records readiness without granting release", async () => {
    const w = await fixture(1);
    // This test uses a separate fictional trusted source with the same actual server scope and named founder.
    w.a.state.now = w.d.now();
    const founder = w.a.humans.get("agent-reviewer")!;
    founder.observedAt = w.a.at(); founder.validUntil = w.a.until();
    const readinessSource = { ...w.d.readiness, write: async (intent: Parameters<typeof w.d.readiness.write>[0]) => {
      const result = await w.d.readiness.write(intent); w.a.state.now = w.d.now(); return result;
    } };
    await w.restart({ ledger: w.d.ledger, readiness: readinessSource, readinessTargetRef: w.d.source.targetRef });
    const exported = await w.act({ ...w.base, operation: "exportSnapshot", actionKind: "exportLedger", expectedVersion: w.d.snapshot.version,
      idempotencyKey: "synthetic-export", payload: exportFixturePayload });
    const csv = await w.http("/v1/action-artifacts/" + exported.actionRef);
    expect(csv.status, csv.text).toBe(200); expect(csv.headers.get("cache-control")).toBe("no-store");
    expect(csv.text.trim().split("\n")).toHaveLength(82); expect(csv.text).not.toContain("native-creator-");
    expect((await w.http("/v1/action-artifacts/" + exported.actionRef, undefined, null)).status).toBe(401);
    const readiness = await w.read("launchControl", {}), view = nativeReadinessViewSchema.parse(JSON.parse(readiness.text).data);
    expect(readiness.status).toBe(200); expect(view.confersRelease).toBe(false);
    expect(JSON.parse(readiness.text).capabilities).toContainEqual({ actionKind: "recordLaunchReadiness", state: "available", reasonCodes: [] });
    const recorded = await w.act({ ...w.base, operation: "recordSourceDecision", actionKind: "recordLaunchReadiness", expectedVersion: view.version,
      entityRefs: [{ source: "launch-readiness", accountId: scope.accountId, sourceId: null, canonicalId: view.targetRef, url: null, identityState: "resolved", provenanceRef: view.version }],
      idempotencyKey: "synthetic-record-readiness", payload: { verdict: "hold", launchDate: view.launchDate, rationale: "Fictional founder review only", evidenceRefs: view.evidenceRefs } });
    expect(recorded.reasonCodes).toContain("READINESS_RECORDED_RELEASE_NOT_GRANTED"); expect(w.d.state.writes).toBe(1); expect(w.state.calls).toBe(0);
    const recovered = await w.read("launchControl", { requestKey: "synthetic-record-readiness" });
    expect(recovered.status, recovered.text).toBe(200);
    expect(JSON.parse(recovered.text).data.requestRecovery).toMatchObject({ state: "recorded", intent: { requestKey: "synthetic-record-readiness", expectedVersion: view.version },
      receipt: { confersRelease: false } });
    expect(w.d.state.writes).toBe(1);
    w.d.state.denySource = true;
    expect((await w.http("/v1/action-artifacts/" + exported.actionRef)).status).toBe(403);
  });
});
