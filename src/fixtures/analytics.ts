import { metricDictionaryDemo } from "./headlineMetrics";
/**
 * Demo datasets for the launch and analytics screens (THO-293). Every figure here is synthetic and the screens label it so.
 * The original 12,596 / 400-order example is kept apart from the pilot 1,800 / 270 commission data and later acquisition-cohort
 * fixtures (FE01-03): money that also appears on the Overview is derived from `overviewOriginal`, so the two reconcile.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import type { Measure } from "@/adapter/viewSchemas/analytics";
import { DEMO_NOW, overviewOriginal } from "./overview";

const usd = (dollars: number): Money => ({ minorUnits: Math.round(dollars * 100), currency: "USD" });

export const DEMO_CAMPAIGN_ID = "demo-campaign-first-wave";
export const DEMO_OFFER_ID = "demo-offer-1";
export const DEMO_COLLABORATION_ID = "demo-collaboration-1";
export const DEMO_SUPPORT_CASE_ID = "demo-case-1";
export const DEMO_RETURN_ID = "demo-return-1";

export const known = <T>(value: T, evidence = "demo:analytics"): ProvenanceValue<T> => ({
  state: "known",
  value,
  reasonCode: null,
  evidenceRefs: [evidence],
  sourceRef: null,
  occurredAt: null,
  sourceUpdatedAt: DEMO_NOW,
  observedAt: DEMO_NOW,
});
export const unknown = <T>(reasonCode: string, evidence = "demo:analytics"): ProvenanceValue<T> => ({ ...known<T>(null as unknown as T, evidence), state: "unknown", value: null, reasonCode });

/** Where the figures on a screen came from and when. Read-only disclosure (CTRL-205); a label never turns a stale snapshot into current data. */
export type Provenance = { source: string; observedAt: string; timezone: string; coverage: string; stale: boolean };
const provenance = (source: string, coverage: string): Provenance => ({ source, observedAt: DEMO_NOW, timezone: "America/Los_Angeles", coverage, stale: false });

/* ---------- Launch snapshot (Figma 3:6) ---------- */

export type LaunchSnapshotData = {
  datasetKey: "launch-snapshot-demo";
  snapshotLabel: string;
  stage: string;
  launchDate: ProvenanceValue<string>;
  targetWindow: string;
  conversations: ProvenanceValue<number>;
  readyForNextStep: number;
  firstWaveSamples: ProvenanceValue<number>;
  budgetCeiling: Money;
  decisionsToUnblock: string[];
  momentum: { label: string; inConversation: number; ready: number }[];
  relativeGates: { offset: string; label: string }[];
  approvals: { initial: string; handle: string; context: string; age: string }[];
  sources: { label: string; source: string; badge: string }[];
  agentNote: string;
  provenance: Provenance;
};

export const launchSnapshotDemo: LaunchSnapshotData = {
  datasetKey: "launch-snapshot-demo",
  snapshotLabel: "Snapshot · 29 Oct 2026",
  stage: "Pre-launch",
  launchDate: unknown("LAUNCH_DATE_UNSET"),
  targetWindow: "January 2027 · target window",
  conversations: known(128),
  readyForNextStep: 32,
  firstWaveSamples: known(46),
  budgetCeiling: usd(40_000),
  decisionsToUnblock: ["Launch date", "sample window", "access"],
  // Bars are an illustrative index, drawn at one pixel per point as in the design; they are not creator counts.
  momentum: [
    { label: "Wk 1", inConversation: 44, ready: 28 },
    { label: "Wk 2", inConversation: 71, ready: 46 },
    { label: "Wk 3", inConversation: 100, ready: 62 },
    { label: "Wk 4", inConversation: 128, ready: 92 },
    { label: "Wk 5", inConversation: 158, ready: 116 },
    { label: "Wk 6", inConversation: 184, ready: 146 },
  ],
  relativeGates: [
    { offset: "L − 25", label: "First-wave samples ship" },
    { offset: "L − 7", label: "Readiness simulation" },
    { offset: "L − 4", label: "Go / revise / hold" },
  ],
  approvals: [
    { initial: "M", handle: "@mira.moves", context: "TikTok · collaboration invitation", age: "12m" },
    { initial: "S", handle: "@studio.rae", context: "Social Cat · UGC brief", age: "38m" },
    { initial: "W", handle: "@wellwithalex", context: "Creator payment · founder only", age: "1h" },
  ],
  sources: [
    { label: "Creator records", source: "Notion", badge: "Live records" },
    { label: "Orders · stock · support", source: "Google Sheets", badge: "Read-only mirror" },
    { label: "Ledger · P&L · tax", source: "QuickBooks", badge: "Read-only summary" },
  ],
  agentNote: "Browser-agent access: to validate · Zapier orchestration planned",
  provenance: provenance("Demo launch snapshot", "Illustrative sample, not connected sources"),
};

