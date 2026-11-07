import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAction } from "@/adapter/useAction";
import { assertScopeMatches,protectedRead } from "@/adapter/useView";
import { scopeKey,useScope } from "@/adapter/scope";
import { SCHEMA_VERSION,type ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SelectField,TextField } from "@/components/Field";
import { LeaveGuard } from "@/components/LeaveGuard";
import { ActionError,blockedReason } from "@/features/approvals/shared";
import { available,positionHold,transferIntent,handoffIntent,nativeInventorySchema,nativeSupportSchema,type NativeStock,type NativeSupport,type StockIntent } from "@/creator-agent/stockSupportSchema";
import styles from "./Inventory.module.css";

const markerSchema=z.object({key:z.string().uuid(),base:z.string(),hash:z.string().regex(/^[0-9a-f]{64}$/),actor:z.string(),filters:z.record(z.string()),payload:z.union([transferIntent,handoffIntent]),id:z.string().nullable(),digest:z.string().nullable()}).strict();
type Marker=z.infer<typeof markerSchema>;
const memory=new Map<string,Marker>();
function previous(key:string){
  try{const s=sessionStorage.getItem(key);if(s){const m=markerSchema.safeParse(JSON.parse(s));if(m.success)return m.data;}}catch{/* Memory retains this process's marker. */}
  return memory.get(key)??null;
}
function keep(key:string,m:Marker|null){
  if(m)memory.set(key,m);else memory.delete(key);
  try{if(m)sessionStorage.setItem(key,JSON.stringify(m));else sessionStorage.removeItem(key);}catch{/* Fall back to memory. */}
}
function canonical(value:unknown):string{
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  if(value!==null&&typeof value==="object")return "{"+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+":"+canonical(v)).join(",")+"}";
  return JSON.stringify(value);
}
async function hash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(value))))].map(b=>b.toString(16).padStart(2,"0")).join("");}
const reasons={transfer:["low-stock","order-shortage","sample-shortage","rebalance"],support:["assignment","return-review","replacement-review","refund-review"]};
const options=(items:string[])=>[{value:"",label:"Choose an option"},...items.map(value=>({value,label:value.replaceAll("-"," ")}))];

