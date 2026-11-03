import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Button } from "@/components/Button";
import { ViewError } from "@/components/ViewError";
import { RoutePlaceholder } from "@/routes/RoutePlaceholder";
import { ActionError, EXECUTION_LABELS, blockedReason, dateTime } from "./shared";
import type { ControlPayload, ReconcilePayload, RunCounts, RunDetail } from "./types";

type Res = ReadResponse<RunDetail>;
const COUNT_LABELS: Record<keyof RunCounts, string> = { confirmed: "Confirmed", failed: "Failed", held: "Held", unsent: "Unsent", paused: "Paused", uncertain: "Unknown outcome" };

/**
 * Agent run approval (5:13) and unknown-outcome recovery (5:156), owner THO-296.
 * The tabless path is the hourly monitor variant (25:307, THO-299), which isn't built yet.
 * BEHAVIOR SLICE ONLY: the layout and visuals are PENDING Figma intake; no fidelity is claimed.
 */
export function RunPage() {
  const [search] = useSearchParams();
  const tab = search.get("tab");
  if (tab !== "approval" && tab !== "recovery") return <RoutePlaceholder path="/runs/:runId" />;
  return <Run tab={tab} />;
}

function Run({ tab }: { tab: "approval" | "recovery" }) {
  const { runId = "" } = useParams();
  const filters = useMemo(() => ({ runId }), [runId]);
  const query = useView<{ runId: string }, RunDetail>("runDetail", filters);
  const title = tab === "approval" ? "Agent run approval" : "Unknown-outcome recovery";
  return (
    <section aria-labelledby="run-title" data-figma-source={tab === "approval" ? "5:13" : "5:156"}>
      <h1 id="run-title" style={{ font: "var(--text-h1)", marginTop: 0 }}>{title}</h1>
      <nav aria-label="Run sections">
        <Link to="?tab=approval" aria-current={tab === "approval" ? "page" : undefined}>Approval</Link>{" · "}
        <Link to="?tab=recovery" aria-current={tab === "recovery" ? "page" : undefined}>Recovery</Link>
      </nav>
      {query.isPending && <p role="status">Loading run…</p>}
      {query.isError && <ViewError error={query.error} subject="This run" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} parent={<p><Link to="/runs">Back to runs</Link></p>} />}
      {query.data?.data && <Body res={query.data as Res} data={query.data.data} tab={tab} />}
    </section>
  );
}

function Body({ res, data, tab }: { res: Res; data: RunDetail; tab: "approval" | "recovery" }) {
  const control = useAction<ControlPayload>();
  const send = (request: ControlPayload["control"]) =>
    control.mutate({ operation: "controlRun", actionKind: "pauseRun", entityRefs: [], expectedVersion: data.version, approvalRef: data.approvalRef, manifestRef: null, payload: { runRef: data.runRef, control: request } });
  return (
    <>
      <p role="status" data-testid="run-status"><strong>{EXECUTION_LABELS[data.state]}</strong> · Attempt {data.attempt} · Mode: {data.mode} · Environment: {data.environment}</p>
      {data.pausedAt && <p data-testid="pause-ack">Pause acknowledged by the server {dateTime(data.pausedAt)}. It covers unsent work only; confirmed actions stay on record.</p>}
      {tab === "approval" ? <ApprovalTab res={res} data={data} onPause={() => send("pause")} pausing={control.isPending} /> : <RecoveryTab res={res} data={data} onPause={() => send("pause")} pausing={control.isPending} />}
      {control.error && <ActionError error={control.error} />}
      <Items data={data} />
      <p style={{ font: "var(--text-small)" }}>Job {data.jobId} ({data.jobVersion}) · Trigger: {data.trigger} · Reference: {data.correlationId}</p>
    </>
  );
}

function ApprovalTab({ res, data, onPause, pausing }: { res: Res; data: RunDetail; onPause: () => void; pausing: boolean }) {
  return (
    <>
      <h2 style={{ font: "var(--text-h2)" }}>Approval</h2>
      <p><Link to={`/approvals/${data.approvalRef}`}>Open approval {data.approvalRef}</Link></p>
      <p>No Slack link is available for this approval.</p>
      <Button variant="secondary" loading={pausing} disabledReason={blockedReason(res, "pauseRun")} onClick={onPause}>Pause run</Button>
    </>
  );
}

function RecoveryTab({ res, data, onPause, pausing }: { res: Res; data: RunDetail; onPause: () => void; pausing: boolean }) {
  const { adapter } = useScope();
  const reconcile = useAction<ReconcilePayload>();
  const send = (request: ReconcilePayload["request"]) =>
    reconcile.mutate({ operation: "reconcileRun", actionKind: request, entityRefs: [], expectedVersion: data.version, approvalRef: data.approvalRef, manifestRef: null, payload: { runRef: data.runRef, request } });
  const pending = (request: ReconcilePayload["request"]) => reconcile.isPending && reconcile.variables?.payload.request === request;
  const uncertain = data.state === "outcomeUncertain";
  const { result, evidence } = data.reconciliation;

  return (
    <>
      <h2 style={{ font: "var(--text-h2)" }}>Recovery</h2>
      {!uncertain && <p>This run has no unresolved outcome.</p>}
      {uncertain && (
        <>
          <p role="alert">The source may or may not have applied this action. Nothing can be retried until that is settled.</p>
          <Button variant="secondary" loading={pending("lookup")} disabledReason={blockedReason(res, "lookupSource")} onClick={() => send("lookup")}>Check the source</Button>
          <div data-testid="reconciliation">
            {result === "notChecked" && <p>Not checked yet.</p>}
            {result === "stillUnknown" && <p>The source shows no evidence either way. Keep this paused and escalate to the account owner.</p>}
            {result === "confirmedNotExecuted" && <p>The source shows the earlier attempt never ran.</p>}
            {result === "sourceReceiptFound" && evidence && <p>Source receipt {evidence.receiptRef} found: {evidence.provider}, account {evidence.accountId}, {evidence.identity}, observed {dateTime(evidence.observedAt)}.{adapter.kind === "demo" ? " Synthetic demo evidence." : ""}</p>}
          </div>
          <Button loading={pending("recordConfirmedSent")} disabledReason={blockedReason(res, "recordConfirmedSent")} onClick={() => send("recordConfirmedSent")}>Record confirmed sent</Button>{" "}
          <Button variant="secondary" loading={pending("freshAttempt")} disabledReason={blockedReason(res, "requestFreshAttempt")} onClick={() => send("freshAttempt")}>Request a fresh attempt</Button>{" "}
          <Button variant="secondary" loading={pausing} disabledReason={data.pausedAt ? "Already paused." : blockedReason(res, "pauseRun")} onClick={onPause}>Keep paused</Button>
          {reconcile.error && <ActionError error={reconcile.error} />}
        </>
      )}
      <p><Link to={`/approvals/${data.approvalRef}?view=history`}>View approval history</Link></p>
    </>
  );
}

function Items({ data }: { data: RunDetail }) {
  const total = Object.values(data.counts).reduce((s, n) => s + n, 0);
  return (
    <>
      <h2 style={{ font: "var(--text-h2)" }}>Items ({total})</h2>
      <p data-testid="run-counts">
        {(Object.keys(COUNT_LABELS) as (keyof RunCounts)[]).filter((k) => data.counts[k] > 0).map((k) => `${COUNT_LABELS[k]}: ${data.counts[k]}`).join(" · ")}
      </p>
      <div style={{ overflowX: "auto" }} role="region" aria-label="Run items" tabIndex={0}>
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
    </>
  );
}
