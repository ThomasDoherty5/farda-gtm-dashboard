import { z } from "zod";
import { creatorAssessmentSchema } from "./assessmentSchema.ts";
import { evidencePacketSchema } from "./evidence.ts";
import { commercialEligibilityViewSchema } from "./commercialPolicy/views.ts";

/** Browser-safe shapes for actual agent read models. Historical/demo contracts remain separate. */
const text = z.string().min(1);
const instant = z.string().datetime({ offset: true });
const revision = z.number().int().positive();
const state = z.enum(["hold", "reviewNeeded", "prospectiveInviteEligible", "activationReady"]);
const modelId = z.enum(["WEBSITE-AFFILIATE-v3", "TIKTOK-SHOP-AFFILIATE-v3"]);
const decisionRules = z.object({ invitationMinScore: z.number().min(0).max(100).nullable(), activationMinScore: z.number().min(0).max(100), minCoveragePct: z.number().min(0).max(100) }).strict();

export const agentModelSummarySchema = z.object({
  modelId, status: z.enum(["bound", "unbound"]), configVersion: text.nullable(), configHash: text.nullable(),
  baselineHash: text.nullable(), numericHash: text.nullable(),
  criteria: z.array(z.object({ id: text, label: text, weight: z.number().positive().max(100) }).strict()).nullable(),
  bands: z.array(z.object({ id: text, min: z.number().min(0).max(100) }).strict()).nullable(),
  arithmetic: text.nullable(), decisionRules: decisionRules.nullable(),
}).strict().superRefine((model, ctx) => {
  const boundFields = [model.configVersion, model.configHash, model.baselineHash, model.numericHash, model.criteria, model.bands, model.arithmetic];
  if (model.status === "bound" && boundFields.some((field) => field === null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A bound model must expose its actual immutable configuration." });
  if (model.status === "unbound" && [...boundFields, model.decisionRules].some((field) => field !== null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An unbound model cannot substitute numerical configuration." });
});
export type AgentModelSummary = z.infer<typeof agentModelSummarySchema>;

export const agentSourcingRecordSchema = z.object({
  creatorId: text, runId: text, evidenceId: text.nullable(), briefId: text,
  checkoutRoute: z.enum(["website", "tiktok-shop"]), state, recordedAt: instant, revision, stale: z.boolean(),
  superseded: z.boolean().default(false),
}).strict().superRefine((record, ctx) => {
  if (record.superseded && (!record.stale || record.state !== "reviewNeeded" || record.evidenceId !== null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A superseded snapshot row cannot claim current readiness or link silently to new evidence." });
});
export const agentSourcingSnapshotSchema = z.object({
  id: text, asOf: instant, expiresAt: instant, offset: z.number().int().nonnegative().safe(),
  limit: z.number().int().min(1).max(100), returnedCount: z.number().int().min(0).max(100), total: z.number().int().nonnegative().safe(),
}).strict();
export const agentSourcingSchema = z.object({
  kind: z.literal("agent-sourcing"), policyVersion: text, agentVersion: text, agentSchemaVersion: text,
  records: z.array(agentSourcingRecordSchema).max(100), models: z.array(agentModelSummarySchema).length(2),
  total: z.number().int().nonnegative(), partial: z.boolean(),
  /** Membership/order/total are fixed at this snapshot; readiness is observed again on each page fetch. */
  snapshot: agentSourcingSnapshotSchema.optional(),
}).strict().superRefine((data, ctx) => {
  if (new Set(data.records.map((record) => record.creatorId)).size !== data.records.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["records"], message: "Sourcing lists one latest saved record per creator." });
  if (new Set(data.models.map((model) => model.modelId)).size !== 2)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["models"], message: "Both independent checkout models must be represented." });
  if (data.total < data.records.length || data.partial !== (data.total > data.records.length))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partial"], message: "Saved-record coverage must reconcile with its actual total." });
  if (data.snapshot && (data.snapshot.total !== data.total || data.snapshot.returnedCount !== data.records.length || data.snapshot.returnedCount > data.snapshot.limit || data.snapshot.offset + data.records.length > data.total))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshot"], message: "Snapshot page metadata must reconcile with actual returned records." });
});
export type AgentSourcingData = z.infer<typeof agentSourcingSchema>;

export const agentAssessmentRecordSchema = z.object({
  kind: z.literal("creator-v3"), creatorId: text, assessmentId: text, runId: text, evidenceId: text.nullable(),
  qualification: creatorAssessmentSchema, assessedQualification: creatorAssessmentSchema, agentEvidence: evidencePacketSchema,
  recordedAt: instant, revision, stale: z.boolean(), superseded: z.boolean(),
  commercialEligibility: commercialEligibilityViewSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if (record.assessmentId !== record.runId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assessmentId"], message: "An assessment address identifies its exact saved run." });
  if (record.agentEvidence.creatorId !== record.creatorId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["creatorId"], message: "Saved assessment and evidence must belong to the requested creator." });
  const expectedModel = record.agentEvidence.checkoutRoute === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3";
  for (const key of ["qualification", "assessedQualification"] as const) {
    for (const field of ["creatorId", "briefId", "evidenceRevision", "termsRevision"] as const)
      if (record[key][field] !== record.agentEvidence[field])
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, field], message: "Qualification must identify the exact saved evidence and terms basis." });
    if (record[key].modelId !== expectedModel)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, "modelId"], message: "Qualification must use the saved packet's checkout model." });
  }
  if ((record.stale || record.superseded) && record.qualification.state !== "reviewNeeded")
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qualification", "state"], message: "A stale or superseded assessment cannot claim current readiness." });
  if (record.evidenceId !== null && !record.agentEvidence.posts.some((post) => post.postId === record.evidenceId))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceId"], message: "Evidence navigation must identify a post from this saved packet." });
  if (record.superseded && (!record.stale || record.evidenceId !== null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A superseded run is historical and cannot link silently to the latest evidence packet." });
});
export type AgentAssessmentRecord = z.infer<typeof agentAssessmentRecordSchema>;

