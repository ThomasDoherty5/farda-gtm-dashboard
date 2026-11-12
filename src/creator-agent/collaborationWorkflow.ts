import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CollaborationEvidenceData } from "./collaborationEvidence.ts";
import { digest } from "./config.ts";
import { boundedSourceRead } from "./actions/readBoundary.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";
import type { OperationsScope } from "./operations.ts";
import { openCollaborationRef } from "./creatorPlatformReferences.ts";
import { projectPostingClock } from "./postingClock/project.ts";
import { collaborationReadBindingSchema,collaborationSourceResultSchema, intentHold, nativeCollaborationSchema, workflowIntentSchema, type CollaborationSourceReader, type CollaborationSourceSnapshot, type NativeCollaborationData } from "./collaborationWorkflowSchema.ts";

const observationLeaseMs=15*60_000;
const policyVersion="collaboration-review-proposal.v1";
export class CollaborationWorkflowError extends Error {
  readonly code:string; readonly status:number; readonly currentVersion?:string;readonly executionCertainty:"notApplied"|"uncertain";
  constructor(code:string,status:number,currentVersion?:string,certainty:"notApplied"|"uncertain"="notApplied"){super(code);this.code=code;this.status=status;this.currentVersion=currentVersion;this.executionCertainty=certainty;}
}
export type CollaborationCaller={assertCurrent():void;signal?:AbortSignal};
const envelopeSchema=z.object({operation:z.literal("requestApproval"),actionKind:z.literal("proposeCollaborationReview"),entityRefs:z.array(z.never()).max(0),
  approvalRef:z.null(),manifestRef:z.null(),runRef:z.null().optional(),expectedVersion:z.string().regex(/^cw1-[a-f0-9]{64}$/),idempotencyKey:z.string().trim().min(1).max(240),
  requestedScope:z.object({workspaceId:z.string(),accountIds:z.array(z.string()).length(1),environment:z.literal("sandbox")}).strict(),payload:workflowIntentSchema});
