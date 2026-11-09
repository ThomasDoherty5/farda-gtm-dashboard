// @vitest-environment node
import { createRequire } from "node:module";
const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe,it,expect,vi } from "vitest";
import { createCollaborationWorkflow,CollaborationWorkflowError } from "./collaborationWorkflow.ts";
import { collaborationSnapshotSchema, type CollaborationSourceReader } from "./collaborationWorkflowSchema.ts";
import { collaborationTestSource,collaborationAction, collaborationSnapshot, collabTestAt, collabTestId, collabTestScope as scope } from "./collaborationWorkflowFixtures.ts";
import { sealCollaborationRef } from "./creatorPlatformReferences.ts";
function opened(path=":memory:"){
  const db=new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS capability_scope(id INTEGER PRIMARY KEY,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT OR IGNORE INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId,scope.accountId,scope.environment);return db;
}
const secret="synthetic-server-only-value",now=()=>Date.parse(collabTestAt);
describe("current collaboration read authority",()=>{
  it("preserves one original proposal receipt after postcommit revocation",async()=>{
    const db=opened(),source=collaborationTestSource(()=>collaborationSnapshot(),now),assert=source.assertCurrent;let denied=false;
    source.assertCurrent=(...args)=>{if(denied)throw new CollaborationWorkflowError("PRIVATE_OWNER_TOKEN",403);assert(...args);};
    const service=createCollaborationWorkflow(db,scope,secret,source,now);
    try{const before=(await service.read(collabTestId))!,request=collaborationAction(before.version!,{},"committed-original"),exec=db.exec.bind(db);
      const spy=vi.spyOn(db,"exec").mockImplementation(sql=>{const result=exec(sql);if(sql==="COMMIT")denied=true;return result;});
      try{await expect(service.propose(request,"agent-reviewer")).rejects.toMatchObject({code:"COLLABORATION_SOURCE_DENIED",status:403,executionCertainty:"uncertain"});}finally{spy.mockRestore();}
      const recorded=db.prepare("SELECT receipt FROM collaboration_review_requests WHERE request_key=?").get(request.idempotencyKey)!;expect(recorded).toBeDefined();
      denied=false;expect(await service.propose(request,"agent-reviewer")).toEqual(JSON.parse(String(recorded.receipt)));
      expect(db.prepare("SELECT COUNT(*) AS n FROM collaboration_review_proposals").get()?.n).toBe(1);
    }finally{db.close();}
  });
  it.each(["denied","revision"] as const)("rejects captured source %s without any asset-binding dependency",async(change)=>{
    const db=opened(),snapshot=collaborationSnapshot();let denied=false;const source=collaborationTestSource(()=>{if(denied)throw new CollaborationWorkflowError("PRIVATE_OWNER_TOKEN",403,"private-version");return snapshot;},now);
    const service=createCollaborationWorkflow(db,scope,secret,source,now);
    try{const before=(await service.read(collabTestId))!,read=source.read;source.read=async(...args)=>{const packet=await read(...args);await Promise.resolve();if(change==="denied")denied=true;else snapshot.sourceRevision="new-source-revision";return packet;};
      await expect(service.propose(collaborationAction(before.version!),"agent-reviewer")).rejects.toMatchObject({code:change==="denied"?"COLLABORATION_SOURCE_DENIED":"COLLABORATION_SOURCE_CHANGED"});
      expect(db.prepare("SELECT COUNT(*) AS n FROM collaboration_review_proposals").get()?.n).toBe(0);
    }finally{db.close();}
  });
  it.each(["read","assert"] as const)("normalizes private typed %s failures",async(stage)=>{
    const db=opened(),source=collaborationTestSource(()=>collaborationSnapshot(),now),service=createCollaborationWorkflow(db,scope,secret,source,now);
    try{for(const status of [403,409]){const error=new CollaborationWorkflowError("PRIVATE_OWNER_TOKEN",status,"private-version");if(stage==="read")source.read=async()=>{throw error;};else source.assertCurrent=()=>{throw error;};
      await expect(service.read(collabTestId)).rejects.toMatchObject({code:status===403?"COLLABORATION_SOURCE_DENIED":"COLLABORATION_SOURCE_CHANGED",currentVersion:undefined});}
    }finally{db.close();}
  });
  it("publishes a separate access lease and refuses unverified absence",async()=>{
    const db=opened();let time=now();const source=collaborationTestSource(()=>collaborationSnapshot(),()=>time),service=createCollaborationWorkflow(db,scope,secret,source,()=>time);
    try{const result=(await service.read(collabTestId))!;expect(result.data!.readAccess?.validUntil).toBe(new Date(time+15*60_000).toISOString());time+=15*60_000;
      expect(()=>result.assertCurrent()).toThrow("COLLABORATION_ACCESS_EXPIRED");
      const absent=collaborationTestSource(()=>null,()=>time),read=absent.read;absent.read=async(...args)=>({...await read(...args) as object,absence:"unknown"});
      await expect(createCollaborationWorkflow(db,scope,secret,absent,()=>time).read(collabTestId)).rejects.toMatchObject({code:"SOURCE_COVERAGE_INCOMPLETE",status:503});
    }finally{db.close();}
  });
  it("keeps a verified absence fenced through the final publication boundary",async()=>{
    const db=opened(),source=collaborationTestSource(()=>null,now),service=createCollaborationWorkflow(db,scope,secret,source,now);
    try{const absent=await service.read(collabTestId);expect(absent.data).toBeNull();source.assertCurrent=()=>{throw new CollaborationWorkflowError("PRIVATE_OWNER_TOKEN",403);};
      expect(()=>absent.assertCurrent()).toThrow("COLLABORATION_SOURCE_DENIED");
    }finally{db.close();}
  });
  it.each(["missing","async","nonvoid"] as const)("rejects %s final assertion owners",async(kind)=>{
    const db=opened(),source=collaborationTestSource(()=>collaborationSnapshot(),now);Object.assign(source,{assertCurrent:kind==="missing"?undefined:kind==="async"?async()=>undefined:()=>true});
    try{await expect(createCollaborationWorkflow(db,scope,secret,source,now).read(collabTestId)).rejects.toBeInstanceOf(CollaborationWorkflowError);}finally{db.close();}
  });
});
describe("authoritative collaboration workflow",()=>{
  it("persists an immutable approval proposal across restarts, private routing, retries, concurrent versions and changed native facts",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"collab-workflow-")),path=join(dir,"workflow.sqlite"),snapshot=collaborationSnapshot();
    let db=opened(path);
    const reader:CollaborationSourceReader=collaborationTestSource(id=>id===collabTestId?snapshot:null,now);
    const opaque=sealCollaborationRef(scope,secret,collabTestId);
    try{
      let w=createCollaborationWorkflow(db,scope,secret,reader,now);
      const initial=(await w.read(opaque))!;
      expect(initial.data!.collaborationRef).toBe(opaque);expect(initial.data!.proposalTotal).toBe(0);
      const request=collaborationAction(initial.version!,{collaborationRef:opaque,kind:"request-revision",deliverableRef:"synthetic-deliverable",submissionVersion:"submission-v2"});
      const ack=await w.propose(request,"synthetic-reviewer");
      expect(ack.state).toBe("approvalPending");expect(ack.receiptRefs).toEqual(["proposal:"+ack.actionRef]);
      expect(await w.propose(request,"synthetic-reviewer")).toEqual(ack);
      await expect(w.propose({...request,idempotencyKey:"new-key"},"synthetic-reviewer")).rejects.toThrow("STALE_VERSION");
      await expect(w.propose({...request,payload:{...request.payload,reason:"Different"}},"synthetic-reviewer")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
      const saved=(await w.read(opaque))!;expect(saved.data!.proposals[0]).toMatchObject({digest:ack.payloadVersion,actorRef:"synthetic-reviewer",reason:request.payload.reason,state:"approvalPending"});
      expect(saved.data!.stage).toBe("Creating");expect(saved.data!.deliverables[0]!.review.state).toBe("unknown");
      db.close();db=opened(path);w=createCollaborationWorkflow(db,scope,secret,reader,now);
      expect(await w.propose(request,"synthetic-reviewer")).toEqual(ack);
      const current=(await w.read(opaque))!;snapshot.sourceRevision="new-source-version";
      await expect(w.propose({...request,idempotencyKey:"changed",expectedVersion:current.version!},"synthetic-reviewer")).rejects.toThrow("STALE_VERSION");
      expect((await w.read(opaque))!.data!.proposalTotal).toBe(1);
      await expect(w.read(sealCollaborationRef({...scope,accountId:"other"},secret,collabTestId))).rejects.toThrow("INVALID_COLLABORATION_REFERENCE");
      await expect(w.propose({...request,requestedScope:{...request.requestedScope,accountIds:["other"]}},"synthetic-reviewer")).rejects.toThrow("SOURCE_SCOPE_DENIED");
    }finally{db.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("looks up the exact actor/request across all history and seals stale retries as immutable no-ops",async()=>{
    const db=opened();try{
      const source=collaborationSnapshot(),service=createCollaborationWorkflow(db,scope,secret,collaborationTestSource(()=>source,now),now);
      const firstVersion=(await service.read(collabTestId))!.version!;
      const first=collaborationAction(firstVersion,{},"own-key"),ack=await service.propose(first,"reviewer-one");
      // Same reason and target must not count as evidence of a request belonging to a different actor/key.
      for(const [key,actor]of [["own-key","reviewer-two"],["unused-key","reviewer-one"]]){
        const read=await service.read(collabTestId,{requestKey:key,actorRef:actor});
        expect(read!.data!.proposalReconciliation).toMatchObject({state:"notRecorded",proposal:null});
      }
      for(let n=0;n<51;n++){
        const current=(await service.read(collabTestId))!.version!;
        await service.propose(collaborationAction(current,{},"later-"+n),"reviewer-two");
      }
      const bounded=await service.read(collabTestId,{requestKey:"own-key",actorRef:"reviewer-one"});
      expect(bounded!.data!.proposals).toHaveLength(50);expect(bounded!.data!.proposals.some(p=>p.id===ack.actionRef)).toBe(false);
      expect(bounded!.data!.proposalReconciliation).toMatchObject({state:"recorded",proposal:{id:ack.actionRef,actorRef:"reviewer-one"}});
      const stale=collaborationAction(firstVersion,{},"never-arrived");
      await expect(service.propose(stale,"reviewer-one")).rejects.toThrow("STALE_VERSION");
      const noOp=await service.read(collabTestId,{requestKey:"never-arrived",actorRef:"reviewer-one"});
      expect(noOp!.data!.proposalReconciliation).toMatchObject({state:"notApplied",reasonCode:"STALE_VERSION",proposal:null});
      await expect(service.propose(stale,"reviewer-one")).rejects.toThrow("STALE_VERSION");
      expect(noOp!.data!.proposalTotal).toBe(52);
    }finally{db.close();}
  });
  it("keeps unknown, voluntary, suppressed, unverified publication and stale source states separate",async()=>{
    const db=opened(),source=collaborationSnapshot(),reader:CollaborationSourceReader=collaborationTestSource(()=>source,now);
    try{
      const w=createCollaborationWorkflow(db,scope,secret,reader,now);
      const attempt=async(kind:"reminder"|"repeat"|"request-revision"|"close",args={})=>w.propose(collaborationAction((await w.read(collabTestId))!.version!,{kind,...args}),"reviewer");
      source.terms.posting="voluntary";source.terms.due=null;source.terms.graceDays=null;
      await expect(attempt("reminder")).rejects.toThrow("POSTING_OBLIGATION_UNVERIFIED");
      source.suppression={state:"suppressed",sourceRef:"optout"};await expect(attempt("repeat")).rejects.toThrow("OUTREACH_SUPPRESSED");
      await expect(attempt("request-revision",{deliverableRef:"synthetic-deliverable",submissionVersion:"v1"})).rejects.toThrow("INVALID_PROPOSAL_TARGET");
      source.coverage="partial";await expect(attempt("close",{outcome:"no-response"})).rejects.toThrow("SOURCE_COVERAGE_PARTIAL");
      source.coverage="complete";source.observedAt="2020-01-01T00:00:00Z";const old=await w.read(collabTestId);
      expect(old!.stale).toBe(true);await expect(attempt("close",{outcome:"completed"})).rejects.toThrow("SOURCE_STALE");
      source.observedAt=collabTestAt;source.deliverables[0]!.publication.state="published";
      expect(collaborationSnapshotSchema.safeParse(source).success).toBe(false);
      await expect(w.read(collabTestId)).rejects.toThrow("SOURCE_RESPONSE_INVALID");
    }finally{db.close();}
  });
  it("serves missing, unavailable, wrong-scope and independently registered submissions without guessing rights",async()=>{
    const db=opened();try{
      await expect(createCollaborationWorkflow(db,scope,secret,undefined,now).read(collabTestId)).rejects.toThrow("INTEGRATION_PENDING");
      expect((await createCollaborationWorkflow(db,scope,secret,collaborationTestSource(()=>null,now),now).read(collabTestId)).data).toBeNull();
      const s=collaborationSnapshot();
      await expect(createCollaborationWorkflow(db,scope,secret,collaborationTestSource(()=>({...s,scope:{...scope,accountId:"other"}}),now),now).read(collabTestId)).rejects.toThrow("SOURCE_SCOPE_DENIED");
      db.exec("CREATE TABLE creator_assets(asset_id TEXT,version INTEGER,body TEXT); CREATE TABLE creator_asset_requests(key TEXT PRIMARY KEY)");
      db.prepare("INSERT INTO creator_assets VALUES(?,?,?)").run("linked-asset",1,JSON.stringify({submission:{collaborationId:collabTestId,fileVersion:"drive-v1"},sourceEvidence:{availability:"available"}}));
      s.assetBindings=[{deliverableRef:s.deliverables[0]!.ref,assetId:"linked-asset"}];s.deliverables[0]!.submissionVersion=null;
      const w=createCollaborationWorkflow(db,scope,secret,collaborationTestSource(()=>s,now),now,async()=>({nextCursor:null,data:{source:"saved-agent-records",kind:"collaboration-evidence",
        collaborationId:collabTestId,observedAt:collabTestAt,total:1,offset:0,hasMore:false,records:[{kind:"asset",id:"asset-receipt",assetId:"linked-asset",fileVersion:"drive-v1",
          productId:"product",productRevision:"revision",version:1,recordedAt:collabTestAt,parentAssetId:null,parentVersion:null,availability:"available",reviewState:"pending",rightsState:"unknown",rightsObservedAt:null}]}}));
      const data=(await w.read(collabTestId))!.data;expect(data.deliverables[0]).toMatchObject({submissionVersion:expect.stringMatching(/^v1-/),review:{state:"pending"},rights:{state:"unknown"},publishPermission:{state:"unknown"}});
    }finally{db.close();}
  });
});