/** Explicit source opportunity membership; existing score history is a separate observation. */
export const nativeRecruitmentViewSchema = z.object({
  kind: z.literal("native-recruitment"),
  filters: z.object({ networks: z.enum(["both", "instagram", "tiktok"]), route: z.enum(["queue", "inbound", "outbound"]) }).strict(),
  observedAt: instant, validUntil: instant, sourceAlias: z.string().regex(/^recruitment-source-[a-f0-9]{64}$/),
  rows: z.array(z.object({ opportunityRef: z.string().regex(/^recruitment-opportunity-[a-f0-9]{64}$/), creatorId: text,
    runId: text.nullable(), offerId: text.nullable(), offerVersion: z.string().regex(/^v[1-9]\d*$/).nullable(), phase: z.enum(["invitation", "activation", "shipment"]),
    network: z.enum(["instagram", "tiktok", "unknown"]), route: z.enum(["inbound", "outbound", "unknown"]),
    assessment: z.object({ state, score: z.number().finite().nullable(), stale: z.boolean() }).strict().nullable(),
    commercialEligibility: commercialEligibilityViewSchema,
  }).strict()).max(100),
  coverage: z.object({ returned: z.number().int().nonnegative().max(100), total: z.number().int().nonnegative().safe().nullable(), complete: z.boolean() }).strict(),
  dispatchAuthorized: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.coverage.returned !== value.rows.length || value.coverage.total !== null && value.coverage.total < value.rows.length || value.coverage.complete && value.coverage.total !== value.rows.length)
    ctx.addIssue({ code: "custom", message: "Recruitment source coverage must match the bounded rows." });
});
export type NativeRecruitmentView = z.infer<typeof nativeRecruitmentViewSchema>;
