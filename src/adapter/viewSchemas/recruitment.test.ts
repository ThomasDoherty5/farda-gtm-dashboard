import { recruitmentViewSchemas as schemas } from "./recruitment";
import { REMOVE, expectAllParse, expectRejections, readRequest, readVariants, scope } from "./acquisitionTestKit";
import { SCHEMA_VERSION, type ActionRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { BATCH_ID, seedItems, heldReasons } from "@/fixtures/batch";
import { OWNERS } from "@/fixtures/creators";
import { discoveryDemo } from "@/fixtures/discovery";
import { PIPELINE_STAGES, pipelineDemo } from "@/fixtures/pipeline";
import { invitationDemo, recruitmentDemo } from "@/fixtures/recruitment";
import { filterPipeline } from "@/fixtures/pipeline";
import type { BatchData } from "@/fixtures/batch";

const combos = <A extends string, B extends string>(a: readonly A[], b: readonly B[]) => a.flatMap((x) => b.map((y) => [x, y] as const));
const control = (actionKind: string, key: string, expectedVersion: string, payload: object): ActionRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "controlRun", requestedScope: scope, actionKind, entityRefs: [], expectedVersion, approvalRef: null, manifestRef: null, idempotencyKey: key, payload: { batchId: BATCH_ID, ...payload }, requestId: `a-${key}`,
});

const batchBase: BatchData = {
  datasetKey: "batch-demo", batchId: BATCH_ID, version: "batch-v1", paused: false, items: seedItems(), held: heldReasons,
  filters: { source: "tiktok", deal: "affiliate", owner: "all" }, model: { label: "current v3 pending", status: "pending" },
  capacity: { nativeInvitations: 24, sampleUnits: 12, sampleCostMinor: 30_000, collaborationSlots: null },
};

