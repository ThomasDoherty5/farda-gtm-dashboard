import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AdapterError } from "@/adapter/errors";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Field } from "@/components/Field";
import { Card, HandoffDialog, KpiCard, KpiGrid, ViewShell, useIsDemo } from "@/features/analytics/parts";
import type { HourlyRunData } from "@/fixtures/monitor";
import { DEMO_POST_ID } from "@/fixtures/monitor";
import a from "@/features/analytics/Analytics.module.css";
import m from "./Monitor.module.css";

type Evidence = HourlyRunData["evidence"][number];

/**
 * Hourly monitoring run (Figma source 25:307, owner THO-299, CTRL-019 to CTRL-022, CTRL-213). The run is a read-only trace:
 * schedule, next run and retry are snapshots, and nothing here sends or authorizes anything outbound.
 */
export function HourlyRunPage() {
  const { runId = "" } = useParams();
  const query = useView<{ runId: string }, HourlyRunData>("hourlyRun", { runId });
  const record = query.data?.data ?? null;
  return (
    <section aria-labelledby="run-title" data-figma-source="25:307" className={a.page}>
      {!record && <h1 id="run-title" style={{ font: "var(--text-h1)", margin: 0 }}>Hourly monitoring run</h1>}
      <ViewShell query={query} subject="The hourly run" emptyTitle="No run record" emptyBody="The source responded, but there is no run to show.">
        {(data) => <Run data={data} />}
      </ViewShell>
    </section>
  );
}

