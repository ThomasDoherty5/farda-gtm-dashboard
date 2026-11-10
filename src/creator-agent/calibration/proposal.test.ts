// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { approvalTestScope } from "../approvals/fixtures.testkit.ts";
import { baselineEvidencePolicy, classifyPath, type PolicyChange } from "./contract.ts";
import { applyChangeSet } from "./proposal.ts";
import { compareConfigs } from "./compare.ts";
import { CalibrationRepository } from "./repository.ts";
import { packetChangeInput, proposed, syntheticBasis, syntheticCandidateSet } from "./fixtures.testkit.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const NOW = Date.parse("2026-11-06T20:00:00Z");
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
function repository(now = () => NOW) {
  const db = new DatabaseSync(":memory:"); closers.push(() => db.close());
  db.exec("CREATE TABLE agent_scope(id INTEGER PRIMARY KEY, workspace_id TEXT, account_id TEXT)");
  db.prepare("INSERT INTO agent_scope VALUES(1,?,?)").run(approvalTestScope.workspaceId, approvalTestScope.accountId);
  return { db, repo: new CalibrationRepository(db, { scope: approvalTestScope, now }) };
}
const actor = { principalRef: "synthetic:requester" };
const count = (db: InstanceType<typeof DatabaseSync>) => Number(db.prepare("SELECT COUNT(*) AS n FROM calibration_proposals").get()!.n);

describe("versioned change set against a named immutable baseline", () => {
  it("records each changed field with before, after and rationale, plus the evidence basis and its limits", () => {
    const { repo } = repository();
    const input = packetChangeInput(NOW, { changes: [
      { path: "packet.minIndependentPosts", before: 3, after: 2, rationale: "Fictional packet agreement." },
      { path: "anchors.routineFit.3", before: baselineEvidencePolicy().anchors.routineFit[3], after: "Practical adult routine with a visible, plausible supported product role.", rationale: "Fictional anchor clarity." },
    ] });
    const proposal = proposed(repo.createProposal(input, actor, "propose-1"));
    expect(proposal).toMatchObject({ mode: "evidencePolicy", kind: "change", baseVersionRef: "evidence-policy.2026-11-04.launch-v1", proposedBy: "synthetic:requester",
      changes: input.changes, evidenceBasis: syntheticBasis(), sufficiency: { status: "sufficient", observed: { reviewedPackets: 24, distinctCreators: 12 } } });
    expect(proposal.evidenceBasis.limits).toEqual(["Fictional review counts.", "Packet gates only; no outcome or score evidence."]);
    expect(proposal.proposedConfig.packet.minIndependentPosts).toBe(2);
    expect(proposal.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repo.readProposal(proposal.proposalRef)!.state).toBe("open");
    expect(repo.head().config).toEqual(baselineEvidencePolicy());
    expect(repo.history()).toHaveLength(1);
  });

  it("refuses a stale before value, duplicates, no-ops, unknown fields and an invalid resulting config", () => {
    const base = baselineEvidencePolicy();
    const refused = (changes: PolicyChange[]) => applyChangeSet(base, changes.map(c => ({ ...c, rationale: "x" })));
    expect(refused([{ path: "packet.minIndependentPosts", before: 4, after: 2, rationale: "x" }])).toMatchObject({ status: "refused", reasonCodes: ["STALE_BEFORE_VALUE"] });
    expect(refused([{ path: "packet.minIndependentPosts", before: 3, after: 3, rationale: "x" }])).toMatchObject({ reasonCodes: ["NO_OP_CHANGE"] });
    expect(refused([{ path: "packet.minIndependentPosts", before: 3, after: 2, rationale: "x" }, { path: "packet.minIndependentPosts", before: 3, after: 4, rationale: "x" }]))
      .toMatchObject({ reasonCodes: ["DUPLICATE_CHANGE"] });
    expect(refused([{ path: "likeGate.requireExactCount", before: true, after: false, rationale: "x" }])).toMatchObject({ reasonCodes: ["UNKNOWN_POLICY_FIELD"] });
    expect(refused([{ path: "packet.minIndependentPosts", before: 3, after: 1, rationale: "x" }])).toMatchObject({ reasonCodes: ["INVALID_PROPOSED_CONFIG"] });
    expect(refused([{ path: "criticalFloors.routineFit", before: 3, after: 6, rationale: "x" }])).toMatchObject({ reasonCodes: ["INVALID_PROPOSED_CONFIG"] });
  });

  it("is idempotent per key and refuses a reused key with a different body", () => {
    const { repo, db } = repository();
    const first = repo.createProposal(packetChangeInput(NOW), actor, "same-key");
    expect(repo.createProposal(packetChangeInput(NOW), actor, "same-key")).toEqual(first);
    expect(() => repo.createProposal(packetChangeInput(NOW, { rationale: "A different fictional rationale." }), actor, "same-key")).toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(count(db)).toBe(1);
  });

  it("rejects an unknown base, an out-of-range expiry and a database bound to another scope", () => {
    const { repo, db } = repository();
    expect(() => repo.createProposal(packetChangeInput(NOW, { baseVersionRef: "evidence-policy.rev-9" }), actor, "k1")).toThrow("BASE_VERSION_NOT_FOUND");
    expect(() => repo.createProposal(packetChangeInput(NOW, { expiresAt: new Date(NOW).toISOString() }), actor, "k2")).toThrow("EXPIRY_INVALID");
    expect(() => repo.createProposal(packetChangeInput(NOW, { expiresAt: new Date(NOW + 40 * 86_400_000).toISOString() }), actor, "k3")).toThrow("EXPIRY_INVALID");
    expect(() => new CalibrationRepository(db, { scope: { workspaceId: "synthetic-other", accountId: "synthetic-account" }, now: () => NOW })).toThrow("DATABASE_SCOPE_MISMATCH");
  });
});

