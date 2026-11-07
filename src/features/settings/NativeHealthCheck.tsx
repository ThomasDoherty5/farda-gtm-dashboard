import {useState} from "react";
import {z} from "zod";
import {useScope,scopeKey} from "@/adapter/scope";
import {useAction} from "@/adapter/useAction";
import {AdapterError} from "@/adapter/errors";
import {Button} from "@/components/Button";
import {Dialog} from "@/components/Dialog";
import {ActionError} from "@/features/approvals/shared";
import type {NativeOperationsControl} from "@/creator-agent/operationsControlsSchema";
const pendingSchema=z.object({key:z.string().uuid(),base:z.string().regex(/^oc1-[a-f0-9]{64}$/),targetRef:z.string(),actor:z.string()}).strict();
type Pending=z.infer<typeof pendingSchema>;
const memory=new Map<string,Pending>();
function load(key:string){try{const p=pendingSchema.safeParse(JSON.parse(sessionStorage.getItem(key)??"null"));if(p.success)return p.data;}catch{/* memory remains */}return memory.get(key)??null;}
function save(key:string,p:Pending|null){if(p)memory.set(key,p);else memory.delete(key);try{if(p)sessionStorage.setItem(key,JSON.stringify(p));else sessionStorage.removeItem(key);}catch{/* memory remains */}}
function canonical(v:unknown):string{if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";if(v&&typeof v==="object")return "{"+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+":"+canonical(x)).join(",")+"}";return JSON.stringify(v);}
async function hash(v:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,"0")).join("");}
export function NativeHealthCheck({data,open,onClose}:{data:NativeOperationsControl;open:boolean;onClose:()=>void}){
 const ctx=useScope(),action=useAction<{targetRef:string}>();
 const key="operations-health-pending:"+canonical([scopeKey(ctx),data.actorRef]);
 const [pending,setPending]=useState<Pending|null>(()=>load(key)),[status,setStatus]=useState("");
 const retain=(p:Pending|null)=>{save(key,p);setPending(p);};
 async function check(targetRef:string){
  const p=load(key)??{key:crypto.randomUUID(),base:data.version,targetRef,actor:data.actorRef};retain(p);
  const scope={workspaceId:ctx.scope.workspaceId,accountId:ctx.scope.accountIds[0],environment:ctx.scope.environment};
  try{
   const r=await action.mutateAsync({operation:"refreshObservation",actionKind:"refreshOperationsHealth",entityRefs:[],expectedVersion:p.base,approvalRef:null,manifestRef:null,idempotencyKey:p.key,payload:{targetRef:p.targetRef}});
   if(r.actionRef!=="control-health-"+await hash([scope,p.actor,p.key])||r.payloadVersion!==await hash([scope,p.actor,{targetRef:p.targetRef},p.base]))throw new Error("Unverified health acknowledgment");
   if(r.executionCertainty==="uncertain"){setStatus("Health-check outcome remains unverified. Reconcile the same request; no new check has been authorized.");return;}
   if(r.executionCertainty==="applied"&&r.receiptRefs.some(x=>x.startsWith("health-observation:"))){retain(null);setStatus("A health observation was recorded. Inspect its returned status and source timestamp; this does not grant permission.");}
   else if(r.executionCertainty==="notApplied"&&r.state==="blocked"){retain(null);setStatus("Health check held: "+r.reasonCodes.join(" · ")+". No provider observation is claimed.");}
   else throw new Error("Unverified health acknowledgment");
  }catch(error){
   if(error instanceof AdapterError&&error.body.executionCertainty==="notApplied"){retain(null);setStatus("The check was not applied. Refresh current evidence before requesting another check.");}
   else setStatus("Health-check outcome remains unverified. Reconcile the original request before starting another check.");
  }
 }
 return <>
  {pending&&!open&&<p role="status">A health check needs reconciliation. <Button variant="secondary" loading={action.isPending} onClick={()=>void check(pending.targetRef)}>Reconcile health check</Button></p>}
  {status&&<p role="status">{status}</p>}
  <Dialog open={open} title="Check registered connections" onClose={onClose}>
   <p>Only configured, permitted J14 read probes can run. This does not authenticate, change permissions, repair a source or enable a schedule.</p>
   {pending?<Button loading={action.isPending} onClick={()=>void check(pending.targetRef)}>Reconcile original health check</Button>:
    data.healthTargets.length?data.healthTargets.map(t=><div key={t.targetRef}><Button loading={action.isPending} disabledReason={t.allowed?null:t.reasonCodes.join(" · ")} onClick={()=>void check(t.targetRef)}>{t.title}</Button></div>):<p>No verified health target is configured for this account. The connection owner must supply the permitted source probe.</p>}
   {action.error&&<ActionError error={action.error}/>}
   <Button variant="secondary" onClick={onClose}>Close</Button>
  </Dialog>
 </>;
}
