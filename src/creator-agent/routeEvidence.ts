import { z } from "zod";
import type { EvidencePacket } from "./evidence.ts";
import type { OfferRepository } from "./offers/repository.ts";

const text = z.string().trim().min(1).max(500);
const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
const route = z.enum(["website", "tiktok-shop"]);
const status = z.enum(["pass", "fail", "unknown"]);
const currency = z.string().regex(/^[A-Z]{3}$/);
const metricName = z.enum(["gmv", "orders", "items", "refundAmount", "refundedOrders", "retainedSales", "creatorPayout"]);
const countMetrics = new Set(["orders", "items", "refundedOrders"]);
const metricSchema = z.object({
  name: metricName, value: z.number().int().safe(), unit: z.enum(["count", "minorCurrency"]),
  currency: currency.nullable(), definition: text, denominator: text, windowStart: instant, windowEnd: instant,
  sampleSize: count, maturity: z.enum(["mature", "open", "unknown"]), sourceRef: text,
}).strict().superRefine((m, ctx) => {
  const isCount = countMetrics.has(m.name);
  if (isCount !== (m.unit === "count") || isCount !== (m.currency === null) || (isCount && m.value < 0))
    ctx.addIssue({ code: "custom", message: "Preserve the source metric's unit, currency and denominator." });
  if (Date.parse(m.windowEnd) <= Date.parse(m.windowStart))
    ctx.addIssue({ code: "custom", message: "Metric windows must have positive duration." });
});
const receipt = z.object({ status, sourceRef: text }).strict();
const terms = z.object({
  origin: z.enum(["provider", "saved-offer"]), offerId: text, version: text, manifestHash: text, acceptedRef: text, termsRevision: text,
  shopAdsRateBps: count.max(10000).nullable(),
  provider: text, programId: text, programVersion: text, currency,
  commission: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("percentage"), basisPoints: count.max(10000) }).strict(),
    z.object({ kind: z.literal("perSale"), amountMinor: count.positive(), supportedByProvider: z.boolean() }).strict(),
  ]), eligibleBase: text, refundRule: text, guaranteedFeeMinor: count,
}).strict();
const attributionTest = z.object({
  expectedProviderCredit: z.boolean(), orderId: text, refundOfOrderId: text, refundApplied: z.boolean(), sourceRef: text,
}).strict();
const website = z.object({
  kind: z.literal("website"), linkOrCodeRef: text.nullable(), attributionPrecedence: text.nullable(),
  test: attributionTest.nullable(),
}).strict();
const rate = z.object({ basisPoints: count.max(10000), version: text, sourceRef: text }).strict();
const shop = z.object({
  kind: z.literal("tiktok-shop"), sellerRef: text, productRef: text, creatorEligibility: receipt, sellerEligibility: receipt,
  productEligibility: receipt, nativeAttribution: receipt, standardRate: rate.nullable(),
  adsRate: z.discriminatedUnion("state", [
    z.object({ state: z.literal("applicable"), rate }).strict(),
    z.object({ state: z.literal("notApplicable"), sourceRef: text }).strict(),
    z.object({ state: z.literal("unknown") }).strict(),
  ]),
}).strict();
const criterionEvidence = z.object({
  id: z.enum(["verifiedCommerce", "audienceAlignment", "reliability", "offerEconomics"]),
  sourceRefs: z.array(text).min(1).max(30), rating: count.max(5), rationale: text,
}).strict();
const audience = z.object({
  sourceRef: text, denominator: text, sampleSize: count.positive(), windowStart: instant, windowEnd: instant,
  country: text, age: text, language: text, alignment: status,
}).strict().refine((a) => Date.parse(a.windowEnd) > Date.parse(a.windowStart), { message: "Audience needs an ordered source window." });

/** Independent, server-supplied evidence snapshot; this is never accepted from a dashboard POST/PUT. */
export const sourceSnapshotSchema = z.object({
  workspaceId: text, accountId: text, creatorId: text, creatorSourceId: text, checkoutRoute: route, evidenceRevision: text, termsRevision: text,
  sourceRef: text, observedAt: instant, validUntil: instant, provider: text, market: text, programId: text, programVersion: text,
  programEligibility: receipt, supportedClaims: receipt.nullable(), terms: terms.nullable(), commerce: z.discriminatedUnion("kind", [website, shop]),
  metrics: z.array(metricSchema).max(50), audience: audience.nullable(), reliability: receipt.nullable(), economics: receipt.nullable(),
  criteria: z.array(criterionEvidence).max(4),
}).strict().superRefine((s, ctx) => {
  if (s.checkoutRoute !== s.commerce.kind || new Set(s.criteria.map(c => c.id)).size !== s.criteria.length)
    ctx.addIssue({ code: "custom", message: "Source snapshot must describe one route with unique criterion claims." });
  if (s.metrics.some(m => Date.parse(m.windowEnd) > Date.parse(s.observedAt)) || (s.audience && Date.parse(s.audience.windowEnd) > Date.parse(s.observedAt)))
    ctx.addIssue({ code: "custom", message: "Source proof cannot include a measurement window in its future." });
  if (Date.parse(s.validUntil) <= Date.parse(s.observedAt))
    ctx.addIssue({ code: "custom", message: "Source proof requires an explicit validity interval." });
});
export type ScorecardSourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
type ScorecardSubject = Pick<ScorecardSourceSnapshot, "workspaceId" | "accountId" | "creatorId" | "checkoutRoute" | "evidenceRevision" | "termsRevision">;
export type ScorecardAuthority = { resolve(subject: ScorecardSubject): Promise<unknown> | unknown };
export type ScorecardProof = { snapshot: ScorecardSourceSnapshot | null; reason: string };
const unavailable = (reason: string): ScorecardProof => ({ snapshot: null, reason });

