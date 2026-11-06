// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "./server.ts";
import { digest, loadApprovedBindings, numericDigest, type ConfigBinding } from "./config.ts";
import { AGENT_SCHEMA_VERSION, AGENT_VERSION, POLICY_VERSION, creatorAssessmentSchema } from "./assessmentSchema.ts";
import { evidencePacketSchema, type EvidencePacket } from "./evidence.ts";
import type { StoredAssessment } from "./store.ts";
import { SCHEMA_VERSION } from "../adapter/contract";
import { createLiveAdapter } from "../adapter/liveAdapter";
import { createHttpTransport } from "../adapter/httpTransport";
import { evidenceViewSchemas } from "../adapter/viewSchemas/evidence";
import { scoreOf } from "../features/scorecards/scorecardMath";
import { syntheticSourceSnapshot, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE, syntheticPacket, withActivationEvidence } from "./testFixtures.ts";

const ids = ["routineFit", "demonstrationStorytelling", "verifiedCommerce", "audienceAlignment", "reliability", "offerEconomics"];
const approved = {
  website: { modelId: "WEBSITE-AFFILIATE-v3", weights: [25, 20, 15, 15, 10, 15], score: 82, hash: "048db012fb33cf8aa5f5ec8e02e31ab56d08e32fb7e4259cf2c329dea71697e6" },
  "tiktok-shop": { modelId: "TIKTOK-SHOP-AFFILIATE-v3", weights: [25, 20, 20, 15, 10, 10], score: 81, hash: "27749895dd5e81032ad1bb569c7f91cc08b24c6e9079c906c8160ce8e8eff808" },
} as const;
const routes = ["website", "tiktok-shop"] as const;
const noncritical = ["verifiedCommerce", "audienceAlignment", "reliability", "offerEconomics"];

/** Only source evidence is synthetic; these tests bind the owner's actual approved immutable launch manifest. */
function completePacket(route: EvidencePacket["checkoutRoute"]): EvidencePacket {
  const packet = withActivationEvidence(syntheticPacket(route));
  return evidencePacketSchema.parse({
    ...packet, creatorId: `synthetic-approved-${route}`, ratings: { routine: 5, demo: 4 },
    criterionRatings: { verifiedCommerce: 3, audienceAlignment: 4, reliability: 4, offerEconomics: 4 },
    criterionEvidenceRefs: Object.fromEntries(noncritical.map((id) => [id, [`synthetic:criterion-proof:${id}`]])),
  });
}

