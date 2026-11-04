import { useRef, useState } from "react";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { TextField } from "@/components/Field";
import type { LaunchControlData, LaunchGate } from "@/fixtures/analytics";
import { checkProposal, goBlockedReason, summarizeGates } from "./launchRules";
import { Card, HandoffDialog, KpiCard, KpiGrid, Notice, PageHeader, SectionHeading, Table, ViewShell, WorkspaceTabs, count, dateTime, useIsDemo } from "./parts";
import styles from "./Analytics.module.css";

export const LAUNCH_TABS = (current: "snapshot" | "control" | "performance") => [
  { label: "GTM overview", to: "/launch?view=snapshot", current: current === "snapshot" },
  { label: "Launch control", to: "/launch?view=control", current: current === "control" },
  { label: "Performance", to: "/analytics/attribution", current: current === "performance" },
];

const compactUsd = (minorUnits: number) => `$${new Intl.NumberFormat("en-US").format(minorUnits / 100_000)}k`;

/** Launch control (Figma source 14:74, owner THO-293, CTRL-197 to CTRL-201). Records readiness; never activates a launch. */
export function LaunchControlPage() {
  const query = useView<Record<string, never>, LaunchControlData>("launchControl", {});
  const gatesRef = useRef<HTMLHeadingElement>(null);
  const [notion, setNotion] = useState(false);
  return (
    <section aria-labelledby="launch-control-title" data-figma-source="14:74" className={styles.page}>
      <PageHeader id="launch-control-title" title="Ready means evidenced." subtitle="Launch control · owner decisions, dependencies and launch-relative timing.">
        <Button variant="secondary" style={{ minWidth: 184 }} aria-haspopup="dialog" onClick={() => setNotion(true)}>Open Notion</Button>
        <Button style={{ minWidth: 184 }} onClick={() => { gatesRef.current?.scrollIntoView?.({ block: "start" }); gatesRef.current?.focus(); }}>Review gates</Button>
      </PageHeader>
      <WorkspaceTabs tabs={LAUNCH_TABS("control")} />
      <ViewShell query={query} subject="Launch control" emptyTitle="No launch control record yet" emptyBody="The source responded, but there is no launch-readiness record to show.">
        {(data) => <Body data={data} gatesRef={gatesRef} />}
      </ViewShell>
      <HandoffDialog open={notion} onClose={() => setNotion(false)} title="Notion launch control" rows={[{ label: "Owner", value: "Founder, in the Notion Launch Control record" }, { label: "Link", value: "No verified link in this build" }]}>
        <p>Actual launch readiness is recorded in Notion. This build has no verified link to it, so it opens nothing and records nothing.</p>
      </HandoffDialog>
    </section>
  );
}

