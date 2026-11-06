import { z } from "zod";
import { expectedBindingSchema } from "../connections/schema.ts";

export const JOB_SCHEMA_VERSION = "farda.jobs.v1" as const;
const id = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine((value) => !/^https?:/i.test(value), "Use an opaque reference, not an endpoint.");
const instant = z.string().datetime({ offset: true });
export const jobDefinitionSchema = z.object({
  jobId: id, version: z.number().int().positive().safe(), ownerRef: id,
  mode: z.enum(["observe", "propose"]).default("observe"), handler: z.enum(["record-reference.v1", "draft-reference.v1"]),
  eventType: id, inputSchemaVersion: z.literal("job-reference-batch.v1"), outputSchemaVersion: z.literal("job-local-result.v1"),
  policyVersion: id, modelVersion: id.nullable(), offerVersion: id.nullable(), capabilityBinding: expectedBindingSchema.nullable(),
  budgets: z.object({ maxItems: z.number().int().min(1).max(100), maxSteps: z.number().int().min(1).max(1000), maxAttempts: z.number().int().min(1).max(5),
    maxRunMs: z.number().int().min(1000).max(900_000), leaseMs: z.number().int().min(1000).max(300_000), maxConcurrency: z.number().int().min(1).max(4), retryBaseMs: z.number().int().min(0).max(60_000) }).strict(),
}).strict().superRefine((job, ctx) => {
  if ((job.mode === "observe") !== (job.handler === "record-reference.v1")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Handler and no-source mode must match." });
  if (job.capabilityBinding && job.capabilityBinding.mode !== job.mode) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Capability mode must match the registration." });
  if (job.budgets.leaseMs > job.budgets.maxRunMs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A lease cannot exceed the run time budget." });
});
export type JobDefinition = z.infer<typeof jobDefinitionSchema>;
export const referenceInputSchema = z.object({ itemKey: id, subjectRef: id, evidenceRef: id.nullable() }).strict();
export const jobEventSchema = z.object({ schemaVersion: z.literal("job-reference-batch.v1"), jobId: id, jobVersion: z.number().int().positive().safe(), eventId: id, eventType: id,
  eventAt: instant.nullable(), items: z.array(referenceInputSchema).max(100) }).strict().superRefine((event, ctx) => {
  if (new Set(event.items.map((item) => item.itemKey)).size !== event.items.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Item keys must be unique within the event." });
});
export type JobEvent = z.infer<typeof jobEventSchema>;
export const checkpointSchema = z.object({ cursor: id.nullable(), processedRefs: z.array(id).max(100) }).strict();
export type JobCheckpoint = z.infer<typeof checkpointSchema>;
export const localResultSchema = z.object({ schemaVersion: z.literal("job-local-result.v1"), kind: z.enum(["reference-recorded", "proposal-recorded"]), artifactRef: id,
  sourceEffect: z.literal("none") }).strict();
export type LocalResult = z.infer<typeof localResultSchema>;
export const failureSchema = z.object({ reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), certainty: z.enum(["safe-read", "not-applied", "uncertain"]), retryable: z.boolean(), retryAfterMs: z.number().int().min(0).max(3_600_000).default(0) }).strict();
export type JobFailure = z.infer<typeof failureSchema>;
export const itemStateSchema = z.enum(["queued", "leased", "retryWait", "held", "completed", "cancelled", "failed", "reconcile"]);
export const jobItemViewSchema = z.object({ itemId: id, jobId: id, itemKey: id, definitionVersion: z.number().int().positive(), input: referenceInputSchema,
  state: itemStateSchema, attempts: z.number().int().nonnegative(), steps: z.number().int().nonnegative(), dueAt: instant,
  lease: z.object({ ownerRef: id, expiresAt: instant }).strict().nullable(), checkpointVersion: z.number().int().nonnegative(), checkpoint: checkpointSchema,
  result: localResultSchema.nullable(), reasonCode: z.string().nullable(), createdAt: instant, updatedAt: instant }).strict();
export type JobItemView = z.infer<typeof jobItemViewSchema>;
export const jobRunViewSchema = z.object({ schemaVersion: z.literal(JOB_SCHEMA_VERSION), environment: z.literal("sandbox"), runId: id, jobId: id, eventId: id, eventAt: instant.nullable(), observedAt: instant,
  definition: jobDefinitionSchema, definitionHash: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean(), activationRef: id.nullable(),
  control: z.enum(["active", "paused", "cancelled"]), state: z.enum(["empty", "queued", "running", "deferred", "held", "paused", "cancelling", "cancelled", "completed", "partial", "failed", "reconcile"]),
  counts: z.object({ total: z.number().int().nonnegative(), due: z.number().int().nonnegative(), deferred: z.number().int().nonnegative(), leased: z.number().int().nonnegative(), held: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), reconcile: z.number().int().nonnegative(), reused: z.number().int().nonnegative() }).strict(),
  blockerCodes: z.array(z.string()), nextAction: z.string(), items: z.array(jobItemViewSchema).max(100),
  usage: z.object({ workSteps: z.number().int().nonnegative(), externalCalls: z.literal(0), modelCalls: z.literal(0), sourceQuota: z.literal("notApplicable"), zapierTasks: z.literal("unknown"), runtimeCost: z.literal("unknown") }).strict(),
}).strict();
export type JobRunView = z.infer<typeof jobRunViewSchema>;
