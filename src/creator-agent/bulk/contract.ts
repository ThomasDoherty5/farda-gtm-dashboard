import { z } from "zod";
import { approvalDraftSchema, approvalHashSchema, approvalInstantSchema, approvalRefSchema, approvalScopeSchema } from "../approvals/contract.ts";
import { reviewFieldSchema } from "../actions/reviewViews.ts";

const ref = approvalRefSchema, instant = approvalInstantSchema, count = z.number().int().nonnegative().safe();
export const bulkReasonSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
export const bulkRegistrationSchema = z.object({ jobId: z.literal("J13"), version: z.literal(1), registrationRef: ref,
  registrationVersion: ref, inputSchema: z.literal("farda.bulk-input.v1"), outputSchema: z.literal("farda.bulk-output.v1") }).strict();
export const bulkProvenanceSchema = z.discriminatedUnion("evidenceStage", [
  z.object({ evidenceStage: z.literal("synthetic"), synthetic: z.literal(true) }).strict(),
  z.object({ evidenceStage: z.literal("source"), synthetic: z.literal(false) }).strict(),
]);
export const bulkApprovalLinkSchema = z.object({ approvalRef: ref, manifestVersion: count.positive(), manifestHash: approvalHashSchema }).strict();
export const bulkReadFiltersSchema = z.object({ batchRef: ref, batchVersion: ref }).strict();
export type BulkReadFilters = z.infer<typeof bulkReadFiltersSchema>;
export const bulkRequestSchema = z.discriminatedUnion("kind", [
  bulkReadFiltersSchema.extend({ kind: z.literal("batch") }).strict(),
  z.object({ kind: z.literal("preview"), entityRef: ref, entityVersion: approvalHashSchema }).strict(),
  z.object({ kind: z.literal("manifest"), sourceRef: ref, basisHash: approvalHashSchema }).strict(),
]);
export type BulkRequest = z.infer<typeof bulkRequestSchema>;
export const bulkSnapshotSchema = z.object({ schemaVersion: z.literal("farda.bulk-input.v1"), registration: bulkRegistrationSchema,
  scope: approvalScopeSchema, principalRef: ref, permissionVersion: ref, permission: z.enum(["permitted", "denied", "unknown"]), request: bulkRequestSchema,
  provenance: bulkProvenanceSchema, batchRef: ref, batchVersion: ref, sourceRef: ref, sourceVersion: ref,
  observedAt: instant, validUntil: instant, expiresAt: instant,
  rows: z.array(z.object({ rowId: ref, recipientRef: ref, recipient: reviewFieldSchema, product: reviewFieldSchema,
    sampleDisposition: z.enum(["newSample", "noNewSample", "unknown"]),
    productRefs: z.array(ref).min(1).max(30), productVersions: z.array(ref).min(1).max(30), evidenceModelVersions: z.array(ref).min(1).max(30), termsVersions: z.array(ref).min(1).max(30),
    payloadHashes: z.array(approvalHashSchema).min(1).max(30),
    blockers: z.array(z.object({ code: bulkReasonSchema, groupRef: ref.nullable() }).strict()).max(30),
  }).strict()).min(1).max(100),
  groups: z.array(z.object({ groupRef: ref, kind: z.enum(["invitation", "activation", "sampleDecision"]), actionKind: ref,
    providerAccountRef: ref, ownerEntityRef: ref, ownerEntityVersion: ref,
    members: z.array(z.object({ rowId: ref, itemRef: ref }).strict()).min(1).max(100),
    draft: approvalDraftSchema.nullable(), approval: bulkApprovalLinkSchema.nullable(), runRefs: z.array(ref).max(100),
  }).strict()).min(1).max(100),
  capacity: z.array(z.object({ provider: ref, providerAccountRef: ref, action: ref, unit: ref,
    kind: z.enum(["invitationQuota", "activeCollaborations"]), remaining: count.nullable(), resetAt: instant.nullable(),
    observedAt: instant, validUntil: instant, sourceRef: ref, sourceVersion: ref, reasonCode: bulkReasonSchema.nullable() }).strict()).max(100),
  sampleAllocation: z.object({ sourceRef: ref, sourceVersion: ref, observedAt: instant, validUntil: instant,
    approvedUnits: count, approvedMinor: count, currency: z.literal("USD") }).strict().nullable(),
  commissionForecastMinor: count.nullable(),
}).strict().superRefine((s, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: "custom", message });
  if (new Set(s.rows.map(r => r.rowId)).size !== s.rows.length || new Set(s.groups.map(g => g.groupRef)).size !== s.groups.length) error("Finite row and group identities must be unique.");
  for (const group of s.groups) {
    if (new Set(group.members.map(m => m.rowId)).size !== group.members.length || new Set(group.members.map(m => m.itemRef)).size !== group.members.length ||
      group.members.some(m => !s.rows.some(r => r.rowId === m.rowId)) || new Set(group.runRefs).size !== group.runRefs.length) error("Exact group membership is required.");
    if (!group.draft && (group.approval || group.runRefs.length)) error("An empty held group cannot claim a canonical action.");
  }
  if (s.rows.some(r => r.blockers.some(b => b.groupRef !== null && !s.groups.some(g => g.groupRef === b.groupRef)))) error("A blocker must refer to this finite group set.");
  for (const row of s.rows) {
    if (!s.groups.some(g => g.members.some(m => m.rowId === row.rowId))) error("Every finite recipient needs explicit action membership, including held rows.");
    const sampleGroups = s.groups.filter(g => g.kind === "sampleDecision" && g.members.some(m => m.rowId === row.rowId));
    if (row.sampleDisposition === "newSample" && sampleGroups.length !== 1 || row.sampleDisposition === "noNewSample" && sampleGroups.length) error("Separate source sample membership must be explicit.");
  }
});
export type BulkSnapshot = z.infer<typeof bulkSnapshotSchema>;
export type BulkGroup = BulkSnapshot["groups"][number];
export type BulkSourceInput = { scope: z.infer<typeof approvalScopeSchema>; principalRef: string; request: BulkRequest };
/** Resolves exact retained source versions after restart. An immutable lookup is still subject to current read permission.
 * assertCurrent must check actual current permission/material authority, never merely the supplied packet. */
export interface BulkSource {
  read(input: BulkSourceInput): Promise<unknown>;
  assertCurrent(snapshot: BulkSnapshot, input: BulkSourceInput, now: number): void;
}
export class BulkError extends Error {
  readonly code: string; readonly status: number; readonly executionCertainty = "notApplied" as const;
  constructor(code: string, status = 409) { super(code); this.name = "BulkError"; this.code = code; this.status = status; }
}
