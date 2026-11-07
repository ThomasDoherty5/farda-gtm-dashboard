import type { AnalyticsSourceKey, ReportingWindow } from "./sources.ts";

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
};

/** Worst first. A measure is only as fresh as its least fresh input. */
const FRESHNESS_RANK: Record<FreshnessState, number> = { error: 0, neverSynced: 1, partial: 2, noChange: 3, current: 4 };
export const worstFreshness = (states: FreshnessState[]): FreshnessState =>
  states.reduce<FreshnessState>((worst, s) => (FRESHNESS_RANK[s] < FRESHNESS_RANK[worst] ? s : worst), "current");

export const operand = (label: string, value: number | null, reasonCode: string | null = null): Operand =>
  ({ label, value, reasonCode: value === null ? reasonCode ?? "UNKNOWN_INPUT" : null });

type Context = { window: ReportingWindow; provenance: string[]; freshness: FreshnessState[] };

/** A directly observed amount or count. */
export function observed(key: string, label: string, unit: MeasureUnit, input: Operand, ctx: Context): Measure {
  const valid = input.value === null || Number.isSafeInteger(input.value) && input.value >= 0;
  return {
    key, label, unit, numerator: input, denominator: null, window: ctx.window, provenance: [...ctx.provenance].sort(),
    freshnessState: worstFreshness(ctx.freshness),
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
  const base = { key, label, unit, numerator, denominator, window: ctx.window, provenance: [...ctx.provenance].sort(), freshnessState: worstFreshness(ctx.freshness) };
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
  if (!Number.isFinite(age) || age < 0) return { freshnessState: "error", staleReasonCode: "SOURCE_TIME_UNVERIFIED" };
  if (age > limitMs) return { freshnessState: "error", staleReasonCode: "SOURCE_STALE" };
  if (feed.coverage === "partial") return { freshnessState: "partial", staleReasonCode: "SOURCE_COVERAGE_PARTIAL" };
  return { freshnessState: feed.syncState === "noChange" ? "noChange" : "current", staleReasonCode: null };
}
