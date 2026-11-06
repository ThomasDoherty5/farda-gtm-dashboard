// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { createOperations } from "./operations.ts";
import { capabilityIdForBinding } from "./connections/ledger.ts";
import { unknownBusinessEligibility, unknownSourceFreshness } from "./connections/schema.ts";
import type { ExpectedBinding, VerificationReceipt } from "./connections/schema.ts";
import { createProviderHealth, createNotionRegistryHealthTargets, healthBindingDigest } from "./providerHealth.ts";
import type { HealthObservation, HealthTarget } from "./providerHealth.ts";
import { healthObservationSchema, notionHealthTargetConfigSchema } from "./providerHealthSchema.ts";
import { AssetRegistryReadError, createNotionDriveAssetSource } from "./notionDriveAssetSource.ts";

const scope={workspaceId:"test-workspace",accountId:"test-account",environment:"sandbox" as const};
const epoch=Date.parse("2026-11-05T12:00:00Z");
let clock=epoch;
const now=()=>clock;
const iso=(time=clock)=>new Date(time).toISOString();
const binding = (patch:Partial<ExpectedBinding>={}):ExpectedBinding => ({
  ...scope, provider:"test-provider",providerAccountId:"test-native-account",action:"check-source",mode:"observe",route:"api",
  routeRef:"route:test-api",authorizationScopeVersion:"v1",toolVersion:"v1",requiredScopes:["source:read"],
  connectionRef:"connection:private-connection",secretRef:"secretref:private-secret",...patch,
});
const observation=(b:ExpectedBinding,patch:Partial<HealthObservation>={}):HealthObservation=>({
  bindingDigest:healthBindingDigest(b),checkedAt:iso(),status:"observed",permission:"allowed",session:"authenticated",roleScopePlan:"verified",
  coverage:"complete",sourceLastSuccess:iso(),sourceUpdatedAt:iso(),mirrorUpdatedAt:null,quotaState:"not_applicable",quotaRemaining:null,deadlineState:"not_applicable",deadline:null,...patch,
});
const target=(b:ExpectedBinding, probe:HealthTarget["probe"]):HealthTarget=>({
  binding:b,ownerRef:"owner:source-operator",documentationRef:"docs:test-capability",documentationCheckedAt:iso(epoch),maxAgeSeconds:60,
  freshnessBasis:"successful_read",probe,
});
const cleanup:(()=>void)[]=[];
function setup(targets:HealthTarget[],activate=true,path=":memory:") {
  const store=new AgentStore(path,scope);
  const proofs=new Map<string,VerificationReceipt>();
  const ops=createOperations(store.database,scope,{now,resolveReceipt:r=>proofs.get(r)??null,
    resolveJobActivation:req=>activate && req.decisionRef==="test-activation" ? {approved:true,decisionRef:req.decisionRef,definitionHash:req.definitionHash}:null});
  const service=createProviderHealth(store.database,scope,ops.ledger,ops.jobs,{now,catalog:targets,activationRef:"test-activation"});
  const close=()=>{ ops.close();store.close(); };
  cleanup.push(close);
  async function register(b:ExpectedBinding,ready=true) {
    const id=capabilityIdForBinding(b);
    ops.ledger.register({binding:b,ownerRef:"owner:source-operator",costBasis:{state:"unknown",reasonCode:"UNKNOWN"}},0);
    if(ready) {
      const ref="receipt:"+id;
      proofs.set(ref,{receiptRef:ref,binding:b,outcome:"Ready",checkedAt:iso(),expiresAt:iso(clock+600_000),verifiedScopes:b.requiredScopes,
        connectionHealth:"Authenticated",sourceFreshness:unknownSourceFreshness(),businessEligibility:unknownBusinessEligibility(),reasonCodes:[]});
      await ops.ledger.verify(id,ref,1);
    }
    return id;
  }
  const check = (id:string,event:string,key=event)=>service.check({capabilityId:id,eventId:event},key);
  return {store,ops,service,register,check};
}
afterEach(()=>{ while(cleanup.length) cleanup.pop()!(); clock=epoch; });

