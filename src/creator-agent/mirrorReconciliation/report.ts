import { digest } from "../config.ts";
import { reportEventSchema, type ReportEvent } from "../slackReporting/contract.ts";
import type { MirrorReconciliationRepository } from "./repository.ts";

export type ReconciliationReportBinding = Pick<ReportEvent, "producerRef" | "link">;

/** Produce a typed aggregate for the existing reporter. Admission and delivery still use its source-owned policy. */
export function reconciliationReport(repo: MirrorReconciliationRepository, runId: string, binding: ReconciliationReportBinding): ReportEvent | null {
  const run = repo.run(runId), window = run?.scheduledWindow;
  if (!run || !window || window.timezone !== "America/Los_Angeles") return null;
  const { opened, reopened, cleared } = run.dispositions;
  if (!opened && !reopened && !cleared) return null;
  const incomplete = run.outcome === "incomplete" || run.staleComparisons > 0;
  const transitions = new Map(repo.runFindings(runId).map(finding => [finding.fingerprint, finding.disposition]));
  const raised = run.findings.filter(finding => ["opened", "reopened"].includes(transitions.get(finding.fingerprint) ?? ""));
  const affected = new Set(raised.map(finding => digest([finding.comparisonId, finding.recordKey]))).size;
  const needsReview = affected > 0 || incomplete || run.outcome === "differences";
  return reportEventSchema.parse({
    ...binding,
    eventRef: `mirror-reconciliation:${run.runId}`,
    eventVersion: `schedule-v${run.scheduleVersion}`,
    occurredAt: run.observedAt,
    severity: needsReview ? "orange" : "info",
    identity: { kind: "window", cadence: "orangeDigest", windowRef: `reconciliation:${run.runId}`, start: window.start, end: window.end,
      timezone: window.timezone, launchWindowRef: null },
    subject: { kind: "aggregate", category: "automation" },
    facts: [
      { label: "coverage", value: incomplete ? "partial" : "complete" },
      { label: "records", value: affected, unit: "count", missingReason: null },
    ],
    nextAction: needsReview ? "reviewSource" : "continueMonitoring",
  });
}
