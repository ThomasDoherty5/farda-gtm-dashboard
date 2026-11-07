import { z } from "zod";

export const approvalRefSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(value => !/^https?:/i.test(value), "Use an opaque reference.");
export const approvalHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const approvalInstantSchema = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "A finite timestamp is required.");
const count = z.number().int().nonnegative().safe();
const version = z.number().int().positive().safe();
export const approvalScopeSchema = z.object({ workspaceId: approvalRefSchema, accountId: approvalRefSchema, environment: z.literal("sandbox") }).strict();
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;
export const principalSchema = z.object({ principalRef: approvalRefSchema }).strict();
export type ApprovalPrincipal = z.infer<typeof principalSchema>;
export const versionRequirementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("required"), version: approvalRefSchema }).strict(),
  z.object({ state: z.literal("notApplicable"), policyVersion: approvalRefSchema, reason: z.string().min(1).max(500) }).strict(),
]);
export const approvalPhaseSchema = z.enum(["invitation", "activation", "shipment", "settlement", "rewardRedemption", "policyChange", "launch", "productionEnable", "other"]);
export type ApprovalPhase = z.infer<typeof approvalPhaseSchema>;
export const approvalGateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("satisfied"), sourceRef: approvalRefSchema, sourceVersion: approvalRefSchema, validUntil: approvalInstantSchema }).strict(),
  z.object({ state: z.literal("notApplicable"), policyVersion: approvalRefSchema, reason: z.string().min(1).max(500) }).strict(),
  z.object({ state: z.literal("unknown"), reason: z.string().min(1).max(500) }).strict(),
]);
export const approvalTermsSchema = z.object({ relationship: z.string().min(1).max(60), upfrontFeeMinor: count, guaranteedFeeMinor: count, paidComponentMinor: count,
  commissionPct: z.number().finite().min(0).max(100), perSaleFixedMinor: count, sampleCostMinor: count }).strict();
export const approvalItemSchema = z.object({ itemRef: approvalRefSchema, itemVersion: approvalRefSchema, targetRef: approvalRefSchema, targetVersion: approvalRefSchema,
  payloadHash: approvalHashSchema, sourceRef: approvalRefSchema, units: count, spendMinor: count }).strict();
export type ApprovalItem = z.infer<typeof approvalItemSchema>;
export const approvalDraftSchema = z.object({
  actionKind: approvalRefSchema, phase: approvalPhaseSchema, providerAccountRef: approvalRefSchema, providerAccountVersion: approvalRefSchema,
  payloadHash: approvalHashSchema, payloadRef: approvalRefSchema, productVersion: versionRequirementSchema, termsVersion: versionRequirementSchema,
  rightsVersion: versionRequirementSchema, configVersion: approvalRefSchema, policyVersion: approvalRefSchema,
  effects: z.object({ spendsMoney: z.boolean(), sendsCreator: z.boolean(), changesPolicy: z.boolean() }).strict(),
  items: z.array(approvalItemSchema).min(1).max(100),
  bounds: z.object({ maxItems: z.number().int().min(1).max(100), maxUnits: count, maxSpendMinor: count, currency: z.literal("USD") }).strict(),
  exposure: z.discriminatedUnion("state", [z.object({ state: z.literal("known"), minor: count, currency: z.literal("USD") }).strict(), z.object({ state: z.literal("unknown"), reason: z.string().min(1).max(500) }).strict()]),
  acquisitionTerms: approvalTermsSchema.nullable(), historicalLiability: z.object({ sourceRef: approvalRefSchema, sourceVersion: approvalRefSchema, acceptedMinor: count, currency: z.literal("USD"), validUntil: approvalInstantSchema }).strict().nullable(),
  // Source registry selects exact saved offers. Eligibility hashes never replace J04 approval or source grants.
  commercialOffers: z.array(z.object({ itemRef: approvalRefSchema, offerRef: approvalRefSchema,
    basisHash: approvalHashSchema.optional() }).strict()).min(1).max(100).optional(),
  // Optional preserves the hashes of existing five-gate manifests. Physical reward phases require it in policy.
  gates: z.object({ acceptedTerms: approvalGateSchema, sampleAuthority: approvalGateSchema, providerTerms: approvalGateSchema, launchReadiness: approvalGateSchema, sourcePermission: approvalGateSchema,
    rewardStockAuthority: approvalGateSchema.optional() }).strict(),
  sourceBasisRef: approvalRefSchema, sourceBasisVersion: approvalRefSchema, sourceValidUntil: approvalInstantSchema,
  linearIssueRef: approvalRefSchema, expiresAt: approvalInstantSchema,
}).strict().superRefine((draft, ctx) => {
  if (new Set(draft.items.map(item => item.itemRef)).size !== draft.items.length || new Set(draft.items.map(item => item.targetRef)).size !== draft.items.length)
    ctx.addIssue({ code: "custom", message: "Items and targets must be unique in a finite manifest." });
  const units = draft.items.reduce((sum, item) => sum + BigInt(item.units), 0n), spend = draft.items.reduce((sum, item) => sum + BigInt(item.spendMinor), 0n);
  if (draft.items.length > draft.bounds.maxItems || units > BigInt(draft.bounds.maxUnits) || spend > BigInt(draft.bounds.maxSpendMinor))
    ctx.addIssue({ code: "custom", message: "Items exceed finite resource bounds." });
  if (draft.exposure.state === "known" && (BigInt(draft.exposure.minor) < spend || draft.exposure.minor > draft.bounds.maxSpendMinor))
    ctx.addIssue({ code: "custom", message: "Exposure must cover the finite items within the approved bound." });
});
export type ApprovalDraft = z.infer<typeof approvalDraftSchema>;
export const proposeCommandSchema = z.object({ actionKind: approvalRefSchema, entityRef: approvalRefSchema, entityVersion: approvalRefSchema,
  selectionRefs: z.array(approvalRefSchema).min(1).max(100), approvalRef: approvalRefSchema.optional(), expectedVersion: count }).strict();