describe("numeric model changes are separate and refused in this mode", () => {
  it.each([
    ["criteria.0.weight", 25, 30], ["weights.routineFit", 25, 30], ["bands.1.min", 65, 60], ["arithmetic", "weight*rating/5;round-complete-total;no-rescaling", "x"],
    ["decisionRules.activationMinScore", 80, 75], ["modelId", "WEBSITE-AFFILIATE-v3", "WEBSITE-AFFILIATE-v4"], ["numericBindings.0.numericHash", "a", "b"],
  ])("refuses %s and stores nothing", (path, before, after) => {
    const { repo, db } = repository();
    expect(classifyPath(path)).toBe("numericModel");
    const outcome = repo.createProposal(packetChangeInput(NOW, { changes: [{ path, before, after, rationale: "Fictional numeric attempt." }] }), actor, "numeric");
    expect(outcome).toMatchObject({ status: "refused", reasonCodes: ["NUMERIC_MODEL_CHANGE_REFUSED"] });
    expect(count(db)).toBe(0);
  });

  it("refuses a mixed change set whole instead of applying its evidence-policy part", () => {
    const { repo, db } = repository();
    const outcome = repo.createProposal(packetChangeInput(NOW, { changes: [
      { path: "packet.minIndependentPosts", before: 3, after: 2, rationale: "Evidence-policy part." },
      { path: "criteria.0.weight", before: 25, after: 30, rationale: "Numeric part." },
    ] }), actor, "mixed");
    expect(outcome).toMatchObject({ status: "refused", reasonCodes: ["NUMERIC_MODEL_CHANGE_REFUSED"] });
    expect(count(db)).toBe(0);
    expect(repo.head().config).toEqual(baselineEvidencePolicy());
  });

  it("returns a structured block for any numerical calibration request", () => {
    const { repo, db } = repository();
    const blocked = { status: "blocked", mode: "numericCalibration", reasonCodes: ["NUMERIC_CALIBRATION_NOT_AVAILABLE", "MATURE_RETAINED_SALES_COHORTS_UNAVAILABLE"], numericModel: "unchanged" };
    expect(repo.requestNumericCalibration()).toMatchObject(blocked);
    expect(repo.createProposal({ mode: "numericCalibration", changes: [{ path: "criteria.0.weight", before: 25, after: 30 }] }, actor, "num")).toMatchObject(blocked);
    expect(count(db)).toBe(0);
  });
});

