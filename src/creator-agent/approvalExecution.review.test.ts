// @vitest-environment node
import { expect, it } from "vitest";
import { approvalFixture, approvalTestScope as scope } from "./approvals/fixtures.testkit.ts";
import { createActionFoundation } from "./actionFoundation.ts";
import { JobRepository } from "./jobs/repository.ts";
import { CapabilityLedger } from "./connections/ledger.ts";
import { POLICY_VERSION } from "./assessmentSchema.ts";
import type { DispatchHandler } from "./jobs/dispatchSchema.ts";

it("does not borrow a canonical approval receipt for an ordinary job reusing its item key", async () => {
  const a = approvalFixture(), jobs = new JobRepository(a.db, { scope, now: () => a.state.now });
  const ledger = new CapabilityLedger(a.db, scope);
  a.draft.phase = "other"; a.draft.acquisitionTerms = null; a.draft.effects.sendsCreator = false;
  const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Synthetic local artifact only" };
  let effects = 0;
  const handler: DispatchHandler = { idempotency: "source-enforced", sourceEffect: "localArtifact", policyVersion: a.policy.version,
    provider: na, resources: () => ({ budget: na, stock: na, quota: na }),
    budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 2, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async context => { effects++; return { state: "applied", receipt: { receiptRef: "synthetic-existing-artifact", dispatchKey: context.dispatchKey,
      payloadHash: context.intent.approval.payloadHash, handlerRef: context.intent.handlerRef, providerBindingHash: context.providerBindingHash,
      sourceEffect: "localArtifact", observedAt: a.at() } }; },
    reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_UNKNOWN" }) };
  const foundation = createActionFoundation({ db: a.db, scope, secret: "synthetic-independent-linkage-key-0000000000000000", jobs, ledger, now: () => a.state.now,
    bindings: { approvals: a.options, registry: new Map([[a.draft.actionKind, { handlerRef: "synthetic-handler" }]]), handlers: new Map([["synthetic-handler", handler]]) } });
  try {
    const approved = await a.approved(), intent = foundation.service.toIntent(approved, approved.manifest.items[0]!.itemRef);
    const canonical = await foundation.dispatch.handoff(intent, { principalRef: "synthetic:requester", idempotencyKey: "synthetic-real-handoff" });
    await foundation.dispatch.execute(canonical.runRef);
    jobs.register({ jobId: "synthetic-unrelated-job", version: 1, ownerRef: "synthetic-owner", mode: "observe", handler: "record-reference.v1",
      eventType: "synthetic-event", inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-local-result.v1", policyVersion: POLICY_VERSION,
      modelVersion: null, offerVersion: null, capabilityBinding: null, budgets: handler.budgets }, 0);
    const unrelated = jobs.ingest({ schemaVersion: "job-reference-batch.v1", jobId: "synthetic-unrelated-job", jobVersion: 1, eventId: "synthetic-unrelated-event",
      eventType: "synthetic-event", eventAt: null, items: [{ itemKey: canonical.dispatchKey, subjectRef: "synthetic-unrelated-subject", evidenceRef: null }] }, "synthetic-unrelated-ingress");
    expect(jobs.getRun(unrelated.runId).items[0]!.result).toBeNull();
    expect(() => foundation.dispatch.read(unrelated.runId, false)).toThrow("DISPATCH_NOT_FOUND");
    const linked = foundation.dispatch.readApprovalRuns(approved.manifest.approvalRef, 1);
    expect(linked.total).toBe(1); expect(linked.runs.map(run => run.runRef)).toEqual([canonical.runRef]);
    expect(linked.runs[0]!.items[0]!.receipt?.receiptRef).toBe("synthetic-existing-artifact");
    const display = await foundation.service.readApproval(approved.manifest.approvalRef, { principalRef: "synthetic:requester" });
    expect(display.execution).toMatchObject({ coverage: { returned: 1, total: 1, complete: true }, runs: [{ runRef: canonical.runRef, confirmedItems: 1, localArtifactItems: 1 }] });
    expect(foundation.dispatch.readApprovalRuns(approved.manifest.approvalRef, 2)).toEqual({ runs: [], total: 0 });
    expect(effects).toBe(1); expect(jobs.getRun(unrelated.runId).items[0]!.attempts).toBe(0);
  } finally { a.db.close(); }
});
