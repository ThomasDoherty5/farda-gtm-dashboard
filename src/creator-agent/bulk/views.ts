import { z } from "zod";
import { approvalInstantSchema as instant, approvalRefSchema as ref } from "../approvals/contract.ts";
import { reviewFieldSchema } from "../actions/reviewViews.ts";
import { bulkApprovalLinkSchema, bulkProvenanceSchema, bulkReasonSchema, bulkReadFiltersSchema, bulkRegistrationSchema } from "./contract.ts";

const count = z.number().int().nonnegative().safe();
export const bulkSampleCommitmentsSchema = z.object({ approvedUnits: count, approvedMinor: count,
  remainingUnits: count.nullable(), remainingMinor: count.nullable(), currency: z.literal("USD"), evidenceRefs: z.array(ref),
  reasonCodes: z.array(bulkReasonSchema), confersAuthority: z.literal(false) }).strict();
export const nativeBulkViewSchema = z.object({ kind: z.literal("native-bulk"), schemaVersion: z.literal("farda.bulk-output.v1"),
  registration: bulkRegistrationSchema, filters: bulkReadFiltersSchema, provenance: bulkProvenanceSchema,
  actorRef: ref, sourceVersion: ref, observedAt: instant, validUntil: instant,
  rows: z.array(z.object({ rowId: ref, recipientRef: ref, recipient: reviewFieldSchema, product: reviewFieldSchema,
    sampleDisposition: z.enum(["newSample", "noNewSample", "unknown"]),
    state: z.enum(["confirmed", "failed", "blocked", "deferred", "uncertain", "canceled", "ready"]),
    productRefs: z.array(ref), productVersions: z.array(ref), evidenceModelVersions: z.array(ref), termsVersions: z.array(ref),
    allBlockers: z.array(bulkReasonSchema), primarySummaryReason: bulkReasonSchema.nullable() }).strict()).max(100),
  primaryCounts: z.array(z.object({ reason: bulkReasonSchema, count }).strict()),
  groups: z.array(z.object({ groupRef: ref, kind: z.enum(["invitation", "activation", "sampleDecision"]), actionKind: ref,
    preview: z.object({ entityRef: ref, entityVersion: ref, selectionRefs: z.array(ref).max(100) }).strict().nullable(),
    approval: bulkApprovalLinkSchema.nullable(), runRefs: z.array(ref).max(100),
    reasonCodes: z.array(bulkReasonSchema) }).strict()).max(100),
  aggregateCounts: z.object({ snapshot: count, confirmed: count, failed: count, blocked: count, deferred: count, uncertain: count, canceled: count, ready: count }).strict(),
  rowReceipts: z.array(z.object({ rowId: ref, groupRef: ref, receiptRef: ref, sourceEffect: z.enum(["localArtifact", "providerApplied"]) }).strict()),
  recoveryQueue: z.array(z.object({ rowId: ref, groupRef: ref, runRef: ref,
    nextAction: z.enum(["reconcileOriginal", "waitForSourceReset", "inspectFailure", "refreshSource"]), owner: z.literal("sourceOwner") }).strict()),
  sampleCommitments: bulkSampleCommitmentsSchema.nullable(), commissionForecastMinor: count.nullable(), forecastIsEarnedCap: z.literal(false),
  capacity: z.array(z.object({ provider: ref, providerAccountRef: ref, action: ref, unit: ref,
    kind: z.enum(["invitationQuota", "activeCollaborations"]), remaining: count.nullable(), resetAt: instant.nullable(),
    observedAt: instant, validUntil: instant, sourceRef: ref, sourceVersion: ref, reasonCode: bulkReasonSchema.nullable() }).strict()).max(100),
  sourceEffect: z.literal("none"), confersAuthority: z.literal(false),
}).strict();
export type BulkReadData = z.infer<typeof nativeBulkViewSchema>;
export type BulkSampleCommitments = z.infer<typeof bulkSampleCommitmentsSchema>;
