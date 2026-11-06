// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assessCreator } from "./policy.ts";
import { loadApprovedBindings } from "./config.ts";
import { anchorFor, ratingPolicy } from "./ratingPolicy.ts";
import { isScorecardProofExpired, resolveScorecardEvidence, sourceSnapshotSchema, type ScorecardSourceSnapshot } from "./routeEvidence.ts";
import { syntheticPacket, syntheticSourceSnapshot, withActivationEvidence, SYNTHETIC_SCOPE } from "./testFixtures.ts";

const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]! };
const cases = ["website", "tiktok-shop"] as const;
function example(route: typeof cases[number]) {
  const packet = withActivationEvidence(syntheticPacket(route));
  packet.ratings = { routine: 4, demo: 4 };
  packet.criterionRatings = { verifiedCommerce: 4, audienceAlignment: 4, reliability: 4, offerEconomics: 4 };
  packet.criterionEvidenceRefs = Object.fromEntries(Object.keys(packet.criterionRatings).map(id => [id, [`synthetic:criterion-proof:${id}`]]));
  const config = loadApprovedBindings().find(b => b.current.modelId === (route === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3"))!;
  const snapshot = syntheticSourceSnapshot(packet, packet.criterionRatings);
  const at = Date.parse("2026-02-03T00:00:00Z");
  const inspect = async (row: unknown) => assessCreator(packet, config, await resolveScorecardEvidence({ resolve: () => row }, scope, packet, at));
  return { packet, config, snapshot, at, inspect };
}

describe("authorized route assessment", () => {
  it.each(cases)("preserves the %s weighted fixture, traceable anchors and separate source measurements", async route => {
    const { inspect, snapshot, config } = example(route);
    const assessment = await inspect(snapshot);
    expect(await inspect(structuredClone(snapshot))).toEqual(assessment);
    expect(assessment).toMatchObject({ state: "activationReady", score: { total: 80 }, routeEvidence: {
      status: "verified", coveredWeight: 100, provider: snapshot.provider, comparison: { count: 10, median: 450, spread: 900 },
      metrics: [{ name: "retainedSales", value: 2500, currency: "USD", sampleSize: 2, maturity: "mature" }],
    } });
    for (const c of config.current.criteria) {
      expect(ratingPolicy.evidenceSources[c.id as keyof typeof ratingPolicy.evidenceSources]).toBeTruthy();
      for (let r = 0; r <= 5; r++) expect(anchorFor(c.id, r)).toBeTruthy();
      expect(assessment.routeEvidence!.criteria.find(row => row.id === c.id)).toMatchObject({ rating: 4, anchor: anchorFor(c.id, 4) });
    }
    expect(isScorecardProofExpired(assessment, Date.parse(snapshot.validUntil))).toBe(true);
  });

  it.each(cases)("generic reviewer pass and unverified %s outcome references cannot populate commerce", async route => {
    const { packet, config } = example(route);
    const result = assessCreator(packet, config);
    expect(result).toMatchObject({ state: "prospectiveInviteEligible", contentQualification: "pass", score: { total: null, unknownCount: 4 },
      routeEvidence: { status: "unknown", coveredWeight: 45, metrics: [], acceptedTerms: null } });
    expect(result.gates).toContainEqual(expect.objectContaining({ id: "SOURCE:route", state: "unknown" }));
  });

  it("keeps unsupported creative ratings unknown when there are no source-reviewed eligible clips", () => {
    const {packet,config} = example("website");
    packet.posts = [];
    packet.ratings = {routine:0,demo:5};
    const result = assessCreator(packet,config);
    expect(result).toMatchObject({state:"reviewNeeded",criteria:{routine:null,demo:null}, score:{earned:0,total:null}});
  });

  it("rejects a vanished or modified locally accepted offer and caps proof to its earliest expiry", async () => {
    const { packet, snapshot, at } = example("website");
    const t = snapshot.terms!;
    t.origin = "saved-offer";
    t.provider = snapshot.provider = "shopify-collabs";
    t.eligibleBase = "retained-eligible-merchandise";
    const validUntil = "2030-01-01T00:00:00Z";
    const commission = {type:"percentage" as const,standardRateBps:2000,fixedMinor:null,shopAdsRateBps:null,
      currency:"USD" as const,base:"retained-eligible-merchandise" as const,effectiveAt:null};
    const offer = {offerId:t.offerId,version:t.version,manifestHash:t.manifestHash,creatorId:packet.creatorId,route:packet.checkoutRoute,
      currency:"USD" as const,commission,provider:{sourceRef:"synthetic:provider",observedAt:snapshot.observedAt,validUntil,provider:"shopify-collabs" as const,
      programRef:snapshot.programId,supportsPercentage:true,supportsFixedPerSale:false,actualCommission:commission,payoutOwner:"provider",
      attributionWindowDays:30,precedence:"verified",conflictRule:"verified",holdDays:30,payoutSchedule:"monthly",payoutThresholdMinor:0,
      onboarding:"verified",feeTreatment:"verified",fundingRule:"verified",refundRule:t.refundRule,trackingOwner:"provider"},acceptedRef:t.acceptedRef,validUntil};
    const auth = {resolve: () => snapshot};
    expect((await resolveScorecardEvidence(auth,scope,packet,at)).snapshot?.terms).toBeNull();
    expect((await resolveScorecardEvidence(auth,scope,packet,at,() => ({...offer,manifestHash:"changed"}))).snapshot?.terms).toBeNull();
    expect((await resolveScorecardEvidence(auth,scope,packet,at,() => ({...offer,commission:{...commission,standardRateBps:1999}}))).snapshot?.terms).toBeNull();
    // An otherwise valid accepted receipt cannot activate an assessment calculated for different terms.
    expect((await resolveScorecardEvidence(auth,scope,packet,at,() => offer)).snapshot?.terms).toBeNull();
    packet.termsRevision = snapshot.termsRevision = t.termsRevision = t.manifestHash;
    const exact = await resolveScorecardEvidence(auth,scope,packet,at,() => offer);
    expect(exact.snapshot?.terms).toEqual(t);
    expect(Date.parse(exact.snapshot!.validUntil)).toBe(Date.parse(validUntil));
  });

  it("drops mismatched account, immutable creator identity, route and revision without disclosing other records", async () => {
    const { snapshot, inspect } = example("website");
    for (const patch of [
      { accountId: "another-account" }, { workspaceId: "another-workspace" }, { creatorId: "similar-handle" },
      { termsRevision: "new-offer" }, { evidenceRevision: "old-evidence" }, { checkoutRoute: "tiktok-shop" },
      { validUntil: "2020-02-07T00:00:00Z" }, { observedAt: "2099-01-01T00:00:00Z" },
    ]) {
      const result = await inspect({ ...snapshot, ...patch });
      expect(result.routeEvidence).toMatchObject({ status: "unknown", sourceRef: null, metrics: [], criteria: expect.any(Array) });
      expect(result.state).toBe("prospectiveInviteEligible");
    }
  });

  it("keeps native GMV, immature net activity and incompatible units out of retained-sales evidence", async () => {
    const { inspect, snapshot } = example("tiktok-shop");
    const metric = snapshot.metrics[0]!;
    const gmv = await inspect({ ...snapshot, metrics: [{ ...metric, name: "gmv" }] });
    expect(gmv.routeEvidence!.metrics[0]!.name).toBe("gmv");
    expect(gmv.score?.total).toBeNull();
    const open = await inspect({ ...snapshot, metrics: [{ ...metric, maturity: "open" }] });
    expect(open.configuration!.criteria.find(c => c.id === "verifiedCommerce")?.rating).toBeNull();
    const badUnit = await inspect({ ...snapshot, metrics: [{ ...metric, name: "orders" }] });
    expect(badUnit.routeEvidence).toMatchObject({ metrics: [], reason: "SOURCE_SCHEMA_INVALID" });
    const knownZero = await inspect({ ...snapshot, metrics: [{ ...metric, value: 0 }] });
    expect(knownZero.routeEvidence!.metrics[0]!.value).toBe(0);
  });

  it("requires verified monetary terms without guaranteed fees, exact versions and provider support for fixed per sale", async () => {
    const { inspect, snapshot } = example("website");
    const t = snapshot.terms!;
    for (const patch of [{ guaranteedFeeMinor: 1 }, { termsRevision: "other" }, { programVersion: "other" }, { provider: "other" },
      { commission: { kind: "perSale", amountMinor: 200, supportedByProvider: false } }]) {
      const result = await inspect({ ...snapshot, terms: { ...t, ...patch } });
      expect(result.gates).toContainEqual(expect.objectContaining({ id: "SOURCE:terms", state: "fail" }));
      expect(result.state).toBe("prospectiveInviteEligible");
    }
    expect((await inspect({ ...snapshot, terms: { ...t, commission: { kind: "perSale", amountMinor: 200, supportedByProvider: true } } })).state).toBe("activationReady");
  });

  it("requires the exact order's refund, link/code and attribution precedence for website activation", async () => {
    const { inspect, snapshot } = example("website");
    if (snapshot.commerce.kind !== "website") throw Error("wrong fixture");
    const c = snapshot.commerce;
    for (const patch of [{ linkOrCodeRef: null }, { attributionPrecedence: null }, { test: null },
      { test: { ...c.test!, refundOfOrderId: "different-order" } }, { test: { ...c.test!, refundApplied: false } }])
      expect((await inspect({ ...snapshot, commerce: { ...c, ...patch } })).state).toBe("prospectiveInviteEligible");
  });

  it("ignores an incompatible provider family and keeps unverified native seller/product linkage out of commerce scores", async () => {
    const {inspect,snapshot} = example("tiktok-shop");
    if (snapshot.commerce.kind !== "tiktok-shop") throw Error("wrong fixture");
    const mismatch = await inspect({...snapshot, provider:"external-affiliate"});
    expect(mismatch.routeEvidence).toMatchObject({status:"unknown",metrics:[]});
    const denied = await inspect({...snapshot, commerce:{...snapshot.commerce, productEligibility:{status:"fail",sourceRef:"fixture:ineligible"}}});
    expect(denied.routeEvidence?.status).toBe("failed");
    expect(denied.score?.total).toBeNull();
    const pending = await inspect({...snapshot, commerce:{...snapshot.commerce, creatorEligibility:{status:"unknown",sourceRef:"fixture:no-link"}}});
    expect(pending.routeEvidence?.status).toBe("unknown");
    expect(pending.routeEvidence?.criteria.find(c => c.id === "verifiedCommerce")?.rating).toBeNull();
  });

  it("requires native seller, creator and product linkage plus effective standard/Ads rates", async () => {
    const { inspect, snapshot } = example("tiktok-shop");
    if (snapshot.commerce.kind !== "tiktok-shop") throw Error("wrong fixture");
    const c = snapshot.commerce;
    for (const patch of [{ creatorEligibility: { ...c.creatorEligibility, status: "unknown" } }, { sellerEligibility: { ...c.sellerEligibility, status: "fail" } },
      { productEligibility: { ...c.productEligibility, status: "fail" } }, { nativeAttribution: { ...c.nativeAttribution, status: "unknown" } },
      { standardRate: { ...c.standardRate!, basisPoints: 1000 } }, { adsRate: { state: "unknown" } }])
      expect((await inspect({ ...snapshot, commerce: { ...c, ...patch } })).state).toBe("prospectiveInviteEligible");
  });

  it("requires matching typed fact and reviewed rating, preserves absence and rejects spoofed managed proof fields", async () => {
    const { packet, inspect, snapshot } = example("website");
    packet.criterionRatings.reliability = 5;
    const result = await inspect(snapshot);
    expect(result.configuration?.criteria.find(c => c.id === "reliability")?.rating).toBeNull();
    const missingAudience = await inspect({ ...snapshot, audience: null });
    expect(missingAudience.configuration?.criteria.find(c => c.id === "audienceAlignment")?.rating).toBeNull();
    const bad: ScorecardSourceSnapshot = { ...snapshot, metrics: [{ ...snapshot.metrics[0]!, windowEnd: snapshot.metrics[0]!.windowStart }] };
    expect(sourceSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});
