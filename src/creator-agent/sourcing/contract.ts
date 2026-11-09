import { z } from "zod";

/**
 * Browser-safe daily sourcing plan contract (THO-287, served under THO-367).
 *
 * `sourcingPlan` is a read-only projection of the J19 daily sourcing service: schedule and access, the five plan steps,
 * capacity in each source's own units, identity and suppression counts, and the latest run's states. It holds no creator
 * record, recipient list, provider credential or send command. Unknown counts stay `null` with a reason, never zero.
 */
export const SOURCING_PLAN_VIEW = "sourcingPlan" as const;
export const sourcingPlanFilters = z.object({}).strict();

export const refSchema = z.string().trim().min(1).max(240);
const text = z.string().trim().min(1).max(500);
const count = z.number().int().nonnegative().safe();
/** `Date.parse` must give a finite time; an ISO-shaped string such as 2026-02-30 fails closed. */
export const instantSchema = z.string().datetime({ offset: true }).refine((v) => Number.isFinite(Date.parse(v)), "A finite timestamp is required.");
export const timezoneSchema = z.string().min(1).max(100).refine((v) => {
  try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; }
}, "Unknown timezone.");

/**
 * D-13 has no row for a once-a-day plan. J19 runs daily (THO-287 is the daily plan; the hourly monitor is a separate job),
 * so a plan observation is stale after one cadence plus a two-hour grace, whatever lease the source claims.
 */
export const SOURCING_PLAN_MAX_AGE_MS = 26 * 3600_000;
/** A source clock may run slightly ahead of the server's. Beyond this the observation is refused. */
export const SOURCING_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Why a count is not known. Enumerated so no source prose (a handle, an address, a link) can reach the browser.
 * `NOT_APPLICABLE` is a definite answer, distinct from both zero and unknown.
 */
export const missingReasonCodes = [
  "NOT_APPLICABLE", "NOT_READ", "SOURCE_DID_NOT_REPORT", "SOURCE_LIMIT_NOT_PUBLISHED", "SOURCE_PERMISSION_DENIED", "SOURCE_LOGIN_REQUIRED",
  "J20_REVIEW_INCOMPLETE", "IDENTITY_RESOLUTION_INCOMPLETE", "RELATIONSHIP_LEDGER_NOT_READ", "SUPPRESSION_LIST_NOT_READ",
  "RECEIPT_NOT_RECONCILED", "RUN_IN_PROGRESS", "CAPACITY_NOT_REPORTED",
] as const;
export const missingReasonSchema = z.enum(missingReasonCodes);
export type MissingReason = typeof missingReasonCodes[number];
/** The next action for a plan step, as a code. The browser holds the copy. */
export const nextActionCodes = [
  "RESOLVE_IDENTITIES", "QUEUE_VIDEO_REVIEW", "REVIEW_REMAINING_CLIPS", "FINISH_VIDEO_REVIEW", "QUALIFY_REVIEWED_CREATORS",
  "WAIT_FOR_QUALIFIED_CREATORS", "PREPARE_FINITE_PREVIEW", "RESTORE_SOURCE_ACCESS", "NONE",
] as const;
export const nextActionSchema = z.enum(nextActionCodes);
/** A configuration version label the browser shows as is: short, no spaces, no `@`, no slash, so no address or URL. */
export const versionLabelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, "A version label is a short code.");

/** A count the source observed, or unknown with an enumerated reason. Never both, never neither. */
export const observedCountSchema = z.object({ value: count.nullable(), missingReason: missingReasonSchema.nullable() }).strict()
  .refine((v) => (v.value === null) === (v.missingReason !== null), "Unknown counts need a reason; observed counts do not.");
export type ObservedCount = z.infer<typeof observedCountSchema>;

export const recruitmentSources = ["social-cat", "tiktok-shop"] as const;
export const recruitmentSourceSchema = z.enum(recruitmentSources);
export const accessStates = ["verified", "unverified", "loginRequired", "denied", "unknown"] as const;
export const sessionStates = ["open", "closed", "unknown"] as const;
export const scheduleStates = ["unconfigured", "draft", "active", "paused"] as const;
export const ownerRoles = ["creator-agent", "operator", "reviewer", "founder", "operations"] as const;
/** DS-02: five distinct steps. Discovery or captions alone never count as video review or qualification. */
export const stepKeys = ["discovery", "identityResolution", "videoReview", "qualification", "invitationPlanning"] as const;
/** DS-03: each capacity kind has exactly one native unit. Unlike units are never combined into one cap. */
export const capacityUnits = {
  invitations: "invitations", collaborationSlots: "slots", apiRequests: "requests", browserActions: "actions", sampleUnits: "units", authorizedCost: "minorUnits",
} as const;
export type CapacityKind = keyof typeof capacityUnits;
export const capacityKinds = Object.keys(capacityUnits) as CapacityKind[];
/** DS-07 run states, in display order. */
export const runStateKeys = ["queued", "running", "quotaDeferred", "loginRequired", "permissionDenied", "paused", "confirmed", "failed", "uncertain"] as const;

export const sourceStates = ["current", "partial", "expired", "unavailable", "unconfigured"] as const;

const sourceAccountView = z.object({
  source: recruitmentSourceSchema, accountRef: refSchema.nullable(), access: z.enum(accessStates), session: z.enum(sessionStates), accessObservedAt: instantSchema.nullable(),
}).strict();

