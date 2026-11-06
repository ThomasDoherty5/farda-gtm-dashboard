// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { syntheticBinding, syntheticPacket, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures.ts";
import { assessCreator } from "./policy.ts";
import { SCHEMA_VERSION } from "../adapter/contract";
import { createLiveAdapter } from "../adapter/liveAdapter";
import { createHttpTransport } from "../adapter/httpTransport";
import { protectCommentAuthors } from "./evidencePrivacy.ts";
import { loadOperationsSecret } from "./operationsSecret.ts";

type Json = Record<string, unknown>;
describe("review sprint authenticated evidence boundary", () => {
  let app: ReturnType<typeof createAgentServer>;
  let origin: string;
  const binding = syntheticBinding();
  const packet = syntheticPacket();
  beforeEach(async () => {
    app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, bindings: [binding] });
    app.store.save(packet, assessCreator(packet, binding), 0, "synthetic-review-boundary-initial");
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test server.");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await app.close(); });
  async function post(path: string, body: unknown, token = SYNTHETIC_REVIEW_TOKEN, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Json };
  }
  async function read(runId?: string) {
    return post("/v1/read", { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-review-boundary-read",
      requestedScope: SYNTHETIC_SCOPE, viewKey: "evidenceRecord", filters: { creatorId: packet.creatorId, evidenceId: packet.posts[0]!.postId, ...(runId ? { runId } : {}) },
      period: null, sort: [], page: { cursor: null, limit: 50 } });
  }
  function saveRequest(data: Json, key = "synthetic-review-boundary-save") {
    const source = data.sourceReview as Json;
    return { schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestId: "synthetic-review-boundary-save-request", requestedScope: SYNTHETIC_SCOPE,
      resourceKind: "reviewerAssessment", resourceRef: packet.posts[0]!.postId, expectedVersion: data.version, idempotencyKey: key,
      payload: { kind: "disagree", creatorId: packet.creatorId, runId: source.runId, basisHash: source.basisHash,
        targetId: "review", reason: "Synthetic disagreement: source demonstration needs another review." } };
  }
  it("enforces reader denial, exact workspace and payload/resource kind at the authenticated route", async () => {
    const current = await read(); expect(current.status).toBe(200);
    const request = saveRequest(current.body.data as Json);
    expect((await post("/v1/save", request, SYNTHETIC_READ_TOKEN)).status).toBe(403);
    expect((await post("/v1/save", { ...request, requestedScope: { ...SYNTHETIC_SCOPE, accountIds: ["synthetic-foreign"] } })).status).toBe(400);
    expect((await post("/v1/save", { ...request, resourceKind: "evidenceDraft" })).status).toBe(422);
    expect((await post("/v1/save", { ...request, payload: { ...request.payload, reviewer: "forged-founder" } })).status).toBe(422);
    expect((await read()).body.data).toEqual(current.body.data);
  });
  it("preserves source-interval validation through the real HTTP transport and typed live adapter", async () => {
    const response = await read(); const data = response.body.data as Json;
    const source = data.sourceReview as Json;
    const machineFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers); headers.set("authorization", `Bearer ${SYNTHETIC_REVIEW_TOKEN}`);
      return fetch(url, { ...init, headers });
    };
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(origin, { fetch: machineFetch }), writeAttempts: 1 });
    await expect(adapter.saveResource({ schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: SYNTHETIC_SCOPE,
      requestId: "synthetic-interval-adapter", resourceKind: "evidenceDraft", resourceRef: packet.posts[0]!.postId,
      expectedVersion: data.version as string, idempotencyKey: "synthetic-interval-key", payload: {
        kind: "observation", creatorId: packet.creatorId, runId: source.runId, basisHash: source.basisHash,
        note: { category: "demonstration", startSec: 0, endSec: 20, text: "This claimed range exceeds the actual source interval." },
      } })).rejects.toMatchObject({ category: "validation", body: { code: "OBSERVATION_OUTSIDE_REVIEW", executionCertainty: "notApplied" } });
    expect(((await read()).body.data as Json).sourceReview).toMatchObject({ annotations: [] });
  });
  it("acknowledges one immutable local annotation, rejects changed replay and preserves the original J20 packet", async () => {
    const initial = await read(); const data = initial.body.data as Json;
    const request = saveRequest(data);
    const saved = await post("/v1/save", request);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ resourceRef: packet.posts[0]!.postId, persistedByRef: "agent-reviewer", executionCertainty: "applied" });
    expect(saved.body.record).toMatchObject({ reviewer: "agent-reviewer", revision: 1, original: { id: "review" } });
    expect((await post("/v1/save", request)).body).toEqual(saved.body);
    expect((await post("/v1/save", { ...request, payload: { ...request.payload, reason: "A materially different disagreement under the same request key." } })).status).toBe(409);
    expect((await post("/v1/save", { ...request, idempotencyKey: "synthetic-review-stale-new-key" })).status).toBe(409);
    const result = await read();
    const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
    expect((result.body.data as Json).agentEvidence).toEqual(protectCommentAuthors(packet, scope, loadOperationsSecret(app.store.database, scope)));
    expect(app.store.latest(packet.creatorId)!.packet).toEqual(packet);
    expect(app.store.latest(packet.creatorId)!.assessment).toEqual(assessCreator(packet, binding));
    const effective = await fetch(origin + "/v1/creators/" + packet.creatorId, { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
    expect(await effective.json()).toMatchObject({ stale: true, assessment: { state: "reviewNeeded", reasonCodes: expect.arrayContaining(["EVIDENCE_DISPUTED"]) } });
  });
  it("keeps superseded disputes accessible by exact run without transferring them to new source evidence", async () => {
    const initial = await read(); const original = initial.body.data as Json;
    expect((await post("/v1/save", saveRequest(original))).status).toBe(200);
    app.store.save(packet, assessCreator(packet, binding), 1, "synthetic-review-unchanged-new-run");
    const relabeled = { ...packet, evidenceRevision: "synthetic-review-label-only" };
    app.store.save(relabeled, assessCreator(relabeled, binding), 2, "synthetic-review-relabeled-new-run");
    const unresolved = await fetch(origin + "/v1/creators/" + packet.creatorId, { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
    expect(await unresolved.json()).toMatchObject({ stale: true, assessment: { reasonCodes: expect.arrayContaining(["EVIDENCE_DISPUTED"]) } });
    await new Promise(resolve => setTimeout(resolve, 5));
    const reviewedAt = new Date().toISOString();
    const next = { ...packet, evidenceRevision: "synthetic-review-source-v2", posts: packet.posts.map((post,index) => index !== 0 ? post : {
      ...post, observedAt: reviewedAt, review: { ...post.review, reviewedAt, sourceRef: "synthetic:review:corrected-receipt",
        observedActions: [{ ...post.review.observedActions[0]!, action: "A fresh source review corrects the challenged demonstration." }] },
    }) };
    app.store.save(next, assessCreator(next, binding), 3, "synthetic-review-boundary-next");
    const latest = (await read()).body.data as Json;
    expect(latest.sourceReview).toMatchObject({ superseded: false, annotations: [] });
    const history = (await read((original.sourceReview as Json).runId as string)).body.data as Json;
    expect(history.sourceReview).toMatchObject({ superseded: true, annotations: [expect.objectContaining({ revision: 1 })] });
    expect((await post("/v1/save", saveRequest(history, "synthetic-review-historical-write"))).status).toBe(409);
  });
  it("rejects cookie writes without both same-origin and CSRF proof", async () => {
    const initial = await read();
    const session = await fetch(origin + "/v1/session", { headers: { authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}` } });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const { csrfToken } = await session.json() as { csrfToken: string };
    const request = saveRequest(initial.body.data as Json);
    const invoke = (headers: Record<string, string>) => fetch(origin + "/v1/save", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(request) });
    expect((await invoke({ origin })).status).toBe(403);
    expect((await invoke({ origin: "https://example.invalid", "x-csrf-token": csrfToken })).status).toBe(403);
    expect((await invoke({ origin, "x-csrf-token": csrfToken })).status).toBe(200);
  });
});
