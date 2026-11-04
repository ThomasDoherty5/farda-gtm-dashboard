import { SCHEMA_VERSION, type SaveResourceRequest } from "./contract";
import { createDemoEvidence } from "./demoEvidence";
import { AdapterError } from "./errors";
import type { EvidenceDraft } from "@/features/acquisition/evidenceTypes";
import { DEMO_EVIDENCE_PARTIAL_ID, DEMO_MEDIA_URL } from "@/fixtures/evidence";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let seq = 0;
const URL1 = "https://www.instagram.com/reel/NEWREEL0001/";

const save = (ref: string | null, version: string | null, payload: EvidenceDraft, key = `k-${++seq}`): SaveResourceRequest<EvidenceDraft> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "saveResource",
  requestedScope: scope,
  resourceKind: "evidenceDraft",
  resourceRef: ref,
  expectedVersion: version,
  idempotencyKey: key,
  requestId: `r-${seq}`,
  payload,
});
const draft = (over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({ mediaUrl: URL1, checkoutRoute: "website", observations: [], ...over });
const read = (store: ReturnType<typeof createDemoEvidence>, id: string) =>
  store.read({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "evidenceRecord", requestedScope: scope, filters: { creatorId: "c", evidenceId: id }, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "q" });
const errorFrom = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as AdapterError);
const o = (id: string, over = {}) => ({ id, category: "hook" as const, startSec: 0, endSec: 8, text: "Opens on a desk.", recordedAgainst: URL1, ...over });

describe("saving a draft", () => {
  it("persists a new version, and never offers a way to mark it watched (CTRL-154)", async () => {
    const store = createDemoEvidence();
    const result = await store.save(save("demo-evidence-1", "v1", draft({ observations: [o("n1")] })));
    expect(result.resourceVersion).toBe("v2");
    expect(result.record.observations).toHaveLength(1);
    expect(Object.keys(result.record)).not.toContain("watched");
    const reread = read(store, "demo-evidence-1");
    expect(reread.data!.version).toBe("v2");
    expect(reread.capabilities.find((c) => c.actionKind === "markWatched")).toMatchObject({ state: "unverified", reasonCodes: ["PLAYBACK_UNVERIFIED"] });
    expect(reread.data!.assessments.creative.state).toBe("unknown");
  });

  it("saves with no address at all, leaving media unknown", async () => {
    const result = await createDemoEvidence().save(save("demo-evidence-1", "v1", draft({ mediaUrl: null, checkoutRoute: "tiktok-shop" })));
    expect(result.record).toMatchObject({ mediaUrl: null, checkoutRoute: "tiktok-shop", version: "v2" });
  });

  it("returns the same version without a new save when nothing changed", async () => {
    const store = createDemoEvidence();
    const result = await store.save(save("demo-evidence-1", "v1", draft({ mediaUrl: null })));
    expect(result.resourceVersion).toBe("v1");
    expect(result.reasonCodes).toEqual(["NO_CHANGE"]);
  });

  it("rejects a profile URL with a field error, and saves nothing (CTRL-156)", async () => {
    const store = createDemoEvidence();
    const error = await errorFrom(store.save(save("demo-evidence-1", "v1", draft({ mediaUrl: "https://www.instagram.com/demo.creator/" }))));
    expect(error.category).toBe("validation");
    expect(error.body.fieldErrors?.mediaUrl).toMatch(/profile/);
    expect(read(store, "demo-evidence-1").data!.version).toBe("v1");
  });

  it("rejects an observation with a bad interval or empty text", async () => {
    const error = await errorFrom(createDemoEvidence().save(save("demo-evidence-1", "v1", draft({ observations: [o("n1", { startSec: 9, endSec: 3 }), o("n2", { text: " " })] }))));
    expect(Object.keys(error.body.fieldErrors ?? {})).toEqual(expect.arrayContaining(["observations.0.end", "observations.1.text"]));
  });

  it("won't tie a new observation to media other than the draft's", async () => {
    const error = await errorFrom(createDemoEvidence().save(save("demo-evidence-1", "v1", draft({ observations: [o("n1", { recordedAgainst: "https://www.instagram.com/reel/OTHER00001/" })] }))));
    expect(error.body.fieldErrors?.["observations.0.recordedAgainst"]).toBeDefined();
  });

  it("won't re-attribute an existing observation to new media, so a media change invalidates it", async () => {
    const store = createDemoEvidence();
    const existing = read(store, DEMO_EVIDENCE_PARTIAL_ID).data!.observations;
    const moved = existing.map((x) => ({ ...x, recordedAgainst: URL1 }));
    expect((await errorFrom(store.save(save(DEMO_EVIDENCE_PARTIAL_ID, "v3", draft({ mediaUrl: URL1, observations: moved }))))).category).toBe("validation");
    const kept = await store.save(save(DEMO_EVIDENCE_PARTIAL_ID, "v3", draft({ mediaUrl: URL1, observations: existing })));
    expect(kept.record.observations.every((x) => x.recordedAgainst === DEMO_MEDIA_URL)).toBe(true);
  });

  it("rejects a stale version and reports the current one, applying nothing (FX-11)", async () => {
    const store = createDemoEvidence();
    await store.save(save("demo-evidence-1", "v1", draft()));
    const error = await errorFrom(store.save(save("demo-evidence-1", "v1", draft({ checkoutRoute: "tiktok-shop" }))));
    expect(error.category).toBe("conflict");
    expect(error.body.currentVersion).toBe("v2");
    expect(read(store, "demo-evidence-1").data!.checkoutRoute).toBe("website");
  });

  it("replays a duplicate save to the original result, and refuses a changed payload under the same key (FX-14, FX-15)", async () => {
    const store = createDemoEvidence();
    const [a, b] = await Promise.all([store.save(save("demo-evidence-1", "v1", draft(), "same")), store.save(save("demo-evidence-1", "v1", draft(), "same"))]);
    expect(a.resourceVersion).toBe("v2");
    expect(b.resourceVersion).toBe("v2");
    expect(read(store, "demo-evidence-1").data!.version).toBe("v2");
    expect((await errorFrom(store.save(save("demo-evidence-1", "v1", draft({ checkoutRoute: "tiktok-shop" }), "same")))).body.code).toBe("MANIFEST_CHANGED");
  });

  it("reports a missing record, and won't create one from the browser", async () => {
    const store = createDemoEvidence();
    expect((await errorFrom(store.save(save("nope", "v1", draft())))).category).toBe("notFound");
    expect((await errorFrom(store.save(save(null, null, draft())))).category).toBe("validation");
  });

  it("rejects the wrong resource kind", async () => {
    const request = { ...save("demo-evidence-1", "v1", draft()), resourceKind: "configurationDraft" as const };
    expect((await errorFrom(createDemoEvidence().save(request))).category).toBe("validation");
  });
});