const scheduleView = z.object({
  declaredState: z.enum(scheduleStates),
  /** Active only when the source says so and every account is verified with an open session, a timezone and a next run exist, and the read is current. */
  effectiveState: z.enum(scheduleStates),
  holdReasons: z.array(text).max(20),
  cadence: z.literal("daily").nullable(), timezone: timezoneSchema.nullable(), lastRunAt: instantSchema.nullable(), nextRunAt: instantSchema.nullable(), scheduleRef: refSchema.nullable(),
}).strict().superRefine((v, c) => {
  if (v.effectiveState === "active" && (v.declaredState !== "active" || v.holdReasons.length > 0)) c.addIssue({ code: "custom", message: "An active schedule needs a source claim and no hold." });
});

const stepView = z.object({
  step: z.enum(stepKeys), count: observedCountSchema, owner: z.enum(ownerRoles).nullable(), evidenceRefs: z.array(refSchema).max(20), nextAction: nextActionSchema,
}).strict();

const capacityView = z.object({
  source: z.enum([...recruitmentSources, "shared"]), kind: z.enum(capacityKinds as [CapacityKind, ...CapacityKind[]]),
  unit: z.enum(["invitations", "slots", "requests", "actions", "units", "minorUnits"]), currency: z.literal("USD").nullable(),
  limit: observedCountSchema, used: observedCountSchema, remaining: observedCountSchema,
  resetAt: instantSchema.nullable(), observedAt: instantSchema.nullable(), validUntil: instantSchema.nullable(), receipt: refSchema.nullable(),
  /** `current` only with a receipt inside its lease, the server's maximum age and before any reset. Unknown and stale rows block dependent dispatch; `notApplicable` rows are not a constraint for this source. */
  state: z.enum(["current", "stale", "unknown", "notApplicable"]), dispatchBlocked: z.boolean(), blockReason: text.nullable(),
}).strict().superRefine((v, c) => {
  if (v.unit !== capacityUnits[v.kind]) c.addIssue({ code: "custom", message: "Capacity unit does not match its kind." });
  if ((v.currency !== null) !== (v.kind === "authorizedCost")) c.addIssue({ code: "custom", message: "Only authorized cost carries a currency." });
  if ((v.state === "unknown" || v.state === "stale") && !v.dispatchBlocked) c.addIssue({ code: "custom", message: "Unknown or stale capacity must block dispatch." });
  if (v.state === "notApplicable" && [v.limit, v.used, v.remaining].some((n) => n.missingReason !== "NOT_APPLICABLE")) c.addIssue({ code: "custom", message: "Only an all-N/A row is not applicable." });
  if (v.dispatchBlocked !== (v.blockReason !== null)) c.addIssue({ code: "custom", message: "A blocked row needs its reason." });
});

const identityView = z.object({
  surfaced: observedCountSchema, mergedDuplicates: observedCountSchema, suppressedOptedOut: observedCountSchema, suppressedDeclinedRecently: observedCountSchema,
  suppressedExistingRelationship: observedCountSchema, alreadyInvited: observedCountSchema, selected: observedCountSchema, evidenceRefs: z.array(refSchema).max(20),
}).strict();

const runStatesShape = Object.fromEntries(runStateKeys.map((k) => [k, observedCountSchema])) as Record<typeof runStateKeys[number], typeof observedCountSchema>;
const latestRunView = z.object({
  runRef: refSchema, startedAt: instantSchema, states: z.object(runStatesShape).strict(),
  attempts: observedCountSchema, distinctOpportunities: observedCountSchema, confirmedInvitations: observedCountSchema, receiptRefs: z.array(refSchema).max(500),
}).strict();

export const sourcingPlanShape = {
  kind: z.literal("agent-sourcing-plan"),
  observedAt: instantSchema, sourceAsOf: instantSchema.nullable(), sourceVersion: refSchema.nullable(), validUntil: instantSchema.nullable(),
  freshness: z.enum(["current", "stale", "unknown"]), coverage: z.enum(["complete", "partial", "unknown"]), sourceState: z.enum(sourceStates), missingReason: text.nullable(),
  plan: z.object({
    planRef: refSchema, icpVersion: versionLabelSchema.nullable(), policyVersion: versionLabelSchema.nullable(),
    schedule: scheduleView, sources: z.array(sourceAccountView).min(1).max(2), steps: z.array(stepView).length(stepKeys.length),
    capacity: z.array(capacityView).max(24), identity: identityView, latestRun: latestRunView.nullable(),
    /** Every reason nothing may dispatch from this plan. Reading the plan never dispatches. */
    dispatchHoldReasons: z.array(text).min(1).max(30),
  }).strict().nullable(),
};
export const sourcingPlanSchema = z.object(sourcingPlanShape).strict().superRefine((v, c) => {
  if ((v.plan === null) !== (v.sourceState === "unconfigured" || v.sourceState === "unavailable")) c.addIssue({ code: "custom", message: "Only a read source has a plan." });
  if (v.plan === null && v.missingReason === null) c.addIssue({ code: "custom", message: "A missing plan needs its reason." });
  if (v.plan && v.plan.steps.some((s, i) => s.step !== stepKeys[i])) c.addIssue({ code: "custom", message: "Plan steps are fixed and ordered." });
});
export type SourcingPlan = z.infer<typeof sourcingPlanSchema>;
export type SourcingPlanBody = NonNullable<SourcingPlan["plan"]>;
