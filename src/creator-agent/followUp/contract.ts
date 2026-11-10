import { z } from "zod";
import { instant, reference } from "../actions/contract.ts";
import { workflowDeliverableSchema } from "../collaborationWorkflowSchema.ts";

/** IANA zone names only. An unknown zone is never replaced by a default. */
export function isTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}
const day = z.string().date();
const timezone = z.string().min(1).max(100).refine(isTimezone, "Unknown timezone.");

export const FOLLOW_UP_POLICY_VERSION = "creator-follow-up.v1";

export const followUpConfigSchema = z.object({
  /** The operating timezone that posting days are counted in. */
  timezone,
  /** Days ahead of a rights end date that an expiry warning is raised. */
  rightsWarningDays: z.number().int().min(1).max(90),
}).strict();
export type FollowUpConfig = z.infer<typeof followUpConfigSchema>;
export const defaultFollowUpConfig = (zone: string): FollowUpConfig =>
  followUpConfigSchema.parse({ timezone: zone, rightsWarningDays: 14 });
/** The first reminder opens on the local day two days before the due day. */
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
  /** The timezone the source states for the deadline, when it states one. */
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

export const CLOSURE_REASONS = ["posted-verified", "declined", "expired", "terms-mismatch", "rights-unavailable", "cancelled"] as const;
export const closureReasonSchema = z.enum(CLOSURE_REASONS);
export type ClosureReason = z.infer<typeof closureReasonSchema>;

export const FOLLOW_UP_STEPS = ["due-minus-2", "within-grace", "past-grace", "rights-expiry-warning"] as const;
export type FollowUpStep = typeof FOLLOW_UP_STEPS[number];
/** A creator message needs J04 exact-action approval. A human review item never messages the creator. */
export type FollowUpChannel = "creator-message" | "human-review";

export const INTENT_STATES = ["proposed", "awaitingApproval", "dispatched", "uncertain", "sent", "notSent", "superseded"] as const;
export type IntentState = typeof INTENT_STATES[number];

export type FollowUpIntent = {
  intentRef: string;
  /** Opaque version bound to the exact intent body; the J04 preview binds to it. */
  intentVersion: string;
  collaborationId: string;
  step: FollowUpStep;
  /** Due-date version for reminders; the rights binding for an expiry warning. */
  dueVersion: string;
  channel: FollowUpChannel;
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
  approvalRef: string | null;
  manifestRef: string | null;
  runRef: string | null;
  runVersion: string | null;
  receiptRefs: string[];
  updatedAt: string;
};

/** Outcomes reported back from the existing actions service. Approved is not sent. */
const refs = { approvalRef: reference.nullable(), manifestRef: reference.nullable(), runRef: reference.nullable(), runVersion: reference.nullable() };
export const sendOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approvalRecorded"), intentRef: reference, approvalRef: reference, manifestRef: reference }).strict(),
  z.object({ kind: z.literal("dispatchPending"), intentRef: reference, approvalRef: reference, manifestRef: reference, runRef: reference, runVersion: reference }).strict(),
  z.object({ kind: z.literal("sent"), intentRef: reference, approvalRef: reference, manifestRef: reference, runRef: reference, runVersion: reference,
    receiptRefs: z.array(reference).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("notSent"), intentRef: reference, ...refs, receiptRefs: z.array(reference).max(100) }).strict(),
  z.object({ kind: z.literal("uncertain"), intentRef: reference, ...refs }).strict(),
]);
export type SendOutcome = z.infer<typeof sendOutcomeSchema>;
