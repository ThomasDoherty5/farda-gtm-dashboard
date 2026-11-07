import { CLOCK_SKEW_MS, type AnalyticsSourceKey, type ReportingWindow } from "./sources.ts";

/**
 * Server-computed measures for the THO-293 analytics reads. Every measure states its numerator, denominator, window and
 * provenance, and keeps a known zero, unknown and not-applicable apart: a missing input is unknown with a reason, and a zero
 * denominator is not applicable. Nothing here ever turns a missing value into 0.
 */
export type FreshnessState = "current" | "noChange" | "partial" | "error" | "neverSynced";
export type MeasureUnit = "usdMinor" | "count" | "multiple" | "percent" | "stars";
export type Operand = { label: string; value: number | null; reasonCode: string | null };
export type Measure = {
  key: string; label: string; unit: MeasureUnit;
  state: "known" | "unknown" | "notApplicable"; value: number | null; reasonCode: string | null;
  numerator: Operand; denominator: Operand | null;
  window: ReportingWindow; provenance: string[]; freshnessState: FreshnessState;
  /** The server's definition: numerator, denominator, cohort and refund treatment. Never source text. */
  definition: string;
};

/** Worst first. A measure is only as fresh as its least fresh input. */
const FRESHNESS_RANK: Record<FreshnessState, number> = { error: 0, neverSynced: 1, partial: 2, noChange: 3, current: 4 };
export const worstFreshness = (states: FreshnessState[]): FreshnessState =>
  states.reduce<FreshnessState>((worst, s) => (FRESHNESS_RANK[s] < FRESHNESS_RANK[worst] ? s : worst), "current");

export const operand = (label: string, value: number | null, reasonCode: string | null = null): Operand =>
  ({ label, value, reasonCode: value === null ? reasonCode ?? "UNKNOWN_INPUT" : null });

type Context = { window: ReportingWindow; provenance: string[]; freshness: FreshnessState[] };

/** Definitions by measure key (the part before any "."). */
export const DEFINITIONS: Record<string, string> = {
  netReceipts: "Sum of net receipts of valid orders placed in the period, after refunds and cancellations posted to date for those orders. Refunds of orders placed before the period are corrections to that earlier period and are reported separately.",
  validOrders: "Count of the source-defined valid order cohort placed in the period (paid, not test or cancelled), counted once across channels by canonical order identity. Fully refunded orders stay in the cohort with $0 net.",
  aov: "Net receipts ÷ valid orders in the same cohort (THO-196). Valid orders with $0 net after refunds stay in the denominator, so refunds lower AOV rather than shrinking the cohort.",
  zeroNetValidOrders: "Valid orders in the cohort whose net receipts are $0 after refunds. They are included in the AOV denominator.",
  priorPeriodRefundCorrections: "Refunds posted in this period for orders placed before it. A correction to the earlier period, not a reduction of this period's net receipts.",
  paidMediaSpend: "Meta and TikTok ad spend in the period, including GMV Max. Creator commissions and sample costs are payables and are not included.",
  mer: "Net receipts ÷ total marketing spend in the same period. Total marketing spend includes creator costs, which this service does not read, so MER is unknown here.",
  blendedCac: "Included acquisition cost ÷ distinct new retained customers. Acquisition cost includes creator costs, which this service does not read.",
  discountCodeOrders: "Valid orders attributed to any discount code, creator or sitewide.",
  creatorCodeOrders: "Valid orders attributed to a discount code the source marks as a creator's code. Sitewide promotions are excluded; an unverified code owner makes this unknown.",
  creatorCodeNetReceipts: "Net receipts of creator-code orders, with the same refund treatment as net receipts.",
  newRetainedCustomers: "Distinct customers (by the source's customer reference) whose first order is in the period and who were not fully refunded. Unknown when the source cannot identify customers.",
  contribution: "Net receipts less product, shipping, transaction and variable fulfilment costs. Landed costs are not read here, so it is unknown.",
  platformRoas: "That platform's reported purchase value ÷ that platform's spend on standard campaigns. Platform-reported, not MER, never summed across platforms, and never including GMV Max.",
  gmvMaxSpend: "TikTok GMV Max spend. Its reported value is not incremental and is excluded from platform ROAS.",
  ctr: "Clicks ÷ impressions on standard campaigns.",
  storeConversion: "Valid Shopify orders ÷ Shopify storefront sessions from one selected source. TikTok Shop orders are excluded.",
  globalAov: "Net receipts ÷ valid orders across both channels, as AOV.",
  supportLoad: "Support tickets ÷ delivered units in the source's delivered-unit window × 100.",
  returnRate: "Returned units ÷ delivered units in the same delivered-unit window × 100.",
  averageRating: "Rating points ÷ rated reviews, all time. Unrated reviews are excluded.",
};
const definitionOf = (key: string) => DEFINITIONS[key.split(".")[0]!] ?? "Server-computed measure.";