/* ---------- Launch control (Figma 14:74) ---------- */

export type LaunchGate = { id: string; gate: string; owner: string; state: "pass" | "blocked"; evidenceAction: string; evidenceKind: "task" | "run" | "proof" };
export type LaunchControlData = {
  datasetKey: "launch-control-demo";
  launchDate: ProvenanceValue<string>;
  gates: LaunchGate[];
  blockerContext: string;
  firstWaveSamples: number;
  budgetCeiling: Money;
  milestones: { milestone: string; relative: string; state: string }[];
  decision: { windowLabel: string; recorded: string; reviewOwner: string; version: string };
  provenance: Provenance;
};

const gate = (id: string, name: string, owner: string, state: LaunchGate["state"], evidenceAction: string, evidenceKind: LaunchGate["evidenceKind"]): LaunchGate => ({ id, gate: name, owner, state, evidenceAction, evidenceKind });

export const launchControlDemo: LaunchControlData = {
  datasetKey: "launch-control-demo",
  launchDate: unknown("LAUNCH_DATE_UNSET"),
  gates: [
    gate("gate-sample", "Production-spec sample accepted", "Founder", "blocked", "Open task", "task"),
    gate("gate-sc-route", "Social Cat browser route tested", "Automation", "blocked", "Open run", "run"),
    gate("gate-order", "Order → delivery → refund test", "Operations", "pass", "View proof", "proof"),
    gate("gate-creator", "Creator → content → paid test", "Creator desk", "pass", "View proof", "proof"),
    gate("gate-ledger", "Ledger and inventory reconcile", "Finance", "pass", "View proof", "proof"),
    gate("gate-consent", "Consent and four email flows", "Growth", "pass", "View proof", "proof"),
    gate("gate-privacy", "Privacy and source scope checked", "Founder", "pass", "View proof", "proof"),
    gate("gate-owners", "Source owners and fallback named", "Operations", "pass", "View proof", "proof"),
  ],
  blockerContext: "Sample acceptance · platform access",
  firstWaveSamples: 46,
  budgetCeiling: usd(40_000),
  milestones: [
    { milestone: "Samples ship", relative: "L − 25", state: "Waiting for launch date" },
    { milestone: "Daily reporting ready", relative: "L − 21", state: "Waiting for launch date" },
    { milestone: "Readiness test", relative: "L − 7", state: "Waiting for launch date" },
    { milestone: "Go / revise / hold", relative: "L − 4", state: "Waiting for launch date" },
    { milestone: "Launch pulse", relative: "L to L + 3", state: "Off" },
    { milestone: "Stage 2 media review", relative: "L + 14", state: "Waiting for launch date" },
  ],
  decision: { windowLabel: "Founder decision at L − 4 days.", recorded: "Not recorded", reviewOwner: "Founder", version: "launch-readiness@demo-0" },
  provenance: provenance("Demo launch control", "Demo test results only"),
};

/* ---------- Performance attribution (Figma 14:377) ---------- */

export type HeadlineEvidence = {
  source: "fixture" | "source"; sourceRef: string;
  cohortId: string; cohortWindow: import("../features/analytics/economicCosts").ReportingWindow;
  costScope: import("../features/analytics/economicCosts").CostScope;
  costs: import("../features/analytics/economicCosts").CostBucket[];
  retention: "mature" | "immature" | "unknown"; landedCost: "complete" | "incomplete" | "unknown";
  refundRevision: string | null;
};
export type MetricObservationScope = {
  source: "fixture" | "source"; sourceRef: string;
  cohortId: string; currency: string; period: import("../features/analytics/economicCosts").ReportingWindow;
};
export type PlatformWindow = { label: string; sourceRef: string };
export type AttributionData = {
  datasetKey: "overview-original" | "attribution-observed";
  periodLabel: string;
  reportScope?: MetricObservationScope;
  receiptScope?: MetricObservationScope;
  retainedCustomerScope?: MetricObservationScope;
  netReceipts: ProvenanceValue<Money>;
  orders: ProvenanceValue<number>;
  retainedUnits: number | null;
  contribution: ProvenanceValue<Money>;
  marketingSpend: Money | null;
  newRetainedCustomers: number | null;
  headlineEvidence?: HeadlineEvidence;
  tiktokRoasWindow?: PlatformWindow | null;
  tiktokPlatformRoas: ProvenanceValue<number>;
  channels: { key: "shopify" | "tiktok"; label: string; netReceipts: Money; orders: number }[];
  weeks: { label: string; note: string | null; shopify: Money; tiktok: Money }[];
  attribution: { key: "code" | "utm" | "platform" | "unattributed"; label: string; orders: number }[];
  creators: { handle: string; roi: number }[];
  provenance: Provenance;
  measures?: Measure[];
};

