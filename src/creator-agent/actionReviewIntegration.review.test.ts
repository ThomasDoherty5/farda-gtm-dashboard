// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture, approvalTestScope as scope } from "./approvals/fixtures.testkit.ts";
import { JobRepository } from "./jobs/repository.ts";
import { DispatchGuard } from "./jobs/dispatchGuard.ts";
import type { DispatchHandler } from "./jobs/dispatchSchema.ts";
import { createActionService } from "./actions/service.ts";
import { createActionReviewService } from "./actions/review.ts";
import { reviewSourceFixture } from "./actions/reviewFixtures.testkit.ts";

const open: ReturnType<typeof approvalFixture>["db"][] = [];
const principal = { principalRef: "synthetic:requester" };
async function world(execute?: DispatchHandler["execute"]) {
  const a = approvalFixture(); open.push(a.db);
  a.draft.actionKind = "synthetic-task"; a.command.actionKind = a.draft.actionKind;
  a.draft.phase = "other"; a.draft.acquisitionTerms = null; a.draft.effects.sendsCreator = false;
  const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Synthetic read-only test artifact" };
  let effectCalls = 0;
  const handler: DispatchHandler = { idempotency: "source-enforced", sourceEffect: "localArtifact", policyVersion: a.policy.version,
    provider: na, resources: () => ({ budget: na, stock: na, quota: na }),
    budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 2, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async context => { effectCalls++; if (execute) return execute(context); throw new Error("No effects are permitted in a read-review test"); },
    reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_UNKNOWN" }) };
  const jobs = new JobRepository(a.db, { scope, now: () => a.state.now });
  const dispatch = new DispatchGuard({ db: a.db, jobs, scope, approvals: a.repo, handlers: new Map([["synthetic-task.v1", handler]]), now: () => a.state.now });
  const source = reviewSourceFixture(() => a.state.now), secret = "synthetic-independent-review-reference-key-0000000000";
  const review = createActionReviewService({ scope, referenceKey: secret, source: source.source, now: () => a.state.now });
  const service = createActionService({ scope, secret, approvals: a.repo, dispatch, registry: new Map([["synthetic-task", { handlerRef: "synthetic-task.v1" }]]),
    authorize: a.sources.resolveActor, assertAuthority: a.sources.assertCurrent, review, now: () => a.state.now });
  const approved = await a.approved(), intent = service.toIntent(approved, approved.manifest.items[0]!.itemRef);
  const run = await dispatch.handoffBatch([intent], { principalRef: principal.principalRef, idempotencyKey: "synthetic-review-handoff" });
  const verified = await a.repo.resolveCurrentProof(intent.approval);
  if (verified.state !== "verified") throw new Error("Actual synthetic J04 fixture did not qualify");
  jobs.activateApproved(run.run.jobId, run.run.definition.version, verified.proof.decisionReceipt.receiptRef, () => a.repo.assertCurrentProof(verified.proof, a.state.now));
  expect(dispatch.read(run.runRef, false).current.state).toBe("ready");
  return { ...a, source, jobs, dispatch, service, run, effectCalls: () => effectCalls };
}
afterEach(() => { for (const db of open.splice(0)) db.close(); });

describe("independent shared action-review final-source integration", () => {
  it.each(["disable", "pause"] as const)("does not publish the old ready run after job-level %s during source await", async command => {
    const w = await world(), original = w.dispatch.read(w.run.runRef, false);
    w.source.state.afterRead = () => { w.jobs.setJobControl(w.run.run.jobId, w.run.run.definition.version, command); };
    await expect(w.service.readRun(w.run.runRef, principal)).rejects.toMatchObject({ code: "REVIEW_RECORD_CHANGED" });
    const actual = w.dispatch.read(w.run.runRef, false);
    expect(actual.revision).toBe(original.revision); // Job-head transitions are not per-run transitions.
    expect(actual.current.state).toBe("held");
    expect(actual.run.state).toBe(command === "pause" ? "paused" : "held");
    expect(w.effectCalls()).toBe(0);
  });
  it("withholds the protected run if its named actor is revoked during the final source await", async () => {
    const w = await world(), original = w.dispatch.read(w.run.runRef, false);
    w.source.state.afterRead = () => { w.humans.get(principal.principalRef)!.active = false; };
    await expect(w.service.readRun(w.run.runRef, principal)).rejects.toMatchObject({ code: "AUTHORITY_REQUIRED", status: 403 });
    expect(w.dispatch.read(w.run.runRef, false).revision).toBe(original.revision);
    expect(w.effectCalls()).toBe(0);
  });
  it("does not publish protected fields when a source fence returns a Promise that rejects actual backing permission", async () => {
    const w = await world(), originalFence = w.source.source.assertCurrent;
    let backingDenials = 0;
    w.source.source.assertCurrent = (...args) => {
      const pending = Promise.resolve().then(() => originalFence(...args));
      void pending.catch(() => { backingDenials++; });
      return pending;
    };
    w.source.state.afterRead = () => { w.source.state.permitted = false; };
    await expect(w.service.readApproval(w.run.intent.approval.approvalRef, principal))
      .rejects.toMatchObject({ code: "REVIEW_SOURCE_AUTHORITY_UNAVAILABLE", status: 403 });
    await Promise.resolve();
    expect(backingDenials).toBeGreaterThan(0); expect(w.effectCalls()).toBe(0);
  });
  it("returns the exact current run and actual history when no source or authority changes", async () => {
    const w = await world(), run = await w.service.readRun(w.run.runRef, principal);
    expect(run.current.state).toBe("ready"); expect(run.review?.state).toBe("complete");
    const approval = await w.service.readApproval(w.run.intent.approval.approvalRef, principal, { manifestVersion: 1, history: true });
    expect(approval.history).toMatchObject({ mode: "history", selectedVersion: 1, latestVersion: 1, totalVersions: 1 });
    expect(approval.current).toMatchObject({ state: "held", reasonCodes: expect.arrayContaining(["HISTORICAL_VIEW_READ_ONLY"]) });
    expect(w.effectCalls()).toBe(0);
  });
});


describe("independent original named/J04 authority synchronous fences", () => {
  it("denies historical protected reads when asynchronous named authority rejects the current backing actor", async () => {
    const w = await world(); let backingDenials = 0;
    const service = createActionService({ scope, secret: "synthetic-original-authority-key-0000000000000000", approvals: w.repo, dispatch: w.dispatch,
      registry: new Map([["synthetic-task", { handlerRef: "synthetic-task.v1" }]]), now: () => w.state.now,
      authorize: async ref => { const observed = await w.sources.resolveActor!(ref, scope); w.humans.get(ref)!.active = false; return observed; },
      assertAuthority: (...args) => { const pending = Promise.resolve().then(() => w.sources.assertCurrent!(...args)); void pending.catch(() => { backingDenials++; }); return pending; } });
    await expect(service.readApproval(w.run.intent.approval.approvalRef, principal, { manifestVersion: 1, history: true }))
      .rejects.toMatchObject({ code: "AUTHORITY_REQUIRED", status: 403 });
    await Promise.resolve(); expect(backingDenials).toBeGreaterThan(0); expect(w.effectCalls()).toBe(0);
  });
  it.each(["source", "registry"] as const)("blocks the actual artifact at the final %s fence when its backing authority rejects asynchronously", async mode => {
    let backingDenials = 0, nativeEffects = 0;
    const w: Awaited<ReturnType<typeof world>> = await world(async context => {
      if (mode === "source") {
        const current = w.sources.assertCurrent!;
        w.sources.assertCurrent = (...args) => { const pending = Promise.resolve().then(() => current(...args)); void pending.catch(() => { backingDenials++; }); return pending; };
        w.humans.get("synthetic:reviewer")!.active = false;
      } else {
        const current = w.options.registry.assertCurrentDraft;
        w.options.registry.assertCurrentDraft = (...args) => { const pending = Promise.resolve().then(() => current(...args)); void pending.catch(() => { backingDenials++; }); return pending; };
        w.draft.configVersion = "synthetic-withdrawn-config";
      }
      context.assertCurrent(); nativeEffects++;
      return { state: "applied", receipt: { receiptRef: "synthetic:local-artifact", dispatchKey: context.dispatchKey,
        payloadHash: context.intent.approval.payloadHash, handlerRef: context.intent.handlerRef, providerBindingHash: context.providerBindingHash,
        sourceEffect: "localArtifact", observedAt: w.at() } };
    });
    await expect(w.dispatch.execute(w.run.runRef)).rejects.toMatchObject({ code: "SOURCE_OUTCOME_UNCERTAIN", executionCertainty: "uncertain" }); await Promise.resolve();
    expect(backingDenials).toBeGreaterThan(0); expect(nativeEffects).toBe(0);
    expect(w.dispatch.read(w.run.runRef, false).items.every(item => item.receipt === null)).toBe(true);
  });
});
