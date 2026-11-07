// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../store.ts";
import type { ExpectedBinding } from "../connections/schema.ts";
import { JobRepository, type JobClaim } from "./repository.ts";
import { jobDefinitionSchema, jobRunViewSchema, type JobDefinition, type ReportResult } from "./schema.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const scope = { workspaceId: "synthetic-report-workspace", accountId: "synthetic-report-account", environment: "sandbox" as const };
const binding: ExpectedBinding = { ...scope, provider: "slack", providerAccountId: "synthetic-slack-workspace", action: "deliver-internal-report", mode: "executeApproved", route: "api", routeRef: "route:synthetic-report", authorizationScopeVersion: "synthetic-report-permission-v1", toolVersion: "synthetic-report-tool-v1", requiredScopes: ["synthetic-chat-write"], connectionRef: "connection:synthetic-report", secretRef: null };
const definition = (jobId = "synthetic-report-job", selectedBinding = binding): JobDefinition => jobDefinitionSchema.parse({ jobId, version: 1, ownerRef: "owner:synthetic-report", mode: "executeApproved", handler: "deliver-report.v1", eventType: "synthetic-report-event", inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-report-result.v1", policyVersion: "synthetic-adopted-report-policy-v1", modelVersion: null, offerVersion: null, capabilityBinding: selectedBinding,
  budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 3, maxRunMs: 60_000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 } });
const noop = () => {};

