import { createHmac } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { ReportError, automationErrorClass, reportEventSchema, reportInstant, reportReference, reportScopeSchema,
  type ReportEvent, type ReportLocator, type ReportScope, type ReportSnapshot, type ReportSourceRead, type ReportingSource } from "./contract.ts";

const triggerVersion = z.object({ ref: reportReference, version: reportReference }).strict();
const triggerRun = z.object({ scope: reportScopeSchema, jobRef: reportReference, windowRef: reportReference,
  trigger: triggerVersion, runRef: reportReference, receiptRef: reportReference,
  outcome: z.enum(["succeeded", "failed", "unknown"]), observedAt: reportInstant }).strict();
const migrationReads = z.object({ scope: reportScopeSchema, jobRef: reportReference, windowRef: reportReference,
  old: triggerVersion, replacement: triggerVersion, coverage: z.enum(["complete", "partial", "unknown"]),
  coverageReceipt: reportReference, reads: z.array(triggerRun).max(100) }).strict();
const terminal = z.object({
  scope: reportScopeSchema,
  sourceVersion: reportReference,
  zapRef: reportReference,
  jobRef: reportReference,
  runRef: reportReference,
  itemRef: reportReference,
  originalAttemptRef: reportReference,
  checkpointRef: reportReference.nullable(),
  observedAt: reportInstant,
  errorClass: automationErrorClass,
  migration: migrationReads.optional(),
  replay: z.discriminatedUnion("state", [
    z.object({ state: z.literal("safeRead") }).strict(),
    z.object({ state: z.literal("sourceEnforced"), proofRef: reportReference }).strict(),
    z.object({ state: z.literal("uncertain") }).strict(),
    z.object({ state: z.literal("held") }).strict(),
  ]),
});
const automationFailureEvidence = z.discriminatedUnion("transition", [
  terminal.extend({ transition: z.literal("breach"), terminalFailureReceipt: reportReference }).strict(),
  terminal.extend({ transition: z.literal("clear"), terminalFailureReceipt: reportReference, recoveryReceipt: reportReference }).strict(),
]);
type FailureEvidence = z.infer<typeof automationFailureEvidence>;
type Recovery = NonNullable<ReportEvent["automationFailure"]>["recovery"];
const recoveryByClass: Partial<Record<FailureEvidence["errorClass"], Recovery>> = {
  permissionLost: "restoreAccess", tasksExhausted: "waitForTasks", rateLimited: "waitForRateLimit",
  invalidConfiguration: "fixConfiguration", unknownOutcome: "reconcileOriginal",
};

function recoveryFor(evidence: FailureEvidence): Recovery {
  if (evidence.transition === "clear") {
    if (evidence.replay.state === "uncertain" || evidence.recoveryReceipt === evidence.terminalFailureReceipt)
      throw new Error("AUTOMATION_RECOVERY_UNVERIFIED");
    return "continueMonitoring";
  }
  if (evidence.errorClass === "duplicateTrigger") return "reviewDuplicateTrigger";
  if (evidence.replay.state === "uncertain") return "reconcileOriginal";
  const classified = recoveryByClass[evidence.errorClass];
  if (classified) return classified;
  return evidence.checkpointRef && (evidence.replay.state === "safeRead" || evidence.replay.state === "sourceEnforced")
    ? "retryVerifiedCheckpoint" : "reviewRun";
}

/** An adopted migration can detect a duplicate even when both source runs succeeded. */
export function inspectAutomationTriggerOverlap(raw: unknown) {
  const input = migrationReads.parse(raw);
  const unknown = { state: "unknown" as const };
  const scope = canonicalJson(input.scope), triggerKey = (trigger: z.infer<typeof triggerVersion>) => canonicalJson(trigger);
  const old = triggerKey(input.old), replacement = triggerKey(input.replacement);
  if (input.coverage !== "complete" || input.old.ref === input.replacement.ref ||
      input.reads.some(run => canonicalJson(run.scope) !== scope || run.jobRef !== input.jobRef || run.windowRef !== input.windowRef ||
        (triggerKey(run.trigger) !== old && triggerKey(run.trigger) !== replacement) || run.outcome === "unknown")) return unknown;
  const runs = new Map<string, string>();
  for (const run of input.reads) {
    const existing = runs.get(run.runRef), canonical = canonicalJson(run);
    if (existing && existing !== canonical) return unknown;
    runs.set(run.runRef, canonical);
  }
  const previous = input.reads.find(run => triggerKey(run.trigger) === old && run.outcome === "succeeded");
  const next = input.reads.find(run => triggerKey(run.trigger) === replacement && run.outcome === "succeeded");
  return previous && next ? { state: "duplicate" as const, original: previous, replacement: next } : { state: "noOverlap" as const };
}

