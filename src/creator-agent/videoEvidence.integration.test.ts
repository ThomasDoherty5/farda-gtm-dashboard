// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "./config.ts";
import { evidencePacketSchema, type EvidencePacket } from "./evidence.ts";
import type { CanonicalRecord, IdentitySink } from "./intake/repository.ts";
import type { IntakeInput, SinkBinding, SinkReceipt } from "./intake/contract.ts";
import { createRuntimeTestkit, syntheticRuntimeRegistration, runtimeSyntheticScope as scope } from "./jobs/runtime.testkit.ts";
import type { RuntimeRegistration, RuntimeWindowPlan } from "./jobs/runtimeSchema.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { AgentStore } from "./store.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { evidenceViewSchemas } from "../adapter/viewSchemas/evidence.ts";
import { runtimeApiAckSchema, safeRuntimeRunSchema } from "./jobs/runtimeViews.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer, syntheticBinding } from "./testFixtures.ts";
import { createSyntheticVideoCollector, fixtureBrief, fixtureReviews, fixtureSourcePost } from "./videoEvidence/fixtures.testkit.ts";
import type { VideoEvidenceQuality } from "./videoEvidence/qualityContract.ts";

/** Synthetic identities, posts and receipts only. This proves the J20 protocol in the sandbox, not a live source collection. */
const runtimeToken = "synthetic-j20-runtime-worker-credential-000000";
const dispatchToken = "synthetic-j20-dispatch-worker-credential-00000";
const readFields = { schemaVersion: SCHEMA_VERSION, requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" } };
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const close of closes.splice(0).reverse()) await close(); });

class Sink implements IdentitySink {
  private receipts = new Map<string, SinkReceipt>();
  constructor(readonly name: string) {}
  upsert(key: string, _record: CanonicalRecord, binding: SinkBinding) {
    const receipt: SinkReceipt = { ...binding, state: "applied", receiptRef: `${this.name}:${key}`, observedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 10 * 60_000).toISOString() };
    this.receipts.set(key, receipt); return receipt;
  }
  read(key: string, binding: SinkBinding) {
    const receipt = this.receipts.get(key);
    return receipt ? { ...receipt, observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 10 * 60_000).toISOString() }
      : { ...binding, state: "notApplied", terminal: true, receiptRef: `fence:${binding.attemptId}`, observedAt: new Date().toISOString() };
  }
}

function j20Registration(overrides: Partial<RuntimeRegistration> = {}) {
  const base = syntheticRuntimeRegistration();
  return syntheticRuntimeRegistration({ registrationRef: "synthetic-j20", family: "J20", executorRef: "j20-video-evidence.v1",
    browserBinding: null, browserExecutorRef: null, definition: { ...base.definition, jobId: "synthetic-j20" }, ...overrides });
}