describe("owner-approved launch baselines through actual HTTP and SQLite", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  let origin: string;
  let directory: string;
  let databasePath: string;
  let bindings: ConfigBinding[];

  const sourceRows = new Map<string, ReturnType<typeof syntheticSourceSnapshot>>();
  async function start() {
    app = createAgentServer({ databasePath, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, scorecardAuthority: { resolve: ({creatorId}) => sourceRows.get(creatorId) }, bindings });
    const server = app.server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral loopback test address.");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() { const current = app; app = undefined; if (current) await current.close(); }
  const bindingFor = (route: EvidencePacket["checkoutRoute"]) => bindings.find((binding) => binding.current.modelId === approved[route].modelId)!;
  async function put(packet: EvidencePacket, expectedVersion = 0) {
    sourceRows.set(packet.creatorId, syntheticSourceSnapshot(packet, packet.criterionRatings));
    const response = await fetch(`${origin}/v1/creators/${packet.creatorId}`, {
      method: "PUT", headers: { authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ expectedVersion, policyVersion: POLICY_VERSION, configHash: bindingFor(packet.checkoutRoute).hash, packet }),
    });
    const { stale, ...receipt } = await response.json() as StoredAssessment & { stale?: boolean; code?: string };
    if (response.ok) expect(stale).toBe(false);
    return { status: response.status, body: receipt };
  }
  async function get(creatorId: string) {
    const response = await fetch(`${origin}/v1/creators/${creatorId}`, { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
    expect(response.status).toBe(200);
    return await response.json() as StoredAssessment & { stale: boolean };
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "farda-approved-baseline-"));
    databasePath = join(directory, "evidence.sqlite");
    bindings = loadApprovedBindings();
    await start();
  });
  afterEach(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });

  it("loads exactly the two approved vectors, original bands and explicit phase rules", () => {
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((binding) => binding.current.modelId)).size).toBe(2);
    for (const route of routes) {
      const binding = bindingFor(route);
      expect(binding.current.version).toBe("2026-11-04.launch-v1");
      expect(binding.current.criteria.map((criterion) => criterion.id)).toEqual(ids);
      expect(binding.current.criteria.map((criterion) => criterion.weight)).toEqual(approved[route].weights);
      expect(binding.baseline.criteria.map((criterion) => criterion.weight)).toEqual(approved[route].weights);
      expect([...binding.current.bands].sort((a, b) => a.min - b.min)).toEqual([{ id: "hold", min: 0 }, { id: "manualReview", min: 65 }, { id: "priorityReview", min: 80 }]);
      expect(binding.current.decisionRules).toEqual({ invitationMinScore: null, activationMinScore: 80, minCoveragePct: 0 });
      expect(binding.current.arithmetic).toBe("weight*rating/5;round-complete-total;no-rescaling");
      expect(binding.hash).toBe(approved[route].hash);
      expect(binding.baselineHash).toBe(approved[route].hash);
      expect(binding.hash).toBe(digest(binding.current));
      expect(binding.numericHash).toBe(numericDigest(binding.baseline));
      expect(binding.numericHash).toBe(numericDigest(binding.current));
    }
  });

  it("serves the approved rating anchors only to an authenticated reader", async () => {
    expect((await fetch(`${origin}/v1/policy`)).status).toBe(401);
    const response = await fetch(`${origin}/v1/policy`, { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
    expect(response.status).toBe(200);
    const policy = await response.json();
    expect(policy).toMatchObject({ policyVersion: POLICY_VERSION, unknownRating: null, criticalFloors: { routineFit: 3, demonstrationStorytelling: 3 }, retailCtaRequiredForContentSourcing: false, verifiedSalesFromPublicEngagement: false });
    expect(policy.routineFit).toHaveLength(6);
    expect(policy.demonstrationStorytelling).toHaveLength(6);
  });

  it.each(routes)("persists the approved %s score and activation decision, and supplies the typed frontend view", async (route) => {
    const packet = completePacket(route);
    const saved = await put(packet);
    expect(saved.status).toBe(200);
    const a = creatorAssessmentSchema.parse(saved.body.assessment);
    const binding = bindingFor(route);
    expect(a).toMatchObject({ schemaVersion: AGENT_SCHEMA_VERSION, agentVersion: AGENT_VERSION, policyVersion: POLICY_VERSION,
      modelId: approved[route].modelId, state: "activationReady", contentQualification: "pass",
      config: { status: "bound", version: "2026-11-04.launch-v1", hash: binding.hash, baselineHash: binding.baselineHash, numericHash: binding.numericHash },
      packet: { qualifyingPosts: 3, publicationDates: 2, meaningfulUsePosts: 2 }, score: { total: approved[route].score, unknownCount: 0, band: "priorityReview" } });
    expect(a.configuration!.criteria.map((criterion) => criterion.weight)).toEqual(approved[route].weights);
    console.info("Approved baseline HTTP receipt:", JSON.stringify({ route, runId: saved.body.runId, revision: saved.body.revision, policyVersion: a.policyVersion, modelId: a.modelId, configVersion: a.config.version, configHash: a.config.hash, baselineHash: a.config.baselineHash, numericHash: a.config.numericHash, total: a.score!.total, state: a.state }));
    expect(a.gates.every((gate) => gate.state === "pass")).toBe(true);
    const unchangedMath = scoreOf(a.configuration!.criteria);
    expect(unchangedMath.total).toBe(approved[route].score);
    expect(readFileSync(databasePath).subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");

    const readerFetch: typeof fetch = (input, init) => { const headers = new Headers(init?.headers); headers.set("authorization", `Bearer ${SYNTHETIC_READ_TOKEN}`); return fetch(input, { ...init, headers }); };
    const adapter = createLiveAdapter("sandbox", { transport: createHttpTransport(origin, { fetch: readerFetch }), writeAttempts: 1 });
    const view = await adapter.readView({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "evidenceRecord", requestId: "approved-synthetic-read",
      requestedScope: SYNTHETIC_SCOPE, filters: { creatorId: packet.creatorId, evidenceId: packet.posts[0]!.postId }, period: null, sort: [], page: { cursor: null, limit: 50 } });
    const data = evidenceViewSchemas.evidenceRecord!.parse(view.data);
    expect(data.qualification).toEqual(a);
    expect(data.agentEvidence.criterionEvidenceRefs).toEqual(packet.criterionEvidenceRefs);
    expect(view.capabilities).toEqual([
      { actionKind: "saveEvidenceDraft", state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] },
      { actionKind: "recordDisagreement", state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] },
      { actionKind: "markWatched", state: "held", reasonCodes: ["J20_SOURCE_REVIEW_REQUIRED"] },
    ]);
    await stop(); await start();
    expect(await get(packet.creatorId)).toEqual({ ...saved.body, stale: false });
    expect(app!.store.history(packet.creatorId)).toEqual([saved.body]);
  });

  it("holds verified critical-floor failures even when the approved weighted total exceeds80", async () => {
    for (const route of routes) for (const critical of ["routine", "demo"] as const) {
      const packet = completePacket(route);
      packet.creatorId += `-${critical}`;
      packet.ratings = { routine: 5, demo: 5, [critical]: 2 };
      packet.criterionRatings = Object.fromEntries(noncritical.map((id) => [id, 5]));
      const saved = await put(packet);
      expect(saved.status).toBe(200);
      expect(saved.body.assessment.score!.total).toBeGreaterThanOrEqual(80);
      expect(saved.body.assessment.state).toBe("hold");
      expect(saved.body.assessment.contentQualification).toBe("hold");
      expect(saved.body.assessment.gates).toContainEqual(expect.objectContaining({ id: critical === "routine" ? "ROUTINE_FLOOR" : "DEMO_FLOOR", state: "fail" }));
    }
  });

  it("allows a prospective invitation below80 but activates only at the approved80 boundary", async () => {
    for (const route of routes) {
      const below = completePacket(route);
      below.creatorId += "-score79";
      if (route === "website") below.criterionRatings.verifiedCommerce = 2;
      else below.criterionRatings.reliability = 3;
      const review = await put(below);
      expect(review.status).toBe(200);
      expect(review.body.assessment.score!.total).toBe(79);
      expect(review.body.assessment.score!.band).toBe("manualReview");
      expect(review.body.assessment.state).toBe("prospectiveInviteEligible");

      const boundary = completePacket(route);
      boundary.creatorId += "-score80";
      boundary.ratings = { routine: 4, demo: 4 };
      boundary.criterionRatings = Object.fromEntries(noncritical.map((id) => [id, 4]));
      const activate = await put(boundary);
      expect(activate.status).toBe(200);
      expect(activate.body.assessment.score!.total).toBe(80);
      expect(activate.body.assessment.score!.band).toBe("priorityReview");
      expect(activate.body.assessment.state).toBe("activationReady");
    }
  });

  it("does not let zero minimum coverage waive the mandatory creator packet", async () => {
    for (const route of routes) {
      const packet = completePacket(route);
      packet.creatorId += "-incomplete-packet";
      packet.posts = packet.posts.slice(0, 1);
      packet.ratings = { routine: 5, demo: 5 };
      packet.criterionRatings = Object.fromEntries(noncritical.map((id) => [id, 5]));
      const saved = await put(packet);
      expect(saved.status).toBe(200);
      expect(saved.body.assessment.score!.total).toBe(100);
      expect(saved.body.assessment.packet.qualifyingPosts).toBe(1);
      expect(saved.body.assessment.contentQualification).toBe("reviewNeeded");
      expect(saved.body.assessment.state).not.toBe("activationReady");
    }
  });

  it("keeps unsupported noncritical ratings unknown and requires a new evidence revision when proof is added", async () => {
    for (const route of routes) {
      const packet = completePacket(route);
      delete packet.criterionEvidenceRefs.verifiedCommerce;
      const missing = await put(packet);
      expect(missing.status).toBe(200);
      expect(missing.body.assessment.score).toMatchObject({ total: null, unknownCount: 1, band: null });
      expect(missing.body.assessment.state).not.toBe("activationReady");
      expect(missing.body.assessment.configuration!.criteria.find((criterion) => criterion.id === "verifiedCommerce")!.rating).toBeNull();
      packet.criterionEvidenceRefs.verifiedCommerce = ["synthetic:criterion-proof:verifiedCommerce"];
      expect((await put(packet, 1)).body.code).toBe("EVIDENCE_REVISION_REUSED");
      packet.evidenceRevision = "synthetic-approved-proof-v2";
      const completed = await put(packet, 1);
      expect(completed.status).toBe(200);
      expect(completed.body.assessment.score!.total).toBe(approved[route].score);
      expect(completed.body.assessment.state).toBe("activationReady");
      expect(app!.store.history(packet.creatorId)).toEqual([missing.body, completed.body]);
    }
  });
});
