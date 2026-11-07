// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "./server.ts";
import { offerPolicyFixture } from "./offers/policyFixture.testkit.ts";
import { providerMaterial } from "./offers/policy.ts";
import { approvalFixture } from "./approvals/fixtures.testkit.ts";
import { approvalDispatchBinding } from "./approvals/repository.ts";
import { acquisitionTermsOf } from "./commercialPolicy/evaluate.ts";
import { RecruitmentSourceError, type RecruitmentSourceSnapshot, type RecruitmentSource } from "./commercialPolicy/recruitment.ts";
import { digest } from "./config.ts";
import { assessCreator } from "./policy.ts";
import { syntheticBinding, syntheticPacket, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "./testFixtures.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { scorecardsViewSchemas } from "../adapter/viewSchemas/scorecards.ts";
import { recruitmentViewSchemas } from "../adapter/viewSchemas/recruitment.ts";
import { parseScorecardSelection, scorecardPreviewPath } from "./scorecardPreview.ts";
import type { DispatchHandler } from "./jobs/dispatchSchema.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function world(connected = true) {
  const dir = mkdtempSync(join(tmpdir(), "farda-commercial-read-")), path = join(dir, "agent.sqlite");
  const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
  const h = offerPolicyFixture(path, scope), offer = h.save(), a = approvalFixture(), binding = syntheticBinding();
  a.state.now = h.now(); a.policy.observedAt = a.at(); a.policy.validUntil = a.until();
  for (const human of a.humans.values()) { human.observedAt = a.at(); human.validUntil = a.until(); }
  a.humans.set("agent-reviewer", { ...a.humans.get("synthetic:requester")!, principalRef: "agent-reviewer" });
  h.auth.assertCurrent = proof => {
    const actual = app.store.latest(proof.assessment?.creatorId ?? "");
    const expected = actual ? { creatorId: actual.packet.creatorId, runId: actual.runId, route: actual.packet.checkoutRoute, modelId: actual.assessment.modelId,
      configHash: actual.assessment.config.hash, policyVersion: actual.assessment.policyVersion, termsRevision: actual.packet.termsRevision, state: actual.assessment.state, stale: false } : null;
    const provider = h.auth.provider?.(h.terms, scope) as { facts: NonNullable<typeof proof.provider> };
    if (digest(proof.assessment) !== digest(expected) || digest(proof.suppression) !== digest(h.auth.suppression?.(h.terms.creatorId, scope)) ||
      digest(providerMaterial(proof.provider)) !== digest(providerMaterial(provider.facts))) throw new Error("Synthetic backing association changed");
  };
  const d = a.draft; d.expiresAt = a.until(); d.sourceValidUntil = a.until();
  for (const gate of Object.values(d.gates)) if (gate?.state === "satisfied") gate.validUntil = a.until();
  d.providerAccountRef = offer.provider!.providerAccountRef!; d.productVersion = { state: "required", version: h.terms.manifest.productRevision! };
  d.termsVersion = { state: "required", version: offer.version }; d.acquisitionTerms = acquisitionTermsOf(h.terms);
  d.gates.sampleAuthority = structuredClone(d.gates.providerTerms);
  d.items[0]!.targetRef = h.terms.creatorId; d.commercialOffers = [{ itemRef: d.items[0]!.itemRef, offerRef: offer.offerId }];
  const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Synthetic read review never executes this handler." };
  const handler: DispatchHandler = { idempotency: "source-enforced", sourceEffect: "localArtifact", policyVersion: a.policy.version, provider: na,
    resources: () => ({ budget: na, stock: na, quota: na }), budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 1, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async () => { throw new Error("This read integration test must never execute"); }, reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_NOT_EXECUTED" }) };
  let duringRead: (() => void) | null = null, duringAssert: (() => void) | null = null;
  const recruitmentSource: RecruitmentSource = {
    read: async () => { const copy = structuredClone(source); duringRead?.(); return copy; },
    assertCurrent: snapshot => { duringAssert?.(); if (source.permission === "denied") throw new RecruitmentSourceError("SOURCE_SCOPE_DENIED", 403);
      if (digest(snapshot) !== digest(source)) throw new RecruitmentSourceError("RECRUITMENT_SOURCE_CHANGED", 409); },
  };
  const app = createAgentServer({ databasePath: path, workspaceId: scope.workspaceId, accountId: scope.accountId, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    bindings: [binding], operations: { now: h.now }, offerAuthority: h.auth, commercialPolicy: h.source.source, recruitmentSource: connected ? recruitmentSource : undefined,
    actionFoundation: { approvals: a.options, registry: new Map([[d.actionKind, { handlerRef: "synthetic-commercial-read.v1" }]]), handlers: new Map([["synthetic-commercial-read.v1", handler]]) } });
  cleanups.push(async () => { await app.close(); h.store.close(); a.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const packet = { ...syntheticPacket(), termsRevision: offer.manifestHash };
  const saved = app.store.save(packet, assessCreator(packet, binding), 0, "synthetic-commercial-assessment");
  expect(saved.assessment.state).toBe("prospectiveInviteEligible");
  const source: RecruitmentSourceSnapshot = { scope, principalRef: "agent-reader", filters: { networks: "both", route: "queue" }, sourceRef: "synthetic-private-recruitment-source", sourceVersion: "v1",
    observedAt: a.at(), validUntil: a.until(), permission: "permitted", rows: [{ opportunityRef: "synthetic-private-opportunity", creatorId: packet.creatorId, runId: saved.runId,
      offerId: offer.offerId, offerVersion: offer.version, phase: "invitation", network: "instagram", route: "inbound" }], total: 1, complete: true };
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Expected local test server");
  const origin = `http://127.0.0.1:${address.port}`;
  const selection = { creatorId: packet.creatorId, runId: saved.runId, offerId: offer.offerId, offerVersion: offer.version, phase: "invitation" as const };
  async function read(viewKey: string, filters: object, token: string | null = SYNTHETIC_READ_TOKEN, limit = 100) {
    const response = await fetch(origin + "/v1/read", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-commercial-read", requestedScope: SYNTHETIC_SCOPE, viewKey, filters, period: null, sort: [], page: { cursor: null, limit } }) });
    return { status: response.status, body: await response.json() };
  }
  async function approvedRun() {
    const repo = app.actionFoundation.approvals, principal = { principalRef: "agent-reviewer" };
    const preview = await repo.preparePreview(a.command, principal, "synthetic-preview");
    const requested = await repo.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: 1 }, principal, "synthetic-request");
    const event = a.event(requested); const approved = await repo.observeDecision(event.locator, { ingressRef: "synthetic-verified-relay" });
    const manifest = approved.manifest;
    const run = await app.actionFoundation.dispatch.handoff({ handlerRef: "synthetic-commercial-read.v1", payloadRef: d.payloadRef,
      approval: approvalDispatchBinding(manifest, manifest.items[0]!.itemRef) }, { principalRef: principal.principalRef, idempotencyKey: "synthetic-read-run" });
    return { approved, run };
  }
  return { h, a, app, offer, saved, source, read, selection, approvedRun,
    onRead: (fn: () => void) => { duringRead = fn; }, onAssert: (fn: () => void) => { duringAssert = fn; } };
}

describe("actual HTTP commercial projection parity", () => {
  it("returns the same selected commercial result across assessment, offer, recruitment, finite preview, approval and run", async () => {
    const w = await world(), { approved, run } = await w.approvedRun();
    const assessment = await w.read("assessmentRecord", { creatorId: w.selection.creatorId, assessmentId: w.saved.runId, offerId: w.offer.offerId, offerVersion: w.offer.version });
    const offer = await w.read("offerDraft", { offerId: w.offer.offerId, offerVersion: w.offer.version });
    const recruitment = await w.read("recruitmentQueue", {});
    const preview = await w.read("batchDetail", { batchId: "scorecard-preview", selection: [w.selection] });
    const approval = await w.read("approvalDetail", { approvalId: approved.manifest.approvalRef }, SYNTHETIC_REVIEW_TOKEN);
    const nativeRun = await w.read("runDetail", { runId: run.runRef }, SYNTHETIC_REVIEW_TOKEN);
    for (const response of [assessment, offer, recruitment, preview, approval, nativeRun]) expect(response.status, JSON.stringify(response.body)).toBe(200);
    const expected = assessment.body.data.commercialEligibility;
    expect(expected.state).toBe("eligible");
    for (const current of [offer.body.data.commercialEligibility, recruitment.body.data.rows[0].commercialEligibility, preview.body.data.items[0].commercialEligibility,
      approval.body.data.items[0].commercialEligibility, nativeRun.body.data.items[0].commercialEligibility]) expect(current).toEqual(expected);
    expect(scorecardsViewSchemas.offerDraft!.safeParse(offer.body.data).success).toBe(true);
    expect(recruitmentViewSchemas.recruitmentQueue!.safeParse(recruitment.body.data).success).toBe(true);
    expect(JSON.stringify(recruitment.body.data)).not.toContain("synthetic-private");
    expect(w.app.store.findRun(w.selection.creatorId, w.saved.runId)).toEqual(w.saved);
  });
  it("never guesses an offer or version from a saved score, accepted terms or an existing offer", async () => {
    const w = await world();
    expect((await w.read("assessmentRecord", { creatorId: w.selection.creatorId, assessmentId: w.saved.runId })).body.data.commercialEligibility.state).toBe("unbound");
    expect((await w.read("offerDraft", { offerId: w.offer.offerId })).body.data.commercialEligibility.reasonCodes).toEqual(["OFFER_VERSION_REQUIRED"]);
    const old = await w.read("batchDetail", { batchId: "scorecard-preview", selection: [{ creatorId: w.selection.creatorId, runId: w.saved.runId }] });
    expect(old.body.data.items[0].commercialEligibility.reasonCodes).toEqual(["OFFER_SELECTION_REQUIRED"]);
    expect((await w.read("offerDraft", { offerId: w.offer.offerId, offerVersion: "v999" })).body.data.commercialEligibility.reasonCodes).toEqual(["OFFER_VERSION_MISMATCH"]);
    expect((await w.read("assessmentRecord", { creatorId: w.selection.creatorId, assessmentId: w.saved.runId, offerId: w.offer.offerId, offerVersion: w.offer.version, eligible: true })).status).toBe(400);
    expect((await w.read("recruitmentQueue", {}, null)).status).toBe(401);
  });
  it("keeps source absence distinct from an empty or partial source opportunity list", async () => {
    const absent = await world(false); expect((await absent.read("recruitmentQueue", {})).body.code).toBe("INTEGRATION_PENDING");
    const w = await world(); w.source.rows = []; w.source.total = null; w.source.complete = false;
    const partial = await w.read("recruitmentQueue", {}); expect(partial.status).toBe(200); expect(partial.body.dataState).toBe("partial"); expect(partial.body.coverage.expectedCount).toBeNull();
    w.source.total = 0; w.source.complete = true;
    const empty = await w.read("recruitmentQueue", {}); expect(empty.body.dataState).toBe("empty"); expect(empty.body.coverage).toMatchObject({ expectedCount: 0, observedCount: 0, complete: true });
  });
  it.each(["scope", "principal", "filter", "expired", "long-lease", "limit"])("rejects invalid authoritative recruitment %s", async kind => {
    const w = await world();
    if (kind === "scope") w.source.scope.accountId = "synthetic-other-account";
    if (kind === "principal") w.source.principalRef = "agent-reviewer";
    if (kind === "filter") w.source.filters.networks = "tiktok";
    if (kind === "expired") w.source.validUntil = w.source.observedAt;
    if (kind === "long-lease") w.source.validUntil = new Date(w.h.now() + 300001).toISOString();
    if (kind === "limit") { w.source.rows.push({ ...w.source.rows[0]!, opportunityRef: "synthetic-second-opportunity" }); w.source.total = 2; }
    expect((await w.read("recruitmentQueue", {}, SYNTHETIC_READ_TOKEN, 1)).status).toBe(kind === "scope" || kind === "principal" || kind === "filter" ? 403 : kind === "limit" ? 502 : 409);
  });
  it("fences membership or permission withdrawn during the source await and the final composed read", async () => {
    const w = await world(); w.onRead(() => { w.source.rows = []; w.source.total = 0; });
    expect((await w.read("recruitmentQueue", {})).status).toBe(409);
    w.onRead(() => {}); let count = 0; w.onAssert(() => { if (++count === 2) w.source.permission = "denied"; });
    expect((await w.read("recruitmentQueue", {})).status).toBe(403);
  });
  it("withholds an unbound opportunity when its saved assessment is superseded during the final source fence", async () => {
    const w = await world(); w.source.rows[0]!.offerId = null; w.source.rows[0]!.offerVersion = null;
    let checks = 0;
    w.onAssert(() => {
      if (++checks !== 2) return;
      const packet = { ...w.saved.packet, termsRevision: "synthetic-revised-terms" };
      w.app.store.save(packet, assessCreator(packet, syntheticBinding()), w.saved.revision, "synthetic-superseding-assessment");
    });
    const result = await w.read("recruitmentQueue", {});
    expect(result.status).toBe(409); expect(result.body.code).toBe("COMMERCIAL_PROJECTION_CHANGED");
    expect(w.app.store.latest(w.selection.creatorId)!.runId).not.toBe(w.saved.runId);
    expect(w.app.store.findRun(w.selection.creatorId, w.saved.runId)).toEqual(w.saved);
  });
  it("preserves the exact current commercial hold vector in genuine J04 approval and native run reads", async () => {
    const w = await world(), { approved, run } = await w.approvedRun(); const before = w.app.actionFoundation.approvals.readApproval(approved.manifest.approvalRef)!.decisionReceipt;
    w.h.suppress(); const fee = w.h.reply(w.offer); w.h.repo.observeReply(w.offer.offerId, w.offer.version, fee.sourceRef, "synthetic-fee", "synthetic-reader");
    const response = await w.read("approvalDetail", { approvalId: approved.manifest.approvalRef }, SYNTHETIC_REVIEW_TOKEN);
    expect(response.status).toBe(200); expect(response.body.data.current.state).toBe("held");
    const held = response.body.data.items[0].commercialEligibility;
    expect(held.reasonCodes).toEqual(expect.arrayContaining(["CREATOR_SUPPRESSED", "CREATOR_FEE_REQUEST"]));
    expect(response.body.data.current.reasonCodes).toEqual(expect.arrayContaining(held.reasonCodes));
    const r = await w.read("runDetail", { runId: run.runRef }, SYNTHETIC_REVIEW_TOKEN);
    expect(r.body.data.items[0].commercialEligibility).toEqual(held);
    expect(w.app.actionFoundation.approvals.readApproval(approved.manifest.approvalRef)!.decisionReceipt).toEqual(before);
  });
  it("preserves old finite-member URLs and round-trips exact new offer/version/phase associations", () => {
    const legacy = [{ creatorId: "synthetic-creator", runId: "synthetic-run" }];
    const exact = [{ ...legacy[0]!, offerId: "synthetic-offer", offerVersion: "v2", phase: "shipment" as const }];
    for (const members of [legacy, exact]) expect(parseScorecardSelection(new URL(scorecardPreviewPath(members), "https://synthetic.invalid").searchParams)).toEqual(members);
    expect(parseScorecardSelection(new URLSearchParams({ member: JSON.stringify({ ...exact[0], eligible: true }) }))).toBeNull();
  });
});
