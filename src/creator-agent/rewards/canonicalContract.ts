import { z } from "zod";
import { approvalScopeSchema, approvalInstantSchema, approvalHashSchema, type DispatchApprovalBinding } from "../approvals/contract.ts";
import { resourceRequirementsSchema } from "../jobs/dispatchSchema.ts";
import { expectedBindingSchema } from "../connections/schema.ts";
import { entitlementSchema, prepareSchema, quoteSchema, providerStateSchema, purchaseReceiptSchema, ref, type RewardOption } from "./contract.ts";

export const REWARD_ACTION = "reward.redeem" as const;
export const REWARD_HANDLER = "reward-redemption.v1" as const;
const positive = z.number().int().positive().safe();
const stock = z.discriminatedUnion("state", [
  z.object({ state: z.literal("required"), sourceRef: ref, sourceVersion: ref, purpose: z.literal("creator-reward"),
    resourceRef: ref, skuRef: ref, locationRef: ref, quantity: positive, productVersion: ref, validUntil: approvalInstantSchema }).strict(),
  z.object({ state: z.literal("notApplicable"), policyVersion: ref, reason: z.string().min(1).max(500) }).strict(),
]);
/** Trusted source evidence, never an HTTP approval or a browser-computed eligibility flag. */
export const rewardSourceSnapshotSchema = z.object({
  scope: approvalScopeSchema, redemptionId: ref, revision: positive, requestHash: approvalHashSchema,
  sourceRef: ref, sourceVersion: ref, observedAt: approvalInstantSchema, validUntil: approvalInstantSchema,
  entitlement: entitlementSchema, quote: quoteSchema, provider: providerStateSchema,
  providerBinding: expectedBindingSchema, stock,
}).strict();
export type RewardSourceSnapshot = z.infer<typeof rewardSourceSnapshotSchema>;
/** Internal repository projection; no private source data is added to the public redemption view. */
export type CanonicalRewardRequest = {
  redemptionId: string; revision: number; requestHash: string; revisedAt: string;
  entitlement: z.infer<typeof entitlementSchema>; input: z.infer<typeof prepareSchema>;
  option: RewardOption | null; quote: z.infer<typeof quoteSchema> | null;
  legacyAttempt: boolean; canonicalDispatchKey: string | null;
};
export const canonicalPurchaseIdentitySchema = z.object({ scope: approvalScopeSchema, redemptionId: ref, revision: positive,
  requestHash: approvalHashSchema, dispatchKey: ref, payloadHash: approvalHashSchema, providerBindingHash: approvalHashSchema,
  attemptRef: ref, attemptNumber: positive }).strict();
export type CanonicalPurchaseIdentity = z.infer<typeof canonicalPurchaseIdentitySchema>;
export const canonicalPurchaseReadbackSchema = z.discriminatedUnion("state", [
  canonicalPurchaseIdentitySchema.extend({ state: z.literal("applied"), receipt: purchaseReceiptSchema,
    receiptRef: ref, observedAt: approvalInstantSchema }).strict(),
  canonicalPurchaseIdentitySchema.extend({ state: z.literal("notApplied"), receiptRef: ref, observedAt: approvalInstantSchema,
    validUntil: approvalInstantSchema, complete: z.literal(true), originalAttemptClosed: z.literal(true) }).strict(),
  z.object({ state: z.literal("unknown"), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/) }).strict(),
]);
export type CanonicalPurchaseReadback = z.infer<typeof canonicalPurchaseReadbackSchema>;
export type CanonicalPurchaseApplied = Extract<CanonicalPurchaseReadback, { state: "applied" }>;
export type CanonicalPurchaseClosed = Extract<CanonicalPurchaseReadback, { state: "notApplied" }>;
export type RewardPurchaseIntent = CanonicalPurchaseIdentity & {
  approval: DispatchApprovalBinding; decisionReceiptRef: string; providerRef: string; providerBindingRef: string;
  optionId: string; quoteRef: string; recipientRef: string; deliveryRoute: string; fundingRef: string;
  capMinor: number; currency: "USD"; physicalAllocationRef: string | null;
  expectedSourceVersion: string; expectedPolicyVersion: string; expectedExecutionVersion: string;
};
export type RewardPurchaseLookup = CanonicalPurchaseIdentity & { providerRef: string; providerBindingRef: string };
export interface RewardDomainSource {
  idempotency: "source-enforced";
  readBasis(input: { scope: z.infer<typeof approvalScopeSchema>; redemptionId: string; revision: number; requestHash: string }): Promise<unknown>;
  assertCurrent(snapshot: RewardSourceSnapshot, now: number): void;
  purchase(input: RewardPurchaseIntent): Promise<unknown>;
  readPurchase(input: RewardPurchaseLookup): Promise<unknown>;
  /** Independent read permission. Current purchase eligibility is not required to preserve a prior native receipt. */
  assertReadCurrent(input: RewardPurchaseLookup, now: number): void;
}
export type CanonicalRewardCheckpoint = {
  binding: DispatchApprovalBinding; decisionReceiptRef: string; identity: CanonicalPurchaseIdentity;
  startedAt: string; physicalAllocationRef: string | null;
  closed: CanonicalPurchaseClosed | null; receipt: CanonicalPurchaseApplied | null;
};

/** Durable frozen payload material, not an approval, resource reservation or source authorization. */
export const rewardResourceBasisSchema = z.object({
  redemptionId: ref, revision: positive, requestHash: approvalHashSchema, payloadHash: approvalHashSchema,
  requirements: resourceRequirementsSchema,
}).strict();
export type RewardResourceBasis = z.infer<typeof rewardResourceBasisSchema>;