const o = overviewOriginal;
const fixtureAttributionScope = {
  source: "fixture", sourceRef: "demo:overview/report", cohortId: "fixture-all-acquisition", currency: "USD",
  period: { start: "2026-09-30", end: "2026-10-29", timezone: "America/Los_Angeles" },
} satisfies MetricObservationScope;
export const attributionDemo = {
  datasetKey: "overview-original",
  periodLabel: "30 Sep–29 Oct 2026",
  reportScope: fixtureAttributionScope,
  receiptScope: { ...fixtureAttributionScope, sourceRef: "demo:overview/order-receipts" },
  retainedCustomerScope: { ...fixtureAttributionScope, sourceRef: "demo:overview/retained-customers" },
  netReceipts: o.netReceipts,
  orders: o.orders,
  retainedUnits: 378,
  contribution: o.contribution,
  marketingSpend: o.marketingSpend,
  newRetainedCustomers: o.newRetainedCustomers,
  headlineEvidence: { source: "fixture", sourceRef: "Illustrative acquisition cost schedule", cohortId: "fixture-all-acquisition", cohortWindow: { start: "2026-09-30", end: "2026-10-29", timezone: "America/Los_Angeles" }, costScope: { cohortId: "fixture-all-acquisition", currency: "USD", period: { start: "2026-09-30", end: "2026-10-29", timezone: "America/Los_Angeles" }, coverage: "complete" },
    costs: metricDictionaryDemo.buckets, retention: "mature", landedCost: "complete", refundRevision: null },
  tiktokRoasWindow: null,
  tiktokPlatformRoas: known(2.4),
  channels: o.channels,
  // Weekly buckets in dollars; they sum to the two channel totals. Week 5 holds two days.
  weeks: [
    ["Wk 1", 1200, 680],
    ["Wk 2", 1740, 880],
    ["Wk 3", 2300, 1196],
    ["Wk 4", 2600, 1300],
    ["Wk 5", 524, 176],
  ].map(([label, shopify, tiktok]) => ({ label: label as string, note: label === "Wk 5" ? "*" : null, shopify: usd(shopify as number), tiktok: usd(tiktok as number) })),
  attribution: [
    { key: "code", label: "Discount code", orders: 180 },
    { key: "utm", label: "UTM", orders: 120 },
    { key: "platform", label: "Platform-reported", orders: 60 },
    { key: "unattributed", label: "Unattributed", orders: 40 },
  ],
  creators: [
    { handle: "@mira.moves", roi: 2.2 },
    { handle: "@studio.rae", roi: 1.8 },
    { handle: "@dailywithjo", roi: 1.4 },
    { handle: "@cozybyclaire", roi: 0.9 },
    { handle: "@oliviasunday", roi: 0.6 },
  ],
  provenance: provenance("Orders mirror · illustrative", "400 orders, 30 Sep–29 Oct 2026"),
} satisfies AttributionData;

/* ---------- Paid media (Figma 30:349) ---------- */

export type RightsState = "cleared" | "expiring" | "notGranted" | "unknown";
export type PaidMediaData = {
  datasetKey: "paid-media-demo" | "paid-media-observed";
  periodLabel: string;
  channels: { key: "meta" | "tiktok"; label: string; spend: Money | null; impressions: number; clicks: number; platformPurchaseValue: Money | null; attributionWindow?: PlatformWindow | null }[];
  creatorSampleEconomics: Money | null;
  assets: { id: string; platform: "meta" | "tiktok"; label: string; clicks: number; impressions: number; rights: RightsState; expiresInDays: number | null }[];
  /** Assets before any filter, so the table can state its denominator. */
  assetTotal: number;
  provenance: Provenance;
  measures?: Measure[];
};

