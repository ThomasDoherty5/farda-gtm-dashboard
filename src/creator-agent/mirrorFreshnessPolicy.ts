import { z } from "zod";
import { MIRROR_IDS, mirrorPolicyOverridesSchema, mirrorRefSchema } from "./mirrorFreshness.ts";

const instant = z.string().datetime({ offset: true });
const cadence = z.number().int().min(1).max(43_200);
/** Server-owned adoption receipt. Configuration is not proof of a deployed schedule or native source binding. */
export const mirrorPolicyApprovalSchema = z.object({
  version: mirrorRefSchema, decisionRef: mirrorRefSchema, ownerRef: mirrorRefSchema,
  approvedAt: instant, timezone: z.literal("America/Los_Angeles"),
  expectedCadenceMinutes: z.object(Object.fromEntries(MIRROR_IDS.map(id => [id, cadence])) as Record<(typeof MIRROR_IDS)[number], typeof cadence>).strict(),
  policies: mirrorPolicyOverridesSchema,
}).strict().superRefine((value, ctx) => {
  for (const id of MIRROR_IDS) {
    const policy = value.policies[id];
    if (!policy || policy.checkEveryMinutes !== 15 || !policy.staleAfterMinutes || value.expectedCadenceMinutes[id] > policy.staleAfterMinutes)
      ctx.addIssue({ code: "custom", path: ["policies", id], message: "Each adopted mirror needs the 15-minute sweep and a threshold at least its expected source cadence." });
  }
});
export type MirrorPolicyApproval = z.infer<typeof mirrorPolicyApprovalSchema>;
