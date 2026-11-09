import { z } from "zod";
import { approvalScopeSchema, approvalRefSchema as ref, approvalInstantSchema as instant, type ApprovalScope, type TrustedHuman, type ApprovalRegistry } from "../approvals/contract.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";
import { nativeInvitationViewSchema, nativeRecruitmentBatchSchema, invitationFiltersSchema, recruitmentBatchFiltersSchema,
  recruitmentCount, recruitmentReason, type InvitationFilters, type RecruitmentBatchFilters } from "./contract.ts";
import { reviewFieldSchema } from "../actions/reviewViews.ts";

export const RECRUITMENT_SOURCE_MAX_AGE_MS = 300_000;
const binding = z.object({
  scope: approvalScopeSchema, principalRef: ref, directoryVersion: ref,
  providerAccountRef: ref, providerAccountVersion: ref,
}).strict();
const header = {
  provenance: nativeInvitationViewSchema.shape.provenance,
  binding, sourceRef: ref, sourceVersion: ref, observedAt: instant, validUntil: instant,
  permission: z.enum(["permitted", "denied", "unknown"]), complete: z.boolean(),
  reasonCodes: z.array(recruitmentReason).max(30),
};
export const invitationSourceSchema = z.object({
  kind: z.literal("invitation"), ...header, filters: invitationFiltersSchema,
  provider: nativeInvitationViewSchema.shape.provider, account: reviewFieldSchema,
  creators: nativeInvitationViewSchema.shape.creators,
  products: nativeInvitationViewSchema.shape.products, templates: nativeInvitationViewSchema.shape.templates,
  limits: nativeInvitationViewSchema.shape.limits, willingness: nativeInvitationViewSchema.shape.willingness,
  acceptedOffer: z.object({ offerId: ref, version: ref, receiptRef: ref, validUntil: instant }).strict().nullable(),
  capacity: nativeInvitationViewSchema.shape.capacity, samples: nativeInvitationViewSchema.shape.samples,
  sourceLink: nativeInvitationViewSchema.shape.sourceLink,
  draftPermission: z.boolean(),
}).strict().superRefine((value, ctx) => {
  for (const values of [value.creators, value.products, value.templates, value.samples]) {
    const ids = values.map(item => "requestRef" in item ? item.requestRef : item.ref);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Source selectors must be unique." });
  }
  if(new Set(value.creators.map(creator=>creator.creatorId)).size!==value.creators.length)
    ctx.addIssue({code:"custom",message:"Each canonical creator has exactly one permitted selector."});
  if (new Set(value.capacity.map(item => item.kind)).size !== value.capacity.length)
    ctx.addIssue({ code: "custom", message: "Capacity dimensions must be unique." });
});
export type InvitationSourceSnapshot = z.infer<typeof invitationSourceSchema>;

export const recruitmentBatchSourceSchema = z.object({
  kind: z.literal("batch"), ...header, filters: recruitmentBatchFiltersSchema,
  approvalRef: ref, manifestVersion: recruitmentCount.positive(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  runRef: ref, runRevision: recruitmentCount.positive(), models: nativeRecruitmentBatchSchema.innerType().shape.models,
  rows: nativeRecruitmentBatchSchema.innerType().shape.rows,
  total: recruitmentCount.max(100), owners: nativeRecruitmentBatchSchema.innerType().shape.owners,
  capacity: nativeRecruitmentBatchSchema.innerType().shape.capacity, samples: nativeRecruitmentBatchSchema.innerType().shape.samples,
  forecastCommissionMinor: recruitmentCount.nullable(), sourceLink: nativeRecruitmentBatchSchema.innerType().shape.sourceLink,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.rows.map(row => row.itemRef)).size !== value.rows.length || value.total < value.rows.length ||
      value.complete !== (value.total === value.rows.length) ||
      new Set(value.owners.map(owner => owner.ref)).size !== value.owners.length ||
      new Set(value.capacity.map(item => item.kind)).size !== value.capacity.length)
    ctx.addIssue({ code: "custom", message: "Finite source rows, facets and coverage must reconcile." });
});
export type RecruitmentBatchSourceSnapshot = z.infer<typeof recruitmentBatchSourceSchema>;
export type RecruitmentSnapshot = InvitationSourceSnapshot | RecruitmentBatchSourceSnapshot;
export type RecruitmentSourceRequest =
  { kind: "invitation"; scope: ApprovalScope; actor: TrustedHuman; filters: InvitationFilters } |
  { kind: "batch"; scope: ApprovalScope; actor: TrustedHuman; filters: RecruitmentBatchFilters };

/** Private current-source contract. Selectors and labels are deliberately distinct.
 * Readers must exclude contact/health/session secrets. This grants no dispatch authority.
 */
export interface RecruitmentSource {
  read(request: RecruitmentSourceRequest, options?: {signal?: AbortSignal}): Promise<unknown>;
  /** Inspect current backing permission/material, synchronously returning undefined. */
  assertCurrent(request: RecruitmentSourceRequest, snapshot: RecruitmentSnapshot, now: number): void;
}
/** The existing source owner must resolve canonical stored payloadRef/targetRef and preserve
 * the original J04 proof in execution and original dispatchKey in reconciliation. */
export type RecruitmentInvitationOwner = { registry: ApprovalRegistry; handler: DispatchHandler };
export class RecruitmentError extends Error {
  readonly code: string;
  readonly status: number;
  readonly executionCertainty: "notApplied" | "applied" | "uncertain";
  readonly currentVersion: string | undefined;
  constructor(code: string, status = 409, executionCertainty: RecruitmentError["executionCertainty"] = "notApplied", currentVersion?: string) {
    super(code); this.name = "RecruitmentError"; this.code = code; this.status = status;
    this.executionCertainty = executionCertainty; this.currentVersion = currentVersion;
  }
}
