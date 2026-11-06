import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SCHEMA_VERSION, type ReadResponse } from "@/adapter/contract";
import { protectedRead, assertScopeMatches } from "@/adapter/useView";
import { scopeKey, useScope } from "@/adapter/scope";
import { LeaveGuard } from "@/components/LeaveGuard";
import { matchingProposal, pendingProposal, reasonFingerprint, rememberPending, savedPending, type PendingProposal } from "./proposalReconciliation";
import { useAction } from "@/adapter/useAction";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { TextField, SelectField } from "@/components/Field";
import { SectionTabs } from "@/components/SectionTabs";
import { DetailRows, Panel, Split, kit } from "@/components/PageKit";
import { formatMoneyExact } from "@/components/MetricValue";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { PageTitle, StaleNotice } from "@/features/creators/creatorsShared";
import { ContextBox, creators } from "@/features/recruitment/recruitmentShared";
import { intentHold, nativeCollaborationSchema, type NativeCollaborationData, type WorkflowIntent } from "@/creator-agent/collaborationWorkflowSchema";
import styles from "./Collaboration.module.css";

const titles: Record<WorkflowIntent["kind"],string>={review:"Request human review", "request-revision":"Request revision","reject-content":"Propose rejection",
  "approve-content":"Propose content approval",reminder:"Propose posting reminder","human-handoff":"Request publisher handoff",suppress:"Propose suppression",
  close:"Propose closure",repeat:"Propose repeat assessment","new-collaboration":"Propose new collaboration"};
