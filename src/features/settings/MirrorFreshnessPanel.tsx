import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { useSourceLease } from "@/adapter/useSourceLease";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { DetailRows, Divider, Panel, Row, Small } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import { mirrorFreshnessBadge, mirrorFreshnessDetail, type MirrorFreshnessSummary } from "@/creator-agent/mirrorFreshness";
import type { MirrorFreshnessView, MirrorRunDetail } from "@/creator-agent/mirrorFreshnessContract";
import { mirrorRefSchema } from "@/creator-agent/mirrorFreshness";

const stamp=(value:string|null|undefined)=>value?new Date(value).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"long"}):"Unknown";
const minutes=(value:number|null|undefined)=>value==null?"Unknown":`${value} minutes`;

/** Exact SYS-01 freshness slot. Native coverage, never demo data or a provider-permission claim. */
export function MirrorFreshnessPanel() {
  const query=useView<Record<string,never>,MirrorFreshnessView>("mirrorFreshness",{});
  const [params,setParams]=useSearchParams();
  const data=query.data?.data;
  // Bound a quiet tab at both its next health check and the first stale millisecond.
  const deadlines=data?.mirrors.flatMap(m=>[Date.parse(m.checkedAt)+900_000,
    ...(m.valuesAreCurrent&&m.evidence.lastComplete&&m.policy.staleAfterMinutes!==null?[Date.parse(m.evidence.lastComplete.coverageWatermark)+m.policy.staleAfterMinutes*60_000+1]:[])])??[];
  const expired=useSourceLease(deadlines.length?new Date(Math.min(...deadlines)).toISOString():null);
  const withheld=expired||query.isError;
  const selected=data?.mirrors.find(m=>m.mirrorId===params.get("mirror"));
  const select=(mirror:string|null,run:string|null=null)=>setParams(p=>{const next=new URLSearchParams(p);next.delete("mirrorRun");
    if(mirror)next.set("mirror",mirror);else next.delete("mirror");if(run)next.set("mirrorRun",run);return next;},{replace:mirror===null});
  return <Panel title="Trust the freshness" note="Source event time ≠ mirror sync time" headingId="mirror-freshness-title" testId="mirror-freshness">
    {query.isPending&&<p role="status">Loading source freshness…</p>}
    {query.isError&&<ViewError error={query.error} subject="Mirror freshness" hasPriorData={Boolean(data)} onRetry={()=>void query.refetch()}/>}
    {data&&<>
      <Small>{!data.policy?"Threshold approval is not configured.":`Health sweep: every 15 minutes · ${data.policy.timezone}.`}</Small>
      <p>Schedule: <strong>{data.schedule.state==="unconfigured"?"Unconfigured":data.schedule.state}</strong></p>
      {data.schedule.state==="running"&&<Small>Last sweep {stamp(data.schedule.lastSweepAt)}. Next sweep {stamp(data.schedule.nextSweepAt)}.</Small>}
      {withheld&&<p role="status">This observation needs refreshing. Current freshness is unknown; the prior source evidence is retained for inspection.</p>}
      <DetailRows rows={data.mirrors.map(m=>{const badge=mirrorFreshnessBadge(withheld?null:m);return [m.label,
        <Row key={m.mirrorId}><Badge tone={badge.tone} testId={`mirror-state-${m.mirrorId}`}>{badge.label}</Badge>
          <Button variant="ghost" aria-haspopup="dialog" onClick={()=>select(m.mirrorId)} aria-label={`Inspect ${m.label} freshness`}>Inspect</Button></Row>] as const;})}/>
      <Divider/>
      <Small>Complete source checks establish freshness. A check with no changes still renews coverage. Unconnected sources remain unknown.</Small>
      <Row><Button variant="secondary" loading={query.isFetching} onClick={()=>void query.refetch()}>Refresh freshness</Button>
        <LinkButton variant="secondary" to="/automations?from=connections">Open sync run history</LinkButton>
        <LinkButton variant="secondary" to="/settings/capabilities">Inspect available actions</LinkButton></Row>
      <Dialog open={Boolean(selected)} title={selected?`${selected.label} freshness`:"Source freshness"} onClose={()=>select(null)}>
        <Button variant="secondary" onClick={()=>select(null)}>Close</Button>
        {selected&&<MirrorDetail summary={selected} withheld={withheld} data={data} runId={params.get("mirrorRun")} openRun={run=>select(selected.mirrorId,run)}/>}
      </Dialog>
    </>}
  </Panel>;
}

