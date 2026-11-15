// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "./server.ts";
import { bindConfig, loadApprovedBindings, type ConfigBinding } from "./config.ts";
import { AGENT_VERSION, POLICY_VERSION, creatorAssessmentSchema, type CreatorAssessment } from "./assessmentSchema.ts";
import { evidencePacketSchema, type EvidencePacket } from "./evidence.ts";
import type { StoredAssessment } from "./store.ts";
import { agentAssessmentRecordSchema } from "./readViews.ts";
import { SCHEMA_VERSION } from "../adapter/contract";
import { evidenceViewSchemas } from "../adapter/viewSchemas/evidence";
import { syntheticPacket, syntheticSourceSnapshot, withActivationEvidence, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures.ts";

/** Synthetic evidence through the actual HTTP service and SQLite store, bound to the owner-approved launch configuration. */
const legacy = JSON.parse(readFileSync(new URL("./scoringFixtures/legacy-assessment-1.1.0.json", import.meta.url), "utf8")) as StoredAssessment;
const noncritical = ["verifiedCommerce", "audienceAlignment", "reliability", "offerEconomics"];
function approved(creatorId = "synthetic-j02-creator"): EvidencePacket {
  return evidencePacketSchema.parse({ ...withActivationEvidence(syntheticPacket("website")), creatorId, ratings: { routine: 5, demo: 4 },
    criterionRatings: { verifiedCommerce: 3, audienceAlignment: 4, reliability: 4, offerEconomics: 4 },
    criterionEvidenceRefs: Object.fromEntries(noncritical.map(id => [id, [`synthetic:criterion-proof:${id}`]])) });
}
type Receipt = StoredAssessment & { stale: boolean; code?: string };

describe("J02 versioned snapshots, reviewer overrides and the proposal-only handoff", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  let origin: string, directory: string, databasePath: string, bindings: ConfigBinding[];
  const sources = new Map<string, ReturnType<typeof syntheticSourceSnapshot>>();
  async function start(next = loadApprovedBindings()) {
    bindings = next;
    app = createAgentServer({ databasePath, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, bindings,
      workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, scorecardAuthority: { resolve: ({ creatorId }) => sources.get(creatorId) } });
    await new Promise<void>((resolve, reject) => { app!.server.once("error", reject); app!.server.listen(0, "127.0.0.1", resolve); });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral loopback address.");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() { const current = app; app = undefined; if (current) await current.close(); }
  async function call<T>(method: string, path: string, body?: unknown, token = SYNTHETIC_REVIEW_TOKEN, key?: string) {
    const response = await fetch(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) } });
    return { status: response.status, body: await response.json() as T };
  }
  const hashFor = (packet: EvidencePacket) => bindings.find(b => b.current.modelId === (packet.checkoutRoute === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3"))!.hash;
  async function put(packet: EvidencePacket, expectedVersion = 0, extra: Record<string, unknown> = {}, source = syntheticSourceSnapshot(packet, packet.criterionRatings)) {
    sources.set(packet.creatorId, source);
    return call<Receipt>("PUT", `/v1/creators/${packet.creatorId}`, { expectedVersion, policyVersion: POLICY_VERSION, configHash: hashFor(packet), packet, ...extra },
      SYNTHETIC_REVIEW_TOKEN, randomUUID());
  }
  const get = (creatorId: string) => call<Receipt>("GET", `/v1/creators/${creatorId}`, undefined, SYNTHETIC_READ_TOKEN);
  const readView = (viewKey: string, filters: Record<string, string>) => call<{ data: Record<string, unknown> & { version: string; sourceReview: { basisHash: string } } }>("POST", "/v1/read",
    { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: `synthetic-${viewKey}`, requestedScope: SYNTHETIC_SCOPE, viewKey, filters, period: null, sort: [], page: { cursor: null, limit: 50 } });
  const rawBodies = (creatorId: string) => app!.store.database.prepare("SELECT revision,body FROM assessments WHERE creator_id=? ORDER BY revision").all(creatorId)
    .map(row => [Number(row.revision), String(row.body)] as const);
  function ledgerCounts() {
    const db = app!.store.database;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
    return Object.fromEntries(tables.map(name => [name, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()!.n)]));
  }

  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "farda-j02-snapshot-")); databasePath = join(directory, "agent.sqlite"); sources.clear(); await start(); });
  afterEach(async () => { vi.useRealTimers(); await stop(); rmSync(directory, { recursive: true, force: true }); });

  it("persists every version, bound and a proposal-only recommendation, and writes nothing outside the assessment ledger", async () => {
    const before = ledgerCounts();
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["approval_manifests", "approval_outbox", "job_runs", "job_dispatch_intents", "offer_versions"]));
    const saved = await put(approved());
    expect(saved.status).toBe(200);
    const a = creatorAssessmentSchema.parse(saved.body.assessment);
    expect(a).toMatchObject({ agentVersion: AGENT_VERSION, state: "activationReady", score: { total: 82 }, rubricVersion: "route-proof.v1",
      offer: { state: "bound", origin: "provider", version: "v1", manifestHash: "synthetic-manifest-digest" }, scoreBounds: { min: 82, max: 82, total: 82 },
      calibrationState: "provisional", calibration: { operatingPolicy: { status: "approvedOperatingPolicy", configVersion: "2026-11-04.launch-v1" },
        salesPrediction: { status: "unvalidated" }, heldOutEvaluationRef: null },
      dimensions: { creativeFit: "pass", commerceEvidence: "verified", confidence: "complete", financialReadiness: "unavailable" },
      reviewerOverrides: [], rescore: { triggers: ["initial"], priorRevision: null },
      nextAction: { recommendation: "activationReady", mode: "propose", dispatch: "none", confersApproval: false,
        effects: { sends: false, spends: false, enrolls: false, ships: false } } });
    expect(Object.values(a.economics!.fields).every(field => field.state === "unavailable" && field.reason === "J11_RETAINED_SALES_LEDGER_NOT_CONNECTED")).toBe(true);
    // Only the assessment ledger and its idempotency receipt (which also carries the caller-request hash) grow.
    // api_principal_events is per-principal transport admission, not a business effect.
    const after = ledgerCounts();
    expect(Object.fromEntries(Object.entries(after).filter(([name, n]) => n !== before[name] && name !== "api_principal_events")))
      .toEqual({ assessments: 1, requests: 1 });
    // The new snapshot fields carry versions, hashes and reason codes only, never scope or source account identifiers.
    const added = JSON.stringify([a.offer, a.scoreBounds, a.calibration, a.metricCompatibility, a.dimensions, a.economics, a.nextAction, a.rescore]);
    for (const secret of [SYNTHETIC_SCOPE.workspaceId, SYNTHETIC_SCOPE.accountIds[0]!, "source-creator-id", "fixture-offer", "fixture-program"]) expect(added).not.toContain(secret);
    const view = await readView("assessmentRecord", { creatorId: "synthetic-j02-creator", assessmentId: saved.body.runId });
    expect(agentAssessmentRecordSchema.parse(view.body.data).assessedQualification).toEqual(a);
  });

  it("refuses a caller-supplied override, rescore reason, handoff or calibration claim", async () => {
    for (const [index, extra] of [{ reviewerOverrides: [] }, { rescore: { triggers: ["explicitRescore"] } }, { nextAction: null }, { calibrationState: "approvedCalibrated" }].entries()) {
      const result = await put(approved(), 0, extra);
      expect(result.status, `forged field ${index}`).toBe(400);
    }
    expect(app!.store.history("synthetic-j02-creator")).toEqual([]);
  });

  it("persists an open reviewer override with its reason and recorded versions, holds readiness on read and never rewrites history", async () => {
    const packet = approved();
    const first = await put(packet);
    const firstBody = rawBodies(packet.creatorId);
    const evidenceId = packet.posts[0]!.postId;
    const evidence = (await readView("evidenceRecord", { creatorId: packet.creatorId, evidenceId })).body.data;
    const saved = await call<{ record: { id: string } }>("POST", "/v1/save", { schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestId: "synthetic-override",
      requestedScope: SYNTHETIC_SCOPE, resourceKind: "reviewerAssessment", resourceRef: evidenceId, expectedVersion: evidence.version, idempotencyKey: "synthetic-override",
      payload: { kind: "override", creatorId: packet.creatorId, runId: first.body.runId, basisHash: evidence.sourceReview.basisHash, targetId: "action-0",
        reason: "The observed action is a different fictional bag.", replacement: "Places a fictional case beside the bag." } });
    expect(saved.status).toBe(200);
    // Read-time invalidation: the unsent readiness and its J04 proposal are withdrawn; the stored run is untouched.
    const held = await get(packet.creatorId);
    expect(held.body).toMatchObject({ stale: true, assessment: { state: "reviewNeeded", reasonCodes: expect.arrayContaining(["EVIDENCE_DISPUTED"]),
      nextAction: { recommendation: "reviewNeeded", dispatch: "none" } } });
    expect(rawBodies(packet.creatorId)).toEqual(firstBody);
    const disputed = evidenceViewSchemas.evidenceRecord!.parse((await readView("evidenceRecord", { creatorId: packet.creatorId, evidenceId })).body.data);
    expect(disputed.qualification).toMatchObject({ state: "reviewNeeded", nextAction: { recommendation: "reviewNeeded" } });

    const rescored = await put(packet, 1);
    expect(rescored.status).toBe(200);
    const stored = app!.store.findRun(packet.creatorId, rescored.body.runId)!.assessment;
    expect(stored.reviewerOverrides).toEqual([{ annotationRef: saved.body.record.id, kind: "override", postId: evidenceId, targetRef: "action-0",
      targetLabel: expect.stringContaining("Opens a fictional case"), reason: "The observed action is a different fictional bag.",
      replacement: "Places a fictional case beside the bag.", reviewerRef: "agent-reviewer", recordedAt: expect.any(String),
      basis: { revision: 1, evidenceRevision: packet.evidenceRevision, termsRevision: packet.termsRevision, policyVersion: POLICY_VERSION,
        modelId: "WEBSITE-AFFILIATE-v3", configHash: hashFor(packet), agentVersion: AGENT_VERSION, rubricVersion: "route-proof.v1" } }]);
    // The scored evidence result is unchanged; the snapshot's J04 handoff waits for the reviewer.
    expect(stored).toMatchObject({ state: "activationReady", rescore: { triggers: ["reviewerOverride"], priorRevision: 1 },
      reasonCodes: expect.arrayContaining(["REVIEWER_OVERRIDE_OPEN"]), nextAction: { recommendation: "reviewNeeded" } });
    expect(rescored.body).toMatchObject({ stale: true, assessment: { state: "reviewNeeded" } });
    expect(rawBodies(packet.creatorId)[0]).toEqual(firstBody[0]);
    expect(app!.store.history(packet.creatorId).map(r => r.assessment.state)).toEqual(["activationReady", "activationReady"]);
  });

  it("classifies evidence, objective, offer, stale-proof, policy and explicit rescores from the stored prior run", async () => {
    // Restart under the fake clock so the shared transport limiter and the source-proof lease use one clock.
    await stop(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T00:00:00.000Z")); await start();
    const packet = approved();
    const expiring = { ...syntheticSourceSnapshot(packet, packet.criterionRatings), validUntil: "2026-11-10T01:00:00.000Z" };
    expect((await put(packet, 0, {}, expiring)).body.assessment.rescore).toEqual({ triggers: ["initial"], priorRevision: null });
    vi.setSystemTime(new Date("2026-11-10T02:00:00.000Z"));
    expect((await get(packet.creatorId)).body).toMatchObject({ stale: true, assessment: { state: "reviewNeeded", nextAction: { recommendation: "reviewNeeded" } } });
    const steps: [Partial<EvidencePacket>, string[]][] = [
      [{}, ["staleEvidence"]], [{}, ["explicitRescore"]], [{ evidenceRevision: "synthetic-evidence-v2" }, ["evidenceReady"]],
      [{ evidenceRevision: "synthetic-evidence-v3", briefId: "synthetic-carry-use" }, ["evidenceReady", "objectiveChange"]],
      [{ evidenceRevision: "synthetic-evidence-v3", briefId: "synthetic-carry-use", termsRevision: "synthetic-terms-v2" }, ["offerChange"]],
    ];
    let current = packet;
    for (const [index, [patch, triggers]] of steps.entries()) {
      current = evidencePacketSchema.parse({ ...current, ...patch });
      const result = await put(current, index + 1);
      expect(result.status).toBe(200);
      expect(result.body.assessment.rescore).toEqual({ triggers, priorRevision: index + 1 });
    }
    // A configuration relabel with unchanged numeric meaning is a policy change: the latest read is stale until rescored.
    const history = rawBodies(packet.creatorId);
    await stop();
    const website = loadApprovedBindings().find(b => b.current.modelId === "WEBSITE-AFFILIATE-v3")!;
    await start([bindConfig({ ...website.current, version: "2026-11-04.launch-v1.relabel" }, website.baseline, website.baselineHash)]);
    expect((await get(packet.creatorId)).body).toMatchObject({ stale: true, assessment: { state: "reviewNeeded", nextAction: { recommendation: "reviewNeeded" } } });
    const relabeled = await put(current, steps.length + 1);
    expect(relabeled.body.assessment).toMatchObject({ config: { version: "2026-11-04.launch-v1.relabel" }, rescore: { triggers: ["policyChange"] }, score: { total: 82 } });
    expect(rawBodies(packet.creatorId).slice(0, history.length)).toEqual(history);
  });

  it("treats a snapshot scored under an earlier rubric revision as stale until rescored", async () => {
    const saved = await put(approved("synthetic-j02-current"));
    const creatorId = "synthetic-j02-prior-rubric";
    const prior: StoredAssessment = { ...saved.body, runId: randomUUID(), packet: { ...saved.body.packet, creatorId },
      assessment: { ...saved.body.assessment, creatorId, rubricVersion: "route-proof.v0" } };
    delete (prior as Partial<Receipt>).stale;
    const body = JSON.stringify(prior);
    app!.store.database.prepare("INSERT INTO assessments VALUES(?,?,?,?,?,?)").run(creatorId, 1, prior.runId, prior.recordedAt, prior.packetHash, body);
    expect((await get(creatorId)).body).toMatchObject({ stale: true, assessment: { state: "reviewNeeded", rubricVersion: "route-proof.v0",
      reasonCodes: expect.arrayContaining(["STALE_ASSESSMENT"]), nextAction: { recommendation: "reviewNeeded", dispatch: "none" } } });
    const rescored = await put(evidencePacketSchema.parse({ ...prior.packet }), 1);
    expect(rescored.body).toMatchObject({ stale: false, assessment: { state: "activationReady", rubricVersion: "route-proof.v1", rescore: { triggers: ["policyChange"], priorRevision: 1 } } });
    expect(rawBodies(creatorId)[0]).toEqual([1, body]);
  });

  it("keeps a frozen 1.1.0 snapshot parseable and byte-identical, read as stale, while a current-version rescore appends", async () => {
    expect(creatorAssessmentSchema.parse(legacy.assessment)).toEqual(legacy.assessment);
    expect(legacy.assessment).not.toHaveProperty("nextAction");
    const body = JSON.stringify(legacy);
    app!.store.database.prepare("INSERT INTO assessments VALUES(?,?,?,?,?,?)").run(legacy.packet.creatorId, legacy.revision, legacy.runId, legacy.recordedAt, legacy.packetHash, body);
    const read = await get(legacy.packet.creatorId);
    expect(read.body.assessment).toEqual({ ...legacy.assessment, state: "reviewNeeded", reasonCodes: [...legacy.assessment.reasonCodes, "STALE_ASSESSMENT"] });
    const view = await readView("assessmentRecord", { creatorId: legacy.packet.creatorId, assessmentId: legacy.runId });
    expect(view.status).toBe(200);
    const parsed = agentAssessmentRecordSchema.parse(view.body.data);
    expect(parsed).toMatchObject({ stale: true, qualification: { state: "reviewNeeded" } });
    expect(parsed.assessedQualification).toEqual(legacy.assessment);
    // A current snapshot cannot omit the J02 fields that a legacy one never had.
    expect(creatorAssessmentSchema.safeParse({ ...legacy.assessment, agentVersion: AGENT_VERSION }).success).toBe(false);
    const next = evidencePacketSchema.parse({ ...legacy.packet, evidenceRevision: "synthetic-evidence-after-upgrade" });
    const rescored = await put(next, 1);
    expect(rescored.status).toBe(200);
    expect(rescored.body.assessment as CreatorAssessment).toMatchObject({ agentVersion: AGENT_VERSION, rescore: { triggers: ["evidenceReady", "policyChange"], priorRevision: 1 } });
    expect(rawBodies(legacy.packet.creatorId)[0]).toEqual([1, body]);
    expect(app!.store.history(legacy.packet.creatorId)[0]).toEqual(legacy);
  });
});