export type ProposeCommand = z.infer<typeof proposeCommandSchema>;
export const approvalCommandSchema = z.object({ approvalRef: approvalRefSchema, expectedVersion: version }).strict();
export type ApprovalCommand = z.infer<typeof approvalCommandSchema>;
export const trustedHumanSchema = z.object({ scope: approvalScopeSchema, principalRef: approvalRefSchema, personRef: approvalRefSchema,
  roles: z.array(z.enum(["founder", "operator", "reviewer", "finance", "viewer"])).min(1), active: z.boolean(), directoryVersion: approvalRefSchema,
  observedAt: approvalInstantSchema, validUntil: approvalInstantSchema }).strict();
export type TrustedHuman = z.infer<typeof trustedHumanSchema>;
export const approvalPolicySchema = z.object({ scope: approvalScopeSchema, version: approvalRefSchema, sourceRef: approvalRefSchema, observedAt: approvalInstantSchema, validUntil: approvalInstantSchema,
  founderThresholdMinor: z.literal(50_000), currency: z.literal("USD"), appDecisionsEnabled: z.literal(false),
  commission: z.object({ version: approvalRefSchema, maxCommissionPct: z.number().finite().min(0).max(100), sampleCapMinor: count }).strict() }).strict();
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export type ApprovalManifest = { scope: ApprovalScope; approvalRef: string; manifestVersion: number; manifestHash: string; policyHash: string; proposer: { principalRef: string; personRef: string; directoryVersion: string };
  createdAt: string; draft: ApprovalDraft; items: (ApprovalItem & { itemHash: string })[] };
export const slackDecisionLocatorSchema = z.object({ workspaceRef: approvalRefSchema, channelRef: approvalRefSchema, threadRef: approvalRefSchema, eventRef: approvalRefSchema }).strict();
export type SlackDecisionLocator = z.infer<typeof slackDecisionLocatorSchema>;
export type TrustedApprovalIngress = { ingressRef: string };
export const slackDecisionSchema = z.object({ scope: approvalScopeSchema, locator: slackDecisionLocatorSchema, requestRecordRef: approvalRefSchema,
  approvalRef: approvalRefSchema, manifestVersion: version, manifestHash: approvalHashSchema, principalRef: approvalRefSchema, personRef: approvalRefSchema,
  decision: z.enum(["approved", "rejected", "editRequired", "canceled"]), proposedEditRef: approvalRefSchema.nullable(), sourceVersion: approvalRefSchema,
  decidedAt: approvalInstantSchema, observedAt: approvalInstantSchema, validUntil: approvalInstantSchema,
  state: z.enum(["current", "edited", "deleted", "ambiguous", "revoked"]) }).strict();
export type VerifiedSlackDecision = z.infer<typeof slackDecisionSchema>;
export const linearRecordIntentSchema = z.object({ scope: approvalScopeSchema, intentRef: approvalRefSchema, kind: z.enum(["request", "decision", "outcome"]),
  issueRef: approvalRefSchema, approvalRef: approvalRefSchema, manifestVersion: version, manifestHash: approvalHashSchema, contentHash: approvalHashSchema,
  preview: z.object({ manifestRef: approvalRefSchema, actionKind: approvalRefSchema, providerAccountRef: approvalRefSchema,
    recipientRefs: z.array(approvalRefSchema).min(1).max(100), payloadHash: approvalHashSchema, termsVersion: versionRequirementSchema, rightsVersion: versionRequirementSchema,
    policyVersion: approvalRefSchema, bounds: z.object({ maxItems: count, maxUnits: count, maxSpendMinor: count, currency: z.literal("USD") }).strict(), expiresAt: approvalInstantSchema }).strict(),
  decision: slackDecisionSchema.nullable(), outcomeRef: approvalRefSchema.nullable() }).strict();
