// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures.ts";
import { collaborationSnapshotSchema, type CollaborationSourceSnapshot } from "./collaborationWorkflowSchema.ts";
import { sealCollaborationRef } from "./creatorPlatformReferences.ts";
import { loadOperationsSecret } from "./operationsSecret.ts";
import { SCHEMA_VERSION } from "../adapter/contract";

type Json = Record<string, unknown>;
const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
describe("review sprint collaboration authenticated source/proposal boundary", () => {
  let app: ReturnType<typeof createAgentServer>;
  let origin: string;
  let source: CollaborationSourceSnapshot | null;
  let clock: number;
  beforeEach(async () => {
    clock = Date.now();
    source = collaborationSnapshotSchema.parse({ scope, id: "synthetic-collaboration", sourceRevision: "synthetic-source-v1", sourceRef: "source:synthetic-collaboration",
      observedAt: new Date(clock).toISOString(), coverage: "complete", title: "Synthetic collaboration", platform: "Social Cat", creatorRef: null, campaignRef: null,
      stage: "Content pending", nextAction: "Review content",
      terms: { kind: "Commission only", agreementRef: null, acceptedAt: null, version: null, brief: null, usage: null, posting: "unknown", due: null,
        graceDays: null, observationUntil: null, retainedSampleCost: null, historicalFee: null },
      sample: { state: null, observedAt: null, sourceRef: null }, suppression: { state: "unknown", sourceRef: null }, history: [], deliverables: [] });
    app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      workspaceId: scope.workspaceId, accountId: scope.accountId, operations: { now: () => clock },
      collaborationSourceReader: async (_scope, id) => id === "synthetic-collaboration" ? source : null });
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test server.");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await app.close(); });
  async function post(path: string, body: unknown, token = SYNTHETIC_REVIEW_TOKEN) {
    const response = await fetch(origin + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Json };
  }
  function readRequest(viewKey: string, collaborationId: string) {
    return { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-collaboration-read", requestedScope: SYNTHETIC_SCOPE,
      viewKey, filters: { collaborationId }, period: null, sort: [], page: { cursor: null, limit: 50 } };
  }
  function proposal(expectedVersion: unknown, collaborationRef = "synthetic-collaboration") {
    return { schemaVersion: SCHEMA_VERSION, operation: "requestApproval", requestId: "synthetic-collaboration-proposal", requestedScope: SYNTHETIC_SCOPE,
      actionKind: "proposeCollaborationReview", entityRefs: [], expectedVersion, approvalRef: null, manifestRef: null, runRef: null,
      idempotencyKey: "synthetic-collaboration-proposal-key", payload: { collaborationRef, kind: "review", reason: "Review the current source-owned collaboration." } };
  }
  it("resolves opaque collaboration links consistently in detail and saved-evidence reads", async () => {
    const ref = sealCollaborationRef(scope, loadOperationsSecret(app.store.database, scope), "synthetic-collaboration");
    const detail = await post("/v1/read", readRequest("collaborationDetail", ref));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ collaborationRef: ref, kind: "source-collaboration", title: "Synthetic collaboration" });
    const evidence = await post("/v1/read", readRequest("collaborationEvidence", ref));
    expect(evidence.status).toBe(200);
    expect(evidence.body.data).toMatchObject({ collaborationId: ref, total: 0, records: [] });
    const foreign = sealCollaborationRef({ ...scope, accountId: "synthetic-other-account" }, loadOperationsSecret(app.store.database, scope), "synthetic-collaboration");
    expect((await post("/v1/read", readRequest("collaborationDetail", foreign))).status).toBe(400);
    expect((await post("/v1/read", readRequest("collaborationEvidence", foreign))).status).toBe(400);
  });
  it("saves only a local proposal and rejects reader, forged actor, dispatch and changed-payload attempts", async () => {
    const read = await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const request = proposal(read.body.dataVersion);
    const initialSource = structuredClone(source);
    expect((await post("/v1/action", request, SYNTHETIC_READ_TOKEN)).status).toBe(403);
    expect((await post("/v1/action", { ...request, actorRef: "forged-founder" })).status).toBe(400);
    expect((await post("/v1/action", { ...request, operation: "dispatchApprovedAction" })).status).toBe(400);
    const saved = await post("/v1/action", request);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ state: "approvalPending", approvalRef: null, runRef: null, executionCertainty: "applied",
      reasonCodes: expect.arrayContaining(["LOCAL_PROPOSAL_ONLY", "J04_DECISION_AND_SOURCE_DISPATCH_NOT_CONNECTED"]) });
    expect((await post("/v1/action", request)).body).toEqual(saved.body);
    expect((await post("/v1/action", { ...request, payload: { ...request.payload, reason: "Changed proposal under the original idempotency key." } })).status).toBe(409);
    expect(source).toEqual(initialSource);
    const final = await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"));
    expect(final.body.data).toMatchObject({ proposalTotal: 1, proposals: [expect.objectContaining({ state: "approvalPending" })] });
  });
  it("requires fresh source versions and current membership, with reader capabilities denied", async () => {
    const read = await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"), SYNTHETIC_READ_TOKEN);
    expect(read.body.capabilities).toEqual([expect.objectContaining({ actionKind: "proposeCollaborationReview", state: "denied" })]);
    const request = proposal(read.body.dataVersion);
    source = { ...source!, sourceRevision: "synthetic-source-v2", stage: "Terms changed" };
    expect((await post("/v1/action", request)).status).toBe(409);
    source = null;
    expect((await post("/v1/action", request)).status).toBe(404);
    expect((await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"))).status).toBe(404);
  });
  it("keeps reminders held when the posting obligation or suppression clearance is unknown", async () => {
    const read = await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"));
    const request = proposal(read.body.dataVersion);
    const result = await post("/v1/action", { ...request, payload: { ...request.payload, kind: "reminder" } });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "SUPPRESSION_UNVERIFIED", executionCertainty: "notApplied" });
    expect((await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"))).body.data).toMatchObject({ proposalTotal: 0 });
  });
  it("looks up the exact actor/request receipt beyond the latest50 proposals", async () => {
    const initial = await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"));
    const first = await post("/v1/action", proposal(initial.body.dataVersion));
    expect(first.status).toBe(200);
    for (let index = 0; index < 51; index++) {
      // Model permitted traffic across multiple windows, retaining all52 receipts and the original history lookup.
      clock += 2100;
      source!.observedAt = new Date(clock).toISOString();
      const current = await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"));
      const next = proposal(current.body.dataVersion);
      const response = await post("/v1/action", { ...next, idempotencyKey: "synthetic-following-proposal-" + index,
        payload: { ...next.payload, reason: "Following synthetic review proposal number " + index } });
      expect(response.status).toBe(200);
    }
    const request = readRequest("collaborationDetail", "synthetic-collaboration");
    const ordinary = await post("/v1/read", request);
    expect((ordinary.body.data as { proposals: { id: string }[] }).proposals.some(p => p.id === first.body.actionRef)).toBe(false);
    const lookup = { ...request, filters: { ...request.filters, proposalRequestKey: "synthetic-collaboration-proposal-key" } };
    expect((await post("/v1/read", lookup, SYNTHETIC_READ_TOKEN)).status).toBe(403);
    const result = await post("/v1/read", lookup);
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ proposalReconciliation: { state: "recorded", requestKey: "synthetic-collaboration-proposal-key",
      actorRef: "agent-reviewer", proposal: { id: first.body.actionRef } } });
  });
  it("does not acknowledge a lost request from an independently submitted identical proposal", async () => {
    const initial = await post("/v1/read", readRequest("collaborationDetail", "synthetic-collaboration"));
    const planned = proposal(initial.body.dataVersion);
    const other = await post("/v1/action", { ...planned, idempotencyKey: "synthetic-other-identical-request" });
    expect(other.status).toBe(200);
    const read = readRequest("collaborationDetail", "synthetic-collaboration");
    const result = await post("/v1/read", { ...read, filters: { ...read.filters, proposalRequestKey: planned.idempotencyKey } });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ proposalReconciliation: { state: "notRecorded", requestKey: planned.idempotencyKey,
      actorRef: "agent-reviewer", proposal: null } });
  });
});
