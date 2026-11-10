// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { NativeAnalyticsSnapshot } from "./contract.ts";
import { nativeAnalyticsFixture } from "./nativeFixtures.testkit.ts";
import { addNativeReviewEvidence } from "./nativeReviewEvidence.testkit.ts";

type Fixture = ReturnType<typeof nativeAnalyticsFixture>;
type AttributionSource = Extract<NativeAnalyticsSnapshot, { viewKey: "attribution" }>;
type PaidSource = Extract<NativeAnalyticsSnapshot, { viewKey: "paidMedia" }>;
const readAttribution = async (f: Fixture) => {
  const result = await f.reader.read(f.request("attribution"), f.principal);
  if (result.data.viewKey !== "attribution") throw new Error("Wrong fixture view");
  return { ...result, data: result.data };
};
const readPaid = async (f: Fixture) => {
  const result = await f.reader.read(f.request("paidMedia"), f.principal);
  if (result.data.viewKey !== "paidMedia") throw new Error("Wrong fixture view");
  return { ...result, data: result.data };
};
const attributionFixture = (mutate?: (snapshot: AttributionSource, f: Fixture) => void) => {
  const f = nativeAnalyticsFixture();
  f.state.mutate = snapshot => { if (snapshot.viewKey === "attribution") mutate?.(snapshot, f); };
  return f;
};
const paidFixture = (mutate?: (snapshot: PaidSource, f: Fixture) => void) => {
  const f = nativeAnalyticsFixture();
  f.state.mutate = snapshot => { addNativeReviewEvidence(snapshot, f.state.now); if (snapshot.viewKey === "paidMedia") mutate?.(snapshot, f); };
  return f;
};
const privateMaterial = /fictional-|synthetic-|canon-|cust-|permissionVersion|principalRef|customerRef/;

