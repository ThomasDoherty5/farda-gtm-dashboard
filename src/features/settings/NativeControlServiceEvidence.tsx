import { LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { DetailRows, Panel, Small } from "@/components/PageKit";
import type { OperationsServiceEvidence, NativeOperationsControl } from "@/creator-agent/operationsControlsSchema";

/** Source-owned projections only: no local scheduler, comparator or success inference. */
export function NativeControlServiceEvidence({evidence,section}:{evidence:OperationsServiceEvidence[];section:NativeOperationsControl["section"]}) {
 if(!evidence.length)return ["reports","runs","reconciliation","capabilities"].includes(section)?<Panel title="Source service evidence" headingId={"service-evidence-"+section}>
  <p>No linked source service evidence is available. {section==="reports"?"Runtime activation, report programme and delivery are unknown. A saved draft or setup post does not establish recurrence.":section==="reconciliation"?"Comparison, conditional repair and matching source/mirror readback remain with their owning source jobs.":"Current assignment, execution or permission must be verified by the owning source."}</p>
 </Panel>:null;
 return <Panel title="Source service evidence" headingId={"service-evidence-"+section} note="Current source associations, native receipts and readback">
  {evidence.map((entry,index)=><section key={entry.kind+entry.targetRef+index} aria-label={entry.kind+" evidence"}><Evidence entry={entry}/></section>)}
 </Panel>;
}
function Evidence({entry}:{entry:OperationsServiceEvidence}) {
 if(entry.kind==="unavailable")return <><h3>{entry.service}</h3><p>Source evidence unavailable: {entry.reasonCode}. Configuration and completion remain unknown.</p></>;
 if(entry.kind==="runtimeRegistration"){
  const r=entry.data,c=r.cadence;
  return <><h3>Installed runtime registration</h3><DetailRows rows={[
   ["Registration",r.registrationRef],["Version",String(r.version)],["Family / mode",r.family+" / "+r.mode],["Source owner",r.ownerAlias],
   ["Installed cadence",c.kind==="event"?"Source event":c.kind==="hourly"?"Hourly, minute "+c.minute:c.cadence+" at "+c.localTime],
   ["Timezone",c.kind==="event"?"Not applicable":c.timezone],["Starts",c.kind==="event"?"Source event":c.startsAt],
   ["Next planned window",r.cadenceStatus.nextPlannedAt??(c.kind==="event"?"Event driven":"Not returned")],
   ["Oldest unadmitted window",r.cadenceStatus.oldestUnadmittedAt??"None in the scanned range"],
   ["Backlog coverage",r.cadenceStatus.unadmittedInScannedRange+" unadmitted in "+r.cadenceStatus.scannedSlots+" scanned slots; "+(r.cadenceStatus.scanComplete?"scan complete":"partial scan")],
   ["Observed",r.observedAt],["Authority valid until",r.validUntil],
  ]}/><Small>An installed cadence is separate from the saved draft and from a successful source execution. Next planned time does not promise delivery. No enable command is available here.</Small>
  {r.windows.length?<DataTable caption="Observed runtime windows" columns={[{label:"Intended time"},{label:"Recorded run"}]} rows={r.windows.map(w=>[w.intendedAt,w.runRef?<LinkButton key={w.runRef} variant="ghost" to={"/runs/"+encodeURIComponent(w.runRef)}>Inspect runtime window</LinkButton>:"No admitted run"])}/>:<p>No runtime windows have been returned. This is not evidence that a provider has never run.</p>}
  <Small>{r.coverage.returned} windows returned; total unknown. {r.coverage.partial?"Additional windows may exist.":""}</Small></>;
 }
 if(entry.kind==="runtimeRun"){
  const r=entry.data;
  return <><h3>Runtime run and takeover</h3><DetailRows rows={[
   ["Run",r.runRef],["State / control",r.state+" / "+r.control],["Execution certainty",r.executionCertainty],["Registration version",String(r.registrationVersion)],
   ["Window",r.windowStart+" → "+r.windowEnd],["Source observation",r.sourceObservedAt],["Source freshness",r.sourceFresh?"Current":"Stale"],["Source coverage",r.sourceCoverage],
   ["Next action",r.nextAction],["Blockers",r.blockers.join(" · ")||"None returned"],["Continuation",r.hasContinuation?"Checkpoint continuation available":"None returned"],
   ["Usage coverage",r.usage.coverage],["Observed cost",r.usage.observedCostMinor===null?"Unknown":String(r.usage.observedCostMinor)+" minor units · "+(r.usage.currency??"currency unknown")],["Cost coverage",r.usage.costCoverage],
  ]}/><LinkButton variant="secondary" to={"/runs/"+encodeURIComponent(r.runRef)+"?tab=recovery"}>Inspect runtime recovery</LinkButton>
  {r.takeovers.length?<DataTable caption="Source-owned takeover state" columns={[{label:"Item / version"},{label:"Reason"},{label:"Assigned owner"},{label:"Resolution"}]} rows={r.takeovers.map(t=>[t.itemRef+" · "+t.version,t.kind,t.ownerAlias,t.resolved?"Source resolution recorded":"Awaiting source resolution"])}/>:<p>No takeover record was returned for this run.</p>}
  <Small>Requesting takeover does not assign a worker lease or resolve login, MFA, UI drift or changed terms. Uncertain work must reconcile its original attempt.</Small></>;
 }
 if(entry.kind==="report"){
  const r=entry.data;
  return <><h3>Report receipt and recovery</h3><DetailRows rows={[
   ["Report",r.reportRef],["Report run",r.runRef],["State",r.state],["Execution certainty",r.executionCertainty],["Source effect",r.sourceEffect],
   ["Current source holds",r.current.reasonCodes.join(" · ")],["Observed",r.observedAt],["Receipt",r.receipt?.receiptRef??"No confirmed delivery receipt"],
   ["Receipt observation",r.receipt?.observedAt??"Unavailable"],["Thread reference",r.receipt?.threadRef??"Unavailable"],["Usage / cost",r.usage.zapierTasks+" / "+r.usage.cost],
  ]}/><Small>A confirmed report receipt proves that recorded internal post only. Setup posts, channel membership and saved drafts do not prove an adopted programme or active recurrence. Uncertain delivery retains its original report key for source lookup.</Small></>;
 }
 const title=entry.kind==="repairReceipt"?"Source-owned repair":entry.kind==="permissionReceipt"?"Permission evidence write":"Takeover receipt";
 return <><h3>{title}</h3><DetailRows rows={[
  ["Receipt",entry.receiptRef],["Stage",entry.state],["Source owner",entry.ownerRef],["Source version",entry.sourceVersion],["Observed",entry.observedAt],
  ["Source readback version",entry.sourceReadbackVersion??"Not verified"],["Mirror readback version",entry.mirrorReadbackVersion??"Not verified"],
 ]}/><Small>{entry.kind==="repairReceipt"?entry.state==="resolved"?"The source reports a resolved incident with matching source/mirror readback and a complete comparison.":"A request or write acknowledgment does not resolve the conflict. Source-owned conditional repair, matching source/mirror readback and a complete comparison are required. Local-owned and unknown-version fields remain protected.":entry.kind==="permissionReceipt"?"Recording evidence does not grant provider authority or change capability to Ready.":"Source assignment and source resolution are separate stages. An uncertain original attempt must be reconciled before another attempt."}</Small></>;
}