export async function resolveScorecardEvidence(authority: ScorecardAuthority | undefined,
  scope: Pick<ScorecardSubject, "workspaceId" | "accountId">, packet: EvidencePacket, nowMs = Date.now(),
  readAccepted?: OfferRepository["acceptedTerms"]): Promise<ScorecardProof> {
  if (!authority) return unavailable("SOURCE_NOT_CONNECTED");
  const subject: ScorecardSubject = { ...scope, creatorId: packet.creatorId, checkoutRoute: packet.checkoutRoute, evidenceRevision: packet.evidenceRevision, termsRevision: packet.termsRevision };
  let input: unknown;
  try { input = await authority.resolve(subject); } catch { return unavailable("SOURCE_UNAVAILABLE"); }
  if (!input) return unavailable("SOURCE_UNAVAILABLE");
  const parsed = sourceSnapshotSchema.safeParse(input);
  if (!parsed.success) return unavailable("SOURCE_SCHEMA_INVALID");
  const s = parsed.data;
  if ((Object.keys(subject) as (keyof ScorecardSubject)[]).some(key => s[key] !== subject[key])) return unavailable("SOURCE_SCOPE_OR_VERSION_MISMATCH");
  if (Date.parse(s.observedAt) > nowMs || Date.parse(s.validUntil) <= nowMs) return unavailable("SOURCE_STALE");
  if (s.terms?.origin === "saved-offer" && !matchesAcceptedOffer(s, readAccepted))
    return { snapshot: { ...s, terms: null }, reason: "ACCEPTED_OFFER_MISSING_OR_CHANGED" };
  return { snapshot: s, reason: "SOURCE_VERIFIED" };
}

/** Bind the provider's claimed accepted terms to the actual current scoped offer record. */
function matchesAcceptedOffer(s: ScorecardSourceSnapshot, readAccepted: OfferRepository["acceptedTerms"] | undefined) {
  const t = s.terms!;
  const offer = readAccepted?.(t.offerId);
  if (!offer || offer.version !== t.version || offer.manifestHash !== t.manifestHash || offer.creatorId !== s.creatorId
    || offer.route !== s.checkoutRoute || offer.acceptedRef !== t.acceptedRef || offer.currency !== t.currency
    || offer.provider.provider !== s.provider || offer.provider.programRef !== s.programId
    || offer.commission.base !== t.eligibleBase || offer.provider.refundRule !== t.refundRule
    || offer.commission.shopAdsRateBps !== t.shopAdsRateBps) return false;
  return t.commission.kind === "percentage"
    ? offer.commission.type === "percentage" && offer.commission.standardRateBps === t.commission.basisPoints
    : offer.commission.type === "fixed-per-sale" && offer.commission.fixedMinor === t.commission.amountMinor && offer.provider.supportsFixedPerSale;
}

