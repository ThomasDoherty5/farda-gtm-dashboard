/**
 * Screen for Farda-authored inference in J20: reviewer inferences, context labels, production-choice notes and interruption
 * reasons. It refuses phrasing that diagnoses or infers health, demographics, life stage or purchasing power about a creator
 * or audience, and phrasing that promises sales outcomes. Quoted or observed content (shown actions, narration, claims,
 * comments) is never screened, so a medical or compatibility claim still reaches a person.
 *
 * It matches inference phrasing in context, never single words, so ordinary product language ("race day bag",
 * "rich leather", "unisex tote") passes. It is a floor, not a classifier: a human reviewer still owns the review.
 */
const PERSON = String.raw`(?:creator|she|he|they|her|him|them|host|presenter|viewers?|audience|followers?|buyers?|people|women|men)`;
const SEEMS = String.raw`(?:looks?|seems?|appears?|is|are|likely|probably|must be|might be|may be|could be|clearly|obviously)`;
const GROUP = String.raw`(?:audience|viewers|followers|demographic|crowd|buyers|shoppers|women|men|moms|mums|mothers|parents|people)`;

const PROHIBITED_INFERENCE: { code: string; pattern: RegExp }[] = [
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${SEEMS}\s+(?:\w+\s+){0,2}(?:pregnant|ill|sick|disabled|diabetic|depressed|anxious|infertile|postpartum|menopausal|neurodivergent|autistic)\b`, "i") },
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${PERSON}\s+(?:has|have|suffers? from|is living with|lives with)\s+(?:a\s+|an\s+)?(?:\w+\s+){0,2}(?:condition|disorder|illness|disease|disability|diagnosis)\b`, "i") },
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: /\b(?:diagnos(?:ed|is|e)\s+(?:with|as)|undiagnosed)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b(?:about|around|roughly|approximately|maybe|likely|probably|looks?|seems?|appears?)\s+(?:\w+\s+){0,2}\d{1,2}\s*(?:years?\s+old|yrs?\s+old|year[- ]olds?)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b\d{1,2}\s*(?:-|–|to)\s*\d{1,2}\s*(?:years?\s+old|year[- ]olds?)\b|\b(?:aged|ages)\s+\d{1,2}\s*(?:-|–|to)\s*\d{1,2}\b|\bin\s+(?:her|his|their)\s+(?:early\s+|mid\s+|late\s+)?\d0s\b|\b\d0-somethings?\b|\b(?:apparent|perceived|estimated)\s+(?:age|gender|ethnicity|race)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:new|expecting|pregnant|postpartum|first-time|young|older|single|stay-at-home)\s+(?:moms?|mums?|mothers?|dads?|parents?)\b|\b(?:moms?|mums?|mothers?|dads?|parents?|${GROUP})\s+(?:aged\s+|who are\s+)?(?:over|under|above|below)\s+\d{2}\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:older|younger|middle-aged|elderly|mature|teen(?:age)?|millennial|gen\s?z|boomer|female|male)\b[\w ,-]{0,30}\b${GROUP}\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${GROUP}\s+(?:is|are|skews?|skewing|leans?|trends?)\s+(?:\w+\s+){0,2}(?:older|younger|female|male|teen\w*|middle-aged)\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${SEEMS}\s+(?:\w+\s+){0,2}(?:asian|black|white|latin[ao]|latinx|hispanic|arab|gay|lesbian|straight|muslim|christian|jewish|hindu|immigrant)\b|\b(?:ethnicity|racial background|religious background|sexual orientation|immigration status|nationality)\s+(?:is|seems|appears|looks|of)\b`, "i") },
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: /\b(?:high|low|middle|upper|lower)[- ]income\b|\b(?:purchasing|buying|spending) power\b|\bdisposable income\b|\b(?:upper|middle|working)[- ]class\b/i },
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:wealthy|affluent|well-off|well off|rich|budget-conscious|low-budget|high-spending)\b[\w ,-]{0,20}\b(?:${GROUP}|household|households|creator|family|families)\b|\b${PERSON}\s+(?:can|could|cannot|can't)\s+afford\b`, "i") },
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${PERSON}\s+${SEEMS}\s+(?:\w+\s+){0,2}(?:wealthy|affluent|well-off|rich|broke|low-income|high-income)\b`, "i") },
  { code: "OUTCOME_PROMISE_REFUSED", pattern: /\b(?:predicted sales|expected sales|sales (?:lift|uplift|forecast|potential)|conversion rate|purchase intent|likely to (?:buy|purchase|convert)|(?:will|guaranteed to)\s+(?:cure|treat|fix|improve)\b)/i },
];

/** Refusal codes for any text that names a prohibited inference; empty when every text passes. */
export function inferenceRefusals(texts: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const value of texts) for (const rule of PROHIBITED_INFERENCE) if (rule.pattern.test(value)) codes.add(rule.code);
  return [...codes].sort();
}

/** The interruption itself is a fact and stays recorded; only an inferring reason is replaced. */
export const WITHHELD_INTERRUPTION = "Interruption reason withheld by the inference screen.";