export type LinearRecordIntent = z.infer<typeof linearRecordIntentSchema>;
export const linearReadbackSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("recorded"), scope: approvalScopeSchema, intentRef: approvalRefSchema, issueRef: approvalRefSchema, recordRef: approvalRefSchema,
    contentHash: approvalHashSchema, sourceVersion: approvalRefSchema, active: z.boolean(), observedAt: approvalInstantSchema, validUntil: approvalInstantSchema }).strict(),
  z.object({ state: z.enum(["absent", "unknown", "denied"]), reason: z.string().min(1).max(500) }).strict(),
]);
export type LinearReadback = z.infer<typeof linearReadbackSchema>;
export type RecordedLinearRecord = Extract<LinearReadback, { state: "recorded" }>;
export type LinearWriteObservation = { state: "attempted" | "notApplied" | "unknown" };
export type ApprovalAuthoritySnapshot = { scope: ApprovalScope; actor: TrustedHuman; slack: VerifiedSlackDecision | null; linearRecords: RecordedLinearRecord[]; linearWriteIntent?: LinearRecordIntent };
export type ApprovalSources = {
  resolveActor?: (principalRef: string, scope: ApprovalScope) => Promise<unknown>;
  readSlackDecision?: (locator: SlackDecisionLocator, scope: ApprovalScope, ingress?: TrustedApprovalIngress) => Promise<unknown>;
  readLinearRecord?: (intent: LinearRecordIntent) => Promise<unknown>;
  writeLinearRecord?: (intent: LinearRecordIntent) => Promise<LinearWriteObservation>;
  /** Source-owned current-version/lease fence. Must not merely trust the supplied snapshot. */
  assertCurrent?: (snapshot: ApprovalAuthoritySnapshot, now: number) => void;
};
export type ApprovalRegistry = { resolvePreview: (command: ProposeCommand, principal: ApprovalPrincipal, scope: ApprovalScope) => Promise<unknown>;
  /** Fresh source basis, never a browser-computed equality flag. */
  currentDraft: (manifest: ApprovalManifest) => Promise<unknown>;
  /** Synchronous source-owned material-version fence for the final transaction. */
  assertCurrentDraft?: (manifest: ApprovalManifest, observed: ApprovalDraft, now: number) => void };

export type DecisionReceipt = { receiptRef: string; scope: ApprovalScope; approvalRef: string; manifestVersion: number; manifestHash: string;
  decision: VerifiedSlackDecision["decision"]; decidedAt: string; principalRef: string; personRef: string; directoryVersion: string;
  proposedEditRef: string | null;
  policyVersion: string; linearRecordRef: string; linearSourceVersion: string; linearContentHash: string; slack: SlackDecisionLocator; slackSourceVersion: string;
  expiresAt: string; bounds: ApprovalDraft["bounds"] };
export const dispatchApprovalBindingSchema = z.object({ scope: approvalScopeSchema, approvalRef: approvalRefSchema, manifestVersion: version, manifestHash: approvalHashSchema,
  itemRef: approvalRefSchema, itemVersion: approvalRefSchema, itemHash: approvalHashSchema, actionKind: approvalRefSchema, providerAccountRef: approvalRefSchema,
  payloadHash: approvalHashSchema, policyVersion: approvalRefSchema, termsVersion: versionRequirementSchema, rightsVersion: versionRequirementSchema, phase: approvalPhaseSchema }).strict();
export type DispatchApprovalBinding = z.infer<typeof dispatchApprovalBindingSchema>;
export type VerifiedApprovalProof = { verificationRef: string; binding: DispatchApprovalBinding; approvalRevision: number; decisionReceipt: DecisionReceipt;
  item: ApprovalItem & { itemHash: string }; observedAt: string; validUntil: string; policyEvidenceVersion: string; actorDirectoryVersion: string };
export type CurrentApprovalResult = { state: "verified"; proof: VerifiedApprovalProof } | { state: "held"; reasonCodes: string[]; historicalReceipt: DecisionReceipt | null };
export type ApprovalRead = { schemaVersion: "farda.approval.v1"; manifest: ApprovalManifest; revision: number;
  request: { state: "local" | "recorded" | "uncertain"; record: RecordedLinearRecord | null };
  decisionReceipt: DecisionReceipt | null; decisionHistory: DecisionReceipt[];
  current: { state: "pending" | "held" | "approved" | "rejected" | "editRequired" | "canceled"; reasonCodes: string[] };
  outbox: { intentRef: string; kind: LinearRecordIntent["kind"]; state: "pending" | "attempted" | "recorded" | "uncertain"; attempts: number }[];
  outcomeRefs: string[]; sourceEffect: "none" };
export type VerifiedExistingJobOutcome = { approvalRef: string; manifestVersion: number; manifestHash: string; itemRef: string; runRef: string; outcomeRef: string };

export class ApprovalError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "ApprovalError"; this.code = code; }
}
