import { z } from "zod";
import { safeRuntimeRegistrationSchema, safeRuntimeRunSchema } from "./jobs/runtimeViews.ts";
import { reportReadSchema } from "./slackReporting/contract.ts";

const ref = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(v => !/^https?:/i.test(v), "Use a reference.");
const text = z.string().trim().min(1).max(300);
const instant = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
const n = z.number().int().nonnegative().safe();
const version = z.string().regex(/^oc1-[a-f0-9]{64}$/);
const opaque = z.string().min(1).max(4100);
export const controlPolicy = "operations-controls.v1";
export const controlSections = ["connections","team","runs","reports","capabilities","reconciliation"] as const;
export const controlPlatforms = ["instagram","tiktok","social-cat","shopify","email","other"] as const;
export const operationsControlFilters = z.object({ section:z.enum(controlSections), targetRef:opaque.optional(),
  proposalRequestKey:ref.optional(), jobRef:opaque.optional(), q:z.string().max(120).optional(), platform:z.enum(controlPlatforms).optional(), mine:z.boolean().optional() }).strict();
export type OperationsControlFilters = z.infer<typeof operationsControlFilters>;
const proof = { sourceVersion:ref, evidenceRef:ref, observedAt:instant };
const role = z.object({id:ref,provider:text,account:text,role:z.enum(["owner","administrator","editor","member","viewer"]).nullable(),ownerRef:ref.nullable(),backupRef:ref.nullable(),...proof}).strict();
const task = z.object({id:ref,title:text,jobId:ref,jobVersion:n.positive(),category:z.enum(["daily-acquisition","daily-review","hourly-monitor","report"]),
  permission:z.enum(["allowed","denied","unknown"]),ownerRef:ref, ...proof,
  items:z.array(z.object({itemKey:ref,subjectRef:ref,evidenceRef:ref.nullable()}).strict()).min(1).max(100) }).strict();
const takeover = z.object({id:ref,runId:ref,itemId:ref,reason:z.enum(["login","mfa","ui_changed","outcome_uncertain","owner_review"]),requestAllowed:z.boolean(),
  assignment:z.object({actorRef:ref,receiptRef:ref,version:ref}).strict().nullable(),...proof}).strict();
const permission = z.object({id:ref,capabilityId:z.string().regex(/^[a-f0-9]{64}$/),receiptRef:ref,bindingRevision:n.positive(),verified:z.boolean(),...proof}).strict();
const timezone=z.string().refine(v=>{try{new Intl.DateTimeFormat("en",{timeZone:v});return true;}catch{return false;}},"Use an IANA timezone.");
const amount = z.object({minorUnits:z.number().int().safe(),currency:z.string().regex(/^[A-Z]{3}$/)}).strict();
const comparison = z.object({id:ref,label:text,grain:z.enum(["order","shipment","inventory","support","finance-summary"]),period:z.object({startAt:instant,endAt:instant,timezone}).strict(),
  currency:z.string().regex(/^[A-Z]{3}$/),sourceCount:n.nullable(),mirrorCount:n.nullable(),sourceAmount:amount.nullable(),mirrorAmount:amount.nullable(),
  coverage:z.enum(["complete","partial","failed","unknown"]),cutoff:instant,...proof}).strict().superRefine((v,c)=>{
  if(Date.parse(v.period.startAt)>=Date.parse(v.period.endAt)||Date.parse(v.period.endAt)>Date.parse(v.cutoff)||Date.parse(v.cutoff)>Date.parse(v.observedAt))c.addIssue({code:"custom",message:"Invalid comparison period."});
  for(const a of [v.sourceAmount,v.mirrorAmount])if(a&&a.currency!==v.currency)c.addIssue({code:"custom",message:"Comparison currency mismatch."});
});
const safeValue=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("count"),value:n}).strict(),
 z.object({kind:z.literal("money"),minorUnits:z.number().int().safe(),currency:z.string().regex(/^[A-Z]{3}$/)}).strict(),
 z.object({kind:z.literal("presence"),value:z.enum(["present","missing","duplicate","unknown"])}).strict(),
 z.object({kind:z.literal("state"),value:z.enum(["open","closed","pending","confirmed","unknown"])}).strict(),
 z.object({kind:z.literal("redacted"),fingerprint:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict(),
]);
const conflict = z.object({id:ref,comparisonId:ref,category:z.enum(["missing_source","missing_mirror","orphan","duplicate","amount","field"]),
  field:z.enum(["net-sales","label-cost","refund-total","record-key","record-count","record-status"]),ownership:z.enum(["source","local","unknown"]),sourceValue:safeValue.nullable(),mirrorValue:safeValue.nullable(),
  authoritativeVersion:ref.nullable(),mirrorVersion:ref.nullable(),ownershipVersion:ref,repairAllowed:z.boolean(),
  state:z.enum(["open","proposed","applied","resolved","unknown"]),receiptRef:ref.nullable(),...proof}).strict();