/** A directly observed amount or count. */
export function observed(key: string, label: string, unit: MeasureUnit, input: Operand, ctx: Context): Measure {
  const valid = input.value === null || Number.isSafeInteger(input.value) && input.value >= 0;
  return {
    key, label, unit, numerator: input, denominator: null, window: ctx.window, provenance: [...ctx.provenance].sort(),
    freshnessState: worstFreshness(ctx.freshness), definition: definitionOf(key),
    ...(input.value === null ? { state: "unknown" as const, value: null, reasonCode: input.reasonCode ?? "UNKNOWN_INPUT" }
      : valid ? { state: "known" as const, value: input.value, reasonCode: null }
      : { state: "unknown" as const, value: null, reasonCode: "INVALID_INPUT" }),
  };
}

/**
 * numerator ÷ denominator, scaled (100 for a percentage). Unknown input: unknown with that input's reason. Zero denominator:
 * not applicable. A non-integer or negative input is invalid and never shown as a value.
 */
export function ratio(key: string, label: string, unit: MeasureUnit, numerator: Operand, denominator: Operand, ctx: Context, scale = 1): Measure {
  const base = { key, label, unit, numerator, denominator, window: ctx.window, provenance: [...ctx.provenance].sort(), freshnessState: worstFreshness(ctx.freshness), definition: definitionOf(key) };
  if (numerator.value === null) return { ...base, state: "unknown", value: null, reasonCode: numerator.reasonCode ?? "UNKNOWN_INPUT" };
  if (denominator.value === null) return { ...base, state: "unknown", value: null, reasonCode: denominator.reasonCode ?? "UNKNOWN_INPUT" };
  if (![numerator.value, denominator.value].every(v => Number.isSafeInteger(v) && v >= 0)) return { ...base, state: "unknown", value: null, reasonCode: "INVALID_INPUT" };
  if (denominator.value === 0) return { ...base, state: "notApplicable", value: null, reasonCode: "ZERO_DENOMINATOR" };
  return { ...base, state: "known", value: (numerator.value * scale) / denominator.value, reasonCode: null };
}

/** Sum of known parts. Any unknown part makes the sum unknown with that part's reason; an empty list is a known zero only when stated. */
export function sumOperands(label: string, parts: Operand[]): Operand {
  const missing = parts.find(p => p.value === null);
  if (missing) return operand(label, null, missing.reasonCode);
  const total = parts.reduce((n, p) => n + (p.value as number), 0);
  return Number.isSafeInteger(total) ? operand(label, total) : operand(label, null, "AMOUNT_OUT_OF_RANGE");
}

/** D-13: the server's verdict on one source feed. Old data is `error` with `SOURCE_STALE`, because D-13 has no stale state. */
export function freshnessOf(source: AnalyticsSourceKey, feed: { lastSuccessAt: string | null; syncState: "ok" | "noChange" | "error"; coverage: "complete" | "partial" } | null,
  now: number, limitMs: number, unavailable = false): { freshnessState: FreshnessState; staleReasonCode: string | null } {
  void source;
  if (unavailable) return { freshnessState: "error", staleReasonCode: "SOURCE_UNAVAILABLE" };
  if (!feed) return { freshnessState: "neverSynced", staleReasonCode: "SOURCE_UNCONFIGURED" };
  if (feed.lastSuccessAt === null) return { freshnessState: "neverSynced", staleReasonCode: feed.syncState === "error" ? "SOURCE_SYNC_FAILED" : null };
  if (feed.syncState === "error") return { freshnessState: "error", staleReasonCode: "SOURCE_SYNC_FAILED" };
  const age = now - Date.parse(feed.lastSuccessAt);
  // A source clock slightly ahead of this service (within CLOCK_SKEW_MS) is tolerated; further ahead is unverified.
  if (!Number.isFinite(age) || age < -CLOCK_SKEW_MS) return { freshnessState: "error", staleReasonCode: "SOURCE_TIME_UNVERIFIED" };
  if (age > limitMs) return { freshnessState: "error", staleReasonCode: "SOURCE_STALE" };
  if (feed.coverage === "partial") return { freshnessState: "partial", staleReasonCode: "SOURCE_COVERAGE_PARTIAL" };
  return { freshnessState: feed.syncState === "noChange" ? "noChange" : "current", staleReasonCode: null };
}
