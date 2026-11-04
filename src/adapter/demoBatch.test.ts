import { SCHEMA_VERSION, type ActionRequest, type ReadRequest } from "./contract";
import { createDemoBatch } from "./demoBatch";
import { BATCH_ID } from "@/fixtures/batch";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
const read = (filters: object = { batchId: BATCH_ID }): ReadRequest<unknown> => ({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "batchDetail", requestedScope: scope, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r1" });
const act = (actionKind: string, expectedVersion: string, key: string, payload: unknown = { batchId: BATCH_ID }): ActionRequest<unknown> => ({ schemaVersion: SCHEMA_VERSION, operation: "controlRun", requestedScope: scope, actionKind, entityRefs: [], expectedVersion, approvalRef: null, manifestRef: null, idempotencyKey: key, payload, requestId: `a-${key}` });
const states = (b: ReturnType<typeof createDemoBatch>) => b.read(read()).data!.items.reduce<Record<string, number>>((a, i) => ({ ...a, [i.state]: (a[i.state] ?? 0) + 1 }), {});

describe("demo batch", () => {
  it("starts as 24 approved items: 16 confirmed, 3 queued, 2 running, 2 reconciling, 1 login blocked", () => {
    expect(states(createDemoBatch())).toEqual({ confirmed: 16, queued: 3, running: 2, reconcile: 2, login: 1 });
  });

  it("pauses unsent work only: queued items pause, and running and confirmed items are untouched", async () => {
    const batch = createDemoBatch();
    const version = batch.read(read()).dataVersion;
    const result = await batch.submit(act("pauseBatch", version, "k1"));
    expect(result.state).toBe("paused");
    expect(result.reasonCodes).toContain("IN_FLIGHT_DRAINS");
    expect(states(batch)).toEqual({ confirmed: 16, paused: 3, running: 2, reconcile: 2, login: 1 });
    const after = batch.read(read());
    expect(after.data!.paused).toBe(true);
    expect(after.capabilities.find((c) => c.actionKind === "pauseBatch")).toMatchObject({ state: "held", reasonCodes: ["ALREADY_PAUSED"] });
  });

  it("cancels only the unsent items asked for, and reports what it left alone", async () => {
    const batch = createDemoBatch();
    const items = batch.read(read()).data!.items;
    const queued = items.filter((i) => i.state === "queued");
    const one = await batch.submit(act("cancelUnsent", batch.read(read()).dataVersion, "k1", { batchId: BATCH_ID, itemIds: [queued[0]!.id] }));
    expect(one.state).toBe("canceled");
    expect(states(batch)).toMatchObject({ canceled: 1, queued: 2, confirmed: 16 });
    const mixed = await batch.submit(act("cancelUnsent", batch.read(read()).dataVersion, "k2", { batchId: BATCH_ID, itemIds: [queued[1]!.id, items[0]!.id] }));
    expect(mixed.state).toBe("partiallySucceeded");
    expect(mixed.reasonCodes).toContain("SENT_OR_RUNNING_EXCLUDED");
    expect(states(batch)).toMatchObject({ canceled: 2, queued: 1, confirmed: 16 });
  });

  it("refuses to cancel a confirmed send", async () => {
    const batch = createDemoBatch();
    const confirmed = batch.read(read()).data!.items.find((i) => i.state === "confirmed")!;
    await expect(batch.submit(act("cancelUnsent", batch.read(read()).dataVersion, "k1", { batchId: BATCH_ID, itemIds: [confirmed.id] }))).rejects.toMatchObject({ body: { code: "VALIDATION_FAILED", executionCertainty: "notApplied" } });
    expect(states(batch)).toEqual({ confirmed: 16, queued: 3, running: 2, reconcile: 2, login: 1 });
  });

  it("is idempotent: the same key returns the first result and acts once", async () => {
    const batch = createDemoBatch();
    const version = batch.read(read()).dataVersion;
    const first = await batch.submit(act("cancelUnsent", version, "same"));
    const second = await batch.submit(act("cancelUnsent", version, "same"));
    expect(second).toEqual(first);
    expect(states(batch).canceled).toBe(3);
  });

  it("rejects a stale version with a recoverable conflict, and changes nothing", async () => {
    const batch = createDemoBatch();
    await batch.submit(act("pauseBatch", batch.read(read()).dataVersion, "k1"));
    await expect(batch.submit(act("cancelUnsent", "batch-v1", "k2"))).rejects.toMatchObject({ category: "conflict" });
    expect(states(batch)).toMatchObject({ paused: 3 });
  });

  it("knows nothing about a batch it doesn't have, and rejects a facet that isn't allowed", () => {
    const batch = createDemoBatch();
    expect(() => batch.read(read({ batchId: "nope" }))).toThrow(/does not exist/);
    expect(() => batch.read(read({ batchId: BATCH_ID, owner: "nobody" }))).toThrow(/owner must be/);
  });

  it("dispatches nothing for an action it doesn't implement", async () => {
    await expect(createDemoBatch().submit(act("sendBatch", "batch-v1", "k1"))).rejects.toMatchObject({ category: "unavailable" });
  });

  describe("decideTikTokSample replays", () => {
    const decide = (sampleId: string, decision: string, extra: object = {}) => ({ batchId: BATCH_ID, sampleId, decision, ...extra });

    it("the same key and the same payload returns the first result", async () => {
      const batch = createDemoBatch();
      const version = batch.read(read()).dataVersion;
      const first = await batch.submit(act("decideTikTokSample", version, "s1", decide("SR-001", "approve")));
      const again = await batch.submit(act("decideTikTokSample", version, "s1", decide("SR-001", "approve")));
      expect(again).toBe(first);
    });

    it("the same key with a changed decision is MANIFEST_CHANGED and decides nothing", async () => {
      const batch = createDemoBatch();
      const version = batch.read(read()).dataVersion;
      await batch.submit(act("decideTikTokSample", version, "s2", decide("SR-001", "approve")));
      await expect(batch.submit(act("decideTikTokSample", version, "s2", decide("SR-001", "decline")))).rejects.toMatchObject({ body: { code: "MANIFEST_CHANGED" } });
      const samples = batch.read(read()).data!.samples;
      expect(samples.find((x) => x.id === "SR-001")!.state).toBe("approved");
    });

    it("the same key aimed at a different sample is MANIFEST_CHANGED, not the first sample's receipt", async () => {
      const batch = createDemoBatch();
      const version = batch.read(read()).dataVersion;
      await batch.submit(act("decideTikTokSample", version, "s3", decide("SR-001", "approve")));
      await expect(batch.submit(act("decideTikTokSample", version, "s3", decide("SR-002", "approve")))).rejects.toMatchObject({ body: { code: "MANIFEST_CHANGED" } });
      expect(batch.read(read()).data!.samples.find((x) => x.id === "SR-002")!.state).toBe("pending");
    });
  });
});
