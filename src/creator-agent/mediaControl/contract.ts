import { z } from "zod";
import { ENVIRONMENTS, PROVIDERS, ref } from "../media/contract.ts";

/**
 * Contribution-based optimization and staged media release (THO-347). The controller sits over THO-346's guarded campaign module and
 * native delivery: it observes, proposes, checks exact approval, executes bounded changes through the media repository and reconciles.
 * Every economic parameter, report, order, health check and treasury figure comes from an injected trusted resolver. None is connected;
 * the tests use synthetic sources only. Money is integer USD minor units, and unknown stays null.
 */
export { ref };
/** A datetime that also parses to a finite instant. Zod accepts offsets such as +99:99 that Date.parse turns into NaN. */
export const time = z.string().datetime({ offset: true }).refine((v) => Number.isFinite(Date.parse(v)), "Use a valid datetime.");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const minor = z.number().int().nonnegative().max(1_000_000_000);
const bps = z.number().int().min(0).max(10_000);
const count = z.number().int().nonnegative().max(10_000_000);
export const scopeSchema = z.object({ workspaceId: ref, accountId: ref }).strict();
export type ControlScope = z.infer<typeof scopeSchema>;

/**
 * One owner-adopted parameter. Only an `adopted` value with an adoption reference and a past adoption time is used. A `proposed` value,
 * such as the 20% commission or 5% return proposals, stays unknown, and so does a missing one (null).
 */
const adopted = <T extends z.ZodTypeAny>(value: T) => z.object({
  value, state: z.enum(["adopted", "proposed"]), adoptionRef: ref.nullable(), adoptedAt: time.nullable(),
}).strict().nullable();
export const COST_COMPONENTS = ["unit-cost", "tariff", "embedded-tooling", "inbound-freight", "inventory-carrying"] as const;
export const parameterSetSchema = z.object({
  scope: scopeSchema, version: ref, observedAt: time,
  contribution: z.object({
    /** Landed COGS per unit by component. A component listed twice is a cost counted twice and makes contribution unknown. */
    landedCogsPerUnit: adopted(z.array(z.object({ component: z.enum(COST_COMPONENTS), amountMinor: minor }).strict()).min(1).max(10)),
    fulfillmentPerOrderMinor: adopted(minor), paymentFeeBps: adopted(bps), marketplaceFeeBps: adopted(bps), affiliateCommissionBps: adopted(bps),
    returnAllowanceBps: adopted(bps), otherVariablePerOrderMinor: adopted(minor),
  }).strict(),
  /** Finite diagnostic learning loss, kept apart from profitable scale criteria. */
  diagnostic: z.object({ maxTestLossMinor: adopted(minor), maxCpaMinor: adopted(minor) }).strict(),
  attributionWindow: adopted(ref),
  minimumEvidence: adopted(z.object({ orders: count, spendMinor: minor, days: z.number().int().min(0).max(365) }).strict()),
  reviewCadence: adopted(z.object({
    anchorAt: time, intervalHours: z.number().int().min(1).max(24 * 31), windowMinutes: z.number().int().min(1).max(24 * 60),
    learningWindowHours: z.number().int().min(0).max(24 * 31), safetyIntervalMinutes: z.number().int().min(1).max(24 * 60),
  }).strict().refine((c) => c.windowMinutes <= c.intervalHours * 60, "The review window fits inside the interval.")),
  freshnessMaxAgeMinutes: adopted(z.number().int().min(1).max(7 * 24 * 60)),
  stagePolicy: adopted(z.array(z.object({ ordinal: z.number().int().min(1).max(10), capMinor: minor.positive(), maxHeadroomBps: bps }).strict()).min(1).max(10)),
  founderCashCeilingMinor: adopted(minor.positive()),
  /** Owner-adopted incremental-lift evidence for campaigns whose reporting includes organic and affiliate outcomes (GMV Max). */
  incrementalEvidence: adopted(z.array(z.object({ provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS), nativeCampaignId: ref,
    evidenceRef: ref }).strict()).max(50)).optional(),
}).strict();
export type ParameterSet = z.infer<typeof parameterSetSchema>;

