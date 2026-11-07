import { useEffect,useRef,useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import { scopeKey,useScope } from "@/adapter/scope";
import { useView,protectedRead,assertScopeMatches } from "@/adapter/useView";
import { useAction } from "@/adapter/useAction";
import { SCHEMA_VERSION,type ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { Button,LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SelectField,TextField } from "@/components/Field";
import { DataTable } from "@/components/DataTable";
import { LeaveGuard } from "@/components/LeaveGuard";
import { ReadState } from "@/components/ReadState";
import { ViewError } from "@/components/ViewError";
import { SkeletonCard } from "@/components/EmptyState";
import { DetailRows,Notice,Page,PageHeader,Panel,Row,Small,Split,kit } from "@/components/PageKit";
import { ActionError } from "@/features/approvals/shared";
import { nativeOperationsControlSchema,operationsReviewPayload,controlPlatforms,type NativeOperationsControl,type OperationsReviewPayload,type OperationsControlFilters } from "@/creator-agent/operationsControlsSchema";
import { NativeHealthCheck } from "./NativeHealthCheck";
import { AutomationNav } from "./shared";

type Section=NativeOperationsControl["section"];
const names={connections:"Connection controls",team:"Team & permissions",runs:"Task and recovery controls",reports:"Report evidence",capabilities:"Permission and validation evidence",reconciliation:"Where two systems disagree."};
const label={task:"Request task",takeover:"Request human takeover",repair:"Request repair",permissionEvidence:"Record permission evidence"};
function canonical(v:unknown):string{
 if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";
 if(v&&typeof v==="object")return "{"+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+":"+canonical(x)).join(",")+"}";
 return JSON.stringify(v);
}
async function hash(v:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,"0")).join("");}
const markerSchema=z.object({key:z.string().uuid(),base:z.string(),hash:z.string().regex(/^[a-f0-9]{64}$/),actor:z.string(),section:z.enum(["connections","team","runs","reports","capabilities","reconciliation"]),
 kind:operationsReviewPayload.shape.kind,targetRef:operationsReviewPayload.shape.targetRef,id:z.string().nullable(),digest:z.string().nullable()}).strict();
type Marker=z.infer<typeof markerSchema>;
const pendingMemory=new Map<string,Marker>();
function prior(key:string){try{const v=sessionStorage.getItem(key);if(v){
 const raw=JSON.parse(v),r=markerSchema.safeParse({key:raw.key,base:raw.base,hash:raw.hash,actor:raw.actor,section:raw.section,kind:raw.kind??raw.payload?.kind,targetRef:raw.targetRef??raw.payload?.targetRef,id:raw.id,digest:raw.digest});
 // Migrate old payload-bearing markers immediately; raw reasons never remain in storage.
 if(r.success){sessionStorage.setItem(key,JSON.stringify(r.data));return r.data;}sessionStorage.removeItem(key);
 }}catch{try{sessionStorage.removeItem(key);}catch{/* storage unavailable */}}return pendingMemory.get(key)??null;}
function scrubLegacyControlMarkers(){
 try{for(const key of Object.keys(sessionStorage))if(key.startsWith("operations-control-pending:"))prior(key);}catch{/* storage unavailable; no protected value is read or copied */}
}
function retain(key:string,m:Marker|null){if(m)pendingMemory.set(key,m);else pendingMemory.delete(key);try{if(m)sessionStorage.setItem(key,JSON.stringify(m));else sessionStorage.removeItem(key);}catch{/* process fallback */}}