type Gate = { id: string; state: z.infer<typeof status>; reason: string };
function gate(id: string, value: z.infer<typeof status> | undefined, ref?: string): Gate {
  return { id: `SOURCE:${id}`, state: value ?? "unknown", reason: ref ?? "Required provider evidence is unknown." };
}
const meets = (v: boolean | null) => v === null ? "unknown" : v ? "pass" : "fail";
export function sourceGates(packet: EvidencePacket, proof: ScorecardProof | undefined): Gate[] {
  const s = proof?.snapshot;
  if (!s) return [gate("route", "unknown", proof?.reason)];
  const t = s.terms;
  const scopeMatches = t && t.termsRevision === packet.termsRevision && t.provider === s.provider && t.programId === s.programId && t.programVersion === s.programVersion;
  const routeCommissionMatches = t && (s.commerce.kind === "website"
    ? t.commission.kind === "percentage" || t.commission.supportedByProvider
    : t.commission.kind === "percentage" && s.commerce.standardRate !== null && t.commission.basisPoints === s.commerce.standardRate.basisPoints
      && (s.commerce.adsRate.state === "applicable" ? t.shopAdsRateBps === s.commerce.adsRate.rate.basisPoints : t.shopAdsRateBps === null));
  const gates = [
    gate("route", s.programEligibility.status, s.programEligibility.sourceRef),
    gate("terms", meets(t && !!scopeMatches && t.guaranteedFeeMinor === 0 && !!routeCommissionMatches), t?.acceptedRef),
    gate("audience", s.audience?.alignment, s.audience?.sourceRef),
    gate("supportedClaims", s.supportedClaims?.status, s.supportedClaims?.sourceRef),
    gate("offerEconomics", s.economics?.status, s.economics?.sourceRef),
  ];
  const c = s.commerce;
  if (c.kind === "website") {
    const test = c.test;
    gates.push(gate("websiteLink", c.linkOrCodeRef ? "pass" : "unknown", c.linkOrCodeRef ?? undefined),
      gate("attributionPrecedence", c.attributionPrecedence ? "pass" : "unknown", c.attributionPrecedence ?? undefined),
      gate("orderRefundTest", meets(test && test.expectedProviderCredit && test.refundApplied && test.orderId === test.refundOfOrderId), test?.sourceRef));
  } else {
    for (const [id, r] of [["seller", c.sellerEligibility], ["creator", c.creatorEligibility], ["product", c.productEligibility], ["nativeAttribution", c.nativeAttribution]] as const)
      gates.push(gate(id, r.status, r.sourceRef));
    gates.push(gate("standardRate", c.standardRate ? "pass" : "unknown", c.standardRate?.sourceRef),
      gate("shopAdsRate", c.adsRate.state === "unknown" ? "unknown" : "pass",
        c.adsRate.state === "applicable" ? c.adsRate.rate.sourceRef : c.adsRate.state === "notApplicable" ? c.adsRate.sourceRef : undefined));
  }
  return gates;
}

/** Commercial ratings require the relevant provider's underlying fact, not a generic reviewer reference. */
export function criterionSource(s: ScorecardSourceSnapshot | null | undefined, id: string): string[] | null {
  if (!s) return null;
  const claim = s.criteria.find(c => c.id === id);
  if (!claim) return null;
  let eligibleRefs: string[];
  switch (claim.id) {
    case "verifiedCommerce":
      eligibleRefs = s.metrics.filter(m => m.name === "retainedSales" && m.maturity === "mature" && m.sampleSize > 0).map(m => m.sourceRef);
      break;
    case "audienceAlignment": eligibleRefs = s.audience && s.audience.alignment !== "unknown" ? [s.audience.sourceRef] : []; break;
    case "reliability": eligibleRefs = s.reliability && s.reliability.status !== "unknown" ? [s.reliability.sourceRef] : []; break;
    case "offerEconomics": eligibleRefs = s.economics && s.economics.status !== "unknown" ? [s.economics.sourceRef] : []; break;
  }
  return claim.sourceRefs.every(ref => eligibleRefs.includes(ref)) ? claim.sourceRefs : null;
}

export const routeAssessmentSchema = z.object({
  route, status: z.enum(["verified", "unknown", "failed"]), reason: text, sourceRef: text.nullable(),
  provider: text.nullable(), programId: text.nullable(), programVersion: text.nullable(), market: text.nullable(),
  creatorSourceId: text.nullable(), observedAt: instant.nullable(), validUntil: instant.nullable(), coveredWeight: count.max(100),
  metrics: z.array(metricSchema).max(50),
  confidence: z.object({
    completePublicReviews: count, distinctPublicationDates: count, commentsObservedPosts: count, unassessedAudioPosts: count,
    verifiedCriteria: count, configuredCriteria: count, sourceCoverage: z.enum(["unknown", "partial", "complete"]),
  }).strict(),
  criteria: z.array(z.object({ id: text, rating: count.max(5).nullable(), anchor: text.nullable(), sourceRefs: z.array(text), rationale: text.nullable() }).strict()),
  comparison: z.object({ status: z.enum(["known", "partial", "incomparable", "unknown"]), count, median: z.number().nullable(),
    spread: count.nullable(), definition: text.nullable(), window: text.nullable(), paid: z.enum(["yes", "no", "unknown"]).nullable(),
    firstPublishedAt: instant.nullable(), lastPublishedAt: instant.nullable() }).strict(),
  /** The exact accepted manifest, native commission programs and provider test evidence remain auditable after a restart. */
  commerce: z.discriminatedUnion("kind", [website, shop]).nullable(), acceptedTerms: terms.nullable(), audience: audience.nullable(),
}).strict();
export function isScorecardProofExpired(a: { routeEvidence?: z.infer<typeof routeAssessmentSchema> }, nowMs = Date.now()) {
  const until = a.routeEvidence?.validUntil;
  return until != null && Date.parse(until) <= nowMs;
}
