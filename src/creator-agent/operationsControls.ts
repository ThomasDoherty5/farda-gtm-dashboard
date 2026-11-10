import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "./config.ts";
import type { OperationsScope } from "./operations.ts";
import type { CapabilityLedger } from "./connections/ledger.ts";
import type { JobRepository } from "./jobs/repository.ts";
import type { createProviderHealth } from "./providerHealth.ts";
import { openOperationsToken, sealOperationsToken } from "./operationsTokens.ts";
import {assertSynchronousVoid} from "./sourceFence.ts";
import {boundedSourceRead} from "./actions/readBoundary.ts";
import {type OperationsControlAuthority,type OperationsControlProof,OperationsAuthorityError,type OperationsServiceReference,operationsTargetMaterialHash} from "./operationsControlAuthority.ts";
import {operationsCanonicalIntentSchema,operationsIntentDigest,type OperationsCanonicalIntent,type OperationsControlBridge} from "./operationsControlBridge.ts";
import type {ApprovalPrincipal} from "./approvals/contract.ts";
import { controlPolicy, operationsControlFreshnessMs, controlReceiptSchema, nativeOperationsControlSchema, operationsControlAction, operationsControlFilters, operationsControlSourceSchema,operationsHealthAction,operationsHealthResultSchema,
  operationsCanonicalAction,operationsServiceEvidenceSchema,type OperationsServiceEvidence,type NativeOperationsControl, type OperationsControlSnapshot, type OperationsReviewPayload } from "./operationsControlsSchema.ts";