export function NativeControlsPage({section}:{section:"team"|"reconciliation"}){
 return <Page labelledBy="native-controls-title" source={section==="team"?"7:1085":"none"}>
  <PageHeader id="native-controls-title" title={names[section]} subtitle={section==="team"?"Effective application access and separately verified source roles.":"Source-owned nightly comparisons, proposed repairs and immutable receipts."}/>
  {section==="reconciliation"&&<AutomationNav current="reconciliation" width={152}/>}
  <NativeOperationsControls section={section}/>
 </Page>;
}
export function NativeOperationsControls({section,taskOpen=false,onTaskClose,planOpen=false,onPlanClose,jobRef,healthOpen=false,onHealthClose,onReady,onRefreshReady}:{section:Section;taskOpen?:boolean;onTaskClose?:()=>void;planOpen?:boolean;onPlanClose?:()=>void;jobRef?:string;healthOpen?:boolean;onHealthClose?:()=>void;onReady?:(ready:boolean)=>void;onRefreshReady?:(refresh:(()=>Promise<NativeOperationsControl|null>)|null)=>void}){
 const ctx=useScope();
 useEffect(scrubLegacyControlMarkers,[]);
 const [params,setParams]=useSearchParams();
 const platform=controlPlatforms.find(p=>p===params.get("controlPlatform"));
 const q=params.get("controlSearch")?.slice(0,120);
 const query=useView<OperationsControlFilters,NativeOperationsControl>("operationsControl",{section,...(jobRef?{jobRef}:{}),...(section==="runs"?{...(platform?{platform}:{}),...(q?{q}:{})}:{})});
 const data=query.data?.data;
 const refetch=query.refetch;
 useEffect(()=>{
  onRefreshReady?.(async()=>{const result=await refetch();return result.isError?null:result.data?.data??null;});
  return ()=>onRefreshReady?.(null);
 },[refetch,onRefreshReady]);
 useEffect(()=>{onReady?.(Boolean(data)&&!query.isError);},[data,query.isError,onReady]);
 return <section className={kit.page} aria-label={names[section]+" evidence and review controls"} id={"native-controls-"+section}>
  {section==="runs"&&<Row>
   <TextField label="Search inspected run history" value={q??""} onChange={v=>setParams(p=>{const n=new URLSearchParams(p);if(v)n.set("controlSearch",v.slice(0,120));else n.delete("controlSearch");return n;},{replace:true})}/>
   <SelectField label="Source platform" value={platform??"all"} options={[{value:"all",label:"All platforms"},...controlPlatforms.map(v=>({value:v,label:v}))]} onChange={v=>setParams(p=>{const n=new URLSearchParams(p);if(v!=="all")n.set("controlPlatform",v);else n.delete("controlPlatform");return n;})}/>
   <Button variant="secondary" disabledReason="A named authenticated source owner has not been verified for this role-scoped session.">Assigned to me</Button>
   <Button variant="ghost" onClick={()=>setParams(p=>{const n=new URLSearchParams(p);n.delete("controlPlatform");n.delete("controlSearch");return n;})}>Clear history filters</Button>
  </Row>}
  <ReadState res={query.data} subject={names[section]} only={["partial","stale"]}/>
  {query.isPending&&<SkeletonCard label={"Loading "+names[section]+"…"}/>}
  {query.isError&&<ViewError error={query.error} subject={names[section]} hasPriorData={Boolean(data)} onRetry={()=>void query.refetch()}/>}
  {data&&<ControlsBody key={canonical([scopeKey(ctx),section,data.actorRef,platform,q])} data={data} res={query.data!} refresh={()=>void query.refetch()} taskOpen={taskOpen} onTaskClose={onTaskClose} planOpen={planOpen} onPlanClose={onPlanClose}/> }
  {data&&<NativeHealthCheck key={canonical([scopeKey(ctx),data.actorRef])} data={data} open={healthOpen} onClose={()=>onHealthClose?.()}/> }
 </section>;
}
function ControlsBody({data,res,refresh,taskOpen,onTaskClose,planOpen,onPlanClose}:{data:NativeOperationsControl;res:ReadResponse<NativeOperationsControl>;refresh:()=>void;taskOpen:boolean;onTaskClose?:()=>void;planOpen:boolean;onPlanClose?:()=>void}){
 const [params,setParams]=useSearchParams();
 const [detail,setDetail]=useState<NativeOperationsControl["records"][number]|null>(null);
 const [selection,setSelection]=useState<NativeOperationsControl["actions"][number]|null>(null);
 const selectedKind=params.get("controlDraft");
 useEffect(()=>{setDetail(null);},[data.section]);
 const visible=data.actions.filter(a=>!selectedKind||a.kind===selectedKind);
 const closeKind=()=>setParams(p=>{const n=new URLSearchParams(p);n.delete("controlDraft");return n;},{replace:true});
 return <>
  <Notice title={data.sourceState==="notConnected"?"Source authority is not connected":data.sourceState==="current"?"Source evidence available":"Source evidence needs review"}>
   {data.sourceState==="notConnected"?"Provider roles, assignments, reports and reconciliation facts are unknown until their owning source is available.":
    "Source observed "+data.sourceObservedAt+". Current state: "+data.sourceState+"."} Local proposals never grant permission, claim a browser session, apply repairs or activate schedules.
  </Notice>
  {data.section==="team"&&<Split>
   <Panel title="Who can do what" note="Application and provider roles are separate" headingId="native-role-matrix">
    <DetailRows rows={[["Current application role",data.role],["Current principal",data.actorRef],["Read scoped evidence","Allowed"],["Record review proposal",data.role==="reviewer"?"Conditional on exact source evidence":"Not allowed"],["Provider approval or execution","Separate verified authority required"]]}/>
    <Small>A reviewer session does not establish founder, provider administrator, finance or task-owner authority.</Small>
   </Panel>
   <Panel title="Owner coverage" headingId="native-owner-coverage"><p>{data.sourceState==="notConnected"?"Owner and backup coverage is unknown.":data.records.length+" source role records received; unknown owners remain explicit."}</p>
    <LinkButton variant="secondary" to="/settings/capabilities">View source roles and capabilities</LinkButton><LinkButton variant="secondary" to="/launch?view=control">Open launch control</LinkButton>
   </Panel>
  </Split>}
  <Panel title={data.section==="reconciliation"?"Nightly source comparisons and conflicts":data.section==="team"?"Source roles and owner register":"Source records"} headingId={"native-source-"+data.section}>
   {data.records.length?<DataTable caption={names[data.section]+" source evidence"} columns={[{label:"Source record"},{label:"Evidence"}]}
    rows={data.records.map(r=>[r.title,<Button key={r.id} variant="secondary" aria-haspopup="dialog" onClick={()=>setDetail(r)}>Inspect evidence</Button>])}/>:<p>No source records have been returned. This is not a verified clean comparison or a zero business total.</p>}
   <Row><Button variant="secondary" onClick={refresh}>Refresh source evidence</Button>{data.handoffs.map(h=><a key={h.targetRef} href={h.url} rel="noreferrer">{h.title}</a>)}</Row>
  </Panel>
  {data.section==="runs"&&<Panel title="Current run and checkpoint history" headingId="native-run-history">
   <p>{data.runFilterEvidence.matched} matching traces among {data.localCoverage.returned} of {data.localCoverage.total} local runs inspected. {data.runFilterEvidence.unknownPlatform} inspected runs have unknown source platform. {data.localCoverage.partial?"Additional records remain in the paged run registry.":""}</p>
   <Small>Assignment to a named person and provider execution are shown only when independently evidenced. A role-scoped login cannot prove “assigned to me.”</Small>
   {data.localRuns.length?<DataTable caption="Native run recovery traces" columns={[{label:"Run"},{label:"Trace"}]} rows={data.localRuns.map(r=>[r.title,<Button key={r.id} variant="secondary" onClick={()=>setDetail(r)}>View history</Button>])}/>:<p>No local run trace is present.</p>}
  </Panel>}
  <Panel title="Finite review proposals" headingId={"control-actions-"+data.section}>
   <p>Inspect the exact target and evidence before requesting review. No action below dispatches work.</p>
   {selectedKind&&<Button variant="ghost" onClick={closeKind}>Show all review actions</Button>}
   {visible.length?<DataTable caption="Allowed operations review proposals" columns={[{label:"Target"},{label:"Current permission"},{label:"Action"}]} rows={visible.map(a=>[
    a.title,a.allowed?"May request review":a.reasonCodes.join(" · "),<Button key={a.targetRef} variant="secondary" aria-haspopup="dialog" disabledReason={a.allowed?null:a.reasonCodes.join(" · ")} onClick={()=>setSelection(a)}>{label[a.kind]}</Button>
   ])}/>:<p>No finite authorized proposal is available for this scope. Resolve source access or the owned evidence gap before requesting work.</p>}
  </Panel>
  <Dialog open={taskOpen} title="Choose a registered task" onClose={()=>onTaskClose?.()}>
   <p>Only current finite source-authorized plans can be proposed. A proposal does not enqueue or execute a job.</p>
   {data.actions.filter(a=>a.kind==="task").length?data.actions.filter(a=>a.kind==="task").map(a=><div key={a.targetRef}><h3>{a.title}</h3><DetailRows rows={a.details.slice(0,5)}/><Button disabledReason={a.allowed?null:a.reasonCodes.join(" · ")} onClick={()=>{setSelection(a);onTaskClose?.();}}>Draft {a.title}</Button></div>):<p>No registered finite task plan is available from the source.</p>}
   <Button variant="secondary" onClick={()=>onTaskClose?.()}>Close</Button>
  </Dialog>
  <Dialog open={planOpen} title="Plan validation" onClose={()=>onPlanClose?.()}><p>Validate exact provider, account, action, route, permission, session and current evidence independently. These source observations do not execute a check or grant authority.</p>
   <p>Source state: {data.sourceState}. {data.actions.filter(a=>a.kind==="permissionEvidence").length} verified permission evidence targets available for review.</p>
   <Button variant="secondary" onClick={()=>onPlanClose?.()}>Close</Button>
  </Dialog>
  <ControlProposal data={data} res={res} selected={selection} clearSelection={()=>setSelection(null)}/>
  <Panel title="Review receipt history" headingId={"control-receipts-"+data.section} note={data.historyCoverage.returned+" of "+data.historyCoverage.total+" receipts; exact-request recovery searches the complete ledger."}>
   {data.history.length?<DataTable caption="Immutable local review receipts" columns={[{label:"State / request"},{label:"Actor / time"},{label:"Reason"}]} rows={data.history.map(r=>[
    r.state+" · "+r.requestKey,r.actorRef+" · "+r.createdAt,r.reason??"Unknown"
   ])}/>:<p>No local review proposal has been recorded.</p>}
  </Panel>
  <Dialog open={!!detail} title={detail?.title??"Source evidence"} onClose={()=>setDetail(null)}>
   {detail&&<DetailRows rows={detail.details}/>}<Button variant="secondary" onClick={()=>setDetail(null)}>Close</Button>
  </Dialog>
 </>;
}
function ControlProposal({data,selected,clearSelection}:{data:NativeOperationsControl;res:ReadResponse<NativeOperationsControl>;selected:NativeOperationsControl["actions"][number]|null;clearSelection:()=>void}){
 const ctx=useScope(),client=useQueryClient(),action=useAction<OperationsReviewPayload>();
 const key="operations-control-pending:"+canonical([scopeKey(ctx),data.actorRef,data.section]);
 const [pending,setPending]=useState<Marker|null>(()=>prior(key)),[retry,setRetry]=useState(false),[reason,setReason]=useState("");
 const [open,setOpen]=useState(false),[discard,setDiscard]=useState(false),[base,setBase]=useState(data.version),[busy,setBusy]=useState(false),[status,setStatus]=useState(""),[invalid,setInvalid]=useState("");
 const previousSelection=useRef<string|null>(null);
 useEffect(()=>{if(selected&&selected.targetRef!==previousSelection.current){setReason("");setBase(data.version);setOpen(true);setInvalid("");}previousSelection.current=selected?.targetRef??null;},[selected,data.version]);
 const payloadKey=(m:Marker)=>[...scopeKey(ctx),"operations-control-private-draft",m.key];
 const original=(m:Marker)=>{const r=operationsReviewPayload.safeParse(client.getQueryData(payloadKey(m)));return r.success?r.data:null;};
 const mark=(m:Marker|null)=>{if(!m&&pending)client.removeQueries({queryKey:payloadKey(pending),exact:true});retain(key,m);setPending(m);};
 const dirty=open&&!pending&&!!reason;
 const close=()=>{if(dirty)setDiscard(true);else{setOpen(false);clearSelection();}};
 async function reconcile(m:Marker){
  setBusy(true);setRetry(false);
  try{
   const requestId="controls-reconcile-"+crypto.randomUUID();
   const response=await protectedRead(client,scopeKey(ctx),requestId,async()=>{
    const r=await ctx.adapter.readView({schemaVersion:SCHEMA_VERSION,operation:"readView",viewKey:"operationsControl",requestedScope:ctx.scope,
     filters:{section:m.section,proposalRequestKey:m.key},period:null,sort:[],page:{limit:50,cursor:null},requestId});
    assertScopeMatches(r,ctx.scope);return r;
   });
   const parsed=nativeOperationsControlSchema.safeParse(response.data);if(!parsed.success||parsed.data.actorRef!==m.actor||parsed.data.section!==m.section||parsed.data.version!==response.dataVersion)throw new Error("unverified");
   const r=parsed.data.proposalReconciliation;if(!r||r.requestKey!==m.key||r.actorRef!==m.actor)throw new Error("unverified");
   if(r.state==="absent"&&parsed.data.sourceState==="current"){
    const payload=original(m);setRetry(Boolean(payload));setStatus(payload?"This exact request has no receipt. Only the original key, target, reason and version can be retried.":"No receipt was found, and the original protected draft is no longer available. This request remains held; do not resend or start another proposal.");return;
   }
   if(r.payloadDigest!==m.hash||r.baseVersion!==m.base)throw new Error("unverified");
   if(r.state==="rejected"){mark(null);setOpen(false);clearSelection();setStatus("The original request is sealed as not applied because its source basis changed. Review current evidence before a new proposal.");return;}
   if(r.state!=="recorded"||!r.actionRef||!r.manifestDigest||(m.id&&r.actionRef!==m.id)||(m.digest&&r.manifestDigest!==m.digest))throw new Error("unverified");
   mark(null);setOpen(false);clearSelection();setStatus("Review proposal "+r.actionRef+" recorded. No provider action was executed.");
  }catch{setStatus("Exact request verification failed. Further proposals remain held.");}finally{setBusy(false);}
 }
 async function submit(){
  if(busy||action.isPending)return;
  const old=prior(key);
  if(old&&!retry){setInvalid("Verify the exact pending request before continuing.");return;}
  if(!old&&(!selected?.allowed||base!==data.version)){setInvalid("Source evidence changed or this action is held. Reopen the current target.");return;}
  const originalPayload=old?original(old):null;
  if(old&&!originalPayload){setInvalid("The original protected draft is no longer available. Reconcile the exact request; no resend is allowed.");return;}
  const parsed=operationsReviewPayload.safeParse(originalPayload??{kind:selected?.kind,targetRef:selected?.targetRef,reason});
  if(!parsed.success){setInvalid("Enter a reason from 1 to 1,000 characters.");return;}
  setBusy(true);setInvalid("");
  try{
   let fingerprint:string;
   try{fingerprint=await protectedRead(client,scopeKey(ctx),"controls-draft-hash-"+crypto.randomUUID(),()=>hash(parsed.data));}
   catch{setInvalid("Source access changed while preparing this draft. Reopen current evidence before continuing.");return;}
   // A concurrent denial must not be followed by a delayed hash callback restoring protected text.
   const current=client.getQueriesData<ReadResponse<NativeOperationsControl>>({queryKey:scopeKey(ctx)}).some(([,r])=>r?.data?.kind==="native-operations-controls"&&r.data.actorRef===data.actorRef&&r.data.section===data.section&&r.data.version===data.version);
   if(!current){setInvalid("Current source access must be re-established before retaining or submitting a draft.");return;}
   let m=old??{key:crypto.randomUUID(),base,hash:fingerprint,actor:data.actorRef,section:data.section,kind:parsed.data.kind,targetRef:parsed.data.targetRef,id:null,digest:null};
   if(old&&(old.hash!==fingerprint||old.actor!==data.actorRef)){setInvalid("The original request cannot be changed.");return;}
   if(!old)client.setQueryData(payloadKey(m),parsed.data);
   mark(m);setRetry(false);
   try{
    const r=await action.mutateAsync({operation:"requestApproval",actionKind:"proposeOperationsReview",entityRefs:[],expectedVersion:m.base,approvalRef:null,manifestRef:null,idempotencyKey:m.key,payload:parsed.data});
    if(r.executionCertainty!=="applied"||r.state!=="approvalPending"||!r.receiptRefs.includes("proposal:"+r.actionRef)||!/^[a-f0-9]{64}$/.test(r.payloadVersion))throw new Error("unverified");
    m={...m,id:r.actionRef,digest:r.payloadVersion};mark(m);await reconcile(m);
   }catch(e){
    if(e instanceof AdapterError&&e.body.code==="STALE_VERSION")await reconcile(m);
    else if(!old&&e instanceof AdapterError&&e.body.executionCertainty==="notApplied"){mark(null);setStatus("The request was not applied. Review the source and reported reason.");}
    else setStatus("Proposal outcome is unverified. Reconcile this exact request before continuing.");
   }
  }finally{setBusy(false);}
 }
 return <>
  {pending&&<section aria-label="Unverified review request"><p role="alert">A previous request must be reconciled before another proposal.</p>
   <Button loading={busy} onClick={()=>void reconcile(pending)}>Reconcile exact request</Button>
   {retry&&<Button onClick={()=>{setReason(original(pending)?.reason??"");setBase(pending.base);setOpen(true);}}>Review original request</Button>}</section>}
  {status&&<p role="status">{status}</p>}
  <Dialog open={open} title={pending?"Review original request":selected?label[selected.kind]:"Review proposal"} onClose={close}>
   <p>Local review only. Source execution, assignment and approval are separate.</p>
   {pending?<DetailRows rows={[["Original action",pending.kind],["Original target",pending.targetRef.slice(0,20)+"…"]]}/>:selected&&<DetailRows rows={selected.details}/>}
   <p>Exact source version: {pending?.base??base}</p>
   <form onSubmit={e=>{e.preventDefault();void submit();}}>
    <TextField label="Reason" multiline value={pending?original(pending)?.reason??"":reason} onChange={setReason} disabled={!!pending} error={invalid||null} helpText="1–1,000 characters. Do not include credentials or personal data."/>
    {action.error&&<ActionError error={action.error}/>}
    <Row><Button type="submit" loading={busy||action.isPending} disabledReason={pending&&!retry?"Verify the original request first.":!pending&&!selected?.allowed?"This target is held.":null}>Save proposal for review</Button>
    <Button variant="secondary" onClick={close}>Return to evidence</Button></Row>
   </form>
  </Dialog>
  <Dialog open={discard} title="Discard proposal edits?" onClose={()=>setDiscard(false)}><Button onClick={()=>setDiscard(false)}>Keep editing</Button><Button onClick={()=>{setDiscard(false);setOpen(false);clearSelection();setReason("");}}>Discard edits</Button></Dialog>
  <LeaveGuard dirty={dirty} subject="proposal"/>
 </>;
}
