import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { ReadState } from "@/components/ReadState";
import { ViewError } from "@/components/ViewError";
import { HourlyRunPage } from "@/features/monitor/HourlyRunPage";
import { ActionError, Details, EXECUTION_LABELS, HistoricalNote, SourceDialog, blockedReason, dateTime } from "./shared";
import type { ControlPayload, ReconcilePayload, RunCounts, RunDetail } from "./types";
import { nativeRunViewSchema, type NativeRunView } from "@/creator-agent/actions/views";
import { NativeRunPage } from "./NativeRunPage";
import { safeRuntimeRunSchema, type SafeRuntimeRun } from "@/creator-agent/jobs/runtimeViews";
import { RuntimeRunPage } from "./RuntimeRunPage";
import styles from "./Approvals.module.css";

type Res = ReadResponse<RunDetail>;
type Tab = "approval" | "recovery";
const COUNT_LABELS: Record<keyof RunCounts, string> = { confirmed: "Confirmed", failed: "Failed", held: "Held", unsent: "Unsent", paused: "Paused", uncertain: "Unknown outcome" };

/**
 * Agent run approval (5:13) and unknown-outcome recovery (5:156), owner THO-296.
 * The tabless path is the hourly monitor variant (25:307, THO-299).
 */
export function RunPage() {
  const [search] = useSearchParams();
  const { runId } = useParams();
  const tab = search.get("tab");
  if (runId?.startsWith("rt-run-") && tab !== "recovery") return <Run tab="approval" />;
  if (tab !== "approval" && tab !== "recovery") return <HourlyRunPage />;
  return <Run tab={tab} />;
}

function Run({ tab }: { tab: Tab }) {
  const { adapter } = useScope();
  const { runId = "" } = useParams();
  const filters = useMemo(() => ({ runId }), [runId]);
  const query = useView<{ runId: string }, RunDetail | NativeRunView | SafeRuntimeRun>("runDetail", filters);
  const raw = query.data?.data ?? null;
  const data = raw && !("kind" in raw) ? raw : null;
  const source = data?.source ?? "";
  const uncertain = data?.state === "outcomeUncertain";
  const control = useAction<ControlPayload>();
  const [dialog, setDialog] = useState<"source" | "slack" | "takeover" | null>(null);
  const pause = () => data && control.mutate({ operation: "controlRun", actionKind: "pauseRun", entityRefs: [], expectedVersion: data.version, approvalRef: data.approvalRef, manifestRef: null, runRef: data.runRef, payload: { control: "pause" } });

  if (raw && "kind" in raw) {
    if (raw.kind === "registered-runtime-run") {
      const parsed = safeRuntimeRunSchema.safeParse(raw);
      if (!parsed.success) return <section><h1>Run unavailable</h1><p role="alert">The registered run response did not match its contract. No action is available.</p></section>;
      return <>{query.isError && <ViewError error={query.error} subject="This run" hasPriorData onRetry={() => void query.refetch()} />}<RuntimeRunPage res={{ ...query.data!, data: parsed.data,
        ...(query.isError || query.isFetching ? { dataState: "stale" as const } : {}) }} tab={tab} refresh={() => void query.refetch()} /></>;
    }
    const parsed = nativeRunViewSchema.safeParse(raw);
    if (!parsed.success) return <section><h1>Run unavailable</h1><p role="alert">The native run response did not match its contract. No action is available.</p></section>;
    return <>{query.isError && <ViewError error={query.error} subject="This run" hasPriorData onRetry={() => void query.refetch()} />}<NativeRunPage res={{ ...query.data!, data: parsed.data, ...(query.isError || query.isFetching ? { dataState: "stale" as const } : {}) }} tab={tab} refresh={() => void query.refetch()} /></>;
  }

  return (
    <section aria-labelledby="run-title" data-figma-source={tab === "approval" ? "5:13" : "5:156"} className={styles.page}>
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          <h1 id="run-title">{!data ? "Agent run" : tab === "approval" ? `${source}, step by step.` : "Confirm before trying again."}</h1>
          {data && (
            <p>
              {tab === "approval"
                ? `The browser agent works in ${source}. Zapier coordinates each handoff.`
                : uncertain ? `${source} did not return a reliable confirmation after the send action.` : "This run has no unresolved outcome."}
            </p>
          )}
        </div>
        {data && tab === "approval" && (
          <>
            <Button variant="secondary" style={{ minWidth: 160 }} aria-haspopup="dialog" onClick={() => setDialog("source")}>Open source</Button>
            <div><Button style={{ minWidth: 160 }} loading={control.isPending} disabledReason={blockedReason(query.data as Res, "pauseRun")} onClick={pause}>Pause run</Button></div>
          </>
        )}
        {data && tab === "recovery" && (
          <>
            <Button variant="secondary" style={{ minWidth: 160 }} aria-haspopup="dialog" onClick={() => setDialog("takeover")}>Open session</Button>
            <Button style={{ minWidth: 160 }} aria-haspopup="dialog" onClick={() => setDialog("takeover")}>Take over</Button>
          </>
        )}
      </div>
      <nav aria-label="Automation sections" className={styles.subnav}>
        <LinkButton to="/automations" aria-current="true" style={{ minWidth: 116 }}>Agent runs</LinkButton>
        <LinkButton to="/automations?tab=zaps" variant="ghost" style={{ minWidth: 112 }}>Zaps</LinkButton>
        <LinkButton to="/settings/connections" variant="ghost" style={{ minWidth: 124 }}>Connections</LinkButton>
        <LinkButton to="/automations?tab=reporting" variant="ghost" style={{ minWidth: 112 }}>Reporting</LinkButton>
      </nav>
      <ReadState res={query.data} subject="This run" />
      {query.isPending && <p role="status">Loading run…</p>}
      {query.isError && <ViewError error={query.error} subject="This run" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} parent={<p><Link to="/runs">Back to runs</Link></p>} />}
      {data && (
        <>
          {data.historicalNote && (
            <HistoricalNote title="Historical execution example" note={data.historicalNote}>
              <LinkButton variant="secondary" to="/offers/demo-offer" style={{ minWidth: 208.5 }}>Current affiliate terms</LinkButton>
              <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
            </HistoricalNote>
          )}
          {data.pausedAt && <p data-testid="pause-ack" className={styles.small}>Pause acknowledged by the server {dateTime(data.pausedAt)}. It covers unsent work only; confirmed actions stay on record.</p>}
          {control.error && <ActionError error={control.error} />}
          {tab === "approval" ? <ApprovalTab data={data} onSlack={() => setDialog("slack")} /> : <RecoveryTab res={query.data as Res} data={data} onPause={pause} pausing={control.isPending} />}
          {data.items.length > 1 && <Items data={data} />}
          {adapter.kind === "demo" && <p className={styles.small}>
            {tab === "approval"
              ? "Proposed browser workflow · source compatibility and execution are not yet validated · no messages sent by this design."
              : "Recovery proposal · deterministic result states must be implemented and tested before live browser execution."}
          </p>}
        </>
      )}
      <SourceDialog open={dialog === "source" || dialog === "slack"} title="Continue in the owning tool." url={null} onClose={() => setDialog(null)} />
      <Dialog open={dialog === "takeover"} title="Hand control to an authorized operator" onClose={() => setDialog(null)}>
        <p>The browser task pauses at login, MFA or a changed native screen. The operator restores the session or verifies the correct action before the agent resumes.</p>
        <p>No success is inferred from a timeout. Preserve the current record and approved terms, then recheck source state before continuing.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
        <LinkButton to="/settings/capabilities">Review channel access</LinkButton>
      </Dialog>
    </section>
  );
}

