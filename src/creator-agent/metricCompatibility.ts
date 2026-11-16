import { z } from "zod";
import type { MetadataBaseline, PostEvidence, PostMetric } from "./evidence.ts";
import type { RouteMetric, ScorecardSourceSnapshot } from "./routeEvidence.ts";

/**
 * J02 metric compatibility. Every derived feature declares which of the eight comparison dimensions it
 * requires, reports or does not use. A mismatch is never derived. A required dimension that the source
 * fields cannot establish is unverified, never assumed. Fields added by J20 (snapshot time, definition
 * version, refund basis, traffic mix, numerator key, per-post counters and missing reasons) are checked
 * when present; earlier packets fall back to the fields they always carried. Browser-safe: pure values.
 */
export const compatibilityDimensions = ["unit", "numeratorDenominator", "window", "cohort", "postAge", "trafficClass", "sourceDefinition", "refundBasis"] as const;
export type CompatibilityDimension = typeof compatibilityDimensions[number];
const outcome = z.enum(["match", "mismatch", "unknown", "notApplicable"]);
type Outcome = z.infer<typeof outcome>;
export const metricReasonSchema = z.enum([
  "SOURCE_PROOF_UNAVAILABLE", "RETAINED_SALES_CLAIM_MISSING", "CLAIM_SOURCE_NOT_A_METRIC", "CITED_METRIC_UNAVAILABLE",
  "UNIT_MISMATCH", "CURRENCY_MISMATCH", "COUNT_APPROXIMATE", "NUMERATOR_NOT_RETAINED", "NUMERATOR_MISMATCH", "DENOMINATOR_MISMATCH", "VIEWS_ZERO_DENOMINATOR",
  "WINDOW_MISMATCH", "WINDOW_OVERLAP", "WINDOW_LENGTH_DIFFERS", "COHORT_EMPTY", "COHORT_PARTIAL",
  "POST_AGE_SNAPSHOT_UNAVAILABLE", "POST_AGE_MISMATCH", "POST_AGE_NOT_NORMALIZED",
  "TRAFFIC_CLASS_MIXED", "TRAFFIC_CLASS_PARTIALLY_UNKNOWN", "TRAFFIC_CLASS_UNKNOWN", "TRAFFIC_CLASS_INCONSISTENT", "TRAFFIC_INCLUDES_PAID",
  "SOURCE_DEFINITION_MISMATCH", "REFUND_BASIS_GROSS", "REFUND_BASIS_MISMATCH", "REFUND_BASIS_UNKNOWN", "REFUND_BASIS_UNDECLARED", "REFUND_BASIS_LEGACY_DEFINITION",
  "REFUND_WINDOW_OPEN", "REFUND_MATURITY_UNKNOWN",
  "VIEWS_MISSING", "LIKES_MISSING", "COMMENT_TOTAL_MISSING", "SHARES_MISSING", "SAVES_MISSING",
]);
export type MetricReason = z.infer<typeof metricReasonSchema>;
const blocking = new Set<MetricReason>(["UNIT_MISMATCH", "CURRENCY_MISMATCH", "NUMERATOR_NOT_RETAINED", "NUMERATOR_MISMATCH", "DENOMINATOR_MISMATCH",
  "VIEWS_ZERO_DENOMINATOR", "WINDOW_MISMATCH", "WINDOW_OVERLAP", "COHORT_EMPTY", "POST_AGE_MISMATCH", "TRAFFIC_CLASS_MIXED", "TRAFFIC_CLASS_PARTIALLY_UNKNOWN", "TRAFFIC_CLASS_INCONSISTENT",
  "SOURCE_DEFINITION_MISMATCH", "REFUND_BASIS_GROSS", "REFUND_BASIS_MISMATCH", "REFUND_WINDOW_OPEN"]);
/** required: unknown blocks derivation. reported: unknown is retained as a caveat. notApplicable: the feature does not use it. */
type Requirement = "required" | "reported" | "notApplicable";
type Spec = Record<CompatibilityDimension, Requirement>;
const featureSpecs = {
  // Post age is not part of the bound rubric's evidence source for retained sales; traffic mix is reported without restricting it.
  verifiedCommerce: { unit: "required", numeratorDenominator: "required", window: "required", cohort: "required",
    postAge: "notApplicable", trafficClass: "reported", sourceDefinition: "required", refundBasis: "required" },
  reachBaseline: { unit: "required", numeratorDenominator: "notApplicable", window: "required", cohort: "reported",
    postAge: "reported", trafficClass: "reported", sourceDefinition: "required", refundBasis: "notApplicable" },
  engagementRate: { unit: "required", numeratorDenominator: "required", window: "required", cohort: "required",
    postAge: "required", trafficClass: "required", sourceDefinition: "required", refundBasis: "notApplicable" },
} as const satisfies Record<string, Spec>;
type Feature = keyof typeof featureSpecs;

