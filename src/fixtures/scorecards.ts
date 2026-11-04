/**
 * Demo records for the historical v2 scorecards and the offer draft (THO-297). Every figure is synthetic. The scorecards
 * are read-only snapshots of prior proposed models; they never rate a public creator or authorize a new acquisition.
 */
import { DEMO_CREATOR_ID, DEMO_EVIDENCE_ID } from "./ids";

export const DEMO_ASSESSMENT_CONTENT_ID = "demo-assessment-content";
export const DEMO_ASSESSMENT_TIKTOK_ID = "demo-assessment-tiktok";
export const DEMO_ASSESSMENT_SC_ID = "demo-assessment-sc-commerce";
export const DEMO_OFFER_DRAFT_ID = "demo-offer-1";
export { DEMO_CREATOR_ID, DEMO_EVIDENCE_ID };

/** A criterion's rating is an integer 0 to 5, or null when the evidence is missing. Null is not zero. */
export type Criterion = { label: string; rating: number | null; weight: number };
export type Tone = "success" | "violet" | "warning" | "neutral";
export type HistoryEntry = { version: string; model: string; policy: string; offer: string; at: string; reason: string };

/** What an assessment was made against. A change to any part invalidates readiness that depended on it. */
export type ReadinessBasis = { media: string; terms: string; policy: string };
export const ASSESSED_BASIS: ReadinessBasis = { media: "media-2026-10-29", terms: "AFF-C01@v1", policy: "policy-2026-10" };
export type BasisFields = { assessedBasis?: ReadinessBasis; currentBasis?: ReadinessBasis };

export type ScorecardRecord = BasisFields & {
  kind: "content-v2" | "tiktok-commerce-v2";
  assessmentId: string;
  creatorId: string;
  handle: string;
  modelId: string;
  title: string;
  subtitle: string;
  historicalNote: string;
  coveragePct: number | null;
  criteria: Criterion[];
  evidence: { title: string; headline: string; note: string; observed: string }[];
  gates: { label: string; badge: string; tone: Tone }[];
  decisionNote: string;
  modelNote: string;
  history: HistoryEntry[];
};

const criteria = (rows: [string, number, number][]): Criterion[] => rows.map(([label, rating, weight]) => ({ label, rating, weight }));
const OBSERVED = "Observed 29 Oct · demo";

export const contentScorecard: ScorecardRecord = {
  kind: "content-v2",
  assessmentId: DEMO_ASSESSMENT_CONTENT_ID,
  creatorId: DEMO_CREATOR_ID,
  handle: "@mira.moves",
  modelId: "CONTENT-v2",
  title: "A good fit should be easy to explain.",
  subtitle: "Social Cat · @mira.moves · synthetic CONTENT-v2 assessment · content/licensed-assets objective",
  historicalNote: "CONTENT-v2 is a prior proposed content-quality model. New acquisition is commission-only and uses the checkout-specific v3 model after evidence review and publication.",
  coveragePct: 100,
  criteria: criteria([
    ["Routine and ICP relevance", 4, 25],
    ["Demonstration and storytelling", 5, 25],
    ["Audience alignment", 4, 15],
    ["Typical distribution and response quality", 4, 10],
    ["Collaboration reliability", 3, 15],
    ["Deliverables, rights and economic fit", 5, 10],
  ]),
  evidence: [
    { title: "Content & storytelling", headline: "10–20 comparable posts", note: "Routine relevance, understandable setup, usable production.", observed: OBSERVED },
    { title: "Audience & response", headline: "Permitted aggregate evidence", note: "US/adult alignment; typical response, not one viral outlier.", observed: OBSERVED },
    { title: "Reviews & terms", headline: "Verified source records", note: "Marketplace reliability, network scope, rights and quote.", observed: OBSERVED },
  ],
  gates: [
    { label: "Identity + suppression", badge: "Demo checked", tone: "success" },
    { label: "Campaign + network", badge: "Instagram + TikTok", tone: "violet" },
    { label: "Claims + rights", badge: "Needs review", tone: "warning" },
    { label: "Quota + sample budget", badge: "Read live account", tone: "warning" },
  ],
  decisionNote: "Prior SC-v1 records remain in history. CONTENT-v2 is a proposed content model; compare results after 20 matured collaborations.",
  modelNote: "For content-only Gifted/Paid, affiliate tracking and commission payout are N/A. Paid fee/rights controls still apply. Hybrid keeps both applicable lanes and scores separately; new terms require reassessment.",
  history: [
    { version: "v1", model: "SC-v1", policy: "policy-2026-09", offer: "none", at: "2026-09-18", reason: "First synthetic assessment; preserved, never overwritten." },
    { version: "v2", model: "CONTENT-v2 (proposed)", policy: "policy-2026-10", offer: "none", at: "2026-10-29", reason: "Re-scored on the proposed content-quality model. Does not authorize a new candidate." },
  ],
};