const report = z.object({id:ref,jobId:ref,title:text,category:z.enum(["daily-acquisition","daily-review","hourly-monitor","report"]),
  cadence:z.enum(["hourly","daily","weekdays","weekly-monday","source-event","unknown"]),timezone,configuration:z.enum(["unconfigured","draft","paused","enabled","unknown"]),ownerRef:ref.nullable(),destination:z.object({kind:z.enum(["registered-channel","registered-report"]),ref}).strict().nullable(),
  lastCompleteAt:instant.nullable(),nextRunAt:instant.nullable(),preview:z.array(z.object({label:z.enum(["creator-followups","stock-exceptions","source-failures","reconciliation-conflicts","pending-reviews"]),value:n.nullable()}).strict()).max(50),
  history:z.array(z.object({id:ref,at:instant,state:z.enum(["confirmed","partial","failed","uncertain"]),receiptRef:ref.nullable()}).strict()).max(100),...proof}).strict();
const attribution = z.object({id:ref,title:text,account:text,expected:z.enum(["identity","checkout-attribution","refund-reversal","payout-export","quota-permission"]),observed:z.enum(["matched","mismatched","incomplete"]).nullable(),state:z.enum(["passed","failed","notRun","unknown"]),...proof}).strict();
const handoff = z.object({id:ref,capabilityId:z.string().regex(/^[a-f0-9]{64}$/),kind:z.enum(["setup","source","owner","commitment"]),
  url:z.string().url().max(2000),...proof}).strict();
export const operationsControlSourceSchema = z.object({
  scope:z.object({workspaceId:ref,accountId:ref,environment:z.literal("sandbox")}).strict(), revision:ref,observedAt:instant,
  coverage:z.enum(["complete","partial"]), roles:z.array(role).max(100),tasks:z.array(task).max(100),takeovers:z.array(takeover).max(100),
  permissions:z.array(permission).max(100),comparisons:z.array(comparison).max(100),conflicts:z.array(conflict).max(100),reports:z.array(report).max(100),
  attribution:z.array(attribution).max(100),handoffs:z.array(handoff).max(100),
  runMembership:z.array(z.object({id:ref,runId:ref,platform:z.enum(controlPlatforms).nullable(),assignedActorRef:ref.nullable(),...proof}).strict()).max(100).default([]),
}).strict().superRefine((s,c)=>{
  for(const rows of [s.roles,s.tasks,s.takeovers,s.permissions,s.comparisons,s.conflicts,s.reports,s.attribution,s.handoffs,s.runMembership])
    if(new Set(rows.map(v=>v.id)).size!==rows.length)c.addIssue({code:"custom",message:"Duplicate source identity."});
  for(const t of s.tasks)if(new Set(t.items.map(v=>v.itemKey)).size!==t.items.length)c.addIssue({code:"custom",message:"Duplicate task item."});
  if(new Set(s.runMembership.map(v=>v.runId)).size!==s.runMembership.length)c.addIssue({code:"custom",message:"Duplicate run membership."});
  for(const f of s.conflicts){
    const comparison=s.comparisons.find(v=>v.id===f.comparisonId);
    if(!comparison)c.addIssue({code:"custom",message:"Conflict comparison missing."});
    for(const v of [f.sourceValue,f.mirrorValue])if(v?.kind==="money"&&v.currency!==comparison?.currency)c.addIssue({code:"custom",message:"Conflict currency mismatch."});
  }
  for(const r of s.reports){
    if(r.lastCompleteAt&&Date.parse(r.lastCompleteAt)>Date.parse(r.observedAt))c.addIssue({code:"custom",message:"Future source completion."});
    for(const h of r.history)if(Date.parse(h.at)>Date.parse(r.observedAt))c.addIssue({code:"custom",message:"Future source history."});
  }
  for(const a of s.attribution)if(a.state==="passed"&&a.observed!=="matched")c.addIssue({code:"custom",message:"Passing attribution needs a matched source result."});
});
export type OperationsControlSnapshot=z.infer<typeof operationsControlSourceSchema>;
export const operationsReviewPayload = z.object({kind:z.enum(["task","takeover","repair","permissionEvidence"]),targetRef:opaque,
  reason:z.string().trim().min(1).max(1000)}).strict();
export type OperationsReviewPayload=z.infer<typeof operationsReviewPayload>;
export const operationsControlAction = z.object({schemaVersion:z.string(),requestId:ref,operation:z.literal("requestApproval"),
  actionKind:z.literal("proposeOperationsReview"),requestedScope:z.object({workspaceId:ref,accountIds:z.array(ref).length(1),environment:z.literal("sandbox")}).strict(),
  entityRefs:z.array(z.never()).max(0),approvalRef:z.null(),manifestRef:z.null(),runRef:z.null().optional(),expectedVersion:version,
  idempotencyKey:ref,payload:operationsReviewPayload}).strict();
