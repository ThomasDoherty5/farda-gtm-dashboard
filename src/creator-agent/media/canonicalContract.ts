import { z } from "zod";
import { approvalScopeSchema, approvalInstantSchema as instant, approvalHashSchema as hash, type DispatchApprovalBinding } from "../approvals/contract.ts";
import { expectedBindingSchema } from "../connections/schema.ts";
import { resourceRequirementsSchema, type ResourceGrant } from "../jobs/dispatchSchema.ts";
import { ref, manifestSchema, nativeSettingsSchema, MEDIA_GATES, gateReceiptSchema } from "./contract.ts";
import { stageInputSchema } from "../mediaControl/contract.ts";

export const MEDIA_ACTIONS = ["media.createDraft", "media.publish", "media.changeBudget", "media.pause"] as const;
export type CanonicalMediaAction = typeof MEDIA_ACTIONS[number];
const positive = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
export const canonicalMediaRequestSchema = z.object({ campaignId: ref, revision: positive, manifestHash: hash, manifest: manifestSchema,
  entityRef: ref, entityVersion: ref, action: z.enum(MEDIA_ACTIONS), requestHash: hash,
  expiresAt:instant, dailyBudgetMinor: positive.nullable(), nativeCampaignId: ref.nullable(), safetyGeneration: count, legacyPending: z.boolean() }).strict();
export type CanonicalMediaRequest = z.infer<typeof canonicalMediaRequestSchema>;
const permission = z.object({ sourceRef: ref, sourceVersion: ref, state: z.enum(["permitted", "denied", "unknown"]), validUntil: instant }).strict();
const native = z.object({ settings: nativeSettingsSchema, nativeVersion: ref, publicationGeneration: ref, safetyGeneration: count }).strict();
const pool = z.object({ poolRef: ref, poolVersion: ref, allocationHash: hash, stageReceiptRef: ref, resourceRef: ref,
  campaignExposureMinor: positive, state: z.enum(["released", "held"]), validUntil: instant }).strict();
/** Exact source-issued backing facts. Growth gate receipts remain five independent current receipts. */
export const mediaSourceSnapshotSchema = z.object({ scope: approvalScopeSchema, entityRef: ref, entityVersion: ref, requestHash: hash,
  sourceRef: ref, sourceVersion: ref, observedAt: instant, validUntil: instant, permission,
  providerBinding: expectedBindingSchema, native: native.nullable(), pool: pool.nullable(),
  gates: z.array(gateReceiptSchema).max(MEDIA_GATES.length),
  safety: z.object({ policyRef: ref, policyVersion: ref, publicationGeneration: ref, desiredStatus: z.literal("PAUSED"),
    maxNativeEffects: z.literal(1), permittedTriggers: z.array(ref).min(1).max(30) }).strict().nullable(),
}).strict();
export type MediaSourceSnapshot = z.infer<typeof mediaSourceSnapshotSchema>;
export const mediaOperationIdentitySchema = z.object({ scope: approvalScopeSchema, action: z.enum(MEDIA_ACTIONS),
  campaignId: ref, revision: positive, manifestHash: hash, entityRef: ref, entityVersion: ref, requestHash: hash,
  dispatchKey: ref, payloadHash: hash, providerBindingHash: hash, attemptRef: ref, attemptNumber: positive,
  provider: z.enum(["meta", "tiktok"]), providerAccountRef: ref, nativeCampaignId: ref.nullable() }).strict();
export type MediaOperationIdentity = z.infer<typeof mediaOperationIdentitySchema>;
export const canonicalMediaReadbackSchema = z.discriminatedUnion("state", [
  mediaOperationIdentitySchema.extend({ state: z.literal("applied"), receiptRef: ref, observedAt: instant,
    outcome: z.enum(["applied", "rejected"]), rejectionCode: ref.nullable(), native }).strict(),
  mediaOperationIdentitySchema.extend({ state: z.literal("notApplied"), receiptRef: ref, observedAt: instant, validUntil: instant,
    complete: z.literal(true), originalAttemptClosed: z.literal(true) }).strict(),
  z.object({ state: z.literal("unknown"), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/) }).strict(),
]);
export type CanonicalMediaReadback = z.infer<typeof canonicalMediaReadbackSchema>;
export type CanonicalMediaCheckpoint = { identity: MediaOperationIdentity; binding: DispatchApprovalBinding; decisionReceiptRef: string;
  startedAt: string; source: MediaSourceSnapshot; receipt: Extract<CanonicalMediaReadback,{state:"applied"}>|null;
  closed: Extract<CanonicalMediaReadback,{state:"notApplied"}>|null };
/** Native boundary must condition atomically on these versions and enforce the original operation key. */
export type MediaConditionalWrite = MediaOperationIdentity & { approval: DispatchApprovalBinding; decisionReceiptRef: string;
  manifest: z.infer<typeof manifestSchema>; desired: { status:"PAUSED"|"ACTIVE"|null; dailyBudgetMinor:number|null };
  expectedSourceVersion: string; expectedNativeVersion: string|null; expectedPublicationGeneration: string|null;
  expectedSafetyGeneration: number; pool: z.infer<typeof pool>|null; resourceGrants: readonly ResourceGrant[] };
export interface CanonicalMediaSource {
  idempotency: "source-enforced";
  conditionalWrites: "native-version-and-safety-generation";
  readBasis(input:{scope:z.infer<typeof approvalScopeSchema>;request:CanonicalMediaRequest}):Promise<unknown>;
  assertCurrent(snapshot:MediaSourceSnapshot,now:number):void;
  perform(input:MediaConditionalWrite):Promise<unknown>;
  readOperation(identity:MediaOperationIdentity):Promise<unknown>;
  assertReadCurrent(identity:MediaOperationIdentity,now:number):void;
}
export const mediaResourceBasisSchema = z.object({ entityRef:ref, entityVersion:ref, payloadHash:hash, request:canonicalMediaRequestSchema, requirements:resourceRequirementsSchema }).strict();

export const MEDIA_STAGE_ACTION = "media.stageRelease" as const;
export const MEDIA_STAGE_HANDLER = "media-stage-release.v1" as const;
export const stageSourceSnapshotSchema = z.object({ scope:approvalScopeSchema, stageRef:ref, revision:positive, subjectHash:hash,
  sourceRef:ref, sourceVersion:ref, observedAt:instant, validUntil:instant, permission,
  governanceAccount: z.object({ kind:z.literal("internalGovernance"), accountRef:ref, accountVersion:ref, sourceRef:ref }).strict(),
  poolRef:ref, poolVersion:ref, allocationHash:hash, terms:stageInputSchema,
  parameterVersion:ref, adoptionRef:ref, adoptedAt:instant,
  gates:z.array(z.object({gate:z.enum(MEDIA_GATES),state:z.enum(["verified","held","failed"]),sourceRef:ref,sourceVersion:ref,validUntil:instant}).strict()).length(MEDIA_GATES.length),
}).strict();
export type StageSourceSnapshot=z.infer<typeof stageSourceSnapshotSchema>;
export interface CanonicalStageSource {
  readBasis(input:{scope:z.infer<typeof approvalScopeSchema>;stageRef:string;revision:number;subjectHash:string}):Promise<unknown>;
  assertCurrent(snapshot:StageSourceSnapshot,now:number):void;
  assertReadCurrent(stageRef:string,now:number):void;
}