export const tiktokScorecard: ScorecardRecord = {
  kind: "tiktok-commerce-v2",
  assessmentId: DEMO_ASSESSMENT_TIKTOK_ID,
  creatorId: DEMO_CREATOR_ID,
  handle: "@studio.rae",
  modelId: "TT-COMMERCE-v2",
  title: "Commerce potential, with proof.",
  subtitle: "TikTok Affiliate Center · @studio.rae · synthetic TT-COMMERCE-v2 assessment",
  historicalNote: "The illustrative 86-point TT-COMMERCE-v2 result is not a current acquisition decision. TikTok Shop v3 weights and bands remain unpublished; creative quality does not establish commerce performance.",
  coveragePct: 100,
  criteria: criteria([
    ["Routine and category relevance", 4, 25],
    ["Shoppable demonstration quality", 5, 20],
    ["Verified commerce evidence", 4, 20],
    ["Audience alignment", 4, 15],
    ["Sample and collaboration reliability", 4, 10],
    ["Commission and unit economics", 5, 10],
  ]),
  evidence: [
    { title: "Relevant content", headline: "10 comparable recent posts", note: "Recent public product demonstrations; supported claims only.", observed: OBSERVED },
    { title: "Commerce evidence", headline: "Authorized 30-day window", note: "Comparable native orders, conversion and refund-adjusted results; source GMV is not reconciled net sales.", observed: OBSERVED },
    { title: "Audience & reliability", headline: "Permitted aggregate evidence", note: "US/adult alignment and sample history; no health inference.", observed: OBSERVED },
  ],
  gates: [
    { label: "Identity + suppression", badge: "Demo checked", tone: "success" },
    { label: "Shop + product eligibility", badge: "To validate", tone: "warning" },
    { label: "Claims + compatibility", badge: "Needs review", tone: "warning" },
    { label: "Quota + sample budget", badge: "Read live account", tone: "warning" },
  ],
  decisionNote: "Preserve TT-v1 and versioned offers. TT-COMMERCE-v2 is proposed; calibrate after 20 matured collaborations.",
  modelNote: "Content and commerce are separate objectives. Hybrid may show both, never their average. A changed rate, fee, recipient, evidence or payload invalidates the prior assessment/approval.",
  history: [
    { version: "v1", model: "TT-v1", policy: "policy-2026-09", offer: "TT-OFFER-v1", at: "2026-09-20", reason: "First synthetic assessment; preserved, never overwritten." },
    { version: "v2", model: "TT-COMMERCE-v2 (proposed)", policy: "policy-2026-10", offer: "none", at: "2026-10-29", reason: "Re-scored on the proposed commerce model. Not a current acquisition decision." },
  ],
};

export type CommerceScorecardRecord = BasisFields & {
  kind: "sc-commerce-v2";
  assessmentId: string;
  creatorId: string;
  handle: string;
  route: string;
  coveragePct: number | null;
  /** The independent CONTENT-v2 score. It is shown beside commerce and never averaged with it. */
  contentScore: number;
  criteria: Criterion[];
  evidenceRows: { evidence: string; window: string; coverage: string; action: string; target: "evidence" | "cohort" | "offer" }[];
  gates: { badge: string; tone: Tone; title: string; detail: string }[];
  history: HistoryEntry[];
};