export function StockSupportProposal({data,res}:{data:NativeStock|NativeSupport;res:ReadResponse<unknown>}){
  const stock=data.kind==="source-stock",ctx=useScope(),client=useQueryClient(),action=useAction<StockIntent>();
  const filters=stock?data.selected:{caseId:data.caseId};
  const localKey="stock-support-request:"+canonical([scopeKey(ctx),data.actorRef,data.kind,stock?null:data.caseId]);
  const [pending,setPending]=useState<Marker|null>(()=>previous(localKey));
  const [open,setOpen]=useState(false),[discard,setDiscard]=useState(false),[base,setBase]=useState("");
  const [sku,setSku]=useState(""),[from,setFrom]=useState(""),[to,setTo]=useState(""),[units,setUnits]=useState(""),[reason,setReason]=useState("");
  const [status,setStatus]=useState(""),[invalid,setInvalid]=useState(""),[busy,setBusy]=useState(false),[absent,setAbsent]=useState(false);
  const act=stock?"requestStockTransfer":"requestSupportHandoff",label=stock?"Request transfer":"Request human handoff";
  const view=stock?"inventoryOverview":"supportWorkspace";
  const blocked=blockedReason(res,act)??(data.actorRef!=="agent-reviewer"?"A reviewer session is required.":data.stale||data.coverage!=="complete"?"Refresh complete source evidence before proposing a change.":
    stock&&!data.period?"A source-backed period is required.":stock&&data.period?.window.ref!==data.currentWindow?"Historical balances cannot support a new transfer.":
    !stock&&!data.cases.some(c=>c.id===data.caseId&&c.handoffAllowed&&c.state!=="Resolved"&&c.state!=="Unknown")?"Select a current case that permits human handoff.":null);
  const dirty=open&&!pending&&!!(units||reason||to||from!==(stock?data.selected.home??"":"")||sku!==(stock?data.selected.sku??data.skus[0]??"":""));
  const retrying=!!pending&&absent&&pending.actor===data.actorRef;
  const formHold=retrying?null:blocked;
  const marker=(m:Marker|null)=>{keep(localKey,m);setPending(m);};
  function show(){
    action.reset();setInvalid("");setBase(pending?.base??data.revision);
    const original=pending?.payload,transfer=original&&"units" in original?original:null;
    setFrom(transfer?.from??(stock?data.selected.home??"":""));setSku(transfer?.sku??(stock?data.selected.sku??data.skus[0]??"":""));
    setTo(transfer?.to??"");setUnits(transfer?String(transfer.units):"");setReason(original?.reasonCode??"");setOpen(true);
  }
  async function reconcile(m:Marker){
    setBusy(true);setAbsent(false);
    try{
      const rid="stock-reconcile-"+crypto.randomUUID();
      const response=await protectedRead(client,scopeKey(ctx),rid,async()=>{
        const r=await ctx.adapter.readView({schemaVersion:SCHEMA_VERSION,operation:"readView",viewKey:view,filters:{...m.filters,proposalRequestKey:m.key},requestedScope:ctx.scope,
          period:null,sort:[],page:{limit:50,cursor:null},requestId:rid});assertScopeMatches(r,ctx.scope);return r;
      });
      const parsed=(stock?nativeInventorySchema:nativeSupportSchema).safeParse(response.data);
      if(!parsed.success||parsed.data.actorRef!==m.actor||parsed.data.revision!==response.dataVersion||parsed.data.coverage!=="complete"||parsed.data.stale)throw new Error("unverified");
      const sameTarget=parsed.data.kind==="source-stock"?canonical(parsed.data.selected)===canonical(m.filters):parsed.data.caseId===m.filters.caseId;
      const proof=parsed.data.reconciliation;
      if(!sameTarget||!proof||proof.actorRef!==m.actor||proof.requestKey!==m.key)throw new Error("unverified");
      if(proof.state==="absent"){await client.invalidateQueries({queryKey:[...scopeKey(ctx),SCHEMA_VERSION,view]});setAbsent(true);setStatus("No receipt for this request. Only its original version and parameters can be retried.");return;}
      if(proof.payloadDigest!==m.hash||proof.baseVersion!==m.base)throw new Error("unverified");
      if(proof.state==="rejected"){marker(null);setOpen(false);setStatus("This exact request was rejected because its source version changed. Review the current record.");return;}
      if(!proof.actionRef||!proof.digest||(m.id&&m.id!==proof.actionRef)||(m.digest&&m.digest!==proof.digest))throw new Error("unverified");
      marker(null);setOpen(false);setStatus("Proposal "+proof.actionRef+" is recorded for human review. No source action was executed.");
    }catch{setStatus("The exact request receipt could not be verified. Further proposals are held.");}finally{setBusy(false);}
  }
  async function submit(){
    if(action.isPending||busy||formHold)return;
    const oldTransfer=pending && "units" in pending.payload?pending.payload:null;
    const entry=stock?transferIntent.safeParse({scope:pending?.filters??filters,windowRef:oldTransfer?.windowRef??data.period?.window.ref,sku,from,to,units:Number(units),reasonCode:reason}):
      handoffIntent.safeParse({caseId:data.caseId,reasonCode:reason});
    if(!entry.success){setInvalid("Choose valid proposal details. A transfer needs two different homes and a positive whole unit count.");return;}
    if(!pending&&base!==data.revision){setInvalid("Source changed. Reopen the form to review the new version.");return;}
    if(!pending && stock && "units" in entry.data){
      const s=data.period?.positions.find(p=>p.home===from&&p.sku===sku);
      const hold=positionHold(s);
      if(hold||entry.data.units>(s?available(s)??0:0)){setInvalid(hold?"Reconcile the source balance and reservation evidence before review.":"Units exceed available stock.");return;}
    }
    setBusy(true);setInvalid("");
    try{
      const fingerprint=await hash(entry.data);
      const prior=previous(localKey);
      if(prior&&(!absent||prior.hash!==fingerprint||prior.actor!==data.actorRef)){setInvalid("Use the original request parameters after verifying an absent receipt.");return;}
      let m=prior??{key:crypto.randomUUID(),base,hash:fingerprint,actor:data.actorRef,payload:entry.data,filters:Object.fromEntries(Object.entries(filters).filter((pair):pair is [string,string]=>typeof pair[1]==="string")),id:null,digest:null};
      marker(m);setAbsent(false);
      try{
        const result=await action.mutateAsync({operation:"requestApproval",actionKind:act,idempotencyKey:m.key,entityRefs:[],expectedVersion:m.base,approvalRef:null,manifestRef:null,payload:entry.data});
        if(result.executionCertainty!=="applied"||result.state!=="approvalPending"||!result.receiptRefs.includes("proposal:"+result.actionRef)||!/^[0-9a-f]{64}$/.test(result.payloadVersion))throw new Error("unverified");
        m={...m,id:result.actionRef,digest:result.payloadVersion};marker(m);await reconcile(m);
      }catch(e){
        if(prior && e instanceof AdapterError && e.body.code==="STALE_VERSION"){await reconcile(m);}
        else if(!prior && e instanceof AdapterError && e.body.executionCertainty==="notApplied"){marker(null);setStatus("The proposal was not applied. Review the source and the reported reason.");}
        else setStatus("Proposal outcome unverified. Reconcile the exact request before continuing.");
      }
    }catch{setStatus("The request could not be verified locally.");}finally{setBusy(false);}
  }
  const close=()=>{if(dirty)setDiscard(true);else setOpen(false);};
  return <>
    <Button variant="secondary" aria-haspopup="dialog" disabledReason={pending?"Resolve the previous request before creating another.":blocked} onClick={show}>{label}</Button>
    {pending&&<><Button loading={busy} onClick={()=>void reconcile(pending)}>Reconcile exact request</Button>{absent&&<Button onClick={show}>Review original request</Button>}</>}
    {status&&<p role="status">{status}</p>}
    <Dialog open={open} title={label} onClose={close}><p>This saves a local proposal for human review. The source owner controls execution.</p>
      {pending&&<p>Original source version {pending.base}. {"windowRef" in pending.payload?"Reporting period "+pending.payload.windowRef+".":""} Only this original request can be retried.</p>}
      <form className={styles.form} onSubmit={e=>{e.preventDefault();void submit();}}>
        {stock&&<><SelectField label="SKU" value={sku} onChange={setSku} options={options([...new Set([...(data.selected.sku?[data.selected.sku]:data.skus),...(sku?[sku]:[])])])} />
        <SelectField label="From" value={from} onChange={setFrom} options={options(data.selected.home?[data.selected.home]:["H1","H2","H3"])} />
        <SelectField label="To" value={to} onChange={setTo} options={options(["H1","H2","H3"])} /><TextField label="Units" value={units} onChange={setUnits}/></>}
        <SelectField label="Reason" value={reason} onChange={setReason} options={options(stock?reasons.transfer:reasons.support)} />
        {invalid&&<p role="alert">{invalid}</p>}{action.error&&<ActionError error={action.error}/>}
        <Button type="submit" loading={busy||action.isPending} disabledReason={formHold??(pending&&!absent?"Reconcile the original request first.":null)}>Save proposal for review</Button>
        <Button variant="secondary" onClick={close}>Return to record</Button>
      </form></Dialog>
    <Dialog open={discard} title="Discard proposal edits?" onClose={()=>setDiscard(false)}><Button onClick={()=>setDiscard(false)}>Keep editing</Button><Button onClick={()=>{setDiscard(false);setOpen(false);}}>Discard edits</Button></Dialog>
    <LeaveGuard dirty={dirty} subject="proposal"/>
  </>;
}