describe("source-owned unattributed order review", () => {
  it("lists the exact 40 unmatched orders with the same window and no invented source-specific cause", async () => {
    const { data } = await readAttribution(attributionFixture());
    const review = data.unattributedReview!;
    expect(review).toMatchObject({ state: "ready", period: data.period, cohortRef: data.cohortRef, precedence: ["code", "utm", "platform"], total: { state: "known", value: 40 }, limit: 100, truncated: false });
    expect(review.rows).toHaveLength(40);
    expect(review.rows.every(row => row.classification === "unattributed" && row.sourceAttribution === "unattributed" && row.reason === "SOURCE_REPORTED_UNATTRIBUTED" && row.sourceReason === null && row.evidenceRefs.length === 0)).toBe(true);
    expect(new Set(review.rows.map(row => row.orderRef)).size).toBe(40);
    expect(new Set(review.rows.map(row => row.canonicalOrderRef)).size).toBe(40);
    expect(review.rows[0]!.proofRef).toBe(data.sources.find(owner => owner.owner === "commerceOrders")!.proofRef);
    expect(JSON.stringify(review)).not.toMatch(privateMaterial);
  });
  it("keeps unknown classification separate, carries real source reasons and preserves 400 / $12,596", async () => {
    const f = attributionFixture((snapshot, fixture) => addNativeReviewEvidence(snapshot, fixture.state.now));
    const { data } = await readAttribution(f), review = data.unattributedReview!;
    expect(data.orders.value).toBe(400); expect(data.netReceipts.value?.minorUnits).toBe(1_259_600);
    expect(review).toMatchObject({ state: "partial", total: { value: 42 } });
    expect(review.reasonCodes).toContain("INPUT_UNKNOWN");
    expect(review.rows.filter(row => row.classification === "unattributed")).toHaveLength(40);
    expect(review.rows.find(row => row.classification === "unknownCodeOwner")).toMatchObject({ sourceAttribution: "code", codeOwner: "unknown", sourceReason: "unrecognizedCode", reason: "CODE_OWNER_UNKNOWN" });
    expect(review.rows.find(row => row.classification === "notEvaluated")).toMatchObject({ sourceAttribution: null, codeOwner: null, sourceReason: "notEvaluated", reason: "ATTRIBUTION_NOT_EVALUATED" });
    expect(review.rows.filter(row => row.sourceReason !== null)).toHaveLength(3);
    expect(review.rows.filter(row => row.sourceReason !== null).every(row => row.evidenceRefs.length === 1 && row.reasonObservedAt !== null)).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(privateMaterial);
  });
  it("uses only the selected native feed and exposes attribution-only mirror disagreement as partial", async () => {
    const f = attributionFixture(snapshot => {
      const native = snapshot.facts.orders!.snapshot.feeds[0]!, mirror = structuredClone(native);
      mirror.feedRef = "fictional-shopify-mirror"; mirror.origin = "mirror";
      mirror.orders.find(row => row.attribution === "unattributed")!.attribution = "utm";
      snapshot.facts.orders!.snapshot.feeds.push(mirror);
    });
    const { data } = await readAttribution(f);
    expect(data.unattributedReview).toMatchObject({ state: "partial", total: { value: 40, provisional: true } });
    expect(data.unattributedReview!.reasonCodes).toContain("COVERAGE_PARTIAL");
    expect(data.unattributedReview!.rows).toHaveLength(40);
    expect(new Set(data.unattributedReview!.rows.map(row => row.feedRef)).size).toBe(1);
  });
  it("accepts a qualified mirror only when no native feed exists", async () => {
    const f = attributionFixture(snapshot => { snapshot.facts.orders!.snapshot.feeds[0]!.origin = "mirror"; });
    const { data } = await readAttribution(f);
    expect(data.unattributedReview).toMatchObject({ state: "ready", total: { value: 40 } });
  });
  it.each(["missingIdentity", "duplicateIdentity", "missingSource", "error", "partial", "stale"] as const)("preserves the %s fence", async mode => {
    const f = attributionFixture((snapshot, fixture) => {
      const source = snapshot.facts.orders!, feed = source.snapshot.feeds[0]!, owner = snapshot.owners.find(row => row.owner === "commerceOrders")!;
      if (mode === "missingIdentity") feed.orders[0]!.canonicalOrderId = null;
      if (mode === "duplicateIdentity") source.snapshot.feeds[1]!.orders[0]!.canonicalOrderId = feed.orders[0]!.canonicalOrderId;
      if (mode === "missingSource") snapshot.facts.orders = null;
      if (mode === "error") feed.syncState = "error";
      if (mode === "partial") { owner.coverage = "partial"; feed.coverage = "partial"; }
      if (mode === "stale") owner.sourceAsOf = new Date(fixture.state.now - 16 * 60_000).toISOString();
    });
    const review = (await readAttribution(f)).data.unattributedReview!;
    if (mode === "partial" || mode === "stale") {
      expect(review.state).toBe(mode); expect(review.rows).toHaveLength(40);
      expect(review.rows.every(row => row.provisional)).toBe(true);
    } else {
      expect(review.rows).toHaveLength(0); expect(review.total.state).toBe("unknown");
      expect(review.state).toBe(mode === "error" ? "partial" : "unavailable");
    }
    expect(review.reasonCodes).toContain(mode.includes("Identity") ? "IDENTITY_UNRESOLVED" : mode === "missingSource" ? "SOURCE_MISSING" : mode === "error" ? "SOURCE_ERROR" : mode === "stale" ? "SOURCE_STALE" : "COVERAGE_PARTIAL");
  });
  it("distinguishes a complete zero from a bounded 100-row subset with its exact total", async () => {
    for (const unmatched of [false, true]) {
      const f = attributionFixture(snapshot => {
        for (const feed of snapshot.facts.orders!.snapshot.feeds) for (const row of feed.orders) { row.attribution = unmatched && feed.channel === "shopify" ? "unattributed" : "utm"; row.codeOwner = null; }
      });
      const first = (await readAttribution(f)).data.unattributedReview!, second = (await readAttribution(f)).data.unattributedReview!;
      expect(first).toMatchObject({ state: "ready", total: { state: "known", value: unmatched ? 260 : 0 }, truncated: unmatched });
      expect(first.rows).toHaveLength(unmatched ? 100 : 0);
      expect(first.rows.map(row => row.orderRef)).toEqual(second.rows.map(row => row.orderRef));
    }
  });
  it.each(["before", "end", "reasonVersion", "reasonClassification", "reasonTime"] as const)("refuses %s evidence outside the exact order source", async mode => {
    const f = attributionFixture((snapshot, fixture) => {
      addNativeReviewEvidence(snapshot, fixture.state.now);
      const row = snapshot.facts.orders!.snapshot.feeds[0]!.orders[0]!;
      if (mode === "before") row.placedAt = new Date(Date.parse(snapshot.period!.startAt) - 1).toISOString();
      if (mode === "end") row.placedAt = snapshot.period!.endAt;
      if (mode === "reasonVersion") row.attributionEvidence!.sourceVersion = "fictional-wrong-version";
      if (mode === "reasonClassification") row.attributionEvidence!.reason = "noMatchingSignal";
      if (mode === "reasonTime") row.attributionEvidence!.observedAt = new Date(fixture.state.now + 1).toISOString();
    });
    await expect(readAttribution(f)).rejects.toMatchObject({ code: mode === "reasonVersion" ? "ANALYTICS_BINDING_MISMATCH" : "ANALYTICS_SOURCE_INVALID" });
  });
  it("labels old source explanations stale without discarding the exact raw classification", async () => {
    const f = attributionFixture((snapshot, fixture) => {
      addNativeReviewEvidence(snapshot, fixture.state.now);
      snapshot.facts.orders!.snapshot.feeds[0]!.orders[0]!.attributionEvidence!.observedAt = new Date(fixture.state.now - 16 * 60_000).toISOString();
    });
    const review = (await readAttribution(f)).data.unattributedReview!;
    expect(review.state).toBe("stale"); expect(review.reasonCodes).toContain("SOURCE_STALE");
    expect(review.rows.find(row => row.classification === "unknownCodeOwner")).toMatchObject({ sourceAttribution: "code", sourceReason: "unrecognizedCode", provisional: true });
  });
  it("expires the read at the source explanation freshness boundary", async () => {
    const f = attributionFixture((snapshot, fixture) => {
      addNativeReviewEvidence(snapshot, fixture.state.now);
      snapshot.facts.orders!.snapshot.feeds[0]!.orders[0]!.attributionEvidence!.observedAt = new Date(fixture.state.now - 15 * 60_000 + 1000).toISOString();
    });
    const result = await readAttribution(f);
    expect(result.data.provenance.validUntil).toBe(new Date(f.state.now + 1000).toISOString());
    f.state.now += 1000;
    expect(() => result.assertCurrent()).toThrowError(expect.objectContaining({ code: "ANALYTICS_PUBLICATION_EXPIRED" }));
  });
});

