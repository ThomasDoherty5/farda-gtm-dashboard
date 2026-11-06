// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../store.ts";
import { POLICY_VERSION } from "../assessmentSchema.ts";
import { JobRepository, type JobOptions } from "./repository.ts";
import { jobDefinitionSchema, jobEventSchema, jobRunViewSchema, type JobDefinition, type JobEvent } from "./schema.ts";
import type { ExpectedBinding } from "../connections/schema.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const scope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
const binding = (): ExpectedBinding => ({ ...scope, provider: "synthetic", providerAccountId: "synthetic-provider-account", action: "inspect-reference", mode: "observe", route: "api", routeRef: "route:synthetic", authorizationScopeVersion: "synthetic-auth-v1", toolVersion: "synthetic-tool-v1", requiredScopes: ["synthetic-read"], connectionRef: null, secretRef: null });
const definition = (overrides: Partial<JobDefinition> = {}): JobDefinition => jobDefinitionSchema.parse({ jobId: "synthetic-job", version: 1, ownerRef: "owner:synthetic", mode: "observe", handler: "record-reference.v1", eventType: "synthetic-reviewed-reference", inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-local-result.v1", policyVersion: POLICY_VERSION, modelVersion: null, offerVersion: null, capabilityBinding: null,
  budgets: { maxItems: 10, maxSteps: 20, maxAttempts: 2, maxRunMs: 60_000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 10 }, ...overrides });
const event = (items = 1, overrides: Partial<JobEvent> = {}): JobEvent => ({ schemaVersion: "job-reference-batch.v1", jobId: "synthetic-job", jobVersion: 1, eventId: "synthetic-event", eventType: "synthetic-reviewed-reference", eventAt: null, items: Array.from({ length: items }, (_, i) => ({ itemKey: `synthetic-item-${i}`, subjectRef: `subject:synthetic-${i}`, evidenceRef: null })), ...overrides });
const result = (itemId: string) => ({ schemaVersion: "job-local-result.v1", kind: "reference-recorded", artifactRef: `job-artifact:${itemId}`, sourceEffect: "none" });