function Body({ data, gatesRef }: { data: LaunchControlData; gatesRef: React.RefObject<HTMLHeadingElement> }) {
  const demo = useIsDemo();
  const summary = summarizeGates(data.gates);
  const set = data.launchDate.state === "known" && Boolean(data.launchDate.value);
  const [handoff, setHandoff] = useState<LaunchGate | null>(null);
  const [decision, setDecision] = useState(false);
  return (
    <>
      {set ? (
        <Notice tone="violet" title={`Proposed launch date ${data.launchDate.value}`}>A proposed date isn't a founder-approved launch. Dependent dates stay relative until it is approved.</Notice>
      ) : (
        <Notice tone="warning" title="Launch date is not set">January 2027 is the production-spec sample and factory-visit target window. It is not a confirmed launch. Historical forecasts remain pending rebaseline.</Notice>
      )}
      <KpiGrid>
        <KpiCard label="Required gates" context="Illustrative readiness checks" testId="metric-gates">{summary.passed} / {summary.total}</KpiCard>
        <KpiCard label="Critical blockers" context={data.blockerContext} testId="metric-blockers">{String(summary.blocked).padStart(2, "0")}</KpiCard>
        <KpiCard label="First-wave samples" context="Planned allocation · not shipped">{count(data.firstWaveSamples)}</KpiCard>
        <KpiCard label="Budget ceiling" context="Actual / committed costs from Finance">{compactUsd(data.budgetCeiling.minorUnits)}</KpiCard>
      </KpiGrid>
      <div className={styles.split} style={{ gridTemplateColumns: "824fr 448fr" }}>
        <Card labelledBy="gates-title">
          <div className={styles.sectionHeading}>
            <h2 id="gates-title" ref={gatesRef} tabIndex={-1}>Launch gates</h2>
            <p>Every pass needs source evidence and an accountable owner.</p>
          </div>
          <Table
            tight
            caption="Launch gates"
            columns={[{ label: "Gate", width: 338 }, { label: "Owner", width: 142 }, { label: "State", width: 144 }, { label: "Evidence", width: 152 }]}
            rows={data.gates.map((g) => ({
              key: g.id,
              cells: [
                g.gate,
                g.owner,
                <Badge key="s" tone={g.state === "pass" ? "success" : "danger"} width={120}>{g.state === "pass" ? "Pass" : "Blocked"}</Badge>,
                <Button key="e" variant="ghost" style={{ minWidth: 122 }} aria-haspopup="dialog" aria-label={`${g.evidenceAction}: ${g.gate}`} onClick={() => setHandoff(g)}>{g.evidenceAction}</Button>,
              ],
            }))}
          />
          <p className={styles.small}>{demo ? "Demo test results only. " : ""}Actual launch readiness is recorded in Notion Launch Control.</p>
        </Card>
        <Card labelledBy="decision-title">
          <div className={styles.sectionHeading}>
            <h2 id="decision-title">Go / revise / hold</h2>
            <p>{data.decision.windowLabel}</p>
          </div>
          <div className={styles.btnRow}><Badge tone="warning" width={216}>{set ? "Awaiting founder decision" : "Awaiting launch date"}</Badge></div>
          <DecisionRow label="Decision" value={data.decision.recorded} />
          <DecisionRow label="Review owner" value={data.decision.reviewOwner} />
          <DecisionRow label="Evidence" value={summary.blocked ? `${summary.blocked} blocker${summary.blocked === 1 ? "" : "s"} remain` : "All required gates pass"} />
          <hr className={styles.divider} />
          <div className={styles.options3}><h3>Go</h3><p>All required gates pass, with evidence.</p></div>
          <div className={styles.options3}><h3>Revise</h3><p>Change the plan and re-test affected gates.</p></div>
          <div className={styles.options3}><h3>Hold</h3><p>Keep launch and dependent automations paused.</p></div>
          <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 232 }} aria-haspopup="dialog" onClick={() => setDecision(true)}>Record in Notion</Button></div>
        </Card>
      </div>
      <div className={styles.split} style={{ gridTemplateColumns: "824fr 448fr" }}>
        <Card labelledBy="dates-title">
          <SectionHeading id="dates-title" level={2} title="Dates move together" note="No absolute date is generated until a founder approves L." />
          <Table
            tight
            caption="Relative milestone schedule"
            columns={[{ label: "Milestone", width: 376 }, { label: "Relative date", width: 156 }, { label: "Current state", width: 244 }]}
            rows={data.milestones.map((m) => ({ key: m.milestone, cells: [m.milestone, m.relative, set && m.state === "Waiting for launch date" ? "Waiting for founder approval of L" : m.state] }))}
          />
        </Card>
        <Proposal />
      </div>
      <Notice tone="violet" title="Cutover is a separate gate">Sandbox → validated sources → founder decision → live enablement. A failed live check pauses new actions and routes the team to the checked manual workflow.</Notice>
      <HandoffDialog
        open={handoff !== null}
        onClose={() => setHandoff(null)}
        title={handoff ? `${handoff.evidenceAction}: ${handoff.gate}` : ""}
        rows={handoff ? [{ label: "Gate", value: handoff.gate }, { label: "Owner", value: handoff.owner }, { label: "State", value: handoff.state === "pass" ? "Pass (demo result)" : "Blocked" }, { label: "Linked record", value: `None. This ${handoff.evidenceKind} reference is a labeled demo placeholder.` }] : []}
      >
        <p>No {handoff?.evidenceKind ?? "record"} is opened, and nothing here is marked complete. A real reference opens its owner's record.</p>
      </HandoffDialog>
      <Dialog open={decision} title="Record a launch-readiness decision" badge={demo ? "Demo" : undefined} onClose={() => setDecision(false)}>
        <DecisionEditor data={data} summary={summary} launchDateSet={set} onClose={() => setDecision(false)} />
      </Dialog>
    </>
  );
}