function Run({ data }: { data: HourlyRunData }) {
  const demo = useIsDemo();
  const retry = useAction<{ profile: string }>();
  const evidenceRef = useRef<HTMLHeadingElement>(null);
  const [dialog, setDialog] = useState<"reconnect" | "suggestion" | null>(null);
  const [row, setRow] = useState<Evidence | null>(null);
  const failed = data.profiles.failed;
  const unavailableSessions = failed ? 1 : 0;
  const retryError = retry.error instanceof AdapterError ? retry.error : null;
  const submit = () => failed && retry.mutate({ operation: "controlRun", actionKind: "retryMonitorProfile", entityRefs: [], expectedVersion: data.version, approvalRef: null, manifestRef: null, payload: { profile: failed.handle } });
  const act = (e: Evidence) => {
    if (e.kind === "reconnect") setDialog("reconnect");
    else if (e.kind === "suggestion" || e.kind === "delivery") { setRow(e); setDialog("suggestion"); }
  };
  return (
    <>
      <div className={a.titleRow}>
        <div className={a.heading}>
          <h1 id="run-title">Every hourly check leaves evidence.</h1>
          <p>Review new posts, conversation changes and partial failures before the next run.</p>
        </div>
        <LinkButton variant="secondary" to="/content" style={{ minWidth: 176 }}>Back to monitor</LinkButton>
        <Button style={{ minWidth: 184 }} onClick={() => { evidenceRef.current?.scrollIntoView?.({ block: "start" }); evidenceRef.current?.focus(); }}>Review {data.statusReviews} changes</Button>
      </div>
      <section className={a.notice} style={{ background: "var(--color-violetSoft)", border: "1px solid var(--color-border)" }} aria-label="Current acquisition policy">
        <p className={a.label}>Hourly monitoring run</p>
        <p className={a.small}>This run checks enrolled profiles, posts and inbox updates. It does not discover new prospects or send unsolicited outreach. Daily sourcing has its own permitted-capacity plan.</p>
        <div className={a.actions} style={{ gap: 10 }}>
          <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
          <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 209 }}>Full acquisition funnel</LinkButton>
        </div>
      </section>
      <div className={m.ctx}>
        <Badge tone="violet" width={200}>{demo ? "Simulated hourly run" : "Hourly run"}</Badge>
        <p className={a.small}>{data.runLabel} · {data.context} · <Link to="/automations/demo-jobId/schedule" className={a.linkText} style={{ font: "inherit", textDecoration: "underline" }}>Manage schedule</Link></p>
      </div>
      <KpiGrid>
        <KpiCard label="Profiles checked" context={failed ? `${unavailableSessions} browser session needs reconnection` : "Every selected profile was read"} warn={Boolean(failed)} testId="metric-checked">{data.profiles.checked} / {data.profiles.total}</KpiCard>
        <KpiCard label="New post links" context="Deduplicated by network + post ID" testId="metric-posts">{data.newPostLinks}</KpiCard>
        <KpiCard label="Inbox changes" context="New source events since checkpoint" testId="metric-inbox">{data.inboxChanges}</KpiCard>
        <KpiCard label="Status reviews" context="Message-derived suggestions await review" warn testId="metric-reviews">{data.statusReviews}</KpiCard>
      </KpiGrid>
      <div className={a.split} style={{ gridTemplateColumns: "832fr 440fr", gap: 24 }}>
        <Card labelledBy="timeline-title">
          <h2 id="timeline-title" className={a.cardH2} style={{ margin: 0 }}>Checkpointed, source by source</h2>
          <ol className={m.stages} aria-label="Run stages">
            {data.stages.map((s) => (
              <li key={s.n}>
                <div className={m.stageRow}>
                  <Badge tone="violet" width={40}>{s.n}</Badge>
                  <div className={m.stageCopy}><strong>{s.title}</strong><span>{s.detail}</span></div>
                  <Badge tone={s.state === "complete" ? "success" : "warning"} width={126}>{s.state === "complete" ? "Complete" : "Partial"}</Badge>
                </div>
                <hr className={a.divider} />
              </li>
            ))}
          </ol>
        </Card>
        <Card labelledBy="policy-title" className={a.card20}>
          <h2 id="policy-title" className={a.cardH2} style={{ margin: 0 }}>Hourly policy</h2>
          <div className={m.fields} style={{ display: "contents" }}>
            <Field label="Schedule" helpText={data.policy.scheduleNote}>{(p) => <input {...p} readOnly aria-disabled="true" value={data.policy.schedule} />}</Field>
            <Field label="Next example run" helpText={data.policy.nextRunNote}>{(p) => <input {...p} readOnly aria-disabled="true" value={data.policy.nextRun} />}</Field>
            <Field label="Retry behavior" helpText={data.policy.retryNote}>{(p) => <input {...p} readOnly aria-disabled="true" value={data.policy.retry} />}</Field>
          </div>
          <p className={a.small}>Reconnecting a session does not resend messages or repeat completed source writes.</p>
          <Button variant="secondary" style={{ width: "100%" }} aria-haspopup="dialog" onClick={() => setDialog("reconnect")}>Reconnect source</Button>
          <Button variant="secondary" style={{ width: "100%" }} loading={retry.isPending} disabledReason={failed ? null : "No profile failed in this run"} onClick={submit}>Retry failed profile</Button>
          {retry.data && (
            <p className={m.status} role="status">
              {retry.data.state === "blocked" ? `Not retried: ${failed?.handle ?? "the profile"} needs its source session reconnected first. Nothing ran, and nothing was resent.` : `Retry state: ${retry.data.state}. The source receipt, not this click, shows what ran.`}
            </p>
          )}
          {retryError && <p className={m.status} role="alert">{retryError.category === "conflict" ? "This run changed. Reload it before retrying." : retryError.message}</p>}
        </Card>
      </div>
      <Card labelledBy="evidence-title">
        <h2 id="evidence-title" ref={evidenceRef} tabIndex={-1} className={a.cardH2} style={{ margin: 0 }}>Observed events stay separate from inferred status</h2>
        <div className={a.tableWrap} role="region" aria-label="Evidence and proposed changes" tabIndex={0}>
          <table className={a.table}>
            <caption className="visually-hidden">Evidence and proposed changes</caption>
            <colgroup>{[350, 310, 360, 228].map((w) => <col key={w} style={{ width: `${(100 * w) / 1248}%` }} />)}</colgroup>
            <thead><tr>{["EVIDENCE", "SOURCE", "RESULT", "ACTION"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {data.evidence.map((e) => (
                <tr key={e.evidence}>
                  <th scope="row">{e.evidence}</th><td>{e.source}</td><td>{e.result}</td>
                  <td>{e.kind === "post" ? <Link className={m.linkBtn} to={`/content/${DEMO_POST_ID}`}>{e.action}</Link> : <button type="button" className={m.linkBtn} aria-haspopup="dialog" onClick={() => act(e)}>{e.action}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={a.small}>This monitoring run reads source content and conversations. Any outbound message, payment or commercial commitment follows its separate approval workflow.</p>
      </Card>
      <p className={m.footer}>{demo ? "Demo run · metrics are illustrative · " : ""}every snapshot stores observed_at and source_url; unknown counts remain unavailable.</p>
      <HandoffDialog open={dialog === "reconnect"} onClose={() => setDialog(null)} title="Reconnect source session"
        rows={[{ label: "Profile", value: failed ? `${failed.handle} · ${failed.network}` : "None failed" }, { label: "Reason", value: failed?.reason ?? "Not applicable" }, { label: "Sign-in", value: "Happens in the connected browser session. This app never sees credentials" }]}>
        <p>Reconnecting doesn't resend messages or repeat completed source writes, and no access is bypassed.</p>
      </HandoffDialog>
      <HandoffDialog open={dialog === "suggestion" && row !== null} onClose={() => { setDialog(null); setRow(null); }} title={row ? row.action.replace(" →", "") : ""}
        rows={row ? [{ label: "Source", value: row.source }, { label: "Current value", value: "Authoritative source status, unchanged" }, { label: "Proposed value", value: row.result.replace("Suggested: ", "") }, { label: "Evidence", value: "Message event ID recorded; link not available in this build" }, { label: "Expected version", value: data.version }] : []}>
        <p>A suggestion can't silently overwrite an authoritative source fact. Accepting one needs the source owner's own versioned action.</p>
      </HandoffDialog>
    </>
  );
}