describe("insufficient evidence never yields a confident proposal", () => {
  it("blocks unknown counts without treating them as zero, and blocks a known zero separately", () => {
    const { repo, db } = repository();
    const unknown = repo.createProposal(packetChangeInput(NOW, { evidenceBasis: syntheticBasis({ reviewedPackets: { state: "unknown", reason: "Synthetic export incomplete." } }) }), actor, "unknown");
    expect(unknown).toMatchObject({ status: "blocked", mode: "evidencePolicy", reasonCodes: ["EVIDENCE_PACKETS_UNKNOWN"] });
    const zero = repo.createProposal(packetChangeInput(NOW, { evidenceBasis: syntheticBasis({ distinctCreators: { state: "known", value: 0 } }) }), actor, "zero");
    expect(zero).toMatchObject({ status: "blocked", reasonCodes: ["EVIDENCE_BASIS_EMPTY"] });
    const window = repo.createProposal(packetChangeInput(NOW, { evidenceBasis: syntheticBasis({ window: { from: "2026-11-01T00:00:00Z", to: "2026-10-01T00:00:00Z" } }) }), actor, "window");
    expect(window).toMatchObject({ status: "blocked", reasonCodes: ["EVIDENCE_WINDOW_INVALID"] });
    expect(count(db)).toBe(0);
  });

  it("returns a provisional, non-promotable report below the minimums", () => {
    const { repo, db } = repository();
    const outcome = repo.createProposal(packetChangeInput(NOW, { evidenceBasis: syntheticBasis({ reviewedPackets: { state: "known", value: 7 }, distinctCreators: { state: "known", value: 4 } }) }), actor, "thin");
    expect(outcome).toMatchObject({ status: "provisional", promotable: false, reasonCodes: ["EVIDENCE_PACKETS_BELOW_MINIMUM", "EVIDENCE_CREATORS_BELOW_MINIMUM"],
      observed: { reviewedPackets: 7, distinctCreators: 4 }, minimums: { reviewedPackets: 20, distinctCreators: 10 } });
    expect(count(db)).toBe(0);
  });
});

describe("no demographic, diagnosis or sales inference", () => {
  it.each([
    ["rationale", "Creators with a likely diagnosis performed differently.", "DIAGNOSIS_INFERENCE_REFUSED"],
    ["rationale", "Lower the gate for creators of an apparent age under 25.", "DEMOGRAPHIC_INFERENCE_REFUSED"],
    ["rationale", "This should raise expected sales across the cohort.", "SALES_INFERENCE_REFUSED"],
    ["anchor", "Routine fit judged from the creator's gender and ethnicity.", "DEMOGRAPHIC_INFERENCE_REFUSED"],
  ])("refuses %s text that introduces an inference (%s)", (where, textValue, code) => {
    const { repo, db } = repository();
    const input = where === "rationale" ? packetChangeInput(NOW, { rationale: textValue })
      : packetChangeInput(NOW, { changes: [{ path: "anchors.routineFit.4", before: baselineEvidencePolicy().anchors.routineFit[4], after: textValue, rationale: "Fictional anchor edit." }] });
    expect(repo.createProposal(input, actor, `inference-${code}`)).toMatchObject({ status: "refused", reasonCodes: [code] });
    expect(count(db)).toBe(0);
  });

  it("has no schema field for audience, health or sales inputs, and accepts only synthetic candidates", () => {
    const { repo } = repository();
    const withField = packetChangeInput(NOW, { evidenceBasis: { ...syntheticBasis(), audienceDemographics: { ageGroups: [] } } as never });
    expect(() => repo.createProposal(withField, actor, "field")).toThrow("VALIDATION_FAILED");
    const withSales = packetChangeInput(NOW, { evidenceBasis: { ...syntheticBasis(), retainedSalesCohorts: { state: "available", reason: "x" } } as never });
    expect(() => repo.createProposal(withSales, actor, "sales")).toThrow("VALIDATION_FAILED");
    const real = syntheticCandidateSet(["baseline-pass"]);
    (real.candidates[0]!.packet as { creatorId: string }).creatorId = "creator-123";
    expect(() => repo.createProposal(packetChangeInput(NOW, { candidateSet: real }), actor, "real")).toThrow("CANDIDATE_NOT_SYNTHETIC");
    expect(() => repo.createProposal(packetChangeInput(NOW, { candidateSet: { ...syntheticCandidateSet(), provenance: "production" } as never }), actor, "prov")).toThrow("VALIDATION_FAILED");
  });

  it("keeps baseline audience anchors that name authorized aggregate dimensions; only author-supplied text is screened", () => {
    expect(baselineEvidencePolicy().anchors.audienceAlignment[3]).toContain("age");
    const { repo } = repository();
    expect(repo.createProposal(packetChangeInput(NOW), actor, "clean").status).toBe("proposed");
  });
});