function DecisionRow({ label, value }: { label: string; value: string }) {
  return <dl className={styles.decisionDetails}><div><dt>{label}</dt><dd>{value}</dd></div></dl>;
}

function Proposal() {
  const demo = useIsDemo();
  const [date, setDate] = useState("");
  const [evidence, setEvidence] = useState("");
  const [shown, setShown] = useState(false);
  const check = checkProposal(date, evidence);
  return (
    <Card labelledBy="proposal-title">
      <SectionHeading id="proposal-title" level={2} title="Propose a launch date" note="Approval happens in the owning Notion record." />
      <div className={styles.narrow}><TextField label="Proposed L" placeholder="YYYY-MM-DD" helpText="Leave unset until the sample review." error={shown ? check.dateError : null} value={date} onChange={setDate} /></div>
      <div className={styles.narrow}><TextField label="Reason / evidence" placeholder="Link sample acceptance" helpText="Required before founder review." error={shown ? check.evidenceError : null} value={evidence} onChange={setEvidence} /></div>
      <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 230 }} onClick={() => setShown(true)}>Open date proposal</Button></div>
      {shown && check.ok && (
        <p className={styles.formStatus} role="status">
          {check.proposedDate ? `Proposed L ${check.proposedDate} is a draft, not an approved date.` : "Proposed L stays unset."} {demo ? "Nothing is sent to Notion in the demo, and the evidence reference isn't verified. " : ""}No schedule is enabled.
        </p>
      )}
      <p className={styles.proposalCopy}>On approval: rebaseline forecast, preview dependent dates, then enable the checked schedule. A rejected proposal leaves the plan unchanged.</p>
    </Card>
  );
}

type Verdict = "go" | "revise" | "hold";

/** Founder decision editor (CTRL-199). It prepares a draft; saving needs the adapter's receipt, so nothing here claims a record exists. */
function DecisionEditor({ data, summary, launchDateSet, onClose }: { data: LaunchControlData; summary: ReturnType<typeof summarizeGates>; launchDateSet: boolean; onClose: () => void }) {
  const demo = useIsDemo();
  const [verdict, setVerdict] = useState<Verdict>("hold");
  const [rationale, setRationale] = useState("");
  const [touched, setTouched] = useState(false);
  const goBlocked = goBlockedReason(launchDateSet, summary.blocked);
  const options: { value: Verdict; label: string }[] = [{ value: "go", label: "Go" }, { value: "revise", label: "Revise" }, { value: "hold", label: "Hold" }];
  return (
    <div className={styles.editor}>
      <p>Founder only. Preparing a decision doesn't activate launch, approve a date or start any automation.</p>
      <fieldset className={styles.options}>
        <legend>Decision</legend>
        {options.map((o) => {
          const blocked = o.value === "go" && goBlocked !== null;
          return (
            <label key={o.value} className={styles.option} style={blocked ? { opacity: 0.6 } : undefined}>
              <input type="radio" name="verdict" checked={verdict === o.value} disabled={blocked} aria-describedby={blocked ? "go-reason" : undefined} onChange={() => setVerdict(o.value)} />
              {o.label}
            </label>
          );
        })}
        {goBlocked && <p id="go-reason" className={styles.small}>{goBlocked}</p>}
      </fieldset>
      <dl className={styles.defs}>
        <div><dt>Launch date</dt><dd>{launchDateSet ? String(data.launchDate.value) : "Not set"}</dd></div>
        <div><dt>Gate snapshot</dt><dd>{summary.passed} of {summary.total} required gates pass · {summary.blocked} blocked · {dateTime(data.provenance.observedAt)}</dd></div>
        <div><dt>Expected record version</dt><dd>{data.decision.version}</dd></div>
      </dl>
      <TextField label="Rationale" multiline value={rationale} onChange={(v) => { setRationale(v); setTouched(true); }} error={touched && rationale.trim() === "" ? "Required for every decision." : null} helpText="Cite the gate evidence behind this decision." />
      <Button disabledReason={demo ? "Demo: recording in Notion isn't connected, so nothing is saved." : "Recording isn't available until the adapter publishes the launch-readiness action."}>Record decision</Button>
      <p className={styles.small}>This draft is not saved. Closing discards it.</p>
      <Button variant="secondary" onClick={onClose}>Close without recording</Button>
    </div>
  );
}