/** derived: the inputs are compatible and the feature may be computed. No other state is ever computed. */
export const metricFeatureSchema = z.object({
  feature: z.enum(["verifiedCommerce", "reachBaseline", "engagementRate"]),
  state: z.enum(["derived", "incompatible", "unverified", "unavailable"]),
  inputCount: z.number().int().nonnegative().safe(),
  dimensions: z.object({ unit: outcome, numeratorDenominator: outcome, window: outcome, cohort: outcome, postAge: outcome,
    trafficClass: outcome, sourceDefinition: outcome, refundBasis: outcome }).strict(),
  reasons: z.array(metricReasonSchema).max(30),
}).strict().superRefine((f, ctx) => {
  const spec: Spec = featureSpecs[f.feature];
  const dims = compatibilityDimensions.map(d => [spec[d], f.dimensions[d]] as const);
  const requiredUnknown = dims.some(([need, value]) => need === "required" && value === "unknown");
  const expected = f.state === "unavailable" ? f.state : dims.some(([, value]) => value === "mismatch") ? "incompatible" : requiredUnknown ? "unverified" : "derived";
  const unusedMatches = dims.every(([need, value]) => (need === "notApplicable") === (value === "notApplicable"));
  const derivedClean = f.state !== "derived" || !f.reasons.some(r => blocking.has(r));
  if (f.state !== expected || !unusedMatches || !derivedClean || (f.state !== "derived" && !f.reasons.length))
    ctx.addIssue({ code: "custom", message: "A feature is derived only when no required dimension mismatches or is unverified, and every other state retains its typed reason." });
});
export type MetricFeature = z.infer<typeof metricFeatureSchema>;

/** `caveat` records a non-blocking reason on a dimension that still matches. */
type Check = { outcome: Outcome; reason?: MetricReason; caveat?: MetricReason };

function decide(feature: Feature, checks: Partial<Record<CompatibilityDimension, Check>>, inputCount: number, missing: MetricReason[] = []): MetricFeature {
  const spec: Spec = featureSpecs[feature];
  const reasons = new Set<MetricReason>(missing);
  let unverified = false;
  const dimensions = {} as MetricFeature["dimensions"];
  for (const d of compatibilityDimensions) {
    const check: Check = spec[d] === "notApplicable" ? { outcome: "notApplicable" } : checks[d] ?? { outcome: "unknown" };
    dimensions[d] = check.outcome;
    if (check.reason && check.outcome !== "match") reasons.add(check.reason);
    if (check.caveat && check.outcome === "match") reasons.add(check.caveat);
    if (check.outcome === "unknown" && spec[d] === "required") unverified = true;
  }
  const state = missing.length ? "unavailable" : Object.values(dimensions).includes("mismatch") ? "incompatible" : unverified ? "unverified" : "derived";
  return metricFeatureSchema.parse({ feature, state, inputCount, dimensions, reasons: [...reasons] });
}
const distinct = (values: unknown[]) => new Set(values.map(v => JSON.stringify(v))).size;
const same = (values: unknown[], reason: MetricReason): Check => ({ outcome: distinct(values) > 1 ? "mismatch" : "match", reason });
/** First mismatch, otherwise first unknown, otherwise a match that keeps the first caveat. */
const worst = (...checks: Check[]): Check => checks.find(c => c.outcome === "mismatch") ?? checks.find(c => c.outcome === "unknown")
  ?? { outcome: "match", caveat: checks.find(c => c.caveat)?.caveat };

/**
 * The refund basis is a declared J20 source fact. Measurements that predate it (no compared input declares one) keep the
 * earlier rule, the retained-sales name with a mature window, and say so with a non-blocking caveat: that match was
 * inferred from the definition, not checked against a declaration. A mix of declared and undeclared inputs cannot be compared.
 */
