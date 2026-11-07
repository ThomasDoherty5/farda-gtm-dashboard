// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createLiveAdapter } from "./liveAdapter";
import { SCHEMA_VERSION, type ActionRequest } from "./contract";
import { TransportFailure, type Transport, type TransportRequest } from "./transport";
import { AgentStore } from "../creator-agent/store.ts";
import { ApprovalRepository } from "../creator-agent/approvals/repository.ts";
import { JobRepository } from "../creator-agent/jobs/repository.ts";
import { DispatchGuard } from "../creator-agent/jobs/dispatchGuard.ts";
import { createActionDomainServices } from "../creator-agent/actions/domainServices.ts";
import { createActionService } from "../creator-agent/actions/service.ts";
import { ActionServiceError } from "../creator-agent/actions/contract.ts";
import { actionDomainFixture, actionTestScope as scope, actionTestSecret as secret, founderFixture as principal, exportFixturePayload } from "../creator-agent/actions/fixtures.testkit.ts";

const stores: AgentStore[] = [];
function setup(count = 110) {
  const f = actionDomainFixture(count), store = new AgentStore(":memory:", scope); stores.push(store);
  const jobs = new JobRepository(store.database, { scope, now: f.now }), approvals = new ApprovalRepository(store.database, { scope, now: f.now });
  const dispatch = new DispatchGuard({ db: store.database, scope, jobs, approvals, handlers: new Map(), now: f.now });
  const domains = createActionDomainServices({ db: store.database, scope, secret, jobs, ...f });
  const service = createActionService({ scope, secret, approvals, dispatch, domains, registry: new Map(), authorize: f.authorize, assertAuthority: f.assertAuthority, now: f.now });
  const sent: TransportRequest[] = [];
  const transport: Transport = { send: async request => {
    sent.push(request);
    if (request.kind !== "action") throw new Error("Unexpected non-action transport");
    try { return await service.executeDomain(request.envelope, principal); }
    catch (error) {
      if (error instanceof ActionServiceError) throw new TransportFailure("http", { status: error.status, body: { code: error.code, executionCertainty: error.executionCertainty } });
      throw error;
    }
  } };
  const adapter = createLiveAdapter("sandbox", { transport, writeAttempts: 1, retryDelayMs: 0 });
  const base = { schemaVersion: SCHEMA_VERSION, requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" as const },
    requestId: "fixture-transport-request", idempotencyKey: "fixture-original-key", expectedVersion: "ledger-v1", approvalRef: null, manifestRef: null, runRef: null, entityRefs: [] };
  const exportAction: ActionRequest<unknown> = { ...base, operation: "exportSnapshot", actionKind: "exportLedger", payload: exportFixturePayload };
  async function readinessAction(): Promise<ActionRequest<unknown>> {
    const view = await domains.readReadiness(f.source.targetRef, principal);
    return { ...base, operation: "recordSourceDecision", actionKind: "recordLaunchReadiness", expectedVersion: view.version,
      entityRefs: [{ source: "launch-readiness", accountId: scope.accountId, sourceId: null, canonicalId: view.targetRef, url: null, identityState: "resolved", provenanceRef: view.version }],
      payload: { verdict: "go", launchDate: view.launchDate, rationale: "Synthetic exact source readiness record", evidenceRefs: [view.evidenceRefs[0]!] } };
  }
  return { ...f, store, domains, adapter, sent, exportAction, readinessAction };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("separate exact domain-effect client guard", () => {
  it("accepts an exact whole-ledger export only with actual source-backed artifact/job proof, including known zero", async () => {
    for (const count of [0, 110]) {
      const w = setup(count), response = await w.adapter.submitAction(w.exportAction);
      expect(response).toMatchObject({ state: "succeeded", executionCertainty: "applied", approvalRef: null, manifestRef: null, reasonCodes: ["ARTIFACT_GENERATED_RELEASE_NOT_GRANTED"] });
      expect(response.runRef).toBeTruthy(); expect(response.receiptRefs).toHaveLength(1);
      const artifact = await w.domains.downloadExport(response.receiptRefs[0]!, principal);
      expect(artifact.receipt.rowCount).toBe(count); expect(artifact.receipt.runRef).toBe(response.runRef); expect(artifact.receipt.confersRelease).toBe(false);
      expect(w.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(0); expect(w.sent).toHaveLength(1);
    }
  });
  it("accepts a readiness-only native ACK with opaque source receipt, and cannot confer launch execution authority", async () => {
    const w = setup(), action = await w.readinessAction(), response = await w.adapter.submitAction(action);
    expect(response).toMatchObject({ state: "succeeded", executionCertainty: "applied", runRef: null, approvalRef: null, manifestRef: null, reasonCodes: ["READINESS_RECORDED_RELEASE_NOT_GRANTED"] });
    expect(response.receiptRefs[0]).toMatch(/^notion-receipt-/); expect(response.payloadVersion).toMatch(/^notion-version-/);
    expect(w.state.writes).toBe(1); expect(w.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(0); expect(w.store.database.prepare("SELECT count(*) n FROM job_runs").get()?.n).toBe(0);
    expect(await w.domains.recoverReadinessRequest(action.idempotencyKey, principal)).toMatchObject({ state: "recorded", receipt: { confersRelease: false } });
  });
  it("rejects swapped operations/kinds and forged approval/run/actor/gate/source fields before any transport call", async () => {
    const w = setup(), launch = await w.readinessAction();
    const mutations: unknown[] = [
      { ...w.exportAction, operation: "recordSourceDecision" }, { ...launch, operation: "exportSnapshot" },
      { ...w.exportAction, operation: "previewAction" }, { ...launch, operation: "dispatchApprovedAction" },
      { ...w.exportAction, actionKind: "synthetic-unregistered" }, { ...launch, actionKind: "synthetic-unregistered" },
      { ...w.exportAction, approvalRef: "forged-approval" }, { ...launch, manifestRef: "forged-manifest" }, { ...launch, runRef: "forged-run" },
      { ...launch, actor: "founder" }, { ...launch, payload: { ...(launch.payload as object), gates: [] } },
      { ...launch, payload: { ...(launch.payload as object), confersRelease: true } }, { ...launch, payload: { ...(launch.payload as object), enabled: true } },
      { ...w.exportAction, payload: { ...exportFixturePayload, columns: ["private-email"] } },
      { ...launch, entityRefs: [] }, { ...launch, entityRefs: [launch.entityRefs[0], launch.entityRefs[0]] },
      { ...launch, entityRefs: [{ ...launch.entityRefs[0], sourceId: "raw-notion-page" }] },
      { ...launch, entityRefs: [{ ...launch.entityRefs[0], url: "https://example.invalid/private-source" }] },
      { ...launch, entityRefs: [{ ...launch.entityRefs[0], source: "arbitrary-source" }] },
    ];
    for (const invalid of mutations) await expect(w.adapter.submitAction(invalid as ActionRequest<unknown>)).rejects.toMatchObject({ body: { code: "VALIDATION_FAILED", executionCertainty: "notApplied", retryable: false } });
    expect(w.sent).toHaveLength(0); expect(w.state.writes).toBe(0);
  });
  it("never treats a syntactically opaque but unbound source target as authoritative", async () => {
    const w = setup(), launch = await w.readinessAction();
    await expect(w.adapter.submitAction({ ...launch, entityRefs: [{ ...launch.entityRefs[0]!, canonicalId: "launch-unbound" }] })).rejects.toMatchObject({ category: "forbidden", body: { executionCertainty: "notApplied" } });
    expect(w.sent).toHaveLength(1); expect(w.state.writes).toBe(0);
  });
  it("zero source gate records is invalid evidence, never an implicitly passing checklist", async () => {
    const w = setup(); w.source.gates = [];
    await expect(w.readinessAction()).rejects.toMatchObject({ code: "READINESS_SOURCE_INVALID", executionCertainty: "notApplied" });
    expect(w.sent).toHaveLength(0); expect(w.state.writes).toBe(0);
  });
  it.each(["partial-export", "failed-gate", "unknown-gate", "unapproved-date"] as const)("%s cannot turn missing readiness/coverage into a release or successful source record", async kind => {
    const w = setup();
    if (kind === "partial-export") {
      w.ledger.page = async () => ({ snapshotRef: w.snapshot.snapshotRef, version: w.snapshot.version, offset: 0, total: 110, rows: w.rows.slice(0, 1), nextCursor: null });
      await expect(w.adapter.submitAction(w.exportAction)).rejects.toMatchObject({ body: { executionCertainty: "notApplied" } });
      expect(w.store.database.prepare("SELECT count(*) n FROM action_export_artifacts").get()?.n).toBe(0);
    } else {
      if (kind === "unapproved-date") w.source.launchDateApproved = false; else w.source.gates[0]!.state = kind === "failed-gate" ? "fail" : "unknown";
      await expect(w.adapter.submitAction(await w.readinessAction())).rejects.toMatchObject({ body: { executionCertainty: "notApplied" } });
    }
    expect(w.state.writes).toBe(0); expect(w.store.database.prepare("SELECT count(*) n FROM approval_decisions").get()?.n).toBe(0);
  });
});