function ApprovalTab({ data, onSlack }: { data: RunDetail; onSlack: () => void }) {
  return (
    <>
      <div className={styles.contextRow} style={{ gap: "var(--space-16)" }}>
        <span role="status" data-testid="run-status" style={{ display: "contents" }}><Badge tone={data.state === "succeeded" ? "success" : "violet"} width={160}>{EXECUTION_LABELS[data.state]}</Badge></span>
        <p className={styles.small} data-testid="run-attempt">RUN {data.displayId} · Collaboration {data.collaboration} · {data.handle} · {data.environment === "demo" ? "Demo execution" : "Execution"}{data.attempt > 1 ? ` · Attempt ${data.attempt}` : ""}</p>
      </div>
      <div className={styles.runColumns}>
        <section className={`${styles.card} ${styles.stepsCard}`} aria-labelledby="steps-title">
          <h2 id="steps-title" className={styles.h2}>From brief to a confirmed send</h2>
          <p className={styles.small}>A source result completes the step. A click alone does not.</p>
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {data.steps.map((step, i) => <Step key={step.title} n={i + 1} title={step.title} note={step.note} status={step.status} />)}
          </ol>
        </section>
        <div className={styles.sideColumn}>
          <section className={`${styles.card} ${styles.preview}`} aria-labelledby="preview-title">
            <Badge tone="warning" width={180}>Revision {data.revision} · pending</Badge>
            <h2 id="preview-title" className={styles.h2}>Ready for a human decision</h2>
            <p className={styles.small}>Exact action: send a brief to {data.handle} in {data.source}.</p>
            <p className={styles.message}>{data.previewMessage}</p>
            <hr className={styles.divider} />
            <p className={styles.small}>Draft example only. Changed text, terms or recipient invalidates the previous approval.</p>
            <Button className={styles.fullButton} aria-haspopup="dialog" onClick={onSlack}>View historical approval in Slack</Button>
            <Link to={`/approvals/${data.approvalRef}`} className="visually-hidden-focusable">Open approval {data.approvalRef}</Link>
          </section>
          <section className={styles.card} style={{ gap: "var(--space-16)" }} aria-labelledby="source-title">
            <h2 id="source-title" className={styles.h2}>Inside {data.source}</h2>
            <Details rows={data.sourceDetails.map((d) => [d.label, d.value])} />
            <p className={styles.small}>Account connection and platform workflow testing happen before enabling live runs.</p>
            <LinkButton variant="secondary" to="/settings/connections" className={styles.fullButton}>View connection setup</LinkButton>
          </section>
        </div>
      </div>
      <section className={styles.card} style={{ gap: "var(--space-16)" }} aria-labelledby="stages-title">
        <h2 id="stages-title" className={styles.h2}>One collaboration, through completion</h2>
        <ol className={styles.stages}>
          {data.stages.map((stage, i) => (
            <li key={stage} className={styles.stage} aria-current={stage === data.currentStage ? "step" : undefined}>
              <span className={styles.stageNumber}>{String(i + 1).padStart(2, "0")}</span>
              {stage}
            </li>
          ))}
        </ol>
        <p className={styles.small}>Shipping is handed to Operations. Pay requires a founder decision. Closure records the delivered content, payment outcome and usage-rights expiry.</p>
      </section>
    </>
  );
}

