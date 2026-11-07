import { useId, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { ReadState } from "@/components/ReadState";
import { ViewError } from "@/components/ViewError";
import { ActionError, Details, EXECUTION_LABELS, HistoricalNote, LeaveGuard, SourceDialog, TermsView, blockedReason, dateTime, payloadChanges } from "./shared";
import type { ApprovalDetail, ApprovalStatus, ApprovalVersion, DecidePayload } from "./types";
import { nativeApprovalViewSchema, type NativeApprovalView } from "@/creator-agent/actions/views";
import { NativeApprovalPage } from "./NativeApprovalPage";
import styles from "./Approvals.module.css";

const STATUS: Record<ApprovalStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "Pending", tone: "warning" },
  approved: { label: "Approved, awaiting dispatch", tone: "violet" },
  rejected: { label: "Rejected", tone: "neutral" },
  editRequired: { label: "Edit requested", tone: "warning" },
  expired: { label: "Expired", tone: "danger" },
  canceled: { label: "Canceled", tone: "neutral" },
};

const expiry = (iso: string) => {
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", ...options }).format(new Date(iso));
  return `${part({ day: "numeric", month: "short" })} · ${part({ hour: "2-digit", minute: "2-digit", hour12: false })} PT`;
};

type Res = ReadResponse<ApprovalDetail>;

/** Approval detail (Figma source 6:234, owner THO-296), with history (CTRL-026 to CTRL-028). */
export function ApprovalPage() {
  const { approvalId = "" } = useParams();
  const [search] = useSearchParams();
  const { adapter } = useScope();
  const versionQuery = search.get("version"), beforeQuery = search.get("beforeVersion"), historyQuery = search.get("view") === "history";
  const filters = useMemo(() => {
    const version = (value: string) => /^v?[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.replace(/^v/, ""))) ? Number(value.replace(/^v/, "")) : 0;
    return { approvalId, ...(adapter.kind !== "demo" ? {
      ...(versionQuery !== null ? {manifestVersion:version(versionQuery)} : {}),
      ...(historyQuery || versionQuery !== null ? {history:true} : {}),
      ...(beforeQuery !== null ? {beforeVersion:version(beforeQuery)} : {}),
    } : {}) };
  }, [approvalId, adapter.kind, versionQuery, historyQuery, beforeQuery]);
  const query = useView<typeof filters, ApprovalDetail | NativeApprovalView>("approvalDetail", filters);
  const requestedVersion = search.get("version");
  const showHistory = search.get("view") === "history";
  const data = query.data?.data ?? null;
  // Native data never passes through the legacy creator-message projection.
  if (data && "kind" in data) {
    const parsed = nativeApprovalViewSchema.safeParse(data);
    if (!parsed.success) return <section><h1>Approval unavailable</h1><p role="alert">The native approval response did not match its contract. No action is available.</p></section>;
    return <>{query.isError && <ViewError error={query.error} subject="This approval" hasPriorData onRetry={() => void query.refetch()} />}<NativeApprovalPage res={{ ...query.data!, data: parsed.data, ...(query.isError || query.isFetching ? { dataState: "stale" as const } : {}) }} refresh={() => void query.refetch()} /></>;
  }
  const prior = data ? [...data.versions].reverse().find((v) => v.decision)?.version ?? data.currentVersion : null;

  return (
    <section aria-labelledby="approval-title" data-figma-source="6:234" className={styles.page}>
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          <h1 id="approval-title">A human decision. A precise action.</h1>
          <p>Approval queue · creator messages stay blocked until the exact action is approved.</p>
        </div>
        {data && <LinkButton variant="secondary" to="?view=history" style={{ minWidth: 172 }}>Approval history</LinkButton>}
        {data && <LinkButton to={`?version=${prior}`} className={styles.tight} style={{ minWidth: 166 }}>View historical approval</LinkButton>}
      </div>
      <ReadState res={query.data} subject="This approval" />
      {query.isPending && <p role="status">Loading approval…</p>}
      {query.isError && (
        <ViewError error={query.error} subject="This approval" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} parent={<p><Link to="/approvals">Back to approvals</Link></p>} />
      )}
      {data &&
        (requestedVersion ? (
          <HistoricalVersion data={data} version={requestedVersion} />
        ) : showHistory ? (
          <History data={data} />
        ) : (
          <Current res={query.data as Res} data={data} priorVersion={prior!} />
        ))}
    </section>
  );
}

