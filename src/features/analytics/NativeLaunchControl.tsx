import { useEffect, useRef, useState } from "react";
import { useBlocker, useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { scopeKey, useScope } from "@/adapter/scope";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { TextField } from "@/components/Field";
import type { NativeReadinessView } from "@/creator-agent/actions/views";
import { LAUNCH_TABS } from "./LaunchControlPage";
import { NativeLaunchDecision } from "./NativeLaunchDecision";
import { isCalendarDate } from "./launchRules";
import { Card, HandoffDialog, KpiCard, KpiGrid, Notice, PageHeader, SectionHeading, Table, ViewShell, WorkspaceTabs, dateTime } from "./parts";
import styles from "./Analytics.module.css";
import native from "./NativeLaunch.module.css";

export const launchRequestKeyValid = (key: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);
export function NativeLaunchControl() {
  const ctx = useScope(), [params] = useSearchParams(), raw = params.get("readinessRequestKey"), requestKey = raw && launchRequestKeyValid(raw) ? raw : null;
  const query = useView<{ requestKey?: string }, NativeReadinessView>("launchControl", requestKey ? { requestKey } : {});
  const gatesRef = useRef<HTMLHeadingElement>(null), [notion, setNotion] = useState(false);
  return <section aria-labelledby="launch-control-title" data-figma-source="14:74" className={`${styles.page} ${native.page}`}>
    <PageHeader id="launch-control-title" title="Ready means evidenced." subtitle="Launch control · owner decisions, dependencies and launch-relative timing.">
      <Button variant="secondary" style={{ minWidth: 184 }} aria-haspopup="dialog" onClick={() => setNotion(true)}>Open Notion</Button>
      <Button style={{ minWidth: 184 }} onClick={() => { gatesRef.current?.scrollIntoView?.({ block: "start" }); gatesRef.current?.focus(); }}>Review gates</Button>
    </PageHeader><WorkspaceTabs tabs={LAUNCH_TABS("control")} />
    <ViewShell query={query} subject="Launch control" emptyTitle="No launch control record yet" emptyBody="The source returned no readiness record. No dates, gate outcomes or financial quantities are assumed.">
      {(data, response) => data.kind !== "native-launch-readiness" ? <Notice tone="warning" title="Native readiness source unavailable">This record is not a qualified native readiness response. No fixture numbers or controls can authorize recording.</Notice> : <NativeBody key={JSON.stringify([...scopeKey(ctx), data.actorRef, data.targetRef])} data={data} response={response} gatesRef={gatesRef} requestKey={requestKey} invalidKey={raw !== null && !requestKey} readCurrent={!query.isError && !query.isPlaceholderData} refresh={() => void query.refetch()} />}
    </ViewShell>
    <HandoffDialog open={notion} onClose={() => setNotion(false)} title="Notion launch control" rows={[{ label: "Record", value: "Canonical Notion readiness record" }, { label: "Source link", value: "Not supplied by the current source" }]}><p>No verified source URL is available. This handoff opens no external page. Recording a readiness decision does not approve a launch date or enable any activity.</p></HandoffDialog>
  </section>;
}
function NativeBody({ data, response, gatesRef, requestKey, invalidKey, readCurrent, refresh }: React.ComponentProps<typeof NativeLaunchDecision> & { gatesRef: React.RefObject<HTMLHeadingElement> }) {
  const required = data.gates.filter(g => g.required), passed = required.filter(g => g.state === "pass" && g.evidenceRef), blocked = required.filter(g => g.state === "fail");
  const [dateDirty, setDateDirty] = useState(false), [decisionDirty, setDecisionDirty] = useState(false);
  const [evidence, setEvidence] = useState<NativeReadinessView["gates"][number] | null>(null);
  return <>
    <LaunchLeaveGuard dirty={dateDirty || decisionDirty} pending={!!requestKey} />
    <Notice tone={data.launchDateApproved && data.launchDate ? "violet" : "warning"} title={!data.launchDate ? "Launch date is not set" : data.launchDateApproved ? `Source-approved launch date ${data.launchDate}` : `Proposed launch date ${data.launchDate}`}>
      {data.launchDateApproved ? "The source reports date approval. This screen records readiness only; release and execution remain separate gates." : "A date is not approved by entering it here. Dependent dates remain relative until the source confirms approval."}
    </Notice>
    <KpiGrid>
      <KpiCard label="Required gates" context="Source passes with linked evidence" testId="metric-gates">{passed.length} / {required.length}</KpiCard>
      <KpiCard label="Critical blockers" context={`${required.length - passed.length - blocked.length} unresolved required gates`} testId="metric-blockers">{blocked.length}</KpiCard>
      <KpiCard label="First-wave samples" context="Allocation not supplied by this source">Unknown</KpiCard>
      <KpiCard label="Budget ceiling" context="Finance source not included in this record">Unknown</KpiCard>
    </KpiGrid>
    <div className={styles.split} style={{ gridTemplateColumns: "824fr 448fr" }}>
      <Card labelledBy="gates-title"><div className={styles.sectionHeading}><h2 id="gates-title" ref={gatesRef} tabIndex={-1}>Launch gates</h2><p>Every pass needs source evidence and an accountable owner.</p></div>
        <Table tight caption="Launch gates" columns={[{ label: "Gate", width: 338 }, { label: "Owner", width: 142 }, { label: "State", width: 144 }, { label: "Evidence", width: 152 }]} rows={data.gates.map((g, i) => ({ key: g.id, cells: [<span key="name">Gate {i + 1} · {g.required ? "Required" : "Optional"}<small className={native.note}>Source label unavailable</small></span>, "Not supplied", <Badge key="state" tone={g.state === "pass" && g.evidenceRef ? "success" : g.state === "fail" ? "danger" : "warning"} width={120}>{g.state === "pass" && g.evidenceRef ? "Pass" : g.state === "fail" ? "Blocked" : "Unknown"}</Badge>, <Button key="evidence" variant="ghost" aria-haspopup="dialog" aria-label={`Inspect evidence for gate ${i + 1}`} onClick={() => setEvidence(g)}>View proof</Button>] }))} />
        <p className={styles.small}>Observed {dateTime(data.observedAt)}. Gate names, named owners and source URLs were not supplied. References identify evidence; they do not establish an unobserved task outcome.</p>
      </Card>
      <NativeLaunchDecision data={data} response={response} requestKey={requestKey} invalidKey={invalidKey} readCurrent={readCurrent} refresh={refresh} onDirty={setDecisionDirty} />
    </div>
    <div className={styles.split} style={{ gridTemplateColumns: "824fr 448fr" }}>
      <Card labelledBy="dates-title"><SectionHeading id="dates-title" title="Dates move together" note="Relative design milestones; source scheduling and actual dates are not supplied." />
        <Table tight caption="Relative milestone schedule" columns={[{ label: "Milestone", width: 376 }, { label: "Relative date", width: 156 }, { label: "Current state", width: 244 }]} rows={[["Samples ship", "L − 25"], ["Daily reporting ready", "L − 21"], ["Readiness test", "L − 7"], ["Go / revise / hold", "L − 4"], ["Launch pulse", "L to L + 3"], ["Stage 2 media review", "L + 14"]].map(([label, relative]) => ({ key: label!, cells: [label, relative, "Not supplied by source"] }))} />
      </Card><NativeDateProposal onDirty={setDateDirty} />
    </div>
    <Notice tone="violet" title="Cutover is a separate gate">A Notion readiness record confers no release. No sample shipment, production, schedule, creator message or paid-media spend is enabled here.</Notice>
    <HandoffDialog open={!!evidence} onClose={() => setEvidence(null)} title="Launch gate evidence" rows={evidence ? [{ label: "Gate reference", value: evidence.id }, { label: "Evidence reference", value: evidence.evidenceRef ?? "Missing" }, { label: "Source state", value: evidence.state }, { label: "Owner / source URL", value: "Not supplied" }] : []}><p>This is the current source observation. An opaque reference is not a browsable source link; nothing is opened or marked complete.</p></HandoffDialog>
  </>;
}
function NativeDateProposal({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const [date, setDate] = useState(""), [reason, setReason] = useState(""), [shown, setShown] = useState(false);
  useEffect(() => { onDirty(!!date || !!reason); return () => onDirty(false); }, [date, reason, onDirty]);
  return <Card labelledBy="proposal-title"><SectionHeading id="proposal-title" title="Propose a launch date" note="Approval happens in the owning Notion record." />
    <div className={styles.narrow}><TextField label="Proposed L" placeholder="YYYY-MM-DD" value={date} onChange={setDate} helpText="Leave unset until the sample review." error={date && !isCalendarDate(date) ? "Enter a real calendar date, or leave it unset." : null} /></div>
    <div className={styles.narrow}><TextField label="Reason / evidence" placeholder="Link sample acceptance" value={reason} onChange={v => setReason(v.slice(0, 2000))} helpText="Required before founder review; this source does not verify sample acceptance." /></div>
    <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 230 }} onClick={() => setShown(true)}>Open date proposal</Button></div>
    {shown && <p role="status">This local draft has not been submitted. Sample-acceptance identity, access, version and the date-approval workflow are not supplied. Keep L unchanged in the source until its owner verifies them.</p>}
    <p className={styles.proposalCopy}>A date proposal is separate from Go / revise / hold. No schedule or dependent date is changed.</p>
  </Card>;
}

function LaunchLeaveGuard({ dirty, pending }: { dirty: boolean; pending: boolean }) {
  const route = (l: { pathname: string; search: string }) => { const p = new URLSearchParams(l.search); p.delete("readinessRequestKey"); return l.pathname + p.toString(); };
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirty || pending) && route(currentLocation) !== route(nextLocation));
  useEffect(() => { if (!dirty && !pending) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty, pending]);
  return <Dialog open={blocker.state === "blocked"} title={pending ? "Reconcile before leaving" : "Discard local launch edits?"} onClose={() => blocker.reset?.()}><p>{pending ? "Keep the original request key until its exact outcome is verified. Reload preserves the opaque key without storing your rationale." : "These local edits have not been submitted."}</p><Button onClick={() => blocker.reset?.()}>Keep reviewing</Button>{!pending && <Button variant="secondary" onClick={() => blocker.proceed?.()}>Discard and leave</Button>}</Dialog>;
}