function refundBasis(inputs: RouteMetric[]): Check {
  const declared = inputs.map(m => m.refundBasis).filter(b => b !== undefined);
  const maturity = inputs.map(m => m.maturity);
  return worst(
    inputs.some(m => m.name === "gmv") || declared.includes("included") ? { outcome: "mismatch", reason: "REFUND_BASIS_GROSS" } : { outcome: "match" },
    declared.includes("notApplicable") || distinct(declared) > 1 ? { outcome: "mismatch", reason: "REFUND_BASIS_MISMATCH" } : { outcome: "match" },
    maturity.includes("open") ? { outcome: "mismatch", reason: "REFUND_WINDOW_OPEN" } : { outcome: "match" },
    declared.includes("unknown") ? { outcome: "unknown", reason: "REFUND_BASIS_UNKNOWN" } : { outcome: "match" },
    declared.length && declared.length < inputs.length ? { outcome: "unknown", reason: "REFUND_BASIS_UNDECLARED" } : { outcome: "match" },
    maturity.includes("unknown") ? { outcome: "unknown", reason: "REFUND_MATURITY_UNKNOWN" } : { outcome: "match" },
    { outcome: "match", caveat: declared.length ? undefined : "REFUND_BASIS_LEGACY_DEFINITION" },
  );
}
function commerceTraffic(inputs: RouteMetric[]): Check {
  const mix = inputs.map(m => m.trafficMix ?? "unknown");
  if (distinct(mix.filter(m => m !== "unknown")) > 1) return { outcome: "mismatch", reason: "TRAFFIC_CLASS_INCONSISTENT" };
  if (mix.includes("unknown")) return { outcome: "unknown", reason: "TRAFFIC_CLASS_UNKNOWN" };
  // The bound rubric does not restrict retained sales to organic traffic; paid contribution is reported, not hidden.
  return mix.some(m => m !== "organic") ? { outcome: "unknown", reason: "TRAFFIC_INCLUDES_PAID" } : { outcome: "match" };
}
/** Provider retained sales cited for the verifiedCommerce criterion. */
export function commerceCompatibility(s: ScorecardSourceSnapshot | null | undefined, citedRefs: readonly string[] | null | undefined): MetricFeature {
  if (!s) return decide("verifiedCommerce", {}, 0, ["SOURCE_PROOF_UNAVAILABLE"]);
  if (!citedRefs?.length) return decide("verifiedCommerce", {}, 0, ["RETAINED_SALES_CLAIM_MISSING"]);
  const inputs = s.metrics.filter(m => citedRefs.includes(m.sourceRef));
  // A hidden or unsupported figure stays unavailable with its reason; it is never read as zero.
  if (s.unavailableMetrics?.some(m => citedRefs.includes(m.sourceRef))) return decide("verifiedCommerce", {}, inputs.length, ["CITED_METRIC_UNAVAILABLE"]);
  if (citedRefs.some(ref => !inputs.some(m => m.sourceRef === ref))) return decide("verifiedCommerce", {}, inputs.length, ["CLAIM_SOURCE_NOT_A_METRIC"]);
  const windows = [...inputs].sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart));
  const overlap = windows.some((m, i) => i > 0 && Date.parse(m.windowStart) < Date.parse(windows[i - 1]!.windowEnd));
  const length = inputs.map(m => Date.parse(m.windowEnd) - Date.parse(m.windowStart));
  return decide("verifiedCommerce", {
    unit: inputs.some(m => m.unit !== "minorCurrency") ? { outcome: "mismatch", reason: "UNIT_MISMATCH" } : same(inputs.map(m => m.currency), "CURRENCY_MISMATCH"),
    numeratorDenominator: worst(inputs.some(m => m.name !== "retainedSales") ? { outcome: "mismatch", reason: "NUMERATOR_NOT_RETAINED" } : { outcome: "match" },
      same(inputs.map(m => m.numeratorKey ?? null), "NUMERATOR_MISMATCH"), same(inputs.map(m => m.denominator), "DENOMINATOR_MISMATCH")),
    // Repeated mature windows are separate observations. Overlap would count the same orders twice and blocks. Different
    // lengths are reported, not blocked: there is no approved period-granularity rule, and calendar months differ in length.
    window: { outcome: overlap ? "mismatch" : "match", reason: "WINDOW_OVERLAP", caveat: distinct(length) > 1 ? "WINDOW_LENGTH_DIFFERS" : undefined },
    cohort: { outcome: inputs.some(m => m.sampleSize === 0) ? "mismatch" : "match", reason: "COHORT_EMPTY" },
    trafficClass: commerceTraffic(inputs),
    sourceDefinition: same(inputs.map(m => [m.definition, m.definitionVersion ?? null, m.sourceType ?? null]), "SOURCE_DEFINITION_MISMATCH"),
    refundBasis: refundBasis(inputs),
  }, inputs.length);
}

function metadataTraffic(classes: Set<string>): Check {
  if (classes.has("yes") && classes.has("no")) return { outcome: "mismatch", reason: "TRAFFIC_CLASS_MIXED" };
  if (classes.size > 1) return { outcome: "mismatch", reason: "TRAFFIC_CLASS_PARTIALLY_UNKNOWN" };
  return classes.has("unknown") || !classes.size ? { outcome: "unknown", reason: "TRAFFIC_CLASS_UNKNOWN" } : { outcome: "match" };
}
/**
 * Verdict for the existing metadata baseline. It reads that baseline's own definition, window and paid grouping and
 * never regroups the rows, so the reach feature is derived exactly when the baseline reports a median. Recent-post
 * metadata carries no per-row snapshot time, so post age at measurement stays an explicit caveat.
 */