describe("recruitment view schemas", () => {
  it("covers exactly the five recruitment, invitation, batch, pipeline and discovery view keys", () => {
    expect(Object.keys(schemas).sort()).toEqual(["batchDetail", "discoverySummary", "invitationDraft", "pipelineSummary", "recruitmentQueue"]);
  });

  describe("every demo variant parses unchanged", () => {
    it("recruitmentQueue for every network and route facet, including combinations with an empty queue", async () => {
      const facets = combos(["both", "instagram", "tiktok"] as const, ["queue", "inbound", "outbound"] as const).map(([networks, route]) => ({ networks, route }));
      const variants = await readVariants("recruitmentQueue", facets);
      expect(expectAllParse(schemas.recruitmentQueue!, variants)).toBe(facets.length * 9);
      expect(variants.some((v) => (v.response!.data as { queue: unknown[] }).queue.length === 0)).toBe(true);
    });

    it("recruitmentQueue with no filters at all", async () => {
      expect(expectAllParse(schemas.recruitmentQueue!, await readVariants("recruitmentQueue", [{}]))).toBe(9);
    });

    it("invitationDraft under every fixture", async () => {
      expect(expectAllParse(schemas.invitationDraft!, await readVariants("invitationDraft", [{}]))).toBe(9);
    });

    it("discoverySummary under every fixture", async () => {
      expect(expectAllParse(schemas.discoverySummary!, await readVariants("discoverySummary", [{}]))).toBe(9);
    });

    it("pipelineSummary for every source, network, checkout and window facet (81 combinations)", async () => {
      const facets = combos(["both", "social-cat", "tiktok-shop"] as const, ["all", "instagram", "tiktok"] as const).flatMap(([source, network]) =>
        combos(["all", "website", "tiktok-shop"] as const, ["sep-oct", "sep", "oct"] as const).map(([checkout, window]) => ({ source, network, checkout, window })));
      expect(facets).toHaveLength(81);
      expect(expectAllParse(schemas.pipelineSummary!, await readVariants("pipelineSummary", facets))).toBe(81 * 9);
    });

    it("pipelineSummary with no filters", async () => {
      expect(expectAllParse(schemas.pipelineSummary!, await readVariants("pipelineSummary", [{}]))).toBe(9);
    });

    it("batchDetail for the batch id, no id, and every source, deal and owner filter", async () => {
      const facets = [{ batchId: BATCH_ID }, {}, ...combos(["tiktok", "all"] as const, ["affiliate", "all"] as const).map(([source, deal]) => ({ batchId: BATCH_ID, source, deal })), ...["all", ...OWNERS].map((owner) => ({ batchId: BATCH_ID, owner }))];
      expect(expectAllParse(schemas.batchDetail!, await readVariants("batchDetail", facets))).toBe(facets.length * 9);
    });

    it("batchDetail after pausing, and after cancelling unsent items (including a partial cancel)", async () => {
      const read = (a: ReturnType<typeof createDemoAdapter>) => a.readView(readRequest("batchDetail", { batchId: BATCH_ID }));
      const paused = createDemoAdapter();
      await paused.submitAction(control("pauseBatch", "p1", "batch-v1", {}));
      const pausedRes = await read(paused);
      expect((pausedRes.data as BatchData).paused).toBe(true);

      const canceled = createDemoAdapter();
      const items = (await read(canceled)).data as BatchData;
      const queued = items.items.filter((i) => i.state === "queued").map((i) => i.id);
      await canceled.submitAction(control("cancelUnsent", "c1", "batch-v1", { itemIds: queued }));
      const canceledRes = await read(canceled);
      expect((canceledRes.data as BatchData).items.filter((i) => i.state === "canceled")).toHaveLength(queued.length);

      const mixed = createDemoAdapter();
      const confirmed = items.items.find((i) => i.state === "confirmed")!.id;
      await mixed.submitAction(control("cancelUnsent", "c2", "batch-v1", { itemIds: [queued[0]!, confirmed] }));
      const mixedRes = await read(mixed);
      const asVariant = (label: string, response: typeof pausedRes) => ({ label, fixture: "FX-01-happy-read" as const, response, error: null });
      expect(expectAllParse(schemas.batchDetail!, [asVariant("paused", pausedRes), asVariant("canceled", canceledRes), asVariant("mixed", mixedRes)])).toBe(3);
    });
  });

  describe("recruitmentQueue rejects", () => {
    expectRejections(schemas.recruitmentQueue!, recruitmentDemo, [
      ["a missing queue", "queue", REMOVE],
      ["an unknown network facet", "filters.networks", "youtube"],
      ["an unknown route facet", "filters.route", "referral"],
      ["a text allocation count", "allocation.instagram", "17"],
      ["a null allocation count (unknown is not a count here)", "allocation.tiktok", null],
      ["a fractional extra-sample count", "crossPostExtraSamples", 0.5],
      ["a negative allocation", "allocation.instagram", -1],
      ["an unknown row network", "queue.0.network", "Facebook"],
      ["an unknown row route", "queue.0.route", "queue"],
      ["an unknown next-step target", "queue.0.next.to", "send"],
      ["a known usage figure", "plan.usage", 120],
      ["a usage figure of zero", "plan.usage", 0],
      ["a draft with no recipient", "draft.recipient", REMOVE],
    ]);
  });

  describe("invitationDraft rejects", () => {
    expectRejections(schemas.invitationDraft!, invitationDemo, [
      ["a missing program", "program", REMOVE],
      ["a commission over 100", "program.maxCommissionPct", 130],
      ["fractional validity days", "program.maxValidityDays", 30.5],
      ["a prior score over 100", "priorScore.value", 101],
      ["a prior score as text", "priorScore.value", "86"],
      ["a quota of zero (a read zero, not a missing read)", "quota", { state: "known", value: 0, reasonCode: null }],
      ["a number smuggled into the unknown quota", "quota", { state: "unknown", reasonCode: "QUOTA_NOT_READ", value: 0 }],
      ["an unknown quota with no reason", "quota.reasonCode", ""],
      ["a planned sample count as text", "plannedSamples", "15"],
      ["a negative planned sample count", "plannedSamples", -15],
      ["an unknown suppression state", "creators.0.suppression", "maybe"],
      ["an unresolved identity", "creators.0.identity", "unresolved"],
      ["automatic invitations switched on", "automateInvitations", "on"],
      ["a listing that claims to be verified", "products.0.listing", "verified"],
    ]);
  });

  describe("batchDetail rejects", () => {
    expectRejections(schemas.batchDetail!, batchBase, [
      ["missing items", "items", REMOVE],
      ["an unknown item state", "items.0.state", "sent"],
      ["a repeated item id", "items", [seedItems()[0], seedItems()[0]]],
      ["a paused flag as text", "paused", "false"],
      ["an unknown source filter", "filters.source", "instagram"],
      ["an unknown deal filter", "filters.deal", "fixed"],
      ["an unknown owner filter", "filters.owner", "Everyone"],
      ["a model status other than pending", "model.status", "approved"],
      ["negative sample cost minor units", "capacity.sampleCostMinor", -30_000],
      ["fractional sample cost minor units", "capacity.sampleCostMinor", 30_000.5],
      ["sample cost as a money object", "capacity.sampleCostMinor", { minorUnits: 30_000, currency: "USD" }],
      ["a negative sample unit count", "capacity.sampleUnits", -12],
      ["a fractional native invitation count", "capacity.nativeInvitations", 24.5],
      ["a text native invitation count", "capacity.nativeInvitations", "24"],
      ["collaboration slots of zero (they are unknown, not zero)", "capacity.collaborationSlots", 0],
      ["a held reason missing an owner count", "held.0.byOwner.Thomas", REMOVE],
      ["a negative held count", "held.0.byOwner.Operator", -2],
    ]);
    it("keeps an unknown native invitation count as null, not 0", () => {
      const parsed = schemas.batchDetail!.parse({ ...batchBase, capacity: { ...batchBase.capacity, nativeInvitations: null } }) as BatchData;
      expect(parsed.capacity.nativeInvitations).toBeNull();
    });
  });

  describe("pipelineSummary rejects", () => {
    const data = filterPipeline({ source: "both", network: "tiktok", checkout: "all", window: "oct" });
    expectRejections(schemas.pipelineSummary!, data, [
      ["missing sources", "sources", REMOVE],
      ["an unknown source", "sources.0.source", "instagram"],
      ["an unknown source filter", "filters.source", "instagram-only"],
      ["an unknown window", "filters.window", "nov"],
      ["an unsplit key that is not a filter", "unsplit", ["region"]],
      ["a reached list that is too short", "sources.0.reached", [60, 48]],
      ["a reached list that is too long", "sources.0.reached", [...pipelineDemo.sources[0]!.reached, 1]],
      ["a text reached count", "sources.0.reached.1", "48"],
      ["a negative reached count", "sources.0.reached.1", -48],
      ["a fractional reached count", "sources.0.reached.1", 48.5],
      ["a median-days list that is too short", "sources.0.medianDays", [null, 1]],
      ["negative median days", "sources.0.medianDays.1", -1],
      ["a missing current-stage bucket", "sources.0.current.dispatch", REMOVE],
      ["a null current-stage bucket", "sources.0.current.dispatch", null],
      ["an unknown native milestone", "sources.0.nativeMilestone", "signed"],
      ["negative merchandise minor units", "sources.0.outcomes.merchandise.minorUnits", -48_000],
      ["fractional refund minor units", "sources.0.outcomes.refunds.minorUnits", 3_000.5],
      ["merchandise without a currency", "sources.0.outcomes.merchandise", { minorUnits: 48_000 }],
      ["a text order count", "sources.0.outcomes.orders", "20"],
      ["a scale of zero as text", "scaleMax", "120"],
      ["an as-of time that is not an instant", "cohort.asOf", "2 Nov"],
    ]);
    it("accepts unknown stage counts and median days as null, not 0", () => {
      const source = { ...pipelineDemo.sources[0]!, reached: [60, null, null, 30, 27, 18, 15, 12, 9, 6], medianDays: [null, null, 1, 1, 1, 4, 1, 1, 7, 6] };
      const parsed = schemas.pipelineSummary!.parse({ ...pipelineDemo, sources: [source] }) as typeof pipelineDemo;
      expect(parsed.sources[0]!.reached[1]).toBeNull();
      expect(parsed.sources[0]!.medianDays[1]).toBeNull();
    });
    it("expects one entry per funnel stage", () => {
      expect(PIPELINE_STAGES).toHaveLength(10);
      expect(pipelineDemo.sources.every((s) => s.reached.length === PIPELINE_STAGES.length && s.medianDays.length === PIPELINE_STAGES.length)).toBe(true);
    });
  });

  describe("discoverySummary rejects", () => {
    expectRejections(schemas.discoverySummary!, discoveryDemo, [
      ["missing phases", "phases", REMOVE],
      ["a current phase outside the phases", "currentPhase", 6],
      ["a negative current phase", "currentPhase", -1],
      ["more eligible than selected", "batch.eligible", 51],
      ["fractional sample unit cost", "batch.sampleUnitCost.minorUnits", 2_500.5],
      ["negative sample unit cost", "batch.sampleUnitCost.minorUnits", -2_500],
      ["a sample unit cost as a bare number", "batch.sampleUnitCost", 2_500],
      ["an unknown capacity row id", "capacityRows.0.id", "instagram"],
      ["a known live capacity with a null value (a known null)", "liveCapacity", { ...discoveryDemo.liveCapacity, state: "known", value: null, reasonCode: null }],
      ["an unknown live capacity of zero (unknown turned into a number)", "liveCapacity", { ...discoveryDemo.liveCapacity, value: 0 }],
      ["an unknown live capacity with no reason", "liveCapacity", { ...discoveryDemo.liveCapacity, reasonCode: null }],
      ["a known live capacity that is negative", "liveCapacity", { ...discoveryDemo.liveCapacity, state: "known", value: -1, reasonCode: null }],
      ["a known live capacity that is fractional", "liveCapacity", { ...discoveryDemo.liveCapacity, state: "known", value: 2.5, reasonCode: null }],
      ["a known upfront fee with a null value", "upfrontFee", { ...discoveryDemo.upfrontFee, value: null }],
      ["a known upfront fee of fractional minor units", "upfrontFee", { ...discoveryDemo.upfrontFee, value: { minorUnits: 0.5, currency: "USD" } }],
      ["a known upfront fee of negative minor units", "upfrontFee", { ...discoveryDemo.upfrontFee, value: { minorUnits: -100, currency: "USD" } }],
      ["an upfront fee as a bare number", "upfrontFee", { ...discoveryDemo.upfrontFee, value: 0 }],
      ["a provenance value with an unknown state", "upfrontFee", { ...discoveryDemo.upfrontFee, state: "assumed" }],
      ["a provenance value with no observation time", "upfrontFee.observedAt", REMOVE],
    ]);
    it("accepts the $0 upfront fee as a known zero and live capacity as unknown", () => {
      const parsed = schemas.discoverySummary!.parse(discoveryDemo) as typeof discoveryDemo;
      expect(parsed.upfrontFee).toMatchObject({ state: "known", value: { minorUnits: 0, currency: "USD" } });
      expect(parsed.liveCapacity).toMatchObject({ state: "unknown", value: null, reasonCode: "CAPACITY_NOT_READ" });
    });
  });
});
