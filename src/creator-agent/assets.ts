import { z } from "zod";

// Opaque references only. File URLs, paths and credentials never enter this contract.
export const assetIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const text = z.string().trim().min(1).max(240);
const timestamp = z.string().datetime();
export const assetScopeSchema = z.object({ workspaceId: assetIdSchema, accountId: assetIdSchema }).strict();
export type AssetScope = z.infer<typeof assetScopeSchema>;
export const sourceReferenceSchema = z.object({ provider: assetIdSchema, accountId: assetIdSchema, sourceId: assetIdSchema }).strict();
export type AssetSourceReference = z.infer<typeof sourceReferenceSchema>;
export const transformationSchema = z.enum(["crop", "subtitles", "cut", "audio", "format"]);
export const useKindSchema = z.enum(["paid_ad", "brand_organic", "owned_channel"]);
export const assetSubmissionSchema = z.object({
  assetId: assetIdSchema, fileVersion: assetIdSchema, creatorId: assetIdSchema,
  collaborationId: assetIdSchema, deliverableId: assetIdSchema, submissionId: assetIdSchema,
  briefId: assetIdSchema, briefVersion: assetIdSchema, campaignId: assetIdSchema.nullable(),
  productId: assetIdSchema, productRevision: assetIdSchema,
  useCase: text, concept: text, hook: text,
  format: z.enum(["video/mp4", "video/quicktime", "image/jpeg", "image/png", "image/webp"]),
  durationMs: z.number().int().positive().max(86_400_000).nullable(),
  source: sourceReferenceSchema,
  lineage: z.object({ parentAssetId: assetIdSchema, parentVersion: z.number().int().positive(),
    changes: z.array(transformationSchema).min(1).max(5), editorRef: assetIdSchema, provenanceRef: assetIdSchema,
  }).strict().nullable(),
}).strict();
export type AssetSubmission = z.infer<typeof assetSubmissionSchema>;
export const sourceEvidenceSchema = z.object({
  scope: assetScopeSchema, submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
  authorizationRef: assetIdSchema, observedAt: timestamp,
  availability: z.enum(["available", "unavailable", "quarantined"]),
  checksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type AssetSourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export type StoredAsset = { submission: AssetSubmission; version: number; recordedAt: string;
  submissionHash: string; sourceEvidence: AssetSourceEvidence; storageIdentity: string | null };

export const assetUseSchema = z.object({
  assetId: assetIdSchema, version: z.number().int().positive(),
  kind: useKindSchema, channel: assetIdSchema, territory: z.string().regex(/^[A-Z]{2}$/),
  productId: assetIdSchema, productRevision: assetIdSchema,
  destination: sourceReferenceSchema,
}).strict();
export type AssetUse = z.infer<typeof assetUseSchema>;
/** Actual placement targeting from a trusted account adapter, not the caller's channel label. */
export const destinationEvidenceSchema = z.object({
  scope: assetScopeSchema, destination: sourceReferenceSchema, kind: useKindSchema,
  channel: assetIdSchema, territory: z.string().regex(/^[A-Z]{2}$/),
  authorizationRef: assetIdSchema, observedAt: timestamp, validUntil: timestamp,
}).strict();
export type AssetDestinationEvidence = z.infer<typeof destinationEvidenceSchema>;

/** J09-owned observation supplied by a trusted server adapter, never an HTTP request. */
export const assetRightsSchema = z.object({
  scope: assetScopeSchema, assetId: assetIdSchema, assetVersion: z.number().int().positive(),
  submissionHash: z.string().regex(/^[a-f0-9]{64}$/), checksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  review: z.enum(["pending", "accepted", "rejected"]), acceptedVersion: z.number().int().positive().nullable(),
  approvalVersion: assetIdSchema.nullable(), rightsVersion: assetIdSchema, evidenceRef: assetIdSchema,
  status: z.enum(["unknown", "pending", "granted", "expired", "revoked"]),
  startsAt: timestamp.nullable(), endsAt: timestamp.nullable(), observedAt: timestamp,
  validUntil: timestamp,
  kinds: z.array(useKindSchema).max(3), channels: z.array(assetIdSchema).max(30),
  territories: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250),
  allowedChanges: z.array(transformationSchema).max(5),
  musicCleared: z.boolean().nullable(), thirdPartyCleared: z.boolean().nullable(),
  productId: assetIdSchema, productRevision: assetIdSchema,
}).strict();
export type AssetRights = z.infer<typeof assetRightsSchema>;
export type AssetEligibility = {
  state: "eligible" | "blocked"; reasonCodes: string[]; checkedAt: string;
  authorityRefs: { assetId: string; version: number; rightsVersion: string; approvalVersion: string | null; evidenceRef: string }[];
  /** Eligibility prepares a handoff. It grants neither account access nor publication authority. */
  publishingAuthorized: false;
};
export type AssetExport = { id: string; assetId: string; version: number; use: AssetUse;
  preparedAt: string; state: "prepared"; externalEffect: "none"; eligibility: AssetEligibility };
export const deploymentRequestSchema = z.object({
  assetId: assetIdSchema, version: z.number().int().positive(), exportId: assetIdSchema.nullable(),
  receiptRef: sourceReferenceSchema,
}).strict();
export type DeploymentRequest = z.infer<typeof deploymentRequestSchema>;
export const deploymentEvidenceSchema = z.object({
  scope: assetScopeSchema, assetId: assetIdSchema, assetVersion: z.number().int().positive(),
  exportId: assetIdSchema.nullable(), receiptRef: sourceReferenceSchema,
  destination: sourceReferenceSchema, observedAt: timestamp,
  // A source-owned revision, not arrival order; adapters must preserve ordering of native state changes.
  sourceVersion: z.number().int().positive().safe(),
  kind: z.enum(["creator_publication", "reuse"]),
  state: z.enum(["active", "removed", "unknown"]),
}).strict();
export type AssetDeployment = z.infer<typeof deploymentEvidenceSchema> & { id: string };
export type WithdrawalIntent = { id: string; deploymentId: string; exportId: string;
  deploymentSourceVersion: number;
  assetId: string; version: number; owner: "paid_media" | "content_reuse";
  state: "proposed" | "uncertain" | "confirmed"; reasonCodes: string[]; createdAt: string;
  reconciliationReceipts: WithdrawalEvidence[] };
export const withdrawalEvidenceSchema = z.object({
  scope: assetScopeSchema, intentId: assetIdSchema, deploymentId: assetIdSchema,
  deploymentSourceVersion: z.number().int().positive().safe(),
  receiptRef: sourceReferenceSchema, observedAt: timestamp,
  outcome: z.enum(["withdrawn", "not_applied", "uncertain"]),
}).strict();
export type WithdrawalEvidence = z.infer<typeof withdrawalEvidenceSchema>;

/** Implementations must use source-authorized scoped stores/J09/executor receipts, not caller URLs. */
export interface AssetAuthority {
  resolveSource(submission: AssetSubmission, scope: AssetScope): Promise<AssetSourceEvidence | null>;
  currentRights(asset: StoredAsset, scope: AssetScope): Promise<AssetRights | null>;
  resolveDestination(use: AssetUse, scope: AssetScope): Promise<AssetDestinationEvidence | null>;
  verifyDeployment(request: DeploymentRequest, scope: AssetScope): Promise<Omit<AssetDeployment, "id"> | null>;
  verifyWithdrawal(intent: WithdrawalIntent, receiptRef: AssetSourceReference, scope: AssetScope): Promise<WithdrawalEvidence | null>;
}
export const unavailableAssetAuthority: AssetAuthority = {
  resolveSource: async () => null, currentRights: async () => null,
  resolveDestination: async () => null,
  verifyDeployment: async () => null, verifyWithdrawal: async () => null,
};

export function sameAssetScope(a: AssetScope, b: AssetScope) {
  return a.workspaceId === b.workspaceId && a.accountId === b.accountId;
}

/** No rights are inferred from a matching file hash, accepted parent or public post. */
export function evaluateAssetUse(asset: StoredAsset, use: AssetUse, scope: AssetScope,
  chain: { asset: StoredAsset; rights: AssetRights | null }[], now: string): AssetEligibility {
  const reasons: string[] = [];
  const refs: AssetEligibility["authorityRefs"] = [];
  const fail = (reason: string) => reasons.push(reason);
  if (asset.submission.assetId !== use.assetId || asset.version !== use.version) fail("ASSET_VERSION_MISMATCH");
  if (!asset.submission.campaignId) fail("CAMPAIGN_ASSIGNMENT_PENDING");
  if (asset.submission.productId !== use.productId || asset.submission.productRevision !== use.productRevision) fail("PRODUCT_REVISION_MISMATCH");
  if (chain.length === 0 || chain[0]?.asset.submissionHash !== asset.submissionHash) fail("LINEAGE_INCOMPLETE");
  for (let index = 0; index < chain.length; index++) {
    const entry = chain[index]!;
    const a = entry.asset;
    const r = entry.rights;
    if (a.sourceEvidence.availability !== "available") fail("SOURCE_FILE_UNAVAILABLE");
    if (!a.sourceEvidence.checksum) fail("CHECKSUM_UNVERIFIED");
    if (!r) { fail("J09_RIGHTS_UNAVAILABLE"); continue; }
    if (!sameAssetScope(scope, r.scope) || r.assetId !== a.submission.assetId || r.assetVersion !== a.version || r.submissionHash !== a.submissionHash || r.checksum !== a.sourceEvidence.checksum) fail("RIGHTS_BINDING_MISMATCH");
    if (Date.parse(r.observedAt) > Date.parse(now) || Date.parse(r.validUntil) <= Date.parse(now)) fail("RIGHTS_OBSERVATION_STALE");
    if (r.review !== "accepted" || r.acceptedVersion !== a.version || !r.approvalVersion) fail("EXACT_VERSION_NOT_ACCEPTED");
    if (r.status !== "granted") fail(`RIGHTS_${r.status.toUpperCase()}`);
    if (!r.startsAt || !r.endsAt || Date.parse(r.startsAt) > Date.parse(now) || Date.parse(r.endsAt) <= Date.parse(now)) fail("RIGHTS_OUTSIDE_TERM");
    if (!r.kinds.includes(use.kind) || !r.channels.includes(use.channel) || !r.territories.includes(use.territory)) fail("USE_OUTSIDE_RIGHTS_SCOPE");
    if (r.musicCleared !== true || r.thirdPartyCleared !== true) fail("THIRD_PARTY_RIGHTS_PENDING");
    if (r.productId !== use.productId || r.productRevision !== use.productRevision) fail("PRODUCT_REVISION_MISMATCH");
    // Each ancestor must permit every transformation applied below it, not just its direct child.
    const changes = chain.slice(0, index).flatMap((child) => child.asset.submission.lineage?.changes ?? []);
    if (changes.some((change) => !r.allowedChanges.includes(change))) fail("DERIVATIVE_OUTSIDE_RIGHTS_SCOPE");
    refs.push({ assetId: a.submission.assetId, version: a.version, rightsVersion: r.rightsVersion, approvalVersion: r.approvalVersion, evidenceRef: r.evidenceRef });
  }
  return { state: reasons.length ? "blocked" : "eligible", reasonCodes: [...new Set(reasons)], checkedAt: now, authorityRefs: refs, publishingAuthorized: false };
}
