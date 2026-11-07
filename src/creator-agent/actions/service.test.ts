// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture, approvalTestScope as scope } from "../approvals/fixtures.testkit.ts";
import { JobRepository } from "../jobs/repository.ts";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";
import { createActionService, domainActionSchema, foundationActionSchema } from "./service.ts";
import { SCHEMA_VERSION } from "../../adapter/contract.ts";
import { actionTestSecret as secret } from "./fixtures.testkit.ts";

const databases: ReturnType<typeof approvalFixture>["db"][] = [];
const principal = { principalRef: "synthetic:requester" };
function setup(batch = 1) {
  const a = approvalFixture();
  a.draft.actionKind = "synthetic-task"; a.draft.phase = "other"; a.draft.acquisitionTerms = null; a.draft.effects.sendsCreator = false;
  a.command.actionKind = a.draft.actionKind;
  a.draft.items = Array.from({ length: batch }, (_, i) => ({ ...a.draft.items[0]!, itemRef: `synthetic:item-${i + 1}`, targetRef: `synthetic:task-${i + 1}` }));
  a.draft.bounds.maxItems = batch; a.command.selectionRefs = a.draft.items.map(i => i.itemRef);
  let calls = 0;
  const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Synthetic local task artifact has no money, inventory or provider calls." };
  const handler: DispatchHandler = { idempotency: "source-enforced", sourceEffect: "localArtifact", policyVersion: a.policy.version, provider: na,
    resources: () => ({ budget: na, stock: na, quota: na }), budgets: { maxItems: 100, maxSteps: 1000, maxAttempts: 2, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async c => { calls++; return { state: "applied", receipt: { receiptRef: "synthetic-receipt-" + c.intent.approval.itemRef,
      dispatchKey: c.dispatchKey, payloadHash: c.intent.approval.payloadHash, handlerRef: c.intent.handlerRef, providerBindingHash: c.providerBindingHash, sourceEffect: "localArtifact", observedAt: a.at() } }; },
    reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_NO_LOOKUP" }) };
  const jobs = new JobRepository(a.db, { scope, now: () => a.state.now });
  const dispatch = new DispatchGuard({ db: a.db, jobs, scope, approvals: a.repo, handlers: new Map([["synthetic-task.v1", handler]]), now: () => a.state.now });
  const service = createActionService({ scope, secret, approvals: a.repo, dispatch, registry: new Map([["synthetic-task", { handlerRef: "synthetic-task.v1" }]]), authorize: a.sources.resolveActor, assertAuthority: a.sources.assertCurrent, now: () => a.state.now });
  const base = { schemaVersion: SCHEMA_VERSION, requestId: "synthetic-http-1", requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" as const }, entityRefs: [], approvalRef: null, manifestRef: null, runRef: null, idempotencyKey: "synthetic-preview", expectedVersion: "offer-v1" };
  const preview = { ...base, operation: "previewAction" as const, actionKind: "synthetic-task", payload: { entityRef: a.command.entityRef, entityVersion: a.command.entityVersion, selectionRefs: a.command.selectionRefs } };
  async function approved() {
    const p = await service.execute(preview, principal);
    const request = { ...base, operation: "requestApproval" as const, actionKind: "requestApproval" as const, approvalRef: p.approvalRef!, manifestRef: p.manifestRef!, expectedVersion: p.payloadVersion, idempotencyKey: "synthetic-request", payload: {} };
    const r = await service.execute(request, principal), read = a.repo.readApproval(r.approvalRef!)!;
    const event = a.event(read); await a.repo.observeDecision(event.locator, { ingressRef: "synthetic-ingress" });
    const current = a.repo.readApproval(r.approvalRef!)!;
    return { request, current, dispatchInput: { ...base, operation: "dispatchApprovedAction" as const, actionKind: "dispatchApprovedAction" as const,
      approvalRef: r.approvalRef!, manifestRef: service.manifestRef(current), expectedVersion: service.approvalVersion(current), idempotencyKey: "synthetic-dispatch", payload: {} } };
  }
  const world = { ...a, jobs, dispatch, service, handler, base, preview, approved, calls: () => calls }; databases.push(a.db); return world;
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("strict shared orchestration with actual J04 and existing SQLite runner", () => {
  it("stores exact preview and canonical decision request without source execution; re-envelopes replay requestId", async () => {
    const w = setup(), p = await w.service.execute(w.preview, principal);
    expect(p.runRef).toBeNull(); expect(p.executionCertainty).toBe("applied"); expect(w.calls()).toBe(0);
    const again = await w.service.execute({ ...w.preview, requestId: "synthetic-replay" }, principal);
    expect(again).toEqual({ ...p, requestId: "synthetic-replay" });
    expect(w.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);
  });
  it("makes a true finite native task batch and reports success only when every item has a native receipt", async () => {
    const w = setup(3), { dispatchInput } = await w.approved();
    const queued = await w.service.execute(dispatchInput, principal); expect(queued.state).toBe("queued"); expect(w.calls()).toBe(0);
    const first = await w.dispatch.execute(queued.runRef!); expect(first.items).toHaveLength(3); expect(w.calls()).toBe(3);
    const replay = await w.service.execute({ ...dispatchInput, requestId: "synthetic-done-read" }, principal);
    expect(replay.state).toBe("succeeded"); expect(replay.receiptRefs).toHaveLength(3); expect(w.calls()).toBe(3);
    expect(w.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(1);
    const read = await w.service.readApproval(queued.approvalRef!, principal);
    expect(read.phase).toBe("other"); expect(read.items[0]!.targetRef).toMatch(/^target-/);
    expect(JSON.stringify(read)).not.toContain("synthetic:task-"); expect(JSON.stringify(read)).not.toContain("synthetic:private-message");
    expect(read).not.toHaveProperty("commission"); expect(read).not.toHaveProperty("creator");
  });
  it("recovers an original approval request after the manifest is superseded without rewriting either preview", async () => {
    const w = setup(), { request, current } = await w.approved();
    const edit = { ...w.preview, idempotencyKey: "synthetic-edited-preview", approvalRef: current.manifest.approvalRef, manifestRef: w.service.manifestRef(current), expectedVersion: w.service.approvalVersion(current) };
    const next = await w.service.execute(edit, principal); expect(next.payloadVersion).not.toBe(request.expectedVersion);
    const replay = await w.service.execute({ ...request, requestId: "synthetic-original-request" }, principal);
    expect(replay.manifestRef).toBe(request.manifestRef); expect(replay.reasonCodes).toContain("APPROVAL_VERSION_CHANGED"); expect(w.state.writes).toBe(2);
    expect(w.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(2);
  });
  it("keeps Slack-default app decisions held and refuses actor/scope/payload injections", async () => {
    const w = setup(), { current } = await w.approved();
    await expect(w.service.execute({ ...w.base, operation: "decideApproval", actionKind: "decideApproval", approvalRef: current.manifest.approvalRef, manifestRef: w.service.manifestRef(current), expectedVersion: w.service.approvalVersion(current), payload: { decision: "approved" } }, principal)).rejects.toMatchObject({ code: "APPROVAL_CHANNEL_REQUIRED", status: 403 });
    await expect(w.service.execute({ ...w.preview, requestedScope: { ...w.base.requestedScope, accountIds: ["other"] } }, principal)).rejects.toMatchObject({ status: 403 });
    expect(foundationActionSchema.safeParse({ ...w.preview, actor: "founder" }).success).toBe(false);
    expect(foundationActionSchema.safeParse({ ...w.preview, payload: { ...w.preview.payload, enabled: true } }).success).toBe(false);
    expect(foundationActionSchema.safeParse({ ...w.preview, runRef: "invented-run" }).success).toBe(false);
  });
  it("retains the original control request after lost ACK, with no repeated transition and no changed-body replay", async () => {
    const w = setup(), { dispatchInput } = await w.approved(), queued = await w.service.execute(dispatchInput, principal);
    const pause = { ...w.base, operation: "controlRun", actionKind: "pauseRun", approvalRef: queued.approvalRef, manifestRef: queued.manifestRef, runRef: queued.runRef,
      expectedVersion: queued.payloadVersion, idempotencyKey: "synthetic-pause", payload: { control: "pause" } };
    const paused = await w.service.execute(pause, principal), replay = await w.service.execute({ ...pause, requestId: "synthetic-pause-replay" }, principal);
    expect(paused.state).toBe("paused"); expect(replay).toEqual({ ...paused, requestId: "synthetic-pause-replay" });
    await expect(w.service.execute({ ...pause, actionKind: "cancelUnsent", payload: { control: "cancel" } }, principal)).rejects.toThrow("DISPATCH_IDEMPOTENCY_KEY_REUSED");
    expect(w.calls()).toBe(0);
  });
  it("cannot forge a scoped signed version or select an unrelated manifest item", async () => {
    const w = setup(), { dispatchInput } = await w.approved();
    const forged = dispatchInput.expectedVersion.slice(0, -1) + (dispatchInput.expectedVersion.endsWith("0") ? "1" : "0");
    await expect(w.service.execute({ ...dispatchInput, expectedVersion: forged }, principal)).rejects.toThrow("STALE_VERSION");
    await expect(w.service.execute({ ...dispatchInput, payload: { itemRefs: ["foreign-item"] } }, principal)).rejects.toThrow("EXACT_MANIFEST_ITEM_REQUIRED");
    await expect(w.service.readApproval(dispatchInput.approvalRef, { principalRef: "synthetic:reviewer" })).rejects.toMatchObject({ status: 403 });
  });
  it("holds a first dispatch without current canonical approval; never creates a run", async () => {
    const w = setup(), p = await w.service.execute(w.preview, principal);
    await expect(w.service.execute({ ...w.base, operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", approvalRef: p.approvalRef,
      manifestRef: p.manifestRef, expectedVersion: p.payloadVersion, payload: {} }, principal)).rejects.toMatchObject({ executionCertainty: "notApplied" });
    expect(w.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(0);
  });
  it("keeps applied or uncertain certainty on exact replay after named actor authority is withdrawn", async () => {
    const w = setup(), { dispatchInput } = await w.approved(), queued = await w.service.execute(dispatchInput, principal);
    const pause = { ...w.base, operation: "controlRun", actionKind: "pauseRun", approvalRef: queued.approvalRef, manifestRef: queued.manifestRef, runRef: queued.runRef,
      expectedVersion: queued.payloadVersion, idempotencyKey: "synthetic-pause-outcome", payload: { control: "pause" } };
    await w.service.execute(pause, principal); w.humans.get(principal.principalRef)!.active = false;
    await expect(w.service.execute(pause, principal)).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
    await expect(w.service.execute(dispatchInput, principal)).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
    const u = setup(), approved = await u.approved(), q = await u.service.execute(approved.dispatchInput, principal);
    u.handler.execute = async () => ({ state: "unknown", reasonCode: "SYNTHETIC_TIMEOUT" }); await u.dispatch.execute(q.runRef!);
    u.humans.get(principal.principalRef)!.active = false;
    await expect(u.service.execute(approved.dispatchInput, principal)).rejects.toMatchObject({ status: 403, executionCertainty: "uncertain" });
  });
  it("replays historical completion with current approval expiry reasons and never executes again", async () => {
    const w = setup(), { dispatchInput } = await w.approved(), queued = await w.service.execute(dispatchInput, principal);
    await w.dispatch.execute(queued.runRef!); w.state.now += 121000;
    const replay = await w.service.execute(dispatchInput, principal);
    expect(replay.state).toBe("succeeded"); expect(replay.reasonCodes).toContain("APPROVAL_EXPIRED"); expect(w.calls()).toBe(1);
  });
  it("clears a protected approval projection when the requester loses authority during the decision-source await", async () => {
    const w = setup(), { current } = await w.approved(), reader = w.sources.readSlackDecision!;
    w.sources.readSlackDecision = async (...args) => { const result = await reader(...args); w.humans.get(principal.principalRef)!.active = false; return result; };
    await expect(w.service.readApproval(current.manifest.approvalRef, principal)).rejects.toMatchObject({ code: "AUTHORITY_REQUIRED", status: 403 });
  });
  it("retains a reconciled effect but clears its protected response if the requester is revoked during native readback", async () => {
    const w = setup(), { dispatchInput } = await w.approved(), queued = await w.service.execute(dispatchInput, principal);
    w.handler.execute = async () => ({ state: "unknown", reasonCode: "SYNTHETIC_LOST_ACK" }); await w.dispatch.execute(queued.runRef!);
    w.handler.reconcile = async c => { w.humans.get(principal.principalRef)!.active = false; return { state: "applied", receipt: {
      receiptRef: "synthetic-reconciled-receipt", dispatchKey: c.dispatchKey, payloadHash: c.intent.approval.payloadHash, handlerRef: c.intent.handlerRef,
      providerBindingHash: c.providerBindingHash, sourceEffect: "localArtifact", observedAt: w.at() } }; };
    const input = { ...w.base, operation: "reconcileRun", actionKind: "lookup", runRef: queued.runRef, approvalRef: queued.approvalRef, manifestRef: queued.manifestRef,
      expectedVersion: w.service.runVersion(w.dispatch.read(queued.runRef!)), idempotencyKey: "synthetic-reconcile-revoked", payload: { request: "lookup" } };
    await expect(w.service.execute(input, principal)).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
    expect(w.dispatch.read(queued.runRef!).receipt?.receiptRef).toBe("synthetic-reconciled-receipt");
    expect(w.dispatch.read(queued.runRef!).run.counts.completed).toBe(1);
  });
  it("accepts only the separate source-record and snapshot-export operations with exact reference shapes", () => {
    const w = setup(), exportRequest = { ...w.base, operation: "exportSnapshot", actionKind: "exportLedger", payload: { filters: { state: "all", startAt: "2026-10-01T00:00:00Z", endAt: "2026-11-01T00:00:00Z", timezone: "UTC", currency: "USD" }, format: "csv" } };
    expect(domainActionSchema.safeParse(exportRequest).success).toBe(true);
    expect(domainActionSchema.safeParse({ ...exportRequest, operation: "dispatchApprovedAction" }).success).toBe(false);
    expect(domainActionSchema.safeParse({ ...exportRequest, approvalRef: "fake-approval" }).success).toBe(false);
    const record = { ...w.base, operation: "recordSourceDecision", actionKind: "recordLaunchReadiness", entityRefs: [{ source: "launch-readiness", accountId: scope.accountId, canonicalId: "launch", sourceId: null, url: null, identityState: "resolved", provenanceRef: "v1" }], payload: { verdict: "hold", launchDate: null, rationale: "Source gate unresolved", evidenceRefs: ["gate"] } };
    expect(domainActionSchema.safeParse(record).success).toBe(true);
    expect(domainActionSchema.safeParse({ ...record, payload: { ...record.payload, confersRelease: true } }).success).toBe(false);
    expect(domainActionSchema.safeParse({ ...record, entityRefs: [] }).success).toBe(false);
  });
});
