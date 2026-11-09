import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { scopeKey, useScope } from "@/adapter/scope";
import type { ReadResponse } from "@/adapter/contract";
import { Button, LinkButton } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Kpi, KpiRow } from "@/components/Kpi";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { NativeCommandFeedback, nativeBlocked, useNativeCommand } from "@/features/approvals/NativeApprovalActions";
import { NativeRunRecovery } from "@/features/approvals/NativeRunRecovery";
import { permittedReviewUrl, reviewValue } from "@/features/approvals/NativeReview";
import { dateTime } from "@/features/approvals/shared";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { PageTitle, Pending, StaleNotice } from "@/features/creators/creatorsShared";
import type { NativeRecruitmentBatch, RecruitmentBatchFilters } from "@/creator-agent/recruitment/contract";
import { RecruitmentCapacity, RecruitmentSamples } from "./NativeRecruitmentParts";
import { acquisition, ContextBox, creators, styles } from "./recruitmentShared";

const sources=[{value:"all",label:"All sources"},{value:"social-cat",label:"Social Cat"},{value:"tiktok",label:"TikTok"}];
const deals=[{value:"all",label:"All deal histories"},{value:"affiliate",label:"Affiliate"},{value:"historical",label:"Historical obligations"}];
const deadlines=[{value:"all",label:"All deadlines"},{value:"overdue",label:"Overdue"},{value:"dated",label:"Source deadline known"},{value:"undated",label:"Deadline unknown"}];
const money=(minor:number|null)=>minor===null?"Unknown":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(minor/100);
type Item=NativeRecruitmentBatch["run"]["items"][number];
export function knownUnsent(item:Item|undefined) {
  return Boolean(item&&!item.receiptRef&&item.execution?.attemptOutcome.state==="unstarted"&&item.execution.attempts===0&&["queued","held","retryWait"].includes(item.execution.state));
}
export function batchOutcome(item:Item|undefined) {
  if(!item)return "Unknown · no exact run item";
  if(item.receiptRef&&item.observedAt&&item.sourceEffect)return item.sourceEffect==="localArtifact"?"Local artifact confirmed":item.providerOutcome?.state==="rejected"?"Provider rejected · receipt confirmed":"Provider receipt confirmed";
  const e=item.execution;
  if(!e)return "Unknown · state not returned";
  if(e.attemptOutcome.state==="open"||e.attemptOutcome.state==="unknown")return "Reconcile original outcome";
  if(e.recovery?.nextAction==="waitForSourceReset")return "Quota deferred · source reset required";
  if(e.recovery?.nextAction==="signInAtSource"||e.recovery?.nextAction==="completeMfaAtSource")return "Login / MFA owner handoff";
  return `${e.state} · ${e.reasonCode??"no provider result confirmed"}`;
}

export function NativeBatchPage() {
  const {batchId=""}=useParams(),[search,setSearch]=useSearchParams(),ctx=useScope();
  const source=search.get("source"),deal=search.get("deal"),deadline=search.get("deadline");
  const filters:RecruitmentBatchFilters={context:"recruitment",batchId,source:source==="social-cat"||source==="tiktok"?source:"all",deal:deal==="affiliate"||deal==="historical"?deal:"all",owner:search.get("owner"),deadline:deadline==="overdue"||deadline==="dated"||deadline==="undated"?deadline:"all"};
  const query=useView<RecruitmentBatchFilters,NativeRecruitmentBatch>("batchDetail",filters,null);
  const data=query.data?.data,lease=useSourceLease(data?.validUntil);
  const current=Boolean(data&&lease&&!query.isError&&!query.isFetching&&!query.isPlaceholderData&&query.data?.dataState==="ready"&&Object.entries(filters).every(([key,value])=>data.filters[key as keyof RecruitmentBatchFilters]===value));
  const setParam=(key:string,value:string)=>{const next=new URLSearchParams(search);if(value==="all")next.delete(key);else next.set(key,value);setSearch(next);};
  return <section aria-labelledby="batch-title" data-figma-source="66:821" className={acquisition.page}>
    {!data&&<PageTitle id="batch-title" title="Scale the work. Keep control." subtitle="Finite source-bound recruitment work"/>}
    <Pending query={query} subject="the finite recruitment batch">{data?.kind==="native-recruitment-batch"&&query.data&&<NativeBatchBody key={JSON.stringify([scopeKey(ctx),batchId])} data={data} res={query.data} current={current} setParam={setParam} refresh={()=>void query.refetch()}/>}</Pending>
  </section>;
}