function Step({ n, title, note, status }: { n: number; title: string; note: string; status: string }) {
  const tone = status === "Complete" ? styles.statusComplete : status === "Waiting" ? styles.statusWaiting : "";
  return (
    <li className={styles.step}>
      <p className={styles.stepNumber}>{String(n).padStart(2, "0")}</p>
      <div className={styles.stepBody}>
        <p className={styles.label}>{title}</p>
        <p className={styles.small}>{note}</p>
      </div>
      <p className={`${styles.small} ${tone}`}>{status}</p>
    </li>
  );
}

const PAUSE_STATES: [string, string, string][] = [
  ["Session expired", "Stop before submitting; preserve the task context.", "Reconnect in the source service"],
  ["Page changed", "Stop if the target control or record cannot be verified.", "Inspect the page and resume"],
  ["Approval changed", "Discard the previous execution permission.", "Approve the current revision"],
  ["Rate limited", "Wait for the permitted time; keep duplicate protection.", "Review repeated failures"],
  ["Payment pending", "Create a draft; do not mark payment as completed.", "Founder approves; QBO confirms"],
];

function RecoveryTab({ res, data, onPause, pausing }: { res: Res; data: RunDetail; onPause: () => void; pausing: boolean }) {
  const { adapter } = useScope();
  const reconcile = useAction<ReconcilePayload>();
  const send = (request: ReconcilePayload["request"]) =>
    reconcile.mutate({ operation: "reconcileRun", actionKind: request, entityRefs: [], expectedVersion: data.version, approvalRef: data.approvalRef, manifestRef: null, runRef: data.runRef, payload: { request } });
  const pending = (request: ReconcilePayload["request"]) => reconcile.isPending && reconcile.variables?.payload.request === request;
  const uncertain = data.state === "outcomeUncertain";
  const { result, evidence } = data.reconciliation;
  const receipt = data.items.find((i) => i.receiptRef)?.receiptRef ?? null;

  return (
    <>
      {uncertain && (
        <div role="alert" className={styles.alertBox}>
          <h2 className={styles.h2}>The message may already be sent.</h2>
          <p>This run is paused. Check the source conversation for the approved message before authorizing another attempt.</p>
        </div>
      )}
      <div className={styles.runColumns}>
        <section className={`${styles.card} ${styles.checklistCard}`} aria-labelledby="resolve-title">
          <h2 id="resolve-title" className={styles.h2}>Resolve the result</h2>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-16)" }}>
            <Step n={1} title="Reopen the same collaboration" note={`Verify ${data.handle} and ${data.collaboration} before reading the thread.`} status="Required" />
            <Step n={2} title={`Compare against approved revision ${data.revision}`} note="Match final text and recipient. Check for a source timestamp." status="Required" />
            <Step n={3} title="Choose the observed result" note="Confirmed sent → complete. Confirmed absent → request retry." status="Required" />
            <Step n={4} title="Keep ambiguous results paused" note="Escalate for human takeover. Do not infer failure from timeout." status="Required" />
          </ol>
          {uncertain && (
            <>
              <div className={styles.evidence}>
                <Button variant="secondary" loading={pending("lookup")} disabledReason={blockedReason(res, "lookup")} onClick={() => send("lookup")}>Check the source</Button>
                <div data-testid="reconciliation" className={styles.small}>
                  {result === "notChecked" && <p>Not checked yet.</p>}
                  {result === "stillUnknown" && <p>The source shows no evidence either way. Keep this paused and escalate to the account owner.</p>}
                  {result === "confirmedNotExecuted" && <p>The source shows the earlier attempt never ran.</p>}
                  {result === "sourceReceiptFound" && evidence && <p>Source receipt {evidence.receiptRef} found: {evidence.provider}, account {evidence.accountId}, {evidence.identity}, observed {dateTime(evidence.observedAt)}.{adapter.kind === "demo" ? " Synthetic demo evidence." : ""}</p>}
                </div>
              </div>
              <div className={styles.controls}>
                <div className={styles.controlRecord}><Button loading={pending("recordConfirmedSent")} disabledReason={blockedReason(res, "recordConfirmedSent")} onClick={() => send("recordConfirmedSent")}>Record confirmed sent</Button></div>
                <div className={styles.controlFresh}><Button variant="secondary" loading={pending("freshAttempt")} disabledReason={blockedReason(res, "freshAttempt")} onClick={() => send("freshAttempt")}>Request a fresh attempt</Button></div>
                <div className={styles.controlPaused}><Button variant="ghost" loading={pausing} disabledReason={data.pausedAt ? "Already paused." : blockedReason(res, "pauseRun")} onClick={onPause}>Keep paused</Button></div>
              </div>
              {reconcile.error && <ActionError error={reconcile.error} />}
            </>
          )}
                  </section>
        <section className={`${styles.card} ${styles.receipt}`} aria-labelledby="receipt-title">
          <div role="status" data-testid="run-status" className={styles.statusRow}><Badge tone={data.state === "succeeded" ? "success" : "warning"} width={180}>{EXECUTION_LABELS[data.state]}</Badge></div>
          <h2 id="receipt-title" className={styles.h2}>{uncertain ? "Approved, then interrupted" : "Reconciled"}</h2>
          <div className={styles.sideColumn}>
            <Details rows={[
              ["Recipient", data.handle],
              ["Revision", `${data.revision} · unchanged`],
              ["Decision", data.decisionLabel],
              ["Last event", data.lastEvent],
              ["Source receipt", receipt ?? "Not confirmed"],
              ...(data.attempt > 1 ? [["Attempt", String(data.attempt)] as [string, string]] : []),
            ]} />
          </div>
          <hr className={styles.divider} />
          <p className={styles.small}>Evidence is limited to the action, record key, timestamp and redacted outcome. Passwords and private customer details are excluded.</p>
          <LinkButton variant="secondary" to={`/approvals/${data.approvalRef}?view=history`} className={styles.fullButton}>View approval history</LinkButton>
        </section>
      </div>
      <section className={styles.card} aria-labelledby="pauses-title">
        <h2 id="pauses-title" className={styles.h2}>Every pause has a next step</h2>
        <div className={styles.scroll} role="region" aria-label="Recovery states" tabIndex={0}>
          <table className={styles.pauseTable}>
            <thead><tr><th scope="col">STATE</th><th scope="col">WHAT THE AGENT DOES</th><th scope="col">HUMAN ACTION</th></tr></thead>
            <tbody>{PAUSE_STATES.map(([state, agent, human]) => <tr key={state}><td>{state}</td><td>{agent}</td><td>{human}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Items({ data }: { data: RunDetail }) {
  const total = Object.values(data.counts).reduce((s, n) => s + n, 0);
  return (
    <section className={styles.card} aria-labelledby="items-title">
      <h2 id="items-title" className={styles.h2}>Items ({total})</h2>
      <p data-testid="run-counts" style={{ margin: 0 }}>
        {(Object.keys(COUNT_LABELS) as (keyof RunCounts)[]).filter((k) => data.counts[k] > 0).map((k) => `${COUNT_LABELS[k]}: ${data.counts[k]}`).join(" · ")}
      </p>
      <div className={styles.scroll} role="region" aria-label="Run items" tabIndex={0}>
        <table>
          <caption className="visually-hidden">Outcome of each item in this run</caption>
          <thead><tr><th scope="col">Recipient</th><th scope="col">Outcome</th><th scope="col">Source receipt</th><th scope="col">Reason</th></tr></thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.itemId}>
                <td>{i.recipient.sourceId ?? "Unknown"}</td>
                <td>{COUNT_LABELS[i.state]}</td>
                <td>{i.receiptRef ?? "None"}</td>
                <td>{i.reasonCode ?? "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
