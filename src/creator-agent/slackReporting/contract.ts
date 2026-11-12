import { z } from "zod";
import { expectedBindingSchema, type ExpectedBinding } from "../connections/schema.ts";
import type { JobClaim, JobRepository } from "../jobs/repository.ts";
import type { JobRunView } from "../jobs/schema.ts";
import { mirrorIncidentPayloadSchema } from "../mirrorFreshness.ts";
import { dailyDigestContextSchema, digestAllClear } from "../dailyDigest/contract.ts";
import { weeklyReportContextSchema } from "../weeklySnapshots/comparison.ts";

export const reportReference = z.string().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(value => !/^https?:/i.test(value));
export const reportInstant = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nativeId = z.string().regex(/^[A-Z][A-Z0-9]{2,40}$/);
const timestamp = z.string().regex(/^[1-9]\d{9,14}\.\d{6}$/);
export const reportScopeSchema = z.object({ workspaceId: reportReference, accountId: reportReference, environment: z.literal("sandbox") }).strict();
export type ReportScope = z.infer<typeof reportScopeSchema>;
export const reportLocatorSchema = z.object({ eventRef: reportReference, eventVersion: reportReference }).strict();
export type ReportLocator = z.infer<typeof reportLocatorSchema>;

const numericFact = z.object({ label: z.enum(["orders", "shipments", "records", "resolvedFindings", "failedRuns", "pendingItems", "oldestAge", "elapsed", "amount"]), value: z.number().int().nonnegative().safe().nullable(), unit: z.enum(["count", "minutes", "USD-minor"]), missingReason: z.enum(["notObserved", "partialSource", "notApplicable"]).nullable() }).strict().superRefine((value, ctx) => {
  if ((value.value === null) !== (value.missingReason !== null)) ctx.addIssue({ code: "custom", message: "Unknown values require an explicit reason." });
  const expected = value.label === "amount" ? "USD-minor" : ["oldestAge", "elapsed"].includes(value.label) ? "minutes" : "count";
  if (value.unit !== expected) ctx.addIssue({ code: "custom", message: "Metric units must match the finite label." });
});
const statusFact = z.object({ label: z.enum(["sourceStatus", "coverage", "incidentStatus"]), value: z.enum(["unavailable", "permissionDenied", "rateLimited", "partial", "complete", "breached", "cleared", "unknown"]) }).strict();
export const reportFactSchema = z.union([numericFact, statusFact]);
export type ReportFact = z.infer<typeof reportFactSchema>;
export const reportSourceLinkSchema = z.object({ kind: z.literal("linear"), workspaceSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/), issueIdentifier: z.string().regex(/^[A-Z]{2,8}-[1-9]\d{0,8}$/), authorizationRef: reportReference }).strict();
const subject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("order"), orderRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,39}$/) }).strict(),
  z.object({ kind: z.literal("creator"), handle: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.]{0,39}$/) }).strict(),
  z.object({ kind: z.literal("aggregate"), category: z.enum(["fulfillment", "automation", "creators", "content", "finance", "support", "launch"]) }).strict(),
]);
const incident = z.object({ kind: z.literal("incident"), conditionRef: reportReference, generation: z.number().int().positive().safe(), transition: z.enum(["breach", "clear"]), sequence: z.number().int().positive().safe(), previousClearEventRef: reportReference.nullable() }).strict();
const window = z.object({ kind: z.literal("window"), windowRef: reportReference, start: reportInstant, end: reportInstant, cadence: z.enum(["orangeDigest", "weekdayDaily", "mondayWeekly", "launchHourly", "dailyExceptions", "reconciliationRecovery"]), timezone: z.literal("America/Los_Angeles"), launchWindowRef: reportReference.nullable() }).strict().superRefine((value, ctx) => {
  if (Date.parse(value.start) >= Date.parse(value.end)) ctx.addIssue({ code: "custom", message: "A source window must have positive duration." });
  if ((value.cadence === "launchHourly") !== (value.launchWindowRef !== null)) ctx.addIssue({ code: "custom", message: "Hourly reporting requires a source-confirmed launch window." });
});
/** Source-authorized evidence URL, never a browser-supplied redirect or free-form Slack markup. */
export const mirrorReportContextSchema = z.object({ incident: mirrorIncidentPayloadSchema,
  runEvidenceUrl: z.string().url().max(700).refine(value=>{try{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&!/[<>|\s]/.test(value);}catch{return false;}}).nullable(),
}).strict().superRefine((v,c)=>{
  if(v.incident.event==="suppressed" || (v.incident.latestRunId!==null && v.runEvidenceUrl===null) || (v.incident.latestRunId===null && v.runEvidenceUrl!==null))
    c.addIssue({code:"custom",message:"Only original incident transitions with their exact source evidence link may report."});
});
const automationAlias = z.string().regex(/^[a-f0-9]{20}$/);
export const automationErrorClass = z.enum(["executionFailure", "permissionLost", "tasksExhausted", "rateLimited", "invalidConfiguration", "duplicateTrigger", "unknownOutcome"]);
export const automationFailureContextSchema = z.object({
  zap: automationAlias, job: automationAlias, run: automationAlias, item: automationAlias, checkpoint: automationAlias.nullable(),
  errorClass: automationErrorClass,
  recovery: z.enum(["reviewRun", "restoreAccess", "waitForTasks", "waitForRateLimit", "fixConfiguration", "reviewDuplicateTrigger",
    "retryVerifiedCheckpoint", "reconcileOriginal", "continueMonitoring"]),
}).strict();
export const reportEventSchema = reportLocatorSchema.extend({ producerRef: reportReference, occurredAt: reportInstant, severity: z.enum(["red", "orange", "info"]), identity: z.union([incident, window]), subject, facts: z.array(reportFactSchema).min(1).max(3), nextAction: z.enum(["inspectShipment", "reviewAutomation", "reviewSource", "reviewCreator", "reviewContent", "reviewFinance", "reviewSupport", "reviewLaunch", "continueMonitoring"]), link: reportSourceLinkSchema, mirror: mirrorReportContextSchema.optional(), dailyDigest: dailyDigestContextSchema.optional(), automationFailure: automationFailureContextSchema.optional(), weeklySnapshot: weeklyReportContextSchema.optional() }).strict().superRefine((value, ctx) => {
  if (value.identity.kind === "incident" && ((value.identity.transition === "breach" && value.severity !== "red") || (value.identity.transition === "clear" && value.severity !== "info"))) ctx.addIssue({ code: "custom", message: "Only red breaches dispatch immediately; clear is an original-thread recovery." });
  if(value.mirror && (value.identity.kind!=="incident" || value.subject.kind!=="aggregate" || value.subject.category!=="automation" ||
    value.identity.conditionRef!==value.mirror.incident.incidentId || value.identity.generation!==1 || value.identity.sequence!==(value.mirror.incident.event==="cleared"?2:1) ||
    value.identity.transition!==(value.mirror.incident.event==="cleared"?"clear":"breach"))) ctx.addIssue({code:"custom",message:"Mirror identity must match its immutable incident transition."});
  if (value.automationFailure && (value.identity.kind !== "incident" || value.subject.kind !== "aggregate" ||
      value.subject.category !== "automation" || value.mirror || value.dailyDigest ||
      (value.automationFailure.recovery === "continueMonitoring") !== (value.identity.transition === "clear") ||
      (value.automationFailure.recovery === "retryVerifiedCheckpoint" && value.automationFailure.checkpoint === null))) {
    ctx.addIssue({ code: "custom", message: "Automation diagnostics require an exact incident transition and a recorded retry checkpoint." });
  }
  const daily = value.identity.kind === "window" && value.identity.cadence === "dailyExceptions";
  if (daily !== Boolean(value.dailyDigest)) ctx.addIssue({ code: "custom", message: "Daily digest cadence requires the complete typed digest context." });
  if (value.dailyDigest && value.identity.kind === "window") {
    const { window: period } = value.dailyDigest;
    if (value.identity.start !== period.start || value.identity.end !== period.end ||
        value.eventRef !== "daily-exceptions:" + period.reportDate || value.mirror ||
        value.subject.kind !== "aggregate" || value.subject.category !== "launch" ||
        value.severity !== (digestAllClear(value.dailyDigest) ? "info" : "orange")) {
      ctx.addIssue({ code: "custom", message: "Daily digest identity and severity must match its source evidence." });
    }
  }
  if (value.identity.kind === "window" && !daily && ((value.severity === "orange") !== (value.identity.cadence === "orangeDigest") || value.severity === "red")) ctx.addIssue({ code: "custom", message: "Digest severity and source cadence must match." });
  if (value.eventRef.startsWith("weekly-kpi:") !== Boolean(value.weeklySnapshot)) {
    ctx.addIssue({ code: "custom", message: "A weekly KPI report requires its frozen snapshot." });
  }
  const weekly = value.weeklySnapshot?.snapshot;
  if (weekly && (value.identity.kind !== "window" || value.identity.cadence !== "mondayWeekly" ||
      value.identity.start !== weekly.window.start || value.identity.end !== weekly.window.end ||
      value.identity.windowRef !== value.eventRef || value.eventRef !== "weekly-kpi:" + weekly.window.reportDate ||
      value.subject.kind !== "aggregate" || value.subject.category !== "finance" || weekly.version !== "v1" ||
      weekly.correction !== null || value.mirror || value.dailyDigest || value.automationFailure)) {
    ctx.addIssue({ code: "custom", message: "The weekly pre-read must identify the original completed snapshot." });
  }
  if (value.identity.kind === "window" && value.identity.cadence === "reconciliationRecovery" &&
      (value.subject.kind !== "aggregate" || value.subject.category !== "automation" || value.nextAction !== "continueMonitoring" ||
        value.eventRef !== "mirror-" + value.identity.windowRef || !value.identity.windowRef.startsWith("reconciliation:") ||
        !value.facts.some(fact => fact.label === "coverage" && fact.value === "complete") ||
        !value.facts.some(fact => fact.label === "resolvedFindings" && fact.value !== null && fact.value > 0))) {
    ctx.addIssue({ code: "custom", message: "Reconciliation recovery requires complete coverage and a confirmed cleared finding." });
  }
});
export type ReportEvent = z.infer<typeof reportEventSchema>;

