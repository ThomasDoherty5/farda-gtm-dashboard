// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, createHmac } from "node:crypto";
import { createAgentServer } from "./server.ts";
import { protectCommentAuthors } from "./evidencePrivacy.ts";
import { loadOperationsSecret } from "./operationsSecret.ts";
import { bindConfig, type ConfigBinding } from "./config.ts";
import { assessCreator } from "./policy.ts";
import { POLICY_VERSION } from "./assessmentSchema.ts";
import type { EvidencePacket } from "./evidence.ts";
import type { StoredAssessment } from "./store.ts";
import { agentAssessmentRecordSchema, agentSourcingSchema, type AgentAssessmentRecord, type AgentSourcingData } from "./readViews.ts";
import { SCHEMA_VERSION, type ReadResponse } from "../adapter/contract";
import { createHttpTransport } from "../adapter/httpTransport";
import { createLiveAdapter } from "../adapter/liveAdapter";
import { syntheticSourceSnapshot, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE, syntheticBinding, syntheticPacket, withActivationEvidence } from "./testFixtures.ts";

describe("actual agent sourcing and immutable assessment read models", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  let origin: string;
  let directory: string;
  let databasePath: string;
  let bindings: ConfigBinding[];

  async function start(nextBindings = [syntheticBinding(), syntheticBinding("tiktok-shop")], scope = SYNTHETIC_SCOPE, readToken = SYNTHETIC_READ_TOKEN) {
    bindings = nextBindings;
    app = createAgentServer({ databasePath, readToken, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      workspaceId: scope.workspaceId, accountId: scope.accountIds[0]!, scorecardAuthority: { resolve: (subject) => syntheticSourceSnapshot(subject) }, bindings });
    const server = app.server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected ephemeral test server.");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() { const closing = app; app = undefined; if (closing) await closing.close(); }
  async function save(packet = syntheticPacket(), expectedVersion = 0, key = "synthetic-read-model-save") {
    const modelId = packet.checkoutRoute === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3";
    const response = await fetch(`${origin}/v1/creators/${packet.creatorId}`, { method: "PUT",
      headers: { authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}`, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ expectedVersion, policyVersion: POLICY_VERSION, configHash: bindings.find((binding) => binding.current.modelId === modelId)?.hash ?? null, packet }) });
    expect(response.status).toBe(200);
    const { stale, ...receipt } = await response.json() as StoredAssessment & { stale: boolean };
    expect(stale).toBe(false);
    return receipt;
  }
  async function read<T>(viewKey: string, filters: object = {}, scope: object = SYNTHETIC_SCOPE, token: string | null = SYNTHETIC_READ_TOKEN, page: { cursor: string | null; limit: number } = { cursor: null, limit: 100 }) {
    const response = await fetch(`${origin}/v1/read`, { method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestId: "synthetic-read-model-request", requestedScope: scope, filters, period: null, sort: [], page }) });
    return { status: response.status, body: await response.json() as ReadResponse<T> };
  }

  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "farda-agent-read-views-")); databasePath = join(directory, "agent.sqlite"); await start(); });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await stop(); rmSync(directory, { recursive: true, force: true }); });

  function seed(count: number, { prefix = "synthetic-page", at = "2026-01-01T12:00:00.000Z" } = {}): StoredAssessment[] {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    try {
      return Array.from({ length: count }, (_, index) => {
        const packet = { ...syntheticPacket(), creatorId: `${prefix}-${index}` };
        return app!.store.save(packet, assessCreator(packet, bindings[0]!), 0, `${prefix}-save-${index}`);
      });
    } finally { vi.useRealTimers(); }
  }

  it("returns an actual empty reviewed-record queue and both immutable model projections without source-capacity claims", async () => {
    const response = await read<AgentSourcingData>("discoverySummary");
    expect(response.status).toBe(200);
    expect(agentSourcingSchema.safeParse(response.body.data).success).toBe(true);
    expect(response.body.data).toMatchObject({ kind: "agent-sourcing", records: [], total: 0, partial: false });
    expect(response.body.data!.models).toHaveLength(2);
    expect(response.body.data!.models.map((model) => model.modelId)).toEqual(["WEBSITE-AFFILIATE-v3", "TIKTOK-SHOP-AFFILIATE-v3"]);
    expect(response.body.data!.models[0]).toMatchObject({ status: "bound", configHash: bindings[0]!.hash, criteria: bindings[0]!.current.criteria, bands: bindings[0]!.current.bands });
    expect(response.body.capabilities).toContainEqual({ actionKind: "startLiveDiscovery", state: "held", reasonCodes: ["SOURCE_AUTOMATION_NOT_CONNECTED"] });
    for (const key of ["batch", "liveCapacity", "capacityRows", "selected", "discovered"]) expect(response.body.data).not.toHaveProperty(key);
  });

  it("lists one latest saved record per creator with real assessment and evidence navigation IDs", async () => {
    const first = await save();
    const changed = syntheticPacket();
    changed.evidenceRevision = "synthetic-evidence-v2";
    changed.ratings.demo = 4;
    const latest = await save(changed, 1, "synthetic-read-model-save-2");
    const otherPacket = syntheticPacket("tiktok-shop");
    otherPacket.creatorId = "synthetic-other-creator";
    const other = await save(otherPacket, 0, "synthetic-read-model-other");
    const response = await read<AgentSourcingData>("discoverySummary");
    expect(response.body.data).toMatchObject({ total: 2, partial: false });
    expect(response.body.data!.records).toHaveLength(2);
    const row = response.body.data!.records.find((record) => record.creatorId === changed.creatorId)!;
    expect(row).toMatchObject({ runId: latest.runId, evidenceId: changed.posts[0]!.postId, briefId: changed.briefId, checkoutRoute: "website", revision: 2, state: latest.assessment.state, stale: false });
    expect(response.body.data!.records.some((record) => record.runId === first.runId)).toBe(false);
    expect(response.body.data!.records.find((record) => record.creatorId === otherPacket.creatorId)?.runId).toBe(other.runId);
  });

  it("round-trips actual sourcing and current assessment through the existing HTTP transport and typed live adapter", async () => {
    const saved = await save();
    const machineReaderFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${SYNTHETIC_READ_TOKEN}`);
      return fetch(input, { ...init, headers });
    };
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(origin, { fetch: machineReaderFetch }), writeAttempts: 1 });
    const envelope = { schemaVersion: SCHEMA_VERSION, operation: "readView" as const, requestId: "synthetic-typed-roundtrip", requestedScope: SYNTHETIC_SCOPE, period: null, sort: [], page: { cursor: null, limit: 50 } };
    const sourcing = await adapter.readView({ ...envelope, viewKey: "discoverySummary", filters: {} });
    expect(agentSourcingSchema.parse(sourcing.data).records[0]!.runId).toBe(saved.runId);
    const assessment = await adapter.readView({ ...envelope, viewKey: "assessmentRecord", filters: { creatorId: saved.packet.creatorId, assessmentId: saved.runId } });
    expect(agentAssessmentRecordSchema.parse(assessment.data).agentEvidence).toEqual(saved.packet);
    expect(assessment.scope.environment).toBe("sandbox");
    expect(assessment.capabilities).toEqual([]);
  });

  it("reads the exact saved run, preserving original qualification while superseded runs cannot claim current readiness", async () => {
    const first = await save();
    const before = await read<AgentAssessmentRecord>("assessmentRecord", { creatorId: first.packet.creatorId, assessmentId: first.runId });
    const sameRead = await read<AgentAssessmentRecord>("assessmentRecord", { creatorId: first.packet.creatorId, assessmentId: first.runId });
    expect(before.body.dataVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(sameRead.body.dataVersion).toBe(before.body.dataVersion);
    const changed = syntheticPacket();
    changed.evidenceRevision = "synthetic-evidence-v2";
    changed.ratings.routine = 4;
    const latest = await save(changed, 1, "synthetic-read-model-save-2");
    const historical = await read<AgentAssessmentRecord>("assessmentRecord", { creatorId: changed.creatorId, assessmentId: first.runId });
    expect(historical.status).toBe(200);
    expect(agentAssessmentRecordSchema.safeParse(historical.body.data).success).toBe(true);
    expect(historical.body.data).toMatchObject({ kind: "creator-v3", runId: first.runId, assessmentId: first.runId, revision: 1, stale: true, superseded: true, evidenceId: null });
    expect(historical.body.data!.qualification.state).toBe("reviewNeeded");
    expect(historical.body.data!.qualification.reasonCodes).toContain("SUPERSEDED_ASSESSMENT");
    expect(historical.body.data!.assessedQualification).toEqual(first.assessment);
    expect(historical.body.data!.agentEvidence).toEqual(first.packet);
    expect(historical.body.dataState).toBe("stale");
    expect(historical.body.data!.assessmentId).toBe(before.body.data!.assessmentId);
    expect(historical.body.dataVersion).not.toBe(before.body.dataVersion);
    expect(app!.store.history(changed.creatorId)).toEqual([first, latest]);
    const current = await read<AgentAssessmentRecord>("assessmentRecord", { creatorId: changed.creatorId, assessmentId: latest.runId });
    expect(current.body.data).toMatchObject({ runId: latest.runId, stale: false, superseded: false, evidenceId: changed.posts[0]!.postId });
    expect(current.body.data!.qualification).toEqual(latest.assessment);
    expect(current.body.data!.agentEvidence.recentPosts[0]!.nativeLikes).toMatchObject({ status: "known", value: 5 });
    expect((await read("assessmentRecord", { creatorId: "synthetic-wrong-creator", assessmentId: latest.runId })).status).toBe(404);
    expect((await read("assessmentRecord", { creatorId: changed.creatorId, assessmentId: "synthetic-unknown-run" })).status).toBe(404);
  });

  it("binds new read views to the authenticated exact sandbox scope and rejects forged IDs or unknown views", async () => {
    const record = await save();
    for (const scope of [
      { ...SYNTHETIC_SCOPE, workspaceId: "synthetic-wrong-workspace" },
      { ...SYNTHETIC_SCOPE, accountIds: ["synthetic-wrong-account"] },
      { ...SYNTHETIC_SCOPE, environment: "production" },
      { ...SYNTHETIC_SCOPE, accountIds: [...SYNTHETIC_SCOPE.accountIds, "synthetic-extra-account"] },
    ]) {
      expect((await read("discoverySummary", {}, scope)).status).toBe(400);
      expect((await read("assessmentRecord", { creatorId: record.packet.creatorId, assessmentId: record.runId }, scope)).status).toBe(400);
    }
    expect((await read("discoverySummary", {}, SYNTHETIC_SCOPE, null)).status).toBe(401);
    expect((await read("assessmentRecord", { creatorId: record.packet.creatorId, assessmentId: record.runId, eligible: true })).status).toBe(400);
    expect((await read("scorecardsIndex")).status).toBe(400);
  });

  it("rejects contradictory qualification bases and stale readiness at the shared wire boundary", async () => {
    const saved = await save(withActivationEvidence(syntheticPacket()));
    expect(saved.assessment.state).toBe("activationReady");
    const response = await read<AgentAssessmentRecord>("assessmentRecord", { creatorId: saved.packet.creatorId, assessmentId: saved.runId });
    const valid = agentAssessmentRecordSchema.parse(response.body.data);
    for (const flags of [{ stale: true, superseded: false }, { stale: true, superseded: true, evidenceId: null }])
      expect(agentAssessmentRecordSchema.safeParse({ ...valid, ...flags }).success).toBe(false);
    const validStale = { ...valid, stale: true, qualification: { ...valid.qualification, state: "reviewNeeded" } };
    expect(agentAssessmentRecordSchema.safeParse(validStale).success).toBe(true);
    expect(validStale.assessedQualification.state).toBe("activationReady");
    for (const key of ["qualification", "assessedQualification"] as const) {
      for (const field of ["creatorId", "briefId", "evidenceRevision", "termsRevision"] as const) {
        const malformed = { ...valid, [key]: { ...valid[key], [field]: "synthetic-contradictory-basis" } };
        expect(agentAssessmentRecordSchema.safeParse(malformed).success).toBe(false);
      }
      expect(agentAssessmentRecordSchema.safeParse({ ...valid, [key]: { ...valid[key], modelId: "TIKTOK-SHOP-AFFILIATE-v3" } }).success).toBe(false);
    }
    expect(agentAssessmentRecordSchema.safeParse({ ...valid, agentEvidence: { ...valid.agentEvidence, checkoutRoute: "tiktok-shop" } }).success).toBe(false);
  });

  it("reads only selected immutable runs in the finite preview, including missing and superseded results", async () => {
    const first = await save(syntheticPacket(), 0, "first-preview");
    const selector = (runId: string) => ({creatorId:first.packet.creatorId,runId});
    const filters = { batchId: "scorecard-preview", selection:[selector(first.runId), {creatorId:"synthetic-missing",runId:"unknown"}] };
    const inspect = () => read<import("./scorecardPreview").ScorecardPreview>("batchDetail",filters);
    const saved = await inspect();
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({selectedCount:2,dispatchAuthorized:false,items:[
      {runId:first.runId,modelId:first.assessment.modelId,configHash:first.assessment.config.hash,status:"eligible"},
      {status:"unavailable",score:null,criteria:[]},
    ]});
    await save({...first.packet,evidenceRevision:"updated-preview"},1,"second-preview");
    const revised = await inspect();
    expect(revised.body.data!.items[0]).toMatchObject({runId:first.runId,stale:true,status:"review",evidencePostId:null});
    expect((await read("batchDetail",{...filters,selection:[selector(first.runId),selector("other")]})).status).toBe(400);
    expect((await read("batchDetail",filters,SYNTHETIC_SCOPE,null)).status).toBe(401);
  });

  it("keeps a pre-upgrade activationReady record readable while current views require review", async () => {
    const p = withActivationEvidence(syntheticPacket());
    const old = {...assessCreator(p,bindings[0]!),agentVersion:"1.0.0" as const,state:"activationReady" as const};
    delete old.routeEvidence;
    const stored = app!.store.save(p,old,0,"legacy-generic-gates");
    const readback = await read<AgentAssessmentRecord>("assessmentRecord",{creatorId:p.creatorId,assessmentId:stored.runId});
    expect(readback.body.data).toMatchObject({stale:true,qualification:{state:"reviewNeeded"},assessedQualification:{state:"activationReady",agentVersion:"1.0.0"}});
    expect(app!.store.history(p.creatorId)[0]!.assessment).toEqual(old);
  });

  it("shows config-stale records and original assessed versions without rewriting stored history", async () => {
    const first = await save();
    const before = await read<AgentAssessmentRecord>("assessmentRecord", { creatorId: first.packet.creatorId, assessmentId: first.runId });
    const evidenceBefore = await read("evidenceRecord", { creatorId: first.packet.creatorId, evidenceId: first.packet.posts[0]!.postId });
    const revised = bindings.map((binding) => bindConfig({ ...binding.current, version: "synthetic-config-next", approvalRef: "synthetic:next-approval" }, binding.baseline, binding.baselineHash));
    await stop();
    await start(revised);
    const queue = await read<AgentSourcingData>("discoverySummary");
    expect(queue.body.data!.records[0]).toMatchObject({ runId: first.runId, stale: true, state: "reviewNeeded" });
    expect(queue.body.data!.models[0]).toMatchObject({ configVersion: "synthetic-config-next", configHash: revised[0]!.hash });
    const view = await read<AgentAssessmentRecord>("assessmentRecord", { creatorId: first.packet.creatorId, assessmentId: first.runId });
    expect(view.body.data).toMatchObject({ stale: true, superseded: false });
    expect(view.body.data!.qualification.state).toBe("reviewNeeded");
    expect(view.body.data!.assessedQualification).toEqual(first.assessment);
    expect(view.body.dataVersion).not.toBe(before.body.dataVersion);
    expect(app!.store.history(first.packet.creatorId)).toEqual([first]);
    const evidenceAfter = await read("evidenceRecord", { creatorId: first.packet.creatorId, evidenceId: first.packet.posts[0]!.postId });
    expect(evidenceAfter.status).toBe(200);
    expect(evidenceAfter.body.dataVersion).not.toBe(evidenceBefore.body.dataVersion);
  });

  it("keeps missing model configuration explicitly unbound instead of returning historical or synthetic defaults", async () => {
    await stop();
    await start([]);
    const response = await read<AgentSourcingData>("discoverySummary");
    expect(response.body.data!.models).toHaveLength(2);
    for (const model of response.body.data!.models) expect(model).toMatchObject({ status: "unbound", configVersion: null, configHash: null, baselineHash: null, numericHash: null, criteria: null, bands: null, arithmetic: null, decisionRules: null });
  });

  it("bounds the actual latest listing at100 and reports omitted saved records as partial coverage", async () => {
    for (let index = 0; index < 101; index += 1) {
      const packet: EvidencePacket = { ...syntheticPacket(), creatorId: `synthetic-list-creator-${index}` };
      app!.store.save(packet, assessCreator(packet, bindings[0]!), 0, `synthetic-list-save-${index}`);
    }
    const response = await read<AgentSourcingData>("discoverySummary");
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ total: 101, partial: true });
    expect(response.body.data!.records).toHaveLength(100);
    expect(response.body.dataState).toBe("partial");
    expect(response.body.coverage).toMatchObject({ expectedCount: 101, observedCount: 100, missingCount: 1, complete: false, reasonCodes: ["SNAPSHOT_PAGE_PARTIAL"] });
    expect(response.body.page).toMatchObject({ hasMore: true });
    expect(response.body.page.nextCursor).toEqual(expect.any(String));
    expect(() => app!.store.listLatest(101)).toThrow("INVALID_LIST_LIMIT");
  });

  it.each([0, 1, 100, 101])("returns truthful snapshot/page/coverage boundaries for%i actual saved creators", async (count) => {
    seed(count);
    const result = await read<AgentSourcingData>("discoverySummary");
    expect(result.status).toBe(200);
    expect(agentSourcingSchema.safeParse(result.body.data).success).toBe(true);
    expect(result.body.data!.snapshot).toMatchObject({ offset: 0, limit: 100, returnedCount: Math.min(count, 100), total: count });
    expect(result.body.data!.total).toBe(count);
    expect(result.body.data!.partial).toBe(count > 100);
    expect(result.body.page.hasMore).toBe(count > 100);
    expect(result.body.page.nextCursor === null).toBe(count <= 100);
    expect(result.body.coverage).toMatchObject({ expectedCount: count, observedCount: Math.min(count, 100), missingCount: Math.max(0, count - 100), complete: count <= 100 });
  });

  it("traverses205 tied timestamps without duplicates/omissions while new creators and revisions arrive between pages", async () => {
    const saved = seed(205);
    const ordered = [...saved].sort((a, b) => a.recordedAt === b.recordedAt ? a.runId < b.runId ? 1 : -1 : a.recordedAt < b.recordedAt ? 1 : -1);
    const first = await read<AgentSourcingData>("discoverySummary");
    const initial = first.body.data!;
    expect(initial.records.map((record) => record.runId)).toEqual(ordered.slice(0, 100).map((record) => record.runId));
    expect(initial.snapshot!.offset).toBe(0);
    const snapshotId = initial.snapshot!.id;
    const unseen = ordered[150]!;
    const revised = { ...structuredClone(unseen.packet), evidenceRevision: "synthetic-snapshot-later-revision", ratings: { routine: 4, demo: 3 } };
    await save(revised, 1, "synthetic-snapshot-later-save");
    // A clock rollback cannot insert a newly saved creator into the fixed snapshot's later pages.
    seed(1, { prefix: "synthetic-created-after-snapshot", at: "2020-01-01T00:00:00.000Z" });
    const cursor = first.body.page.nextCursor!;
    const second = await read<AgentSourcingData>("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor, limit: 100 });
    const retry = await read<AgentSourcingData>("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor, limit: 100 });
    expect(retry.body.data).toEqual(second.body.data);
    expect(retry.body.dataVersion).toBe(second.body.dataVersion);
    expect(second.body.data!.snapshot).toMatchObject({ id: snapshotId, asOf: initial.snapshot!.asOf, expiresAt: initial.snapshot!.expiresAt, offset: 100, limit: 100, total: 205, returnedCount: 100 });
    const superseded = second.body.data!.records.find((record) => record.creatorId === unseen.packet.creatorId)!;
    expect(superseded).toMatchObject({ runId: unseen.runId, state: "reviewNeeded", stale: true, superseded: true, evidenceId: null });
    const oldAssessment = await read<AgentAssessmentRecord>("assessmentRecord", { creatorId: superseded.creatorId, assessmentId: superseded.runId });
    expect(oldAssessment.body.data!.assessedQualification).toEqual(unseen.assessment);
    // Legacy seeded receipts retain their original stored packet. Public reads protect commenter identifiers.
    const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
    const publicPacket = protectCommentAuthors(unseen.packet, scope, loadOperationsSecret(app!.store.database, scope));
    expect(publicPacket).not.toEqual(unseen.packet);
    expect(oldAssessment.body.data!.agentEvidence).toEqual(publicPacket);
    const third = await read<AgentSourcingData>("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: second.body.page.nextCursor!, limit: 100 });
    expect(third.body.page).toEqual({ nextCursor: null, hasMore: false });
    expect(third.body.data!.snapshot).toMatchObject({ id: snapshotId, offset: 200, returnedCount: 5, total: 205 });
    expect(third.body.data!.partial).toBe(true);
    expect(third.body.coverage).toMatchObject({ expectedCount: 205, observedCount: 5, missingCount: 200, complete: false });
    const all = [...initial.records, ...second.body.data!.records, ...third.body.data!.records];
    expect(all.map((record) => record.runId)).toEqual(ordered.map((record) => record.runId));
    expect(new Set(all.map((record) => record.creatorId)).size).toBe(205);
    const fresh = await read<AgentSourcingData>("discoverySummary");
    expect(fresh.body.data!.total).toBe(206);
    expect(fresh.body.data!.snapshot!.id).not.toBe(snapshotId);
  });

  it("rejects malformed/tampered/expired cursors, wrong page limits and unauthorized requests", async () => {
    seed(3);
    const first = await read<AgentSourcingData>("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: null, limit: 1 });
    const cursor = first.body.page.nextCursor!;
    const index = Math.floor(cursor.length / 2);
    const tampered = cursor.slice(0, index) + (cursor[index] === "A" ? "B" : "A") + cursor.slice(index + 1);
    for (const invalid of ["", "not-a-cursor", "sc1.x", tampered]) {
      const result = await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: invalid, limit: 1 });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: "INVALID_CURSOR" });
    }
    expect((await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor, limit: 2 })).body).toMatchObject({ code: "INVALID_CURSOR" });
    expect((await read("discoverySummary", {}, SYNTHETIC_SCOPE, null, { cursor, limit: 1 })).status).toBe(401);
    expect((await read("discoverySummary", {}, { ...SYNTHETIC_SCOPE, accountIds: ["synthetic-forbidden-account"] }, SYNTHETIC_READ_TOKEN, { cursor, limit: 1 })).status).toBe(400);
    expect((await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: null, limit: 101 })).status).toBe(400);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(first.body.data!.snapshot!.expiresAt) + 1);
    const expired = await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor, limit: 1 });
    clock.mockRestore();
    expect(expired.status).toBe(409);
    expect(expired.body).toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it("rejects cursor continuation after current configuration context changes", async () => {
    seed(3);
    const first = await read<AgentSourcingData>("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: null, limit: 1 });
    const revised = bindings.map((binding) => bindConfig({ ...binding.current, version: "synthetic-pagination-config-next", approvalRef: "synthetic:pagination-next" }, binding.baseline, binding.baselineHash));
    await stop(); await start(revised);
    const result = await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: first.body.page.nextCursor, limit: 1 });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "CURSOR_STALE" });
    const fresh = await read<AgentSourcingData>("discoverySummary");
    expect(fresh.body.data!.models[0]!.configVersion).toBe("synthetic-pagination-config-next");
  });

  it("does not let a reader decrypt or sign sourcing cursors with its authentication credential", async () => {
    seed(3);
    const first = await read<AgentSourcingData>("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: null, limit: 1 });
    const cursor = first.body.page.nextCursor!;
    const bytes = Buffer.from(cursor.slice(4), "base64url");
    const oldReaderKey = createHmac("sha256", SYNTHETIC_READ_TOKEN).update("farda.creator-sourcing.cursor.v1").digest();
    const decipher = createDecipheriv("aes-256-gcm", oldReaderKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    expect(() => Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()])).toThrow();
    expect((await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor, limit: 1 })).status).toBe(200);
  });

  it("binds cursors to a private database key, authorized scope and the current private credential", async () => {
    seed(3);
    const first = await read<AgentSourcingData>("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: null, limit: 1 });
    const cursor = first.body.page.nextCursor;
    await stop(); databasePath = join(directory, "replacement.sqlite"); await start();
    const replaced = await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor, limit: 1 });
    expect(replaced.status).toBe(400);
    expect(replaced.body).toMatchObject({ code: "INVALID_CURSOR" });
    const otherScope = { ...SYNTHETIC_SCOPE, workspaceId: "synthetic-other-pagination-workspace" };
    await stop(); databasePath = join(directory, "other-scope.sqlite"); await start(undefined, otherScope);
    const foreign = await read("discoverySummary", {}, otherScope, SYNTHETIC_READ_TOKEN, { cursor, limit: 1 });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ code: "INVALID_CURSOR" });
    const rotatedToken = `${SYNTHETIC_READ_TOKEN}-rotated`;
    await stop(); databasePath = join(directory, "rotated-reader.sqlite"); await start(undefined, SYNTHETIC_SCOPE, rotatedToken);
    expect((await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor, limit: 1 })).status).toBe(401);
    const rotated = await read("discoverySummary", {}, SYNTHETIC_SCOPE, rotatedToken, { cursor, limit: 1 });
    expect(rotated.status).toBe(400);
    expect(rotated.body).toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("does not let a valid cursor revive a revoked browser session after service restart", async () => {
    seed(3);
    const first = await read<AgentSourcingData>("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: null, limit: 1 });
    const session = await fetch(`${origin}/v1/session`, { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    await stop(); await start();
    const response = await fetch(`${origin}/v1/read`, { method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "discoverySummary", requestId: "synthetic-revoked-session", requestedScope: SYNTHETIC_SCOPE, filters: {}, period: null, sort: [], page: { cursor: first.body.page.nextCursor, limit: 1 } }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    expect((await read("discoverySummary", {}, SYNTHETIC_SCOPE, SYNTHETIC_READ_TOKEN, { cursor: first.body.page.nextCursor, limit: 1 })).status).toBe(200);
  });
});
