// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentStore } from "./store.ts";
import { EvidenceReviewRepository } from "./evidenceReviewStore.ts";
import { createCreatorEvidenceWriter } from "./creatorEvidenceWriter.ts";
import { syntheticBinding, syntheticPacket } from "./testFixtures.ts";

/** Synthetic store, annotations and writer only; the same composition the server builds. */
const scope = { workspaceId: "test-workspace", accountId: "test-account" };
function harness() {
  const store = new AgentStore(":memory:", scope);
  const reviews = new EvidenceReviewRepository(store, scope, (record, superseded = false) => ({ ...record, stale: superseded }));
  const binding = syntheticBinding();
  const writer = createCreatorEvidenceWriter({ store, scope: { ...scope, environment: "sandbox" }, secret: "synthetic-operations-secret",
    modelBinding: () => binding, acceptedTerms: () => null,
    reviewerOverrides: (packet, through) => reviews.reviewerOverrides(packet, through), challengeWatermark: id => reviews.challengeWatermark(id),
    offerCurrent: () => true });
  const challenge = (runId: string, postId: string, key: string) => {
    const view = reviews.read("synthetic-creator", postId, runId)!;
    return reviews.saveFromAdapter(postId, view.data.version, { kind: "override", creatorId: "synthetic-creator", runId,
      basisHash: view.data.sourceReview.basisHash, targetId: "review", reason: "A synthetic reviewer challenge to this review.", replacement: "Needs another review." },
      key, "agent-reviewer", "reviewerAssessment");
  };
  return { store, reviews, binding, writer, challenge };
}

describe("reviewer challenges are fenced inside the assessment write", () => {
  it("refuses a snapshot when a challenge is recorded after the overrides were read, and records it on retry", async () => {
    const h = harness();
    try {
      const packet = syntheticPacket();
      const first = await h.writer.write({ packet, expectedVersion: 0, configHash: h.binding.hash }, "synthetic-first");
      // The fence runs after the overrides were read and before the append, exactly where a concurrent reviewer would land.
      await expect(h.writer.write({ packet, expectedVersion: 1, configHash: h.binding.hash }, "synthetic-raced",
        { fence: () => { h.challenge(first.runId, packet.posts[0]!.postId, "synthetic-late-challenge"); } })).rejects.toThrow("REVIEWER_CHALLENGE_CHANGED");
      expect(h.store.history(packet.creatorId)).toEqual([first]);
      const retried = await h.writer.write({ packet, expectedVersion: 1, configHash: h.binding.hash }, "synthetic-retry");
      expect(retried.assessment.reviewerOverrides).toHaveLength(1);
      expect(retried.assessment).toMatchObject({ reasonCodes: expect.arrayContaining(["REVIEWER_OVERRIDE_OPEN"]), nextAction: { recommendation: "reviewNeeded" },
        rescore: { triggers: ["reviewerOverride"], priorRevision: 1 } });
    } finally { h.store.close(); }
  });

  it("still replays an earlier receipt unchanged after the head and the challenges moved", async () => {
    const h = harness();
    try {
      const packet = syntheticPacket();
      const first = await h.writer.write({ packet, expectedVersion: 0, configHash: h.binding.hash }, "synthetic-first");
      h.challenge(first.runId, packet.posts[0]!.postId, "synthetic-challenge");
      await h.writer.write({ packet, expectedVersion: 1, configHash: h.binding.hash }, "synthetic-second");
      expect(await h.writer.write({ packet, expectedVersion: 0, configHash: h.binding.hash }, "synthetic-first")).toEqual(first);
    } finally { h.store.close(); }
  });

  it("orders open challenges deterministically, so the recorded basis hash cannot depend on SQLite scan order", async () => {
    const h = harness();
    try {
      const packet = syntheticPacket();
      const first = await h.writer.write({ packet, expectedVersion: 0, configHash: h.binding.hash }, "synthetic-first");
      // Two posts of the same run each get their first annotation: same run revision and same annotation revision.
      // Record them in descending basis order, so insertion order alone cannot produce the expected result.
      const basisOf = (postId: string) => h.reviews.read(packet.creatorId, postId, first.runId)!.data.sourceReview.basisHash;
      const posts = [packet.posts[0]!, packet.posts[2]!].sort((a, b) => basisOf(b.postId).localeCompare(basisOf(a.postId)));
      const receipts = posts.map((post, i) => h.challenge(first.runId, post.postId, `synthetic-tie-${i}`));
      const byBasis = [...receipts].sort((a, b) => a.resource.input.basisHash.localeCompare(b.resource.input.basisHash)).map(r => r.resource.id);
      const overrides = h.reviews.reviewerOverrides(packet, 1);
      expect(overrides.map(o => o.annotationRef)).toEqual(byBasis);
      expect(h.reviews.reviewerOverrides(packet, 1)).toEqual(overrides);
      const a = await h.writer.write({ packet, expectedVersion: 1, configHash: h.binding.hash }, "synthetic-a");
      expect(a.assessment.reviewerOverrides!.map(o => o.annotationRef)).toEqual(byBasis);
    } finally { h.store.close(); }
  });
});
