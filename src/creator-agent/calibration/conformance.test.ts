// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assessCreator, likeGate } from "../policy.ts";
import { ratingPolicy } from "../ratingPolicy.ts";
import { loadApprovedBindings } from "../config.ts";
import { BASELINE_VERSION_REF, CRITERIA, EVIDENCE_POLICY_PATHS, baselineEvidencePolicy, classifyPath } from "./contract.ts";
import { evaluateEvidencePolicy, likeGateAt } from "./compare.ts";
import { approvedNumericBindings } from "./repository.ts";
import { syntheticCandidatePackets } from "./fixtures.testkit.ts";
import { evidencePacketSchema, type EvidencePacket } from "../evidence.ts";
import { syntheticPacket, syntheticPost } from "../testFixtures.ts";

const CONTENT_GATES = ["QUALIFYING_POSTS", "PUBLICATION_DATES", "MEANINGFUL_USE", "ROUTINE_FLOOR", "DEMO_FLOOR"];

/** A packet with `posts` independent posts over `dates` publication dates, the first `use` showing on-brief use. */
function boundaryPacket(o: { posts: number; dates: number; use: number; likes: number; routine?: number; demo?: number }): EvidencePacket {
  const packet = syntheticPacket("website");
  packet.creatorId = "synthetic-calibration-drift";
  packet.posts = Array.from({ length: o.posts }, (_, index) => {
    const post = syntheticPost(index + 1);
    post.publishedAt = `2026-10-${String(Math.min(index + 1, o.dates)).padStart(2, "0")}T12:00:00.000Z`;
    post.nativeLikes = { status: "known", value: o.likes, exact: true, sourceRef: `synthetic:metric:${index + 1}` };
    post.review = { ...post.review, observedActions: index < o.use ? [{ atSec: 4, action: "Uses a fictional case on brief.", meaningfulUse: true }] : [] };
    return post;
  });
  packet.ratings = { routine: o.routine ?? 5, demo: o.demo ?? 5 };
  return evidencePacketSchema.parse(packet);
}
const liveGate = (packet: EvidencePacket, id: string) => assessCreator(packet, null).gates.find(gate => gate.id === id)!.state;

describe("named evidence-policy baseline binds the live launch policy", () => {
  it("fails if a contract literal drifts from where policy.ts actually flips each gate", () => {
    const { likeGate: likes, packet: p, criticalFloors: floors } = baselineEvidencePolicy();
    const full = { posts: p.minIndependentPosts, dates: p.minPublicationDates, use: p.minMeaningfulUsePosts, likes: likes.minNativeLikesExclusive + 1 };
    expect(liveGate(boundaryPacket({ ...full, likes: likes.minNativeLikesExclusive }), "QUALIFYING_POSTS")).toBe("unknown");
    expect(liveGate(boundaryPacket(full), "QUALIFYING_POSTS")).toBe("pass");
    expect(liveGate(boundaryPacket({ ...full, posts: p.minIndependentPosts - 1, dates: Math.min(p.minPublicationDates, p.minIndependentPosts - 1), use: Math.min(p.minMeaningfulUsePosts, p.minIndependentPosts - 1) }), "QUALIFYING_POSTS")).toBe("unknown");
    expect(liveGate(boundaryPacket({ ...full, dates: p.minPublicationDates - 1 }), "PUBLICATION_DATES")).toBe("unknown");
    expect(liveGate(boundaryPacket(full), "PUBLICATION_DATES")).toBe("pass");
    expect(liveGate(boundaryPacket({ ...full, use: p.minMeaningfulUsePosts - 1 }), "MEANINGFUL_USE")).toBe("unknown");
    expect(liveGate(boundaryPacket(full), "MEANINGFUL_USE")).toBe("pass");
    expect(liveGate(boundaryPacket({ ...full, routine: floors.routineFit - 1 }), "ROUTINE_FLOOR")).toBe("fail");
    expect(liveGate(boundaryPacket({ ...full, routine: floors.routineFit }), "ROUTINE_FLOOR")).toBe("pass");
    expect(liveGate(boundaryPacket({ ...full, demo: floors.demonstrationStorytelling - 1 }), "DEMO_FLOOR")).toBe("fail");
    expect(liveGate(boundaryPacket({ ...full, demo: floors.demonstrationStorytelling }), "DEMO_FLOOR")).toBe("pass");
    expect(assessCreator(boundaryPacket(full), null).contentQualification).toBe("pass");
  });

  it("matches policy.ts content gates on the 10-packet synthetic boundary set", () => {
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