export const commerceScorecard: CommerceScorecardRecord = {
  kind: "sc-commerce-v2",
  assessmentId: DEMO_ASSESSMENT_SC_ID,
  creatorId: DEMO_CREATOR_ID,
  handle: "@mira.moves",
  route: "Social Cat → Instagram → Shopify website",
  coveragePct: 100,
  contentScore: 84,
  criteria: criteria([
    ["Routine + ICP", 4, 25],
    ["Shoppable demonstration", 4, 20],
    ["Verified commerce evidence", 3, 15],
    ["Audience alignment", 4, 15],
    ["Reliability", 5, 10],
    ["Offer economics", 5, 15],
  ]),
  evidenceRows: [
    { evidence: "Attributable retained orders", window: "Verified provider record + matched contract", coverage: "Complete demo", action: "Inspect evidence", target: "evidence" },
    { evidence: "Conversion and refund context", window: "Comparable cohort; net sales and rate version", coverage: "Complete demo", action: "Inspect cohort", target: "cohort" },
    { evidence: "Commerce activation", window: "Test the issued link after acceptance", coverage: "Later-stage check", action: "Open offer", target: "offer" },
  ],
  gates: [
    { badge: "Review required", tone: "warning", title: "Invite: identity + proposed terms", detail: "Suppression, claims, authorized access, feasible onboarding, budget and quota" },
    { badge: "After acceptance", tone: "neutral", title: "Ship: accepted agreement + stock", detail: "Acceptance is not required merely to invite; it is required before shipment" },
    { badge: "Before commerce", tone: "neutral", title: "Activate commerce: tracking", detail: "Issue and test the provider link/code after acceptance" },
    { badge: "Before payout", tone: "neutral", title: "Settle: creator payout setup", detail: "Waiting for creator is separate from billing, provider settlement and paid cash" },
  ],
  history: [
    { version: "v1", model: "SC-v1", policy: "policy-2026-09", offer: "AFF-01 (historical draft)", at: "2026-09-18", reason: "First synthetic assessment; preserved, never overwritten." },
    { version: "v2", model: "SC-COMMERCE-v2 (proposed)", policy: "policy-2026-10", offer: "AFF-01 (historical draft)", at: "2026-10-29", reason: "Affiliate-only draft with a $0 fixed fee. Not a current acquisition decision." },
  ],
};

/* ---------- Offer draft (Figma 65:634) ---------- */

export type Provider = "shopify-website" | "tiktok-shop";
export type OfferDraftPayload = {
  commissionPct: number;
  eligibleBase: "eligibleMerchandise";
  baseVerified: boolean;
  provider: Provider;
  networks: "instagram+tiktok" | "instagram" | "tiktok";
  upfrontFeeMinor: number;
  compensation: "percentage" | "fixedPerSale";
  sampleShippingMinor: number;
};
export type OfferDraftRecord = {
  offerId: string;
  offerCode: string;
  version: string;
  savedAt: string | null;
  recruitmentSource: string;
  payload: OfferDraftPayload;
  assumptions: { netSaleMinor: number; commerceCostMinor: number; processingPctOfCommission: number; baseOrders: number; downsideOrders: number };
};

export const offerDraftSeed: OfferDraftRecord = {
  offerId: DEMO_OFFER_DRAFT_ID,
  offerCode: "AFF-C01",
  version: "v1",
  savedAt: null,
  recruitmentSource: "Social Cat",
  payload: { commissionPct: 15, eligibleBase: "eligibleMerchandise", baseVerified: false, provider: "shopify-website", networks: "instagram+tiktok", upfrontFeeMinor: 0, compensation: "percentage", sampleShippingMinor: 2500 },
  assumptions: { netSaleMinor: 4000, commerceCostMinor: 1800, processingPctOfCommission: 2.9, baseOrders: 40, downsideOrders: 10 },
};
