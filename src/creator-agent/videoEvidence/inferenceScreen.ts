/**
 * Free-text screen for Farda-authored inference in J20: reviewer interpretations, context labels, production-choice notes
 * and interruption reasons. It refuses phrasing that infers health or diagnosis, demographics or life stage, or purchasing
 * power about a creator or audience. Quoted or observed content (exact observations, claim summaries, viewer comments) is
 * never screened: a medical or compatibility claim must still reach human claim review.
 *
 * It matches inference phrasing in context, never single words, so ordinary product language ("race day bag",
 * "rich leather", "unisex tote") passes. It uses the same refusal categories and codes as the calibration-proposal screen
 * (`inferenceRefusals` in `calibration/proposal.ts`, not yet on main), whose single-word patterns are broader.
 * Reconcile the two when that branch merges. It is a floor, not a classifier: a human reviewer still owns the review.
 */
import type { PostMetadata, PostReview, Quarantine, VideoEvidenceRecord } from "./schema.ts";

const PERSON = String.raw`(?:creator|she|he|they|her|him|them|host|presenter|viewers?|audience|followers?|buyers?|people|women|men)`;
const SEEMS = String.raw`(?:looks?|seems?|appears?|is|are|likely|probably|must be|might be|may be|could be|clearly|obviously)`;
const GROUP = String.raw`(?:audience|viewers|followers|demographic|crowd|buyers|shoppers|women|men|moms|mums|mothers|parents|people)`;

const PROHIBITED_INFERENCE: { code: string; pattern: RegExp }[] = [
  // Health or diagnosis attributed to a person.
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${SEEMS}\s+(?:\w+\s+){0,2}(?:pregnant|ill|sick|disabled|diabetic|depressed|anxious|infertile|postpartum|menopausal|neurodivergent|autistic)\b`, "i") },
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${PERSON}\s+(?:has|have|suffers? from|is living with|lives with)\s+(?:a\s+|an\s+)?(?:\w+\s+){0,2}(?:condition|disorder|illness|disease|disability|diagnosis)\b`, "i") },
  { code: "DIAGNOSIS_INFERENCE_REFUSED", pattern: /\b(?:diagnos(?:ed|is|e)\s+(?:with|as)|undiagnosed)\b/i },
  // Demographics and life stage attributed to a person or audience.
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b(?:about|around|roughly|approximately|maybe|likely|probably|looks?|seems?|appears?)\s+(?:\w+\s+){0,2}\d{1,2}\s*(?:years?\s+old|yrs?\s+old|year-olds?)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: /\b\d{1,2}\s*(?:-|to)\s*\d{1,2}\s*(?:years?\s+old|year-olds?)\b|\bin\s+(?:her|his|their)\s+(?:early\s+|mid\s+|late\s+)?\d0s\b|\b\d0-somethings?\b|\b(?:apparent|perceived|estimated)\s+(?:age|gender|ethnicity|race)\b/i },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:new|expecting|pregnant|postpartum|first-time|young|older|single|stay-at-home)\s+(?:moms?|mums?|mothers?|dads?|parents?)\b|\b(?:moms?|mums?|mothers?|dads?|parents?|${GROUP})\s+(?:aged\s+|who are\s+)?(?:over|under|above|below)\s+\d{2}\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:older|younger|middle-aged|elderly|mature|teen(?:age)?|millennial|gen\s?z|boomer|female|male)\b[\w ,-]{0,30}\b${GROUP}\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${GROUP}\s+(?:is|are|skews?|skewing|leans?|trends?)\s+(?:\w+\s+){0,2}(?:older|younger|female|male|teen\w*|middle-aged)\b`, "i") },
  { code: "DEMOGRAPHIC_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${SEEMS}\s+(?:\w+\s+){0,2}(?:asian|black|white|latin[ao]|latinx|hispanic|arab|gay|lesbian|straight|muslim|christian|jewish|hindu|immigrant)\b|\b(?:ethnicity|racial background|religious background|sexual orientation|immigration status|nationality)\s+(?:is|seems|appears|looks|of)\b`, "i") },
  // Purchasing power attributed to a person or audience.
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: /\b(?:high|low|middle|upper|lower)[- ]income\b|\b(?:purchasing|buying|spending) power\b|\bdisposable income\b|\b(?:upper|middle|working)[- ]class\b/i },
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b(?:wealthy|affluent|well-off|well off|rich|budget-conscious|low-budget|high-spending)\b[\w ,-]{0,20}\b(?:${GROUP}|household|households|creator|family|families)\b|\b${PERSON}\s+(?:can|could|cannot|can't)\s+afford\b`, "i") },
  { code: "PURCHASING_POWER_INFERENCE_REFUSED", pattern: new RegExp(String.raw`\b${PERSON}\s+${SEEMS}\s+(?:\w+\s+){0,2}(?:wealthy|affluent|well-off|rich|broke|low-income|high-income)\b`, "i") },
  // Sales outcomes (aligned with the calibration screen's sales category).
  { code: "SALES_INFERENCE_REFUSED", pattern: /\b(?:predicted sales|expected sales|sales (?:lift|uplift|forecast|potential)|conversion rate|purchase intent|likely to (?:buy|purchase|convert))\b/i },
];

