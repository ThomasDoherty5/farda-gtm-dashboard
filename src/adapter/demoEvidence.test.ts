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