export const paidMediaDemo = {
  datasetKey: "paid-media-demo",
  periodLabel: "30 Sep–29 Oct 2026",
  channels: [
    { key: "meta", label: "Meta", spend: usd(3000), impressions: 500_000, clicks: 10_000, platformPurchaseValue: usd(6300) },
    { key: "tiktok", label: "TikTok", spend: usd(2000), impressions: 300_000, clicks: 6000, platformPurchaseValue: usd(4800) },
  ],
  creatorSampleEconomics: usd(2000),
  assets: [
    { id: "AD-01", platform: "meta", label: "AD-01 · Meta", clicks: 280, impressions: 10_000, rights: "cleared", expiresInDays: null },
    { id: "AD-02", platform: "meta", label: "AD-02 · Meta", clicks: 192, impressions: 8000, rights: "cleared", expiresInDays: null },
    { id: "AD-03", platform: "tiktok", label: "AD-03 · TikTok", clicks: 120, impressions: 6000, rights: "expiring", expiresInDays: 12 },
    { id: "AD-04", platform: "tiktok", label: "AD-04 · TikTok", clicks: 64, impressions: 4000, rights: "notGranted", expiresInDays: null },
  ],
  assetTotal: 4,
  provenance: provenance("Illustrative ad-source snapshots", "Meta and TikTok ad exports pending; snapshot per asset"),
} satisfies PaidMediaData;

/* ---------- Campaign funnel (Figma 30:550) ---------- */

export type FunnelCampaign = {
  key: "instagram" | "tiktok-website" | "tiktok-shop";
  label: string;
  contactReference: number;
  steps: { contacted: number; replied: number; agreed: number; shipped: number; delivered: number; posted: number };
  giftCap: number;
  reserved: number;
  historical: { replies: number; agreements: number };
};
export type CampaignFunnelData = {
  datasetKey: "campaign-funnel-demo";
  cohort: { key: "first-wave" | "launch-a"; label: string };
  campaigns: FunnelCampaign[];
  notYetMature: number;
  historicalSource: string;
  provenance: Provenance;
};

export const campaignFunnelDemo: CampaignFunnelData = {
  datasetKey: "campaign-funnel-demo",
  cohort: { key: "first-wave", label: "First-wave cohort" },
  campaigns: [
    { key: "instagram", label: "Instagram", contactReference: 580, steps: { contacted: 400, replied: 40, agreed: 20, shipped: 18, delivered: 16, posted: 10 }, giftCap: 23, reserved: 2, historical: { replies: 46, agreements: 23 } },
    { key: "tiktok-website", label: "TikTok website", contactReference: 220, steps: { contacted: 160, replied: 12, agreed: 6, shipped: 6, delivered: 5, posted: 3 }, giftCap: 8, reserved: 0, historical: { replies: 16, agreements: 8 } },
    { key: "tiktok-shop", label: "TikTok Shop", contactReference: 600, steps: { contacted: 420, replied: 24, agreed: 12, shipped: 11, delivered: 10, posted: 6 }, giftCap: 15, reserved: 1, historical: { replies: 30, agreements: 15 } },
  ],
  notYetMature: 5,
  historicalSource: "THO-177",
  provenance: provenance("Illustrative first-wave cohort", "Historical assumptions need rebaseline"),
};

/* ---------- Commerce, support and reviews (Figma 30:721) ---------- */

export type CustomerJourneyData = CustomerJourneyDemoData | CustomerJourneyObservedData;
/** Served by the creator-agent (THO-293). A source that is not connected or did not report leaves its fields null, never 0. */
export type CustomerJourneyObservedData = Omit<CustomerJourneyDemoData, "datasetKey" | "productViewed" | "checkoutStarted" | "websiteOrders" | "tiktokOrders" | "websiteNetReceipts" | "globalAov" | "globalOrders" | "tickets" | "resolution" | "returns"> & {
  datasetKey: "customer-journey-observed";
  productViewed: number | null; checkoutStarted: number | null; websiteOrders: number | null; tiktokOrders: number | null;
  websiteNetReceipts: Money | null; globalAov: Money | null; globalOrders: number | null;
  tickets: CustomerJourneyDemoData["tickets"] | null; resolution: CustomerJourneyDemoData["resolution"] | null; returns: CustomerJourneyDemoData["returns"] | null;
  measures: Measure[];
};
export type CustomerJourneyDemoData = {
  datasetKey: "customer-journey-demo";
  commercePeriod: string;
  sessions: ProvenanceValue<number>;
  productViewed: number;
  checkoutStarted: number;
  websiteOrders: number;
  tiktokOrders: number;
  websiteNetReceipts: Money;
  globalAov: Money;
  globalOrders: number;
  deliveredUnits: ProvenanceValue<number>;
  tickets: { category: string; count: number }[];
  resolution: { byFin: number; byPeople: number; open: number };
  returns: { returned: number; received: number; awaitingInspection: number; restocked: number; quarantined: number };
  reviews: { ratedCount: ProvenanceValue<number>; stars: { star: 1 | 2 | 3 | 4 | 5; count: number }[] };
  cohorts: { metric: string; grain: string; window: string; denominator: string; inclusion: string; version: string }[];
  provenance: Provenance;
};