type Ack={actionRef:string;payloadVersion:string;policyVersion:string;receiptRefs:string[];state:"approvalPending"};
export function createCollaborationWorkflow(db:DatabaseSync,scope:OperationsScope,secret:string,reader?:CollaborationSourceReader,now:()=>number=Date.now,readEvidence?:(request:{collaborationId:string;cursor:string|null;limit:number})=>Promise<{data:CollaborationEvidenceData;nextCursor:string|null}>) {
  const bound=db.prepare("SELECT workspace_id, account_id,environment FROM capability_scope WHERE id=1").get();
  if(!bound || bound.workspace_id!==scope.workspaceId || bound.account_id!==scope.accountId || bound.environment!==scope.environment)throw new CollaborationWorkflowError("DATABASE_SCOPE_MISMATCH",403);
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_review_proposals(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,collaboration_id TEXT NOT NULL,
    actor TEXT NOT NULL,kind TEXT NOT NULL,manifest_hash TEXT NOT NULL,manifest TEXT NOT NULL,public_body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS collaboration_review_subject ON collaboration_review_proposals(collaboration_id,seq);
    CREATE TABLE IF NOT EXISTS collaboration_review_requests(request_key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collaboration_review_rejections(request_key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,actor TEXT NOT NULL,
      collaboration_id TEXT NOT NULL,current_version TEXT NOT NULL);`);
  function canonical(ref:string) {
    if(ref.startsWith("collab1-")){
      try{return openCollaborationRef(scope,secret,ref);}catch{throw new CollaborationWorkflowError("INVALID_COLLABORATION_REFERENCE",400);}
    }
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(ref))throw new CollaborationWorkflowError("INVALID_COLLABORATION_REFERENCE",400);
    return ref;
  }
  const assetMarks = new WeakMap<CollaborationSourceSnapshot,string>();
  function assetMark(source:CollaborationSourceSnapshot) {
    const ids=source.assetBindings?.map(b=>b.assetId)??[];
    if(!ids.length)return "";
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('creator_assets','creator_asset_requests')").all();
    if(tables.length!==2)throw new CollaborationWorkflowError("ASSET_EVIDENCE_UNVERIFIED",503);
    const heads=db.prepare("SELECT asset_id, MAX(version) AS version FROM creator_assets WHERE asset_id IN ("+ids.map(()=>"?").join(",")+") GROUP BY asset_id ORDER BY asset_id").all(...ids);
    // Every committed asset mutation (including a local rights reconciliation/withdrawal) appends an idempotency receipt.
    const mutation=db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM creator_asset_requests").get()!.n;
    return digest([heads,mutation]);
  }
  function assertCurrentAssets(source:CollaborationSourceSnapshot) {
    const expected=assetMarks.get(source);
    if(expected!==undefined && assetMark(source)!==expected)throw new CollaborationWorkflowError("SOURCE_VERSION_CHANGED",409);
  }
  async function readSource(id:string,actorRef:string,operation:"read"|"propose",request:unknown,caller?:CollaborationCaller) {
    if(!reader)throw new CollaborationWorkflowError("INTEGRATION_PENDING",503);
    const binding=collaborationReadBindingSchema.parse({scope,principalRef:actorRef,operation,collaborationId:id,requestDigest:digest(request)});
    const assertCaller=()=>{if(caller?.signal?.aborted)throw new CollaborationWorkflowError("REQUEST_CANCELLED",499);if(caller)assertSynchronousVoid(caller.assertCurrent);};
    const sourceFailure=(error:unknown):never=>{if(error instanceof CollaborationWorkflowError && [401,403].includes(error.status))throw new CollaborationWorkflowError("COLLABORATION_SOURCE_DENIED",error.status);
      if(error instanceof CollaborationWorkflowError && error.status===409)throw new CollaborationWorkflowError("COLLABORATION_SOURCE_CHANGED",409);
      if(caller?.signal?.aborted)throw new CollaborationWorkflowError("REQUEST_CANCELLED",499);throw new CollaborationWorkflowError("COLLABORATION_SOURCE_UNAVAILABLE",503);};
    assertCaller();
    if(typeof reader.read!=="function"||typeof reader.assertCurrent!=="function")throw new CollaborationWorkflowError("SOURCE_RESPONSE_INVALID",502);
    let raw:unknown;try{raw=await boundedSourceRead(()=>reader.read(structuredClone(binding),secret,caller?.signal),caller?.signal);}catch(error){sourceFailure(error);}
    assertCaller();
    const parsed=collaborationSourceResultSchema.safeParse(raw);
    if(!parsed.success)throw new CollaborationWorkflowError("SOURCE_RESPONSE_INVALID",502);
    const packet=parsed.data,s=structuredClone(packet.snapshot);
    const assertCurrent=()=>{assertCaller();const proof=packet.authority,time=now();
      if(digest(proof.binding)!==digest(binding)||proof.sourceVersion!==(s?.sourceRevision??null))throw new CollaborationWorkflowError("SOURCE_RESPONSE_INVALID",502);
      if(!Number.isFinite(time)||Date.parse(proof.observedAt)>time||Math.min(Date.parse(proof.validUntil),Date.parse(proof.observedAt)+observationLeaseMs)<=time)throw new CollaborationWorkflowError("COLLABORATION_ACCESS_EXPIRED",409);
      try{assertSynchronousVoid(()=>reader.assertCurrent(structuredClone(packet),structuredClone(binding),time));}catch(error){sourceFailure(error);}assertCaller();
      if(Math.min(Date.parse(proof.validUntil),Date.parse(proof.observedAt)+observationLeaseMs)<=now())throw new CollaborationWorkflowError("COLLABORATION_ACCESS_EXPIRED",409);};
    assertCurrent();
    if(s && (s.id!==id || s.scope.workspaceId!==scope.workspaceId || s.scope.accountId!==scope.accountId || s.scope.environment!==scope.environment))
      throw new CollaborationWorkflowError("SOURCE_SCOPE_DENIED",403);
    if(s && Date.parse(s.observedAt)>now())throw new CollaborationWorkflowError("SOURCE_TIME_UNVERIFIED",503);
    if(!s && packet.absence!=="verified")throw new CollaborationWorkflowError("SOURCE_COVERAGE_INCOMPLETE",503);
    return {snapshot:s,assertCurrent,readAccess:{validUntil:new Date(Math.min(Date.parse(packet.authority.validUntil),Date.parse(packet.authority.observedAt)+observationLeaseMs)).toISOString()}};
  }
  async function snapshot(id:string,actorRef:string,operation:"read"|"propose",request:unknown,caller?:CollaborationCaller) {
    const observed=await readSource(id,actorRef,operation,request,caller),s=observed.snapshot;
    if(!s)return observed;
    if(readEvidence && s.assetBindings?.length){
      const mark=assetMark(s);
      const sourceFacts=version(s,0);
      const assets=(await boundedSourceRead(()=>readEvidence({collaborationId:id,cursor:null,limit:100}),caller?.signal)).data;
      observed.assertCurrent();
      if(assets.collaborationId!==id)throw new CollaborationWorkflowError("SOURCE_SCOPE_DENIED",403);
      // The evidence resolver awaits external authority. Recheck membership and the exact source version after it returns.
      const reread=await readSource(id,actorRef,operation,request,caller),current=reread.snapshot;
      observed.assertCurrent();reread.assertCurrent();
      if(!current || version(current,0)!==sourceFacts || assetMark(s)!==mark)throw new CollaborationWorkflowError("SOURCE_VERSION_CHANGED",409);
      assetMarks.set(s,mark);
      if(assets.hasMore)s.coverage="partial";
      for(const binding of s.assetBindings){
        const d=s.deliverables.find(x=>x.ref===binding.deliverableRef);
        const revisions=assets.records.filter(x=>x.kind==="asset" && x.assetId===binding.assetId).filter(x=>x.kind==="asset").sort((a,b)=>b.version-a.version);
        if(!d || !revisions.length)continue;
        const latest=revisions[0]!;
        const head=db.prepare("SELECT version,body FROM creator_assets WHERE asset_id=? ORDER BY version DESC LIMIT 1").get(binding.assetId);
        const stored=head ? JSON.parse(String(head.body)):null;
        if(!head || head.version!==latest.version || stored?.submission?.collaborationId!==id ||
          stored?.submission?.fileVersion!==latest.fileVersion || stored?.sourceEvidence?.availability!==latest.availability)
          throw new CollaborationWorkflowError("SOURCE_VERSION_CHANGED",409);
        d.revisions=revisions.slice(0,50).map(r=>({label:"Asset v"+r.version+" · "+r.availability,at:r.recordedAt,sourceRef:r.id}));
        if(revisions.length>50)s.coverage="partial";
        d.submissionVersion=latest.availability==="available" ? "v"+latest.version+"-"+digest([latest.id,latest.fileVersion]).slice(0,32) : null;
        if(latest.reviewState!=="unknown")d.review={state:latest.reviewState,receiptRef:latest.id};
        if(latest.rightsState!=="unknown")d.rights={state:latest.rightsState,receiptRef:latest.id};
        if(latest.availability!=="available")d.blocker="Submitted asset "+latest.availability;
      }
    }
    observed.assertCurrent();return observed;
  }
  function version(source:CollaborationSourceSnapshot,seq:number) {
    // Clock projections are read-only; proposals still bind the existing accepted source terms.
    const {observedAt,postingClock,...facts}=source;
    void observedAt;void postingClock;
    return "cw1-"+digest([scope,facts,seq,policyVersion]);
  }
  function head(id:string){return Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM collaboration_review_proposals WHERE collaboration_id=?").get(id)!.seq);}
  function previous(key:string,requestDigest:string):Ack|null {
    const row=db.prepare("SELECT request_digest,receipt FROM collaboration_review_requests WHERE request_key=?").get(key);
    if(!row)return null;
    if(row.request_digest!==requestDigest)throw new CollaborationWorkflowError("IDEMPOTENCY_KEY_REUSED",409);
    return JSON.parse(String(row.receipt));
  }
  async function read(ref:string, options:{requestKey?:string;actorRef?:string;assertCurrent?:()=>void;signal?:AbortSignal}={}){
    const actorRef=options.actorRef??"agent-reader";
    if(options.requestKey!==undefined && (!options.requestKey.trim() || options.requestKey.length>240 || actorRef==="agent-reader"))
      throw new CollaborationWorkflowError("SOURCE_SCOPE_DENIED",403);
    const caller=options.assertCurrent?{assertCurrent:options.assertCurrent,signal:options.signal}:undefined;
    const id=canonical(ref),observed=await snapshot(id,actorRef,"read",{ref,requestKey:options.requestKey??null},caller),source=observed.snapshot;
    if(!source){observed.assertCurrent();return {data:null,version:null,partial:false,stale:false,capabilities:[],assertCurrent:observed.assertCurrent};}
    db.exec("BEGIN");
    try{
      observed.assertCurrent();assertCurrentAssets(source);
      const seq=head(id);
      const total=Number(db.prepare("SELECT COUNT(*) AS n FROM collaboration_review_proposals WHERE collaboration_id=?").get(id)!.n);
      const rows=db.prepare("SELECT public_body FROM collaboration_review_proposals WHERE collaboration_id=? ORDER BY seq DESC LIMIT 50").all(id);
      const {id:internalId,scope:privateScope,assetBindings,postingClock,...fields}=source;void internalId;void privateScope;void assetBindings;
      const observedNow=now(),stale=observedNow-Date.parse(source.observedAt)>observationLeaseMs;
      const clockExpiry=postingClock ? Math.min(Date.parse(postingClock.validUntil),Date.parse(postingClock.observedAt)+observationLeaseMs) : 0;
      const clockFresh=clockExpiry>observedNow;
      const clock=postingClock ? projectPostingClock({...postingClock,validUntil:new Date(clockExpiry).toISOString()},observedNow) : null;
      const publicClock=clock ? source.coverage==="partial" ? {
        state:"pending",observedAt:clock.observedAt,timezone:null,deadlines:[],reason:"SOURCE_COVERAGE_PARTIAL",
      } : {
        state:clock.state,observedAt:clock.observedAt,timezone:clock.timezone,reason:clock.reason,
        deadlines:clock.deadlines.map(deadline=>({...deadline,deliverableId:source.deliverables.some(row=>row.ref===deadline.deliverableId)
          ? deadline.deliverableId : "clock-deliverable:"+createHmac("sha256",secret).update(JSON.stringify([scope,id,deadline.deliverableId])).digest("hex")})),
      } : undefined;
      let proposalReconciliation=null;
      if(options.requestKey!==undefined){
        if(stale || source.coverage!=="complete")throw new CollaborationWorkflowError(stale?"SOURCE_STALE":"SOURCE_COVERAGE_INCOMPLETE",409);
        const found=db.prepare(`SELECT p.public_body FROM collaboration_review_requests r JOIN collaboration_review_proposals p
          ON p.id=json_extract(r.receipt,'$.actionRef') WHERE r.request_key=? AND p.collaboration_id=? AND p.actor=?`).get(options.requestKey,id,actorRef);
        const rejected=db.prepare("SELECT current_version FROM collaboration_review_rejections WHERE request_key=? AND actor=? AND collaboration_id=?").get(options.requestKey,actorRef,id);
        proposalReconciliation={requestKey:options.requestKey,actorRef,state:found?"recorded":rejected?"notApplied":"notRecorded",
          reasonCode:rejected?"STALE_VERSION":null,currentVersion:rejected?String(rejected.current_version):null,proposal:found?JSON.parse(String(found.public_body)):null};
      }
      const readAccess=clockFresh && source.coverage==="complete" && clockExpiry<Date.parse(observed.readAccess.validUntil)
        ? {validUntil:new Date(clockExpiry).toISOString()} : observed.readAccess;
      const data:NativeCollaborationData=nativeCollaborationSchema.parse({...fields,readAccess,stale,actorRef,proposalReconciliation,collaborationRef:ref,kind:"source-collaboration",
        ...(publicClock?{postingClock:publicClock}:{}),proposals:rows.map(row=>JSON.parse(String(row.public_body))),proposalTotal:total});
      const assertCurrent=()=>{observed.assertCurrent();assertCurrentAssets(source);if(head(id)!==seq ||
        stale!==(now()-Date.parse(source.observedAt)>observationLeaseMs) ||
        postingClock && clockFresh!==(clockExpiry>now()))throw new CollaborationWorkflowError("SOURCE_VERSION_CHANGED",409);};
      assertCurrent();db.exec("COMMIT");return {data,version:version(source,seq),partial:source.coverage==="partial" || rows.length<total,stale,assertCurrent,
        capabilities:[{actionKind:"proposeCollaborationReview",state:source.coverage==="complete" && !stale?"available" as const:"held" as const,reasonCodes:stale?["SOURCE_STALE"]:source.coverage==="complete"?[]:["SOURCE_COVERAGE_PARTIAL"]}]};
    }catch(e){db.exec("ROLLBACK");throw e;}
  }
  async function propose(raw:unknown,actor:string,caller?:CollaborationCaller):Promise<Ack&{assertCurrent():void}> {
    const input=envelopeSchema.parse(raw);
    if(input.requestedScope.workspaceId!==scope.workspaceId || input.requestedScope.accountIds[0]!==scope.accountId || input.requestedScope.environment!==scope.environment || !actor.trim())
      throw new CollaborationWorkflowError("SOURCE_SCOPE_DENIED",403);
    const intent=input.payload,id=canonical(intent.collaborationRef);
    const {collaborationRef,...action}=intent;void collaborationRef;
    const requestDigest=digest([scope,actor,id,input.expectedVersion,action]);
    // Read source membership before disclosing even a historical replay.
    const observed=await snapshot(id,actor,"propose",input,caller),source=observed.snapshot;
    const publish=(value:Ack)=>{const fence=()=>{try{observed.assertCurrent();}catch(error){if(error instanceof CollaborationWorkflowError)throw new CollaborationWorkflowError(error.code,error.status,undefined,"uncertain");throw new CollaborationWorkflowError("COLLABORATION_SOURCE_UNAVAILABLE",503,undefined,"uncertain");}};
      Object.defineProperty(value,"assertCurrent",{value:fence,enumerable:false});fence();return value as Ack&{assertCurrent():void};};
    if(!source)throw new CollaborationWorkflowError("RECORD_NOT_FOUND",404);
    db.exec("BEGIN IMMEDIATE");
    let committed=false;
    try {
      observed.assertCurrent();assertCurrentAssets(source);
      const old=previous(input.idempotencyKey,requestDigest);
      if(old){observed.assertCurrent();db.exec("COMMIT");committed=true;return publish(old);}
      const rejected=db.prepare("SELECT request_digest,current_version FROM collaboration_review_rejections WHERE request_key=?").get(input.idempotencyKey);
      if(rejected){
        if(rejected.request_digest!==requestDigest)throw new CollaborationWorkflowError("IDEMPOTENCY_KEY_REUSED",409);
        throw new CollaborationWorkflowError("STALE_VERSION",409,String(rejected.current_version));
      }
      if(now()-Date.parse(source.observedAt)>observationLeaseMs)throw new CollaborationWorkflowError("SOURCE_STALE",409);
      const current=version(source,head(id));
      if(current!==input.expectedVersion){
        // Seal this exact nonce as a no-op. An earlier, still-running copy must observe this result before it could append a proposal.
        db.prepare("INSERT INTO collaboration_review_rejections VALUES(?,?,?,?,?)").run(input.idempotencyKey,requestDigest,actor,id,current);
        observed.assertCurrent();if(now()-Date.parse(source.observedAt)>observationLeaseMs)throw new CollaborationWorkflowError("SOURCE_STALE",409);db.exec("COMMIT");committed=true;
        throw new CollaborationWorkflowError("STALE_VERSION",409,current);
      }
      const targeted=["request-revision","reject-content","approve-content"].includes(intent.kind);
      const candidate=source.deliverables.find(d=>d.ref===intent.deliverableRef);
      if(targeted && (!candidate || !candidate.submissionVersion || candidate.submissionVersion!==intent.submissionVersion)
        || !targeted && (intent.deliverableRef || intent.submissionVersion) || (intent.kind==="close")!==!!intent.outcome)
        throw new CollaborationWorkflowError("INVALID_PROPOSAL_TARGET",422);
      const hold=intentHold(source,intent.kind,intent.deliverableRef);
      if(hold)throw new CollaborationWorkflowError(hold,409);
      const manifest={scope,collaborationId:id,sourceVersion:current,sourceRevision:source.sourceRevision,actor,policyVersion,action};
      const hash=digest(manifest),proposalId="proposal-"+randomUUID(),createdAt=new Date(now()).toISOString();
      const body={id:proposalId,digest:hash,kind:intent.kind,createdAt,state:"approvalPending",baseVersion:current,actorRef:actor,reason:intent.reason,reasonHash:digest(intent.reason),deliverableRef:intent.deliverableRef??null,
        submissionVersion:intent.submissionVersion??null,outcome:intent.outcome??null};
      db.prepare("INSERT INTO collaboration_review_proposals(id,collaboration_id,actor,kind,manifest_hash,manifest,public_body,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(proposalId,id,actor,intent.kind,hash,JSON.stringify(manifest),JSON.stringify(body),createdAt);
      const ack:Ack={actionRef:proposalId,payloadVersion:hash,policyVersion,receiptRefs:["proposal:"+proposalId],state:"approvalPending"};
      db.prepare("INSERT INTO collaboration_review_requests VALUES(?,?,?)").run(input.idempotencyKey,requestDigest,JSON.stringify(ack));
      observed.assertCurrent();if(now()-Date.parse(source.observedAt)>observationLeaseMs)throw new CollaborationWorkflowError("SOURCE_STALE",409);db.exec("COMMIT");committed=true;return publish(ack);
    }catch(e){if(!committed)db.exec("ROLLBACK");throw e;}
  }
  return {read,propose};
}