export function reachCompatibility(baseline: MetadataBaseline): MetricFeature {
  const v = baseline.viewStats, groups = v.groups;
  if (v.status === "unknown" || !groups.length) return decide("reachBaseline", {}, 0, ["VIEWS_MISSING"]);
  return decide("reachBaseline", {
    unit: { outcome: "match" },
    window: same(groups.map(g => g.window), "WINDOW_MISMATCH"),
    cohort: { outcome: v.status === "partial" ? "unknown" : "match", reason: "COHORT_PARTIAL" },
    postAge: { outcome: "unknown", reason: "POST_AGE_SNAPSHOT_UNAVAILABLE" },
    trafficClass: metadataTraffic(new Set(groups.map(g => g.paid))),
    sourceDefinition: same(groups.map(g => g.definition), "SOURCE_DEFINITION_MISMATCH"),
  }, v.knownCount);
}

const utcDay = (instant: string) => Math.floor(Date.parse(instant) / 86_400_000);
const ageDays = (publishedAt: string, observedAt: string) => utcDay(observedAt) - utcDay(publishedAt);
const counterReason = { views: "VIEWS_MISSING", comments: "COMMENT_TOTAL_MISSING", shares: "SHARES_MISSING", saves: "SAVES_MISSING" } as const;
/**
 * Full engagement rate = (likes + comments + shares + saves) / views for each relevant reviewed post, from one
 * source snapshot and window. J20 posts carry these counters with their missing reasons; a sampled comment list
 * is not a comment total. Any missing component keeps the rate unavailable; a partial rate is never reported under
 * this name. Zero views is an undefined rate. There is no approved age-normalization rule, so posts of different ages
 * (UTC calendar days from publication to snapshot) leave post age unverified rather than incompatible. No approved
 * criterion consumes the rate, so a compatible verdict authorizes no score change.
 */
export function engagementCompatibility(posts: readonly PostEvidence[]): MetricFeature {
  const rows = posts.filter(p => p.relevant);
  const counter = (p: PostEvidence, key: keyof typeof counterReason) => p.metrics?.find(m => m.key === key);
  const missing = new Set<MetricReason>();
  if (!rows.length || rows.some(p => p.nativeLikes.status !== "known" || !p.nativeLikes.exact)) missing.add("LIKES_MISSING");
  for (const key of Object.keys(counterReason) as (keyof typeof counterReason)[])
    if (!rows.length || rows.some(p => counter(p, key)?.value == null)) missing.add(counterReason[key]);
  if (missing.size) return decide("engagementRate", {}, rows.length, [...missing]);
  const metrics = rows.map(p => Object.fromEntries(Object.keys(counterReason).map(k => [k, counter(p, k as keyof typeof counterReason)!])) as Record<keyof typeof counterReason, PostMetric>);
  const all = metrics.flatMap(m => Object.values(m));
  return decide("engagementRate", {
    unit: all.some(m => m.approximate) ? { outcome: "unknown", reason: "COUNT_APPROXIMATE" } : { outcome: "match" },
    numeratorDenominator: metrics.some(m => m.views.value === 0) ? { outcome: "mismatch", reason: "VIEWS_ZERO_DENOMINATOR" } : { outcome: "match" },
    window: worst(...metrics.map(m => same(Object.values(m).map(c => c.window), "WINDOW_MISMATCH")), same(metrics.map(m => m.views.window), "WINDOW_MISMATCH")),
    cohort: { outcome: "match" },
    // Likes are read at the post's observation; every counter must come from that same snapshot of a dated post, observed
    // after publication. Different post ages stay unverified until an owner approves an age-normalization rule.
    postAge: rows.some(p => !p.publishedAt) ? { outcome: "unknown", reason: "POST_AGE_SNAPSHOT_UNAVAILABLE" }
      : worst(...rows.map((p, i) => same([p.observedAt, ...Object.values(metrics[i]!).map(c => c.observedAt)].map(t => Date.parse(t)), "POST_AGE_MISMATCH")),
        rows.some(p => ageDays(p.publishedAt!, p.observedAt) < 0) ? { outcome: "mismatch", reason: "POST_AGE_MISMATCH" } : { outcome: "match" },
        distinct(rows.map(p => ageDays(p.publishedAt!, p.observedAt))) > 1 ? { outcome: "unknown", reason: "POST_AGE_NOT_NORMALIZED" } : { outcome: "match" }),
    trafficClass: metadataTraffic(new Set(rows.map(p => p.context?.paid ?? "unknown"))),
    sourceDefinition: worst(...(Object.keys(counterReason) as (keyof typeof counterReason)[]).map(k => same(metrics.map(m => [m[k].definition, m[k].sourceType]), "SOURCE_DEFINITION_MISMATCH"))),
  }, rows.length);
}
