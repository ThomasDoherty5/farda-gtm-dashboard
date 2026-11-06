// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { assessCreator } from "./policy.ts";
import { syntheticBinding, syntheticPacket, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures.ts";
import { protectCommentAuthors } from "./evidencePrivacy.ts";
import { loadOperationsSecret } from "./operationsSecret.ts";
import { POLICY_VERSION } from "./assessmentSchema.ts";
import { SCHEMA_VERSION } from "../adapter/contract";
import type { EvidencePacket } from "./evidence.ts";

type Json = Record<string, unknown>;
describe("comment author protection through native intake, historical reads and migration retries", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });
  it("protects every response and new stored record while preserving legacy receipts, author counts and exact retry identity", async () => {
    const binding = syntheticBinding(), packet = syntheticPacket();
    const sourceAuthor = "synthetic.person@example.invalid";
    const first = packet.posts[0]!;
    if (first.comments.status !== "observed") throw new Error("Expected source sample.");
    for (const row of first.comments.rows) row.authorRef = sourceAuthor;
    const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
    app = createAgentServer({ databasePath: ":memory:", ...scope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, bindings: [binding] });
    // Simulate the exact pre-migration durable receipt, rather than weakening the immutable source assertion.
    const legacy = app.store.save(packet, assessCreator(packet, binding), 0, "synthetic-legacy-request");
    const legacyBody = String(app.store.database.prepare("SELECT body FROM assessments WHERE run_id=?").get(legacy.runId)!.body);
    await new Promise<void>(resolve => app!.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test server.");
    const origin = `http://127.0.0.1:${address.port}`;
    const canonical = protectCommentAuthors(packet, scope, loadOperationsSecret(app.store.database, scope));
    async function get() {
      const response = await fetch(origin + "/v1/creators/" + packet.creatorId, { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
      expect(response.status).toBe(200); return await response.json() as Json;
    }
    async function put(input: EvidencePacket, expectedVersion: number, key: string) {
      const response = await fetch(origin + "/v1/creators/" + packet.creatorId, { method: "PUT", headers: {
        authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}`, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ packet: input, expectedVersion, policyVersion: POLICY_VERSION, configHash: binding.hash }) });
      return { status: response.status, body: await response.json() as Json };
    }
    const projected = await get();
    expect(projected.packet).toEqual(canonical);
    expect(JSON.stringify(projected)).not.toContain(sourceAuthor);
    const replay = await put(packet, 0, "synthetic-legacy-request");
    expect(replay.status).toBe(200); expect(replay.body.runId).toBe(legacy.runId);
    expect(replay.body.packet).toEqual(canonical);
    expect(JSON.stringify(replay.body)).not.toContain(sourceAuthor);
    const next = await put(canonical, 1, "synthetic-canonical-resave");
    expect(next.status).toBe(200); expect(next.body.revision).toBe(2);
    expect(app.store.latest(packet.creatorId)!.packet).toEqual(canonical);
    expect(app.store.latest(packet.creatorId)!.assessment.comments).toEqual(legacy.assessment.comments);
    expect(app.store.history(packet.creatorId)).toHaveLength(2);
    expect(String(app.store.database.prepare("SELECT body FROM assessments WHERE run_id=?").get(legacy.runId)!.body)).toBe(legacyBody);
    expect((await put({ ...packet, evidenceRevision: "changed-input", ratings: { ...packet.ratings, demo: 4 } }, 0, "synthetic-legacy-request")).status).toBe(409);
    const historicalReplay = await put(packet, 0, "synthetic-legacy-request");
    expect(historicalReplay.status).toBe(200); expect(historicalReplay.body).toMatchObject({ runId: legacy.runId, stale: true });
    for (const [viewKey, filters] of [
      ["evidenceRecord", { creatorId: packet.creatorId, evidenceId: first.postId }],
      ["assessmentRecord", { creatorId: packet.creatorId, assessmentId: legacy.runId }],
    ] as const) {
      const response = await fetch(origin + "/v1/read", { method: "POST", headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-privacy-projection", requestedScope: SYNTHETIC_SCOPE,
          viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 25 } }) });
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { agentEvidence: EvidencePacket } };
      expect(body.data.agentEvidence).toEqual(canonical);
      expect(JSON.stringify(body)).not.toContain(sourceAuthor);
    }
  });
});