export const operationsHealthPayload=z.object({targetRef:opaque}).strict();
export const operationsHealthAction=operationsControlAction.extend({operation:z.literal("refreshObservation"),actionKind:z.literal("refreshOperationsHealth"),payload:operationsHealthPayload});
export const operationsCanonicalPayload=operationsReviewPayload.extend({itemRefs:z.array(ref).min(1).max(100).refine(v=>new Set(v).size===v.length).optional()}).strict();
export const operationsCanonicalAction=operationsControlAction.extend({operation:z.literal("previewAction"),actionKind:z.literal("previewOperationsControl"),payload:operationsCanonicalPayload});
export const operationsHealthResultSchema=z.object({actionRef:ref,state:z.enum(["succeeded","blocked","outcomeUncertain"]),payloadVersion:z.string().regex(/^[a-f0-9]{64}$/),policyVersion:z.literal(controlPolicy),runRef:opaque.nullable(),receiptRefs:z.array(ref),reasonCodes:z.array(ref),executionCertainty:z.enum(["notApplied","applied","uncertain"])}).strict();
export const controlReceiptSchema=z.object({requestKey:ref,actorRef:ref,state:z.enum(["recorded","absent","rejected","unverified"]),
  baseVersion:version.nullable(),actionRef:ref.nullable(),manifestDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdAt:instant.nullable(),reason:z.string().max(1000).nullable()}).strict();
const action = z.object({kind:operationsReviewPayload.shape.kind,targetRef:opaque,title:text,details:z.array(z.tuple([text,z.string().max(1000)])).max(110),
  allowed:z.boolean(),reasonCodes:z.array(ref).max(20)}).strict();
const row=z.object({id:opaque,title:text,details:z.array(z.tuple([text,z.string().max(1000)])).max(120)}).strict();
export const operationsServiceEvidenceSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("runtimeRegistration"),targetRef:opaque,data:safeRuntimeRegistrationSchema}).strict(),
  z.object({kind:z.literal("runtimeRun"),targetRef:opaque,data:safeRuntimeRunSchema}).strict(),
  z.object({kind:z.literal("report"),targetRef:opaque,data:reportReadSchema}).strict(),
  z.object({kind:z.enum(["repairReceipt","permissionReceipt","takeoverReceipt"]),targetRef:opaque,receiptRef:ref,sourceVersion:ref,
    state:z.enum(["requested","assigned","applied","resolved","uncertain","rejected"]),observedAt:instant,
    sourceReadbackVersion:ref.nullable(),mirrorReadbackVersion:ref.nullable(),ownerRef:ref}).strict(),
  z.object({kind:z.literal("unavailable"),targetRef:opaque,service:z.enum(["runtimeRegistration","runtimeRun","report"]),reasonCode:ref}).strict(),
]);
export type OperationsServiceEvidence=z.infer<typeof operationsServiceEvidenceSchema>;
export const nativeOperationsControlSchema=z.object({kind:z.literal("native-operations-controls"),section:z.enum(controlSections),version,observedAt:instant,
  actorRef:ref,role:z.enum(["reader","reviewer"]),sourceState:z.enum(["current","stale","partial","notConnected"]),sourceObservedAt:instant.nullable(),
  actions:z.array(action).max(200),records:z.array(row).max(300),localRuns:z.array(row).max(100),
  healthTargets:z.array(z.object({targetRef:opaque,title:text,allowed:z.boolean(),reasonCodes:z.array(ref)}).strict()).max(100),
  localCoverage:z.object({returned:n,total:n,partial:z.boolean()}).strict(),
  runFilterEvidence:z.object({matched:n,unknownPlatform:n,assignment:z.enum(["named-principal-unverified","named-principal-verified"])}).strict(),
  namedActor:z.object({state:z.enum(["verified","unavailable"]),personRef:ref.nullable(),roles:z.array(z.enum(["founder","operator","reviewer","finance","viewer"])),observedAt:instant.nullable(),validUntil:instant.nullable()}).strict().optional(),
  canonicalActions:z.array(action.extend({items:z.array(z.object({itemRef:ref,targetRef:ref,units:n,spendMinor:n}).strict()).min(1).max(100),effect:z.literal("previewOnly")})).max(200).optional(),
  canonicalReconciliation:z.object({requestKey:ref,state:z.enum(["recorded","pending","absent","rejected","unverified"]),approvalRef:ref.nullable(),manifestRef:ref.nullable(),version:ref.nullable(),executionCertainty:z.enum(["notApplied","applied","uncertain"])}).strict().nullable().optional(),
  serviceEvidence:z.array(operationsServiceEvidenceSchema).max(200).optional(),
  handoffs:z.array(z.object({title:text,url:z.string().url(),targetRef:opaque}).strict()).max(100),
  proposalReconciliation:controlReceiptSchema.nullable(),
  history:z.array(controlReceiptSchema).max(20),historyCoverage:z.object({returned:n,total:n,partial:z.boolean()}).strict(),
}).strict();
export type NativeOperationsControl=z.infer<typeof nativeOperationsControlSchema>;
