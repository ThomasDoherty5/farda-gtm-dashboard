import { POLICY_VERSION } from "./assessmentSchema.ts";

/** The agent's versioned review rubric. Unknown evidence has no rating; zero is an observed failure. */
export const ratingPolicy = {
  policyVersion: POLICY_VERSION,
  researchCorpusVersion: "launch-study-31-posts-2026-11-04",
  evidenceRubricRevision: "route-proof.v1",
  unknownRating: null,
  criticalFloors: { routineFit: 3, demonstrationStorytelling: 3 },
  preferredRepeatedEvidenceLevel: 4,
  retailCtaRequiredForContentSourcing: false,
  verifiedSalesFromPublicEngagement: false,
  routineFit: [
    "Confirmed mismatch to the assigned supported-use brief.",
    "Lifestyle overlap without a demonstrated relevant habit.",
    "Adjacent organization or inventory; practical integration is uncertain.",
    "Practical adult routine or carry context with a plausible supported product role.",
    "Repeated relevant preparation or use, including candid limits.",
    "Consistently useful supported-use explanations in multiple contexts or formats.",
  ],
  demonstrationStorytelling: [
    "Confirmed inaccurate or unusable communication for this brief.",
    "Product posing or promotion with unclear operation.",
    "Features or unboxing with little on-brief action or visual support.",
    "Understandable purpose, action or explanation with adequate visuals and bounded claims.",
    "Repeated clear execution, visible useful payoff and credible explanation; retail CTA optional.",
    "Consistently accurate, accessible execution that addresses practical objections.",
  ],
  verifiedCommerce: [
    "Mature comparable retained sales show a verified mismatch.",
    "Comparable retained sales are present but weak for the reviewed use case.",
    "Limited comparable retained sales support only a narrow example.",
    "Source-defined retained sales support this category in a comparable window.",
    "Repeated relevant retained sales are supported across mature comparable windows.",
    "Consistent relevant retained performance is documented across multiple mature cohorts.",
  ],
  audienceAlignment: [
    "Authorized audience aggregates show a confirmed mismatch to the brief.",
    "Source aggregates show little alignment on the brief's applicable dimensions.",
    "Source aggregates show limited or mixed alignment.",
    "Source aggregate country, age and language evidence supports the brief.",
    "Comparable audience observations repeatedly support the brief.",
    "Multiple comparable source windows consistently support the brief's audience.",
  ],
  reliability: [
    "Source records confirm failure to meet the applicable commitment.",
    "Records show repeated material delivery problems.",
    "Completion records contain material limitations or inconsistent outcomes.",
    "Source records support completion of comparable commitments.",
    "Repeated comparable commitments were fulfilled with documented follow-through.",
    "Consistent documented follow-through across different comparable commitments.",
  ],
  offerEconomics: [
    "Approved cost and offer inputs establish an unacceptable outcome.",
    "Verified downside or costs materially undermine the offer.",
    "Verified economics leave little room under the stated downside assumptions.",
    "The exact offer and cost evidence support the approved payback boundary.",
    "The accepted offer and sourced costs support payback in base and downside cases.",
    "Multiple comparable mature outcomes support the approved payback boundary.",
  ],
  evidenceSources: {
    routineFit: "Completed source-linked on-brief post reviews; cite observed intervals or sampled timestamps.",
    demonstrationStorytelling: "Completed on-brief action and explanation evidence; preserve the observed result and its limits.",
    verifiedCommerce: "Route-specific provider retained-sales measurement with source window, currency, maturity and sample size.",
    audienceAlignment: "Authorized aggregate audience report with denominator, sample size and country, age and language dimensions.",
    reliability: "Source-linked comparable commitment and delivery records.",
    offerEconomics: "Exact versioned offer and sourced economics; costs, fees and refunds have separate bases.",
  },
  briefs: ["routine", "dayInLife", "carry", "setupRefill", "hardwareClarity", "usability"],
  reviewRules: [
    "Assign the brief before rating. An explanation can be useful without proving an unshown physical action.",
    "Record observed actions, narrated claims and inference separately.",
    "Use source evidence for audience, commerce, reliability and economics; appearance is not that evidence.",
    "Judge usable framing, product visibility, legibility, pacing, speech/captions and styling for the brief.",
    "Keep prompted participation, product questions and self-reported ownership distinct from verified purchases.",
  ],
} as const;


export function anchorFor(id: string, rating: number | null): string | null {
  if (rating === null || !Object.hasOwn(ratingPolicy.evidenceSources, id)) return null;
  return ratingPolicy[id as keyof typeof ratingPolicy.evidenceSources][rating] ?? null;
}
