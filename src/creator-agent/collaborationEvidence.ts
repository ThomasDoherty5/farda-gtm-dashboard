import { z } from "zod";

const ref = z.string().min(1).max(500);
const instant = z.string().datetime({ offset: true });
const action = z.enum(["renew", "new-brief", "observe", "stop-new-invitations", "close"]);
const common = { id: ref, recordedAt: instant };
export const collaborationEvidenceRecordSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("asset"), assetId: ref, version: z.number().int().positive(), fileVersion: ref,
    productId: ref, productRevision: ref, parentAssetId: ref.nullable(), parentVersion: z.number().int().positive().nullable(),
    availability: z.enum(["available", "unavailable", "quarantined"]),
    reviewState: z.enum(["unknown", "pending", "accepted", "rejected"]),
    rightsState: z.enum(["unknown", "pending", "granted", "expired", "revoked"]), rightsObservedAt: instant.nullable() }).strict(),
  z.object({ ...common, kind: z.literal("review"), reviewKey: ref, revision: z.number().int().positive(), creatorId: ref,
    action, sourceVerified: z.boolean() }).strict(),
  z.object({ ...common, kind: z.literal("decision"), reviewKey: ref, revision: z.number().int().positive(), creatorId: ref,
    action, decision: z.enum(["approved", "rejected"]), decidedAt: instant, linearDecisionRef: ref }).strict(),
  z.object({ ...common, kind: z.literal("participation"), creatorId: ref, decisionId: ref,
    state: z.enum(["accepted", "declined", "activated", "outcome"]), occurredAt: instant, sourceReceiptRef: ref }).strict(),
]);
export const collaborationEvidenceSchema = z.object({
  kind: z.literal("collaboration-evidence"), source: z.literal("saved-agent-records"), collaborationId: ref, observedAt: instant,
  records: z.array(collaborationEvidenceRecordSchema).max(100), total: z.number().int().nonnegative().safe(),
  offset: z.number().int().nonnegative().safe(), hasMore: z.boolean(),
}).strict().superRefine((data, context) => {
  if (data.offset + data.records.length > data.total || data.hasMore !== (data.offset + data.records.length < data.total))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence coverage must reconcile." });
});
export type CollaborationEvidenceRecord = z.infer<typeof collaborationEvidenceRecordSchema>;
export type CollaborationEvidenceData = z.infer<typeof collaborationEvidenceSchema>;
