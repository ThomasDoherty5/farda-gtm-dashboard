import { createHash } from "node:crypto";
import { reportEventSchema, type ReportFact, type ReportSnapshot } from "./contract.ts";
import { PROPOSED_DEFAULT_MIRROR_POLICIES } from "../mirrorFreshness.ts";

const labels = { orders: "Orders affected", shipments: "Shipments affected", records: "Records affected", failedRuns: "Failed runs", pendingItems: "Pending items", oldestAge: "Oldest age", elapsed: "Elapsed time", amount: "Amount", sourceStatus: "Source status", coverage: "Coverage", incidentStatus: "Incident status" } as const;
const statuses = { unavailable: "unavailable", permissionDenied: "permission denied", rateLimited: "rate limited", partial: "partial", complete: "complete", breached: "breached", cleared: "cleared", unknown: "unknown" };
const actions = { inspectShipment: "Inspect the shipment and its source record.", reviewAutomation: "Review the automation and reconcile its original attempt.", reviewSource: "Review the source and its missing evidence.", reviewCreator: "Review the creator record.", reviewContent: "Review the content record.", reviewFinance: "Review the finance record; this report does not authorize payment.", reviewSupport: "Review the support record.", reviewLaunch: "Review launch readiness; this report does not release media or approve a launch.", continueMonitoring: "Continue monitoring the source." };
function factText(fact: ReportFact): string {
  if (!("unit" in fact)) return `${labels[fact.label]}: ${statuses[fact.value]}`;
  const value = fact.value === null ? (fact.missingReason === "notApplicable" ? "not applicable" : `unknown (${fact.missingReason === "partialSource" ? "partial source" : "not observed"})`) : fact.unit === "USD-minor" ? `$${Math.floor(fact.value / 100)}.${String(fact.value % 100).padStart(2, "0")}` : `${fact.value.toLocaleString("en-US")}${fact.unit === "minutes" ? " minutes" : ""}`;
  return `${labels[fact.label]}: ${value}`;
}

/** Finite labels and typed values only. It never accepts free-form message/error/customer text. */
export function formatReport(snapshot: ReportSnapshot): { body: string; bodyHash: string } {
  const event = reportEventSchema.parse(snapshot.event);
  const verdict = (event.severity === "red" ? "🔴 Act now" : event.severity === "orange" ? "🟠 Act today" : "🟢 Info") + (snapshot.testProvenance?.kind === "controlledSandbox" ? " · Controlled sandbox test" : "");
  const subject = event.subject.kind === "order" ? `Order ${event.subject.orderRef}` : event.subject.kind === "creator" ? `Creator @${event.subject.handle}` : `${event.subject.category[0]!.toUpperCase()}${event.subject.category.slice(1)} aggregate`;
  const context = event.identity.kind === "window" ? `${subject} · ${event.identity.start}–${event.identity.end} (${event.identity.timezone})` : `${subject} · ${event.identity.transition === "clear" ? "Source-confirmed recovery" : "Source-confirmed incident"}`;
  const owner = snapshot.destination.owner.state === "active" ? `<@${snapshot.destination.owner.memberId}>` : snapshot.destination.owner.state === "deactivated" ? "unassigned (previous owner deactivated; no backup configured)" : "unassigned (no backup configured)";
  const provenance = createHash("sha256").update(JSON.stringify([event.eventRef, event.eventVersion, snapshot.programme.version])).digest("hex").slice(0, 12);
  const link = `https://linear.app/${event.link.workspaceSlug}/issue/${event.link.issueIdentifier}`;
  const mirror = event.mirror;
  const recovery = {restoreAccessAndCompleteCheck:"Restore source access and run a complete check.",reviewPartialCoverage:"Review missing coverage and run a complete check.",resumeAndCompleteCheck:"Resume the mirror and verify a complete successful check.",configureSourceCheck:"Configure the source check; no successful run has been observed."};
  const mirrorLines=mirror?[
    `Source: ${PROPOSED_DEFAULT_MIRROR_POLICIES[mirror.incident.mirrorId].label} (${mirror.incident.provider})`,
    `Last complete check: ${mirror.incident.lastCompleteCheckAt??"unknown"}`,
    `Complete coverage through: ${mirror.incident.coverageWatermark??"unknown"}`,
    `Coverage age: ${mirror.incident.ageMinutes===null?"unknown":`${mirror.incident.ageMinutes} minutes`}`,
    `Threshold: ${mirror.incident.staleAfterMinutes===null?"unconfigured":`${mirror.incident.staleAfterMinutes} minutes`}`,
    mirror.runEvidenceUrl?`<${mirror.runEvidenceUrl}|Inspect exact run evidence>`:"Run evidence: unavailable (no run observed)",
  ]:[];
  const next=mirror?(mirror.incident.event==="cleared"?"Complete recovery verified. Continue monitoring the source.":recovery[mirror.incident.recoveryAction]):actions[event.nextAction];
  const body = [verdict, context, ...event.facts.map(value => `• ${factText(value)}`), ...mirrorLines, `Next: ${next}`, `Owner: ${owner}`, `<${link}|Authorized source record> · evidence ${provenance}`, "Reporting only; no business action is approved."].join("\n");
  if (body.length > 3000 || /<!|<@(?:channel|here|everyone)>|\b(?:Bearer|Authorization:)\b/i.test(body)) throw new Error("REPORT_FORMAT_UNSAFE");
  return { body, bodyHash: createHash("sha256").update(body).digest("hex") };
}