export const reportSnapshotSchema = z.object({ scope: reportScopeSchema, event: reportEventSchema,
  testProvenance: z.object({ kind: z.literal("controlledSandbox"), evidenceRef: reportReference }).strict().optional(),
  programme: z.object({ programmeRef: reportReference, version: reportReference, adoptionRef: reportReference, authority: z.literal("report-policy"), state: z.enum(["adopted", "unverified", "revoked"]), permittedProducers: z.array(reportReference).min(1).max(30), policy: z.literal("immediate-red-digest-orange-source-scheduled-info"), grantsBusinessAuthority: z.literal(false) }).strict(),
  destination: z.object({ targetRef: reportReference, version: reportReference, workspaceId: nativeId, channelId: nativeId, botId: nativeId, member: z.enum(["verified", "unknown", "denied"]), owner: z.discriminatedUnion("state", [z.object({ state: z.literal("active"), memberId: nativeId, mappingVersion: reportReference }).strict(), z.object({ state: z.enum(["missing", "deactivated"]), memberId: z.null(), mappingVersion: reportReference }).strict()]), backup: z.literal("none-approved") }).strict(),
  authority: z.object({ read: z.enum(["allowed", "unknown", "denied"]), send: z.enum(["allowed", "unknown", "denied"]), sourceRef: reportReference, sourceVersion: reportReference, permissionRef: reportReference.nullable(), observedAt: reportInstant, validUntil: reportInstant }).strict(),
  evidence: z.object({ asOf: reportInstant, freshness: z.enum(["current", "stale", "unknown"]), coverage: z.enum(["complete", "partial", "unknown"]), currentTransition: z.boolean(), linkAuthorized: z.boolean() }).strict(),
  delivery: z.object({ notBefore: reportInstant, binding: expectedBindingSchema }).strict(),
}).strict();
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;