/** Normalize a terminal source receipt for the shared reporter. The source still owns admission and delivery authority. */
export function automationFailureEvent(raw: unknown, binding: Pick<ReportEvent, "producerRef" | "link">, secret: string): ReportEvent {
  if (secret.length < 32) throw new Error("AUTOMATION_REPORT_SECRET_INVALID");
  const evidence = automationFailureEvidence.parse(raw);
  if (evidence.errorClass === "duplicateTrigger" && evidence.transition === "breach") {
    const overlap = evidence.migration ? inspectAutomationTriggerOverlap(evidence.migration) : null;
    if (!overlap || overlap.state !== "duplicate" || canonicalJson(overlap.replacement.scope) !== canonicalJson(evidence.scope) ||
        overlap.replacement.jobRef !== evidence.jobRef || overlap.replacement.runRef !== evidence.runRef ||
        [overlap.original, overlap.replacement].some(run => Date.parse(run.observedAt) > Date.parse(evidence.observedAt))) {
      throw new Error("AUTOMATION_DUPLICATE_TRIGGER_UNVERIFIED");
    }
  }
  const alias = (label: string, value: unknown) => createHmac("sha256", secret)
    .update(canonicalJson(["automation-failure", evidence.scope, label, value])).digest("hex").slice(0, 20);
  const conditionRef = "automation-" + alias("incident", [evidence.zapRef, evidence.jobRef, evidence.runRef,
    evidence.itemRef, evidence.originalAttemptRef]);
  const clear = evidence.transition === "clear";
  return reportEventSchema.parse({
    ...binding,
    eventRef: conditionRef + (clear ? "-recovery" : "-failure"),
    eventVersion: "source-" + alias("version", [evidence.sourceVersion, evidence.terminalFailureReceipt, clear ? evidence.recoveryReceipt : null]),
    occurredAt: evidence.observedAt,
    severity: clear ? "info" : "red",
    identity: { kind: "incident", conditionRef, generation: 1, transition: evidence.transition, sequence: clear ? 2 : 1, previousClearEventRef: null },
    subject: { kind: "aggregate", category: "automation" },
    facts: [{ label: "incidentStatus", value: clear ? "cleared" : "breached" }],
    nextAction: clear ? "continueMonitoring" : "reviewAutomation",
    automationFailure: { zap: alias("zap", evidence.zapRef), job: alias("job", evidence.jobRef), run: alias("run", evidence.runRef),
      item: alias("item", evidence.itemRef), checkpoint: evidence.checkpointRef ? alias("checkpoint", evidence.checkpointRef) : null,
      errorClass: evidence.errorClass, recovery: recoveryFor(evidence) },
  });
}

export type AutomationFailureReportingBinding = {
  event: Pick<ReportEvent, "producerRef" | "link">;
  read(locator: ReportLocator, context: ReportSourceRead): Promise<{
    evidence: unknown;
    delivery: Omit<ReportSnapshot, "event">;
  }>;
  assertCurrent(snapshot: ReportSnapshot, purpose: ReportSourceRead["purpose"], now: number): void;
};

/** Read exact owner-provided evidence through the existing authenticated reporting admission. */
export function bindAutomationFailureReporting(delegate: ReportingSource, scope: ReportScope, secret: string,
  binding: AutomationFailureReportingBinding): ReportingSource {
  const configured = structuredClone(binding.event);
  const owns = (locator: ReportLocator) => /^automation-[a-f0-9]{20}-(failure|recovery)$/.test(locator.eventRef);
  return {
    async readEvent(locator, context) {
      if (!owns(locator)) return delegate.readEvent(locator, context);
      if (!context) throw new ReportError("REPORT_PERMISSION_DENIED", 403);
      context.assertCurrent();
      const result = await binding.read(structuredClone(locator), context);
      context.assertCurrent();
      const evidence = automationFailureEvidence.parse(result.evidence);
      if (canonicalJson(evidence.scope) !== canonicalJson(scope) || canonicalJson(result.delivery.scope) !== canonicalJson(scope))
        throw new ReportError("REPORT_SCOPE_MISMATCH", 403);
      const event = automationFailureEvent(evidence, configured, secret);
      if (event.eventRef !== locator.eventRef || event.eventVersion !== locator.eventVersion) throw new ReportError("REPORT_EVENT_MISMATCH");
      return { ...result.delivery, event };
    },
    assertCurrent(snapshot, purpose, now) {
      if (owns(snapshot.event)) {
        if (!snapshot.event.automationFailure || snapshot.event.producerRef !== configured.producerRef ||
            canonicalJson(snapshot.event.link) !== canonicalJson(configured.link)) throw new ReportError("REPORT_EVENT_MISMATCH");
        assertSynchronousVoid(() => binding.assertCurrent(snapshot, purpose, now));
      }
      assertSynchronousVoid(() => delegate.assertCurrent(snapshot, purpose, now));
    },
    authorizeAttempt: (snapshot, command) => delegate.authorizeAttempt(snapshot, command),
    assertGrant: (grant, command, now) => delegate.assertGrant(grant, command, now),
    deliver: (command, context) => delegate.deliver(command, context),
    lookup: (command, context) => delegate.lookup(command, context),
  };
}
