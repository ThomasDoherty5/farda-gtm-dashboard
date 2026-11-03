import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";
import type { ActionState, ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { formatMoney } from "@/components/MetricValue";
import type { ApprovalPayload } from "./types";

export const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" }).format(new Date(iso));

/** Words shown for each execution state. Only a source receipt ever reads as Sent. */
export const EXECUTION_LABELS: Record<ActionState, string> = {
  draft: "Draft",
  approvalPending: "Waiting for approval",
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
};

/** The reason a capability blocks an action, or null when the server allows it. UI state is advisory; the server still enforces. */
export function blockedReason(res: ReadResponse<unknown>, actionKind: string): string | null {
  const capability = res.capabilities.find((c) => c.actionKind === actionKind);
  if (!capability) return "This action isn't available for this record.";
  if (capability.state === "available") return null;
  return capability.reasonCodes.map((code) => CAPABILITY_REASONS[code] ?? code).join(" ") || `This action is ${capability.state}.`;
}

export function PayloadView({ payload, policyVersion, offerVersion }: { payload: ApprovalPayload; policyVersion: string; offerVersion: string | null }) {
  const rows: [string, string][] = [
    ["Action", payload.actionLabel],
    ["Source account", payload.account.sourceId ?? "Unknown"],
    ["Creator", payload.creator.sourceId ?? "Unknown"],
    ["Recipients", payload.recipients.map((r) => r.sourceId ?? "Unknown").join(", ")],
    ["Recruitment source", payload.recruitmentSource],
    ["Publishing networks", payload.publishingNetworks.join(", ")],
    ["Checkout", payload.checkout],
    ["Commission", `${payload.terms.commissionRatePct}% per eligible sale`],
    ["Upfront fee", formatMoney(payload.terms.upfrontFee)],
    ["Sample cost, approved separately", payload.terms.sampleCost ? formatMoney(payload.terms.sampleCost) : "No sample"],
    ["Policy version", policyVersion],
    ["Offer version", offerVersion ?? "None"],
  ];
  return (
    <>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt style={{ font: "var(--text-label)" }}>{label}</dt>
            <dd style={{ margin: "0 0 var(--space-8)" }}>{value}</dd>
          </div>
        ))}
      </dl>
      <h3 style={{ font: "var(--text-h3)" }}>Exact message</h3>
      {/* Rendered as text, never as markup: source and draft text is untrusted data. */}
      <p style={{ whiteSpace: "pre-wrap" }} data-testid="exact-message">{payload.message}</p>
    </>
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