export const reportCommandSchema = z.object({ scope: reportScopeSchema, reportRef: reportReference, eventRef: reportReference, eventVersion: reportReference, programmeRef: reportReference, programmeVersion: reportReference, targetRef: reportReference, targetVersion: reportReference, workspaceId: nativeId, channelId: nativeId, botId: nativeId, threadTs: timestamp.nullable(), body: z.string().min(1).max(3000), bodyHash: hash, attemptRef: reportReference, attemptNumber: z.number().int().positive().safe(), requestKey: reportReference }).strict();
export type ReportCommand = z.infer<typeof reportCommandSchema>;
export const reportGrantSchema = z.object({ scope: reportScopeSchema, authority: z.literal("report-policy"), commandHash: hash, grantRef: reportReference, quotaAllocationRef: reportReference, exclusive: z.literal(true), maxMessages: z.literal(1), binding: expectedBindingSchema, observedAt: reportInstant, validUntil: reportInstant }).strict();
export type ReportGrant = z.infer<typeof reportGrantSchema>;
export const reportReceiptSchema = z.object({ receiptRef: reportReference, scope: reportScopeSchema, requestKey: reportReference, attemptRef: reportReference, attemptNumber: z.number().int().positive().safe(), reportRef: reportReference, eventRef: reportReference, eventVersion: reportReference, targetRef: reportReference, targetVersion: reportReference, workspaceId: nativeId, channelId: nativeId, botId: nativeId, threadTs: timestamp.nullable(), messageTs: timestamp, bodyHash: hash, observedAt: reportInstant }).strict();
export type ReportReceipt = z.infer<typeof reportReceiptSchema>;
export const reportClosureSchema = z.object({ scope: reportScopeSchema, requestKey: reportReference, attemptRef: reportReference, attemptNumber: z.number().int().positive().safe(), commandHash: hash, targetVersion: reportReference, proofRef: reportReference, observedAt: reportInstant, complete: z.literal(true), originalAttemptClosed: z.literal(true), reasonCode: z.enum(["RATE_LIMITED", "NOT_APPLIED_CLOSED"]), retryAfterMs: z.number().int().min(0).max(3_600_000) }).strict();
export type ReportClosure = z.infer<typeof reportClosureSchema>;
export const reportOutcomeSchema = z.discriminatedUnion("state", [z.object({ state: z.literal("applied"), receipt: reportReceiptSchema }).strict(), z.object({ state: z.literal("notApplied"), proof: reportClosureSchema }).strict(), z.object({ state: z.literal("uncertain"), reasonCode: z.enum(["OUTCOME_UNKNOWN", "ABSENCE_NOT_TERMINAL", "PERMISSION_UNKNOWN", "MALFORMED_READBACK"]) }).strict()]);
export type ReportOutcome = z.infer<typeof reportOutcomeSchema>;
export const reportReadSchema = z.object({ schemaVersion: z.literal("farda.report.v1"), reportRef: reportReference, runRef: reportReference, state: z.enum(["empty", "queued", "running", "deferred", "held", "paused", "cancelling", "cancelled", "completed", "partial", "failed", "reconcile"]), executionCertainty: z.enum(["notApplied", "uncertain", "applied"]), sourceEffect: z.enum(["internalReport", "none", "unknown"]), observedAt: reportInstant,
  current: z.object({ sendEligible: z.literal(false).nullable(), reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]+$/)).min(1).max(20) }).strict(),
  receipt: z.object({ receiptRef: reportReference, threadRef: reportReference, bodyHash: hash, observedAt: reportInstant }).strict().nullable(),
  usage: z.object({ zapierTasks: z.literal("unknown"), cost: z.literal("unknown") }).strict(), grantsBusinessAuthority: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if ((value.executionCertainty === "applied") !== (value.receipt !== null) || value.sourceEffect !== (value.executionCertainty === "applied" ? "internalReport" : value.executionCertainty === "uncertain" ? "unknown" : "none")) ctx.addIssue({ code: "custom", message: "Receipt and effect certainty must agree." });
});
export type ReportRead = z.infer<typeof reportReadSchema>;