const allocationSchema = z.object({
  provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS), capMinor: minor.positive(),
}).strict();
export type Allocation = z.infer<typeof allocationSchema>;
/** The exact terms of one held release. The J04 decision approves their hash, so any change is a new revision. */
export const stageInputSchema = z.object({
  stageRef: ref, ordinal: z.number().int().min(1).max(10), capMinor: minor.positive(), headroomBps: bps, startAt: time, endAt: time,
  allocations: z.array(allocationSchema).min(1).max(10),
}).strict().superRefine((s, ctx) => {
  if (Date.parse(s.startAt) >= Date.parse(s.endAt)) ctx.addIssue({ code: "custom", message: "The stage ends after it starts." });
  const keys = s.allocations.map((a) => `${a.provider}|${a.providerAccountRef}|${a.environment}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "One allocation per provider account." });
  if (s.allocations.reduce((n, a) => n + a.capMinor, 0) > s.capMinor) ctx.addIssue({ code: "custom", message: "Allocations exceed the stage cap." });
});
export type StageInput = z.infer<typeof stageInputSchema>;

/** Returned by the trusted J04 resolver for a stage release. Only a current Linear decision for this exact revision and hash releases. */
export const stageDecisionSchema = z.object({
  scope: scopeSchema, sourceRef: ref, system: z.enum(["linear", "slack", "notion"]), stageRef: ref, revision: z.number().int().positive(),
  action: z.literal("release-stage"), subjectHash: hash, decision: z.enum(["approved", "rejected"]), state: z.enum(["current", "revoked"]),
  decidedAt: time, validUntil: time,
}).strict();
export type StageDecision = z.infer<typeof stageDecisionSchema>;

const conversionSchema = z.object({
  conversionId: ref, channel: z.enum(["native", "mirror"]), orderSource: ref.nullable(), orderRef: ref.nullable(), convertedAt: time, valueMinor: minor,
}).strict();
/** One provider spend/conversion report for one account (THO-191 reporting). Spend is cumulative lifetime spend per campaign. */
export const spendReportSchema = z.object({
  scope: scopeSchema, provider: z.enum(PROVIDERS), providerAccountRef: ref, environment: z.enum(ENVIRONMENTS), sourceRef: ref, currency: z.literal("USD"),
  /** The provider's data-as-of time, and when Farda read it. Separate clocks. */
  sourceUpdatedAt: time, observedAt: time,
  accountSpendMinor: minor.nullable(), accountSpendLimitMinor: minor.nullable(),
  campaigns: z.array(z.object({
    nativeCampaignId: ref, status: z.enum(["DRAFT", "PAUSED", "ACTIVE", "IN_REVIEW", "REJECTED"]), spendMinor: minor.nullable(),
    lifetimeBudgetMinor: minor.nullable(), dailyBudgetMinor: minor.nullable(), endAt: time.nullable(),
    maxDelivery: z.boolean(), autoRecharge: z.boolean(), extraDeliveryBudget: z.boolean(),
    /** GMV Max counts organic and affiliate outcomes, so its value is never incremental paid ROAS. */
    includesOrganicAffiliate: z.boolean(), attributionWindow: ref.nullable(), conversions: z.array(conversionSchema).max(10_000),
  }).strict()).max(500),
}).strict();
export type SpendReport = z.infer<typeof spendReportSchema>;

/** Canonical retained commerce orders (Shopify / TikTok Shop), never platform-attributed purchases. */
export const orderFeedSchema = z.object({
  scope: scopeSchema, sourceRef: ref, observedAt: time, complete: z.boolean(),
  orders: z.array(z.object({
    source: ref, orderRef: ref, channel: z.enum(["website", "tiktok-shop"]), placedAt: time, updatedAt: time, units: count, returnedUnits: count,
    merchandiseMinor: minor, shippingCollectedMinor: minor, refundedMerchandiseMinor: minor, refundedShippingMinor: minor,
    returnWindowClosed: z.boolean(), affiliateAttributed: z.boolean(), commissionAccruedMinor: minor.nullable(),
    /** The tested attribution match to one stage campaign, or null. */
    paidMediaMatch: z.object({ provider: z.enum(PROVIDERS), providerAccountRef: ref, nativeCampaignId: ref }).strict().nullable(),
  }).strict().refine((o) => o.returnedUnits <= o.units && o.refundedMerchandiseMinor <= o.merchandiseMinor
    && o.refundedShippingMinor <= o.shippingCollectedMinor, "Refunds and returns cannot exceed the order.")).max(100_000),
}).strict();
export type OrderFeed = z.infer<typeof orderFeedSchema>;

export const HEALTH_CHECKS = ["stock", "checkout", "rights", "permission", "measurement"] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];
const healthEntry = z.object({ state: z.enum(["ok", "failed", "unknown"]), code: ref.nullable(), observedAt: time, validUntil: time }).strict();
export const healthSchema = z.object({
  scope: scopeSchema, stageRef: ref, sourceRef: ref, checks: z.object(Object.fromEntries(HEALTH_CHECKS.map((c) => [c, healthEntry])) as
    Record<HealthCheck, typeof healthEntry>).strict(),
}).strict();

/**
 * Actual treasury position. Commitments exclude the media stages controlled here. Scheduled payouts and revenue forecasts are reported
 * but never counted as available cash; shipping float is working cash, not an expense.
 */
export const treasurySchema = z.object({
  scope: scopeSchema, sourceRef: ref, observedAt: time, founderInvestedMinor: minor.nullable(), actualCashMinor: minor.nullable(),
  workingFloatMinor: minor.nullable(), commitmentsMinor: minor.nullable(),
  /** Media spend for the stages controlled here that has already been charged to cash. Accrued spend above it is still owed. */
  mediaChargedMinor: minor.nullable(),
  scheduledPayouts: z.array(z.object({ amountMinor: minor, expectedAt: time }).strict()).max(500), revenueForecastMinor: minor.nullable(),
}).strict();

export const launchInputSchema = z.object({ campaignId: ref }).strict();
export const CHANGE_KINDS = ["increase-budget", "reduce-budget", "pause"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const changeInputSchema = z.object({
  campaignId: ref, kind: z.enum(CHANGE_KINDS), dailyBudgetMinor: minor.positive().nullable(), rationale: z.string().trim().min(1).max(500),
}).strict().refine((c) => (c.kind === "pause") === (c.dailyBudgetMinor === null), "Only a budget change carries a budget.");
export const authorizationSchema = z.union([z.object({ decisionRef: ref }).strict(), z.object({ policyRef: ref }).strict()]);
export type ChangeAuthorization = z.infer<typeof authorizationSchema>;
export const safetyInputSchema = z.object({ policyRef: ref }).strict();

export const STAGE_STATES = ["held", "awaiting-approval", "approved", "rejected", "released"] as const;
export type StageState = (typeof STAGE_STATES)[number];
export type ReservationState = "pending" | "committed" | "released";
export type Incident = { code: string; campaignId: string | null; at: string; decisionRef: string | null; resolvedAt: string | null };

export type ExposureView = {
  demonstrated: boolean; reasons: string[]; capMinor: number; spendMinor: number | null; pendingMinor: number; plannedMaxMinor: number | null;
  remainingMinor: number | null;
  allocations: { provider: string; providerAccountRef: string; environment: string; capMinor: number; spendMinor: number | null; pendingMinor: number;
    plannedMaxMinor: number | null; accountLimitMinor: number | null; accountSpendMinor: number | null }[];
  campaigns: { campaignId: string; key: string; reservation: ReservationState; status: string | null; dailyBudgetMinor: number | null; spendMinor: number | null;
    lifetimeBudgetMinor: number | null; boundMinor: number | null; endAt: string | null; sourceUpdatedAt: string | null; fresh: boolean }[];
};
export type EconomicsView = {
  parametersVersion: string | null; unknownInputs: string[];
  canonical: { complete: boolean; orders: number | null; retainedMerchandiseMinor: number | null; retainedShippingMinor: number | null;
    contributionMinor: number | null; contributionPerOrderMinor: number | null; commissionsAccruedMinor: number | null };
  platform: { comparable: boolean; purchases: number | null; valueMinor: number | null; duplicatesRemoved: number; includesOrganicAffiliate: boolean;
    incrementalPaidRoas: null; excluded: string[] };
  spendMinor: number | null; incrementalPaidOrders: number | null; canonicalCpaMinor: number | null; allowableAcquisitionCostMinor: number | null;
  diagnostic: { maxTestLossMinor: number | null; lossMinor: number | null; maxCpaMinor: number | null; state: "within" | "breached" | "unknown" };
  scale: { state: "met" | "not-met" | "unknown"; reasons: string[] };
};
export type TreasuryView = {
  state: "within" | "exceeds" | "unknown"; reasons: string[]; ceilingMinor: number | null; founderInvestedMinor: number | null;
  spendableCashMinor: number | null; commitmentsMinor: number | null; mediaExposureMinor: number; mediaChargedMinor: number | null; projectedFounderInvestedMinor: number | null;
  excludedPayoutsMinor: number; excludedForecastMinor: number | null; observedAt: string | null;
};
export type ObservationView = {
  kind: "media-release-observation"; observationId: string; stageRef: string; observedAt: string; exposure: ExposureView; economics: EconomicsView;
  health: { check: HealthCheck; state: "ok" | "failed" | "unknown"; code: string | null }[]; treasury: TreasuryView;
  freshness: { source: string; sourceUpdatedAt: string | null; observedAt: string | null; fresh: boolean }[];
  corrections: { kind: string; key: string; detail: string; at: string }[];
  /** Conditions that pause live spend under a pre-authorized safety policy. */
  safetyTriggers: string[];
  /** Conditions that hold new dispatch (launches, increases, releases) without pausing. */
  holds: string[];
  recommendations: { action: "pause" | "reduce-budget" | "hold" | "review"; reason: string }[];
  review: { open: boolean; nextReviewAt: string | null; nextSafetyCheckAt: string | null };
};
export type StageView = {
  kind: "media-release-stage"; stageRef: string; revision: number; ordinal: number; state: StageState; terms: StageInput; subjectHash: string;
  heldReasons: string[]; approval: { decision: "none" | "approved" | "rejected"; decisionRef: string | null; validUntil: string | null };
  dispatch: "open" | "held"; incidents: Incident[];
  reservations: { reservationId: string; campaignId: string; provider: string; providerAccountRef: string; environment: string; plannedMaxMinor: number;
    state: ReservationState; confirmedAt: string | null; gates: { gate: string; state: string }[] }[];
  lastObservation: ObservationView | null; history: { state: StageState; at: string; ref: string | null }[];
};
export type LaunchView = {
  kind: "media-release-launch"; stageRef: string; reservationId: string; campaignId: string; reservation: ReservationState; plannedMaxMinor: number;
  campaignState: string; heldReasons: string[]; executionCertainty: "applied" | "uncertain" | "notApplied";
};
export type ChangeView = {
  kind: "media-release-change"; changeId: string; stageRef: string; campaignId: string; changeKind: ChangeKind; dailyBudgetMinor: number | null;
  rationale: string; observationId: string; state: "held" | "awaiting-approval" | "confirmed" | "uncertain" | "rejected" | "not-applied" | "superseded";
  heldReasons: string[]; mutationId: string | null; requestHash: string | null; authorizedBy: "j04" | "safety-policy" | null;
  effect: { before: { status: string; dailyBudgetMinor: number | null } | null; after: { status: string; dailyBudgetMinor: number | null } | null };
  history: { state: string; at: string; ref: string | null }[];
};
export type SafetyRunView = {
  kind: "media-release-safety-run"; stageRef: string; observationId: string; triggers: string[];
  campaigns: { campaignId: string; outcome: "paused" | "already-paused" | "failed" | "held-in-flight"; mutationId: string | null; code: string | null }[];
  incidents: Incident[]; executionCertainty: "applied" | "uncertain" | "notApplied";
};
