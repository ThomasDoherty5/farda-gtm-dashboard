import { z } from "zod";
import { approvalHashSchema, approvalRefSchema } from "@/creator-agent/approvals/contract";

const ref=approvalRefSchema;
export const bulkPreviewMarkerSchema=z.object({requestKey:z.string().uuid(),actorRef:ref,groupRef:ref,actionKind:ref,
  payload:z.object({entityRef:ref,entityVersion:approvalHashSchema,selectionRefs:z.array(ref).min(1).max(100)}).strict()}).strict();
export type BulkPreviewMarker=z.infer<typeof bulkPreviewMarkerSchema>;
const memory=new Map<string,BulkPreviewMarker>();
/** Scoped opaque IDs only. Never recipient labels, source message bodies or credentials. */
export const bulkPreviewStorageKey=(scope:readonly unknown[],actor:string,batch:string,group:string)=>`bulk-preview:${JSON.stringify([scope,actor,batch,group])}`;
export function readBulkPreview(key:string,actorRef:string,groupRef:string):{marker:BulkPreviewMarker|null;invalid:boolean} {
  let raw:unknown=memory.get(key);
  if(!raw) { let stored:string|null=null;try{stored=sessionStorage.getItem(key);}catch{/* In-memory original metadata remains available. */}
    if(stored===null)return{marker:null,invalid:false};try{raw=JSON.parse(stored);}catch{return{marker:null,invalid:true};}}
  const parsed=bulkPreviewMarkerSchema.safeParse(raw);
  if(!parsed.success||parsed.data.actorRef!==actorRef||parsed.data.groupRef!==groupRef)return{marker:null,invalid:true};
  return{marker:parsed.data,invalid:false};
}
export function rememberBulkPreview(key:string,value:BulkPreviewMarker){const parsed=bulkPreviewMarkerSchema.parse(value);memory.set(key,parsed);try{sessionStorage.setItem(key,JSON.stringify(parsed));}catch{/* Retain same logical action in memory; never silently rekey. */}}