/** Refusal codes for any text that names a prohibited inference; empty when every text passes. */
export function inferenceRefusals(texts: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const value of texts) for (const rule of PROHIBITED_INFERENCE) if (rule.pattern.test(value)) codes.add(rule.code);
  return [...codes].sort();
}

/** Replacement for a quarantined interruption reason: the interruption itself is a fact and stays recorded. */
export const WITHHELD_INTERRUPTION = "Interruption reason withheld by the inference screen.";

/** Drops screened context labels that name a prohibited inference. Nothing else in metadata is Farda inference. */
export function quarantineMetadata(metadata: PostMetadata): { metadata: PostMetadata; quarantined: Quarantine } {
  const quarantined: Quarantine = [];
  const secondary_labels = metadata.context.secondary_labels.filter((label, index) => {
    const codes = inferenceRefusals([label]);
    if (codes.length) quarantined.push({ field: `context.secondary_labels[${index}]`, reason_codes: codes, reviewed: null });
    return !codes.length;
  });
  return { metadata: { ...metadata, context: { ...metadata.context, secondary_labels } }, quarantined };
}

/**
 * Drops screened review fields (interpretations, production-choice notes, interruption reasons) that name a prohibited
 * inference, keeping the rest of the review. Exact observations and claim summaries are quoted or observed content and pass.
 */
export function quarantineReview(review: PostReview): { review: PostReview; quarantined: Quarantine } {
  const quarantined: Quarantine = [];
  const features = review.features.map((feature, index) => {
    const codes = feature.interpretation ? inferenceRefusals([feature.interpretation.text]) : [];
    if (!codes.length) return feature;
    quarantined.push({ field: `features[${index}].interpretation`, reason_codes: codes, reviewed: null });
    return { ...feature, interpretation: null };
  });
  const production_choices = review.production_choices.filter((choice, index) => {
    const codes = inferenceRefusals([choice.observation]);
    if (codes.length) quarantined.push({ field: `production_choices[${index}].observation`, reason_codes: codes, reviewed: null });
    return !codes.length;
  });
  let viewing = review.viewing;
  const interruption = viewing.interruption_reason ? inferenceRefusals([viewing.interruption_reason]) : [];
  if (interruption.length) {
    quarantined.push({ field: "viewing.interruption_reason", reason_codes: interruption, reviewed: null });
    viewing = { ...viewing, interruption_reason: WITHHELD_INTERRUPTION };
  }
  return { review: { ...review, features, production_choices, viewing }, quarantined };
}

/** Append-time check on a newly built version: every screened field must already have passed. */
export function unscreenedFields(record: Pick<VideoEvidenceRecord, "sampling" | "features" | "production_choices" | "viewing">): string[] {
  return inferenceRefusals([
    ...record.sampling.secondary_labels,
    ...record.features.flatMap((f) => f.interpretation ? [f.interpretation.text] : []),
    ...record.production_choices.map((p) => p.observation),
    ...(record.viewing?.interruption_reason ? [record.viewing.interruption_reason] : []),
  ]);
}

/** An unacknowledged quarantined reviewer interpretation sends the record to the human exception path. */
export const quarantinedInterpretation = (quarantined: Quarantine) => quarantined.some((q) => q.field.endsWith(".interpretation") && !q.reviewed);
