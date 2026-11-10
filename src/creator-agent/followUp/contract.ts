import { z } from "zod";
import { instant, reference } from "../actions/contract.ts";
import { assetRightsSchema, assetScopeSchema, assetSubmissionSchema, assetUseSchema, sourceEvidenceSchema } from "../assets.ts";
import { workflowDeliverableSchema } from "../collaborationWorkflowSchema.ts";

/** IANA zone names only. An unknown zone is never replaced by a default. */
export function isTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}
const day = z.string().date();
const timezone = z.string().min(1).max(100).refine(isTimezone, "Unknown timezone.");

export const FOLLOW_UP_POLICY_VERSION = "creator-follow-up.v1";

/**
 * Which reminder policy applies. It conflicts with the collaboration workflow's reminder rule (see
 * docs/creator-follow-up.md), so the owner must choose. There is no default: creator reminders are refused until it is set.
 * - `preDue`: creator reminders from two days before the due day through the grace period, then human review.
 * - `postGraceOnly`: no reminder before grace has elapsed; past grace, a creator reminder plus human review.
 */
export const reminderPolicySchema = z.enum(["preDue", "postGraceOnly"]);
export type ReminderPolicy = z.infer<typeof reminderPolicySchema>;

export const followUpConfigSchema = z.object({
  /** The operating timezone that posting days are counted in. */
  timezone,
  /** Days ahead of a rights end date that an expiry warning is raised. */
  rightsWarningDays: z.number().int().min(1).max(90),
  reminderPolicy: reminderPolicySchema.optional(),
}).strict();
export type FollowUpConfig = z.infer<typeof followUpConfigSchema>;
/** Deliberately leaves `reminderPolicy` unset. */
export const defaultFollowUpConfig = (zone: string): FollowUpConfig =>
  followUpConfigSchema.parse({ timezone: zone, rightsWarningDays: 14 });
/** Under `preDue`, the first reminder opens on the local day two days before the due day. */
export const REMINDER_LEAD_DAYS = 2;

/**
 * Synthetic posting clock. The real clock comes from the Notion collaboration source once it is
 * connected; until then only an explicitly synthetic event is accepted, so nothing passes it off as source data.
 */
export const postingClockEventSchema = z.object({
  origin: z.literal("synthetic"),
  collaborationId: reference,
  posting: z.enum(["committed", "voluntary", "unknown"]),
  dueDate: day.nullable(),
  graceDays: z.number().int().min(0).max(365).nullable(),
  /** The timezone the source states for the deadline. A missing one is never filled in from configuration. */
  timezone: z.string().min(1).max(100).nullable(),
  sourceRef: reference,
  observedAt: instant,
}).strict().superRefine((event, ctx) => {
  if (event.posting === "voluntary" && (event.dueDate !== null || event.graceDays !== null))
    ctx.addIssue({ code: "custom", message: "Voluntary posting has no due date or grace." });
});
export type PostingClockEvent = z.infer<typeof postingClockEventSchema>;

/** Synthetic delivery evidence. Publication proof reuses the collaboration workflow's native publication shape. */
export const deliveryEvidenceSchema = z.object({
  origin: z.literal("synthetic"),
  collaborationId: reference,
  deliverableRef: reference,
  contentVersion: reference,
  publication: workflowDeliverableSchema.shape.publication,
  sourceRef: reference,
}).strict();
export type DeliveryEvidence = z.infer<typeof deliveryEvidenceSchema>;

export const outreachStateSchema = z.enum(["clear", "suppressed", "unknown"]);
export type OutreachState = z.infer<typeof outreachStateSchema>;

/** The asset store keeps `StoredAsset` as a type only, so its shape is restated here from the exported part schemas. */
const storedAssetSchema = z.object({ submission: assetSubmissionSchema, version: z.number().int().positive(), recordedAt: z.string().datetime(),
  submissionHash: z.string().regex(/^[a-f0-9]{64}$/), sourceEvidence: sourceEvidenceSchema, storageIdentity: z.string().max(240).nullable() }).strict();
export const rightsGateInputSchema = z.object({ scope: assetScopeSchema, asset: storedAssetSchema,
  chain: z.array(z.object({ asset: storedAssetSchema, rights: assetRightsSchema.nullable() }).strict()).max(20), use: assetUseSchema }).strict();

const amount = z.number().finite();
export const untrustedTermsSchema = z.object({ relationship: z.string().min(1).max(60), upfrontFeeMinor: amount, guaranteedFeeMinor: amount,
  paidComponentMinor: amount, commissionPct: amount, perSaleFixedMinor: amount, sampleCostMinor: amount }).strict();
/** A creator reply or proposed terms. The terms decision is always recomputed from this, never taken as given. */
export const termsInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), text: z.string().min(1).max(5000), sourceRef: reference }).strict(),
  z.object({ kind: z.literal("terms"), terms: untrustedTermsSchema, sourceRef: reference }).strict(),
]);
export type TermsInput = z.infer<typeof termsInputSchema>;