const explain=(s:string)=>s.toLowerCase().replaceAll("_"," ");
type Selection={kind:WorkflowIntent["kind"];deliverableRef?:string;submissionVersion?:string;version:string};
type Props={data:NativeCollaborationData;res:ReadResponse<unknown>;tab:string;openEvidence:()=>void;reload:()=>Promise<{isSuccess:boolean;data?:ReadResponse<unknown>}>};
export function NativeCollaboration({data,res,tab,openEvidence,reload}:Props){
  const [selection,setSelection]=useState<Selection|null>(null),[reason,setReason]=useState(""),[outcome,setOutcome]=useState<WorkflowIntent["outcome"]>("completed");
  const context=useScope(), client=useQueryClient();
  const markerKey="collaboration-pending:"+JSON.stringify([scopeKey(context),data.sourceRef]);
  const [pending,setPending]=useState<PendingProposal|null>(()=>savedPending(markerKey));
  const [absentKey,setAbsentKey]=useState<string|null>(null);
  const [ack,setAck]=useState(""),[discard,setDiscard]=useState(false),[reviewing,setReviewing]=useState(false);
  const saveMarker=(marker:PendingProposal|null)=>{rememberPending(markerKey,marker);setPending(marker);};
  const action=useAction<WorkflowIntent>();
  const content=tab==="content",base="/collaborations/"+encodeURIComponent(data.collaborationRef),t=data.terms;
  const tabs=content||tab==="rights"?["overview","content","rights","payments"]:["overview","brief","content","messages","payments"];
  const tabLabel=(s:string)=>s==="overview"&&content?"Collaboration":s==="content"&&content?"Content review":s[0]!.toUpperCase()+s.slice(1);
  function control(kind:WorkflowIntent["kind"],d?:NativeCollaborationData["deliverables"][number]){
    const sourceHold=intentHold(data,kind,d?.ref);
    const blocked=pending?"Reconcile the pending local proposal first.":blockedReason(res,"proposeCollaborationReview") ?? (data.stale?"A fresh source read is required.":sourceHold?explain(sourceHold):null);
    return <Button key={kind} variant="secondary" disabledReason={blocked} aria-haspopup="dialog" onClick={()=>{
      setReason("");setOutcome("completed");setAck("");action.reset();setSelection({kind,deliverableRef:d?.ref,submissionVersion:d?.submissionVersion??undefined,version:res.dataVersion});
    }}>{titles[kind]}</Button>;
  }
  const currentTarget=data.deliverables.find(d=>d.ref===selection?.deliverableRef);
  const dirty=!!selection && !!reason.trim() && !pending;
  const close=()=>{if(dirty)setDiscard(true);else setSelection(null);};
  async function reconcile(marker:PendingProposal) {
    setReviewing(true);setAbsentKey(null);
    try {
      const requestId="collaboration-reconcile-"+crypto.randomUUID();
      const latest=await protectedRead(client,scopeKey(context),requestId,async()=>{
        const answer=await context.adapter.readView<{collaborationId:string;proposalRequestKey:string},NativeCollaborationData>({
          schemaVersion:SCHEMA_VERSION,operation:"readView",viewKey:"collaborationDetail",requestedScope:context.scope,
          filters:{collaborationId:data.collaborationRef,proposalRequestKey:marker.requestKey},period:null,sort:[],page:{limit:50,cursor:null},requestId
        });
        assertScopeMatches(answer,context.scope);
        return answer;
      });
      const parsed=nativeCollaborationSchema.safeParse(latest.data);
      if(!parsed.success || parsed.data.stale || parsed.data.coverage!=="complete" || parsed.data.collaborationRef!==data.collaborationRef ||
          parsed.data.actorRef!==marker.actorRef || parsed.data.proposalReconciliation?.requestKey!==marker.requestKey ||
          parsed.data.proposalReconciliation.actorRef!==marker.actorRef){
        setAck("The exact request receipt could not be verified. Further proposals are held.");return;
      }
      if(parsed.data.proposalReconciliation.state==="notApplied"){
        saveMarker(null);setSelection(null);setAck("This exact request was rejected at source version "+parsed.data.proposalReconciliation.currentVersion+". No proposal was created. Review the current record before starting again.");
        void reload();return;
      }
      if(parsed.data.proposalReconciliation.state==="notRecorded") {
        setAbsentKey(marker.requestKey);setAck("No committed receipt was found for this exact request. Only the original request can be retried.");return;
      }
      const proposal=matchingProposal(parsed.data,marker);
      if(!proposal){setAck("The receipt differs from this request. Further proposals are held for reconciliation.");return;}
      saveMarker(null);setAck("Proposal "+proposal.id+" is recorded for human approval.");setSelection(null);setReason("");
      void reload();
    }catch{setAck("The exact request receipt could not be read. Further proposals are held.");}
    finally{setReviewing(false);}
  }
  async function sendOriginal(initialMarker:PendingProposal,intent:WorkflowIntent,retry:boolean){
    let marker=initialMarker;
    setAbsentKey(null);saveMarker(marker);
    try {
      const receipt=await action.mutateAsync({operation:"requestApproval",actionKind:"proposeCollaborationReview",entityRefs:[],approvalRef:null,manifestRef:null,
        idempotencyKey:marker.requestKey,expectedVersion:marker.baseVersion,payload:intent});
      if(receipt.state!=="approvalPending" || receipt.executionCertainty!=="applied" || !receipt.receiptRefs.includes("proposal:"+receipt.actionRef) || !/^[a-f0-9]{64}$/.test(receipt.payloadVersion)){
        setAck("Proposal acknowledgment unverified. Reconcile the exact request before continuing.");return;
      }
      marker={...marker,actionRef:receipt.actionRef,digest:receipt.payloadVersion};saveMarker(marker);await reconcile(marker);
    }catch(error){
      if(!retry && (error as {body?:{executionCertainty?:string}})?.body?.executionCertainty==="notApplied")saveMarker(null);
      else setAck("Proposal outcome unverified. Read the exact request receipt again before continuing.");
    }
  }
  async function retryOriginal(){
    if(!pending || pending.actorRef!==data.actorRef || absentKey!==pending.requestKey || reviewing || action.isPending)return;
    if(await reasonFingerprint(reason)!==pending.reasonHash){setAck("Enter the original proposal reason to retry this exact request.");return;}
    const intent:WorkflowIntent={collaborationRef:data.collaborationRef,kind:pending.kind,reason:reason.trim(),
      ...(pending.deliverableRef?{deliverableRef:pending.deliverableRef,submissionVersion:pending.submissionVersion??undefined}:{}),
      ...(pending.outcome?{outcome:pending.outcome as WorkflowIntent["outcome"]}:{})};
    await sendOriginal(pending,intent,true);
  }
  async function submit(){
    if(!selection || !reason.trim() || reason.trim().length>1000 || savedPending(markerKey) || action.isPending || selection.version!==res.dataVersion)return;
    const intent:WorkflowIntent={collaborationRef:data.collaborationRef,kind:selection.kind,reason:reason.trim(),...(selection.deliverableRef?{deliverableRef:selection.deliverableRef,submissionVersion:selection.submissionVersion}:{}),
      ...(selection.kind==="close"?{outcome}: {})};
    let marker:PendingProposal;
    try{marker=await pendingProposal(intent,selection.version,data.actorRef);}catch{setAck("The proposal could not be verified locally. No request was submitted.");return;}
    if(savedPending(markerKey))return;
    await sendOriginal(marker,intent,false);
  }
  const agreement=t.agreementRef && t.acceptedAt ? "Agreement recorded "+t.acceptedAt : "Acceptance unverified";
  const btnRow={display:"flex",gap:"var(--space-8)",flexWrap:"wrap" as const};
  return <>
    <LeaveGuard dirty={dirty} subject="collaboration proposal"/>
    <PageTitle id="collab-title" title={content?"A draft becomes a usable asset.":"One collaboration. The whole story."} subtitle={data.title+" · "+(data.platform??"Platform unknown")}>
      <Button variant="secondary" onClick={openEvidence}>Saved evidence</Button>{control("review")}
    </PageTitle>
    <div className={creators.row}><SectionTabs label="Collaboration views" gap={12} tabs={tabs.map(name=>({label:tabLabel(name),to:base+"?tab="+name,width:146,current:name===tab}))}/>
      <Badge tone="violet">{data.stage??"Stage unknown"}</Badge></div>
    <ContextBox title={agreement} text={data.sourceRef+" · observed "+data.observedAt}>
      <div style={btnRow}><LinkButton variant="secondary" to="/creators/pipeline">Creator pipeline</LinkButton><Button variant="secondary" onClick={openEvidence}>Asset and renewal evidence</Button></div>
    </ContextBox>
    <StaleNotice res={res}/>{data.stale&&<p role="status">The source observation is stale. Refresh before proposing changes.</p>}
    {data.coverage==="partial"&&<p role="status">Deliverable coverage is partial. Review proposals are held until the source read completes.</p>}
    {pending&&<div role="alert"><p>An unresolved proposal is holding new requests for this collaboration.</p><Button variant="secondary" loading={reviewing} onClick={()=>void reconcile(pending)}>Reconcile saved proposal</Button>
      {absentKey===pending.requestKey&&<div><TextField label="Original proposal reason" value={reason} onChange={setReason} />
        <Button variant="secondary" loading={action.isPending} onClick={()=>void retryOriginal()}>Retry original request</Button></div>}</div>}
    {ack&&<p className={styles.ack} role="status">{ack}</p>}
    {tab==="overview"&&<Split><Panel title="Relationship timeline" headingId="native-history" note="Recorded source milestones">
      <DetailRows rows={[["Creator",data.creatorRef??"Identity unverified"],["Campaign",data.campaignRef??"Unassigned or unverified"],["Platform match",data.platform??"Unknown"],
        ["Agreement",agreement],["Sample",data.sample.state??"Unknown"],["Sample observation",data.sample.observedAt??"Unknown"]]} />
      {data.history.length?<ol className={styles.timeline}>{data.history.map((h,i)=><li key={h.sourceRef+i}><strong>{h.label}</strong> · {h.at??"Time unknown"} · {h.sourceRef}</li>)}</ol>:<p>No source milestones observed.</p>}
    </Panel><Panel title="Next action" headingId="native-next" note={data.nextAction??"No source recommendation recorded"}>
      <LinkButton to={base+"?tab=content"}>Open content review</LinkButton>
      <DetailRows rows={[["Outreach suppression",data.suppression.state],["Evidence",data.suppression.sourceRef??"Unverified"]]} />
      <div style={btnRow}>{control("close")}{control("suppress")}{control("repeat")}{control("new-collaboration")}{control("human-handoff")}</div>
    </Panel></Split>}
    {(tab==="overview"||tab==="brief")&&<Panel title="Accepted terms and posting" headingId="native-terms">
      <DetailRows rows={[["Agreement model",t.kind??"Unknown"],["Agreement receipt",t.agreementRef??"Unknown"],["Terms version",t.version??"Unverified"],["Accepted brief",t.brief??"Unknown"],
        ["Posting obligation",t.posting],...(t.posting==="committed"?[["Posting due",t.due??"Unknown"],["Grace days",String(t.graceDays??"Unknown")]]:[]),
        ...(t.posting==="voluntary"?[["Observation ends",t.observationUntil??"Unknown"],["Retained sample cost",t.retainedSampleCost?formatMoneyExact(t.retainedSampleCost):"Unknown"]]:[]) ] as [string,string][]}/>
      {t.posting==="voluntary"?<p>Voluntary posting has no deadline. The sample cost stays with the collaboration.</p>:t.posting==="committed"?control("reminder"):<p>Reminder held until accepted posting terms are verified.</p>}
    </Panel>}
    {(content||tab==="rights")&&<section aria-label={content?"Content review":"Usage rights"} className={styles.column}>
      {data.deliverables.length===0&&<Panel title={content?"Content review":"Usage rights"} headingId="empty-deliverables"><p>{data.coverage==="complete"?"No deliverables were found in this source read.":"No deliverables observed in the partial source read."}</p></Panel>}
      {data.deliverables.map((d,i)=><div className={styles.split} key={d.ref}>
        <Panel title={d.title} headingId={"native-deliverable-"+i} note={d.stage??"Production stage unknown"}>
          <div className={styles.darkBox}><h3>Inspect the source asset</h3><p>Original media, review state and approved use each require separate evidence.</p>
            <Button variant="secondary" onClick={openEvidence}>Open asset evidence</Button></div>
          <h3>Review checklist</h3>
          <DetailRows rows={[["Accepted brief",d.brief??"Unknown"],["Production blocker",d.blocker??"Unknown"],["Submitted version",d.submissionVersion??"Unverified"],
            ["Content decision",d.review.state+" · "+(d.review.receiptRef??"No receipt")],["Next action",d.nextAction??"Unknown"]]} />
          <h3>Revision history</h3>{d.revisions.length?<ul className={styles.history}>{d.revisions.map((r,n)=><li key={r.sourceRef+n}>{r.label} · {r.at??"Unknown time"} · {r.sourceRef}</li>)}</ul>:<p>Revision history unavailable.</p>}
        </Panel>
        <div className={styles.column}>
          <Panel title="Use only what is cleared." headingId={"native-rights-"+i}>
            <DetailRows rows={[["Usage terms",t.usage??"Unknown"],["Usage approval",d.rights.state+" · "+(d.rights.receiptRef??"No grant receipt")],
              ["Registry rights expiry",d.reportedRightsExpiry??"Unknown"],["Account publication approval",d.publishPermission.state+" · "+(d.publishPermission.receiptRef??"No receipt")]]}/>
            <Button variant="secondary" onClick={openEvidence}>Inspect rights evidence</Button>
          </Panel>
          <Panel title="Record the next decision." headingId={"native-decision-"+i} note="Proposals require human approval.">
            <div className={styles.stack}>{control("approve-content",d)}{control("request-revision",d)}{control("reject-content",d)}</div>
          </Panel>
        </div>
        <Panel title="Publication and handoff" headingId={"native-publication-"+i}>
          <DetailRows rows={[["Responsible publisher",d.publisher??"Unknown"],["Planned slot",d.plannedSlot??"Unknown"],["Native-confirmed slot",d.publication.confirmedSlot??"Unverified"],
            ["Publication state",d.publication.state],["Registry publication date",d.reportedPublishedAt??"Unknown"],["Registry link",d.reportedLink===true?"Recorded":d.reportedLink===false?"Absent":"Unknown"],
            ["Native post",d.publication.nativePostRef??"Unverified"],["Publication receipt",d.publication.nativeReceiptRef??"Unknown"],["Published time",d.publication.publishedAt??"Unknown"],
            ["Visibility",d.publication.visibility],["Observation time",d.publication.observedAt??"Unknown"]]} />
          {control("human-handoff")}
        </Panel>
      </div>)}
    </section>}
    {tab==="messages"&&<Panel title="Message history" headingId="native-messages"><p>Native message history is unavailable.</p>{control("human-handoff")}</Panel>}
    {tab==="payments"&&<Panel title="Accepted liabilities" headingId="native-payments"><DetailRows rows={[["Historical agreed fee",t.historicalFee?formatMoneyExact(t.historicalFee):"Unknown"],["Evidence",t.agreementRef??"Unverified"]]} /><LinkButton variant="secondary" to="/finance/commissions">Commission ledger</LinkButton></Panel>}
    <Panel title="Proposals awaiting approval" headingId="native-proposals" note={`${data.proposals.length} of ${data.proposalTotal} local proposals`}>
      {data.proposals.map(p=><details key={p.id}><summary>{titles[p.kind]} · {p.createdAt} · awaiting approval</summary>
        <DetailRows rows={[["Proposal",p.id],["Requested by",p.actorRef],["Reason",p.reason],["Source version",p.baseVersion],["Manifest",p.digest],
          ["Submission",p.submissionVersion??"Not applicable"],["Outcome",p.outcome??"Not applicable"]]} /></details>)}
      {data.proposalTotal===0&&<p>No local proposals recorded.</p>}
    </Panel>
    <Dialog open={selection!==null} title={selection?titles[selection.kind]:"Collaboration review"} onClose={close}>
      {selection&&<div className={styles.form}>
        <p>Save a local proposal for human approval. Its target and current source version are recorded.</p>
        {selection.kind==="close"&&<SelectField label="Outcome" value={outcome??"completed"} options={["declined","no-response","opted-out","canceled","completed"].map(v=>({value:v,label:v}))} onChange={v=>setOutcome(v as WorkflowIntent["outcome"])}/>}
        <TextField label="Reason" value={reason} onChange={setReason} helpText="Required to save a proposal."/>
        {(selection.version!==res.dataVersion || pending)&&<p role="alert">{pending?"Proposal acknowledgment unverified. Inspect the saved proposal list before another request.":"The source version changed. Review current evidence before proposing again."}</p>}
        {action.error&&<ActionError error={action.error}/>}
        <Button loading={action.isPending} disabledReason={!reason.trim()?"Enter a reason.":reason.trim().length>1000?"Use at most 1,000 characters.":selection.version!==res.dataVersion||pending?"Review the current record first.":null}
          onClick={()=>void submit()}>Save proposal for approval</Button>
        {selection.version!==res.dataVersion && !pending&&<div><DetailRows rows={[["Original source version",selection.version],["Current source version",res.dataVersion],
          ["Original submission",selection.submissionVersion??"Not applicable"],["Current submission",currentTarget?.submissionVersion??"Unavailable or not applicable"]]} />
          <Button variant="secondary" disabledReason={selection.deliverableRef && !currentTarget?.submissionVersion ? "The target submission is unavailable." : null}
            onClick={()=>setSelection({...selection,version:res.dataVersion,submissionVersion:currentTarget?.submissionVersion??undefined})}>Keep reason on the displayed version</Button></div>}
        <Button variant="secondary" onClick={close}>Return to source record</Button>
      </div>}
    </Dialog>
    <Dialog open={discard} title="Discard proposal edits?" onClose={()=>setDiscard(false)}><Button onClick={()=>setDiscard(false)}>Keep editing</Button>
      <Button variant="secondary" onClick={()=>{setDiscard(false);setSelection(null);setReason("");}}>Discard edits</Button></Dialog>
    <p className={kit.small}>Asset review and renewal decisions remain available in Saved evidence.</p>
  </>;
}