describe("bounded provider health checks",()=>{
  it("requires separate job activation, retains a held run and never probes just because a connection is registered",async()=>{
    const b=binding(), probe=vi.fn(async()=>observation(b));
    const s=setup([target(b,probe)],false); const id=await s.register(b);
    const r=await s.check(id,"manual-1");
    expect(r).toMatchObject({state:"held",observationId:null,health:{state:"unverified"},blockers:["JOB_DISABLED_OR_STALE"]});
    expect(s.ops.jobs.getRun(r.runId!)).toMatchObject({state:"held",usage:{externalCalls:0}});
    expect(probe).not.toHaveBeenCalled(); expect(s.ops.ledger.requireReady(b).allowed).toBe(false);
    expect(s.service.history(id).total).toBe(0);
  });
  it("can activate a never-authorized definition on a later manual check but respects an explicit owner disable",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"j14-release-")); cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
    const path=join(directory,"jobs.sqlite"), b=binding(),probe=vi.fn(async()=>observation(b));
    const first=setup([target(b,probe)],false,path);
    const id=await first.register(b);
    expect((await first.check(id,"release")).state).toBe("held");
    const enabled=setup([target(b,probe)],true,path);
    expect((await enabled.check(id,"release")).state).toBe("observed");
    enabled.ops.jobs.setJobControl("j14-"+id,1,"disable");
    expect((await enabled.check(id,"disabled")).state).toBe("held");
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it("binds a native observation to its saved action, persists a checkpoint, and replays once across request keys",async()=>{
    const b=binding(),probe=vi.fn(async()=>observation(b));
    const s=setup([target(b,probe)]); const id=await s.register(b);
    const result=await s.check(id,"native-read"); expect(result).toMatchObject({state:"observed",health:{state:"ready",permission:"allowed",coverage:"complete",sourceLastSuccess:iso()}});
    expect(await s.check(id,"native-read","new-request")).toEqual(result);
    await expect(s.check(id,"different-event","native-read")).rejects.toThrow("IDEMPOTENCY");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(s.ops.jobs.getRun(result.runId!)).toMatchObject({state:"completed",items:[{checkpoint:{cursor:"native-preflight"}}],usage:{externalCalls:null,sourceQuota:"unknown"}});
    expect(s.ops.ledger.requireReady(b).allowed).toBe(true);
    expect(JSON.stringify(s.service.history(id))).not.toMatch(/private-secret|private-connection|https:\/\//);
    clock+=61_000;
    expect((await s.check(id,"native-read","expired-retry")).health?.state).toBe("blocked");
    expect(probe).toHaveBeenCalledTimes(1);
    s.ops.ledger.revoke(id,"REVOKED",2);
    expect((await s.check(id,"native-read","revoked-retry")).health?.reasonCodes).toContain("PERMISSION_DENIED");
    expect(s.service.history(id).records[0]?.summary?.state).toBe("ready");
  });
  it("deduplicates failure across restart, keeps past native success and requires fresh permitted recovery",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"farda-j14-")); cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
    const b=binding(); let healthy=true;
    const probe=async()=>healthy ? observation(b) : observation(b,{status:"missing_access",permission:"unknown",session:"expired",sourceLastSuccess:null,sourceUpdatedAt:null,mirrorUpdatedAt:iso()});
    const path=join(directory,"jobs.sqlite");
    const s=setup([target(b,probe)],true,path); const id=await s.register(b); await s.check(id,"first");
    healthy=false; clock+=2_000;
    const failed=await s.check(id,"loss1");
    expect(failed.health).toMatchObject({state:"blocked",sourceLastSuccess:iso(epoch),mirrorUpdatedAt:iso()});
    await s.check(id,"loss2");
    const open=s.service.exceptions(id).records.filter(e=>e.reasonCode==="SESSION_EXPIRED");
    expect(open).toHaveLength(1);
    const reopened=setup([target(b,probe)],true,path);
    expect(reopened.service.exceptions(id).records.find(e=>e.reasonCode==="SESSION_EXPIRED")).toMatchObject({state:"open",ownerRef:"owner:source-operator"});
    expect(reopened.ops.ledger.requireReady(b).allowed).toBe(false);
    healthy=true; clock+=2_000; await reopened.check(id,"recovered");
    expect(reopened.service.exceptions(id).records.find(e=>e.reasonCode==="SESSION_EXPIRED")?.state).toBe("resolved");
    expect(reopened.ops.ledger.requireReady(b).allowed).toBe(true);
    expect(reopened.service.history(id)).toMatchObject({total:4});
    clock+=61_000; expect(reopened.service.get(id)).toMatchObject({freshness:"stale",state:"blocked"});
    expect(reopened.ops.ledger.requireReady(b).allowed).toBe(false);
  });
  it("permits independently verified browser observation after unsupported API and holds it after an explicit account denial",async()=>{
    const api=binding(),browser=binding({route:"browser",routeRef:"route:test-browser"});
    let apiStatus:HealthObservation["status"]="unsupported", denial=false;
    const s=setup([target(api,async()=>observation(api,{status:apiStatus,permission:denial?"denied":"unknown"})),target(browser,async()=>observation(browser))]);
    const id=await s.register(api), browserId=await s.register(browser);
    expect((await s.check(id,"unsupported")).health?.state).toBe("unsupported");
    expect((await s.check(browserId,"browser-native")).health?.state).toBe("ready");
    apiStatus="restricted";denial=true; await s.check(id,"denial");
    expect(s.ops.ledger.requireReady(browser).allowed).toBe(false);
    expect((await s.check(browserId,"browser-again")).health?.state).toBe("blocked");
    apiStatus="failed";denial=false;await s.check(id,"failed-reread");
    expect(s.ops.ledger.requireReady(browser).allowed).toBe(false);
  });
  it("enforces a ledger revocation on the same action before any new health observation",async()=>{
    const api=binding(), browser=binding({route:"browser",routeRef:"route:test-browser"});
    const s=setup([target(api,async()=>observation(api)),target(browser,async()=>observation(browser))]);
    const apiId=await s.register(api), browserId=await s.register(browser);
    await s.check(browserId,"independent-browser");
    expect(s.ops.ledger.requireReady(browser).allowed).toBe(true);
    s.ops.ledger.revoke(apiId,"ACCOUNT_PERMISSION_REVOKED",2);
    expect(s.ops.ledger.requireReady(browser).allowed).toBe(false);
    expect(s.service.get(browserId)?.reasonCodes).toContain("PERMISSION_DENIED");
  });
  it("retains denial and the owned exception after restart without the private probe catalog",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"j14-catalog-"));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
    const path=join(directory,"store.sqlite"),b=binding();
    const s=setup([target(b,async()=>observation(b,{status:"restricted",permission:"denied"}))],true,path);
    const id=await s.register(b);
    await s.check(id,"explicit-denial");
    const reopened=setup([],true,path);
    expect(reopened.service.get(id)).toMatchObject({configured:false,state:"blocked",reasonCodes:expect.arrayContaining(["PERMISSION_DENIED"])});
    expect(reopened.service.list()).toMatchObject({configured:false,records:[{state:"blocked"}]});
    expect(reopened.service.exceptions(id).records.find(e=>e.reasonCode==="PERMISSION_DENIED")).toMatchObject({state:"open",ownerRef:"owner:source-operator"});
    expect(reopened.ops.ledger.requireReady(b).allowed).toBe(false);
  });
  it("blocks a stale native event despite a current mirror; quota and deadline unknown are explicit for phased actions",async()=>{
    const b=binding({mode:"executeApproved"}), t=target(b,async()=>observation(b,{sourceUpdatedAt:iso(clock-360_000),mirrorUpdatedAt:iso(),quotaState:"unknown",deadlineState:"unknown"}));
    const s=setup([{...t,freshnessBasis:"source_event"}]); const id=await s.register(b);
    const r=await s.check(id,"stale");
    expect(r.health).toMatchObject({state:"blocked",freshness:"stale",quotaRemaining:null,deadline:null,
      unknowns:["NATIVE_QUOTA_UNKNOWN","NATIVE_DEADLINE_UNKNOWN"],reasonCodes:expect.arrayContaining(["SOURCE_STALE","REQUIRED_QUOTA_UNVERIFIED","REQUIRED_DEADLINE_UNVERIFIED"])});
    expect(s.ops.ledger.requireReady(b).allowed).toBe(false);
  });
  it("seals preflight versions to the observation, binding, policy and current effective state",async()=>{
    const b=binding(),t=target(b,async()=>observation(b));
    const s=setup([t]);const id=await s.register(b);
    const issued=(await s.check(id,"first")).health!;
    expect(issued.preflightVersion).toMatch(/^[a-f0-9]{64}$/);
    clock+=5_000;
    expect(s.service.get(id)?.preflightVersion).toBe(issued.preflightVersion);
    const next=(await s.check(id,"next")).health!;
    expect(next.preflightVersion).not.toBe(issued.preflightVersion);
    clock+=60_000;
    expect(s.service.get(id)?.preflightVersion).not.toBe(next.preflightVersion);
    const changed=createProviderHealth(s.store.database,scope,s.ops.ledger,s.ops.jobs,{now,catalog:[{...t,maxAgeSeconds:180}]});
    expect(changed.get(id)?.reasonCodes).toContain("BINDING_CHANGED");
    expect(changed.get(id)?.preflightVersion).not.toBe(s.service.get(id)?.preflightVersion);
  });
  it("rejects malformed offsets in new proofs and held historical/future timestamps in an otherwise eligible execute route",async()=>{
    const invalid="2026-11-04T16:00:00+99:99";
    const b=binding({mode:"executeApproved"});
    const real=observation(b,{quotaState:"known",quotaRemaining:3,deadlineState:"known",deadline:iso(clock+30_000)});
    for (const field of ["checkedAt","sourceLastSuccess","sourceUpdatedAt","mirrorUpdatedAt","deadline"] as const) {
      expect(healthObservationSchema.safeParse({...real,[field]:invalid}).success).toBe(false);
    }
    expect(notionHealthTargetConfigSchema.safeParse({registry:"content",binding:b,ownerRef:"owner:test",maxAgeSeconds:60,documentationCheckedAt:invalid}).success).toBe(false);
    const s=setup([target(b,async()=>real)]);const id=await s.register(b);
    expect((await s.check(id,"valid")).health?.state).toBe("ready");
    const saved=JSON.parse(String(s.store.database.prepare("SELECT body FROM health_observations").get()!.body));
    for (const change of [{checkedAt:invalid,deadline:invalid},{checkedAt:iso(clock+1000)},{sourceLastSuccess:iso(clock+1000)},{sourceUpdatedAt:invalid},{deadline:invalid}]) {
      s.store.database.prepare("UPDATE health_observations SET body=?").run(JSON.stringify({...saved,observation:{...real,...change}}));
      expect(s.service.get(id)).toMatchObject({state:"blocked",reasonCodes:expect.arrayContaining(["INVALID_HEALTH_OBSERVATION"])});
      expect(s.ops.ledger.requireReady(b).allowed).toBe(false);
    }
  });
  it.each(["mfa","ui_changed"] as const)("creates owned human takeover for %s",async session=>{
    const b=binding();const s=setup([target(b,async()=>observation(b,{session,permission:"unknown"}))]);const id=await s.register(b);
    await s.check(id,"takeover");
    expect(s.service.exceptions(id).records).toEqual(expect.arrayContaining([expect.objectContaining({state:"open",nextAction:"owner_takeover_and_reverify",ownerRef:"owner:source-operator"})]));
  });
  it("rejects a changed binding after an awaited probe and never records its late success",async()=>{
    const b=binding();let release!:()=>void;let started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const s=setup([target(b,async()=>{started();await new Promise<void>(resolve=>{release=resolve;});return observation(b);})]);
    const id=await s.register(b);
    const pending=s.check(id,"pending");await entered;
    s.ops.ledger.revoke(id,"LOST_PERMISSION",2);release();
    await expect(pending).rejects.toThrow("HEALTH_BINDING_CHANGED");
    expect(s.service.history(id).total).toBe(0);
    expect(s.ops.ledger.requireReady(b).state).toBe("Denied");
  });
  it("fences late workers and keeps uncertain business receipts intact through recovery",async()=>{
    const b=binding();let release!:()=>void;let started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const s=setup([target(b,async()=>{started();await new Promise<void>(resolve=>{release=resolve;});return observation(b);})]);const id=await s.register(b);
    const pending=s.check(id,"late");await entered;
    const healthDef=s.ops.jobs.getJob("j14-"+id).definition;
    const business={...healthDef,jobId:"synthetic-business",handler:"record-reference.v1" as const,healthPolicyVersion:undefined};
    s.ops.jobs.register(business,0);s.ops.jobs.activate(business.jobId,1,"test-activation");
    const run=s.ops.jobs.ingest({schemaVersion:"job-reference-batch.v1",jobId:business.jobId,jobVersion:1,eventId:"biz",eventType:business.eventType,eventAt:null,items:[{itemKey:"biz",subjectRef:"opaque",evidenceRef:null}]},"biz");
    const claim=s.ops.jobs.claim("business-worker",business.jobId)!;
    s.ops.jobs.fail(claim.item.itemId,claim.leaseToken,{reasonCode:"UNCERTAIN",certainty:"uncertain",retryable:false,retryAfterMs:0});
    const before=s.ops.jobs.history(run.runId);
    clock+=21_000; release();await expect(pending).rejects.toThrow("JOB_LEASE_FENCED");
    expect(s.service.history(id).total).toBe(0);
    expect(s.ops.jobs.getRun(run.runId).state).toBe("reconcile"); expect(s.ops.jobs.history(run.runId)).toEqual(before);
  });
  it("shows an unconfigured registry explicitly and rejects caller-supplied health proof",async()=>{
    const s=setup([]); const id=await s.register(binding());
    expect(s.service.list()).toMatchObject({configured:false,total:1,records:[{configured:false,state:"unverified"}]});
    expect(await s.check(id,"empty")).toMatchObject({state:"unconfigured",runId:null});
    await expect(s.service.check({capabilityId:id,eventId:"test",state:"ready"},"test")).rejects.toThrow();
  });
  it("uses only the bound native Notion registry read, preserves unknown plan/quota and never converts missing access to denial",async()=>{
    const b=binding({provider:"notion",action:"read-content-registry"});let granted=true;
    const reader=vi.fn(async()=>{
      if(!granted) throw new AssetRegistryReadError("SOURCE_ACCESS_UNAVAILABLE",503);
      return {registry:"content" as const,observedAt:iso(),records:[],coverage:"complete" as const,nextCursor:null,rights:"unverified" as const};
    });
    const configs=[{registry:"content" as const,binding:b,ownerRef:"owner:source-operator",maxAgeSeconds:60,documentationCheckedAt:iso()}];
    const identity=vi.fn(async()=>b.providerAccountId);
    const targets=createNotionRegistryHealthTargets(scope,configs,reader,identity);
    const s=setup(targets);const id=await s.register(b);
    const observed=await s.check(id,"notion-read");
    expect(observed.health).toMatchObject({state:"ready",sourceUpdatedAt:null,coverage:"complete",roleScopePlan:"unknown",quotaState:"unknown",deadlineState:"not_applicable"});
    expect(reader).toHaveBeenCalledWith({workspaceId:scope.workspaceId,accountId:scope.accountId},{registry:"content",limit:100},expect.any(AbortSignal));
    expect(identity).toHaveBeenCalledTimes(2);
    granted=false;await s.check(id,"notion-loss");
    expect(s.service.get(id)?.permission).toBe("unknown");
    expect(()=>createNotionRegistryHealthTargets(scope,[{...configs[0]!,binding:binding({provider:"notion",action:"send"})}],reader)).toThrow("INVALID_NOTION_HEALTH_BINDING");
  });
  it("checks the native workspace before reading target rows and after the read",async()=>{
    const b=binding({provider:"notion",action:"read-content-registry"});
    const configs=[{registry:"content" as const,binding:b,ownerRef:"owner:source-operator",maxAgeSeconds:60,documentationCheckedAt:iso()}];
    const reader=vi.fn(async()=>({registry:"content" as const,observedAt:iso(),records:[],coverage:"complete" as const,nextCursor:null,rights:"unverified" as const}));
    const source=(workspace:()=>Promise<string|null>)=>createNotionRegistryHealthTargets(scope,configs,reader,workspace)[0]!.probe!(new AbortController().signal);
    expect((await source(async()=>null)).status).toBe("missing_access");
    expect((await source(async()=>"wrong")).status).toBe("account_mismatch");
    expect(reader).not.toHaveBeenCalled();
    let first=true;
    expect((await source(async()=>{if(first){first=false;return b.providerAccountId;}return "changed";})).status).toBe("account_mismatch");
    expect(reader).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["exhausted",2,"complete","ready"],
    ["page budget",3,"partial","unverified"],
    ["native truncation",2,"partial","unverified"],
    ["second request fails",2,"partial","unverified"],
  ] as const)("bounded Notion query scan: %s",async(scenario,expectedCalls,coverage,state)=>{
    clock=Date.now()+100;
    const workspace="20000000-0000-4000-8000-000000000001";
    const source="30000000-0000-4000-8000-000000000001";
    const api=binding({provider:"notion",providerAccountId:workspace,action:"read-content-registry"});
    const cursors:(string|null)[]=[];
    const newest=iso(clock-5_000);
    const native=createNotionDriveAssetSource({scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},contentDataSourceId:source,
      collaborationDataSourceId:"30000000-0000-4000-8000-000000000002",notionToken:async()=>"synthetic-read-token"},{
      clock:()=>iso(),fetch:async(url,opts)=>{
        if(String(url).endsWith("/users/me")) return Response.json({object:"user",type:"bot",bot:{workspace_id:workspace}});
        expect(String(url)).toBe(`https://api.notion.com/v1/data_sources/${source}/query`);
        const input=JSON.parse(String(opts?.body));
        expect(input.page_size).toBe(100);
        cursors.push(input.start_cursor ?? null);
        const page=cursors.length;
        if(scenario==="second request fails" && page===2) return new Response("synthetic provider failure",{status:500});
        const more=scenario==="page budget" || page===1;
        const row=(n:number,stamp:string)=>({object:"page",id:`40000000-0000-4000-8000-${String(n).padStart(12,"0")}`,
          parent:{type:"data_source_id",data_source_id:source},in_trash:false,is_archived:false,last_edited_time:stamp,
          properties:{"Asset link":{type:"url",url:null}}});
        const results=page===1 ? [row(1,iso(clock-50_000)),row(2,newest)] : [row(page+1,iso(clock-20_000))];
        return Response.json({object:"list",results,has_more:more,next_cursor:more ? "cursor-"+page:null,
          request_status:{type:scenario==="native truncation" && page===2 ? "incomplete":"complete"}});
      },
    });
    const targets=createNotionRegistryHealthTargets(scope,[{registry:"content",binding:api,ownerRef:"owner:source-operator",maxAgeSeconds:60,documentationCheckedAt:iso(epoch)}],
      native.listRegistryPage,native.readNotionWorkspace);
    const s=setup(targets),id=await s.register(api);
    const check=await s.check(id,"native-scan");
    expect(cursors).toEqual([null,"cursor-1","cursor-2"].slice(0,expectedCalls));
    expect(check.health).toMatchObject({state,coverage,sourceUpdatedAt:coverage==="complete" ? newest:null});
    expect(s.ops.ledger.requireReady(api).allowed).toBe(coverage==="complete");
  });
  it.each([
    [401,"unknown","expired","blocked",false], [403,"denied","unknown","blocked",true], [404,"unknown","unknown","unverified",false],
  ] as const)("keeps native HTTP %i distinct across scoped probe and alternate-route preflight",async(status,permission,session,state,denied)=>{
    clock=Date.now()+100;
    const workspace="20000000-0000-4000-8000-000000000001";
    const api=binding({provider:"notion",providerAccountId:workspace,action:"read-content-registry"});
    const browser={...api,route:"browser" as const,routeRef:"route:test-browser"};
    const native=createNotionDriveAssetSource({scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},
      contentDataSourceId:"30000000-0000-4000-8000-000000000001",collaborationDataSourceId:"30000000-0000-4000-8000-000000000002",
      notionToken:async()=>"synthetic-private-token"}, {fetch:async()=>new Response("synthetic private provider body",{status})});
    const configs=[{registry:"content" as const,binding:api,ownerRef:"owner:source-operator",maxAgeSeconds:60,documentationCheckedAt:iso(epoch)}];
    const s=setup([...createNotionRegistryHealthTargets(scope,configs,native.listRegistryPage,native.readNotionWorkspace),target(browser,async()=>observation(browser))]);
    const id=await s.register(api),browserId=await s.register(browser);await s.check(browserId,"verified-browser");
    const result=await s.check(id,"native-failure");
    expect(result.health).toMatchObject({permission,session,state,sourceLastSuccess:null});
    expect(s.ops.ledger.requireReady(browser).allowed).toBe(!denied);
    expect(JSON.stringify(result)).not.toMatch(/private provider body|private-token/);
  });
});