describe("comparison on an explicitly limited, labeled synthetic candidate set", () => {
  it("shows which recommendations change and which config fields drove each change", () => {
    const base = baselineEvidencePolicy(), changes = [{ path: "packet.minIndependentPosts", before: 3, after: 2, rationale: "x" }];
    const next = applyChangeSet(base, changes);
    if (next.status !== "ok") throw new Error("expected ok");
    const report = compareConfigs(base, next.config, changes, syntheticCandidateSet());
    expect(report.candidateSet).toMatchObject({ provenance: "synthetic", limit: 6, candidateCount: 6, label: "Synthetic boundary candidates for evidence-policy comparison" });
    expect(report.scope).toMatch(/^Synthetic, explicitly limited candidate set/);
    expect(report.numericScoring).toBe("unchanged-not-evaluated");
    const byRef = Object.fromEntries(report.results.map(result => [result.candidateRef, result]));
    expect(byRef["synthetic:candidate:two-posts"]).toMatchObject({ prior: "reviewNeeded", proposed: "pass", changed: true,
      gateChanges: [{ id: "QUALIFYING_POSTS", before: { state: "unknown", reason: "2/3 independent relevant complete posts with exact native likes >200" },
        after: { state: "pass", reason: "2/2 independent relevant complete posts with exact native likes >200" }, drivenBy: ["packet.minIndependentPosts"] }] });
    expect(byRef["synthetic:candidate:likes-at-200"]).toMatchObject({ prior: "reviewNeeded", proposed: "pass", changed: true });
    for (const ref of ["baseline-pass", "routine-below-floor", "single-date", "unknown-likes"]) expect(byRef[`synthetic:candidate:${ref}`]!.changed, ref).toBe(false);
    expect(byRef["synthetic:candidate:baseline-pass"]!.gateChanges.map(change => change.id)).toEqual(["QUALIFYING_POSTS"]);
    expect(report.summary).toEqual({ changed: 2, unchanged: 4, transitions: { "reviewNeeded->pass": 2 } });
    expect(JSON.stringify(report)).not.toMatch(/"(age|gender|diagnosis|sales|revenue|audience)"/i);
  });

  it("explains a like-gate change on every gate it moves and flags anchor edits for human re-review", () => {
    const base = baselineEvidencePolicy();
    const changes = [{ path: "likeGate.minNativeLikesExclusive", before: 200, after: 199, rationale: "x" },
      { path: "anchors.demonstrationStorytelling.2", before: base.anchors.demonstrationStorytelling[2], after: "Features with little on-brief action.", rationale: "x" }];
    const next = applyChangeSet(base, changes);
    if (next.status !== "ok") throw new Error("expected ok");
    const report = compareConfigs(base, next.config, changes, syntheticCandidateSet(["likes-at-200"]));
    expect(report.results[0]).toMatchObject({ prior: "reviewNeeded", proposed: "pass", changed: true });
    expect(report.results[0]!.gateChanges.find(change => change.id === "QUALIFYING_POSTS")!.drivenBy).toEqual(["likeGate.minNativeLikesExclusive"]);
    expect(report.anchorChanges).toEqual([{ path: "anchors.demonstrationStorytelling.2", reviewImpact: "humanReReviewRequired" }]);
  });

  it("refuses a candidate set over its declared limit or over the hard cap", () => {
    const base = baselineEvidencePolicy();
    expect(() => compareConfigs(base, base, [], { ...syntheticCandidateSet(), limit: 2 })).toThrow("CANDIDATE_SET_INVALID");
    const big = syntheticCandidateSet(["baseline-pass"]);
    big.candidates = Array.from({ length: 26 }, (_, i) => ({ ...big.candidates[0]!, candidateRef: `synthetic:candidate:${i}` }));
    big.limit = 25;
    expect(() => compareConfigs(base, base, [], big)).toThrow("CANDIDATE_SET_INVALID");
  });

  it("stores the comparison inside the proposal so the approver reviews the same rows", () => {
    const { repo } = repository();
    const proposal = proposed(repo.createProposal(packetChangeInput(NOW), actor, "with-compare"));
    expect(proposal.comparison.summary).toEqual({ changed: 2, unchanged: 4, transitions: { "reviewNeeded->pass": 2 } });
    expect(proposal.comparison.candidateSet.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
