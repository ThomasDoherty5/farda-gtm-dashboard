// @vitest-environment node
import { expect, it } from "vitest";
import { POLICY_VERSION } from "./assessmentSchema.ts";
import { createAgentServer } from "./server.ts";
import { syntheticBinding, syntheticPacket, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures.ts";

it("returns the effective dispute hold on assessment write and replay while preserving the immutable scored run", async () => {
  const packet = syntheticPacket();
  const binding = syntheticBinding();
  const app = createAgentServer({ databasePath: ":memory:", workspaceId: SYNTHETIC_SCOPE.workspaceId,
    accountId: SYNTHETIC_SCOPE.accountIds[0]!, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, bindings: [binding] });
  try {
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Local test server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const creatorPath = `/v1/creators/${packet.creatorId}`;
    async function request(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, key?: string) {
      const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}`,
        "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
      expect(response.status).toBe(200);
      return response.json();
    }
    const readFields = { schemaVersion: "2026-11-02.proposed", requestedScope: SYNTHETIC_SCOPE };
    const readView = (viewKey: string, filters: Record<string, string>) => request("POST", "/v1/read", { ...readFields, operation: "readView",
      requestId: "synthetic-dispute-proof", viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 50 } });
    const assess = (revision: number, evidenceRevision: string, key: string) => request("PUT", creatorPath, {
      packet: { ...packet, evidenceRevision }, expectedVersion: revision, policyVersion: POLICY_VERSION, configHash: binding.hash }, key);
    const first = await assess(0, packet.evidenceRevision, "synthetic-first-write");
    expect(first.assessment.state).toBe("prospectiveInviteEligible");
    const evidenceId = packet.posts[0]!.postId;
    const evidence = (await readView("evidenceRecord", { creatorId: packet.creatorId, evidenceId })).data;
    await request("POST", "/v1/save", { ...readFields, operation: "saveResource", requestId: "synthetic-dispute-save",
      resourceKind: "reviewerAssessment", resourceRef: evidenceId, expectedVersion: evidence.version, idempotencyKey: "synthetic-dispute",
      payload: { kind: "disagree", creatorId: packet.creatorId, runId: first.runId, basisHash: evidence.sourceReview.basisHash,
        targetId: "review", reason: "The demonstration requires an independent review of the same source." } });
    const next = await assess(1, "synthetic-relabeled", "synthetic-repeat-write");
    const latest = await request("GET", creatorPath);
    const replay = await assess(1, "synthetic-relabeled", "synthetic-repeat-write");
    const olderReplay = await assess(0, packet.evidenceRevision, "synthetic-first-write");
    const historical = (await readView("assessmentRecord", { creatorId: packet.creatorId, assessmentId: next.runId })).data;
    const held = { stale: true, assessment: { state: "reviewNeeded", reasonCodes: expect.arrayContaining(["EVIDENCE_DISPUTED"]) } };
    for (const result of [next, latest, replay]) expect.soft(result).toMatchObject({ runId: next.runId, revision: 2, ...held });
    expect.soft(olderReplay).toMatchObject({ runId: first.runId, revision: 1, stale: true, assessment: { state: "reviewNeeded",
      reasonCodes: expect.arrayContaining(["EVIDENCE_DISPUTED", "SUPERSEDED_ASSESSMENT"]) } });
    expect(app.store.history(packet.creatorId)).toHaveLength(2);
    const immutable = app.store.findRun(packet.creatorId, next.runId)!.assessment;
    expect(immutable.state).toBe("prospectiveInviteEligible");
    expect(immutable.reasonCodes).not.toContain("EVIDENCE_DISPUTED");
    expect(historical).toMatchObject({ assessedQualification: immutable, qualification: held.assessment });
  } finally { await app.close(); }
});

