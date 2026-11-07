import { z } from "zod";
import type { OperationsScope } from "../operations.ts";
import {
  accessStates, capacityKinds, capacityUnits, instantSchema, observedCountSchema, ownerRoles, recruitmentSourceSchema, recruitmentSources, refSchema,
  runStateKeys, scheduleStates, sessionStates, stepKeys, timezoneSchema, type CapacityKind, type ObservedCount,
} from "./contract.ts";

/**
 * Server-only boundary to the J19 daily sourcing service (THO-325). It is read-only: no discovery start, invitation,
 * approval, lease or dispatch is reachable through it. The reader is injected by the trusted server, never by a request.
 */
const text = z.string().trim().min(1).max(500);
const known = (c: ObservedCount) => c.value;
const after = (a: string | null, b: string) => a !== null && Date.parse(a) > Date.parse(b);

const sourceAccount = z.object({
  source: recruitmentSourceSchema, accountRef: refSchema.nullable(), access: z.enum(accessStates), session: z.enum(sessionStates), accessObservedAt: instantSchema.nullable(),
}).strict().superRefine((v, c) => {
  if (v.access === "verified" && (v.accountRef === null || v.accessObservedAt === null)) c.addIssue({ code: "custom", message: "Verified access needs an account and an observation time." });
});

const schedule = z.object({
  state: z.enum(scheduleStates), cadence: z.literal("daily").nullable(), timezone: timezoneSchema.nullable(),
  lastRunAt: instantSchema.nullable(), nextRunAt: instantSchema.nullable(), scheduleRef: refSchema.nullable(),
}).strict().superRefine((v, c) => {
  if (v.state === "unconfigured" && (v.cadence !== null || v.timezone !== null || v.nextRunAt !== null || v.scheduleRef !== null))
    c.addIssue({ code: "custom", message: "An unconfigured schedule has no cadence, timezone, next run or reference." });
  if (v.lastRunAt !== null && v.nextRunAt !== null && Date.parse(v.nextRunAt) <= Date.parse(v.lastRunAt)) c.addIssue({ code: "custom", message: "The next run must follow the last run." });
});

const step = z.object({
  step: z.enum(stepKeys), count: observedCountSchema, owner: z.enum(ownerRoles).nullable(), evidenceRefs: z.array(refSchema).max(20), nextAction: text.nullable(),
}).strict().refine((v) => v.count.value === null || v.evidenceRefs.length > 0, "An observed step count needs evidence.");

const capacity = z.object({
  source: z.enum([...recruitmentSources, "shared"]), kind: z.enum(capacityKinds as [CapacityKind, ...CapacityKind[]]),
  unit: z.enum(["invitations", "slots", "requests", "actions", "units", "minorUnits"]), currency: z.literal("USD").nullable(),
  limit: observedCountSchema, used: observedCountSchema, remaining: observedCountSchema,
  resetAt: instantSchema.nullable(), observedAt: instantSchema.nullable(), validUntil: instantSchema.nullable(), receipt: refSchema.nullable(),
}).strict().superRefine((v, c) => {
  if (v.unit !== capacityUnits[v.kind]) c.addIssue({ code: "custom", message: "A capacity unit must be the native unit of its kind." });
  if ((v.currency !== null) !== (v.kind === "authorizedCost")) c.addIssue({ code: "custom", message: "Only authorized cost carries a currency." });
  const limit = known(v.limit), used = known(v.used), remaining = known(v.remaining);
  if ((limit !== null || used !== null || remaining !== null) && (v.receipt === null || v.observedAt === null || v.validUntil === null))
    c.addIssue({ code: "custom", message: "An observed capacity needs a receipt and a lease." });
  if (v.observedAt !== null && v.validUntil !== null && Date.parse(v.validUntil) <= Date.parse(v.observedAt)) c.addIssue({ code: "custom", message: "Invalid capacity lease." });
  if (limit !== null && (used !== null && used > limit || remaining !== null && remaining > limit || used !== null && remaining !== null && used + remaining > limit))
    c.addIssue({ code: "custom", message: "Used and remaining capacity cannot exceed the limit." });
});

const identity = z.object({
  surfaced: observedCountSchema, mergedDuplicates: observedCountSchema, suppressedOptedOut: observedCountSchema, suppressedDeclinedRecently: observedCountSchema,
  suppressedExistingRelationship: observedCountSchema, alreadyInvited: observedCountSchema, selected: observedCountSchema, evidenceRefs: z.array(refSchema).max(20),
}).strict().superRefine((v, c) => {
  const parts = [v.mergedDuplicates, v.suppressedOptedOut, v.suppressedDeclinedRecently, v.suppressedExistingRelationship, v.alreadyInvited, v.selected].map(known);
  const surfaced = known(v.surfaced);
  if (surfaced !== null && parts.some((n) => n !== null && n > surfaced)) c.addIssue({ code: "custom", message: "No identity stage can exceed the surfaced profiles." });
  // Suppressed or already-invited opportunities cannot enter the selection, so a fully known funnel must reconcile.
  if (surfaced !== null && parts.every((n) => n !== null) && parts.slice(0, 5).reduce<number>((s, n) => s + n!, 0) + parts[5]! > surfaced)
    c.addIssue({ code: "custom", message: "Selected profiles exceed what remains after duplicates and suppression." });
  if (parts.some((n) => n !== null && n > 0) && v.evidenceRefs.length === 0) c.addIssue({ code: "custom", message: "Identity counts need evidence." });
});