describe("reserved report policy execution on the shared job ledger", () => {
  let path: string, directory: string, store: AgentStore, second: DatabaseType | undefined, jobs: JobRepository, now: number;
  const options = () => ({ scope, now: () => now, resolveActivation: (input: { decisionRef: string; definitionHash: string }) => ({ approved: true, ...input }) });
  const event = (jobId = "synthetic-report-job", eventId = "synthetic-report-event") => ({ schemaVersion: "job-reference-batch.v1", jobId, jobVersion: 1, eventId, eventType: "synthetic-report-event", eventAt: null, items: [{ itemKey: "synthetic-report", subjectRef: "synthetic-event", evidenceRef: "synthetic-source-version" }] });
  function admitted(jobId = "synthetic-report-job", selectedBinding = binding) { jobs.register(definition(jobId, selectedBinding), 0); jobs.activateReport(jobId, 1, "synthetic-policy-grant", noop); return jobs.ingest(event(jobId), "request-" + jobId); }
  const claim = (runId: string, repo = jobs, selectedBinding = binding) => repo.claimReport(runId, "synthetic-report-worker", "synthetic-report", selectedBinding, noop)!;
  const start = (c: JobClaim) => jobs.startReport(c.item.itemId, c.leaseToken, noop);
  const result = (key = "synthetic-native-receipt"): ReportResult => ({ schemaVersion: "job-report-result.v1", kind: "report-receipt", receiptRef: key, requestKey: "synthetic-original-request", payloadHash: "a".repeat(64), sourceEffect: "internalReport", observedAt: new Date(now).toISOString() });
  const started = (itemId: string) => Number(store.database.prepare("SELECT dispatch_started FROM job_items WHERE item_id=?").get(itemId)!.dispatch_started);
  const local = () => Number(store.database.prepare("SELECT count(*) n FROM synthetic_report_receipts").get()!.n);
  const record = (ref: string) => store.database.prepare("INSERT INTO synthetic_report_receipts VALUES(?)").run(ref);
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "farda-report-jobs-")); path = join(directory, "jobs.sqlite"); now = Date.parse("2026-11-07T12:00:00Z"); store = new AgentStore(path, scope); jobs = new JobRepository(store.database, options()); store.database.exec("CREATE TABLE synthetic_report_receipts(ref TEXT PRIMARY KEY)"); });
  afterEach(() => { second?.close(); second = undefined; store.close(); rmSync(directory, { recursive: true, force: true }); });

  it("requires the exact reserved mode/output/binding and excludes generic activation and executors", () => {
    for (const change of [{ mode: "observe" }, { outputSchemaVersion: "job-local-result.v1" }, { capabilityBinding: null }]) expect(jobDefinitionSchema.safeParse({ ...definition(), ...change }).success).toBe(false);
    jobs.register(definition(), 0);
    expect(() => jobs.activate("synthetic-report-job", 1, "synthetic-generic-approval")).toThrow("REPORT_POLICY_ACTIVATION_REQUIRED");
    jobs.activateReport("synthetic-report-job", 1, "synthetic-policy-grant", noop);
    const run = jobs.ingest(event(), "synthetic-ingress");
    expect(jobs.claim("synthetic-generic-worker")).toBeNull(); expect(jobs.processOne("synthetic-generic-worker")).toBeNull();
    expect(() => jobs.claimApproved(run.runId, "synthetic-worker", "synthetic-report", noop)).toThrow("DISPATCH_HANDLER_REQUIRED");
    const c = claim(run.runId);
    expect(() => jobs.complete(c.item.itemId, c.leaseToken, { schemaVersion: "job-local-result.v1", kind: "reference-recorded", artifactRef: "synthetic-artifact", sourceEffect: "none" })).toThrow("APPROVED_DISPATCH_REQUIRES_RECEIPT");
    expect(() => jobs.startApproved(c.item.itemId, c.leaseToken, noop)).toThrow("DISPATCH_PREFLIGHT_HELD");
    expect(started(c.item.itemId)).toBe(0);
  });
  it("cannot treat an unresolved asynchronous callback as a synchronous source fence", () => {
    jobs.register(definition(), 0);
    expect(() => jobs.activateReport("synthetic-report-job", 1, "synthetic-policy-grant", async () => {})).toThrow("REPORT_ASYNC_FENCE_UNSUPPORTED");
    expect(jobs.getJob("synthetic-report-job").enabled).toBe(false);
    jobs.activateReport("synthetic-report-job", 1, "synthetic-policy-grant", noop);
    const run = jobs.ingest(event(), "synthetic-async-fence-ingress"), c = claim(run.runId);
    expect(() => jobs.startReport(c.item.itemId, c.leaseToken, async () => {})).toThrow("REPORT_ASYNC_FENCE_UNSUPPORTED");
    expect(started(c.item.itemId)).toBe(0);
  });
  it("binds claims and final lease assertions to the entire immutable source binding", () => {
    const run = admitted();
    for (const change of [{ providerAccountId: "synthetic-other-account" }, { routeRef: "route:synthetic-other" }, { toolVersion: "synthetic-v2" }, { authorizationScopeVersion: "synthetic-v2" }]) expect(() => claim(run.runId, jobs, { ...binding, ...change })).toThrow("REPORT_BINDING_MISMATCH");
    const c = claim(run.runId);
    expect(() => jobs.assertReportLease(c.item.itemId, c.leaseToken, { ...binding, requiredScopes: [] })).toThrow("REPORT_BINDING_MISMATCH");
    expect(jobs.getRun(run.runId).items[0]!.attempts).toBe(1);
    jobs.register({ ...definition(), version: 2, policyVersion: "synthetic-policy-v2" }, 1);
    expect(() => jobs.startReport(c.item.itemId, c.leaseToken, noop)).toThrow("REPORT_PREFLIGHT_HELD");
  });
  it("persists one real source-receipt callback atomically and keeps confirmed history sticky", () => {
    const run = admitted(), c = claim(run.runId); start(c);
    const receipt = result(); const done = jobs.finishReport(run.runId, "synthetic-report", receipt, attempt => { expect(attempt).toBe(1); record("synthetic-receipt"); });
    expect(done).toMatchObject({ state: "completed", items: [{ result: receipt }], usage: { externalCalls: null, sourceQuota: "unknown", runtimeCost: "unknown" } });
    expect(jobRunViewSchema.safeParse(done).success).toBe(true); expect(JSON.stringify(done)).not.toContain(c.leaseToken);
    expect(jobs.finishReport(run.runId, "synthetic-report", receipt, () => { throw new Error("must not repeat source settlement"); })).toEqual(done);
    expect(jobs.finishReport(run.runId, "synthetic-report", null, () => { throw new Error("must not downgrade confirmed work"); })).toEqual(done);
    expect(() => jobs.finishReport(run.runId, "synthetic-report", result("synthetic-conflicting-receipt"), noop)).toThrow("REPORT_RECEIPT_CONFLICT");
    expect(local()).toBe(1);
  });
  it("serializes the same provider/account/action across two actual SQLite workers without blocking another account", () => {
    const a = admitted("synthetic-report-a"), b = admitted("synthetic-report-b");
    const foreign = { ...binding, providerAccountId: "synthetic-other-workspace" }, c = admitted("synthetic-report-c", foreign);
    second = new DatabaseSync(path); const other = new JobRepository(second, options());
    const first = claim(a.runId); expect(claim(b.runId, other)).toBeNull();
    expect(claim(c.runId, other, foreign)).not.toBeNull();
    start(first); jobs.finishReport(a.runId, "synthetic-report", result(), noop);
    expect(claim(b.runId, other)).not.toBeNull();
  });
  it("rolls back source records and the started fence when final authorization or the lease expires", () => {
    const run = admitted(), c = claim(run.runId);
    expect(() => jobs.startReport(c.item.itemId, c.leaseToken, () => { record("synthetic-denied-start"); throw new Error("synthetic source permission revoked"); })).toThrow("permission revoked");
    expect(local()).toBe(0); expect(started(c.item.itemId)).toBe(0);
    expect(() => jobs.startReport(c.item.itemId, c.leaseToken, () => { record("synthetic-expired-start"); now += 1000; })).toThrow("JOB_LEASE_FENCED");
    expect(local()).toBe(0); expect(started(c.item.itemId)).toBe(0);
    jobs.recoverExpired(); expect(jobs.getRun(run.runId).items[0]!.state).toBe("retryWait");
  });
  it("rechecks current job control after a source claim callback and keeps pause effective immediately before delivery", () => {
    const run = admitted();
    expect(() => jobs.claimReport(run.runId, "synthetic-worker", "synthetic-report", binding, () => { store.database.prepare("UPDATE job_runs SET control='paused' WHERE run_id=?").run(run.runId); })).toThrow("REPORT_PREFLIGHT_HELD");
    expect(jobs.getRun(run.runId).items[0]!.attempts).toBe(0);
    const c = claim(run.runId); start(c); jobs.controlRun(run.runId, "pause");
    expect(() => jobs.assertReportLease(c.item.itemId, c.leaseToken, binding)).toThrow("REPORT_PREFLIGHT_HELD");
    expect(() => jobs.fail(c.item.itemId, c.leaseToken, { reasonCode: "SYNTHETIC_FAILURE", certainty: "not-applied", retryable: true })).toThrow("APPROVED_DISPATCH_REQUIRES_RECONCILIATION");
  });
  it("survives restart with a started fence and cannot create a new attempt from an alternate ingress key", () => {
    const run = admitted(), c = claim(run.runId); start(c);
    store.close(); store = new AgentStore(path, scope); jobs = new JobRepository(store.database, options()); now += 1001;
    jobs.recoverExpired(); expect(jobs.getRun(run.runId).state).toBe("reconcile");
    const again = jobs.ingest(event("synthetic-report-job", "synthetic-other-ingress"), "synthetic-other-key");
    expect(again.items[0]!.itemId).toBe(c.item.itemId); expect(claim(again.runId)).toBeNull();
    const done = jobs.finishReport(run.runId, "synthetic-report", result(), attempt => { expect(attempt).toBe(1); record("synthetic-recovered-receipt"); });
    expect(done.state).toBe("completed"); expect(local()).toBe(1);
  });
  it("closes only the original uncertain attempt, respects Retry-After and requires a fresh source claim", () => {
    const run = admitted(), first = claim(run.runId); start(first); jobs.finishReport(run.runId, "synthetic-report", null, noop);
    jobs.closeReportAttempt(run.runId, "synthetic-report", 1, () => record("synthetic-closure-1"), 500);
    expect(jobs.getRun(run.runId)).toMatchObject({ state: "held", items: [{ state: "held", attempts: 1 }] }); expect(started(first.item.itemId)).toBe(0);
    expect(claim(run.runId)).toBeNull(); now += 500;
    expect(() => jobs.claimReport(run.runId, "synthetic-worker", "synthetic-report", binding, () => { throw new Error("synthetic current send grant missing"); })).toThrow("grant missing");
    const secondAttempt = claim(run.runId); expect(secondAttempt.item.attempts).toBe(2); start(secondAttempt); jobs.finishReport(run.runId, "synthetic-report", null, noop);
    expect(() => jobs.closeReportAttempt(run.runId, "synthetic-report", 1, () => record("synthetic-late-closure"))).toThrow("REPORT_CLOSURE_ATTEMPT_MISMATCH");
    expect(() => jobs.finishReport(run.runId, "synthetic-report", result("synthetic-old-attempt-receipt"), attempt => { record("synthetic-late-receipt"); if (attempt !== 1) throw new Error("synthetic exact attempt mismatch"); })).toThrow("attempt mismatch");
    expect(local()).toBe(1); expect(started(first.item.itemId)).toBe(1); expect(jobs.getRun(run.runId).state).toBe("reconcile");
  });
  it("does not clear a live worker or confirmed effect with a delayed negative lookup", () => {
    const run = admitted(), c = claim(run.runId); start(c);
    jobs.closeReportAttempt(run.runId, "synthetic-report", 1, () => { throw new Error("cannot settle over active worker"); });
    expect(started(c.item.itemId)).toBe(1); expect(jobs.getRun(run.runId).items[0]!.state).toBe("leased");
    jobs.finishReport(run.runId, "synthetic-report", result(), noop);
    jobs.closeReportAttempt(run.runId, "synthetic-report", 1, () => { throw new Error("cannot clear confirmed work"); });
    expect(jobs.getRun(run.runId).items[0]!.state).toBe("completed");
  });
  it("records positive closure under read authority after cancellation without rearming the run", () => {
    const run = admitted(), c = claim(run.runId); start(c); jobs.finishReport(run.runId, "synthetic-report", null, noop); jobs.controlRun(run.runId, "cancel");
    const closed = jobs.closeReportAttempt(run.runId, "synthetic-report", 1, () => record("synthetic-cancelled-closure"));
    expect(closed).toMatchObject({ control: "cancelled", state: "cancelled", items: [{ state: "cancelled" }] });
    expect(started(c.item.itemId)).toBe(0); expect(claim(run.runId)).toBeNull(); expect(local()).toBe(1);
  });
});
