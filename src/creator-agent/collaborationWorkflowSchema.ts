import { z } from "zod";
const ref = z.string().trim().min(1).max(500);
const note = z.string().trim().min(1).max(1200);
const instant = z.string().datetime({offset:true}).refine(v=>Number.isFinite(Date.parse(v)));
const day = z.string().date();
const when = z.union([instant,day]);
const amount = z.object({minorUnits:z.number().int().safe().nonnegative(),currency:z.string().regex(/^[A-Z]{3}$/)}).strict();
const fact = z.object({label:note,at:when.nullable(),sourceRef:ref}).strict();
const scope = z.object({workspaceId:ref,accountId:ref,environment:z.literal("sandbox")}).strict();
const proof = z.object({state:z.enum(["unknown","pending","accepted","rejected","granted","denied","expired","revoked"]),receiptRef:ref.nullable()}).strict()
  .refine(x=>x.state==="unknown" || x.state==="pending" || !!x.receiptRef,"An authoritative decision needs its own receipt.");
const publication = z.object({state:z.enum(["unknown","planned","scheduled","published","failed","missed","unverifiable"]),
  nativeReceiptRef:ref.nullable(),nativePostRef:ref.nullable(),confirmedSlot:instant.nullable(),publishedAt:instant.nullable(),observedAt:instant.nullable(),
  visibility:z.enum(["unknown","visible","private","deleted","unavailable"])}).strict().superRefine((p,c)=>{
    if (["scheduled","published","failed","missed"].includes(p.state) && (!p.nativeReceiptRef || !p.observedAt)) c.addIssue({code:"custom",message:"Native state requires a dated receipt."});
    if (p.state==="scheduled" && !p.confirmedSlot || p.state==="published" && (!p.nativePostRef || !p.publishedAt)) c.addIssue({code:"custom",message:"Native slot or publication proof is incomplete."});
    if (p.publishedAt && p.observedAt && Date.parse(p.publishedAt)>Date.parse(p.observedAt)) c.addIssue({code:"custom",message:"Publication follows observation."});
    if (p.visibility!=="unknown" && (!p.nativeReceiptRef || !p.observedAt)) c.addIssue({code:"custom",message:"Visibility requires native observation."});
  });
const reviewProof=proof.refine(x=>["unknown","pending","accepted","rejected"].includes(x.state),"Invalid content decision.");
const usageProof=proof.refine(x=>["unknown","pending","granted","denied","expired","revoked"].includes(x.state),"Invalid use or publication permission.");
export const workflowDeliverableSchema = z.object({ref,revision:ref,title:note,stage:note.nullable(),brief:note.nullable(),
  blocker:note.nullable(),submissionVersion:ref.nullable(),revisions:z.array(fact).max(50),review:reviewProof,rights:usageProof,publishPermission:usageProof,
  publisher:note.nullable(),plannedSlot:instant.nullable(),
  reportedPublishedAt:when.nullable().optional(),reportedLink:z.boolean().nullable().optional(),reportedRightsExpiry:when.nullable().optional(),publication,nextAction:note.nullable(),sourceRef:ref}).strict();
export const collaborationSnapshotSchema = z.object({
  scope,id:ref,sourceRevision:ref,sourceRef:ref,observedAt:instant,coverage:z.enum(["complete","partial"]),title:note,
  platform:note.nullable(),creatorRef:ref.nullable(),campaignRef:ref.nullable(),stage:note.nullable(),nextAction:note.nullable(),
  terms:z.object({kind:note.nullable(),agreementRef:ref.nullable(),acceptedAt:when.nullable(),version:ref.nullable(),brief:note.nullable(),usage:note.nullable(),
    posting:z.enum(["committed","voluntary","unknown"]),due:day.nullable(),graceDays:z.number().int().min(0).max(365).nullable(),observationUntil:day.nullable(),timezone:z.string().min(1).max(100).nullable().optional(),
    retainedSampleCost:amount.nullable(),historicalFee:amount.nullable()}).strict(),
  sample:z.object({state:note.nullable(),observedAt:when.nullable(),sourceRef:ref.nullable()}).strict(),
  suppression:z.object({state:z.enum(["clear","suppressed","unknown"]),sourceRef:ref.nullable()}).strict(),
  history:z.array(fact).max(80),deliverables:z.array(workflowDeliverableSchema).max(100),
  assetBindings:z.array(z.object({deliverableRef:ref,assetId:ref}).strict()).max(100).optional(),
}).strict().superRefine((x,c)=>{
  if(x.terms.posting!=="unknown" && (!x.terms.agreementRef || !x.terms.acceptedAt)) c.addIssue({code:"custom",message:"Posting terms lack accepted-source evidence."});
  if(x.terms.posting==="voluntary" && (x.terms.due || x.terms.graceDays!==null)) c.addIssue({code:"custom",message:"Voluntary posting has no due date or grace."});
  if(x.suppression.state!=="unknown" && !x.suppression.sourceRef) c.addIssue({code:"custom",message:"Suppression needs evidence."});
  if(new Set(x.deliverables.map(d=>d.ref)).size!==x.deliverables.length)c.addIssue({code:"custom",message:"Duplicate deliverable identity."});
  if(x.deliverables.some(d=>d.publication.observedAt && Date.parse(d.publication.observedAt)>Date.parse(x.observedAt))) c.addIssue({code:"custom",message:"Future publication observation."});
});
export type CollaborationSourceSnapshot=z.infer<typeof collaborationSnapshotSchema>;
export type CollaborationSourceReader=(scope:CollaborationSourceSnapshot["scope"],id:string,referenceKey?:string)=>Promise<CollaborationSourceSnapshot|null>;
export const intentKinds=["review","request-revision","reject-content","approve-content","reminder","human-handoff","suppress","close","repeat","new-collaboration"] as const;
export const workflowIntentSchema=z.object({collaborationRef:ref,kind:z.enum(intentKinds),reason:z.string().trim().min(1).max(1000),
  deliverableRef:ref.optional(),submissionVersion:ref.optional(),outcome:z.enum(["declined","no-response","opted-out","canceled","completed"]).optional()}).strict();