const runStatesShape = Object.fromEntries(runStateKeys.map((k) => [k, observedCountSchema])) as Record<typeof runStateKeys[number], typeof observedCountSchema>;
const latestRun = z.object({
  runRef: refSchema, startedAt: instantSchema, states: z.object(runStatesShape).strict(),
  attempts: observedCountSchema, distinctOpportunities: observedCountSchema, confirmedInvitations: observedCountSchema, receiptRefs: z.array(refSchema).max(500),
}).strict().superRefine((v, c) => {
  const attempts = known(v.attempts), distinct = known(v.distinctOpportunities), confirmed = known(v.confirmedInvitations);
  if (distinct !== null && attempts !== null && distinct > attempts || confirmed !== null && distinct !== null && confirmed > distinct)
    c.addIssue({ code: "custom", message: "Attempts, distinct opportunities and confirmed invitations must nest." });
  // DS-08: every confirmed invitation links to its own source receipt.
  if (confirmed !== null && v.receiptRefs.length !== confirmed || confirmed === null && v.receiptRefs.length > 0) c.addIssue({ code: "custom", message: "Confirmed invitations need exactly one receipt each." });
  if (new Set(v.receiptRefs).size !== v.receiptRefs.length) c.addIssue({ code: "custom", message: "A receipt cannot confirm two invitations." });
  const confirmedState = known(v.states.confirmed);
  if (confirmedState !== null && confirmed !== null && confirmedState !== confirmed) c.addIssue({ code: "custom", message: "Confirmed state and confirmed invitations disagree." });
});

export const sourcingSnapshotSchema = z.object({
  scope: z.object({ workspaceId: refSchema, accountId: refSchema, environment: z.literal("sandbox") }).strict(),
  version: refSchema, observedAt: instantSchema, validUntil: instantSchema, coverage: z.enum(["complete", "partial"]),
  planRef: refSchema, icpVersion: refSchema.nullable(), policyVersion: refSchema.nullable(),
  sources: z.array(sourceAccount).min(1).max(2), schedule, steps: z.array(step).length(stepKeys.length),
  capacity: z.array(capacity).max(24), identity, latestRun: latestRun.nullable(),
}).strict().superRefine((s, c) => {
  if (Date.parse(s.validUntil) <= Date.parse(s.observedAt)) c.addIssue({ code: "custom", message: "Invalid source lease." });
  if (new Set(s.sources.map((a) => a.source)).size !== s.sources.length) c.addIssue({ code: "custom", message: "Duplicate source account." });
  if (s.steps.some((x, i) => x.step !== stepKeys[i])) c.addIssue({ code: "custom", message: "Plan steps are fixed and ordered." });
  if (new Set(s.capacity.map((r) => `${r.source}:${r.kind}`)).size !== s.capacity.length) c.addIssue({ code: "custom", message: "Duplicate capacity row." });
  if (s.capacity.some((r) => r.source !== "shared" && !s.sources.some((a) => a.source === r.source))) c.addIssue({ code: "custom", message: "Capacity for an unplanned source." });
  // A later step can never hold more than the step before it: a caption-only candidate is not video-reviewed or qualified.
  const counts = s.steps.map((x) => known(x.count));
  for (let i = 1; i < counts.length; i++) {
    const prior = counts.slice(0, i).reverse().find((n) => n !== null);
    if (counts[i] !== null && prior !== undefined && prior !== null && counts[i]! > prior) c.addIssue({ code: "custom", message: `${stepKeys[i]} cannot exceed an earlier step.` });
  }
  const times = [s.schedule.lastRunAt, s.latestRun?.startedAt ?? null, ...s.sources.map((a) => a.accessObservedAt), ...s.capacity.map((r) => r.observedAt)];
  if (times.some((t) => after(t, s.observedAt))) c.addIssue({ code: "custom", message: "Evidence cannot postdate its source observation." });
});
export type SourcingSnapshot = z.infer<typeof sourcingSnapshotSchema>;
/** Resolve a snapshot, `null` for a temporarily unavailable source, or throw `SourcingError` with 401/403 for a denial. */
export type SourcingPlanSourceReader = (scope: OperationsScope) => Promise<unknown | null>;

export class SourcingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors?: Record<string, string>;
  constructor(code: string, status: number, fieldErrors?: Record<string, string>) {
    super(code); this.code = code; this.status = status; this.fieldErrors = fieldErrors;
  }
}