async function harness(options: { registration?: RuntimeRegistration; bind?: boolean; scorecardAuthority?: AgentServerOptions["scorecardAuthority"] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "farda-j20-")), databasePath = join(directory, "agent.sqlite");
  const store = new AgentStore(databasePath, scope);
  const registration = options.registration ?? j20Registration();
  const kit = createRuntimeTestkit(store.database, { registration }); await kit.initialize();
  // Window membership comes from the source authority; here it names the intake creators queued for review.
  const subjects: string[] = [];
  const prepare = kit.authority.prepareWindow, assertWindow = kit.authority.assertWindow, issued = new Map<string, RuntimeWindowPlan>();
  kit.authority.prepareWindow = async input => {
    const plan = await prepare(input) as RuntimeWindowPlan;
    if (plan.kind !== "source") return plan;
    const named = { ...plan, items: plan.items.map((item, i) => ({ ...item, itemKey: subjects[i] ?? item.itemKey, subjectRef: subjects[i] ?? item.subjectRef })) };
    issued.set(plan.receiptRef, plan); return named;
  };
  kit.authority.assertWindow = (proof, r, now) => assertWindow(issued.get(proof.receiptRef) ?? proof, r, now);
  const collector = createSyntheticVideoCollector(kit.now);
  const appOptions: AgentServerOptions = { databasePath, workspaceId: scope.workspaceId, accountId: scope.accountId, readToken: reader, reviewToken: reviewer,
    bindings: [syntheticBinding()], operations: { now: kit.now }, scorecardAuthority: options.scorecardAuthority,
    intakeAuthority: { route: () => "Ready", suppression: v => ({ version: v, entries: [] }), crosswalk: v => ({ version: v, entries: [] }),
      sinks: { "notion-creator-crm": new Sink("notion"), "sheets-watchlist": new Sink("sheets") } },
    runtime: { registry: { ...kit.registry, executors: new Map() }, authority: kit.authority, machine: { token: runtimeToken, workerRef: kit.machine.workerRef,
      resolve: async (s, operation, input) => ({ scope: s, workerRef: kit.machine.workerRef, operation, inputHash: digest(input), proofRef: "synthetic-machine-proof",
        observedAt: new Date(kit.now()).toISOString(), validUntil: new Date(kit.now() + 60_000).toISOString() }), assertCurrent: () => {} } },
    actionFoundation: { approvals: { sources: {
      resolveActor: async principalRef => ({ scope, principalRef, personRef: "synthetic-person", roles: ["viewer"], active: true, directoryVersion: "synthetic-directory-v1",
        observedAt: new Date(kit.now()).toISOString(), validUntil: new Date(kit.now() + 60_000).toISOString() }),
      assertCurrent: () => {},
    } }, worker: { token: dispatchToken, workerRef: "synthetic-dispatch-machine", resolve: async () => { throw new Error("Bare dispatch is not used by J20"); }, assertCurrent: () => {} } },
    ...(options.bind === false ? {} : { videoEvidence: { registrationRef: registration.registrationRef, handoffRef: "synthetic-j20-owner-handoff", source: collector.source } }),
  };
  const app = createAgentServer(appOptions);
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Missing local test address");
  const origin = `http://127.0.0.1:${address.port}`;
  closes.push(async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function call(method: "GET" | "POST" | "PUT", path: string, body?: unknown, token = reviewer, key?: string) {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  async function discover(eventId: string, over: Partial<IntakeInput> = {}) {
    const input: IntakeInput = { campaignRef: null, briefRef: { ref: fixtureBrief.ref, version: fixtureBrief.version }, recruitmentSource: "daily-discovery",
      trigger: "discovery", eventId, occurredAt: "2026-11-05T10:00:00Z", observedAt: "2026-11-05T11:00:00Z",
      sourceCandidate: { source: "daily-discovery", accountId: "discovery-sandbox", sourceId: `candidate-${eventId}`, url: null, canonicalId: null, identityState: "unresolved", provenanceRef: `prov:${eventId}` },
      profileRefs: [{ source: "instagram", accountId: "instagram-public", sourceId: `ig-${eventId}`, url: null, canonicalId: null, identityState: "unresolved",
        provenanceRef: `prov:ig-${eventId}`, handle: null, sourceUpdatedAt: null }],
      publishingNetworks: ["instagram"], identityMapVersion: "map-v1", suppressionVersion: "suppression-v1", cursor: null, ...over };
    const envelope = { jobId: "J01", jobVersion: "creator-intake.v1", mode: "observe", actor: { id: "agent-intake", role: "agent" },
      accountRef: { workspaceId: scope.workspaceId, accountId: scope.accountId }, policyVersion: "commission-only-v1", inputHash: digest(input),
      idempotencyKey: `intake-${eventId}`, correlationId: `corr-${eventId}`, requestedAt: "2026-11-05T12:00:00Z", deadline: null, checkpoint: null };
    const result = await call("POST", "/v1/intake", { envelope, input }, reviewer, `intake-${eventId}`);
    expect(result.status).toBe(200);
    const creatorId = (result.body.creatorRef as { canonicalId: string }).canonicalId;
    subjects.push(creatorId); kit.state.items = subjects.length;
    return { creatorId, nextWork: result.body.nextWork };
  }
  let day = 0;
  async function runDay() {
    const intendedAt = new Date(Date.parse("2026-11-07T10:00:00Z") + day * 86_400_000).toISOString();
    if (day) { kit.advance(86_400_000); await kit.verify("api"); }
    day++;
    const run = await app.runtime.fire({ registrationRef: registration.registrationRef, registrationVersion: registration.version, intendedAt,
      triggerEventRef: `synthetic-j20-day-${day}` }, kit.machine);
    return { runRef: run.run.runId, work: () => app.runtime.work({ runRef: run.run.runId, maxItems: 10 }, kit.machine) };
  }
  const steps = (runRef: string) => app.store.database.prepare("SELECT body FROM job_runtime_steps WHERE run_ref=? ORDER BY checkpoint_version").all(runRef)
    .map(row => (JSON.parse(String(row.body)) as { step: { state: string; evidenceRefs: string[]; recordCount: number } }).step);
  const readView = (viewKey: string, filters: Record<string, string>, token = reviewer) => call("POST", "/v1/read", { ...readFields, operation: "readView",
    requestId: `synthetic-j20-${viewKey}`, viewKey, filters, period: null, sort: [], page: { limit: 25, cursor: null } }, token);
  const machine = (operation: string, input: unknown) => call("POST", "/v1/runtime/machine", { operation, input }, runtimeToken);
  return { app, kit, collector, call, discover, runDay, steps, registration, readView, machine };
}

const packetOf = (app: Awaited<ReturnType<typeof harness>>["app"], creatorId: string) => app.store.latest(creatorId)!.packet as EvidencePacket;
const post = (packet: EvidencePacket, n: number) => packet.posts.find(p => p.sourceUrl.endsWith(`SYNTHJ20${n}/`));

describe("J20 collector through the registered runtime, intake queue and shared writer", () => {
  it("collects one versioned packet, gates likes strictly, keeps lower-like metadata, aliases provider IDs and reuses unchanged evidence", async () => {
    const h = await harness();
    const { creatorId, nextWork } = await h.discover("d1");
    expect(nextWork).toBe("J20");
    const page = [
      fixtureSourcePost(1),
      fixtureSourcePost(2, { review: structuredClone(fixtureReviews.sampled), publishedAt: "2026-10-02T12:00:00.000Z" }),
      fixtureSourcePost(3, { review: structuredClone(fixtureReviews.muted), publishedAt: "2026-10-03T12:00:00.000Z" }),
      fixtureSourcePost(4, { likes: { value: 199, rawLabel: "199", sourceType: "nativePublicCounter", sourceRef: "synthetic:likes:4", missingReason: null } }),
      fixtureSourcePost(5, { likes: { value: 200, rawLabel: "200", sourceType: "nativePublicCounter", sourceRef: "synthetic:likes:5", missingReason: null }, review: null }),
      fixtureSourcePost(6, { likes: { value: null, rawLabel: "Hidden", sourceType: "nativePublicCounter", sourceRef: "synthetic:likes:6", missingReason: "hidden" }, review: null }),
      fixtureSourcePost(7, { likes: { value: 1200, rawLabel: "1.2K", sourceType: "nativePublicCounter", sourceRef: "synthetic:likes:7", missingReason: null }, review: null }),
      fixtureSourcePost(8, { context: { ...fixtureSourcePost(8).context, exclusion: "clinicalLecture", educatorOrCredentialed: true }, relevant: true,
        likes: { value: 5000, rawLabel: "5,000", sourceType: "nativePublicCounter", sourceRef: "synthetic:likes:8", missingReason: null } }),
      fixtureSourcePost(9, { likes: { value: 900, rawLabel: "900", sourceType: "thirdParty", sourceRef: "synthetic:third-party", missingReason: null }, review: null }),
    ];
    h.collector.on(null, h.collector.page(page));
    const day1 = await h.runDay();
    expect((await day1.work()).run.state).toBe("completed");
    const first = h.app.store.history(creatorId);
    expect(first).toHaveLength(1);
    const packet = first[0]!.packet;
    expect(packet.collection).toMatchObject({ schemaVersion: "farda.video-evidence.v1", collectorStage: "synthetic-fixture", briefVersion: "v1", listedPosts: 9 });
    expect(packet.posts.map(p => p.sourceUrl.match(/SYNTHJ20(\d)/)![1]).sort()).toEqual(["1", "2", "3"]);
    expect(packet.recentPosts).toHaveLength(9);
    const reasons = Object.fromEntries(packet.collection!.exclusions.map(e => [packet.recentPosts.find(r => r.postId === e.postId)?.nativeLikes.rawLabel ?? e.postId, e.reasons]));
    expect(reasons).toEqual({ "199": ["LIKES_NOT_ABOVE_200", "REVIEW_IGNORED_BELOW_GATE"], "200": ["LIKES_NOT_ABOVE_200"], Hidden: ["LIKES_PENDING_PROOF"],
      "1.2K": ["LIKES_PENDING_PROOF"], "5,000": ["EXCLUDED_CLINICAL_LECTURE"], "900": ["LIKES_PENDING_PROOF"] });
    // Lower-like posts sit in the baseline as metadata only and never carry a stored review.
    expect(JSON.stringify(packet.posts)).not.toContain("SYNTHJ204/");
    expect(first[0]!.assessment.gates.filter(g => ["QUALIFYING_POSTS", "PUBLICATION_DATES", "MEANINGFUL_USE"].includes(g.id)).map(g => g.state)).toEqual(["pass", "pass", "pass"]);
    // The clinical lecture is accessible metadata but not relevant, so the relevant baseline has eight rows, not nine.
    expect(first[0]!.assessment.metadata).toMatchObject({ sampleSize: 8, coverage: "partial" });
    // Provider account and comment authors are stored only as scoped aliases.
    const stored = JSON.stringify(packet);
    expect(stored).not.toContain("synthetic-provider-account-1");
    expect(stored).not.toContain("synthetic-author-1");
    expect(post(packet, 1)!.source!.providerAccountRef).toMatch(/^account:[0-9a-f]{64}$/);
    expect(evidencePacketSchema.parse(packet)).toEqual(packet);
    expect(h.steps(day1.runRef)).toEqual([expect.objectContaining({ state: "completed", recordCount: 9, evidenceRefs: [`j20-evidence:${first[0]!.runId}`] })]);
    // The next daily read of identical facts reuses the stored version: no second revision, no duplicate observation.
    const day2 = await h.runDay();
    expect((await day2.work()).run.state).toBe("completed");
    expect(h.app.store.history(creatorId)).toHaveLength(1);
    expect(h.steps(day2.runRef)[0]!.evidenceRefs).toEqual([`j20-evidence:${first[0]!.runId}`]);
    // A changed counter is a new observation and a new immutable revision; the first revision is unchanged.
    h.collector.on(null, h.collector.page(page.map((p, i) => i ? p : { ...p, metrics: [{ ...p.metrics[0]!, value: 4321, rawLabel: "4321" }, p.metrics[1]!] })));
    expect((await (await h.runDay()).work()).run.state).toBe("completed");
    const history = h.app.store.history(creatorId);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(first[0]);
    expect(history[1]!.packet.evidenceRevision).not.toBe(first[0]!.packet.evidenceRevision);
    const capabilities = await h.call("GET", "/v1/capabilities", undefined, reader);
    expect(capabilities.body.videoEvidence).toMatchObject({ collector: "synthetic-fixture", writer: "creator-evidence-writer", queue: "intake-j20", scoring: "j02-only" });
  });

  it("holds login and MFA as owned takeovers, preserves prior evidence, and resumes from the last checkpoint without re-reading", async () => {
    const h = await harness();
    const { creatorId } = await h.discover("d2");
    h.collector.on(null, h.collector.page([fixtureSourcePost(1), fixtureSourcePost(2, { publishedAt: "2026-10-02T12:00:00.000Z" })], { nextCursor: "synthetic-page-2", listedPosts: 3 }));
    h.collector.on("synthetic-page-2", { kind: "read", read: { state: "takeover", kind: "mfa", reasonCode: "SYNTHETIC_MFA" } },
      h.collector.page([fixtureSourcePost(3, { publishedAt: "2026-10-03T12:00:00.000Z" })], { listedPosts: 3 }));
    const day = await h.runDay();
    const held = await day.work();
    expect(held.run.state).toBe("held");
    expect(held.takeovers).toMatchObject([{ kind: "mfa", resolved: false }]);
    const before = h.app.store.history(creatorId);
    expect(before).toHaveLength(1);
    expect(before[0]!.packet.posts).toHaveLength(2);
    expect(h.collector.requests.map(r => r.cursor)).toEqual([null, "synthetic-page-2"]);
    // Nothing resumes without the source-issued resolution receipt; repeating work does not call the source again.
    await day.work();
    expect(h.collector.requests).toHaveLength(2);
    await h.app.runtime.resolveTakeover({ runRef: day.runRef, itemRef: held.takeovers[0]!.itemRef, expectedVersion: held.takeovers[0]!.version,
      receiptRef: "receipt:synthetic-owner-resolution", requestKey: "synthetic-j20-resume" }, h.kit.machine);
    expect((await day.work()).run.state).toBe("completed");
    expect(h.collector.requests.map(r => r.cursor)).toEqual([null, "synthetic-page-2", "synthetic-page-2"]);
    const after = h.app.store.history(creatorId);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]!.packet.posts).toHaveLength(3);
  });

  it("records removed, changed and denied access beside the earlier evidence, never as a new observation", async () => {
    const h = await harness();
    const { creatorId } = await h.discover("d3");
    const posts = [fixtureSourcePost(1), fixtureSourcePost(2, { publishedAt: "2026-10-02T12:00:00.000Z" }), fixtureSourcePost(3, { publishedAt: "2026-10-03T12:00:00.000Z" })];
    h.collector.on(null, h.collector.page(posts));
    await (await h.runDay()).work();
    const original = packetOf(h.app, creatorId);
    h.collector.on(null, h.collector.page([
      { ...posts[0]!, access: "removed", review: null },
      { ...posts[1]!, contentFingerprint: "synthetic-fingerprint-2-edited", review: null },
      { ...posts[2]!, access: "permissionDenied", review: null },
      fixtureSourcePost(4, { access: "loginRequired", review: null }),
    ]));
    await (await h.runDay()).work();
    const current = packetOf(h.app, creatorId);
    expect(post(current, 1)).toMatchObject({ accessObservation: { state: "deleted" }, source: { change: "removed" }, review: post(original, 1)!.review });
    expect(post(current, 2)).toMatchObject({ source: { change: "changed" }, review: { status: "unassessed", visualMethod: "unassessed" } });
    expect(post(current, 3)).toMatchObject({ accessObservation: { state: "permissionDenied" }, review: post(original, 3)!.review });
    expect(current.collection!.exclusions.map(e => e.reasons)).toEqual([["ACCESS_LOGIN_REQUIRED"]]);
    expect(h.app.store.history(creatorId)[0]!.packet).toEqual(original);
    expect(h.app.store.latest(creatorId)!.assessment.packet.qualifyingPosts).toBeLessThan(3);
    // A source-level permission denial holds the run and writes nothing.
    h.collector.on(null, { kind: "read", read: { state: "denied", reasonCode: "SYNTHETIC_DENIED" } });
    const denied = await h.runDay();
    await expect(denied.work()).rejects.toMatchObject({ code: "SOURCE_SCOPE_DENIED", status: 403 });
    expect(h.app.store.history(creatorId)).toHaveLength(2);
    expect((await h.app.runtime.readRun(denied.runRef)).run.state).not.toBe("completed");
  });

  it("works only queued, briefed J01 creators and refuses invalid or stale source pages", async () => {
    const h = await harness();
    const signup = await h.discover("s1", { trigger: "signup", recruitmentSource: "social-cat",
      sourceCandidate: { source: "social-cat", accountId: "social-cat-sandbox", sourceId: "candidate-s1", url: null, canonicalId: null, identityState: "unresolved", provenanceRef: "prov:s1" } });
    expect(signup.nextWork).toBe("J02");
    const unbriefed = await h.discover("d4", { briefRef: null });
    h.collector.on(null, h.collector.page([fixtureSourcePost(1)]));
    const day = await h.runDay();
    const read = await day.work();
    expect(read.run.items.map(item => item.reasonCode).sort()).toEqual(["J20_BRIEF_UNBOUND", "J20_NOT_QUEUED"]);
    expect(h.collector.requests).toHaveLength(0);
    expect(h.app.store.latest(signup.creatorId)).toBeNull();
    expect(h.app.store.latest(unbriefed.creatorId)).toBeNull();
    // A page for another brief, an elapsed-only "complete" review, or a mismatched request digest stores nothing.
    const h2 = await harness();
    const { creatorId } = await h2.discover("d5");
    h2.collector.on(null, h2.collector.page([fixtureSourcePost(1)], { brief: { ...fixtureBrief, version: "v2" } }));
    await expect((await h2.runDay()).work()).rejects.toMatchObject({ code: "J20_BRIEF_MISMATCH" });
    const elapsedOnly = { ...structuredClone(fixtureReviews.complete), watchedIntervals: [{ startSec: 0, endSec: 10 }], heardIntervals: [], audioMethod: "unassessed" as const };
    h2.collector.on(null, h2.collector.page([fixtureSourcePost(1, { review: elapsedOnly })]));
    await expect((await h2.runDay()).work()).rejects.toMatchObject({ code: "J20_SOURCE_RESPONSE_INVALID" });
    expect(h2.app.store.latest(creatorId)).toBeNull();
  });

  it("routes medical claims and withheld inference to the existing reviewer path and reports quality through the authenticated reads", async () => {
    const h = await harness();
    const { creatorId } = await h.discover("d6");
    const claimed = { ...structuredClone(fixtureReviews.complete),
      claims: [{ atSec: 9, text: "Says the case keeps her medication cool all day.", method: "heard" as const, topic: "medical" as const },
        { atSec: 11, text: "Says the zipper is sturdy.", method: "heard" as const, topic: "productFunction" as const }],
      narration: [{ atSec: 4, text: "Says she packs it every morning.", method: "heard" as const, about: "action" as const }],
      inferences: ["She looks pregnant in this clip.", "Top-down framing suits the brief."] };
    h.collector.on(null, h.collector.page([fixtureSourcePost(1, { review: claimed }), fixtureSourcePost(2, { publishedAt: "2026-10-02T12:00:00.000Z" }),
      fixtureSourcePost(4, { likes: { value: 150, rawLabel: "150", sourceType: "nativePublicCounter", sourceRef: "synthetic:likes:4", missingReason: null }, review: null,
        context: { ...fixtureSourcePost(4).context, pinned: true, paid: "yes" } })], { listedPosts: 5 }));
    // Fire and work through the machine API, then read the trace through the existing runtime run view.
    const fired = await h.machine("fire", { registrationRef: h.registration.registrationRef, registrationVersion: h.registration.version,
      intendedAt: "2026-11-07T10:00:00Z", triggerEventRef: "synthetic-j20-http" });
    const runRef = runtimeApiAckSchema.parse(fired.body).runRefs[0]!;
    expect((await h.machine("work", { runRef, maxItems: 1 })).body.state).toBe("completed");
    const trace = await h.readView("runDetail", { runId: runRef }, reader);
    expect(trace.status).toBe(200);
    const run = safeRuntimeRunSchema.parse(trace.body.data);
    expect(run).toMatchObject({ family: "J20", state: "completed", items: [{ result: "observationRecorded" }] });
    expect(JSON.stringify(run)).not.toContain(creatorId);
    const stored = h.app.store.latest(creatorId)!;
    const claimedPost = stored.packet.posts.find(p => p.sourceUrl.endsWith("SYNTHJ201/"))!;
    expect(claimedPost.review.inferences).toEqual(["Top-down framing suits the brief."]);
    expect(stored.packet.collection!.quarantined).toEqual([{ postId: claimedPost.postId, field: "review.inferences[0]", reasonCodes: ["DIAGNOSIS_INFERENCE_REFUSED"] }]);
    expect(claimedPost.review.claims.map(c => c.text)).toContain("Says the case keeps her medication cool all day.");
    expect(claimedPost.review.observedActions.every(a => a.kind !== undefined)).toBe(true);
    const record = await h.readView("evidenceRecord", { creatorId, evidenceId: claimedPost.postId });
    expect(record.status).toBe(200);
    const view = evidenceViewSchemas.evidenceRecord!.parse(record.body.data) as { videoEvidenceQuality: VideoEvidenceQuality; sourceReview: { basisHash: string }; version: string };
    const quality = view.videoEvidenceQuality;
    expect(quality).toMatchObject({ collectorStage: "synthetic-fixture", nextAction: "needsClaimReview",
      counts: { listed: 5, observed: 3, accessible: 3, eligible: 2, reviewed: 2, metadataOnly: 1, excluded: 1 },
      packet: { qualifyingPosts: 2, status: "needsEvidence" }, audience: { verified: 0, unverified: 0 } });
    expect(quality.limitations).toEqual(expect.arrayContaining(["SYNTHETIC_FIXTURE_COLLECTOR", "PARTIAL_SOURCE_LISTING", "NO_VERIFIED_AUDIENCE_REPORT", "INFERENCE_TEXT_QUARANTINED"]));
    expect(quality.footage.find(f => f.postId === claimedPost.postId)).toMatchObject({ viewingStatus: "completeAudioVisual", audioCoverage: "heard", narration: 1,
      claimsForReview: ["claim-0"], quarantinedFields: 1, outcomeCausality: "unresolved", nextAction: "needsClaimReview",
      features: { hook: "observed", handlingOperationUse: "observed", explanation: "notObserved", visibleOutcome: "notObserved", cta: "notObserved" } });
    expect(quality.metadataOnly).toEqual([expect.objectContaining({ pinned: true, paid: "yes", likeGate: "fail", rawLikeLabel: "150", ageDays: expect.any(Number), reasons: ["LIKES_NOT_ABOVE_200"] })]);
    const body = JSON.stringify(record.body);
    for (const raw of ["synthetic-provider-account-1", "synthetic-author-1", "She looks pregnant"]) expect(body).not.toContain(raw);
    // A person disagrees with the medical claim through the existing reviewer path; the agent never resolves it.
    const saved = await h.call("POST", "/v1/save", { ...readFields, operation: "saveResource", requestId: "synthetic-j20-claim-review",
      resourceKind: "reviewerAssessment", resourceRef: claimedPost.postId, expectedVersion: view.version, idempotencyKey: "synthetic-j20-claim",
      payload: { kind: "disagree", creatorId, runId: stored.runId, basisHash: view.sourceReview.basisHash, targetId: "claim-0",
        reason: "The claim about medication needs a person, not the agent." } });
    expect(saved.status).toBe(200);
    const after = evidenceViewSchemas.evidenceRecord!.parse((await h.readView("evidenceRecord", { creatorId, evidenceId: claimedPost.postId })).body.data) as
      { videoEvidenceQuality: VideoEvidenceQuality; qualification: { state: string; reasonCodes: string[] } };
    expect(after.videoEvidenceQuality.footage.find(f => f.postId === claimedPost.postId)!.claimsForReview).toEqual([]);
    expect(after.qualification).toMatchObject({ state: "reviewNeeded", reasonCodes: expect.arrayContaining(["EVIDENCE_DISPUTED"]) });
    expect(h.app.store.latest(creatorId)!.assessment.state).not.toBe("activationReady");
  });

  it("lets a reviewer rate collected evidence through the same writer but never author J20 collection facts", async () => {
    const h = await harness();
    const { creatorId } = await h.discover("d7");
    h.collector.on(null, h.collector.page([fixtureSourcePost(1), fixtureSourcePost(2, { publishedAt: "2026-10-02T12:00:00.000Z" }), fixtureSourcePost(3, { publishedAt: "2026-10-03T12:00:00.000Z" })]));
    await (await h.runDay()).work();
    const latest = h.app.store.latest(creatorId)!;
    const put = (packet: EvidencePacket, key: string) => h.call("PUT", `/v1/creators/${creatorId}`, { packet, expectedVersion: latest.revision,
      policyVersion: latest.assessment.policyVersion, configHash: syntheticBinding().hash }, reviewer, key);
    const rated = await put({ ...latest.packet, evidenceRevision: "reviewer-rated", ratings: { routine: 4, demo: 3 } }, "synthetic-j20-rate");
    expect(rated.status).toBe(200);
    expect(h.app.store.latest(creatorId)!.assessment.criteria).toEqual({ routine: 4, demo: 3 });
    const relabeled = { ...latest.packet, evidenceRevision: "reviewer-forged", collection: { ...latest.packet.collection!, collectorStage: "source" as const } };
    expect(await put(relabeled, "synthetic-j20-forge-stage")).toMatchObject({ status: 409, body: { code: "J20_COLLECTION_READ_ONLY" } });
    const upgraded = structuredClone(latest.packet); upgraded.evidenceRevision = "reviewer-upgraded";
    upgraded.posts[0]!.review.observedActions.push({ atSec: 20, action: "A use the collector never observed.", meaningfulUse: true, kind: "handlingOperationUse" });
    expect(await put(upgraded, "synthetic-j20-forge-review")).toMatchObject({ status: 409, body: { code: "J20_COLLECTION_READ_ONLY" } });
    expect(h.app.store.history(creatorId)).toHaveLength(2);
  });

  it("retries instead of overwriting when a reviewer write moves the evidence head mid-step, then merges over it", async () => {
    const race = { armed: false, write: () => {} };
    const h = await harness({ scorecardAuthority: { resolve: () => { if (race.armed) { race.armed = false; race.write(); } return null; } } });
    const { creatorId } = await h.discover("d8");
    const posts = [fixtureSourcePost(1), fixtureSourcePost(2, { publishedAt: "2026-10-02T12:00:00.000Z" })];
    h.collector.on(null, h.collector.page(posts));
    await (await h.runDay()).work();
    const first = h.app.store.latest(creatorId)!;
    race.write = () => { const rated = { ...first.packet, evidenceRevision: "reviewer-concurrent", ratings: { routine: 4, demo: 4 } };
      h.app.store.save(rated, { ...first.assessment, evidenceRevision: "reviewer-concurrent" }, first.revision, "synthetic-concurrent-review"); };
    race.armed = true;
    h.collector.on(null, h.collector.page(posts.map((p, i) => i ? p : { ...p, metrics: [{ ...p.metrics[0]!, value: 7777, rawLabel: "7777" }, p.metrics[1]!] })));
    const day = await h.runDay();
    expect((await day.work()).run.state).not.toBe("completed");
    expect(h.app.store.history(creatorId).map(r => r.packet.evidenceRevision)).toEqual([first.packet.evidenceRevision, "reviewer-concurrent"]);
    h.kit.advance(2000); await h.kit.verify("api");
    expect((await day.work()).run.state).toBe("completed");
    const merged = h.app.store.latest(creatorId)!;
    expect(merged.revision).toBe(3);
    expect(merged.packet.ratings).toEqual({ routine: 4, demo: 4 });
    expect(merged.packet.posts.find(p => p.sourceUrl.endsWith("SYNTHJ201/"))!.metrics![0]!.value).toBe(7777);
  });

  it("refuses a misbound registration and never runs the synthetic collector in production", async () => {
    await expect(harness({ registration: j20Registration({ family: "J19" }) })).rejects.toMatchObject({ code: "J20_REGISTRATION_INVALID" });
    const unbound = await harness({ bind: false });
    expect((await unbound.call("GET", "/v1/capabilities", undefined, reader)).body.videoEvidence).toMatchObject({ collector: "notConnected" });
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createSyntheticVideoCollector(Date.now)).toThrow(/NODE_ENV is production/);
    const fake = { stage: "synthetic-fixture" as const, collectorVersion: "synthetic-collector.v1", read: async () => null, assertCurrent: () => {} };
    expect(() => createAgentServer({ databasePath: ":memory:", workspaceId: scope.workspaceId, accountId: scope.accountId, readToken: reader, reviewToken: reviewer,
      runtime: { registry: { registrations: new Map([["synthetic-j20", j20Registration()]]), executors: new Map() } },
      videoEvidence: { registrationRef: "synthetic-j20", handoffRef: "synthetic-handoff", source: fake } })).toThrow("J20_SYNTHETIC_COLLECTOR_IN_PRODUCTION");
  });
});
