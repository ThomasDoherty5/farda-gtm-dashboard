// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assessCreator, likeGate } from "../policy.ts";
import { ratingPolicy } from "../ratingPolicy.ts";
import { loadApprovedBindings } from "../config.ts";
import { BASELINE_VERSION_REF, CRITERIA, EVIDENCE_POLICY_PATHS, baselineEvidencePolicy, classifyPath } from "./contract.ts";
import { evaluateEvidencePolicy, likeGateAt } from "./compare.ts";
import { approvedNumericBindings } from "./repository.ts";
import { syntheticCandidatePackets } from "./fixtures.testkit.ts";

const CONTENT_GATES = ["QUALIFYING_POSTS", "PUBLICATION_DATES", "MEANINGFUL_USE", "ROUTINE_FLOOR", "DEMO_FLOOR"];

describe("named evidence-policy baseline binds the live launch policy", () => {
  it("reproduces policy.ts content gates exactly at the baseline for every synthetic boundary packet", () => {
    const baseline = baselineEvidencePolicy();
    for (const [name, packet] of Object.entries(syntheticCandidatePackets())) {
      const live = assessCreator(packet, null);
      const evaluated = evaluateEvidencePolicy(packet, baseline);
      expect(evaluated.gates, name).toEqual(live.gates.filter(gate => CONTENT_GATES.includes(gate.id)));
      expect(evaluated.recommendation, name).toBe(live.contentQualification);
      for (const post of packet.posts) expect(likeGateAt(post, baseline), name).toBe(likeGate(post));
    }
  });

  it("covers every recommendation the boundary set is meant to exercise", () => {
    const outcomes = new Set(Object.values(syntheticCandidatePackets()).map(packet => evaluateEvidencePolicy(packet, baselineEvidencePolicy()).recommendation));
    expect(outcomes).toEqual(new Set(["pass", "hold", "reviewNeeded"]));
  });

  it("reads floors and every rubric anchor from the approved rating policy", () => {
    const baseline = baselineEvidencePolicy();
    expect(BASELINE_VERSION_REF).toBe("evidence-policy.2026-11-04.launch-v1");
    expect(baseline.criticalFloors).toEqual(ratingPolicy.criticalFloors);
    for (const id of CRITERIA) expect(baseline.anchors[id]).toEqual([...ratingPolicy[id]]);
    expect(baseline).toMatchObject({ likeGate: { minNativeLikesExclusive: 200 }, packet: { minIndependentPosts: 3, minPublicationDates: 2, minMeaningfulUsePosts: 2 } });
  });

  it("carries the approved v3 numeric identities unchanged and exposes no numeric field to proposals", () => {
    const approved = loadApprovedBindings();
    expect(approvedNumericBindings()).toEqual(approved.map(binding => ({ modelId: binding.current.modelId, version: binding.current.version, hash: binding.hash, numericHash: binding.numericHash })));
    expect(approvedNumericBindings().map(binding => binding.hash)).toEqual([
      "048db012fb33cf8aa5f5ec8e02e31ab56d08e32fb7e4259cf2c329dea71697e6", "27749895dd5e81032ad1bb569c7f91cc08b24c6e9079c906c8160ce8e8eff808"]);
    expect(JSON.stringify(baselineEvidencePolicy())).not.toMatch(/weight|band|arithmetic|decisionRules|modelId/);
    expect(EVIDENCE_POLICY_PATHS.every(path => classifyPath(path) === "evidencePolicy")).toBe(true);
    expect(EVIDENCE_POLICY_PATHS).toHaveLength(6 + CRITERIA.length * 6);
  });
});
