import { useId, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { AdapterError } from "@/adapter/errors";
import { Button } from "@/components/Button";
import { ViewError } from "@/components/ViewError";
import { ActionError, EXECUTION_LABELS, LeaveGuard, PayloadView, blockedReason, dateTime, payloadChanges } from "./shared";
import type { ApprovalDetail, ApprovalStatus, ApprovalVersion, DecidePayload } from "./types";

const STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "Waiting for a decision",
  approved: "Approved, not sent",
  rejected: "Rejected",
  editRequired: "Edit requested",
  expired: "Expired",
  canceled: "Canceled",
};

type Res = ReadResponse<ApprovalDetail>;

/**
 * Approval detail (Figma source 6:234, owner THO-296), with history (CTRL-026 to CTRL-028).
 * BEHAVIOR SLICE ONLY: the layout and visuals are PENDING Figma intake; no fidelity is claimed.
 */
export function ApprovalPage() {
  const { approvalId = "" } = useParams();
  const [search] = useSearchParams();
  const filters = useMemo(() => ({ approvalId }), [approvalId]);
  const query = useView<{ approvalId: string }, ApprovalDetail>("approvalDetail", filters);
  const requestedVersion = search.get("version");
  const showHistory = search.get("view") === "history";

  return (
    <section aria-labelledby="approval-title" data-figma-source="6:234">
      <h1 id="approval-title" style={{ font: "var(--text-h1)", marginTop: 0 }}>Approval detail</h1>
      {query.isPending && <p role="status">Loading approval…</p>}
      {query.isError && (
        <ViewError error={query.error} subject="This approval" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} parent={<p><Link to="/approvals">Back to approvals</Link></p>} />
      )}
      {query.data?.data &&
        (requestedVersion ? (
          <HistoricalVersion data={query.data.data} version={requestedVersion} />
        ) : showHistory ? (
          <History data={query.data.data} />
        ) : (
          <Current res={query.data as Res} data={query.data.data} />
        ))}
    </section>
  );
}

