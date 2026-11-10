import { canonicalJson } from "../config.ts";
import { EVIDENCE_BASIS_MINIMUMS, classifyPath, evidencePolicyConfigSchema, type BlockedReport, type EvidenceBasis, type EvidencePolicyConfig,
  type PolicyChange, type ProvisionalReport, type RefusedReport } from "./contract.ts";

export function valueAt(config: EvidencePolicyConfig, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
function withValue(config: EvidencePolicyConfig, path: string, value: unknown): EvidencePolicyConfig {
  const next = structuredClone(config) as unknown as Record<string, unknown>;
  const segments = path.split("."), last = segments.pop()!;
  let cursor: Record<string, unknown> = next;
  for (const segment of segments) cursor = cursor[segment] as Record<string, unknown>;
  cursor[last] = structuredClone(value);
  return next as unknown as EvidencePolicyConfig;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Leaf-level difference between two evidence-policy configs, in canonical path order. */
export function diffConfigs(from: EvidencePolicyConfig, to: EvidencePolicyConfig, paths: readonly string[]): { path: string; before: unknown; after: unknown }[] {
  return paths.flatMap(path => same(valueAt(from, path), valueAt(to, path)) ? [] : [{ path, before: valueAt(from, path), after: valueAt(to, path) }]);
}

/**
 * Sensitive-inference guard over every free-text and reference field a person supplies in a proposal: rationales,
 * changed anchor text, basis limits and references, rollback reasons and limits, and candidate-set and candidate labels
 * and references. It refuses wording that names a health or diagnosis, protected-demographic or sales-outcome inference.
 * It is a floor, not a classifier: the named human approver still owns the review. Unchanged baseline anchors, which
 * name authorized aggregate audience dimensions, are not re-scanned.
 */
const PROHIBITED_INFERENCE: { code: string; pattern: RegExp }[] = [
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: /\b(diagnos\w*|medical condition|health condition|disorder|illness|disabilit\w*|neurodivergen\w*|pregnan\w*)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b(ethnic\w*|race|racial|religio\w*|sexual orientation|gender|sex|nationality|immigration status|age group|years old|apparent age|looks? (young|old|older|younger))\b|\baged?\s*(over|under)?\s*\d|\b\d+\s*-\s*\d+\s*(years|yrs|year-olds)\b/i },
  { code: "SALES_INFERENCE_REFUSED", pattern: /\b(predicted sales|expected sales|sales (lift|uplift|forecast|potential)|revenue|conversion rate|gmv|purchase intent|likely to (buy|purchase|convert)|buying power|spending power)\b/i },
];
export function inferenceRefusals(texts: string[]): string[] {
  const codes = new Set<string>();
  for (const value of texts) for (const rule of PROHIBITED_INFERENCE) if (rule.pattern.test(value)) codes.add(rule.code);
  return [...codes];
}

/** Applies an evidence-policy change set to a named baseline. Anything else is refused whole, never partially applied. */
export function applyChangeSet(base: EvidencePolicyConfig, changes: PolicyChange[]): { status: "ok"; config: EvidencePolicyConfig } | RefusedReport {
  const reasons = new Set<string>(), detail: string[] = [];
  const refuse = (code: string, message: string) => { reasons.add(code); detail.push(message); };
  const seen = new Set<string>();
  for (const change of changes) {
    const kind = classifyPath(change.path);
    if (kind === "numericModel") { refuse("NUMERIC_MODEL_CHANGE_REFUSED", `${change.path} is a numeric model field. This mode changes evidence-policy anchors and gates only.`); continue; }
    if (kind === "unknown") { refuse("UNKNOWN_POLICY_FIELD", `${change.path} is not an evidence-policy field.`); continue; }
    if (seen.has(change.path)) refuse("DUPLICATE_CHANGE", `${change.path} is named more than once.`);
    seen.add(change.path);
    if (change.before === undefined || change.after === undefined) refuse("CHANGE_VALUE_REQUIRED", `${change.path} needs explicit before and after values.`);
    else if (!same(valueAt(base, change.path), change.before)) refuse("STALE_BEFORE_VALUE", `${change.path} before value does not match the named baseline.`);
    else if (same(change.before, change.after)) refuse("NO_OP_CHANGE", `${change.path} does not change.`);
  }
  if (reasons.size) return { status: "refused", mode: "evidencePolicy", reasonCodes: [...reasons], detail };
  let next = base;
  for (const change of changes) next = withValue(next, change.path, change.after);
  const parsed = evidencePolicyConfigSchema.safeParse(next);
  if (!parsed.success) return { status: "refused", mode: "evidencePolicy", reasonCodes: ["INVALID_PROPOSED_CONFIG"], detail: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`) };
  return { status: "ok", config: parsed.data };
}

/**
 * Sufficiency of the recorded basis. Unknown counts block (they are never treated as zero); a known zero or an
 * invalid window blocks; known counts below the minimums produce a provisional, non-promotable report.
 */
export function assessEvidenceBasis(basis: EvidenceBasis, changes: PolicyChange[]): { status: "sufficient"; observed: { reviewedPackets: number; distinctCreators: number } } | BlockedReport | ProvisionalReport {
  const blocked: string[] = [], detail: string[] = [];
  const from = Date.parse(basis.window.from), to = Date.parse(basis.window.to);
  if (!(from < to)) { blocked.push("EVIDENCE_WINDOW_INVALID"); detail.push("The evidence window must have a start before its end."); }
  for (const key of ["reviewedPackets", "distinctCreators"] as const) {
    const value = basis[key];
    if (value.state === "unknown") { blocked.push(`EVIDENCE_${key === "reviewedPackets" ? "PACKETS" : "CREATORS"}_UNKNOWN`); detail.push(`${key} is unknown: ${value.reason}`); }
    else if (value.value === 0) { blocked.push("EVIDENCE_BASIS_EMPTY"); detail.push(`${key} is a known zero.`); }
  }
  if (basis.reviewerDisagreements.state === "unknown") detail.push(`reviewerDisagreements is unknown: ${basis.reviewerDisagreements.reason}`);
  if (blocked.length) return { status: "blocked", mode: "evidencePolicy", reasonCodes: [...new Set(blocked)], detail, numericModel: "unchanged" };
  const packets = (basis.reviewedPackets as { value: number }).value, creators = (basis.distinctCreators as { value: number }).value;
  const provisional: string[] = [];
  if (packets < EVIDENCE_BASIS_MINIMUMS.reviewedPackets) provisional.push("EVIDENCE_PACKETS_BELOW_MINIMUM");
  if (creators < EVIDENCE_BASIS_MINIMUMS.distinctCreators) provisional.push("EVIDENCE_CREATORS_BELOW_MINIMUM");
  if (provisional.length) return { status: "provisional", mode: "evidencePolicy", reasonCodes: provisional,
    detail: [`${packets}/${EVIDENCE_BASIS_MINIMUMS.reviewedPackets} reviewed packets and ${creators}/${EVIDENCE_BASIS_MINIMUMS.distinctCreators} distinct creators.`, ...detail],
    minimums: EVIDENCE_BASIS_MINIMUMS, observed: { reviewedPackets: packets, distinctCreators: creators }, changes, promotable: false };
  return { status: "sufficient", observed: { reviewedPackets: packets, distinctCreators: creators } };
}

/** Numerical calibration needs mature retained-sales cohorts. None exist, so every attempt returns this structured block. */
export function numericCalibrationBlocked(): BlockedReport {
  return { status: "blocked", mode: "numericCalibration", reasonCodes: ["NUMERIC_CALIBRATION_NOT_AVAILABLE", "MATURE_RETAINED_SALES_COHORTS_UNAVAILABLE"],
    detail: ["Numeric weight, band and outcome calibration requires mature retained-sales cohorts, which do not exist yet.",
      "The approved v3 model identities, weights, arithmetic, bands and decision rules remain unchanged."],
    numericModel: "unchanged" };
}
