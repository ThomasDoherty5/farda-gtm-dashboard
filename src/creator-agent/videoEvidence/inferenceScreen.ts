/**
 * Free-text screen for J20 intake. It refuses wording that infers health or diagnosis, demographics or life stage, or
 * purchasing power about a creator or audience. It is a floor, not a classifier: a human reviewer still owns the review.
 *
 * The first three rules are copied verbatim from the calibration-proposal screen (`inferenceRefusals` in
 * `calibration/proposal.ts`, not yet on main) so the two stay aligned; change them together. The J20 rules after them add
 * life-stage, age-threshold, audience-age and wealth wording that the calibration screen does not cover.
 * Viewer comments are not screened: they are quoted audience text, typed separately, never Farda's inference.
 */
const PROHIBITED_INFERENCE: { code: string; pattern: RegExp }[] = [
  // Aligned with calibration/proposal.ts.
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: /\b(diagnos\w*|medical condition|health condition|disorder|illness|disabilit\w*|neurodivergen\w*|pregnan\w*)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b(ethnic\w*|race|racial|religio\w*|sexual orientation|gender|sex|nationality|immigration status|age group|years old|apparent age|looks? (young|old|older|younger))\b|\baged?\s*(over|under)?\s*\d|\b\d+\s*-\s*\d+\s*(years|yrs|year-olds)\b/i },
  { code: "SALES_INFERENCE_REFUSED", pattern: /\b(predicted sales|expected sales|sales (lift|uplift|forecast|potential)|revenue|conversion rate|gmv|purchase intent|likely to (buy|purchase|convert)|buying power|spending power)\b/i },
  // J20 additions.
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: /\b(expecting a baby|postpartum|post-partum|menopaus\w*|perimenopaus\w*|infertil\w*|ivf patient|trying to conceive)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b(new (moms?|mums?|mothers?|dads?|parents?)|(moms?|mums?|mothers?|women|men|audience|viewers|followers) (over|under) \d+|(over|under) \d{2}s?\b|in (her|his|their) \d0s|\d0-somethings?|middle-aged|elderly|seniors?|teens?|teenagers?|millennials?|gen ?z|boomers?)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b(older|younger|mature)\b[\w ,-]{0,30}\b(audience|viewers|followers|demographic|crowd|women|men)\b/i },
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: /\b(income|wealth\w*|affluen\w*|rich|well-off|well off|high-end budget|low-budget audience|purchasing power|disposable income|can afford|upper[- ]class|middle[- ]class|working[- ]class)\b/i },
];

/** Refusal codes for any text that names a prohibited inference; empty when every text passes. */
export function inferenceRefusals(texts: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const value of texts) for (const rule of PROHIBITED_INFERENCE) if (rule.pattern.test(value)) codes.add(rule.code);
  return [...codes].sort();
}