const sourceRef=z.string().min(1).max(500),sourceInstant=z.string().datetime({offset:true});
export const operationsReadBindingSchema=z.object({scope:z.object({workspaceId:sourceRef,accountId:sourceRef,environment:z.literal("sandbox")}).strict(),
  principalRef:z.enum(["agent-reader","agent-reviewer"]),role:z.enum(["reader","reviewer"]),operation:z.enum(["read","propose","refreshHealth"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type OperationsReadBinding=z.infer<typeof operationsReadBindingSchema>;
export const operationsSourceResultSchema=z.object({snapshot:operationsControlSourceSchema.nullable(),authority:z.object({binding:operationsReadBindingSchema,
  sourceVersion:sourceRef.nullable(),permissionVersion:sourceRef,observedAt:sourceInstant,validUntil:sourceInstant}).strict()}).strict();
export type OperationsSourceResult=z.infer<typeof operationsSourceResultSchema>;
export type OperationsControlCaller={assertCurrent():void;signal?:AbortSignal};
export type OperationsControlSource={read:(binding:OperationsReadBinding,signal?:AbortSignal)=>Promise<unknown>;assertCurrent(result:OperationsSourceResult,binding:OperationsReadBinding,now:number):void;
  allowedHandoffOrigins?:readonly string[];allowedHandoffUrls?:readonly string[]};
export class OperationsControlError extends Error{
  readonly code:string;readonly status:number;readonly currentVersion?:string;readonly executionCertainty:"notApplied"|"applied"|"uncertain";
  constructor(code:string,status:number,currentVersion?:string,executionCertainty:"notApplied"|"applied"|"uncertain"="notApplied"){super(code);this.code=code;this.status=status;this.currentVersion=currentVersion;this.executionCertainty=executionCertainty;}
}
type Role="reader"|"reviewer";
export type OperationsControlServiceReaders={
  read(reference:Extract<OperationsServiceReference,{kind:"runtimeRegistration"|"runtimeRun"|"report"}>,principal:ApprovalPrincipal):Promise<{
    reference:OperationsServiceReference;data:Extract<OperationsServiceEvidence,{kind:"runtimeRegistration"|"runtimeRun"|"report"}>["data"];assertCurrent():void;
  }|{reference:OperationsServiceReference;unavailableReason:string;assertCurrent():void}>;
};
type Input={db:DatabaseSync;scope:OperationsScope;secret:string;ledger:CapabilityLedger;jobs:JobRepository;health:ReturnType<typeof createProviderHealth>;source?:OperationsControlSource;now?:()=>number;
  authority?:OperationsControlAuthority;canonical?:()=>OperationsControlBridge|undefined;serviceReaders?:OperationsControlServiceReaders};
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
  const fresh=(at:string)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now()&&now()-Date.parse(at)<=operationsControlFreshnessMs;
  function auth(actor:string,role:Role){if(actor!=="agent-"+role)fail("SOURCE_SCOPE_DENIED",403);}
  function callerFence(caller?:OperationsControlCaller){return ()=>{if(caller?.signal?.aborted)fail("REQUEST_CANCELLED",499);if(!caller)return;
    try{assertSynchronousVoid(caller.assertCurrent);}catch(error){throw new OperationsControlError("OPERATIONS_CALLER_DENIED",error instanceof OperationsControlError&&[401,403].includes(error.status)?error.status:403);}};}
  const readBinding=(operation:OperationsReadBinding["operation"],request:unknown,actorRef:string,role:Role)=>operationsReadBindingSchema.parse({scope,principalRef:actorRef,role,operation,requestDigest:digest(request)});
  async function snapshot(request:OperationsReadBinding,caller?:OperationsControlCaller){
    const assertCaller=callerFence(caller);assertCaller();
    if(!source)return {snapshot:null,accessValidUntil:null,assertCurrent:assertCaller};
    if(typeof source.read!=="function"||typeof source.assertCurrent!=="function")fail("SOURCE_RESPONSE_INVALID",502);
    let raw:unknown;try{raw=await boundedSourceRead(()=>source.read(structuredClone(request),caller?.signal),caller?.signal);}
    catch(error){assertCaller();if(error instanceof OperationsControlError&&[401,403].includes(error.status))fail("SOURCE_SCOPE_DENIED",error.status);if(error instanceof OperationsControlError&&error.status===409)fail("SOURCE_CHANGED",409);return fail("SOURCE_UNAVAILABLE",503);}
    assertCaller();const parsed=operationsSourceResultSchema.safeParse(raw);if(!parsed.success)return fail("SOURCE_RESPONSE_INVALID",502);
    const result=parsed.data,s=result.snapshot;
    const assertCurrent=()=>{
      assertCaller();const time=now(),grant=result.authority;
      if(digest(grant.binding)!==digest(request)||request.principalRef!=="agent-"+request.role||s&&digest(s.scope)!==digest(scope))fail("SOURCE_SCOPE_DENIED",403);
      if(grant.sourceVersion!==(s?.revision??null))fail("SOURCE_RESPONSE_INVALID",502);
      if(!Number.isFinite(time)||Date.parse(grant.observedAt)>time||Date.parse(grant.validUntil)<=time||Date.parse(grant.validUntil)<=Date.parse(grant.observedAt)||Date.parse(grant.validUntil)-Date.parse(grant.observedAt)>900_000)fail("SOURCE_AUTHORITY_EXPIRED",403);
      try{assertSynchronousVoid(()=>source.assertCurrent(structuredClone(result),structuredClone(request),time));}
      catch(error){if(error instanceof OperationsControlError&&[401,403].includes(error.status))fail("SOURCE_SCOPE_DENIED",error.status);if(error instanceof OperationsControlError&&error.status===409)fail("SOURCE_CHANGED",409);fail("SOURCE_RESPONSE_INVALID",502);}
      assertCaller();
    };
    assertCurrent();
    if(s){if(Date.parse(s.observedAt)>now())fail("SOURCE_RESPONSE_INVALID",502);
      for(const rows of [s.roles,s.tasks,s.takeovers,s.permissions,s.comparisons,s.conflicts,s.reports,s.attribution,s.handoffs,s.runMembership])
        for(const record of rows)if(Date.parse(record.observedAt)>now())fail("SOURCE_RESPONSE_INVALID",502);}
    return {snapshot:s,accessValidUntil:result.authority.validUntil,assertCurrent};
  }
  function published<T extends object>(value:T,fence:()=>void,certainty:"notApplied"|"applied"|"uncertain"){
    const assertCurrent=()=>{try{fence();}catch(error){if(error instanceof OperationsControlError)throw new OperationsControlError(error.code,error.status,undefined,error.code==="OPERATIONS_CALLER_DENIED"&&certainty==="applied"?"uncertain":certainty);throw error;}};
    assertCurrent();return Object.defineProperty(value,"assertCurrent",{value:assertCurrent}) as T&{assertCurrent():void};
  }
  function localBasis(){
    return {jobs:db.prepare("SELECT COUNT(*) n,MAX(version) maxVersion FROM job_heads").get(),
      capabilitySequence:db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM capability_events").get()?.n,
      runSequence:db.prepare("SELECT COUNT(*) n,MAX(at) latest FROM job_transitions").get()};
  }
  const version=(s:OperationsControlSnapshot|null,proof?:OperationsControlProof)=>"oc1-"+digest(proof?[scope,controlPolicy,facts(s),localBasis(),proof.materialHash]:[scope,controlPolicy,facts(s),localBasis()]);
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
  function canonicalIntent(ref:string):OperationsCanonicalIntent|null{
    const row=db.prepare("SELECT manifest FROM operations_control_requests WHERE json_extract(receipt,'$.actionRef')=?").get(ref);
    if(!row?.manifest)return null;const parsed=operationsCanonicalIntentSchema.safeParse(JSON.parse(String(row.manifest)));return parsed.success?parsed.data:null;
  }
  function assertCanonicalIntent(intent:OperationsCanonicalIntent,proof:OperationsControlProof){
    proof.assertCurrent();
    if(digest(canonicalIntent(intent.intentRef))!==digest(intent)||operationsTargetMaterialHash(proof,intent.kind,intent.targetId)!==intent.sourceMaterialHash)
      throw new OperationsAuthorityError("OPERATIONS_INTENT_CHANGED");
    const reason=hold(proof.snapshot,intent.kind,intent.targetId);if(reason)throw new OperationsAuthorityError(reason,reason==="SOURCE_SCOPE_DENIED"?403:409);
    const t=proof.authority.targets.find(t=>t.id===intent.targetId&&t.kind===intent.kind);
    if(!t||digest(t)!==digest(intent.target))throw new OperationsAuthorityError("OPERATIONS_TARGET_CHANGED");
    if(intent.kind==="task"){
      const task=proof.snapshot.tasks.find(t=>t.id===intent.targetId)!;
      if(t.items.length!==task.items.length||t.items.some(item=>!task.items.some(row=>row.itemKey===item.itemRef&&row.subjectRef===item.targetRef)))throw new OperationsAuthorityError("OPERATIONS_TASK_MEMBERSHIP_CHANGED");
    }
    proof.assertCurrent();
  }
  async function read(raw:unknown,actorRef:string,role:Role,caller?:OperationsControlCaller){
    auth(actorRef,role);
    const parsed=operationsControlFilters.safeParse(raw);if(!parsed.success)fail("INVALID_REQUEST",400);const f=parsed.data;
    if(f.proposalRequestKey&&role!=="reviewer")fail("SOURCE_SCOPE_DENIED",403);
    const assertCaller=callerFence(caller);assertCaller();
    const proof=input.authority?await input.authority.resolve({principalRef:actorRef}):undefined;
    assertCaller();const observed=proof?null:await snapshot(readBinding("read",f,actorRef,role),caller);
    const s=proof?.snapshot??observed?.snapshot??null,v=version(s,proof),sourceState=!s?"notConnected":!fresh(s.observedAt)?"stale":s.coverage==="partial"?"partial":"current";
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
            : (i.result.sourceEffect === "providerApplied" ? "Confirmed source receipt " : i.result.sourceEffect === "internalReport" ? "Internal report receipt " : "Artifact receipt ")+alias(i.result.receiptRef)
          : "No result receipt")] as [string,string])
      ] as [string,string][]}];
    });
    if(f.q)localRuns=localRuns.filter(r=>JSON.stringify(r).toLowerCase().includes(f.q!.toLowerCase()));
    // Only a current named directory proof can resolve assigned-to-me membership.
    if(f.mine)localRuns=proof?localRuns.filter(row=>s?.runMembership.some(member=>member.runId===open(row.id).id&&fresh(member.observedAt)&&member.assignedActorRef===proof.actor.personRef)):[];

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
    const canonical=input.canonical?.(),canonicalActions:NonNullable<NativeOperationsControl["canonicalActions"]>=[];
    if(proof&&s)for(const a of actions){
      const identified=open(a.targetRef),t=proof.authority.targets.find(t=>t.kind===a.kind&&t.id===identified.id);if(!t)continue;
      const allowed=role==="reviewer"&&a.allowed&&t.permission==="allowed"&&proof.actor.roles.some(r=>["founder","operator","reviewer","finance"].includes(r))&&!!canonical?.supports(a.kind);
      canonicalActions.push({...a,allowed,reasonCodes:allowed?[]:[...new Set([...a.reasonCodes,...(t.permission!=="allowed"?["SOURCE_PERMISSION_UNVERIFIED"]:[]),...(!canonical?.supports(a.kind)?["OPERATIONS_OWNER_UNCONFIGURED"]:[])])],
        items:t.items.map(item=>({itemRef:alias(item.itemRef),targetRef:alias(item.targetRef),units:item.units,spendMinor:item.spendMinor})),effect:"previewOnly"});
    }
    const serviceEvidence:OperationsServiceEvidence[]=[],serviceFences:(()=>void)[]=[];
    if(proof)for(const reference of proof.authority.serviceRefs){
      const section=reference.kind==="runtimeRegistration"||reference.kind==="report"?"reports":reference.kind==="repairReceipt"?"reconciliation":reference.kind==="permissionReceipt"?"capabilities":"runs";
      if(section!==f.section)continue;
      if(reportJob&&(reference.kind==="runtimeRegistration"&&reference.jobId!==reportJob||reference.kind==="report"&&!s?.reports.some(report=>report.id===reference.targetId&&report.jobId===reportJob)))continue;
      const targetRef=seal(reference.kind==="repairReceipt"?"repair":reference.kind==="permissionReceipt"?"permissionEvidence":reference.kind==="takeoverReceipt"?"takeover":"run",reference.targetId);
      if(reference.kind==="runtimeRegistration"||reference.kind==="runtimeRun"||reference.kind==="report"){
        if(!input.serviceReaders){serviceEvidence.push({kind:"unavailable",targetRef,service:reference.kind,reasonCode:"OPERATIONS_SERVICE_UNCONFIGURED"});continue;}
        const observed=await input.serviceReaders.read(structuredClone(reference),{principalRef:actorRef});
        if(digest(observed.reference)!==digest(reference))throw new OperationsAuthorityError("OPERATIONS_SERVICE_BINDING_CHANGED");
        if("unavailableReason"in observed){serviceEvidence.push({kind:"unavailable",targetRef,service:reference.kind,reasonCode:observed.unavailableReason});serviceFences.push(()=>assertSynchronousVoid(observed.assertCurrent));continue;}
        const projected=operationsServiceEvidenceSchema.safeParse({kind:reference.kind,targetRef,data:observed.data});if(!projected.success)throw new OperationsAuthorityError("OPERATIONS_SERVICE_RESPONSE_INVALID",502);
        if(reference.kind==="runtimeRegistration"&&("version"in observed.data&&observed.data.version!==reference.registrationVersion)||reference.kind==="runtimeRun"&&("registrationVersion"in observed.data&&observed.data.registrationVersion!==reference.registrationVersion))throw new OperationsAuthorityError("OPERATIONS_SERVICE_BINDING_CHANGED");
        serviceEvidence.push(projected.data);serviceFences.push(()=>assertSynchronousVoid(observed.assertCurrent));
      }else serviceEvidence.push({kind:reference.kind,targetRef,receiptRef:alias(reference.receiptRef),sourceVersion:alias(reference.sourceVersion),state:reference.state,observedAt:reference.observedAt,
        sourceReadbackVersion:reference.sourceReadbackVersion?alias(reference.sourceReadbackVersion):null,mirrorReadbackVersion:reference.mirrorReadbackVersion?alias(reference.mirrorReadbackVersion):null,ownerRef:alias(reference.ownerPersonRef)});
    }
    let canonicalReconciliation:NativeOperationsControl["canonicalReconciliation"]=null;
    if(f.proposalRequestKey&&reconciliation){
      const intent=reconciliation.actionRef?canonicalIntent(reconciliation.actionRef):null;
      if(intent){
        const existing=canonical?.lookup(intent.intentRef,{principalRef:actorRef},f.proposalRequestKey);
        canonicalReconciliation={requestKey:f.proposalRequestKey,state:existing?"recorded":"pending",approvalRef:existing?.manifest.approvalRef??null,
          manifestRef:existing?"manifest-"+existing.manifest.manifestHash:null,version:null,executionCertainty:existing?"applied":"uncertain"};
      }else canonicalReconciliation={requestKey:f.proposalRequestKey,state:reconciliation.state==="recorded"?"unverified":reconciliation.state,
        approvalRef:null,manifestRef:null,version:null,executionCertainty:reconciliation.state==="rejected"?"notApplied":"uncertain"};
    }
    const data=nativeOperationsControlSchema.parse({kind:"native-operations-controls",section:f.section,version:v,observedAt:new Date(now()).toISOString(),actorRef,role,sourceState,sourceObservedAt:s?.observedAt??null,
      readAccess:proof?{kind:"namedAuthority",validUntil:proof.validUntil}:observed?.accessValidUntil?{kind:"sourceGrant",validUntil:observed.accessValidUntil}:null,
      records,actions,healthTargets,localRuns,localCoverage:{returned:runRows.length,total:f.section==="runs"?runTotal:0,partial:f.section==="runs"&&runRows.length<runTotal},
      runFilterEvidence:{matched:localRuns.length,unknownPlatform,assignment:proof?"named-principal-verified":"named-principal-unverified"},
      namedActor:proof?{state:"verified",personRef:alias(proof.actor.personRef),roles:proof.actor.roles,observedAt:proof.observedAt,validUntil:proof.validUntil}:{state:"unavailable",personRef:null,roles:[],observedAt:null,validUntil:null},
      canonicalActions,canonicalReconciliation,serviceEvidence,
      handoffs,proposalReconciliation:reconciliation,history:hs.records,historyCoverage:hs.coverage});
    const assertCurrent=()=>{
      assertCaller();observed?.assertCurrent();proof?.assertCurrent();for(const fence of serviceFences)fence();proof?.assertCurrent();observed?.assertCurrent();assertCaller();
      if(s&&sourceState!=="stale"&&!fresh(s.observedAt))fail("SOURCE_STALE",409);
      if(version(s,proof)!==v)throw new OperationsAuthorityError("OPERATIONS_LOCAL_RECORD_CHANGED");
    };
    assertCurrent();
    return {assertCurrent,data,version:v,observedAt:data.observedAt,partial:sourceState!=="current"||data.localCoverage.partial||((f.section==="connections"||f.section==="capabilities")&&ledger.list(100).partial),stale:sourceState==="stale",empty:sourceState==="current"&&!records.length&&!actions.length&&!localRuns.length,
      capabilities:[{actionKind:"proposeOperationsReview",state:role==="reader"?"denied" as const:actions.some(a=>a.allowed)?"available" as const:"held" as const,reasonCodes:role==="reader"?["REVIEWER_REQUIRED"]:actions.some(a=>a.allowed)?[]:["SOURCE_AUTHORITY_UNAVAILABLE"]},
        {actionKind:"previewOperationsControl",state:role==="reader"?"denied" as const:canonicalActions.some(a=>a.allowed)?"available" as const:"held" as const,reasonCodes:role==="reader"?["REVIEWER_REQUIRED"]:canonicalActions.some(a=>a.allowed)?[]:["OPERATIONS_OWNER_UNCONFIGURED"]}]};
  }
  function ack(r:z.infer<typeof controlReceiptSchema>){return {actionRef:r.actionRef!,state:"approvalPending" as const,payloadVersion:r.manifestDigest!,policyVersion:controlPolicy,receiptRefs:["proposal:"+r.actionRef]};}
  async function previewCanonical(raw:unknown,actorRef:string,role:Role){
    auth(actorRef,role);if(role!=="reviewer")fail("SOURCE_SCOPE_DENIED",403);
    const parsed=operationsCanonicalAction.safeParse(raw);if(!parsed.success)fail("VALIDATION_FAILED",422);const a=parsed.data;
    if(a.requestedScope.workspaceId!==scope.workspaceId||a.requestedScope.accountIds[0]!==scope.accountId)fail("SOURCE_SCOPE_DENIED",403);
    const identified=open(a.payload.targetRef);if(identified.kind!==a.payload.kind)fail("INVALID_CONTROL_REFERENCE",400);
    const canonical=input.canonical?.();if(!input.authority||!canonical?.supports(a.payload.kind))throw new OperationsAuthorityError("OPERATIONS_OWNER_UNCONFIGURED",503);
    const requestHash=digest({operation:"canonical-v2",scope,actorRef,base:a.expectedVersion,payload:a.payload});
    let prior=db.prepare("SELECT * FROM operations_control_requests WHERE request_key=?").get(a.idempotencyKey);
    if(prior&&prior.request_hash!==requestHash)fail("IDEMPOTENCY_CONFLICT",409);
    const certainty=()=>prior?"applied" as const:"notApplied" as const;
    let proof:OperationsControlProof;
    try{proof=await input.authority.resolve({principalRef:actorRef});}
    catch(error){if(error instanceof OperationsAuthorityError)throw new OperationsAuthorityError(error.code,error.status,certainty());throw error;}
    if(!proof.actor.roles.some(r=>["founder","operator","reviewer","finance"].includes(r)))throw new OperationsAuthorityError("OPERATIONS_NAMED_ACTOR_DENIED",403,certainty());
    const s=proof.snapshot,current=version(s,proof);
    let saved:OperationsCanonicalIntent;
    db.exec("BEGIN IMMEDIATE");let committed=false;
    try{
      proof.assertCurrent();prior=db.prepare("SELECT * FROM operations_control_requests WHERE request_key=?").get(a.idempotencyKey);
      if(prior){
        if(prior.request_hash!==requestHash)fail("IDEMPOTENCY_CONFLICT",409);
        const receipt=controlReceiptSchema.parse(JSON.parse(String(prior.receipt)));
        if(receipt.state==="rejected")fail("STALE_VERSION",409,current);
        const intent=receipt.actionRef?canonicalIntent(receipt.actionRef):null;if(!intent)throw new OperationsAuthorityError("OPERATIONS_CANONICAL_INTENT_REQUIRED");
        saved=intent;
      }else{
        const t=proof.authority.targets.find(t=>t.kind===a.payload.kind&&t.id===identified.id),reason=hold(s,a.payload.kind,identified.id);
        if(current!==a.expectedVersion||!t){
          if(s.coverage!=="complete")fail("SOURCE_COVERAGE_PARTIAL",409);
          const receipt=controlReceiptSchema.parse({requestKey:a.idempotencyKey,actorRef,state:"rejected",baseVersion:a.expectedVersion,actionRef:null,manifestDigest:null,payloadDigest:digest(a.payload),createdAt:new Date(now()).toISOString(),reason:a.payload.reason});
          proof.assertCurrent();db.prepare("INSERT INTO operations_control_requests VALUES(?,?,?,?,?,?,?,?)").run(a.idempotencyKey,actorRef,sectionFor[a.payload.kind],JSON.stringify(identified),requestHash,JSON.stringify(receipt),null,
            Number(db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM operations_control_requests").get()?.n));db.exec("COMMIT");committed=true;fail("STALE_VERSION",409,current);
        }
        if(reason)throw new OperationsAuthorityError(reason,reason==="SOURCE_SCOPE_DENIED"?403:409);
        if(t.permission!=="allowed")throw new OperationsAuthorityError(t.permission==="denied"?"OPERATIONS_SOURCE_SCOPE_DENIED":"OPERATIONS_SOURCE_PERMISSION_UNKNOWN",t.permission==="denied"?403:409);
        const selected=a.payload.itemRefs?a.payload.itemRefs.map(ref=>t.items.find(item=>alias(item.itemRef)===ref)?.itemRef??null):t.items.map(item=>item.itemRef);
        if(selected.some(ref=>ref===null)||new Set(selected).size!==selected.length)fail("OPERATIONS_SELECTION_CHANGED",409);
        const material={mode:"canonical-v2" as const,scope,principalRef:actorRef,personRef:proof.actor.personRef,directoryVersion:proof.actor.directoryVersion,
          kind:a.payload.kind,targetId:identified.id,reason:a.payload.reason,baseVersion:a.expectedVersion,sourceRevision:s.revision,sourceMaterialHash:operationsTargetMaterialHash(proof,a.payload.kind,identified.id),target:t,selectedItemRefs:selected.filter((item):item is string=>item!==null)};
        saved=operationsCanonicalIntentSchema.parse({...material,intentRef:"control-intent-"+randomUUID(),digest:operationsIntentDigest(material),createdAt:new Date(now()).toISOString()});
        // Validate exact current membership before persisting. It remains an app draft, never approval.
        if(saved.kind==="task"){
          const task=s.tasks.find(task=>task.id===saved.targetId)!;
          if(t.items.length!==task.items.length||t.items.some(item=>!task.items.some(row=>row.itemKey===item.itemRef&&row.subjectRef===item.targetRef)))throw new OperationsAuthorityError("OPERATIONS_TASK_MEMBERSHIP_CHANGED");
        }
        const receipt=controlReceiptSchema.parse({requestKey:a.idempotencyKey,actorRef,state:"recorded",baseVersion:a.expectedVersion,actionRef:saved.intentRef,manifestDigest:saved.digest,payloadDigest:digest(a.payload),createdAt:saved.createdAt,reason:a.payload.reason});
        proof.assertCurrent();if(version(s,proof)!==a.expectedVersion)throw new OperationsAuthorityError("OPERATIONS_LOCAL_RECORD_CHANGED");
        db.prepare("INSERT INTO operations_control_requests VALUES(?,?,?,?,?,?,?,?)").run(a.idempotencyKey,actorRef,sectionFor[a.payload.kind],JSON.stringify(identified),requestHash,JSON.stringify(receipt),JSON.stringify(saved),
          Number(db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM operations_control_requests").get()?.n));
      }
      db.exec("COMMIT");committed=true;
    }catch(error){if(!committed)db.exec("ROLLBACK");throw error;}
    try{return await canonical.preview(saved.intentRef,{principalRef:actorRef},a.idempotencyKey,a.requestId);}
    catch(error){if(error instanceof OperationsAuthorityError)throw new OperationsAuthorityError(error.code,error.status,"applied");
      if(error&&typeof error==="object"&&"code"in error&&typeof error.code==="string"&&"status"in error&&typeof error.status==="number")throw new OperationsAuthorityError(error.code,error.status,"applied");
      throw new OperationsAuthorityError("OPERATIONS_PREVIEW_UNVERIFIED",502,"uncertain");}
  }
  async function propose(raw:unknown,actorRef:string,role:Role,caller?:OperationsControlCaller){
    auth(actorRef,role);if(role!=="reviewer")fail("SOURCE_SCOPE_DENIED",403);
    const parsed=operationsControlAction.safeParse(raw);if(!parsed.success)fail("VALIDATION_FAILED",422);const a=parsed.data;
    if(a.requestedScope.workspaceId!==scope.workspaceId||a.requestedScope.accountIds[0]!==scope.accountId)fail("SOURCE_SCOPE_DENIED",403);
    const t=open(a.payload.targetRef);if(t.kind!==a.payload.kind)fail("INVALID_CONTROL_REFERENCE",400);
    const logical={scope,actorRef,kind:a.payload.kind,target:t.id,reason:a.payload.reason,base:a.expectedVersion},hash=digest([logical,a.payload]);
    const bound=readBinding("propose",a,actorRef,role),observed=await snapshot(bound,caller);
    const old=db.prepare("SELECT request_hash,receipt FROM operations_control_requests WHERE request_key=?").get(a.idempotencyKey);
    if(old){if(old.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);const r=controlReceiptSchema.parse(JSON.parse(String(old.receipt)));
      if(r.state==="rejected")fail("STALE_VERSION",409);return published(ack(r),observed.assertCurrent,"applied");}
    const first=observed.snapshot;if(!first)fail("INTEGRATION_PENDING",503);
    const firstDigest=digest(facts(first));
    const currentSource=await snapshot(bound,caller),s=currentSource.snapshot;if(!s)fail("INTEGRATION_PENDING",503);
    const fence=()=>{observed.assertCurrent();currentSource.assertCurrent();};fence();
    if(firstDigest!==digest(facts(s)))fail("SOURCE_CHANGED",409);
    db.exec("BEGIN IMMEDIATE");let closed=false;
    try{
      fence();
      const existing=db.prepare("SELECT request_hash,receipt FROM operations_control_requests WHERE request_key=?").get(a.idempotencyKey);
      if(existing){if(existing.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);const r=controlReceiptSchema.parse(JSON.parse(String(existing.receipt)));
        if(r.state==="rejected")fail("STALE_VERSION",409);fence();db.exec("COMMIT");closed=true;return published(ack(r),fence,"applied");}
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
        fence();db.exec("COMMIT");closed=true;return receipt;
      };
      // A complete changed basis seals the original request as a no-op, preventing a late old submission.
      if(current!==a.expectedVersion||!member){save("rejected");fail("STALE_VERSION",409,current);}
      const reason=hold(s,a.payload.kind,t.id);if(reason)fail(reason,reason==="SOURCE_SCOPE_DENIED"?403:409,current);
      return published(ack(save("recorded")),fence,"applied");
    }catch(error){if(!closed)db.exec("ROLLBACK");throw error;}
  }
  async function refreshHealth(raw:unknown,actorRef:string,role:Role,caller?:OperationsControlCaller){
    auth(actorRef,role);if(role!=="reviewer")fail("SOURCE_SCOPE_DENIED",403);
    const parsed=operationsHealthAction.safeParse(raw);if(!parsed.success)fail("VALIDATION_FAILED",422);const a=parsed.data;
    if(a.requestedScope.workspaceId!==scope.workspaceId||a.requestedScope.accountIds[0]!==scope.accountId)fail("SOURCE_SCOPE_DENIED",403);
    const t=open(a.payload.targetRef);if(t.kind!=="binding")fail("INVALID_CONTROL_REFERENCE",400);
    const hash=digest([scope,actorRef,a.payload,a.expectedVersion]);
    let prior=db.prepare("SELECT * FROM operations_control_health_requests WHERE request_key=?").get(a.idempotencyKey);
    if(prior&&prior.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);
    const priorCertainty=()=>prior?.result?operationsHealthResultSchema.parse(JSON.parse(String(prior.result))).executionCertainty:prior?"uncertain" as const:"notApplied" as const;
    const bound=readBinding("refreshHealth",a,actorRef,role);
    let sourceSnapshot:OperationsControlSnapshot|null,sourceRead:Awaited<ReturnType<typeof snapshot>>;
    try{sourceRead=await snapshot(bound,caller);sourceSnapshot=sourceRead.snapshot;}catch(error){
      prior=db.prepare("SELECT * FROM operations_control_health_requests WHERE request_key=?").get(a.idempotencyKey);
      if(error instanceof OperationsControlError)throw new OperationsControlError(error.code,error.status,error.currentVersion,priorCertainty());throw error;
    }
    const fence=()=>sourceRead.assertCurrent();
    // Another request may establish or complete this exact command while source authority is awaited.
    prior=db.prepare("SELECT * FROM operations_control_health_requests WHERE request_key=?").get(a.idempotencyKey);
    if(prior&&prior.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);
    const binding=ledger.get(t.id);if(!binding)throw new OperationsControlError("RECORD_NOT_FOUND",404,undefined,priorCertainty());
    if(prior?.result){
      const historical=operationsHealthResultSchema.parse(JSON.parse(String(prior.result))),current=health.get(t.id);
      if(historical.executionCertainty!=="applied")return published(historical,fence,historical.executionCertainty);
      const permitted=binding.state==="Ready"&&!ledger.hasDeniedActionRoute(binding.registration.binding)&&current?.permission!=="denied";
      return published({...historical,state:permitted&&current?.state==="ready"&&prior.binding_revision===binding.revision?"succeeded" as const:"blocked" as const,
        reasonCodes:!permitted?["PROVIDER_PERMISSION_HELD"]:current?.reasonCodes??["SOURCE_HEALTH_UNKNOWN"]},fence,historical.executionCertainty);
    }
    if(!prior&&version(sourceSnapshot)!==a.expectedVersion)fail("STALE_VERSION",409,version(sourceSnapshot));
    if(prior&&prior.binding_revision!==binding.revision)throw new OperationsControlError("STALE_VERSION",409,version(sourceSnapshot),priorCertainty());
    const summary=health.get(t.id),held=!summary?.configured?"PROVIDER_HEALTH_TARGET_UNAVAILABLE":binding.state!=="Ready"||ledger.hasDeniedActionRoute(binding.registration.binding)||summary.permission==="denied"?"PROVIDER_PERMISSION_HELD":null;
    fence();db.prepare("INSERT OR IGNORE INTO operations_control_health_requests VALUES(?,?,?,NULL)").run(a.idempotencyKey,hash,binding.revision);
    const concurrent=db.prepare("SELECT request_hash,result FROM operations_control_health_requests WHERE request_key=?").get(a.idempotencyKey);
    if(concurrent?.request_hash!==hash)fail("IDEMPOTENCY_CONFLICT",409);
    if(concurrent.result){const result=operationsHealthResultSchema.parse(JSON.parse(String(concurrent.result)));return published(result,fence,result.executionCertainty);}
    const base={actionRef:"control-health-"+digest([scope,actorRef,a.idempotencyKey]),payloadVersion:hash,policyVersion:controlPolicy};
    const finish=(result:unknown)=>{const r=operationsHealthResultSchema.parse(result);db.prepare("UPDATE operations_control_health_requests SET result=? WHERE request_key=? AND request_hash=?").run(JSON.stringify(r),a.idempotencyKey,hash);return r;};
    if(held)return published(finish({...base,state:"blocked",runRef:null,receiptRefs:[],reasonCodes:[held],executionCertainty:"notApplied"}),fence,"notApplied");
    try{
      fence();
      const result=await health.check({capabilityId:t.id,eventId:"controls-"+hash},"controls-"+digest([scope,actorRef,a.idempotencyKey]));
      if(result.state==="held"&&result.runId){const run=jobs.getRun(result.runId);if(run.state==="running")return published({...base,state:"outcomeUncertain" as const,runRef:seal("run",result.runId),receiptRefs:[],reasonCodes:["HEALTH_CHECK_IN_PROGRESS"],executionCertainty:"uncertain" as const},fence,"uncertain");}
      const recorded=finish({...base,state:result.state==="observed"&&result.health?.state==="ready"?"succeeded":"blocked",runRef:result.runId?seal("run",result.runId):null,
        receiptRefs:result.observationId?["health-observation:"+alias(result.observationId)]:[],reasonCodes:result.state==="observed"?result.health?.reasonCodes??["SOURCE_HEALTH_UNKNOWN"]:result.state==="unconfigured"?["PROVIDER_HEALTH_TARGET_UNAVAILABLE"]:["HEALTH_JOB_HELD"],executionCertainty:result.state==="observed"?"applied":"notApplied"});
      try{sourceRead=await snapshot(bound,caller);}catch(error){if(error instanceof OperationsControlError)throw new OperationsControlError(error.code,error.status,undefined,error.code==="OPERATIONS_CALLER_DENIED"&&recorded.executionCertainty==="applied"?"uncertain":recorded.executionCertainty);throw error;}
      const currentBinding=ledger.get(t.id),currentHealth=health.get(t.id);
      if(recorded.executionCertainty==="applied"&&(!currentBinding||currentBinding.state!=="Ready"||currentBinding.revision!==binding.revision||currentHealth?.state!=="ready"))return published({...recorded,state:"blocked" as const,reasonCodes:currentHealth?.reasonCodes??["PROVIDER_PERMISSION_HELD"]},fence,recorded.executionCertainty);
      return published(recorded,fence,recorded.executionCertainty);
    }catch(error){if(error instanceof OperationsControlError)throw error;return published({...base,state:"outcomeUncertain" as const,runRef:null,receiptRefs:[],reasonCodes:["HEALTH_CHECK_UNVERIFIED"],executionCertainty:"uncertain" as const},fence,"uncertain");}
  }
  return {read,propose,refreshHealth,previewCanonical,canonicalIntents:{read:canonicalIntent,assertCurrent:assertCanonicalIntent}};
}
