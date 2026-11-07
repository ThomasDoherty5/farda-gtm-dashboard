import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "./config.ts";
import type { OperationsScope } from "./operations.ts";
import type { CapabilityLedger } from "./connections/ledger.ts";
import type { JobRepository } from "./jobs/repository.ts";
import type { createProviderHealth } from "./providerHealth.ts";
import { openOperationsToken, sealOperationsToken } from "./operationsTokens.ts";
import { controlPolicy, controlReceiptSchema, nativeOperationsControlSchema, operationsControlAction, operationsControlFilters, operationsControlSourceSchema,operationsHealthAction,operationsHealthResultSchema,
  type NativeOperationsControl, type OperationsControlSnapshot, type OperationsReviewPayload } from "./operationsControlsSchema.ts";

export type OperationsControlSource={read:(scope:OperationsScope)=>Promise<OperationsControlSnapshot>;allowedHandoffOrigins?:readonly string[];allowedHandoffUrls?:readonly string[]};
export class OperationsControlError extends Error{
  readonly code:string;readonly status:number;readonly currentVersion?:string;readonly executionCertainty:"notApplied"|"applied"|"uncertain";
  constructor(code:string,status:number,currentVersion?:string,executionCertainty:"notApplied"|"applied"|"uncertain"="notApplied"){super(code);this.code=code;this.status=status;this.currentVersion=currentVersion;this.executionCertainty=executionCertainty;}
}
type Role="reader"|"reviewer";
type Input={db:DatabaseSync;scope:OperationsScope;secret:string;ledger:CapabilityLedger;jobs:JobRepository;health:ReturnType<typeof createProviderHealth>;source?:OperationsControlSource;now?:()=>number};
type Section=NativeOperationsControl["section"];
const sectionFor={task:"runs",takeover:"runs",repair:"reconciliation",permissionEvidence:"capabilities"} as const;
const targetSchema=z.object({kind:z.enum(["task","takeover","repair","permissionEvidence","run","binding"]),id:z.string().min(1).max(240)}).strict();
function fail(code:string,status:number,currentVersion?:string):never{throw new OperationsControlError(code,status,currentVersion);}
function facts(value:unknown):unknown{
  if(Array.isArray(value))return value.map(facts);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([k])=>k!=="observedAt").map(([k,v])=>[k,facts(v)]));
  return value;
}
export function createOperationsControls(input:Input){
  const {db,scope,ledger,jobs,health,source}=input,now=input.now??Date.now;
  const dbScope=db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
  if(scope.environment!=="sandbox"||dbScope?.workspace_id!==scope.workspaceId||dbScope.account_id!==scope.accountId)fail("DATABASE_SCOPE_MISMATCH",403);
  db.exec(`CREATE TABLE IF NOT EXISTS operations_control_requests(request_key TEXT PRIMARY KEY,actor TEXT NOT NULL,section TEXT NOT NULL,
    target TEXT NOT NULL,request_hash TEXT NOT NULL,receipt TEXT NOT NULL,manifest TEXT,sequence INTEGER UNIQUE NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS operations_control_health_requests(request_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,binding_revision INTEGER NOT NULL,result TEXT);`);
  const alias=(raw:string)=>"reference-"+createHmac("sha256",input.secret).update(JSON.stringify(["controls-display",scope,raw])).digest("hex").slice(0,16);
  const seal=(kind:z.infer<typeof targetSchema>["kind"],id:string)=>sealOperationsToken(scope,input.secret,"operations-control-target",{kind,id});
  function open(ref:string){try{return targetSchema.parse(openOperationsToken(scope,input.secret,"operations-control-target",ref));}catch{return fail("INVALID_CONTROL_REFERENCE",400);}}
  const fresh=(at:string)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now()&&now()-Date.parse(at)<=15*60_000;
  function auth(actor:string,role:Role){if(actor!=="agent-"+role)fail("SOURCE_SCOPE_DENIED",403);}
  async function snapshot(){
    if(!source)return null;
    let raw:unknown;try{raw=await source.read(scope);}catch(error){ if(error instanceof OperationsControlError)throw error; return fail("SOURCE_UNAVAILABLE",503); }
    const result=operationsControlSourceSchema.safeParse(raw);if(!result.success)fail("SOURCE_RESPONSE_INVALID",502);
    const s=result.data;
    if(digest(s.scope)!==digest(scope))fail("SOURCE_SCOPE_DENIED",403);
    if(Date.parse(s.observedAt)>now())fail("SOURCE_RESPONSE_INVALID",502);
    for(const rows of [s.roles,s.tasks,s.takeovers,s.permissions,s.comparisons,s.conflicts,s.reports,s.attribution,s.handoffs,s.runMembership])
      for(const record of rows)if(Date.parse(record.observedAt)>now())fail("SOURCE_RESPONSE_INVALID",502);
    return s;
  }
  function localBasis(){
    return {jobs:db.prepare("SELECT COUNT(*) n,MAX(version) maxVersion FROM job_heads").get(),
      capabilitySequence:db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM capability_events").get()?.n,
      runSequence:db.prepare("SELECT COUNT(*) n,MAX(at) latest FROM job_transitions").get()};
  }
  const version=(s:OperationsControlSnapshot|null)=>"oc1-"+digest([scope,controlPolicy,facts(s),localBasis()]);
  function target(s:OperationsControlSnapshot,kind:OperationsReviewPayload["kind"],id:string){
    return (kind==="task"?s.tasks:kind==="takeover"?s.takeovers:kind==="repair"?s.conflicts:s.permissions).find(r=>r.id===id)??null;
  }
  function hold(s:OperationsControlSnapshot|null,kind:OperationsReviewPayload["kind"],id:string):string|null{
    if(!s)return "INTEGRATION_PENDING";
    if(!fresh(s.observedAt))return "SOURCE_STALE";
    if(s.coverage!=="complete")return "SOURCE_COVERAGE_PARTIAL";
    const t=target(s,kind,id);if(!t)return "RECORD_NOT_FOUND";
    if(!fresh(t.observedAt))return "SOURCE_STALE";
    if(kind==="task"){
      const t=s.tasks.find(r=>r.id===id)!;
      if(t.permission!=="allowed")return t.permission==="denied"?"SOURCE_SCOPE_DENIED":"TASK_PERMISSION_UNVERIFIED";
      try{
        const job=jobs.getJob(t.jobId);
        if(job.definition.version!==t.jobVersion)return "STALE_VERSION";
        if(t.items.length>job.definition.budgets.maxItems)return "TASK_BUDGET_EXCEEDED";
        if(job.definition.capabilityBinding&&!ledger.requireReady(job.definition.capabilityBinding).allowed)return "CAPABILITY_UNVERIFIED";
      }catch{return "RECORD_NOT_FOUND";}
    }else if(kind==="takeover"){
      const t=s.takeovers.find(r=>r.id===id)!;
      if(!t.requestAllowed)return "TAKEOVER_HELD";
      try{const run=jobs.getRun(t.runId);if(!run.items.some(r=>r.itemId===t.itemId))return "RECORD_NOT_FOUND";
        if(["completed","cancelled"].includes(run.state))return "TAKEOVER_HELD";
      }catch{return "RECORD_NOT_FOUND";}
    }else if(kind==="repair"){
      const t=s.conflicts.find(r=>r.id===id)!,comparison=s.comparisons.find(r=>r.id===t.comparisonId);
      if(!comparison||comparison.coverage!=="complete"||!fresh(comparison.observedAt))return "RECONCILIATION_INCOMPLETE";
      if(t.ownership!=="source"||!t.authoritativeVersion||!t.mirrorVersion||!t.repairAllowed||t.state!=="open")return "REPAIR_OWNERSHIP_HELD";
      if(["missing_source","orphan"].includes(t.category))return "REPAIR_OWNERSHIP_HELD";
    }else{
      const t=s.permissions.find(r=>r.id===id)!,binding=ledger.get(t.capabilityId);
      if(!binding)return "RECORD_NOT_FOUND";
      if(!t.verified||t.bindingRevision!==binding.revision)return "PERMISSION_EVIDENCE_UNVERIFIED";
    }
    return null;
  }
  function getReceipt(key:string,actor:string,section:Section,targetRef?:string){
    const row=db.prepare("SELECT * FROM operations_control_requests WHERE request_key=?").get(key);
    if(row&&(row.actor!==actor||row.section!==section))fail("SOURCE_SCOPE_DENIED",403);
    if(row&&targetRef&&row.target!==JSON.stringify(open(targetRef)))fail("SOURCE_SCOPE_DENIED",403);
    return row?controlReceiptSchema.parse(JSON.parse(String(row.receipt))):null;
  }
  function history(actor:string,section:Section){
    const total=Number(db.prepare("SELECT COUNT(*) n FROM operations_control_requests WHERE actor=? AND section=?").get(actor,section)?.n);
    const records=db.prepare("SELECT receipt FROM operations_control_requests WHERE actor=? AND section=? ORDER BY sequence DESC LIMIT 20").all(actor,section)
      .map(r=>controlReceiptSchema.parse(JSON.parse(String(r.receipt))));
    return {records,coverage:{total,returned:records.length,partial:total>records.length}};
  }
  const safeValue=(v:OperationsControlSnapshot["conflicts"][number]["sourceValue"])=>!v?"Unknown":v.kind==="money"?String(v.minorUnits)+" minor "+v.currency:v.kind==="redacted"?"Source-private value redacted":String(v.value);
  const categoryTitle={"daily-acquisition":"Daily acquisition","daily-review":"Daily evidence review","hourly-monitor":"Hourly monitoring",report:"Reporting"};
  const providers=new Set(["notion","zapier","linear","shopify","google-sheets","quickbooks","shippo","tiktok","meta","intercom"]);
  const display=(v:string|null|undefined)=>v??"Unknown";
  async function read(raw:unknown,actorRef:string,role:Role){
    auth(actorRef,role);
    const parsed=operationsControlFilters.safeParse(raw);if(!parsed.success)fail("INVALID_REQUEST",400);const f=parsed.data;
    if(f.proposalRequestKey&&role!=="reviewer")fail("SOURCE_SCOPE_DENIED",403);
    const s=await snapshot(),v=version(s),sourceState=!s?"notConnected":!fresh(s.observedAt)?"stale":s.coverage==="partial"?"partial":"current";
    let reportJob:string|null=null;
    if(f.jobRef){
      if(f.section!=="reports")fail("INVALID_REQUEST",400);
      try{const id=openOperationsToken(scope,input.secret,"schedule-job",f.jobRef);if(typeof id!=="string")throw new Error();jobs.getJob(id);reportJob=id;}catch{fail("INVALID_CONTROL_REFERENCE",400);}
    }
    const records:NativeOperationsControl["records"]=[],actions:NativeOperationsControl["actions"]=[],healthTargets:NativeOperationsControl["healthTargets"]=[];
    const row=(id:string,title:string,details:[string,string][])=>records.push({id:alias(id),title,details});
    if(s){
      if(f.section==="team")for(const r of s.roles)row(r.id,(providers.has(r.provider)?r.provider:"Registered provider")+" · "+alias(r.account),[["Provider role",display(r.role)],["Owner",r.ownerRef?alias(r.ownerRef):"Unknown"],["Backup",r.backupRef?alias(r.backupRef):"Unknown"],["Evidence",alias(r.evidenceRef)],["Source version",alias(r.sourceVersion)],["Observed",r.observedAt]]);
      if(f.section==="reports")for(const r of s.reports.filter(r=>!reportJob||r.jobId===reportJob))row(r.id,categoryTitle[r.category],[["Category",r.category],["Cadence",r.cadence],["Timezone",r.timezone],["Configuration",r.configuration],["Destination",r.destination?r.destination.kind+" · "+alias(r.destination.ref):"Unknown"],["Owner",r.ownerRef?alias(r.ownerRef):"Unknown"],["Last complete",display(r.lastCompleteAt)],["Next source run",display(r.nextRunAt)],...r.preview.map(p=>[p.label,p.value===null?"Unknown":String(p.value)] as [string,string]),["Delivery history coverage",Math.min(50,r.history.length)+" shown of "+r.history.length+" returned; total source history unknown"],...r.history.slice(0,50).map(h=>["Delivery "+h.at,h.state+" · "+(h.receiptRef?alias(h.receiptRef):"Receipt unknown")] as [string,string])] as [string,string][]);
      if(f.section==="capabilities")for(const r of s.attribution)row(r.id,"Attribution verification",[["Account",alias(r.account)],["Expected",r.expected],["Observed",display(r.observed)],["State",r.state],["Evidence",alias(r.evidenceRef)],["Observed at",r.observedAt]]);
      if(f.section==="reconciliation"){
        for(const r of s.comparisons)row(r.id,"Source / mirror comparison",[["Coverage",r.coverage],["Grain",r.grain],["Window",r.period.startAt+" — "+r.period.endAt],["Timezone",r.period.timezone],["Currency",r.currency],["Source keys",r.sourceCount===null?"Unknown":String(r.sourceCount)],["Mirror keys",r.mirrorCount===null?"Unknown":String(r.mirrorCount)],["Source amount",r.sourceAmount?String(r.sourceAmount.minorUnits)+" minor "+r.currency:"Unknown"],["Mirror amount",r.mirrorAmount?String(r.mirrorAmount.minorUnits)+" minor "+r.currency:"Unknown"],["Cutoff",r.cutoff],["Evidence",alias(r.evidenceRef)]]);
        for(const r of s.conflicts)row(r.id,r.field,[["Category",r.category],["Ownership",r.ownership],["Source",safeValue(r.sourceValue)],["Mirror",safeValue(r.mirrorValue)],["State",r.state],["Authoritative version",r.authoritativeVersion?alias(r.authoritativeVersion):"Unknown"],["Mirror version",r.mirrorVersion?alias(r.mirrorVersion):"Unknown"],["Repair receipt",r.receiptRef?alias(r.receiptRef):"Unknown"]]);
      }
      const add=(kind:OperationsReviewPayload["kind"],id:string,title:string,details:[string,string][])=>{
        const reason=role!=="reviewer"?"REVIEWER_REQUIRED":hold(s,kind,id);
        actions.push({kind,targetRef:seal(kind,id),title,details,allowed:!reason,reasonCodes:reason?[reason]:[]});
      };
      if(f.section==="runs"){
        for(const t of s.tasks)add("task",t.id,categoryTitle[t.category]+" task",[["Cadence group",t.category],["Job version",String(t.jobVersion)],["Finite item count",String(t.items.length)],["Owner",alias(t.ownerRef)],["Permission",t.permission],...t.items.map(i=>["Item",alias(i.itemKey)+" · "+alias(i.subjectRef)] as [string,string])]);
        for(const t of s.takeovers)add("takeover",t.id,"Human takeover review",[["Reason",t.reason],["Run",alias(t.runId)],["Assignment",t.assignment?alias(t.assignment.actorRef):"No confirmed assignment"],["Assignment receipt",t.assignment?alias(t.assignment.receiptRef):"Unknown"]]);
      }
      if(f.section==="capabilities")for(const t of s.permissions)add("permissionEvidence",t.id,"Permission evidence review",[["Receipt",alias(t.receiptRef)],["Source verified",t.verified?"Yes":"No"],["Effect","No permission is granted by recording a proposal"]]);
      if(f.section==="reconciliation")for(const t of s.conflicts)add("repair",t.id,"Repair "+t.field,[["Ownership",t.ownership],["Category",t.category],["Effect","Proposal only; source owner applies and verifies any repair"]]);
    }
    if(f.section==="connections"||f.section==="capabilities")for(const b of ledger.list(100).records){
      const h=health.get(b.capabilityId);
      const denied=role!=="reviewer"?"REVIEWER_REQUIRED":!h?.configured?"PROVIDER_HEALTH_TARGET_UNAVAILABLE":b.state!=="Ready"||ledger.hasDeniedActionRoute(b.registration.binding)||h.permission==="denied"?"PROVIDER_PERMISSION_HELD":null;
      healthTargets.push({targetRef:seal("binding",b.capabilityId),title:"Check "+(providers.has(b.registration.binding.provider)?b.registration.binding.provider:"registered provider"),allowed:!denied,reasonCodes:denied?[denied]:[]});
      row(b.capabilityId,"Saved binding "+alias(b.capabilityId),[["Provider",providers.has(b.registration.binding.provider)?b.registration.binding.provider:"Registered provider"],["Action",alias(b.registration.binding.action)],
        ["State",b.state],["Revision",String(b.revision)],["Permission checked",display(b.checkedAt)],["Source checked",display(h?.checkedAt)],
        ["Session",h?.session??"unknown"],["Source coverage",h?.coverage??"unknown"],["Freshness",h?.freshness??"unknown"],["Recovery",b.recovery]]);
    }
    const runTotal=Number(db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n);
    const runRows=f.section==="runs"?db.prepare("SELECT run_id FROM job_runs ORDER BY observed_at DESC,run_id DESC LIMIT 100").all():[];
    let unknownPlatform=0;
    let localRuns:NativeOperationsControl["localRuns"]=runRows.flatMap(r=>{
      const run=jobs.getRun(String(r.run_id)),h=jobs.history(run.runId,20);
      const membership=s?.runMembership.find(m=>m.runId===run.runId),currentMembership=sourceState==="current"&&membership&&fresh(membership.observedAt)?membership:null;
      const platform=currentMembership?.platform??null;if(!platform)unknownPlatform++;
      if(f.platform&&platform!==f.platform)return [];
      return [{id:seal("run",run.runId),title:alias(run.runId),details:[
        ["Source platform",platform??"Unknown"],["Assigned source actor",currentMembership?.assignedActorRef?alias(currentMembership.assignedActorRef):"Unknown"],
        ["State",run.state],["Job version",String(run.definition.version)],["Mode",run.definition.mode],["Observed",run.observedAt],["Due items",String(run.counts.due)],
        ["Completed",String(run.counts.completed)],["Uncertain",String(run.counts.reconcile)],["Checkpoint policy","Completed items are preserved; uncertain effects are not retried"],
        ["History coverage",h.transitions.length+" of "+h.total],...h.transitions.map(e=>[String(e.kind),String(e.at)] as [string,string]),
        ...run.items.slice(0,20).map(i=>["Item "+alias(i.itemId),i.state+" · checkpoint "+i.checkpointVersion+" · "+(i.result
          ? i.result.schemaVersion === "job-local-result.v1" ? "Local receipt "+alias(i.result.artifactRef)
            : (i.result.sourceEffect === "providerApplied" ? "Confirmed source receipt " : "Artifact receipt ")+alias(i.result.receiptRef)
          : "No result receipt")] as [string,string])
      ] as [string,string][]}];
    });
    if(f.q)localRuns=localRuns.filter(r=>JSON.stringify(r).toLowerCase().includes(f.q!.toLowerCase()));
    // A role-scoped principal is not a named source owner. Do not invent assigned-to-me membership.
    if(f.mine)localRuns=[];

    let reconciliation=f.proposalRequestKey?getReceipt(f.proposalRequestKey,actorRef,f.section,f.targetRef):null;
    if(f.proposalRequestKey&&!reconciliation)reconciliation=controlReceiptSchema.parse({requestKey:f.proposalRequestKey,actorRef,state:sourceState==="current"?"absent":"unverified",baseVersion:null,actionRef:null,manifestDigest:null,payloadDigest:null,createdAt:null,reason:null});
    const hs=history(actorRef,f.section);
    const handoffs:NativeOperationsControl["handoffs"]=[];
    if(s&&sourceState==="current")for(const h of s.handoffs){
      const b=ledger.get(h.capabilityId);if(!b||!fresh(h.observedAt))continue;
      const u=new URL(h.url);
      if(u.protocol!=="https:"||u.username||u.password||u.hash||(!source?.allowedHandoffOrigins?.includes(u.origin)||!source.allowedHandoffUrls?.includes(u.toString())))continue;
      // OAuth/session secrets are never relayed through the dashboard.
      if([...u.searchParams.keys()].some(k=>/token|secret|code|auth|session|key/i.test(k)))continue;
      handoffs.push({title:"Open "+h.kind,url:u.toString(),targetRef:seal("binding",h.capabilityId)});
    }
    if(f.targetRef){const t=open(f.targetRef);
      if(t.kind==="run"){const selected=localRuns.find(r=>open(r.id).id===t.id);if(!selected)fail("RECORD_NOT_FOUND",404);localRuns=[selected];}
      else if(t.kind==="binding"&&!ledger.get(t.id))fail("RECORD_NOT_FOUND",404);
      else if(!["run","binding"].includes(t.kind)&&(!s||!target(s,t.kind as OperationsReviewPayload["kind"],t.id)))fail("RECORD_NOT_FOUND",404);
    }
    const data=nativeOperationsControlSchema.parse({kind:"native-operations-controls",section:f.section,version:v,observedAt:new Date(now()).toISOString(),actorRef,role,sourceState,sourceObservedAt:s?.observedAt??null,
      records,actions,healthTargets,localRuns,localCoverage:{returned:runRows.length,total:f.section==="runs"?runTotal:0,partial:f.section==="runs"&&runRows.length<runTotal},
      runFilterEvidence:{matched:localRuns.length,unknownPlatform,assignment:"named-principal-unverified"},
      handoffs,proposalReconciliation:reconciliation,history:hs.records,historyCoverage:hs.coverage});
    return {data,version:v,observedAt:data.observedAt,partial:sourceState==="partial"||data.localCoverage.partial||((f.section==="connections"||f.section==="capabilities")&&ledger.list(100).partial),stale:sourceState==="stale",empty:!records.length&&!actions.length&&!localRuns.length,
      capabilities:[{actionKind:"proposeOperationsReview",state:role==="reader"?"denied" as const:actions.some(a=>a.allowed)?"available" as const:"held" as const,reasonCodes:role==="reader"?["REVIEWER_REQUIRED"]:actions.some(a=>a.allowed)?[]:["SOURCE_AUTHORITY_UNAVAILABLE"]}]};
  }
  function ack(r:z.infer<typeof controlReceiptSchema>){return {actionRef:r.actionRef!,state:"approvalPending" as const,payloadVersion:r.manifestDigest!,policyVersion:controlPolicy,receiptRefs:["proposal:"+r.actionRef]};}
  async function propose(raw:unknown,actorRef:string,role:Role){
    auth(actorRef,role);if(role!=="reviewer")fail("SOURCE_SCOPE_DENIED",403);
    const parsed=operationsControlAction.safeParse(raw);if(!parsed.success)fail("VALIDATION_FAILED",422);const a=parsed.data;
    if(a.requestedScope.workspaceId!==scope.workspaceId||a.requestedScope.accountIds[0]!==scope.accountId)fail("SOURCE_SCOPE_DENIED",403);
    const t=open(a.payload.targetRef);if(t.kind!==a.payload.kind)fail("INVALID_CONTROL_REFERENCE",400);
    const logical={scope,actorRef,kind:a.payload.kind,target:t.id,reason:a.payload.reason,base:a.expectedVersion},hash=digest([logical,a.payload]);
    const old=db.prepare("SELECT request_hash,receipt FROM operations_control_requests WHERE request_key=?").get(a.idempotencyKey);
    if(old){if(old.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);const r=controlReceiptSchema.parse(JSON.parse(String(old.receipt)));
      if(r.state==="rejected")fail("STALE_VERSION",409);return ack(r);}
    const first=await snapshot();if(!first)fail("INTEGRATION_PENDING",503);
    const firstDigest=digest(facts(first));
    const s=await snapshot();if(!s)fail("INTEGRATION_PENDING",503);
    if(firstDigest!==digest(facts(s)))fail("SOURCE_CHANGED",409);
    db.exec("BEGIN IMMEDIATE");let closed=false;
    try{
      const existing=db.prepare("SELECT request_hash,receipt FROM operations_control_requests WHERE request_key=?").get(a.idempotencyKey);
      if(existing){if(existing.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);const r=controlReceiptSchema.parse(JSON.parse(String(existing.receipt)));
        if(r.state==="rejected")fail("STALE_VERSION",409);db.exec("COMMIT");closed=true;return ack(r);}
      if(!fresh(s.observedAt))fail("SOURCE_STALE",409);
      if(s.coverage!=="complete")fail("SOURCE_COVERAGE_PARTIAL",409);
      const current=version(s),member=target(s,a.payload.kind,t.id);
      const save=(state:"recorded"|"rejected")=>{
        const actionRef=state==="recorded"?"control-review-"+randomUUID():null;
        const manifest={...logical,source:facts(member),sourceRevision:s.revision,policy:controlPolicy};
        const receipt=controlReceiptSchema.parse({requestKey:a.idempotencyKey,actorRef,state,baseVersion:a.expectedVersion,actionRef,
          manifestDigest:state==="recorded"?digest(manifest):null,payloadDigest:digest(a.payload),createdAt:new Date(now()).toISOString(),reason:a.payload.reason});
        db.prepare("INSERT INTO operations_control_requests VALUES(?,?,?,?,?,?,?,?)").run(a.idempotencyKey,actorRef,sectionFor[a.payload.kind],JSON.stringify(t),hash,JSON.stringify(receipt),state==="recorded"?JSON.stringify(manifest):null,
          Number(db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM operations_control_requests").get()?.n));
        db.exec("COMMIT");closed=true;return receipt;
      };
      // A complete changed basis seals the original request as a no-op, preventing a late old submission.
      if(current!==a.expectedVersion||!member){save("rejected");fail("STALE_VERSION",409,current);}
      const reason=hold(s,a.payload.kind,t.id);if(reason)fail(reason,reason==="SOURCE_SCOPE_DENIED"?403:409,current);
      return ack(save("recorded"));
    }catch(error){if(!closed)db.exec("ROLLBACK");throw error;}
  }
  async function refreshHealth(raw:unknown,actorRef:string,role:Role){
    auth(actorRef,role);if(role!=="reviewer")fail("SOURCE_SCOPE_DENIED",403);
    const parsed=operationsHealthAction.safeParse(raw);if(!parsed.success)fail("VALIDATION_FAILED",422);const a=parsed.data;
    if(a.requestedScope.workspaceId!==scope.workspaceId||a.requestedScope.accountIds[0]!==scope.accountId)fail("SOURCE_SCOPE_DENIED",403);
    const t=open(a.payload.targetRef);if(t.kind!=="binding")fail("INVALID_CONTROL_REFERENCE",400);
    const hash=digest([scope,actorRef,a.payload,a.expectedVersion]);
    let prior=db.prepare("SELECT * FROM operations_control_health_requests WHERE request_key=?").get(a.idempotencyKey);
    if(prior&&prior.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);
    const priorCertainty=()=>prior?.result?operationsHealthResultSchema.parse(JSON.parse(String(prior.result))).executionCertainty:prior?"uncertain" as const:"notApplied" as const;
    let sourceSnapshot:OperationsControlSnapshot|null;
    try{sourceSnapshot=await snapshot();}catch(error){
      prior=db.prepare("SELECT * FROM operations_control_health_requests WHERE request_key=?").get(a.idempotencyKey);
      if(error instanceof OperationsControlError)throw new OperationsControlError(error.code,error.status,error.currentVersion,priorCertainty());throw error;
    }
    // Another request may establish or complete this exact command while source authority is awaited.
    prior=db.prepare("SELECT * FROM operations_control_health_requests WHERE request_key=?").get(a.idempotencyKey);
    if(prior&&prior.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);
    const binding=ledger.get(t.id);if(!binding)throw new OperationsControlError("RECORD_NOT_FOUND",404,undefined,priorCertainty());
    if(prior?.result){
      const historical=operationsHealthResultSchema.parse(JSON.parse(String(prior.result))),current=health.get(t.id);
      if(historical.executionCertainty!=="applied")return historical;
      const permitted=binding.state==="Ready"&&!ledger.hasDeniedActionRoute(binding.registration.binding)&&current?.permission!=="denied";
      return {...historical,state:permitted&&current?.state==="ready"&&prior.binding_revision===binding.revision?"succeeded" as const:"blocked" as const,
        reasonCodes:!permitted?["PROVIDER_PERMISSION_HELD"]:current?.reasonCodes??["SOURCE_HEALTH_UNKNOWN"]};
    }
    if(!prior&&version(sourceSnapshot)!==a.expectedVersion)fail("STALE_VERSION",409,version(sourceSnapshot));
    if(prior&&prior.binding_revision!==binding.revision)throw new OperationsControlError("STALE_VERSION",409,version(sourceSnapshot),priorCertainty());
    const summary=health.get(t.id),held=!summary?.configured?"PROVIDER_HEALTH_TARGET_UNAVAILABLE":binding.state!=="Ready"||ledger.hasDeniedActionRoute(binding.registration.binding)||summary.permission==="denied"?"PROVIDER_PERMISSION_HELD":null;
    db.prepare("INSERT OR IGNORE INTO operations_control_health_requests VALUES(?,?,?,NULL)").run(a.idempotencyKey,hash,binding.revision);
    const concurrent=db.prepare("SELECT request_hash,result FROM operations_control_health_requests WHERE request_key=?").get(a.idempotencyKey);
    if(concurrent?.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);
    if(concurrent.result)return operationsHealthResultSchema.parse(JSON.parse(String(concurrent.result)));
    const base={actionRef:"control-health-"+digest([scope,actorRef,a.idempotencyKey]),payloadVersion:hash,policyVersion:controlPolicy};
    const finish=(result:unknown)=>{const r=operationsHealthResultSchema.parse(result);db.prepare("UPDATE operations_control_health_requests SET result=? WHERE request_key=? AND request_hash=?").run(JSON.stringify(r),a.idempotencyKey,hash);return r;};
    if(held)return finish({...base,state:"blocked",runRef:null,receiptRefs:[],reasonCodes:[held],executionCertainty:"notApplied"});
    try{
      const result=await health.check({capabilityId:t.id,eventId:"controls-"+hash},"controls-"+digest([scope,actorRef,a.idempotencyKey]));
      if(result.state==="held"&&result.runId){const run=jobs.getRun(result.runId);if(run.state==="running")return {...base,state:"outcomeUncertain" as const,runRef:seal("run",result.runId),receiptRefs:[],reasonCodes:["HEALTH_CHECK_IN_PROGRESS"],executionCertainty:"uncertain" as const};}
      const recorded=finish({...base,state:result.state==="observed"&&result.health?.state==="ready"?"succeeded":"blocked",runRef:result.runId?seal("run",result.runId):null,
        receiptRefs:result.observationId?["health-observation:"+alias(result.observationId)]:[],reasonCodes:result.state==="observed"?result.health?.reasonCodes??["SOURCE_HEALTH_UNKNOWN"]:result.state==="unconfigured"?["PROVIDER_HEALTH_TARGET_UNAVAILABLE"]:["HEALTH_JOB_HELD"],executionCertainty:result.state==="observed"?"applied":"notApplied"});
      try{await snapshot();}catch(error){if(error instanceof OperationsControlError)throw new OperationsControlError(error.code,error.status,error.currentVersion,recorded.executionCertainty);throw error;}
      const currentBinding=ledger.get(t.id),currentHealth=health.get(t.id);
      if(recorded.executionCertainty==="applied"&&(!currentBinding||currentBinding.state!=="Ready"||currentBinding.revision!==binding.revision||currentHealth?.state!=="ready"))return {...recorded,state:"blocked" as const,reasonCodes:currentHealth?.reasonCodes??["PROVIDER_PERMISSION_HELD"]};
      return recorded;
    }catch(error){if(error instanceof OperationsControlError)throw error;return {...base,state:"outcomeUncertain" as const,runRef:null,receiptRefs:[],reasonCodes:["HEALTH_CHECK_UNVERIFIED"],executionCertainty:"uncertain" as const};}
  }
  return {read,propose,refreshHealth};
}
