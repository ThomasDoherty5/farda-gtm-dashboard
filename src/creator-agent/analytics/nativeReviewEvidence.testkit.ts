import type { NativeAnalyticsSnapshot } from "./contract.ts";
import type { AdAssetRightsGrant } from "./sources.ts";

/** Fictional source evidence for detail tests and actual-service browser fixtures. No provider read or write. */
export function addNativeReviewEvidence(snapshot: NativeAnalyticsSnapshot, now: number) {
  if (snapshot.viewKey === "attribution") {
    const owner = snapshot.owners.find(value => value.owner === "commerceOrders");
    const feed = snapshot.facts.orders?.snapshot.feeds.find(value => value.channel === "shopify" && value.origin === "native");
    if (!owner || !feed || feed.orders.length < 2) throw new Error("Fictional order detail requires the existing commerce fixture");
    const evidence = (reason: "unrecognizedCode" | "notEvaluated" | "missingTracking") => ({ reason, sourceVersion: owner.sourceVersion, observedAt: feed.observedAt, evidenceRefs: [`fictional-attribution-${reason}`] });
    feed.orders[0] = { ...feed.orders[0]!, attribution: "code", codeOwner: "unknown", attributionEvidence: evidence("unrecognizedCode") };
    feed.orders[1] = { ...feed.orders[1]!, attribution: null, codeOwner: null, attributionEvidence: evidence("notEvaluated") };
    const unmatched = feed.orders.find(row => row.attribution === "unattributed");
    if (unmatched) unmatched.attributionEvidence = evidence("missingTracking");
  }
  if (snapshot.viewKey === "paidMedia") {
    const owner = snapshot.owners.find(value => value.owner === "adReporting");
    const meta = snapshot.facts.ads?.snapshot.feeds.find(value => value.platform === "meta");
    const tiktok = snapshot.facts.ads?.snapshot.feeds.find(value => value.platform === "tiktok");
    if (!owner || !meta?.assets[0] || !tiktok?.assets[0]) throw new Error("Fictional rights detail requires both existing ad feeds");
    const day = (at: number) => new Date(at).toISOString().slice(0, 10);
    const grant = (assetRef: string, platform: "meta" | "tiktok", expiresOn: string, observedAt: string): AdAssetRightsGrant => ({
      assetRef, platform, accountRef: owner.accountRef, sourceVersion: owner.sourceVersion, usageScope: ["paidAdvertising", "creatorHandleAdvertising"],
      agreementRef: `fictional-agreement-${assetRef}`, agreementVersion: "fictional-agreement-v2", grantVersion: "fictional-grant-v3",
      evidenceRefs: [`fictional-grant-evidence-${assetRef}`], observedAt, expiresOn,
    });
    const future = day(now + 90 * 86_400_000), past = day(now - 86_400_000);
    meta.assets[0].rights = "cleared"; meta.assets[0].expiresOn = future;
    meta.assets[0].rightsGrant = grant(meta.assets[0].assetRef, "meta", future, meta.observedAt);
    tiktok.assets[0].rights = "expired"; tiktok.assets[0].expiresOn = past;
    tiktok.assets[0].rightsGrant = grant(tiktok.assets[0].assetRef, "tiktok", past, tiktok.observedAt);
    const staleRef = "fictional-meta-stale-asset";
    if (!meta.assets.some(asset => asset.assetRef === staleRef)) meta.assets.push({
      assetRef: staleRef, label: "AD-04", clicks: 1, impressions: 1000, rights: "cleared", expiresOn: future,
      rightsGrant: grant(staleRef, "meta", future, new Date(now - owner.maxAgeMs - 1000).toISOString()),
    });
  }
}
