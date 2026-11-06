import { z } from "zod";
import { intentKinds, type NativeCollaborationData, type WorkflowIntent } from "@/creator-agent/collaborationWorkflowSchema";

const markerSchema=z.object({requestKey:z.string().uuid(),actorRef:z.string().min(1),baseVersion:z.string(),kind:z.enum(intentKinds),reasonHash:z.string().regex(/^[a-f0-9]{64}$/),
  deliverableRef:z.string().nullable(),submissionVersion:z.string().nullable(),outcome:z.string().nullable(),actionRef:z.string().nullable(),digest:z.string().nullable()}).strict();
export type PendingProposal=z.infer<typeof markerSchema>;
const memory=new Map<string,PendingProposal>();
/** The retry marker contains the stable request key and a reason digest. Human-entered notes are not stored. */
export function savedPending(key:string) {
  try {
    const stored=sessionStorage.getItem(key);
    if(stored!==null){const parsed=markerSchema.safeParse(JSON.parse(stored));if(parsed.success)return parsed.data;}
  }catch { /* A denied session store uses the in-memory marker. */ }
  return memory.get(key)??null;
}
export function rememberPending(key:string,pending:PendingProposal|null) {
  if(pending)memory.set(key,pending);else memory.delete(key);
  try {if(pending)sessionStorage.setItem(key,JSON.stringify(pending));else sessionStorage.removeItem(key);}catch { /* The in-memory hold still applies. */ }
}
export async function reasonFingerprint(reason:string){
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(reason.trim())));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
}
export async function pendingProposal(intent:WorkflowIntent,baseVersion:string,actorRef:string):Promise<PendingProposal>{
  return {requestKey:crypto.randomUUID(),actorRef,baseVersion,kind:intent.kind,reasonHash:await reasonFingerprint(intent.reason),deliverableRef:intent.deliverableRef??null,
    submissionVersion:intent.submissionVersion??null,outcome:intent.outcome??null,actionRef:null,digest:null};
}
export function matchingProposal(data:NativeCollaborationData,pending:PendingProposal){
  const lookup=data.proposalReconciliation, p=lookup?.proposal;
  if(!lookup || lookup.requestKey!==pending.requestKey || lookup.actorRef!==pending.actorRef || data.actorRef!==pending.actorRef || lookup.state!=="recorded" || !p)return undefined;
  return p.state==="approvalPending" && p.actorRef===pending.actorRef && p.baseVersion===pending.baseVersion && p.reasonHash===pending.reasonHash && p.kind===pending.kind &&
    p.deliverableRef===pending.deliverableRef && p.submissionVersion===pending.submissionVersion && p.outcome===pending.outcome &&
    (!pending.actionRef || p.id===pending.actionRef) && (!pending.digest || p.digest===pending.digest) ? p : undefined;
}