function Current({ res, data }: { res: Res; data: ApprovalDetail }) {
  const { adapter } = useScope();
  const decide = useAction<DecidePayload>();
  const dispatch = useAction<Record<string, never>>();
  const [reviewedVersion, setReviewedVersion] = useState(data.currentVersion);
  const current = data.versions[data.versions.length - 1]!;
  const reviewed = data.versions.find((v) => v.version === reviewedVersion);
  const changes = reviewed && reviewed.version !== current.version && reviewed.decision === null ? payloadChanges(reviewed.payload, current.payload) : [];

  const executionRun = data.execution?.runRef ?? null;
  const dispatchBlocked = blockedReason(res, "dispatchApprovedAction");
  const uncertain = data.execution?.state === "outcomeUncertain";
  const canSend = res.capabilities.some((c) => c.actionKind === "dispatchApprovedAction");

  return (
    <>
      <p role="status" data-testid="approval-status">
        <strong>{data.execution ? EXECUTION_LABELS[data.execution.state] : STATUS_LABELS[data.status]}</strong> · Version {data.currentVersion} · Decision by: {data.requiredRole} · Expires {dateTime(data.expiresAt)}
      </p>
      {changes.length > 0 && (
        <div role="alert" data-testid="version-changes">
          <h2 style={{ font: "var(--text-h2)" }}>Changed since you started reviewing</h2>
          <ul>{changes.map((c) => <li key={c.field}>{c.field}: {c.from} → {c.to}</li>)}</ul>
          <p>Your earlier decision was not applied. Review this version before deciding.</p>
          <Button onClick={() => setReviewedVersion(data.currentVersion)}>Mark as reviewed</Button>
        </div>
      )}
      <h2 style={{ font: "var(--text-h2)" }}>What will be sent</h2>
      <PayloadView payload={current.payload} policyVersion={current.policyVersion} offerVersion={current.offerVersion} />

      {data.status === "pending" || data.status === "expired" ? (
        <DecisionPanel key={current.version} res={res} data={data} current={current} decide={decide} />
      ) : (
        <DecisionSummary version={current} />
      )}

      {data.status === "approved" && (canSend || data.execution) && (
        <>
          <h2 style={{ font: "var(--text-h2)" }}>Send</h2>
          {!data.execution && <p>Approval authorizes this exact version. It isn't sent until the source returns a receipt.</p>}
          {!data.execution && (
            <Button loading={dispatch.isPending} disabledReason={dispatchBlocked} onClick={() => dispatch.mutate({ operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", entityRefs: [current.payload.creator], expectedVersion: data.currentVersion, approvalRef: data.approvalRef, manifestRef: data.manifestRef, payload: {} })}>
              Send approved action
            </Button>
          )}
          {dispatch.error && <ActionError error={dispatch.error} />}
          {data.execution?.receiptRefs.map((r) => <p key={r} data-testid="source-receipt">Source receipt: {r}{adapter.kind === "demo" ? " (synthetic demo receipt, nothing was sent)" : ""}</p>)}
          {uncertain && <p role="alert">The source didn't confirm this send. Don't retry until the outcome is reconciled.</p>}
          {executionRun && <p><Link to={`/runs/${executionRun}?tab=${uncertain ? "recovery" : "approval"}`}>{uncertain ? "Open recovery" : "Open run"}</Link></p>}
        </>
      )}
      <p><Link to="?view=history">Approval history</Link></p>
    </>
  );
}

function DecisionSummary({ version }: { version: ApprovalVersion }) {
  return (
    <>
      <h2 style={{ font: "var(--text-h2)" }}>Decision</h2>
      <DecisionFacts version={version} />
    </>
  );
}

function DecisionPanel({ res, data, current, decide }: { res: Res; data: ApprovalDetail; current: ApprovalVersion; decide: ReturnType<typeof useAction<DecidePayload>> }) {
  const reasonId = useId();
  const messageId = useId();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState(current.payload.message);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [pendingKind, setPendingKind] = useState<DecidePayload["decision"] | null>(null);
  const blocked = blockedReason(res, "decideApproval");
  const dirty = reason !== "" || message !== current.payload.message;

  const serverErrors = decide.error instanceof AdapterError ? decide.error.body.fieldErrors ?? {} : {};
  const errors = { ...serverErrors, ...localErrors };

  const submit = (payload: DecidePayload) => {
    setPendingKind(payload.decision);
    setLocalErrors({});
    decide.mutate({ operation: "decideApproval", actionKind: "decideApproval", entityRefs: [current.payload.creator], expectedVersion: data.currentVersion, approvalRef: data.approvalRef, manifestRef: data.manifestRef, payload });
  };

  return (
    <>
      <LeaveGuard dirty={dirty && !decide.isPending} />
      <h2 style={{ font: "var(--text-h2)" }}>Decision</h2>
      {decide.error && <ActionError error={decide.error} />}
      <Button loading={decide.isPending && pendingKind === "approved"} disabledReason={blocked} onClick={() => submit({ decision: "approved" })}>Approve this version</Button>

      <h3 style={{ font: "var(--text-h3)" }}>Reject</h3>
      <label htmlFor={reasonId} style={{ display: "block", font: "var(--text-label)" }}>Reason</label>
      <textarea id={reasonId} value={reason} rows={2} style={{ width: "100%" }} aria-invalid={Boolean(errors.reason)} aria-describedby={errors.reason ? `${reasonId}-error` : undefined} onChange={(e) => setReason(e.target.value)} />
      {errors.reason && <p id={`${reasonId}-error`}>{errors.reason}</p>}
      <Button
        loading={decide.isPending && pendingKind === "rejected"}
        disabledReason={blocked}
        onClick={() => {
          if (!reason.trim()) setLocalErrors({ reason: "Enter a reason for rejecting." });
          else submit({ decision: "rejected", reason });
        }}
      >
        Reject
      </Button>

      <h3 style={{ font: "var(--text-h3)" }}>Edit the message</h3>
      <p>Saving creates a new version that still needs approval.</p>
      <label htmlFor={messageId} style={{ display: "block", font: "var(--text-label)" }}>Message</label>
      <textarea id={messageId} value={message} rows={4} style={{ width: "100%" }} aria-invalid={Boolean(errors.editedMessage)} aria-describedby={errors.editedMessage ? `${messageId}-error` : undefined} onChange={(e) => setMessage(e.target.value)} />
      {errors.editedMessage && <p id={`${messageId}-error`}>{errors.editedMessage}</p>}
      <Button loading={decide.isPending && pendingKind === "editRequired"} disabledReason={blocked} onClick={() => submit({ decision: "editRequired", editedMessage: message, reason })}>Save as new version</Button>
    </>
  );
}

function DecisionFacts({ version }: { version: ApprovalVersion }) {
  const rows: [string, string][] = [
    ["Decision", version.decision ?? "None recorded"],
    ["Decided by role", version.decidedByRole ?? "None"],
    ["Decided at", version.decidedAt ? dateTime(version.decidedAt) : "Not decided"],
    ["Reason", version.reason ?? "None given"],
    ["Decision receipt", version.decisionReceiptRef ?? "None"],
  ];
  return (
    <dl>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt style={{ font: "var(--text-label)" }}>{label}</dt>
          <dd style={{ margin: "0 0 var(--space-2)" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function History({ data }: { data: ApprovalDetail }) {
  return (
    <>
      <h2 style={{ font: "var(--text-h2)" }}>Approval history</h2>
      <ol>
        {data.versions.map((v) => (
          <li key={v.version} style={{ padding: "var(--space-1) 0" }}>
            {v.version}: {v.decision ?? "no decision"}{v.decidedAt ? `, ${dateTime(v.decidedAt)}` : ""} · <Link to={`?version=${v.version}`} aria-label={`View historical approval ${v.version}`}>View historical approval</Link>
          </li>
        ))}
      </ol>
      <p><Link to=".">Back to current approval</Link></p>
    </>
  );
}

function HistoricalVersion({ data, version }: { data: ApprovalDetail; version: string }) {
  const record = data.versions.find((v) => v.version === version);
  if (!record)
    return (
      <div role="alert">
        <h2 style={{ font: "var(--text-h2)" }}>Version not found</h2>
        <p>This approval has no version {version}.</p>
        <p><Link to="?view=history">Approval history</Link></p>
      </div>
    );
  return (
    <>
      <h2 style={{ font: "var(--text-h2)" }}>Version {record.version}</h2>
      <p role="note">Historical record. It's read-only and grants no new authority.</p>
      <PayloadView payload={record.payload} policyVersion={record.policyVersion} offerVersion={record.offerVersion} />
      <DecisionFacts version={record} />
      <p>{record.slackPermalink ? <a href={record.slackPermalink}>Open in Slack</a> : "No Slack link is available for this version."}</p>
      <p><Link to="?view=history">Approval history</Link></p>
    </>
  );
}
