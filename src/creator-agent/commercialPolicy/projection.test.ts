// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { offerPolicyFixture } from "../offers/policyFixture.testkit.ts";
import type { AssessmentBasis } from "../offers/contract.ts";
import { rewardPolicyFixture, syntheticCommercialScope as scope } from "./fixtures.testkit.ts";
import { createCommercialProjection, type CommercialProjectionContext } from "./projection.ts";
import { commercialEligibilityViewSchema } from "./views.ts";

const fixtures: ReturnType<typeof offerPolicyFixture>[] = [];
const secret = "synthetic-commercial-projection-secret-not-a-credential";
function setup() {
  const h = offerPolicyFixture(); fixtures.push(h);
  const projection = createCommercialProjection({ offers: h.repo, db: h.store.database, scope, secret, now: h.now });
  const context = (offerId = "synthetic-offer", offerVersion = "v1"): CommercialProjectionContext => ({ creatorId: h.terms.creatorId, offerId, offerVersion, phase: "invitation" });
  return { ...h, projection, context };
}
afterEach(() => { for (const h of fixtures.splice(0)) h.store.close(); });

describe("one exact source-backed commercial projection", () => {
  it("requires an explicit selection even when the creator has an eligible offer", () => {
    const h = setup(); h.save();
    const read = vi.spyOn(h.repo, "readOffer");
    const result = h.projection.project({ creatorId: h.terms.creatorId, phase: "invitation" });
    expect(result.data).toMatchObject({ selected: null, state: "unbound", reasonCodes: ["OFFER_SELECTION_REQUIRED"], basisStatus: "notSelected", policyVersion: null });
    expect(read).not.toHaveBeenCalled(); result.assertCurrent();
  });
  it("never guesses the selected version or substitutes a newer offer", () => {
    const h = setup(), old = h.save();
    expect(h.projection.project({ creatorId: h.terms.creatorId, offerId: old.offerId, phase: "invitation" }).data)
      .toMatchObject({ state: "held", reasonCodes: ["OFFER_VERSION_REQUIRED"], selected: { version: null } });
    const original = h.projection.project(h.context());
    const newer = h.repo.saveFromAdapter(old.offerId, old.version, { ...h.terms, counterofferRef: "synthetic-revision" }, "synthetic-revision-key");
    expect(newer.version).toBe("v2");
    expect(() => original.assertCurrent()).toThrow("COMMERCIAL_PROJECTION_CHANGED");
    expect(h.projection.project(h.context()).data).toMatchObject({ state: "held", selected: { version: "v1" }, reasonCodes: ["OFFER_VERSION_MISMATCH"] });
    expect(h.projection.project(h.context("synthetic-absent")).data).toMatchObject({ state: "held", reasonCodes: ["OFFER_NOT_FOUND"] });
  });
  it("denies wrong creator and database scope with the same neutral error", () => {
    const h = setup(); h.save();
    expect(() => h.projection.project({ ...h.context(), creatorId: "synthetic-other-creator" })).toThrow("COMMERCIAL_SCOPE_DENIED");
    expect(() => createCommercialProjection({ offers: h.repo, db: h.store.database, scope: { ...scope, accountId: "synthetic-other-account" }, secret, now: h.now }))
      .toThrow("COMMERCIAL_SCOPE_DENIED");
  });
  it("keeps the selected material in its scoped database and rejects a mismatched repository", () => {
    const h = setup(), other = setup(); other.save();
    const projection = createCommercialProjection({ offers: other.repo, db: h.store.database, scope, secret, now: h.now });
    expect(() => projection.project(h.context())).toThrow("COMMERCIAL_SCOPE_DENIED");
  });
  it("rejects a different account's proof even when its local offer ID and terms are identical", () => {
    const h = setup(); h.save();
    const other = offerPolicyFixture(":memory:", { ...scope, accountId: "synthetic-second-account" }); fixtures.push(other); other.save();
    const projection = createCommercialProjection({ offers: other.repo, db: h.store.database, scope, secret, now: h.now });
    expect(() => projection.project(h.context())).toThrow("COMMERCIAL_SCOPE_DENIED");
  });
  it("has identical eligibility and reason vectors for all six consumers without granting release", () => {
    const h = setup(), record = h.save();
    const context = { ...h.context(), assessment: record.assessment };
    const consumers = ["scorecard", "offer", "workbench", "finite-preview", "approval", "run"];
    const results = consumers.map(() => h.projection.project(context));
    for (const result of results) {
      expect(result.data).toEqual(results[0]!.data); result.assertCurrent();
      expect(result.data).toMatchObject({ state: "eligible", basisStatus: "current", reasonCodes: [], rewardBasis: "notApplicable", rewardVersion: null, confersApproval: false, sourceEffect: "none" });
    }
    h.suppress();
    const held = consumers.map(() => h.projection.project(context).data);
    for (const result of held) expect(result).toEqual(held[0]);
    expect(held[0]?.reasonCodes).toContain("CREATOR_SUPPRESSED");
  });
  it("distinguishes an explicitly absent saved assessment from the repository's exact current basis", () => {
    const h = setup(), record = h.save();
    expect(h.projection.project(h.context()).data.state).toBe("eligible");
    expect(h.projection.project({ ...h.context(), assessment: record.assessment }).data).toEqual(h.projection.project(h.context()).data);
    expect(h.projection.project({ ...h.context(), assessment: null }).data)
      .toMatchObject({ state: "held", basisStatus: "missing", reasonCodes: ["ASSESSMENT_BASIS_REQUIRED"] });
  });
  it.each(["runId", "route", "modelId", "configHash", "termsRevision", "policyVersion", "state"] as const)("holds a saved assessment whose %s differs, without changing the stored score", field => {
    const h = setup(), record = h.save(), before = structuredClone(record.assessment);
    const assessment: AssessmentBasis = { ...record.assessment! };
    Object.assign(assessment, { [field]: field === "route" ? "tiktok-shop" : field === "state" ? "hold" : "synthetic-different-basis" });
    expect(h.projection.project({ ...h.context(), assessment }).data).toMatchObject({ state: "held", basisStatus: "mismatch", reasonCodes: ["ASSESSMENT_BASIS_MISMATCH"] });
    expect(h.repo.readOffer(record.offerId)?.assessment).toEqual(before);
  });
  it("keeps stale saved assessments separate from a current commercial proof", () => {
    const h = setup(), record = h.save();
    expect(h.projection.project({ ...h.context(), assessment: { ...record.assessment!, stale: true } }).data)
      .toMatchObject({ state: "held", basisStatus: "stale", reasonCodes: ["ASSESSMENT_BASIS_STALE"] });
  });
  it.each(["policy", "suppression", "source", "expiry", "fee"] as const)("withholds an earlier eligible result after %s withdrawal", change => {
    const h = setup(), record = h.save(), result = h.projection.project(h.context());
    if (change === "policy") h.source.state.current.state = "revoked";
    if (change === "suppression") h.suppress();
    if (change === "source") h.revoke();
    if (change === "expiry") h.advance(3_600_001);
    if (change === "fee") {
      const fee = h.reply(record); h.repo.observeReply(record.offerId, record.version, fee.sourceRef, "synthetic-fee-request", "synthetic-reviewer");
    }
    expect(() => result.assertCurrent()).toThrow("COMMERCIAL_PROJECTION_CHANGED");
    const held = h.projection.project(h.context()).data;
    expect(held.state).toBe("held"); expect(held.reasonCodes.length).toBeGreaterThan(0);
    expect(held.policyVersion).toBeNull(); expect(held.rewardBasis).toBe("unknown");
  });
  it("accepts renewed leases for identical material but expires the originally issued proof", () => {
    const h = setup(); h.save(); const result = h.projection.project(h.context());
    h.advance(10); h.source.state.current.observedAt = new Date(h.now()).toISOString(); h.source.state.current.validUntil = new Date(h.now() + 3_600_000).toISOString();
    result.assertCurrent();
    expect(h.projection.project(h.context()).data.basisHash).toBe(result.data.basisHash);
    h.advance(3_600_000); expect(() => result.assertCurrent()).toThrow("COMMERCIAL_PROJECTION_CHANGED");
  });
  it("does not return eligible when a real source changes during the resolving source callback", () => {
    const h = setup(); h.save(); const original = h.auth.assertCurrent!;
    let withdrew = false;
    h.auth.assertCurrent = (snapshot, now) => { original(snapshot, now); if (!withdrew) { withdrew = true; h.suppress(); } };
    expect(() => h.projection.project(h.context())).toThrow("COMMERCIAL_PROJECTION_CHANGED");
    expect(withdrew).toBe(true);
    expect(h.projection.project(h.context()).data.reasonCodes).toContain("CREATOR_SUPPRESSED");
  });
  it("inherits native reply ordering and fences a withdrawn exact fee resolution", () => {
    const h = setup(), record = h.save(), fee = h.reply(record); h.advance(1);
    const accepted = h.reply(record, { sourceRef: "synthetic-later-acceptance", eventRef: "synthetic-acceptance-event", classification: "commission-only-accepted", acceptanceRef: "synthetic-terms-acceptance", resolvesSourceRefs: [fee.sourceRef] });
    for (const reply of [accepted, fee]) h.repo.observeReply(record.offerId, record.version, reply.sourceRef, reply.sourceRef, "synthetic-reviewer");
    const result = h.projection.project(h.context()); expect(result.data.state).toBe("eligible");
    const history = h.store.database.prepare("SELECT body FROM offer_reply_observations ORDER BY revision").all();
    h.replies.delete(accepted.sourceRef);
    expect(() => result.assertCurrent()).toThrow("COMMERCIAL_PROJECTION_CHANGED");
    expect(h.projection.project(h.context()).data.reasonCodes).toContain("CREATOR_FEE_REQUEST");
    expect(h.store.database.prepare("SELECT body FROM offer_reply_observations ORDER BY revision").all()).toEqual(history);
  });
  it("keeps accepted decision history immutable when current activation authority expires", () => {
    const h = setup(), record = h.save();
    expect(h.projection.project({ ...h.context(), phase: "activation" }).data.reasonCodes).toContain("SOURCE_ACCEPTANCE_REQUIRED");
    for (const kind of ["owner-approved", "creator-accepted"] as const) {
      h.decisions.set(kind, { scope: { workspaceId: scope.workspaceId, accountId: scope.accountId }, creatorId: h.terms.creatorId, provider: h.terms.provider, programRef: h.terms.programRef, sourceRef: kind,
        offerId: record.offerId, version: record.version, providerAccountRef: "synthetic-provider-account", manifestHash: record.manifestHash, decision: kind, occurredAt: new Date(h.now()).toISOString(), validUntil: new Date(h.now() + 10).toISOString() });
      h.repo.decision(record.offerId, { version: record.version, sourceRef: kind, kind }, kind);
    }
    const historical = h.store.database.prepare("SELECT body FROM offer_decisions ORDER BY kind").all();
    const result = h.projection.project({ ...h.context(), phase: "activation" }); expect(result.data.state).toBe("eligible");
    h.advance(11); expect(() => result.assertCurrent()).toThrow("COMMERCIAL_PROJECTION_CHANGED");
    expect(h.projection.project({ ...h.context(), phase: "activation" }).data.reasonCodes).toContain("SOURCE_ACCEPTANCE_REQUIRED");
    expect(h.repo.readOffer(record.offerId)?.state).toBe("accepted");
    expect(h.store.database.prepare("SELECT body FROM offer_decisions ORDER BY kind").all()).toEqual(historical);
  });
  it("publishes only safe aliases for verified versions and distinguishes a verified reward", () => {
    const h = setup(), reward = rewardPolicyFixture(scope, h.now());
    h.source.state.current.performanceReward = reward; h.terms.rewardVersion = reward.rewardVersion; h.terms.rewardProgrammeRef = reward.programmeRef;
    const record = h.save(), result = h.projection.project(h.context());
    expect(result.data).toMatchObject({ state: "eligible", rewardBasis: "verified", rewardVersion: expect.stringMatching(/^commercial-reward-/) });
    expect(commercialEligibilityViewSchema.safeParse(result.data).success).toBe(true);
    const bytes = JSON.stringify(result.data);
    for (const privateValue of [scope.workspaceId, scope.accountId, record.offerId, h.terms.creatorId, "synthetic-provider-account", "synthetic-inbox", "synthetic-assessment", reward.rewardVersion, reward.sourceRef, "commission-only-v1", "synthetic-model-version"])
      expect(bytes).not.toContain(privateValue);
    expect(commercialEligibilityViewSchema.safeParse({ ...result.data, providerAccountRef: "synthetic-private" }).success).toBe(false);
  });
  it("normalizes unknown source reason text without leaking or weakening the hold", () => {
    const h = setup(); h.save(); const actual = h.repo.resolvePolicyProof("synthetic-offer", "invitation")!;
    vi.spyOn(h.repo, "resolvePolicyProof").mockReturnValue({ ...actual, state: "held", proof: null, reasonCodes: ["CREATOR_FEE_REQUEST", "synthetic-private-source text", "CREATOR_FEE_REQUEST"] });
    const view = h.projection.project(h.context()).data;
    expect(view.reasonCodes).toEqual(["CREATOR_FEE_REQUEST", "COMMERCIAL_SOURCE_HELD"]); expect(view.state).toBe("held");
    expect(JSON.stringify(view)).not.toContain("synthetic-private-source");
  });
  it("clones trusted input and does not let returned DTO mutations rewrite its retained source fence", () => {
    const h = setup(), record = h.save(), input = { ...h.context(), assessment: record.assessment! };
    const result = h.projection.project(input), selected = result.data.selected!.offerRef;
    input.offerId = "synthetic-other-offer"; input.assessment.runId = "synthetic-other-run";
    result.assertCurrent(); expect(result.data.selected?.offerRef).toBe(selected);
    result.data.state = "held"; result.data.basisHash = "0".repeat(64);
    h.suppress(); expect(() => result.assertCurrent()).toThrow("COMMERCIAL_PROJECTION_CHANGED");
  });
});
