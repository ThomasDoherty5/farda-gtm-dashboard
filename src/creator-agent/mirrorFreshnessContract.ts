import { z } from "zod";
import { MIRROR_IDS, MIRROR_RUN_OUTCOMES, MIRROR_PROVIDERS, MIRROR_FRESHNESS_STATES, mirrorPolicyOverrideSchema, mirrorReasonCodeSchema, mirrorRefSchema, mirrorRunSchema, mirrorIncidentPayloadSchema, verifiedMirrorSummary } from "./mirrorFreshness.ts";
import { mirrorPolicyApprovalSchema } from "./mirrorFreshnessPolicy.ts";

const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
export const mirrorCompletionSchema = z.object({
  scope: z.object({ workspaceId: mirrorRefSchema, accountId: mirrorRefSchema, environment: z.literal("sandbox") }).strict(),
  bindingRef: mirrorRefSchema, bindingVersion: mirrorRefSchema, receiptRef: mirrorRefSchema,
  run: mirrorRunSchema,
  coverage: z.object({ basis: z.enum(["fullSnapshot", "completeChangeWindow"]), sourceVersion: mirrorRefSchema,
    partitionsExpected: count.positive(), partitionsCompleted: count, pendingCursor: mirrorRefSchema.nullable(),
    mirrorAcknowledged: z.boolean(), sourceAsOf: instant.nullable() }).strict(),
}).strict().superRefine((value, ctx) => {
  const c = value.coverage;
  if (c.partitionsCompleted > c.partitionsExpected || (value.run.outcome === "complete" &&
    (c.partitionsExpected !== c.partitionsCompleted || c.pendingCursor !== null || !c.mirrorAcknowledged || c.sourceAsOf === null || value.run.coverageWatermark === null || Date.parse(c.sourceAsOf) !== Date.parse(value.run.coverageWatermark))))
    ctx.addIssue({code:"custom",message:"Complete coverage requires every source partition, exhausted cursor, authoritative as-of and mirror acknowledgment."});
});
export type MirrorCompletion = z.infer<typeof mirrorCompletionSchema>;
export type MirrorRunSource = {
  readCompletion(receiptRef: string): Promise<unknown>;
  assertCurrent(completion: MirrorCompletion): void;
};
export const mirrorBindingSchema = z.object({mirrorId:z.enum(MIRROR_IDS),bindingRef:mirrorRefSchema,version:mirrorRefSchema}).strict();
export type MirrorBinding = z.infer<typeof mirrorBindingSchema>;
export const mirrorScheduleSchema = z.object({state:z.enum(["unconfigured","running","stopped","failed"]),
  everyMinutes:z.literal(15),timezone:z.literal("America/Los_Angeles"),deploymentRef:mirrorRefSchema.nullable(),
  lastSweepAt:instant.nullable(),nextSweepAt:instant.nullable()}).strict();
export type MirrorSchedule = z.infer<typeof mirrorScheduleSchema>;


const evidence = z.object({
 latestRun: z.object({runId:mirrorRefSchema,outcome:z.enum(MIRROR_RUN_OUTCOMES),finishedAt:instant,reasonCode:mirrorReasonCodeSchema.nullable(),counts:z.object({rowsRead:count.nullable(),rowsChanged:count.nullable(),rowsExpected:count.nullable()}).strict()}).strict().nullable(),
 lastComplete:z.object({runId:mirrorRefSchema,finishedAt:instant,coverageWatermark:instant,rowsChanged:count}).strict().nullable(),
}).strict();
export const mirrorSummarySchema = z.object({mirrorId:z.enum(MIRROR_IDS),label:z.string(),provider:z.enum(MIRROR_PROVIDERS),state:z.enum(MIRROR_FRESHNESS_STATES),
 reasonCodes:z.array(mirrorReasonCodeSchema).max(12),valuesAreCurrent:z.boolean(),ageMinutes:count.nullable(),checkedAt:instant,
 policy:mirrorPolicyOverrideSchema.extend({checkEveryMinutes:count.positive(),staleAfterMinutes:count.positive().nullable(),basis:z.enum(["proposed-default","configured"]),runsBound:z.boolean()}).strict(),evidence}).strict()
 .superRefine((v,c)=>{if(!verifiedMirrorSummary(v))c.addIssue({code:"custom",message:"Freshness must match its source evidence."});});
export const mirrorFreshnessViewSchema = z.object({kind:z.literal("mirror-freshness"),configured:z.boolean(),mirrors:z.array(mirrorSummarySchema).length(MIRROR_IDS.length),
 policy:mirrorPolicyApprovalSchema.nullable(),schedule:mirrorScheduleSchema,incidents:z.array(mirrorIncidentPayloadSchema).max(100)}).strict().superRefine((v,c)=>{
  const bound=v.mirrors.some(m=>m.policy.runsBound);
  if(new Set(v.mirrors.map(m=>m.mirrorId)).size!==MIRROR_IDS.length || v.configured!==bound || (bound&&!v.policy))
    c.addIssue({code:"custom",message:"Mirror inventory and adopted binding evidence must agree."});
  if(v.schedule.state==="running"&&(!v.policy||!v.schedule.deploymentRef||!v.schedule.lastSweepAt||!v.schedule.nextSweepAt))
    c.addIssue({code:"custom",message:"Running sweeps require actual deployment and run evidence."});
  if(v.schedule.state!=="running"&&v.schedule.nextSweepAt!==null)c.addIssue({code:"custom",message:"Inactive schedules have no next run."});
  for(const m of v.mirrors)if(v.policy&&(m.policy.staleAfterMinutes!==v.policy.policies[m.mirrorId]?.staleAfterMinutes || m.policy.basis!=="configured"))
    c.addIssue({code:"custom",message:"Displayed policy must match its adoption receipt."});
});
export type MirrorFreshnessView = z.infer<typeof mirrorFreshnessViewSchema>;
function sameRun(left: z.infer<typeof mirrorRunSchema>, right: z.infer<typeof mirrorRunSchema> | null) {
  if (!right) return false;
  return left.runId===right.runId && left.mirrorId===right.mirrorId && left.outcome===right.outcome && left.reasonCode===right.reasonCode &&
    Date.parse(left.startedAt)===Date.parse(right.startedAt) && Date.parse(left.finishedAt)===Date.parse(right.finishedAt) &&
    (left.coverageWatermark===null ? right.coverageWatermark===null : right.coverageWatermark!==null && Date.parse(left.coverageWatermark)===Date.parse(right.coverageWatermark)) &&
    left.counts.rowsRead===right.counts.rowsRead && left.counts.rowsExpected===right.counts.rowsExpected && left.counts.rowsChanged===right.counts.rowsChanged;
}
export const mirrorRunDetailSchema=z.object({kind:z.literal("mirror-run"),completion:mirrorCompletionSchema.nullable(),run:mirrorRunSchema.nullable()}).strict().superRefine((v,c)=>{
  if(v.completion&&!sameRun(v.completion.run,v.run))c.addIssue({code:"custom",message:"Run trace and completion receipt must identify the same evidence."});
});
export type MirrorRunDetail=z.infer<typeof mirrorRunDetailSchema>;