export const CLOSURE_REASONS = ["posted-verified", "declined", "expired", "terms-mismatch", "rights-unavailable", "cancelled"] as const;
export const closureReasonSchema = z.enum(CLOSURE_REASONS);
export type ClosureReason = z.infer<typeof closureReasonSchema>;
/** Each closure reason requires its own evidence. Terms and rights are re-evaluated, never trusted as a verdict. */
export const closureEvidenceSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("posted-verified"), delivery: deliveryEvidenceSchema }).strict(),
  z.object({ reason: z.literal("declined"), sourceRef: reference }).strict(),
  z.object({ reason: z.literal("expired"), event: postingClockEventSchema }).strict(),
  z.object({ reason: z.literal("terms-mismatch"), terms: termsInputSchema }).strict(),
  z.object({ reason: z.literal("rights-unavailable"), rights: rightsGateInputSchema, sourceRef: reference }).strict(),
  z.object({ reason: z.literal("cancelled"), sourceRef: reference }).strict(),
]);
export type ClosureEvidence = z.infer<typeof closureEvidenceSchema>;

export const FOLLOW_UP_STEPS = ["due-minus-2", "within-grace", "post-grace", "past-grace", "rights-expiry-warning"] as const;
export type FollowUpStep = typeof FOLLOW_UP_STEPS[number];
/** A creator message needs approval before it is sent. A human review item never messages the creator. */
export type FollowUpChannel = "creator-message" | "human-review";
/**
 * Each intent has exactly one way out of this module, fixed when it is created:
 * - `j04Preview`: a `preDue` creator reminder, through J04 exact-action approval;
 * - `workflowReminder`: a `postGraceOnly` creator reminder, through the collaboration workflow's `reminder` proposal;
 * - `workflowHandoff`: a human-review item, through the collaboration workflow's `human-handoff` proposal.
 */
export type SendPath = "j04Preview" | "workflowReminder" | "workflowHandoff";

export const INTENT_STATES = ["proposed", "awaitingApproval", "approvalHeld", "dispatched", "handedOff", "uncertain", "sent", "notSent", "superseded"] as const;
export type IntentState = typeof INTENT_STATES[number];
export type SupersededBy = "closure" | "dueDateChanged" | "stepAdvanced" | "outreachSuppressed";

export type FollowUpIntent = {
  intentRef: string;
  /** Opaque version bound to the exact intent body; the J04 preview binds to it. */
  intentVersion: string;
  collaborationId: string;
  step: FollowUpStep;
  /** Due-date version for reminders; the rights binding for an expiry warning. */
  dueVersion: string;
  channel: FollowUpChannel;
  sendPath: SendPath;
  localDay: string;
  timezone: string;
  reasonCodes: string[];
  sourceRef: string;
  policyVersion: string;
  createdAt: string;
  /** This module never sends. */
  sends: false;
};
export type StoredIntent = FollowUpIntent & {
  state: IntentState;
  supersededBy: SupersededBy | null;
  /** State when superseded, so an operator can see whether it was already in J04. */
  supersededFrom: IntentState | null;
  approvalRef: string | null;
  manifestRef: string | null;
  runRef: string | null;
  /** The collaboration workflow proposal, once handed off. */
  workflowProposalRef: string | null;
  /** The first signed run version seen. It stays the reconciliation binding. */
  runVersion: string | null;
  receiptRefs: string[];
  holdReasons: string[];
  updatedAt: string;
};

/** Outcomes reported back from the existing actions service. Approved is not sent. */
const refs = { approvalRef: reference.nullable(), manifestRef: reference.nullable(), runRef: reference.nullable(), runVersion: reference.nullable() };
export const sendOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approvalRecorded"), intentRef: reference, approvalRef: reference, manifestRef: reference }).strict(),
  /** A blocked or denied approval request. Nothing is pending in J04 for it. */
  z.object({ kind: z.literal("approvalHeld"), intentRef: reference, approvalRef: reference.nullable(), manifestRef: reference.nullable(),
    reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("dispatchPending"), intentRef: reference, approvalRef: reference, manifestRef: reference, runRef: reference, runVersion: reference }).strict(),
  z.object({ kind: z.literal("sent"), intentRef: reference, approvalRef: reference, manifestRef: reference, runRef: reference, runVersion: reference,
    receiptRefs: z.array(reference).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("notSent"), intentRef: reference, ...refs, receiptRefs: z.array(reference).max(100) }).strict(),
  z.object({ kind: z.literal("uncertain"), intentRef: reference, ...refs }).strict(),
]);
export type SendOutcome = z.infer<typeof sendOutcomeSchema>;

/**
 * The answer from the collaboration workflow's `proposeCollaborationReview` for one intent. `recorded` carries its
 * proposal reference; `notApplied` is its sealed stale-version refusal; `uncertain` needs its `proposalRequestKey` lookup.
 */
export const workflowHandoffSchema = z.discriminatedUnion("result", [
  z.object({ intentRef: reference, result: z.literal("recorded"), proposalRef: reference }).strict(),
  z.object({ intentRef: reference, result: z.literal("notApplied") }).strict(),
  z.object({ intentRef: reference, result: z.literal("uncertain") }).strict(),
]);
export type WorkflowHandoff = z.infer<typeof workflowHandoffSchema>;