export type ReportSourceRead = { purpose: "admit" | "send" | "read"; assertCurrent(): void };
/** All callbacks are trusted, server-only source adapters. Nothing supplies a default sender. */
export interface ReportingSource {
  readEvent(locator: ReportLocator, context?: ReportSourceRead): Promise<unknown>;
  assertCurrent(snapshot: ReportSnapshot, purpose: "admit" | "send" | "read", now: number): void;
  authorizeAttempt(snapshot: ReportSnapshot, command: ReportCommand): Promise<unknown>;
  assertGrant(grant: ReportGrant, command: ReportCommand, now: number): void;
  deliver(command: ReportCommand, context: { assertCurrent(): void }): Promise<unknown>;
  lookup(command: ReportCommand, context: { assertCurrent(): void }): Promise<unknown>;
}
export type ReportMachine = { workerRef: string; assertCurrent(): void };
export type ReportReadAuthority = { readerRef: string; assertCurrent(): void };
export type ReportJobResult = { schemaVersion: "job-report-result.v1"; kind: "report-receipt"; receiptRef: string; requestKey: string; payloadHash: string; sourceEffect: "internalReport"; observedAt: string };
/** Structural port of the existing JobRepository, never a second queue. Callbacks run in its SQLite transaction. */
export interface ReportJobPort extends Pick<JobRepository, "register" | "ingest" | "getRun" | "fail" | "recoverExpired"> {
  activateReport(jobId: string, version: number, grantRef: string, assertCurrent: () => void): unknown;
  claimReport(runRef: string, workerRef: string, itemKey: string, binding: ExpectedBinding, assertCurrent: () => void): JobClaim | null;
  startReport(itemId: string, token: string, assertAndRecord: () => void): void;
  assertReportLease(itemId: string, token: string, binding: ExpectedBinding): void;
  finishReport(runRef: string, itemKey: string, result: ReportJobResult | null, assertAndPersist: (currentAttemptNumber: number) => void, reasonCode?: string): JobRunView;
  closeReportAttempt(runRef: string, itemKey: string, attemptNumber: number, assertAndPersist: () => void, retryAfterMs?: number): JobRunView;
}
export class ReportError extends Error {
  readonly code: string; readonly status: number; readonly executionCertainty: "notApplied" | "uncertain" | "applied";
  readonly retryAfterMs: number | null;
  constructor(code: string, status = 409, executionCertainty: "notApplied" | "uncertain" | "applied" = "notApplied", retryAfterMs: number | null = null) { super(code); this.name = "ReportError"; this.code = code; this.status = status; this.executionCertainty = executionCertainty; this.retryAfterMs = retryAfterMs !== null && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null; }
}