function Current({ res, data, priorVersion }: { res: Res; data: ApprovalDetail; priorVersion: string }) {
  const { adapter } = useScope();
  const decide = useAction<DecidePayload>();
  const dispatch = useAction<Record<string, never>>();
  const [reviewedVersion, setReviewedVersion] = useState(data.currentVersion);
  const [sourceDialog, setSourceDialog] = useState<"slack" | "notion" | null>(null);
  const current = data.versions[data.versions.length - 1]!;
  const reviewed = data.versions.find((v) => v.version === reviewedVersion);
  const changes = reviewed && reviewed.version !== current.version && reviewed.decision === null ? payloadChanges(reviewed.payload, current.payload) : [];
  const uncertain = data.execution?.state === "outcomeUncertain";
  const canSend = res.capabilities.some((c) => c.actionKind === "dispatchApprovedAction");
  const sent = Boolean(data.execution?.receiptRefs.length);
  const status = STATUS[data.status];
  const recipients = current.payload.recipients.map((r) => r.sourceId ?? "Unknown").join(", ");

  return (
    <>
      {data.historicalNote && (
        <HistoricalNote title="Historical approval snapshot" note={data.historicalNote}>
          <LinkButton variant="secondary" to="/offers/demo-offer" style={{ minWidth: 208.5 }}>Current affiliate terms</LinkButton>
          <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>
        </HistoricalNote>
      )}
      <div className={styles.contextRow}>
        <span role="status" data-testid="approval-status" style={{ display: "contents" }}>
          <Badge tone={data.execution ? (sent ? "success" : "warning") : status.tone} width={104}>{data.execution ? EXECUTION_LABELS[data.execution.state] : status.label}</Badge>
        </span>
        <span className={styles.contextId}>{data.displayId}</span>
        <span className={styles.contextText} aria-hidden="true">·</span>
        <span className={styles.contextText}>{data.source} / {recipients}</span>
        <span className={styles.contextSpace} />
        {!sent && <Badge tone="warning" width={176}>Outbound blocked</Badge>}
      </div>
      <div className={styles.approvalColumns}>
        <aside className={styles.queue} aria-labelledby="queue-title">
          <h2 id="queue-title" className={styles.h2}>Needs a decision</h2>
          <p className={styles.small}>{data.queueLabel}</p>
          <ul>
            {data.queue.map((item) => {
              const selected = item.approvalRef === data.approvalRef;
              return (
                <li key={item.approvalRef}>
                  <Link to={`/approvals/${item.approvalRef}`} className={styles.queueItem} aria-current={selected ? "page" : undefined}>
                    <span className={styles.label}>{item.handle}</span>
                    <span className={styles.small}>{item.summary}</span>
                    <Badge tone={item.tone} width={166}>{selected ? `Selected · ${status.label.toLowerCase()}` : item.status}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
          <hr className={styles.divider} />
          <p className={styles.label}>Decide here or in Slack.</p>
          <p className={styles.small}>{"Decide here, or use approve, edit: <text>, or reject: <reason> in Slack. Direct content-fee payments need a founder; native commission billing has its own pre-commitment approval."}</p>
          <Button variant="secondary" className={styles.fullButton} aria-haspopup="dialog" onClick={() => setSourceDialog("slack")}>Open approval channel</Button>
        </aside>
        <section className={styles.card} aria-labelledby="selected-title">
          <div className={styles.titleBlock}>
            <div className={styles.titleText}>
              <h2 id="selected-title" className={styles.h2}>{data.title}</h2>
              <p className={styles.small}>{data.contextLine}</p>
            </div>
            <Badge tone="violet" width={120} testId="approval-version">Version {data.currentVersion.replace("v", "")}</Badge>
          </div>
          {changes.length > 0 && (
            <div role="alert" data-testid="version-changes" className={styles.panel}>
              <p className={styles.label}>Changed since you started reviewing</p>
              <ul style={{ margin: 0, paddingLeft: "var(--space-16)" }}>{changes.map((c) => <li key={c.field}>{c.field}: {c.from} → {c.to}</li>)}</ul>
              <p className={styles.small}>Your earlier decision was not applied. Review this version before deciding.</p>
              <Button variant="secondary" onClick={() => setReviewedVersion(data.currentVersion)}>Mark as reviewed</Button>
            </div>
          )}
          <Details columns={2} rows={[
            ["Recipient", recipients],
            ["Platform", data.platform],
            ["Action", data.actionName],
            ["Requested by", data.requestedBy],
            ["Reviewer", data.reviewer],
            ["Expires", expiry(data.expiresAt)],
          ]} />
          {!data.historicalNote && <TermsView payload={current.payload} policyVersion={current.policyVersion} offerVersion={current.offerVersion} />}
          <div className={styles.payload}>
            <p className={styles.payloadTitle}>Exact message to approve</p>
            {/* Rendered as text, never as markup: source and draft text is untrusted data. */}
            <p className={styles.message} data-testid="exact-message">{current.payload.message}</p>
            <hr className={styles.divider} />
            <p className={styles.payloadNote}>Payload {current.version} · approved text and recipient are locked together</p>
          </div>
          <div className={styles.safeguards}>
            <div><p className={styles.label}>Review the exact text</p><p className={styles.small}>An edited draft creates a new version and needs approval.</p></div>
            <div><p className={styles.label}>Send only after approval</p><p className={styles.small}>Browser execution must match the approved recipient and payload.</p></div>
            <div><p className={styles.label}>Confirm in the source</p><p className={styles.small}>A receipt is required before marking the action sent.</p></div>
          </div>
          <div className={styles.handoff}>
            <h3 className={styles.h3}>After approval</h3>
            <p>{data.executionPlan}</p>
            <Badge tone="warning" width={274}>{data.capabilityLabel}</Badge>
            <p className={styles.small}>If login, MFA, or platform access blocks the task, hand it to an operator. If the send result is unknown, reconcile the message history before retrying.</p>
          </div>
          {!data.historicalNote && (data.status === "pending" || data.status === "expired") && (
            <DecisionPanel key={current.version} res={res} data={data} current={current} decide={decide} />
          )}
          {/* A decision can land in Slack first. The refetch removes the panel, so its refusal has to show here. */}
          {decide.error && data.status !== "pending" && data.status !== "expired" && <ActionError error={decide.error} />}
          {data.status !== "pending" && data.status !== "expired" && !data.historicalNote && <DecisionFacts version={current} />}
          {data.status === "approved" && (canSend || data.execution) && (
            <div className={styles.panel}>
              <h3 className={styles.h3}>Send</h3>
              {!data.execution && <p>Approval authorizes this exact version. It isn't sent until the source returns a receipt.</p>}
              {!data.execution && (
                <Button loading={dispatch.isPending} disabledReason={blockedReason(res, "dispatchApprovedAction")} onClick={() => dispatch.mutate({ operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", entityRefs: [current.payload.creator], expectedVersion: data.currentVersion, approvalRef: data.approvalRef, manifestRef: data.manifestRef, payload: {} })}>
                  Send approved action
                </Button>
              )}
              {dispatch.error && <ActionError error={dispatch.error} />}
              {data.execution?.receiptRefs.map((r) => <p key={r} data-testid="source-receipt">Source receipt: {r}{adapter.kind === "demo" ? " (synthetic demo receipt, nothing was sent)" : ""}</p>)}
              {uncertain && <p role="alert">The source didn't confirm this send. Don't retry until the outcome is reconciled.</p>}
              {data.execution && <p><Link to={`/runs/${data.execution.runRef}?tab=${uncertain ? "recovery" : "approval"}`}>{uncertain ? "Open recovery" : "Open run"}</Link></p>}
            </div>
          )}
          <div className={styles.actionsRow}>
            <LinkButton to={`?version=${priorVersion}`} className={styles.actionButton}>View historical approval</LinkButton>
            <Button variant="secondary" className={styles.actionButton} aria-haspopup="dialog" onClick={() => setSourceDialog("notion")}>Open Notion record</Button>
            <span className={styles.actionsSpace} />
            <p className={styles.small}>{sent ? "Source receipt on file" : "No message has been sent"}</p>
          </div>
        </section>
      </div>
      <section className={`${styles.card} ${styles.timelineCard}`} aria-labelledby="timeline-title">
        <h2 id="timeline-title" className={styles.h2}>Decision timeline</h2>
        <ol className={styles.timeline}>
          {data.timeline.map((event) => (
            <li key={event.title}>
              <span className={styles.time}>{event.time}</span>
              <span className={styles.label}>{event.title}</span>
              <span className={styles.small}>{event.note}</span>
            </li>
          ))}
        </ol>
      </section>
      {adapter.kind === "demo" && <p className={styles.small}>Demo · sample approval and message · no live outreach or platform actions are performed.</p>}
      <SourceDialog open={sourceDialog !== null} title="Continue in the owning tool." url={sourceDialog === "slack" ? current.slackPermalink : null} onClose={() => setSourceDialog(null)} />
    </>
  );
}

/** In-app decisions sit alongside the Slack thread, a product decision that goes beyond Figma (docs/design-map.md). The server decides who may use this. */
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
    <div className={styles.panel}>
      <LeaveGuard dirty={dirty && !decide.isPending} />
      <h3 className={styles.h3}>Decide here</h3>
      <p className={styles.small}>You can also decide in the Slack thread. The first decision recorded wins, and this version is what gets approved.</p>
      {decide.error && <ActionError error={decide.error} />}
      <Button loading={decide.isPending && pendingKind === "approved"} disabledReason={blocked} onClick={() => submit({ decision: "approved" })}>Approve this version</Button>

      <label htmlFor={reasonId} className={styles.fieldLabel}>Reason</label>
      <textarea id={reasonId} className={styles.field} value={reason} rows={2} aria-invalid={Boolean(errors.reason)} aria-describedby={errors.reason ? `${reasonId}-error` : undefined} onChange={(e) => setReason(e.target.value)} />
      {errors.reason && <p id={`${reasonId}-error`} className={styles.fieldError}>{errors.reason}</p>}
      <Button
        variant="secondary"
        loading={decide.isPending && pendingKind === "rejected"}
        disabledReason={blocked}
        onClick={() => {
          if (!reason.trim()) setLocalErrors({ reason: "Enter a reason for rejecting." });
          else submit({ decision: "rejected", reason });
        }}
      >
        Reject
      </Button>

      <label htmlFor={messageId} className={styles.fieldLabel}>Message</label>
      <p className={styles.small}>Saving creates a new version that still needs approval.</p>
      <textarea id={messageId} className={styles.field} value={message} rows={4} aria-invalid={Boolean(errors.editedMessage)} aria-describedby={errors.editedMessage ? `${messageId}-error` : undefined} onChange={(e) => setMessage(e.target.value)} />
      {errors.editedMessage && <p id={`${messageId}-error`} className={styles.fieldError}>{errors.editedMessage}</p>}
      <Button variant="secondary" loading={decide.isPending && pendingKind === "editRequired"} disabledReason={blocked} onClick={() => submit({ decision: "editRequired", editedMessage: message, reason })}>Save as new version</Button>
    </div>
  );
}

function DecisionFacts({ version }: { version: ApprovalVersion }) {
  return (
    <Details rows={[
      ["Decision", version.decision ?? "None recorded"],
      ["Decided by role", version.decidedByRole ?? "None"],
      ["Decided at", version.decidedAt ? dateTime(version.decidedAt) : "Not decided"],
      ["Reason", version.reason ?? "None given"],
      ["Decision receipt", version.decisionReceiptRef ?? "None"],
    ]} />
  );
}

function History({ data }: { data: ApprovalDetail }) {
  return (
    <section className={styles.card} aria-labelledby="history-title">
      <h2 id="history-title" className={styles.h2}>Approval history</h2>
      <ol style={{ margin: 0, paddingLeft: "var(--space-16)" }}>
        {data.versions.map((v) => (
          <li key={v.version} style={{ padding: "var(--space-4) 0" }}>
            {v.version}: {v.decision ?? "no decision"}{v.decidedAt ? `, ${dateTime(v.decidedAt)}` : ""} · <Link to={`?version=${v.version}`} aria-label={`View historical approval ${v.version}`}>View historical approval</Link>
          </li>
        ))}
      </ol>
      <p style={{ margin: 0 }}><Link to=".">Back to current approval</Link></p>
    </section>
  );
}

function HistoricalVersion({ data, version }: { data: ApprovalDetail; version: string }) {
  const record = data.versions.find((v) => v.version === version);
  if (!record)
    return (
      <div role="alert" className={styles.card}>
        <h2 className={styles.h2}>Version not found</h2>
        <p style={{ margin: 0 }}>This approval has no version {version}.</p>
        <p style={{ margin: 0 }}><Link to="?view=history">Approval history</Link></p>
      </div>
    );
  return (
    <section className={styles.card} aria-labelledby="version-title">
      <h2 id="version-title" className={styles.h2}>Version {record.version}</h2>
      <p role="note" style={{ margin: 0 }}>Historical record. It's read-only and grants no new authority.</p>
      <TermsView payload={record.payload} policyVersion={record.policyVersion} offerVersion={record.offerVersion} />
      <div className={styles.payload}>
        <p className={styles.payloadTitle}>Exact message</p>
        <p className={styles.message} data-testid="exact-message">{record.payload.message}</p>
      </div>
      <DecisionFacts version={record} />
      <p style={{ margin: 0 }}>{record.slackPermalink ? <a href={record.slackPermalink}>Open in Slack</a> : "No Slack link is available for this version."}</p>
      <p style={{ margin: 0 }}><Link to="?view=history">Approval history</Link></p>
    </section>
  );
}
