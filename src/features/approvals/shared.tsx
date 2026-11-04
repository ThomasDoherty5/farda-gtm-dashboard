import { useEffect, useRef, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";
import type { ActionState, ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { Alert } from "@/components/Alert";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { formatMoney } from "@/components/MetricValue";
import type { ApprovalPayload } from "./types";
import styles from "./Approvals.module.css";

export const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" }).format(new Date(iso));

/** Words shown for each execution state. Only a source receipt ever reads as Sent. */
export const EXECUTION_LABELS: Record<ActionState, string> = {
  draft: "Draft",
  approvalPending: "Approval required",
  queued: "Queued, not sent",
  blocked: "Blocked",
  running: "Running",
  succeeded: "Sent, source receipt on file",
  partiallySucceeded: "Partly complete",
  failed: "Failed",
  outcomeUncertain: "Outcome unknown",
  reconciling: "Reconciling",
  paused: "Paused",
  canceled: "Canceled",
};

const CAPABILITY_REASONS: Record<string, string> = {
  APPROVAL_EXPIRED: "This approval expired. It needs a fresh preview.",
  ROLE_REQUIRED: "You don't have the role this decision needs.",
  EVIDENCE_REQUIRED: "Check the source first. This needs independent evidence.",
  NOTHING_TO_PAUSE: "There is no unsent work to pause.",
  NOTHING_TO_CANCEL: "There is no unsent work to cancel.",
  ALREADY_PAUSED: "New work is already paused.",
  PLAYBACK_UNVERIFIED: "Blocked until permitted playback and actually observed intervals support the claimed review depth. Elapsed time, captions and thumbnails don't count.",
  CONNECTION_UNVERIFIED: "Enabling needs a verified connection, authorized schedule settings, a time zone and any required approval, then an explicit server acknowledgment.",
  TAKEOVER_NOT_ASSIGNED: "Taking over needs a server-confirmed assignment for this task.",
  SOURCE_ACCESS_UNVERIFIED: "Blocked until source access, a real account configuration, quota capacity and an authorized runtime exist. A demo can't start a live job.",
};

/** The reason a capability blocks an action, or null when the server allows it. UI state is advisory; the server still enforces. */
export function blockedReason(res: ReadResponse<unknown>, actionKind: string): string | null {
  const capability = res.capabilities.find((c) => c.actionKind === actionKind);
  if (!capability) return "This action isn't available for this record.";
  if (capability.state === "available") return null;
  return capability.reasonCodes.map((code) => CAPABILITY_REASONS[code] ?? code).join(" ") || `This action is ${capability.state}.`;
}

/** Commission terms and independent channels. Required by the approval contract, though not in Figma's historical sample. */
export function TermsView({ payload, policyVersion, offerVersion }: { payload: ApprovalPayload; policyVersion: string; offerVersion: string | null }) {
  const rows: [string, string][] = [
    ["Recruitment source", payload.recruitmentSource],
    ["Publishing networks", payload.publishingNetworks.join(", ")],
    ["Checkout", payload.checkout],
    ["Commission", `${payload.terms.commissionRatePct}% per eligible sale`],
    ["Upfront fee", formatMoney(payload.terms.upfrontFee)],
    ["Sample cost, approved separately", payload.terms.sampleCost ? formatMoney(payload.terms.sampleCost) : "No sample"],
    ["Policy version", policyVersion],
    ["Offer version", offerVersion ?? "None"],
  ];
  return <Details rows={rows} columns={2} />;
}

/** Label and value rows (Figma "Detail" rows such as 6:307). */
export function Details({ rows, columns = 1 }: { rows: [string, string][]; columns?: 1 | 2 }) {
  const half = Math.ceil(rows.length / 2);
  const groups = columns === 2 ? [rows.slice(0, half), rows.slice(half)] : [rows];
  return (
    <div className={styles.detailColumns}>
      {groups.map((group, i) => (
        <dl key={i} className={styles.details}>
          {group.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      ))}
    </div>
  );
}

/** The labeled "Historical" box near the top of each approval and run screen. */
export function HistoricalNote({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className={styles.historical}>
      <p className={styles.historicalTitle}>{title}</p>
      <p className={styles.small}>{note}</p>
      <div className={styles.historicalActions}>{children}</div>
    </div>
  );
}

/** Handoff to a source system (Figma overlay 42:1709). It never invents a destination: a missing link says so. */
export function SourceDialog({ open, title, url, onClose }: { open: boolean; title: string; url: string | null; onClose: () => void }) {
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <p>{url ? "This opens the verified source record in its owning platform." : "No verified link is available for this record, so nothing opens from here. Nothing was changed in the source."}</p>
      {url && <a href={url} target="_blank" rel="noreferrer">Open in a new tab</a>}
      <LinkButton variant="secondary" to="/settings/connections">View connection settings</LinkButton>
      <Button variant="secondary" onClick={onClose}>Close preview</Button>
    </Dialog>
  );
}

/** Material differences between two payload versions, for review after a conflict. */
export function payloadChanges(before: ApprovalPayload, after: ApprovalPayload): { field: string; from: string; to: string }[] {
  const facts = (p: ApprovalPayload): Record<string, string> => ({
    Message: p.message,
    Recipients: p.recipients.map((r) => r.sourceId ?? "Unknown").join(", "),
    Commission: `${p.terms.commissionRatePct}%`,
    "Upfront fee": formatMoney(p.terms.upfrontFee),
    "Sample cost": p.terms.sampleCost ? formatMoney(p.terms.sampleCost) : "No sample",
    Account: p.account.sourceId ?? "Unknown",
  });
  const a = facts(before);
  const b = facts(after);
  return Object.keys(a).filter((field) => a[field] !== b[field]).map((field) => ({ field, from: a[field]!, to: b[field]! }));
}

/** A failed action. Takes focus so keyboard and screen-reader users land on it. */
export function ActionError({ error }: { error: Error }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [error]);
  const adapterError = error instanceof AdapterError ? error : null;
  const category = adapterError?.category ?? "unknown";
  const titles: Record<string, string> = {
    unauthenticated: "Sign in again",
    forbidden: "You can't do this",
    validation: "Fix this and try again",
    conflict: "This record changed",
    approvalHold: "Approval needed",
    capabilityHold: "Not available yet",
    resourceHold: "On hold",
    outcomeUncertain: "Outcome still unknown",
    unavailable: "Couldn't reach the service",
  };
  const certainty = adapterError?.body.executionCertainty;
  return (
    <Alert ref={ref} state="error" focusable title={titles[category] ?? "Something went wrong"} testId="action-error">
      <p>{category === "unknown" ? "This action could not be completed." : error.message}</p>
      {certainty === "notApplied" && <p>Nothing was sent.</p>}
      {certainty === "uncertain" && <p>Don't retry until the outcome is reconciled.</p>}
      {adapterError?.body.correlationId && <p>Reference: {adapterError.body.correlationId}</p>}
    </Alert>
  );
}

/** Asks before leaving with unsaved edits. Keep task (CTRL-177) returns to the form with edits intact. */
export function LeaveGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search);
  return (
    <Dialog open={blocker.state === "blocked"} title="Discard your edits?" onClose={() => blocker.reset?.()}>
      <p>You have unsaved changes on this approval.</p>
      <Button onClick={() => blocker.reset?.()}>Keep task</Button>
      <Button variant="secondary" onClick={() => blocker.proceed?.()}>Discard and leave</Button>
    </Dialog>
  );
}
