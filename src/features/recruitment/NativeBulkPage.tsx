import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { scopeKey, useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import { protectedRead, useView } from "@/adapter/useView";
import type { ReadResponse } from "@/adapter/contract";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Kpi, KpiRow } from "@/components/Kpi";
import type { BulkReadData } from "@/creator-agent/bulk/views";
import { reviewValue } from "@/features/approvals/NativeReview";
import { blockedReason, dateTime } from "@/features/approvals/shared";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { PageTitle, Pending, StaleNotice } from "@/features/creators/creatorsShared";
import { bulkPreviewStorageKey, readBulkPreview, rememberBulkPreview, verifiedBulkPreviewResult, type BulkPreviewMarker } from "./bulkPreviewRecovery";
import { acquisition, ContextBox, creators, styles } from "./recruitmentShared";

const money=(minor:number|null|undefined)=>minor===null||minor===undefined?"Unknown":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(minor/100);
const names={invitation:"Invitation",activation:"Activation",sampleDecision:"Separate sample decision"};
export function NativeBulkPage(){
  const {batchId=""}=useParams(),[search]=useSearchParams(),ctx=useScope();
  const filters={context:"bulk" as const,batchRef:batchId,batchVersion:search.get("batchVersion")??""};
  const query=useView<typeof filters,BulkReadData>("batchDetail",filters,null),data=query.data?.data;
  const lease=useSourceLease(data?.validUntil);
  const current=Boolean(data&&lease&&!query.isError&&!query.isFetching&&!query.isPlaceholderData&&query.data?.dataState==="ready"&&data.filters.batchRef===filters.batchRef&&data.filters.batchVersion===filters.batchVersion);
  return <section aria-labelledby="bulk-title" data-figma-source="66:821" className={acquisition.page}>
    {!data&&<PageTitle id="bulk-title" title="Scale the work. Keep control." subtitle="Finite source-bound work">{null}</PageTitle>}
    <Pending query={query} subject="the finite bulk manifest">{data?.kind==="native-bulk"&&query.data&&<BulkBody key={JSON.stringify([scopeKey(ctx),data.actorRef,batchId])} data={data} res={query.data} current={current} refresh={()=>void query.refetch()}/>}</Pending>
  </section>;
}
function BulkBody({data,res,current,refresh}:{data:BulkReadData;res:ReadResponse<BulkReadData>;current:boolean;refresh:()=>void}){
  const [search,setSearch]=useSearchParams(),[inspected,setInspected]=useState<string|null>(null);
  const tab=["detail","exceptions","capacity","samples"].includes(search.get("tab")??"")?search.get("tab")!:"detail";
  const setTab=(value:string)=>{const next=new URLSearchParams(search);next.set("tab",value);setSearch(next);};
  const counts=data.aggregateCounts,maximum=Math.max(1,...data.primaryCounts.map(r=>r.count));
  const countNames={confirmed:"Confirmed",failed:"Failed",blocked:"Blocked",deferred:"Deferred",uncertain:"Reconcile",canceled:"Canceled unsent",ready:"Ready for review"};
  const countClass={confirmed:styles.sConfirmed,failed:styles.sLogin,blocked:styles.sMuted,deferred:styles.sQueued,uncertain:styles.sReconcile,canceled:styles.sMuted,ready:styles.sQueued};
  const sample=current?data.sampleCommitments:null;
  const inspectedRow=current?data.rows.find(r=>r.rowId===inspected):null;
  const runs=[...new Set(data.groups.flatMap(g=>g.runRefs))];
  return <>
    <PageTitle id="bulk-title" title="Scale the work. Keep control." subtitle={`${data.filters.batchRef} · ${data.provenance.synthetic?"Fictional finite batch · no live dispatch":"Source-bound finite batch"}`}>
      <div className={styles.headingActions}><div><Button variant="secondary" disabledReason={!current?"Refresh current evidence.":!runs.length?"No canonical run exists yet.":null} onClick={()=>setTab("capacity")}>Review pause controls</Button></div><div><Button onClick={()=>setTab("detail")}>Review batch receipts</Button></div></div>
    </PageTitle>
    <nav className={styles.buttons} aria-label="Batch sections"><LinkButton variant="ghost" to="/automations">Operations queue</LinkButton>{["detail","exceptions","capacity","samples"].map(value=><Button key={value} variant={tab===value?"primary":"ghost"} aria-pressed={tab===value} onClick={()=>setTab(value)}>{value==="detail"?"Batch detail":value[0]!.toUpperCase()+value.slice(1)}</Button>)}</nav>
    <StaleNotice res={res}/>{!current&&<p role="status">Current source permission or version is unavailable. Refresh before any action.</p>}
    <ContextBox title={data.provenance.synthetic?"Fictional integration evidence · no live dispatch":"Current source-owned batch"} text="Commission-only acquisition remains mandatory. Invitation, activation and sample decisions have separate immutable approvals; viewing a batch authorizes none of them."><div className={styles.buttons}><LinkButton variant="secondary" to="/creators/discovery">Daily sourcing</LinkButton><LinkButton variant="secondary" to="/creators/pipeline">Full acquisition funnel</LinkButton></div></ContextBox>
    <ContextBox title="Approval binds this exact finite set" text={`${current?counts.snapshot:"Unknown"} selected rows. Recipients, products, payloads, evidence, model, terms and expiration are frozen together. Changed economics or membership require fresh review. Unknown willingness may permit an invitation, never activation.`}/>
    <KpiRow><Kpi label="Selected prospects" context="Complete finite source membership">{current?counts.snapshot:"Unknown"}</Kpi><Kpi label="Finite action groups" context="Each group requires its own exact approval">{current?data.groups.length:"Unknown"}</Kpi><Kpi label="Sample allocation" context={sample?`${data.rows.filter(r=>r.sampleDisposition==="noNewSample").length} no-new-sample rows · separate approval`:"Unknown until separate approval proof is returned"}>{sample?`${sample.approvedUnits} / ${money(sample.approvedMinor)}`:"Unknown"}</Kpi><Kpi label="Fixed-fee commitment" context="New acquisition has no upfront or guaranteed fee">{current?"$0":"Unknown"}</Kpi></KpiRow>
    {tab==="detail"&&<section className={creators.panel} aria-labelledby="bulk-outcomes"><h2 id="bulk-outcomes" className={acquisition.h2}>{current?counts.confirmed:"Unknown"} confirmed. Every other item has a next step.</h2><p className={acquisition.small}>Counts partition the frozen recipient set. A recipient is confirmed only when all included actions have authoritative receipts; a local artifact never proves a live provider effect.</p>
      {current&&<><ul className={styles.statusBar} aria-label="Exclusive bulk outcome counts">{Object.entries(countNames).map(([key,label])=>{const k=key as keyof typeof countNames,n=counts[k];return n>0?<li key={k} className={`${styles.seg} ${countClass[k]}`} style={{flex:n}} aria-label={`${label}: ${n}`}>{n}</li>:null;})}</ul><p className={acquisition.small}>{Object.entries(countNames).map(([key,label])=>`${label}: ${counts[key as keyof typeof countNames]}`).join(" · ")}</p></>}
      <DataTable caption="Exact finite bulk rows" minWidth={1040} columns={[{label:"Recipient"},{label:"Product / sample"},{label:"Primary summary"},{label:"All blockers"},{label:"Receipts"},{label:"Recovery"}]} rows={data.rows.map(row=>{
        const receipts=current?data.rowReceipts.filter(r=>r.rowId===row.rowId):[],recovery=current?data.recoveryQueue.filter(r=>r.rowId===row.rowId):[];
        return [reviewValue(row.recipient,current),<span key="product">{reviewValue(row.product,current)} · {current?row.sampleDisposition:"Unknown"}</span>,current?`${row.state} · ${row.primarySummaryReason??"No held reason"}`: "Unknown",current?row.allBlockers.join(" · ")||"No row blockers returned":"Unknown",current?`${receipts.length} ${data.provenance.synthetic?"local artifact":"source"} receipts`:"Unknown",<div key="recovery"><Button variant="ghost" disabledReason={!current?"Refresh current display permission.":null} onClick={()=>setInspected(row.rowId)}>Inspect row</Button>{recovery.map(r=><LinkButton key={`${r.groupRef}:${r.runRef}`} variant="ghost" to={`/runs/${encodeURIComponent(r.runRef)}?tab=recovery`}>{r.nextAction}</LinkButton>)}</div>];})}/>
      <p>Confirmed effects cannot be erased. Pause stops new starts; in-flight and uncertain rows retain their original reconciliation path.</p>
    </section>}
    {(tab==="detail"||tab==="exceptions")&&<section className={creators.panel} aria-labelledby="bulk-held"><h2 id="bulk-held" className={acquisition.h2}>Keep held prospects visible.</h2><p className={acquisition.small}>Every row retains all blockers. One deterministic primary reason counts each held recipient once.</p>
      {current&&<ul className={styles.bars} aria-label="Exclusive primary blockers">{data.primaryCounts.map(r=><li key={r.reason} className={styles.bar}><span className={styles.name}>{r.reason.replaceAll("_"," ")}</span><span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{display:"block",width:`${r.count/maximum*100}%`}}/></span><span className={styles.count}>{r.count} rows</span></li>)}</ul>}
      {current&&data.primaryCounts.length===0&&<p>No held row was returned; current row preflight still applies.</p>}
      <Button variant="secondary" onClick={()=>setTab("exceptions")}>Review held rows</Button>
      {tab==="exceptions"&&<DataTable caption="All held bulk reasons" columns={[{label:"Recipient"},{label:"Primary reason"},{label:"Every blocker"}]} rows={data.rows.filter(r=>r.allBlockers.length).map(r=>[reviewValue(r.recipient,current),current?r.primarySummaryReason:"Unknown",current?r.allBlockers.join(" · "):"Unknown"])}/>}
    </section>}
    {(tab==="detail"||tab==="capacity")&&<section className={creators.panel} aria-labelledby="bulk-gates"><h2 id="bulk-gates" className={acquisition.h2}>Recheck before each write.</h2><p>Actual provider account, action, quota unit and reset stay separate from active collaboration capacity. These observations do not reserve capacity.</p>
      <DataTable caption="Source capacity observations" columns={[{label:"Provider / action"},{label:"Capacity type"},{label:"Remaining / unit"},{label:"Source reset"}]} rows={data.capacity.map(c=>[current?`${c.provider} / ${c.action}`:"Unknown",c.kind,current?`${c.remaining??"Unknown"} / ${c.unit}`:"Unknown",current&&c.resetAt?dateTime(c.resetAt):"Unknown"])}/>
      {!data.capacity.length&&<p>Source capacity was not returned; no limit is assumed.</p>}
      <p>Forecast commission: {current?money(data.commissionForecastMinor):"Unknown"}. This estimate never caps earned commission.</p>
      <p>Pause, cancel unsent and resume operate on each original run. Source authority, policy, offers and capacity are rechecked before resume.</p>
      <div className={styles.buttons}>{current&&runs.map(ref=><LinkButton key={ref} variant="secondary" to={`/runs/${encodeURIComponent(ref)}?tab=recovery`}>Open original run controls</LinkButton>)}<LinkButton variant="secondary" to="/settings/capabilities">Open capacity and access</LinkButton></div>
    </section>}
    {tab==="samples"&&<section className={creators.panel} aria-labelledby="bulk-samples"><h2 id="bulk-samples" className={acquisition.h2}>Separate approved sample commitments</h2><p>Approved: {sample?`${sample.approvedUnits} samples / ${money(sample.approvedMinor)}`:"Unknown"}. Remaining: {sample?`${sample.remainingUnits??"Unknown"} samples / ${money(sample.remainingMinor)}`:"Unknown"}.</p><p>Uncertain sample outcomes make remaining allocation unknown until original receipt reconciliation.</p>{sample&&<ul>{sample.reasonCodes.map(r=><li key={r}>{r}</li>)}</ul>}</section>}
    <section className={creators.panel} aria-labelledby="bulk-approvals"><h2 id="bulk-approvals" className={acquisition.h2}>Inspect each exact approval manifest.</h2><p>These proposals cannot send invitations, activate collaborations or purchase samples. Each domain owns its current policy, source and execution proof.</p>{data.groups.map(g=><BulkGroup key={g.groupRef} group={g} data={data} res={res} current={current} refresh={refresh}/>)}</section>
    <Button variant="secondary" onClick={refresh}>Refresh batch evidence</Button>
    <Dialog open={inspected!==null} title="Exact row evidence" onClose={()=>setInspected(null)}>{inspectedRow?<><p>{reviewValue(inspectedRow.recipient,current)} · {reviewValue(inspectedRow.product,current)}</p><p>Primary: {inspectedRow.primarySummaryReason??"No held reason"}</p><p>All blockers: {inspectedRow.allBlockers.join(" · ")||"None returned"}</p><p>Sample: {inspectedRow.sampleDisposition}</p><ul>{data.rowReceipts.filter(r=>r.rowId===inspectedRow.rowId).map(r=><li key={`${r.groupRef}:${r.receiptRef}`}>{r.sourceEffect} · {r.receiptRef}</li>)}</ul></>:<p>Current row permission is unavailable. Refresh before reviewing protected evidence.</p>}<Button variant="secondary" onClick={()=>setInspected(null)}>Close row evidence</Button></Dialog>
  </>;
}
function BulkGroup({group,data,res,current,refresh}:{group:BulkReadData["groups"][number];data:BulkReadData;res:ReadResponse<BulkReadData>;current:boolean;refresh:()=>void}){
  const ctx=useScope(),client=useQueryClient(),action=useAction<BulkPreviewMarker["payload"]>(),busy=useRef(false);
  const storageKey=bulkPreviewStorageKey(scopeKey(ctx),data.actorRef,data.filters.batchRef,group.groupRef);
  const [saved,setSaved]=useState(()=>readBulkPreview(storageKey,data.actorRef,group.groupRef)),[error,setError]=useState<string|null>(null);
  const [originalResult,setOriginalResult]=useState<ReturnType<typeof verifiedBulkPreviewResult>>(null);
  const alive=useRef(true),live=useRef({actorRef:data.actorRef,storageKey});
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useLayoutEffect(()=>{live.current={actorRef:data.actorRef,storageKey};},[data.actorRef,storageKey]);
  const hold=!current?"Refresh current source evidence.":saved.invalid?"Original preview metadata is invalid; owner reconciliation is required.":saved.marker?null:group.approval?"Review the existing immutable manifest.":!group.preview?"No eligible finite action is available.":blockedReason(res,group.actionKind);
  async function preview(){
    if(hold||busy.current)return;
    const prior=readBulkPreview(storageKey,data.actorRef,group.groupRef);if(prior.invalid){setSaved(prior);return;}
    if(!prior.marker&&!group.preview)return;
    const marker=prior.marker??{requestKey:crypto.randomUUID(),actorRef:data.actorRef,groupRef:group.groupRef,actionKind:group.actionKind,payload:group.preview!};
    busy.current=true;rememberBulkPreview(storageKey,marker);setSaved({marker,invalid:false});setError(null);
    try{
      const ack=await protectedRead(client,scopeKey(ctx),marker.requestKey,()=>action.mutateAsync({operation:"previewAction",actionKind:marker.actionKind,entityRefs:[],expectedVersion:marker.payload.entityVersion,approvalRef:null,manifestRef:null,runRef:null,payload:marker.payload,idempotencyKey:marker.requestKey}));
      const result=verifiedBulkPreviewResult(ack,ctx.scope);
      if(!result)throw new Error("Original result was not an exact scoped preview acknowledgment.");
      if(alive.current&&live.current.actorRef===marker.actorRef&&live.current.storageKey===storageKey)setOriginalResult(result);
    }catch{if(alive.current&&live.current.storageKey===storageKey)setError("Original preview needs authoritative readback. Keep its original key; no action was authorized by this proposal.");}
    finally{busy.current=false;refresh();}
  }
  return <div className={styles.notice}><h3 className={styles.noticeTitle}>{names[group.kind]}</h3><p>{current?group.preview?.selectionRefs.length??0:"Unknown"} exact eligible actions · {current?group.reasonCodes.join(" · ")||"Source review available":"Current permission unavailable"}</p>
    {error&&<p role="alert">{error}</p>}
    {current&&originalResult&&<LinkButton to={`/approvals/${encodeURIComponent(originalResult.approvalRef)}?version=v${originalResult.manifestVersion}`}>Review original recorded preview</LinkButton>}
    {current&&group.approval&&<LinkButton to={`/approvals/${encodeURIComponent(group.approval.approvalRef)}?version=v${group.approval.manifestVersion}`}>Review {names[group.kind].toLowerCase()} approval</LinkButton>}
    {(!group.approval||saved.marker&&!originalResult)&&<><Button disabledReason={hold} loading={action.isPending} onClick={()=>void preview()}>{saved.marker?"Recover original preview":`Preview ${names[group.kind].toLowerCase()}`}</Button>{saved.marker&&!originalResult&&<p role="status">Original request retained. Only canonical approval readback confirms this preview; it is not permission to dispatch.</p>}</>}
  </div>;
}