function MirrorDetail({summary,withheld,data,runId,openRun}:{summary:MirrorFreshnessSummary;withheld:boolean;data:MirrorFreshnessView;runId:string|null;openRun:(run:string)=>void}) {
  const detail=mirrorFreshnessDetail(withheld?null:summary),badge=mirrorFreshnessBadge(withheld?null:summary);
  const runs=[...new Set([summary.evidence.latestRun?.runId,summary.evidence.lastComplete?.runId].filter((v):v is string=>Boolean(v)))];
  return <>
    <Badge tone={badge.tone}>{badge.label}</Badge><p>{detail.meaning}</p>
    <DetailRows rows={[["Source",summary.provider],["Observed",stamp(summary.checkedAt)],["Last successful complete check",stamp(summary.evidence.lastComplete?.finishedAt)],
      ["Complete coverage through",stamp(summary.evidence.lastComplete?.coverageWatermark)],["Coverage age at observation",minutes(summary.ageMinutes)],
      ["Source check expected",minutes(data.policy?.expectedCadenceMinutes[summary.mirrorId])],["Stale strictly after",minutes(summary.policy.staleAfterMinutes)],
      ["Owner",data.policy?.ownerRef??"Unassigned"],["Policy version",data.policy?.version??"Not adopted"],["Approval reference",data.policy?.decisionRef??"Unknown"],
      ["Policy adopted",stamp(data.policy?.approvedAt)],["Reasons",detail.reasonCodes.join(", ")||"No exception at observation"]]}/>
    {data.incidents.filter(i=>i.mirrorId===summary.mirrorId).map(i=><p key={i.incidentId}>Open {i.state} incident. Recovery requires a complete successful source check.</p>)}
    <Row>{runs.map(id=><Button key={id} variant="secondary" onClick={()=>openRun(id)}>Inspect run {id}</Button>)}</Row>
    {!runs.length&&<p>No completed run evidence is available. This is not proof of a zero-row source.</p>}
    {runId&&mirrorRefSchema.safeParse(runId).success?<RunTrace key={runId} runId={runId} mirrorId={summary.mirrorId}/>:runId?<p role="alert">The run reference is invalid.</p>:null}
  </>;
}
function RunTrace({runId,mirrorId}:{runId:string;mirrorId:string}) {
  const query=useView<{runId:string},MirrorRunDetail>("mirrorRunDetail",{runId});
  const data=query.data?.data;
  const run=data?.run;
  const matches=run?.runId===runId&&run.mirrorId===mirrorId;
  return <section aria-label="Mirror run trace">
    <h3>Source run evidence</h3>
    {query.isPending&&<p role="status">Loading run evidence…</p>}
    {query.isError&&<ViewError error={query.error} subject="Mirror run" hasPriorData={Boolean(data)} onRetry={()=>void query.refetch()}/>}
    {data&&!matches&&<p role="status">The requested run evidence is unavailable.</p>}
    {data&&run&&matches&&<DetailRows rows={[["Run",run.runId],["Outcome",run.outcome],["Started",stamp(run.startedAt)],["Finished",stamp(run.finishedAt)],
      ["Rows read",run.counts.rowsRead??"Unknown"],["Rows changed",run.counts.rowsChanged??"Unknown"],["Expected rows",run.counts.rowsExpected??"Unknown"],
      ["Coverage basis",data.completion?.coverage.basis??"Unverified"],["Partitions completed",data.completion?`${data.completion.coverage.partitionsCompleted} of ${data.completion.coverage.partitionsExpected}`:"Unknown"],
      ["Continuation exhausted",data.completion?(data.completion.coverage.pendingCursor===null?"Yes":"No"):"Unknown"],["Mirror acknowledged",data.completion?(data.completion.coverage.mirrorAcknowledged?"Yes":"No"):"Unknown"],
      ["Receipt",data.completion?.receiptRef??"Unavailable"],["Source version",data.completion?.coverage.sourceVersion??"Unknown"]]}/>}
  </section>;
}
