import { POLICY_VERSION } from "./assessmentSchema.ts";

/** The agent's versioned review rubric. Unknown evidence has no rating; zero is an observed failure. */
export const ratingPolicy = {
  policyVersion: POLICY_VERSION,
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
  briefs: ["routine", "dayInLife", "carry", "setupRefill", "hardwareClarity", "usability"],
  reviewRules: [
    "Assign the brief before rating. An explanation can be useful without proving an unshown physical action.",
    "Record observed actions, narrated claims and inference separately.",
    "Use source evidence for audience, commerce, reliability and economics; appearance is not that evidence.",
    "Judge usable framing, product visibility, legibility, pacing, speech/captions and styling for the brief.",
    "Keep prompted participation, product questions and self-reported ownership distinct from verified purchases.",
  ],
} as const;