describe("exact source asset rights evidence", () => {
  it("keeps missing evidence explicit even when the source reports cleared rights", async () => {
    const { data } = await readPaid(nativeAnalyticsFixture());
    expect(data.assets.find(asset => asset.label === "AD-01")).toMatchObject({ rights: "cleared", rightsEvidence: { state: "missing", grant: null, reasonCodes: ["RIGHTS_UNKNOWN", "SOURCE_MISSING"] } });
  });
  it("projects exact available, expired, stale and missing grants without leaking source identifiers", async () => {
    const { data } = await readPaid(paidFixture()), owner = data.sources.find(row => row.owner === "adReporting")!;
    expect(data.assets.find(asset => asset.label === "AD-01")!.rightsEvidence).toMatchObject({ state: "available", reasonCodes: [], grant: { platform: "meta", accountRef: owner.accountRef, proofRef: owner.proofRef, sourceVersion: owner.sourceVersion, usageScope: ["paidAdvertising", "creatorHandleAdvertising"] } });
    expect(data.assets.find(asset => asset.label === "AD-03")!.rightsEvidence.state).toBe("expired");
    expect(data.assets.find(asset => asset.label === "AD-04")!.rightsEvidence.state).toBe("stale");
    expect(data.assets.find(asset => asset.rights === "notGranted")!.rightsEvidence).toMatchObject({ state: "missing", grant: null });
    expect(data.totals.spend.value?.minorUnits).toBe(650000);
    for (const asset of data.assets) if (asset.rightsEvidence.grant) expect(asset.rightsEvidence.grant.assetRef).toBe(asset.assetRef);
    expect(JSON.stringify(data)).not.toMatch(privateMaterial);
  });
  it.each(["asset", "platform", "account", "sourceVersion", "expiry", "future", "secret", "evidence", "notGranted", "scopeDuplicate"] as const)("rejects %s grant substitution", async mode => {
    const f = paidFixture((snapshot, fixture) => {
      const asset = snapshot.facts.ads!.snapshot.feeds[0]!.assets[0]!, grant = asset.rightsGrant!;
      if (mode === "asset") grant.assetRef = "fictional-other-asset";
      if (mode === "platform") grant.platform = "tiktok";
      if (mode === "account") grant.accountRef = "fictional-other-account";
      if (mode === "sourceVersion") grant.sourceVersion = "fictional-other-version";
      if (mode === "expiry") grant.expiresOn = "2027-05-01";
      if (mode === "future") grant.observedAt = new Date(fixture.state.now + 1).toISOString();
      if (mode === "secret") grant.agreementRef = "person@example.test";
      if (mode === "evidence") grant.evidenceRefs = [];
      if (mode === "notGranted") asset.rights = "notGranted";
      if (mode === "scopeDuplicate") grant.usageScope = ["paidAdvertising", "paidAdvertising"];
    });
    await expect(readPaid(f)).rejects.toMatchObject({ code: mode === "account" || mode === "sourceVersion" ? "ANALYTICS_BINDING_MISMATCH" : "ANALYTICS_SOURCE_INVALID" });
  });
  it.each(["expiryUnknown", "organicOnly", "rightsUnknown", "partial", "error", "ownerStale"] as const)("does not qualify %s evidence as available for paid reuse", async mode => {
    const f = paidFixture((snapshot, fixture) => {
      const feed = snapshot.facts.ads!.snapshot.feeds[0]!, asset = feed.assets[0]!, owner = snapshot.owners.find(row => row.owner === "adReporting")!;
      if (mode === "expiryUnknown") { asset.expiresOn = null; asset.rightsGrant!.expiresOn = null; }
      if (mode === "organicOnly") asset.rightsGrant!.usageScope = ["organicRepost"];
      if (mode === "rightsUnknown") asset.rights = "unknown";
      if (mode === "partial") { feed.coverage = "partial"; owner.coverage = "partial"; }
      if (mode === "error") feed.syncState = "error";
      if (mode === "ownerStale") owner.sourceAsOf = new Date(fixture.state.now - 27 * 3_600_000).toISOString();
    });
    const evidence = (await readPaid(f)).data.assets.find(asset => asset.label === "AD-01")!.rightsEvidence;
    expect(evidence.state).toBe(mode === "partial" || mode === "error" ? "partial" : mode === "ownerStale" ? "stale" : "unknown");
    expect(evidence.reasonCodes.length).toBeGreaterThan(0); expect(evidence.grant).not.toBeNull();
  });
  it("binds public asset selection to platform when raw asset identifiers coincide", async () => {
    const f = paidFixture(snapshot => {
      const meta = snapshot.facts.ads!.snapshot.feeds[0]!.assets[0]!, tiktok = snapshot.facts.ads!.snapshot.feeds[1]!.assets[0]!;
      tiktok.assetRef = meta.assetRef; tiktok.rightsGrant!.assetRef = meta.assetRef;
    });
    const { data } = await readPaid(f), meta = data.assets.find(asset => asset.label === "AD-01")!, tiktok = data.assets.find(asset => asset.label === "AD-03")!;
    expect(meta.assetRef).not.toBe(tiktok.assetRef);
    expect(meta.rightsEvidence.grant!.platform).toBe("meta"); expect(tiktok.rightsEvidence.grant!.platform).toBe("tiktok");
  });
  it("expires the publication at the shortest still-current grant lease and retains final denial checks", async () => {
    const f = paidFixture((snapshot, fixture) => {
      const owner = snapshot.owners.find(row => row.owner === "adReporting")!;
      snapshot.facts.ads!.snapshot.feeds[0]!.assets[0]!.rightsGrant!.observedAt = new Date(fixture.state.now - owner.maxAgeMs + 1000).toISOString();
    });
    const result = await readPaid(f);
    expect(result.data.provenance.validUntil).toBe(new Date(f.state.now + 1000).toISOString());
    f.state.allowed = false;
    expect(() => result.assertCurrent()).toThrowError(expect.objectContaining({ code: "ANALYTICS_SOURCE_DENIED" }));
    f.state.allowed = true; f.state.now += 1000;
    expect(() => result.assertCurrent()).toThrowError(expect.objectContaining({ code: "ANALYTICS_PUBLICATION_EXPIRED" }));
  });
  it.each([
    { timezone: "UTC", at: "2026-11-01T23:59:59Z", startAt: "2026-10-01T00:00:00Z", endAt: "2026-11-01T00:00:00Z" },
    { timezone: "America/Los_Angeles", at: "2026-11-02T07:59:59Z", startAt: "2026-10-01T07:00:00Z", endAt: "2026-11-01T07:00:00Z" },
  ])("ends rights publication exactly at the expiry-day boundary in $timezone", async ({ timezone, at, startAt, endAt }) => {
    const f = paidFixture(snapshot => {
      const asset = snapshot.facts.ads!.snapshot.feeds[0]!.assets[0]!;
      asset.expiresOn = "2026-11-01"; asset.rightsGrant!.expiresOn = asset.expiresOn;
    });
    f.state.now = Date.parse(at);
    const request = { ...f.request("paidMedia"), period: { startAt, endAt, timezone, basis: "eventTime" } };
    const first = await f.reader.read(request, f.principal);
    if (first.data.viewKey !== "paidMedia") throw new Error("Wrong fixture view");
    expect(first.data.assets.find(asset => asset.label === "AD-01")!.rightsEvidence.state).toBe("available");
    expect(first.data.provenance.validUntil).toBe(new Date(f.state.now + 1000).toISOString());
    f.state.now += 1000;
    expect(() => first.assertCurrent()).toThrowError(expect.objectContaining({ code: "ANALYTICS_PUBLICATION_EXPIRED" }));
    const second = await f.reader.read(request, f.principal);
    if (second.data.viewKey !== "paidMedia") throw new Error("Wrong fixture view");
    expect(second.data.assets.find(asset => asset.label === "AD-01")!).toMatchObject({ rights: "expired", rightsEvidence: { state: "expired", reasonCodes: ["RIGHTS_EXPIRED"] } });
  });
  it("keeps the selected grant attached through filtered signed pagination", async () => {
    const f = paidFixture(), request = { ...f.request("paidMedia"), filters: { platform: "meta", rights: "all" }, page: { cursor: null, limit: 1 } };
    const first = await f.reader.read(request, f.principal);
    if (first.data.viewKey !== "paidMedia") throw new Error("Wrong fixture view");
    expect(first.data.assets[0]!.rightsEvidence.state).toBe("available");
    const second = await f.reader.read({ ...request, page: { cursor: first.page.nextCursor, limit: 1 } }, f.principal);
    if (second.data.viewKey !== "paidMedia") throw new Error("Wrong fixture view");
    expect(second.data.assets).toHaveLength(1); expect(second.data.assets[0]!.label).toBe("AD-04");
    expect(second.data.assets[0]!.rightsEvidence.state).toBe("stale");
  });
});
