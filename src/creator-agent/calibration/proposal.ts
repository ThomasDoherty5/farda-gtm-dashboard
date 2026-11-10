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
 * and references. It refuses phrasing that infers health or diagnosis, demographics or life stage, purchasing power or
 * sales outcomes about a creator or audience. Unchanged baseline anchors, which name authorized aggregate audience
 * dimensions, are not re-scanned.
 *
 * It matches inference phrasing in context, never single words, so ordinary product language ("race day bag",
 * "rich leather", "unisex tote", "teens' size backpack") passes. The patterns follow the video-evidence screen
 * (`videoEvidence/inferenceScreen.ts`); keep the two aligned until they are shared. This copy adds creators, shoppers and
 * cohorts as subjects, "aged N-M" phrasing, judgments "based on" a protected attribute, health-named cohorts and in-context
 * revenue claims. It is a floor, not a classifier: the named human approver still owns the review.
 */
const PERSON = String.raw`(?:creators?|she|he|they|her|him|them|host|presenter|viewers?|audience|followers?|buyers?|shoppers?|people|women|men)`;
const SEEMS = String.raw`(?:looks?|seems?|appears?|is|are|likely|probably|must be|might be|may be|could be|clearly|obviously)`;
const GROUP = String.raw`(?:audience|viewers|followers|demographic|crowd|buyers|shoppers|women|men|moms|mums|mothers|parents|people|creators|cohort|segment)`;
const HEALTH = String.raw`(?:pregnan\w*|ill|sick|disabled|diabetic|depressed|anxious|infertile|postpartum|menopausal|neurodivergent|autistic)`;
const ATTRIBUTE = String.raw`(?:gender|ethnicity|race|religion|age|sexual orientation|nationality|health|diagnosis|income|disability)`;

const PROHIBITED_INFERENCE: { code: string; pattern: RegExp }[] = [
  // Health or diagnosis attributed to a person, audience or cohort.
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${SEEMS}\s+(?:\w+\s+){0,2}${HEALTH}\b`, "i") },
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${PERSON}\s+(?:has|have|with|suffers? from|is living with|lives with)\s+(?:a\s+|an\s+)?(?:\w+\s+){0,2}(?:condition|disorder|illness|disease|disability|diagnosis)\b`, "i") },
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: /\b(?:diagnos(?:ed|is|e)\s+(?:with|as)|undiagnosed)\b/i },
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${HEALTH}[\s_-]+(?:${GROUP}|${PERSON}|households?|families)\b`, "i") },
  // Demographics and life stage attributed to a person or audience.
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b(?:about|around|roughly|approximately|maybe|likely|probably|looks?|seems?|appears?|over|under|above|below)\s+(?:\w+\s+){0,2}\d{1,2}\s*(?:years?\s+old|yrs?\s+old|year-olds?)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b\d{1,2}\s*(?:-|to)\s*\d{1,2}\s*(?:years?\s+old|year-olds?)\b|\bin\s+(?:her|his|their)\s+(?:early\s+|mid\s+|late\s+)?\d0s\b|\b\d0-somethings?\b|\b(?:apparent|perceived|estimated)\s+(?:age|gender|ethnicity|race)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\baged\s+(?:over\s+|under\s+)?\d{1,2}(?:\s*(?:-|to)\s*\d{1,2}|\+)?\b(?!\s*(?:days?|weeks?|months?))/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:new|expecting|pregnant|postpartum|first-time|young|older|single|stay-at-home)\s+(?:moms?|mums?|mothers?|dads?|parents?)\b|\b(?:moms?|mums?|mothers?|dads?|parents?|${GROUP})\s+(?:aged\s+|who are\s+)?(?:over|under|above|below)\s+\d{2}\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:older|younger|middle-aged|elderly|mature|teen(?:age)?|millennial|gen\s?z|boomer|female|male)\b[\w ,-]{0,30}\b${GROUP}\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${GROUP}\s+(?:is|are|skews?|skewing|leans?|trends?)\s+(?:\w+\s+){0,2}(?:older|younger|female|male|teen\w*|middle-aged)\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${SEEMS}\s+(?:\w+\s+){0,2}(?:asian|black|white|latin[ao]|latinx|hispanic|arab|gay|lesbian|straight|muslim|christian|jewish|hindu|immigrant)\b|\b(?:ethnicity|racial background|religious background|sexual orientation|immigration status|nationality)\s+(?:is|seems|appears|looks|of)\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:judged?|inferred?|based|estimated?|guessed?|assessed|scored|ranked)\s+(?:on|from|by)\s+(?:the\s+)?(?:\w+'s\s+|\w+\s+){0,2}${ATTRIBUTE}\b`, "i") },
  // Purchasing power attributed to a person or audience.
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: /\b(?:high|low|middle|upper|lower)[- ]income\b|\b(?:purchasing|buying|spending) power\b|\bdisposable income\b|\b(?:upper|middle|working)[- ]class\b/i },
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:wealthy|affluent|well-off|well off|rich|budget-conscious|low-budget|high-spending)\b[\w ,-]{0,20}\b(?:${GROUP}|households?|creators?|family|families)\b|\b${PERSON}\s+(?:can|could|cannot|can't)\s+afford\b`, "i") },
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${PERSON}\s+${SEEMS}\s+(?:\w+\s+){0,2}(?:wealthy|affluent|well-off|rich|broke|low-income|high-income)\b`, "i") },
  // Sales outcomes.
  { code: "SALES_INFERENCE_REFUSED", pattern: /\b(?:predicted|expected|projected|forecast)\s+(?:sales|revenue|gmv|conversions?)\b|\b(?:sales|revenue|gmv) (?:lift|uplift|forecast|potential)\b|\bconversion rate\b|\bpurchase intent\b|\blikely to (?:buy|purchase|convert)\b/i },
  { code: "SALES_INFERENCE_REFUSED", pattern: /\b(?:higher|more|increased?|greater|lower|less|drives?|boosts?|raises?)\s+(?:\w+\s+){0,2}(?:revenue|gmv|sales|conversions)\b/i },
];
export function inferenceRefusals(texts: string[]): string[] {
  const codes = new Set<string>();
  for (const value of texts) for (const rule of PROHIBITED_INFERENCE) if (rule.pattern.test(value)) codes.add(rule.code);
  return [...codes].sort();
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