describe("reading", () => {
  it("reports an unknown record as not found", () => {
    expect(() => read(createDemoEvidence(), "nope")).toThrow(AdapterError);
  });
});

describe("reviewer disagreement and override (VE-08)", () => {
  const dispute = (over: Partial<import("@/features/acquisition/evidenceTypes").DisputeDraft> = {}) => ({ kind: "dispute" as const, observationId: "obs-seed-3", stance: "disagree" as const, reason: "There is no voiceover in this clip.", proposed: null, ...over });
  const saveDispute = (ref: string | null, version: string | null, payload: unknown, key = `k-${++seq}`) => ({ ...save(ref, version, payload as EvidenceDraft, key), resourceKind: "reviewerAssessment" as const });

  it("freezes the first reviewer's record when observations are first saved, and later drafts leave it alone", async () => {
    const store = createDemoEvidence();
    const first = await store.save(save("demo-evidence-1", "v1", draft({ observations: [o("n1")] })));
    expect(first.record.firstReview).toMatchObject({ version: "v2", reviewerRole: "reviewer", mediaUrl: URL1 });
    expect(first.record.firstReview!.observations.map((x) => x.id)).toEqual(["n1"]);
    const second = await store.save(save("demo-evidence-1", "v2", draft({ observations: [o("n1"), o("n2", { startSec: 9, endSec: 20 })] })));
    expect(second.record.observations).toHaveLength(2);
    expect(second.record.firstReview!.observations.map((x) => x.id)).toEqual(["n1"]);
    const emptied = await store.save(save("demo-evidence-1", "v3", draft({ observations: [] })));
    expect(emptied.record.firstReview!.observations).toHaveLength(1);
  });

  it("has nothing to dispute until a review is saved", async () => {
    const store = createDemoEvidence();
    const error = await errorFrom(store.save(saveDispute("demo-evidence-1", "v1", dispute())));
    expect(error.category).toBe("validation");
    expect(error.body.fieldErrors?.observationId).toMatch(/no saved review/);
    expect(read(store, "demo-evidence-1").capabilities.find((c) => c.actionKind === "recordDisagreement")).toMatchObject({ state: "held", reasonCodes: ["NO_REVIEW_ON_FILE"] });
  });

  it("records a disagreement beside the original without changing it, coverage, or readiness", async () => {
    const store = createDemoEvidence();
    const before = read(store, DEMO_EVIDENCE_PARTIAL_ID).data!;
    const result = await store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v3", dispute()));
    const after = result.record;
    expect(result.resourceVersion).toBe("v4");
    expect(after.disputes).toHaveLength(1);
    expect(after.disputes[0]).toMatchObject({ stance: "disagree", proposed: null, reviewerRole: "reviewer", recordedAgainst: DEMO_MEDIA_URL });
    expect(after.disputes[0]!.prior).toEqual(before.firstReview!.observations[2]);
    expect(after.observations).toEqual(before.observations);
    expect(after.firstReview).toEqual(before.firstReview);
    expect(after.readiness.reasonCodes).toEqual(["NO_COMPLETE_REVIEW", "CONTESTED"]);
    expect(Object.keys(after)).not.toContain("watched");
    expect(after.assessments).toEqual(before.assessments);
  });

  it("records an override with a replacement or a removal, still without editing the original", async () => {
    const store = createDemoEvidence();
    const replaced = await store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v3", dispute({ stance: "override", proposed: { category: "audio", startSec: 0, endSec: 12, text: "Music only, no speech." } })));
    expect(replaced.record.disputes[0]!.proposed).toMatchObject({ text: "Music only, no speech." });
    const removed = await store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v4", dispute({ stance: "override", observationId: "obs-seed-1", proposed: "remove", reason: "This is a different clip, not the one linked." })));
    expect(removed.record.disputes.map((d) => d.proposed === "remove")).toEqual([false, true]);
    expect(removed.record.firstReview!.observations).toHaveLength(3);
    expect(removed.record.observations).toHaveLength(3);
  });

  it("requires a reason, a valid proposal, and a target in the first record (server rejection)", async () => {
    const store = createDemoEvidence();
    const rejected = async (payload: unknown) => (await errorFrom(store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v3", payload)))).body.fieldErrors ?? {};
    expect(await rejected(dispute({ reason: "   " }))).toHaveProperty("reason");
    expect(await rejected(dispute({ reason: "too short" }))).toHaveProperty("reason");
    expect(await rejected(dispute({ stance: "override", proposed: null }))).toHaveProperty("proposed");
    expect(await rejected(dispute({ stance: "disagree", proposed: "remove" }))).toHaveProperty("proposed");
    expect(await rejected(dispute({ stance: "override", proposed: { category: "audio", startSec: 9, endSec: 3, text: "x" } }))).toHaveProperty("proposed.end");
    expect(await rejected(dispute({ observationId: "made-up" }))).toHaveProperty("observationId");
    expect(await rejected({ ...dispute(), kind: "something-else" })).toHaveProperty("kind");
    expect(read(store, DEMO_EVIDENCE_PARTIAL_ID).data!.disputes).toHaveLength(0);
  });

  it("can't dispute a draft observation that isn't in the first record", async () => {
    const store = createDemoEvidence();
    const added = await store.save(save(DEMO_EVIDENCE_PARTIAL_ID, "v3", draft({ mediaUrl: DEMO_MEDIA_URL, observations: [...read(store, DEMO_EVIDENCE_PARTIAL_ID).data!.observations, o("late", { recordedAgainst: DEMO_MEDIA_URL })] })));
    const error = await errorFrom(store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, added.resourceVersion, dispute({ observationId: "late" }))));
    expect(error.body.fieldErrors?.observationId).toMatch(/first reviewer's record/);
  });

  it("changing the video invalidates the first record, its disputes and readiness (a material change)", async () => {
    const store = createDemoEvidence();
    const disputed = await store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v3", dispute()));
    const changed = await store.save(save(DEMO_EVIDENCE_PARTIAL_ID, disputed.resourceVersion, draft({ mediaUrl: URL1, observations: [] })));
    expect(changed.record.readiness.reasonCodes).toEqual(expect.arrayContaining(["NO_COMPLETE_REVIEW", "MEDIA_CHANGED"]));
    expect(changed.record.readiness.reasonCodes).not.toContain("CONTESTED");
    expect(changed.record.disputes).toHaveLength(1);
    const error = await errorFrom(store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, changed.resourceVersion, dispute({ reason: "A second, separate reason." }))));
    expect(error.body.fieldErrors?.observationId).toMatch(/video changed/);
  });

  it("flags a changed checkout route as invalidating the model it was read against", async () => {
    const store = createDemoEvidence();
    const changed = await store.save(save(DEMO_EVIDENCE_PARTIAL_ID, "v3", draft({ mediaUrl: DEMO_MEDIA_URL, checkoutRoute: "tiktok-shop", observations: read(store, DEMO_EVIDENCE_PARTIAL_ID).data!.observations })));
    expect(changed.record.readiness.reasonCodes).toContain("ROUTE_CHANGED");
  });

  it("rejects a stale version, replays a duplicate, and refuses a changed payload under the same key", async () => {
    const store = createDemoEvidence();
    const [a, b] = await Promise.all([store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v3", dispute(), "same")), store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v3", dispute(), "same"))]);
    expect([a.resourceVersion, b.resourceVersion]).toEqual(["v4", "v4"]);
    expect((await errorFrom(store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v3", dispute({ reason: "A different reason entirely." }), "same")))).body.code).toBe("MANIFEST_CHANGED");
    const stale = await errorFrom(store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v3", dispute({ reason: "Another reason, on a stale page." }))));
    expect(stale.category).toBe("conflict");
    expect(stale.body.currentVersion).toBe("v4");
    // Same content under a new key is not recorded twice.
    const again = await store.save(saveDispute(DEMO_EVIDENCE_PARTIAL_ID, "v4", dispute()));
    expect(again.reasonCodes).toEqual(["NO_CHANGE"]);
    expect(again.record.disputes).toHaveLength(1);
  });
});
