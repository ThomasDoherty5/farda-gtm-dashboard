import { scorecardsViewSchemas as schemas } from "./scorecards";
import { FAILING_FIXTURES, REMOVE, expectAllParse, expectRejections, readRequest, readVariants, scope } from "./acquisitionTestKit";
import { SCHEMA_VERSION, type SaveResourceRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { DEMO_ASSESSMENT_CONTENT_ID, DEMO_ASSESSMENT_SC_ID, DEMO_ASSESSMENT_TIKTOK_ID, DEMO_CREATOR_ID, DEMO_OFFER_DRAFT_ID, commerceScorecard, contentScorecard, offerDraftSeed, tiktokScorecard, type OfferDraftPayload } from "@/fixtures/scorecards";

const saveOffer = (key: string, payload: OfferDraftPayload, expectedVersion = "v1"): SaveResourceRequest<OfferDraftPayload> => ({
  schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: scope, resourceKind: "actionDraft", resourceRef: DEMO_OFFER_DRAFT_ID, expectedVersion, idempotencyKey: key, requestId: `s-${key}`, payload,
});

const ids = [DEMO_ASSESSMENT_CONTENT_ID, DEMO_ASSESSMENT_TIKTOK_ID, DEMO_ASSESSMENT_SC_ID];
const offer = { offerId: DEMO_OFFER_DRAFT_ID };

describe("scorecards view schemas", () => {
  it("covers exactly assessmentRecord, offerDraft and offerRewards", () => {
    expect(Object.keys(schemas).sort()).toEqual(["assessmentRecord", "offerDraft", "offerRewards"]);
  });

  describe("every demo variant parses unchanged", () => {
    it("all three assessments under all nine ?fixture= switches: six answer, offline/forbidden/expired fail the read", async () => {
      const variants = await readVariants("assessmentRecord", ids.map((assessmentId) => ({ creatorId: DEMO_CREATOR_ID, assessmentId })));
      expect(variants.filter((v) => v.error).map((v) => v.fixture)).toEqual(ids.flatMap(() => [...FAILING_FIXTURES]).sort());
      const answered = variants.filter((v) => !FAILING_FIXTURES.includes(v.fixture));
      expect(expectAllParse(schemas.assessmentRecord!, answered)).toBe(ids.length * 6);
    });

    it("the empty-filter fixture returns no data, which the envelope allows", async () => {
      const variants = await readVariants("assessmentRecord", [{ creatorId: DEMO_CREATOR_ID, assessmentId: DEMO_ASSESSMENT_CONTENT_ID }]);
      const empty = variants.find((v) => v.fixture === "FX-03-empty-filter")!;
      expect(empty.response!.data).toBeNull();
      expect(expectAllParse(schemas.assessmentRecord!, [empty])).toBe(1);
    });

    it("the missing-metric fixture keeps the dropped rating null, never 0", async () => {
      const variants = await readVariants("assessmentRecord", ids.map((assessmentId) => ({ creatorId: DEMO_CREATOR_ID, assessmentId })));
      const dropped = variants.filter((v) => v.fixture === "FX-04-missing-metric");
      expect(expectAllParse(schemas.assessmentRecord!, dropped)).toBe(3);
      for (const v of dropped) expect((v.response!.data as { criteria: { rating: number | null }[] }).criteria[2]!.rating).toBeNull();
    });

    it("the seeded offer draft under every ?fixture= switch", async () => {
      const variants = await readVariants("offerDraft", [offer]);
      expect(variants.filter((v) => v.error).map((v) => v.fixture).sort()).toEqual([...FAILING_FIXTURES].sort());
      expect(expectAllParse(schemas.offerDraft!, variants.filter((v) => !FAILING_FIXTURES.includes(v.fixture)))).toBe(6);
    });

    it("the offer draft after a changed save, and after an unchanged save", async () => {
      const adapter = createDemoAdapter();
      const read = async () => adapter.readView(readRequest("offerDraft", offer));
      expect(expectAllParse(schemas.offerDraft!, [{ label: "seed", fixture: "FX-01-happy-read", response: await read(), error: null }])).toBe(1);
      await adapter.saveResource(saveOffer("k1", { ...offerDraftSeed.payload, commissionPct: 12, sampleShippingMinor: 3000 }));
      const saved = await read();
      expect((saved.data as { version: string; savedAt: string }).version).toBe("v2");
      expect((saved.data as { savedAt: string | null }).savedAt).not.toBeNull();
      expect(expectAllParse(schemas.offerDraft!, [{ label: "saved", fixture: "FX-01-happy-read", response: saved, error: null }])).toBe(1);
      await adapter.saveResource(saveOffer("k2", { ...offerDraftSeed.payload, commissionPct: 12, sampleShippingMinor: 3000 }, "v2"));
      expect(expectAllParse(schemas.offerDraft!, [{ label: "no change", fixture: "FX-01-happy-read", response: await read(), error: null }])).toBe(1);
    });
  });

  const criteriaCases = (prefix: string) => [
    [`a ${prefix} rating of 6`, `${prefix}.0.rating`, 6],
    [`a ${prefix} fractional rating`, `${prefix}.0.rating`, 3.5],
    [`a ${prefix} negative rating`, `${prefix}.0.rating`, -1],
    [`a ${prefix} rating as text`, `${prefix}.0.rating`, "4"],
    [`a ${prefix} criterion with no label`, `${prefix}.0.label`, REMOVE],
    [`a ${prefix} weight over 100`, `${prefix}.0.weight`, 101],
  ] as [string, string, unknown][];

  describe("assessmentRecord (content-v2) rejects", () => {
    expectRejections(schemas.assessmentRecord!, contentScorecard, [
      ["a missing criteria list", "criteria", REMOVE],
      ["a missing assessment id", "assessmentId", REMOVE],
      ["a coverage over 100", "coveragePct", 120],
      ["a coverage as text", "coveragePct", "100"],
      ["an unknown gate tone", "gates.0.tone", "red"],
      ["an unknown kind", "kind", "content-v3"],
      ["a history date that is not a date", "history.0.at", "Sept 18"],
      ...criteriaCases("criteria"),
    ]);
    it("keeps a missing rating and a missing coverage as null, not 0", () => {
      const parsed = schemas.assessmentRecord!.parse({ ...contentScorecard, coveragePct: null, criteria: contentScorecard.criteria.map((c, i) => (i === 0 ? { ...c, rating: null } : c)) });
      expect(parsed.coveragePct).toBeNull();
      expect(parsed.criteria[0].rating).toBeNull();
    });
  });

  describe("assessmentRecord (tiktok-commerce-v2) rejects", () => {
    expectRejections(schemas.assessmentRecord!, tiktokScorecard, [
      ["a missing subtitle", "subtitle", REMOVE],
      ["a missing evidence list", "evidence", REMOVE],
      ["an evidence card with no headline", "evidence.0.headline", REMOVE],
      ...criteriaCases("criteria"),
    ]);
  });

  describe("assessmentRecord (sc-commerce-v2) rejects", () => {
    expectRejections(schemas.assessmentRecord!, commerceScorecard, [
      ["a missing route", "route", REMOVE],
      ["a content score as text", "contentScore", "84"],
      ["a content score over 100", "contentScore", 101],
      ["a null content score (it is an independent score, never absent here)", "contentScore", null],
      ["an unknown evidence target", "evidenceRows.0.target", "ledger"],
      ["an unknown gate tone", "gates.0.tone", "red"],
      ...criteriaCases("criteria"),
    ]);
  });

  describe("offerDraft rejects", () => {
    expectRejections(schemas.offerDraft!, offerDraftSeed, [
      ["a missing payload", "payload", REMOVE],
      ["a commission as text", "payload.commissionPct", "15"],
      ["a commission over 100", "payload.commissionPct", 101],
      ["a negative commission", "payload.commissionPct", -1],
      ["a negative upfront fee", "payload.upfrontFeeMinor", -100],
      ["fractional upfront fee minor units", "payload.upfrontFeeMinor", 0.5],
      ["negative sample shipping", "payload.sampleShippingMinor", -2500],
      ["fractional sample shipping", "payload.sampleShippingMinor", 2500.5],
      ["sample shipping as a money object", "payload.sampleShippingMinor", { minorUnits: 2500, currency: "USD" }],
      ["an unknown compensation type", "payload.compensation", "flatFee"],
      ["an unknown provider", "payload.provider", "amazon"],
      ["an unknown network", "payload.networks", "youtube"],
      ["an unknown eligible base", "payload.eligibleBase", "grossSales"],
      ["a base-verified flag as text", "payload.baseVerified", "false"],
      ["an extra commercial term in the payload", "payload", { ...offerDraftSeed.payload, guaranteedBonusMinor: 10_000 }],
      ["a save time that is not an instant", "savedAt", "yesterday"],
      ["a negative net sale assumption", "assumptions.netSaleMinor", -4000],
      ["fractional cost assumption", "assumptions.commerceCostMinor", 1800.5],
      ["a missing offer code", "offerCode", REMOVE],
    ]);
  });
});