describe("scoped durable no-source job repository", () => {
  let directory: string, path: string, db: DatabaseType, other: DatabaseType | undefined, repo: JobRepository, now: number, capabilityReady: boolean;
  const options = (): JobOptions => ({ scope, now: () => now,
    resolveActivation: (request) => request.decisionRef === "decision:synthetic-approved" ? { approved: true, decisionRef: request.decisionRef, definitionHash: request.definitionHash } : null,
    resolveCapability: () => ({ allowed: capabilityReady, state: capabilityReady ? "Ready" : "Unverified", reasonCodes: [capabilityReady ? "SYNTHETIC_VERIFIED" : "SYNTHETIC_MISSING"], capabilityId: "a".repeat(64), revision: 1, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), receiptRef: capabilityReady ? "receipt:synthetic" : null }) });
  const registerActive = (job = definition()) => { repo.register(job, 0); repo.activate(job.jobId, 1, "decision:synthetic-approved"); };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "farda-jobs-test-")); path = join(directory, "agent.sqlite"); const creator = new AgentStore(path, scope); creator.close(); db = new DatabaseSync(path); now = Date.parse("2026-11-04T12:00:00.000Z"); capabilityReady = true; repo = new JobRepository(db, options()); });
  afterEach(() => { other?.close(); other = undefined; db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("keeps new registrations disabled and requires a separate trusted activation decision", () => {
    const noResolver = new JobRepository(db, { scope, now: () => now });
    expect(noResolver.register(definition(), 0).enabled).toBe(false);
    expect(() => noResolver.activate("synthetic-job", 1, "decision:synthetic-approved")).toThrow("JOB_ACTIVATION_UNVERIFIED");
    const run = repo.ingest(event(), "synthetic-request");
    expect(run.state).toBe("held"); expect(repo.claim("worker:synthetic")).toBeNull();
    repo.activate("synthetic-job", 1, "decision:synthetic-approved");
    expect(repo.processOne("worker:synthetic")?.item.state).toBe("completed");
    expect(jobDefinitionSchema.safeParse({ ...definition(), enabled: true }).success).toBe(false);
    expect(jobDefinitionSchema.safeParse({ ...definition(), mode: "executeApproved" }).success).toBe(false);
  });

  it("deduplicates events and cross-event items, rejecting changed reused identities atomically", () => {
    registerActive(); const first = repo.ingest(event(), "synthetic-request");
    expect(repo.ingest(event(), "synthetic-request").runId).toBe(first.runId);
    expect(repo.ingest(event(), "synthetic-request-2").runId).toBe(first.runId);
    const second = repo.ingest(event(1, { eventId: "synthetic-event-2" }), "synthetic-request-3");
    expect(second.items[0]!.itemId).toBe(first.items[0]!.itemId); expect(second.counts.reused).toBe(1);
    expect(() => repo.ingest(event(2), "synthetic-request")).toThrow("JOB_IDEMPOTENCY_KEY_REUSED");
    expect(() => repo.ingest(event(2), "synthetic-request-4")).toThrow("JOB_EVENT_REUSED");
    const changed = event(1, { eventId: "synthetic-event-3", items: [{ ...event().items[0]!, evidenceRef: "evidence:changed" }] });
    expect(() => repo.ingest(changed, "synthetic-request-5")).toThrow("JOB_ITEM_KEY_REUSED");
    expect(repo.getRun(first.runId).items).toHaveLength(1);
  });

  it("fences overlap across actual SQLite connections and omits lease tokens from read views", () => {
    registerActive(); const run = repo.ingest(event(2), "synthetic-request"); other = new DatabaseSync(path); const concurrent = new JobRepository(other, options());
    const first = repo.claim("worker:first")!; expect(first).not.toBeNull(); expect(concurrent.claim("worker:second")).toBeNull();
    expect(JSON.stringify(repo.getRun(run.runId))).not.toContain(first.leaseToken);
    repo.complete(first.item.itemId, first.leaseToken, result(first.item.itemId));
    expect(concurrent.claim("worker:second")!.item.itemId).not.toBe(first.item.itemId);
    expect(() => repo.checkpoint(first.item.itemId, first.leaseToken, 0, { cursor: null, processedRefs: [] })).toThrow("JOB_LEASE_FENCED");
  });

  it("cannot promote an old observed item into completion of a new proposal registration", () => {
    registerActive(); const original = repo.ingest(event(), "synthetic-observe-v1-request"); repo.processOne("worker:synthetic");
    expect(repo.getRun(original.runId).items[0]!.result?.kind).toBe("reference-recorded");
    const next = definition({ version: 2, mode: "propose", handler: "draft-reference.v1" }); repo.register(next, 1); repo.activate(next.jobId, 2, "decision:synthetic-approved");
    const newEvent = event(1, { jobVersion: 2, eventId: "synthetic-propose-v2-event" });
    expect(() => repo.ingest(newEvent, "synthetic-propose-v2-request")).toThrow("JOB_ITEM_DEFINITION_MISMATCH");
    expect(repo.claim("worker:synthetic")).toBeNull();
    const material = { ...newEvent, items: [{ ...newEvent.items[0]!, itemKey: "synthetic-item-proposal-v2" }] };
    const proposal = repo.ingest(material, "synthetic-propose-v2-material-request"); expect(proposal.state).toBe("queued");
    expect(proposal.items[0]!.itemId).not.toBe(original.items[0]!.itemId); expect(proposal.items[0]!.result).toBeNull();
    repo.processOne("worker:synthetic");
    expect(repo.getRun(proposal.runId).items[0]!.result).toMatchObject({ kind: "proposal-recorded", sourceEffect: "none" });
    expect(repo.getRun(original.runId).items[0]!.result?.kind).toBe("reference-recorded");
  });

  it("persists checkpoints and recovers a crashed lease after a real database reopen", () => {
    registerActive(); const run = repo.ingest(event(), "synthetic-request"); const first = repo.claim("worker:first")!;
    repo.checkpoint(first.item.itemId, first.leaseToken, 0, { cursor: "cursor:synthetic-next", processedRefs: ["subject:synthetic-0"] });
    expect(() => repo.checkpoint(first.item.itemId, first.leaseToken, 0, { cursor: "cursor:changed", processedRefs: [] })).toThrow("CHECKPOINT_VERSION_CONFLICT");
    db.close(); db = new DatabaseSync(path); repo = new JobRepository(db, options()); now += 1001;
    expect(repo.recoverExpired()).toEqual({ recovered: 1, remainingExpired: 0 }); expect(repo.claim("worker:replacement")).toBeNull();
    expect(() => repo.complete(first.item.itemId, first.leaseToken, result(first.item.itemId))).toThrow("JOB_LEASE_FENCED"); now += 10;
    const replacement = repo.claim("worker:replacement")!; expect(replacement.leaseToken).not.toBe(first.leaseToken);
    expect(replacement.item.checkpointVersion).toBe(1); expect(replacement.item.checkpoint.cursor).toBe("cursor:synthetic-next"); expect(replacement.item.attempts).toBe(2);
    repo.complete(replacement.item.itemId, replacement.leaseToken, result(replacement.item.itemId));
    expect(repo.getRun(run.runId).state).toBe("completed"); expect(repo.history(run.runId).transitions.map((row) => row.kind)).toContain("lease-recovered");
  });

  it("retains paused work through lease expiry and resumes from its checkpoint", () => {
    registerActive(); const run = repo.ingest(event(), "synthetic-request"); repo.claim("worker:first"); repo.controlRun(run.runId, "pause"); now += 1001;
    repo.recoverExpired(); expect(repo.getRun(run.runId).state).toBe("paused"); expect(repo.getRun(run.runId).counts.cancelled).toBe(0); expect(repo.claim("worker:second")).toBeNull();
    repo.controlRun(run.runId, "resume"); now += 10; expect(repo.processOne("worker:second")?.item.state).toBe("completed");
    const later = repo.ingest(event(1, { eventId: "synthetic-job-paused-event", items: [{ itemKey: "synthetic-job-paused-item", subjectRef: "subject:synthetic-later", evidenceRef: null }] }), "synthetic-job-paused-request");
    repo.setJobControl("synthetic-job", 1, "pause"); expect(repo.claim("worker:third")).toBeNull(); expect(repo.getRun(later.runId).counts.held).toBe(1);
    repo.setJobControl("synthetic-job", 1, "resume"); expect(repo.processOne("worker:third")?.item.state).toBe("completed");
  });

  it("does not let100 older paused items starve a later runnable event", () => {
    const job = definition(); job.budgets.maxItems = 100; registerActive(job);
    const paused = repo.ingest(event(100), "synthetic-paused-batch-request"); repo.controlRun(paused.runId, "pause"); now += 1;
    const active = repo.ingest(event(1, { eventId: "synthetic-later-active-event", items: [{ itemKey: "synthetic-later-active-item", subjectRef: "subject:synthetic-later-active", evidenceRef: null }] }), "synthetic-later-active-request");
    const claim = repo.claim("worker:synthetic-active")!;
    expect(claim).not.toBeNull(); expect(claim.runId).toBe(active.runId); expect(claim.item.itemKey).toBe("synthetic-later-active-item");
    expect(repo.getRun(paused.runId).state).toBe("paused"); expect(repo.getRun(paused.runId).counts.total).toBe(100); expect(repo.getRun(paused.runId).counts.leased).toBe(0);
  });

  it("honors Retry-After and bounded attempts for safe reads or conclusively unapplied work", () => {
    registerActive(); const run = repo.ingest(event(), "synthetic-request"); const first = repo.claim("worker:first")!;
    const failure = { reasonCode: "SYNTHETIC_TRANSIENT", certainty: "safe-read", retryable: true, retryAfterMs: 100 };
    const failed = repo.fail(first.item.itemId, first.leaseToken, failure); expect(failed.state).toBe("retryWait"); expect(repo.fail(first.item.itemId, first.leaseToken, failure)).toEqual(failed);
    expect(repo.claim("worker:second")).toBeNull(); now += 100; const second = repo.claim("worker:second")!;
    expect(() => repo.fail(first.item.itemId, first.leaseToken, failure)).toThrow("JOB_LEASE_FENCED");
    expect(repo.fail(second.item.itemId, second.leaseToken, { ...failure, certainty: "not-applied" }).state).toBe("failed"); now += 1000;
    expect(repo.claim("worker:third")).toBeNull(); expect(repo.getRun(run.runId).counts.failed).toBe(1);
  });

  it("keeps uncertainty in reconciliation even after cancellation and never retries it", () => {
    registerActive(); const run = repo.ingest(event(), "synthetic-request"); const claim = repo.claim("worker:synthetic")!;
    repo.fail(claim.item.itemId, claim.leaseToken, { reasonCode: "SYNTHETIC_UNCERTAIN", certainty: "uncertain", retryable: true });
    repo.controlRun(run.runId, "cancel"); now += 100_000; expect(repo.claim("worker:second")).toBeNull();
    const view = repo.getRun(run.runId); expect(view.state).toBe("reconcile"); expect(view.counts.reconcile).toBe(1); expect(view.items[0]!.result).toBeNull();
  });

  it("cancels unsent items while preserving completed and already leased local work", () => {
    registerActive(); const run = repo.ingest(event(3), "synthetic-request"); repo.processOne("worker:first"); const active = repo.claim("worker:second")!;
    repo.controlRun(run.runId, "cancel"); expect(repo.claim("worker:third")).toBeNull(); repo.complete(active.item.itemId, active.leaseToken, result(active.item.itemId));
    const view = repo.getRun(run.runId); expect(view.counts).toMatchObject({ completed: 2, cancelled: 1 }); expect(view.state).toBe("cancelled");
    expect(() => repo.controlRun(run.runId, "resume")).toThrow("RUN_CANCELLED");
  });

  it("does not cancel a shared logical item still needed by another event or double-count its work", () => {
    registerActive(); const first = repo.ingest(event(), "synthetic-request"); const second = repo.ingest(event(1, { eventId: "synthetic-other-event" }), "synthetic-other-request");
    repo.controlRun(first.runId, "cancel"); expect(repo.processOne("worker:synthetic")!.runId).toBe(second.runId);
    expect(repo.getRun(first.runId).usage.workSteps).toBe(0); expect(repo.getRun(second.runId).usage.workSteps).toBe(1);
  });

  it("holds missing capabilities and refuses completion after revocation or registration replacement", () => {
    registerActive(definition({ capabilityBinding: binding() })); const run = repo.ingest(event(), "synthetic-request"); capabilityReady = false;
    expect(repo.claim("worker:first")).toBeNull(); expect(repo.getRun(run.runId).blockerCodes).toContain("JOB_CAPABILITY_UNVERIFIED");
    capabilityReady = true; repo.controlRun(run.runId, "resume"); const claim = repo.claim("worker:first")!; capabilityReady = false;
    expect(() => repo.complete(claim.item.itemId, claim.leaseToken, result(claim.item.itemId))).toThrow("JOB_PREFLIGHT_HELD"); capabilityReady = true;
    repo.register(definition({ version: 2, capabilityBinding: binding() }), 1);
    expect(repo.getJob("synthetic-job").enabled).toBe(false);
    expect(() => repo.complete(claim.item.itemId, claim.leaseToken, result(claim.item.itemId))).toThrow("JOB_PREFLIGHT_HELD");
    expect(repo.getRun(run.runId).definition.version).toBe(1);
  });

  it("shares account/action leases across jobs and releases them only for the matching fenced owner", () => {
    registerActive(definition({ capabilityBinding: binding() })); registerActive(definition({ jobId: "synthetic-job-two", capabilityBinding: binding() }));
    repo.ingest(event(), "synthetic-request"); repo.ingest(event(1, { jobId: "synthetic-job-two", eventId: "synthetic-second-job-event" }), "synthetic-second-job-request");
    const first = repo.claim("worker:first", "synthetic-job")!; expect(repo.claim("worker:second", "synthetic-job-two")).toBeNull();
    expect(() => repo.complete(first.item.itemId, "synthetic-forged-token", result(first.item.itemId))).toThrow("JOB_LEASE_FENCED"); expect(repo.claim("worker:second", "synthetic-job-two")).toBeNull();
    repo.complete(first.item.itemId, first.leaseToken, result(first.item.itemId)); expect(repo.claim("worker:second", "synthetic-job-two")).not.toBeNull();
  });

  it("enforces step/time/item limits and preserves immutable policy and activation snapshots", () => {
    const job = definition(); job.budgets.maxSteps = 1; registerActive(job); const run = repo.ingest(event(2), "synthetic-request"); repo.processOne("worker:first"); expect(repo.claim("worker:second")).toBeNull();
    const view = repo.getRun(run.runId); expect(view.counts).toMatchObject({ completed: 1, failed: 1 }); expect(view.blockerCodes).toContain("RUN_STEP_BUDGET"); expect(view.activationRef).toBe("decision:synthetic-approved");
    expect(view.usage).toMatchObject({ externalCalls: 0, modelCalls: 0, sourceQuota: "notApplicable", zapierTasks: "unknown", runtimeCost: "unknown" });
    const timed = definition({ jobId: "synthetic-timed-job", budgets: { ...definition().budgets, maxRunMs: 1000 } }); registerActive(timed);
    const timedRun = repo.ingest(event(1, { jobId: timed.jobId, eventId: "synthetic-timed-event" }), "synthetic-timed-request"); repo.claim("worker:timed", timed.jobId); now += 1001; repo.recoverExpired(); now += 10; expect(repo.claim("worker:timed", timed.jobId)).toBeNull(); expect(repo.getRun(timedRun.runId).blockerCodes).toContain("RUN_TIME_BUDGET");
    expect(() => repo.ingest(event(11, { eventId: "synthetic-too-many" }), "synthetic-overflow-request")).toThrow("JOB_EVENT_BUDGET_OR_TYPE_MISMATCH");
  });

  it("rejects wrong scope, stale policy, forged source outcomes and executable/schedule input fields", () => {
    expect(() => new JobRepository(db, { scope: { ...scope, accountId: "synthetic-wrong" } })).toThrow("JOB_SCOPE_MISMATCH");
    expect(() => repo.register(definition({ capabilityBinding: { ...binding(), accountId: "synthetic-wrong" } }), 0)).toThrow("JOB_SCOPE_MISMATCH");
    registerActive(definition({ policyVersion: "synthetic-retired-policy" })); const run = repo.ingest(event(), "synthetic-request"); expect(repo.claim("worker:synthetic")).toBeNull(); expect(repo.getRun(run.runId).blockerCodes).toContain("JOB_POLICY_STALE");
    expect(jobEventSchema.safeParse({ ...event(), execute: true }).success).toBe(false);
    expect(jobDefinitionSchema.safeParse({ ...definition(), scheduleEnabled: true }).success).toBe(false);
    expect(() => repo.complete(run.items[0]!.itemId, "synthetic-token", { ...result(run.items[0]!.itemId), sourceEffect: "sent" })).toThrow();
  });

  it("distinguishes an empty local event from a successful external scan and supports only a local proposal artifact", () => {
    registerActive(); const empty = repo.ingest(event(0), "synthetic-empty"); expect(empty.state).toBe("empty"); expect(empty.usage.workSteps).toBe(0); expect(repo.claim("worker:synthetic")).toBeNull();
    const proposal = definition({ jobId: "synthetic-proposal", mode: "propose", handler: "draft-reference.v1" }); registerActive(proposal);
    const run = repo.ingest(event(1, { jobId: proposal.jobId, eventId: "synthetic-proposal-event" }), "synthetic-proposal-request"); repo.processOne("worker:synthetic", proposal.jobId);
    const view = repo.getRun(run.runId); expect(jobRunViewSchema.safeParse(view).success).toBe(true); expect(view.items[0]!.result).toMatchObject({ kind: "proposal-recorded", sourceEffect: "none" });
  });
});
