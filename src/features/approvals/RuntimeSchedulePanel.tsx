import type { SafeRuntimeRun, SafeRuntimeScheduling } from "@/creator-agent/jobs/runtimeViews";
import { Badge } from "@/components/Badge";
import { Details, dateTime } from "./shared";
import styles from "./Approvals.module.css";
import native from "./NativeApproval.module.css";

const cadenceLabel = { daily: "Daily", weekdays: "Weekdays", "weekly-monday": "Every Monday" };
const familyLabel = { J19: "Daily creator discovery", J20: "Daily video review", J08: "Enrolled-creator monitoring", "registered-business": "Registered business workflow" };
function oldestLabel(backlog: Extract<SafeRuntimeScheduling["backlog"], { state: "observed" }>) {
  if (backlog.oldestUnadmittedAt !== null) return dateTime(backlog.oldestUnadmittedAt);
  return backlog.unadmittedInScannedRange === 0 ? "None in the inspected range" : "Unknown · due-slot timestamp unavailable";
}
function cadenceRows(cadence: SafeRuntimeScheduling["cadence"]): [string, string][] {
  if (cadence.kind === "event") return [["Cadence", "Event-driven"], ["Time zone", "Not applicable · no scheduled time"], ["Scheduled start", "Not applicable · source events admit work"]];
  return [["Cadence", cadence.kind === "hourly" ? `Hourly at minute ${String(cadence.minute).padStart(2, "0")}` : `${cadenceLabel[cadence.cadence]} at ${cadence.localTime}`],
    ["Time zone", cadence.timezone], ["Scheduled from", cadence.startsAt]];
}

/** Read-only schedule evidence, using the schedule/route cards from source 14:911. It cannot change or activate a trigger. */
export function RuntimeSchedulePanel({ data, stale }: { data: Pick<SafeRuntimeRun, "scheduling" | "family">; stale: boolean }) {
  const scheduling = data.scheduling;
  if (!scheduling) return <section className={styles.card} aria-labelledby="runtime-schedule-title" data-figma-source="14:911">
    <h2 id="runtime-schedule-title" className={styles.h2}>Registered trigger and cadence</h2>
    <Badge tone="warning">Schedule evidence unknown</Badge>
    <p>The source has not returned this run’s trigger, cadence or due-work scan. Missing schedule evidence does not mean no backlog or an inactive trigger.</p>
  </section>;
  const backlog = scheduling.backlog;
  return <div className={styles.runColumns} data-figma-source="14:911">
    <section className={styles.card} aria-labelledby="runtime-schedule-title">
      <h2 id="runtime-schedule-title" className={styles.h2}>Registered trigger and cadence</h2>
      <Badge tone={stale ? "warning" : "neutral"}>{stale ? "Stale source snapshot" : "Read-only source snapshot"}</Badge>
      <Details rows={[["Workflow", familyLabel[data.family]], ...cadenceRows(scheduling.cadence),
        ["Verified at", dateTime(scheduling.observedAt)], ["Valid until", dateTime(scheduling.validUntil)]]} />
      <details><summary>Trigger evidence references</summary>
        <p className={native.ref}>Trigger: {scheduling.trigger.alias}</p>
        <p className={native.ref}>Trigger version: {scheduling.trigger.versionAlias}</p>
      </details>
      <p className={styles.small}>This is the registered source snapshot, separate from this run’s historical window and any editable schedule draft. It does not prove future delivery or authorize activation.</p>
    </section>
    <section className={styles.card} aria-labelledby="runtime-backlog-title">
      <h2 id="runtime-backlog-title" className={styles.h2}>Due work in the inspected range</h2>
      {backlog.state === "notApplicable" ? <>
        <Badge tone="neutral">Not applicable · event-driven</Badge>
        <p>Source events admit this registration’s work. There is no scheduled next slot or calendar backlog to count.</p>
        <p className={styles.small}>This says nothing about events the source has not delivered.</p>
      </> : <>
        <Badge tone={backlog.scanComplete ? "neutral" : "warning"}>{backlog.scanComplete ? "Inspected range complete" : "Partial due-work scan"}</Badge>
        <Details rows={[["Next planned slot", backlog.nextPlannedAt ? dateTime(backlog.nextPlannedAt) : "Unknown · no next slot supplied"],
          ["Oldest unadmitted slot", oldestLabel(backlog)], ["Unadmitted in inspected range", String(backlog.unadmittedInScannedRange)],
          ["Slots inspected", String(backlog.scannedSlots)], ["Requested range start", dateTime(backlog.scannedFrom)],
          ["Requested through", dateTime(backlog.requestedThrough)],
          ["Last slot inspected", backlog.scannedThrough ? dateTime(backlog.scannedThrough) : "No slots inspected"],
          ["Next uninspected slot", backlog.scanCursor ? dateTime(backlog.scanCursor) : backlog.scanComplete ? "None in the requested range" : "Unknown"],
          ["Global backlog total", "Unknown"]]} />
        <p className={styles.small}>{backlog.scanComplete ? "The requested range was inspected; this is not an all-time or global backlog total." : "More due slots may remain outside the inspected range. A partial scan cannot establish zero backlog."} Planned slots are not confirmed runs or delivery receipts.</p>
      </>}
    </section>
  </div>;
}