export type WorkflowIntent=z.infer<typeof workflowIntentSchema>;
const proposal=z.object({id:ref,kind:z.enum(intentKinds),digest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:instant,state:z.literal("approvalPending"),baseVersion:ref,actorRef:ref,reason:z.string().trim().min(1).max(1000),reasonHash:z.string().regex(/^[0-9a-f]{64}$/),
  deliverableRef:ref.nullable(),submissionVersion:ref.nullable(),outcome:workflowIntentSchema.shape.outcome.unwrap().nullable()}).strict();
export const proposalReconciliationSchema=z.object({requestKey:z.string().min(1).max(240),actorRef:ref,state:z.enum(["recorded","notRecorded","notApplied"]),
  reasonCode:z.literal("STALE_VERSION").nullable(),currentVersion:ref.nullable(),proposal:proposal.nullable()}).strict().refine(x=>(x.state==="recorded")===(x.proposal!==null) && (x.state==="notApplied")===(x.reasonCode!==null && x.currentVersion!==null),"Invalid request reconciliation.");
export const nativeCollaborationSchema=z.object({kind:z.literal("source-collaboration"),collaborationRef:ref,sourceRef:ref,observedAt:instant,coverage:z.enum(["complete","partial"]),
  title:note,platform:note.nullable(),creatorRef:ref.nullable(),campaignRef:ref.nullable(),stage:note.nullable(),nextAction:note.nullable(),
  terms:collaborationSnapshotSchema.innerType().shape.terms,sample:collaborationSnapshotSchema.innerType().shape.sample,suppression:collaborationSnapshotSchema.innerType().shape.suppression,
  history:z.array(fact).max(80),deliverables:z.array(workflowDeliverableSchema).max(100),
  actorRef:ref,proposalReconciliation:proposalReconciliationSchema.nullable(),proposals:z.array(proposal).max(50),proposalTotal:z.number().int().nonnegative(),sourceRevision:ref,stale:z.boolean(),
}).strict();
export type NativeCollaborationData=z.infer<typeof nativeCollaborationSchema>;

export function intentHold(data: Pick<NativeCollaborationData,"terms"|"suppression"|"coverage"|"deliverables"|"stage"|"observedAt">, kind:WorkflowIntent["kind"], deliverableRef?:string) {
  if(data.coverage!=="complete") return "SOURCE_COVERAGE_PARTIAL";
  if(["request-revision","reject-content","approve-content"].includes(kind)){
    const d=data.deliverables.find(row=>row.ref===deliverableRef);
    if(!d?.submissionVersion) return "SUBMISSION_UNVERIFIED";
  }
  const outreach=["request-revision","reminder","human-handoff","repeat","new-collaboration"].includes(kind);
  if(outreach && data.suppression.state!=="clear")return data.suppression.state==="suppressed"?"OUTREACH_SUPPRESSED":"SUPPRESSION_UNVERIFIED";
  const terminal=["declined","no response","closed","opted out","canceled","cancelled","completed"].includes(data.stage?.toLowerCase()??"");
  if(outreach && terminal && !["new-collaboration","repeat"].includes(kind))return "RELATIONSHIP_CLOSED";
  if(kind==="reminder" && (data.terms.posting!=="committed" || !data.terms.due || data.terms.graceDays===null))return "POSTING_OBLIGATION_UNVERIFIED";
  if(kind==="reminder"){
    if(!data.terms.timezone)return "POSTING_TIMEZONE_UNVERIFIED";
    let currentDay:string;
    try {
      const parts = new Intl.DateTimeFormat("en-US",{timeZone:data.terms.timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(data.observedAt));
      const fields=Object.fromEntries(parts.map(p=>[p.type,p.value]));currentDay=fields.year+"-"+fields.month+"-"+fields.day;
    } catch{return "POSTING_TIMEZONE_UNVERIFIED";}
    const boundary=Date.parse(data.terms.due!)+data.terms.graceDays!*86400000;
    if(Date.parse(currentDay)<=boundary)return "POSTING_GRACE_NOT_ELAPSED";
  }
  return null;
}
