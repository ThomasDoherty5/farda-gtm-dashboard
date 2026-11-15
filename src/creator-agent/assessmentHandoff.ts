import { z } from "zod";

/**
 * J02 workflow step 6, J02 side only. The snapshot records the recommendation it would hand on and the hash of the
 * basis it was computed from. It names no J04 phase or requirement: J04 owns its previews and the offer policy owns
 * commercial eligibility, and nothing in J04 reads this record yet. It is never a preview, decision, grant or send;
 * a score alone cannot enroll, ship, send or spend, so every effect flag is the literal false.
 */
export const recommendationSchema = z.enum(["reviewNeeded", "hold", "prospectiveInviteEligible", "activationReady"]);
export type Recommendation = z.infer<typeof recommendationSchema>;
export const assessmentNextActionSchema = z.object({
  recommendation: recommendationSchema,
  basisHash: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.literal("propose"), dispatch: z.literal("none"), confersApproval: z.literal(false),
  effects: z.object({ sends: z.literal(false), spends: z.literal(false), enrolls: z.literal(false), ships: z.literal(false) }).strict(),
}).strict();
export type AssessmentNextAction = z.infer<typeof assessmentNextActionSchema>;

export function proposeNextAction(recommendation: Recommendation, basisHash: string): AssessmentNextAction {
  return assessmentNextActionSchema.parse({ recommendation, basisHash, mode: "propose", dispatch: "none", confersApproval: false,
    effects: { sends: false, spends: false, enrolls: false, ships: false } });
}

/**
 * Read-time hold of an assessment whose basis changed or was disputed. The projection withdraws the unsent
 * recommendation; the stored snapshot (returned separately as `assessedQualification`) keeps what it recorded, exactly
 * as it keeps its original `state`. Legacy snapshots have no handoff to withdraw.
 */
export function holdForReview<T extends { state: string; reasonCodes: string[]; nextAction?: AssessmentNextAction }>(assessment: T, reasonCodes: string[]): T {
  const held = { ...assessment, state: "reviewNeeded", reasonCodes };
  return (assessment.nextAction ? { ...held, nextAction: proposeNextAction("reviewNeeded", assessment.nextAction.basisHash) } : held) as T;
}