export const customerJourneyDemo: CustomerJourneyDemoData = {
  datasetKey: "customer-journey-demo",
  commercePeriod: "30 Sep–29 Oct 2026",
  sessions: known(16_000),
  productViewed: 2400,
  checkoutStarted: 980,
  websiteOrders: 260,
  tiktokOrders: 140,
  websiteNetReceipts: o.channels[0]!.netReceipts,
  globalAov: usd(31.49),
  globalOrders: 400,
  deliveredUnits: known(300),
  tickets: [
    { category: "Setup", count: 18 },
    { category: "Shipping", count: 12 },
    { category: "Hardware", count: 9 },
    { category: "Return / refund", count: 6 },
  ],
  resolution: { byFin: 27, byPeople: 12, open: 6 },
  returns: { returned: 18, received: 12, awaitingInspection: 6, restocked: 8, quarantined: 4 },
  reviews: {
    ratedCount: known(19),
    stars: [
      { star: 5, count: 13 },
      { star: 4, count: 4 },
      { star: 3, count: 2 },
      { star: 2, count: 0 },
      { star: 1, count: 0 },
    ],
  },
  cohorts: [
    { metric: "Store conversion", grain: "Website session", window: "30 Sep–29 Oct 2026", denominator: "Sessions from one selected storefront source", inclusion: "Shopify website orders; TikTok Shop orders excluded", version: "conversion@demo-1" },
    { metric: "Support load", grain: "Delivered customer unit", window: "Last 14 days", denominator: "300 delivered units", inclusion: "Tickets from the same delivered-unit cohort; no message text", version: "support-load@demo-1" },
    { metric: "Return rate", grain: "Delivered customer unit", window: "Last 14 days", denominator: "300 delivered units", inclusion: "Returned units; refunds are a separate event", version: "returns@demo-1" },
    { metric: "Average rating", grain: "Rated review", window: "All time, latest unique platform + review ID", denominator: "19 rated reviews; unrated excluded", inclusion: "Ratings-only feed", version: "reviews@demo-1" },
  ],
  provenance: provenance("Illustrative commerce, support and review sources", "Production feeds and source selection pending"),
};

/* ---------- Source freshness and reconciliation (GTM275) ---------- */

/** One source's own freshness. A source never inherits another's state. */
export type SourceFreshnessRow = { sourceId: string; label: string; feeds: string; lastSourceSuccessAt: string | null; staleReasonCode: string | null };
export type ReconciliationData = {
  datasetKey: "reconciliation-demo";
  asOf: string;
  freshness: SourceFreshnessRow[];
  /** Pre-built in the adapter from the datasets, so the page shows exactly what the pages state. */
  matrix: import("@/features/analytics/reconciliation").MatrixRow[];
  provenance: Provenance;
};

const hoursBefore = (h: number) => new Date(Date.parse(DEMO_NOW) - h * 3_600_000).toISOString();
export const sourceFreshnessDemo: SourceFreshnessRow[] = [
  { sourceId: "shopify-orders", label: "Shopify orders", feeds: "Overview · Performance attribution · Commerce", lastSourceSuccessAt: hoursBefore(1), staleReasonCode: null },
  { sourceId: "tiktok-shop-orders", label: "TikTok Shop orders", feeds: "Overview · Performance attribution", lastSourceSuccessAt: hoursBefore(3), staleReasonCode: "NO_CHANGE" },
  { sourceId: "ad-exports", label: "Meta and TikTok ad exports", feeds: "Paid media", lastSourceSuccessAt: hoursBefore(52), staleReasonCode: "SOURCE_SYNC_DELAYED" },
  { sourceId: "support-desk", label: "Support desk", feeds: "Commerce, support and reviews", lastSourceSuccessAt: hoursBefore(2), staleReasonCode: "PARTIAL_ROWS" },
  { sourceId: "reviews-feed", label: "Ratings-only review feed", feeds: "Commerce, support and reviews", lastSourceSuccessAt: hoursBefore(75), staleReasonCode: "SOURCE_ERROR_AUTH" },
  { sourceId: "launch-tracker", label: "Notion launch tracker", feeds: "Launch snapshot · Launch control", lastSourceSuccessAt: null, staleReasonCode: null },
];