function NativeBatchBody({data,res,current,setParam,refresh}:{data:NativeRecruitmentBatch;res:ReadResponse<NativeRecruitmentBatch>;current:boolean;setParam:(key:string,value:string)=>void;refresh:()=>void}) {
  const command=useNativeCommand("run",data.run.runRef),[search,setSearch]=useSearchParams();
  const tab=["detail","exceptions","capacity","samples"].includes(search.get("tab")??"")?search.get("tab")!:"detail";
  const setTab=(value:string)=>{const next=new URLSearchParams(search);next.set("tab",value);setSearch(next);};
  const [selected,setSelected]=useState<{version:string;refs:string[]}>({version:data.run.version,refs:[]});
  const [cancel,setCancel]=useState<{version:string;refs:string[]}|null>(null),[receipt,setReceipt]=useState<Item|null>(null),[pause,setPause]=useState<string|null>(null);
  const refs=selected.version===data.run.version?selected.refs:[];
  const item=(ref:string)=>data.run.items.find(i=>i.itemRef===ref);
  const confirmed=data.run.items.filter(i=>i.receiptRef&&i.observedAt&&i.sourceEffect).length;
  const categories=[{label:"Receipt confirmed",className:styles.sConfirmed,match:(i:Item)=>Boolean(i.receiptRef&&i.observedAt&&i.sourceEffect)},
    {label:"Uncertain",className:styles.sReconcile,match:(i:Item)=>i.execution?.attemptOutcome.state==="open"||i.execution?.attemptOutcome.state==="unknown"||i.execution?.state==="reconcile"},
    {label:"Login / MFA",className:styles.sLogin,match:(i:Item)=>["login","mfa"].includes(i.execution?.recovery.kind??"")},
    {label:"Running",className:styles.sRunning,match:(i:Item)=>i.execution?.state==="leased"},
    {label:"Queued / held",className:styles.sQueued,match:(i:Item)=>knownUnsent(i)},
    {label:"Other recorded state",className:styles.sMuted,match:()=>true}];
  const counts=categories.map((category,index)=>({...category,count:data.run.items.filter(item=>categories.findIndex(c=>c.match(item))===index).length}));
  const reasons=[...new Set(data.rows.filter(row=>row.membership==="held").flatMap(row=>row.holdReasons))].map(reason=>({reason,count:data.rows.filter(row=>row.membership==="held"&&row.holdReasons.includes(reason)).length}));
  const heldMaximum=Math.max(1,...reasons.map(r=>r.count));
  const held=data.rows.filter(r=>r.membership==="held");
  const base={entityRefs:[],expectedVersion:data.run.version,approvalRef:data.run.approvalRef,manifestRef:data.run.manifestRef,runRef:data.run.runRef};
  const hold=(action:string)=>!current?"Refresh current complete source evidence.":nativeBlocked(res,action,command.pending);
  const source=permittedReviewUrl(data.sourceLink,current);
  const choose=(ref:string,checked:boolean)=>setSelected({version:data.run.version,refs:checked?[...refs,ref]:refs.filter(r=>r!==ref)});
  const submitCancel=()=>{
    if(!cancel||hold("cancelUnsent")||cancel.version!==data.run.version)return;
    void command.submit({...base,expectedVersion:cancel.version,operation:"controlRun",actionKind:"cancelUnsent",payload:{control:"cancel",itemRefs:cancel.refs}});setCancel(null);
  };
  return <>
    <PageTitle id="batch-title" title="Scale the work. Keep control." subtitle={`${data.batchId} · ${data.sourceState} source membership`}>
      <Button variant="secondary" disabledReason={hold("pauseRun")??(data.run.control!=="active"?"This run is not active.":null)} loading={command.busy} aria-haspopup="dialog" onClick={()=>setPause(data.run.version)}>Pause new work</Button>
      <LinkButton to={`/runs/${encodeURIComponent(data.run.runRef)}?tab=recovery`}>Review batch receipt</LinkButton>
    </PageTitle>
    <nav className={styles.buttons} aria-label="Batch sections"><LinkButton variant="ghost" to="/automations">Operations queue</LinkButton>{["detail","exceptions","capacity","samples"].map(value=><Button key={value} variant={tab===value?"primary":"ghost"} aria-pressed={tab===value} onClick={()=>setTab(value)}>{value==="detail"?"Batch detail":value[0]!.toUpperCase()+value.slice(1)}</Button>)}</nav>
    <StaleNotice res={res}/>{!current&&<p role="status">Current source permission or version is unavailable. Refresh before any action; retained state does not authorize new work.</p>}
    <ContextBox title="Approval binds this exact finite set" text={<>{data.coverage.returned} of {data.coverage.total} source rows returned. Named recipients, saved terms and sample allocations stay bound to the immutable manifest. Changed terms or new recipients need a new approval.</>}/>
    <KpiRow><Kpi label="Selected prospects" context={data.coverage.complete?"Complete source membership":"Partial membership · no missing rows inferred"}>{data.coverage.total}</Kpi><Kpi label="Finite dispatch limit" context="Exact approved manifest">{data.approval.bounds.maxItems}</Kpi><Kpi label="Sample allocation" context="Units and authorized cost are separate limits">{data.approval.bounds.maxUnits} / {money(data.approval.bounds.maxSpendMinor)}</Kpi><Kpi label="Forecast commission" context="An estimate, never a cap on earned commission">{money(data.forecastCommissionMinor)}</Kpi></KpiRow>
    <NativeCommandFeedback command={command}/>
    {tab==="detail"&&<section className={creators.panel} aria-labelledby="batch-results-title"><h2 id="batch-results-title" className={acquisition.h2}>{confirmed} receipt-backed outcomes. Every other item has a next step.</h2>
      <p className={acquisition.small}>All returned rows are shown. A missing receipt is not proof that an action is unsent. Provider acknowledgment does not imply acceptance, publication or payment.</p>
      <ul className={styles.statusBar} aria-label="Canonical batch outcome counts">{counts.filter(c=>c.count>0).map(c=><li key={c.label} className={`${styles.seg} ${c.className}`} style={{flex:c.count}} aria-label={`${c.label}: ${c.count}`}>{c.count}</li>)}</ul>
      <p className={acquisition.small}>{counts.map(c=>`${c.label}: ${c.count}`).join(" · ")}. Counts describe this exact run, not the whole source population.</p>
      <div className={styles.buttons}><Button variant="secondary" disabledReason={hold("cancelUnsent")??(!refs.length?"Select exact known-unsent rows first.":null)} onClick={()=>setCancel({version:data.run.version,refs:[...refs]})}>Cancel unsent</Button><LinkButton variant="secondary" to={`/runs/${encodeURIComponent(data.run.runRef)}?tab=execution`}>Inspect live step</LinkButton></div>
      <DataTable caption="Exact finite batch outcomes" minWidth={1040} columns={[{label:"Select unsent"},{label:"Recipient"},{label:"Bound terms"},{label:"Evidence"},{label:"Next action / deadline"},{label:"Outcome"},{label:"Control"}]} rows={data.rows.map(row=>{
        const execution=item(row.itemRef),unsent=knownUnsent(execution);
        return [<Checkbox key={row.itemRef} label={`Select ${reviewValue(row.recipient,current)}`} checked={refs.includes(row.itemRef)} disabled={!current||!unsent||command.pending} onChange={checked=>choose(row.itemRef,checked)}/>,reviewValue(row.recipient,current),reviewValue(row.terms,current),row.membership==="held"?row.holdReasons.join(" · "):execution?.receiptRef??"No source receipt",`${reviewValue(row.owner,current)} · ${row.deadline?dateTime(row.deadline):"Deadline unknown"}`,batchOutcome(execution),<Button key={row.itemRef} variant="ghost" disabledReason={!execution?"No exact run item is available.":null} onClick={()=>setReceipt(execution??null)}>Inspect item</Button>];
      })}/>
      {!data.rows.length&&<p>No source rows match these filters.</p>}
      <p>Confirmed sends cannot be canceled. Pause stops new work while in-flight work retains its original outcome and reconciliation path.</p>
    </section>}
    {(tab==="detail"||tab==="exceptions")&&<section className={creators.panel} aria-labelledby="batch-held-title"><h2 id="batch-held-title" className={acquisition.h2}>Keep held prospects visible.</h2>
      <div className={styles.buttons}><FilterButton name="Source" title="Filter source" value={data.filters.source} options={sources} onChange={v=>setParam("source",v)}/><FilterButton name="Deal" title="Filter deal history" value={data.filters.deal} options={deals} onChange={v=>setParam("deal",v)}/><FilterButton name="Owner" title="Filter source owner" value={data.filters.owner??"all"} options={[{value:"all",label:"All owners"},...data.owners.map(o=>({value:o.ref,label:reviewValue(o.label,current)}))]} onChange={v=>setParam("owner",v)}/><FilterButton name="Deadline" title="Filter native deadline" value={data.filters.deadline} options={deadlines} onChange={v=>setParam("deadline",v)}/></div>
      <ul className={styles.bars} aria-label="Held reasons among returned rows">{reasons.map(row=><li key={row.reason} className={styles.bar}><span className={styles.name}>{row.reason.replaceAll("_"," ")}</span><span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{display:"block",width:`${row.count/heldMaximum*100}%`}}/></span><span className={styles.count}>{row.count} rows</span></li>)}</ul><p className={acquisition.small}>A row can have several reasons; these counts are not added into a second prospect total.</p>
      <div className={styles.buttons} aria-label="Checkout-selected model status">{data.models.map(model=><span key={model.route} className={styles.readonly}>{model.route}: {current?model.name??"Model unknown":"Model unknown"} · {current?model.state:"unknown"} · {current?model.version??"Version unknown":"Version unknown"}</span>)}</div><p className={acquisition.small}>Models are source-selected by checkout route. Missing or unpublished configuration does not produce an approved score.</p>
      <DataTable caption="Held batch rows" columns={[{label:"Recipient"},{label:"Reason"},{label:"Owner"},{label:"Deadline"}]} rows={held.map(r=>[reviewValue(r.recipient,current),r.holdReasons.join(" · "),reviewValue(r.owner,current),r.deadline?dateTime(r.deadline):"Unknown"])}/>{!held.length&&<p>No held rows were returned for these filters. This does not establish permission for missing or unreturned rows.</p>}
      <Button variant="secondary" onClick={()=>setTab("exceptions")}>Review held rows</Button>
    </section>}
    {(tab==="detail"||tab==="capacity")&&<RecruitmentCapacity values={data.capacity} current={current}/>}
    {tab==="samples"&&<RecruitmentSamples values={data.samples} current={current}/>}
    <div className={styles.buttons}><LinkButton to={`/approvals/${encodeURIComponent(data.approval.approvalRef)}?version=v${data.approval.manifestVersion}`}>Inspect approval manifest</LinkButton><Button variant="secondary" aria-haspopup="dialog" disabledReason={hold("cancelUnsent")??(!refs.length?"Select current known-unsent items first.":null)} onClick={()=>setCancel({version:data.run.version,refs:[...refs]})}>Cancel selected unsent items</Button><Button variant="secondary" onClick={refresh}>Refresh batch evidence</Button>{source?<a href={source} target="_blank" rel="noopener noreferrer">Open permitted source</a>:<span>No currently permitted source link</span>}</div>
    <Dialog open={pause!==null} title="Pause new batch work" onClose={()=>setPause(null)}><p>Pause new work on this exact finite run. In-flight attempts keep their original outcomes and remain eligible for reconciliation.</p><p>Reviewed version: {pause}</p><Button disabledReason={hold("pauseRun")??(pause!==data.run.version?"The run changed. Close and review its current version.":null)} loading={command.busy} onClick={()=>{if(pause===data.run.version&&!hold("pauseRun")){void command.submit({...base,operation:"controlRun",actionKind:"pauseRun",payload:{control:"pause"}});setPause(null);}}}>Confirm pause new work</Button><Button variant="secondary" onClick={()=>setPause(null)}>Keep current work</Button></Dialog>
    <Dialog open={cancel!==null} title="Review selected unsent cancellation" onClose={()=>setCancel(null)}><p>Only these {cancel?.refs.length??0} selected items will be requested. The server atomically rejects a selection containing in-flight, uncertain or already completed work.</p><ul>{cancel?.refs.map(ref=><li key={ref}>{ref}</li>)}</ul><p>Reviewed version: {cancel?.version}</p><Button disabledReason={hold("cancelUnsent")??(cancel?.version!==data.run.version?"The run changed. Close and review the current selection.":null)} loading={command.busy} onClick={submitCancel}>Request selected cancellation</Button><Button variant="secondary" onClick={()=>setCancel(null)}>Keep current work</Button></Dialog>
    <Dialog open={receipt!==null} title="Exact item outcome and recovery" onClose={()=>setReceipt(null)}>{receipt&&<NativeRunRecovery data={{items:[receipt]}} current={current}/>}<LinkButton variant="secondary" to={`/runs/${encodeURIComponent(data.run.runRef)}?tab=recovery`}>Open original run recovery</LinkButton><Button variant="secondary" onClick={()=>setReceipt(null)}>Close item evidence</Button></Dialog>
  </>;
}
