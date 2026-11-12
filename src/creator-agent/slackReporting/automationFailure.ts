import { createHmac } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../config.ts";
import { automationErrorClass, reportEventSchema, reportInstant, reportReference, reportScopeSchema,
  type ReportEvent } from "./contract.ts";

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
  invalidConfiguration: "fixConfiguration", duplicateTrigger: "reviewDuplicateTrigger", unknownOutcome: "reconcileOriginal",
};

function recoveryFor(evidence: FailureEvidence): Recovery {
  if (evidence.transition === "clear") {
    if (evidence.replay.state === "uncertain" || evidence.recoveryReceipt === evidence.terminalFailureReceipt)
      throw new Error("AUTOMATION_RECOVERY_UNVERIFIED");
    return "continueMonitoring";
  }
  if (evidence.replay.state === "uncertain") return "reconcileOriginal";
  const classified = recoveryByClass[evidence.errorClass];
  if (classified) return classified;
  return evidence.checkpointRef && (evidence.replay.state === "safeRead" || evidence.replay.state === "sourceEnforced")
    ? "retryVerifiedCheckpoint" : "reviewRun";
}

/** Normalize a terminal source receipt for the shared reporter. The source still owns admission and delivery authority. */
export function automationFailureEvent(raw: unknown, binding: Pick<ReportEvent, "producerRef" | "link">, secret: string): ReportEvent {
  if (secret.length < 32) throw new Error("AUTOMATION_REPORT_SECRET_INVALID");
  const evidence = automationFailureEvidence.parse(raw);
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
