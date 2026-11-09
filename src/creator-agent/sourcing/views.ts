import { z } from "zod";
import { instantSchema, sourcingPlanShape } from "./contract.ts";
const publicRef = z.string().regex(/^sourcing-[a-z]+-[a-f0-9]{64}$/);
export const nativeSourcingPlanSchema = z.object({ ...sourcingPlanShape, datasetKey: z.literal("sourcing-plan-native"), provenance: z.object({ evidenceStage: z.enum(["synthetic", "source"]), synthetic: z.boolean(), sourceVersion: publicRef, observedAt: instantSchema, validUntil: instantSchema }).strict() }).strict()
  .refine(value => value.provenance.synthetic === (value.provenance.evidenceStage === "synthetic"));
export type NativeSourcingPlan = z.infer<typeof nativeSourcingPlanSchema>;
