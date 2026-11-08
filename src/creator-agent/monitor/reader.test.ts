// @vitest-environment node
import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { AgentStore } from "../store.ts";
import { FunnelRepository } from "../funnelStore.ts";
import { loadOperationsSecret } from "../operationsSecret.ts";
import { createOperations } from "../operations.ts";
import { digest } from "../config.ts";
import { evt, fixtureRef } from "../funnelFixtures.testkit.ts";
import type { FunnelEvent } from "../funnelContract.ts";
import { createMonitorReader } from "./reader.ts";
import { nativeContentSchema,nativePostSchema,nativeWatchlistSchema,nativeRunSchema,monitorSnapshotSchema } from "./contract.ts";
import { addMonitorReviewEvidence,intakeFixture,monitorFixture,monitorScope as scope,monitorTime } from "./fixtures.testkit.ts";
let now=monitorTime,store:AgentStore,ops:ReturnType<typeof createOperations>,funnel:FunnelRepository,secret:string,snapshot=monitorFixture(),members=intakeFixture();
const proofs=new Map<string,string>();
beforeEach(()=>{now=monitorTime;snapshot=monitorFixture();members=intakeFixture();proofs.clear();store=new AgentStore(":memory:",scope);
  ops=createOperations(store.database,scope);secret=loadOperationsSecret(store.database,scope);
  funnel=new FunnelRepository(store.database,scope,{resolve:async(_scope,_envelope,ref)=>proofs.has(ref)?{...scope,eventHash:proofs.get(ref)!}:null},()=>new Date(now));});
afterEach(()=>{ops.close();store.close();});
const open=(connected=true)=>createMonitorReader({db:store.database,scope,secret,funnel,intake:{monitorMembership:()=>members},
  ...(connected?{source:async()=>structuredClone(snapshot)}:{}),now:()=>now});
const page={limit:100,cursor:null};
function event(id:string,type:FunnelEvent["eventType"],over:Partial<FunnelEvent>={}):FunnelEvent{
  const ref=(name:string,sourceId:string)=>({...fixtureRef(name,sourceId),accountId:scope.accountId});
  return evt(id,type,"fixture-opportunity",5,{creatorRef:ref("notion","canonical-a"),campaignCohortRef:ref("notion","campaign-a"),
    sourceAccount:ref("instagram","publishing-a"),acquisitionRef:ref("social-cat","recruit-context"),
    occurredAt:new Date(now-3000).toISOString(),observedAt:new Date(now-2000).toISOString(),details:{postId:"EVT_ONLY",blockers:[]},...over});
}
async function ingest(e:FunnelEvent){
  const hash=digest(e);proofs.set(e.evidenceRef.provenanceRef,hash);
  await funnel.ingest({event:e,jobId:"fixture-job",jobVersion:"v1",mode:"observe",actor:{id:"fixture-producer",role:"observer"},accountRef:e.sourceAccount,
    policyVersion:e.policyOfferApprovalVersions.policy,inputHash:hash,idempotencyKey:e.eventId,correlationId:"corr-"+e.eventId,requestedAt:new Date(now).toISOString(),deadline:null,checkpoint:null});
}
describe("source-backed monitoring views",()=>{
  it("keeps zero activity and an inaccessible crosspost visible, preserves shared creative, and never allocates creator sales to a post",async()=>{
    const reader=open(),data=nativeContentSchema.parse((await reader.read("contentMonitor",{},page)).data);
    expect(data.total).toBe(2);expect(data.views).toBeNull();expect(data.orders).toBeNull();
    const first=data.posts.find(p=>p.network==="instagram")!,second=data.posts.find(p=>p.network==="tiktok")!;
    expect(first).toMatchObject({measurement:{views:0,likes:0},attribution:{orders:0,level:"post"}});
    expect(second).toMatchObject({measurement:null,visibility:"inaccessible",access:"loginRequired",attribution:{level:"creator",gmv:{minorUnits:7000}}});
    expect(first.creative).toBe(second.creative);expect(first.id).not.toBe(second.id);
    const post=nativePostSchema.parse((await reader.read("postPerformance",{postId:second.id},page)).data);
    expect(post.post.attribution?.net?.minorUnits).toBe(5040);
    expect(await reader.read("postPerformance",{postId:"invented"},page)).toMatchObject({data:null});
    const filtered=nativeContentSchema.parse((await reader.read("contentMonitor",{network:"instagram"},page)).data);
    expect(filtered).toMatchObject({views:0,rate:null,orders:0,net:{minorUnits:0,currency:"USD"}});
  });
  it("quarantines duplicate owners and unmatched registry identities, enforces suppression before showing enrollment",async()=>{
    const reader=open();
    const first=nativeWatchlistSchema.parse((await reader.read("watchlist",{},page)).data);
    expect(first).toMatchObject({active:1,excluded:1,total:2});
    members.records.push({...structuredClone(members.records[0]!),creatorId:"ambiguous-creator"});members.total++;
    snapshot.members.push({...snapshot.members[0]!,creatorId:"not-in-intake",profileId:"new-source-profile"});
    const changed=nativeWatchlistSchema.parse((await reader.read("watchlist",{},page)).data);
    expect(changed).toMatchObject({active:0,pending:2,excluded:1,total:3});
    expect(changed.profiles.filter(p=>p.state==="identity-review")).toHaveLength(2);
  });
  it("binds opaque continuations to fresh scope, filters, permission, source facts and intake without silently replacing a snapshot",async()=>{
    const reader=open(),first=await reader.read("contentMonitor",{}, {...page,limit:1,authorizationContext:"reader"});
    expect(first).toMatchObject({total:2,returned:1,partial:true,hasMore:true});
    const cursor=first.nextCursor!,next={cursor,limit:1,authorizationContext:"reader"};
    now+=10_000;snapshot.observedAt=new Date(now).toISOString();snapshot.validUntil=new Date(now+3600_000).toISOString();
    const second=await reader.read("contentMonitor",{},next);
    expect(second).toMatchObject({returned:1,partial:true,hasMore:false,nextCursor:null});
    expect(nativeContentSchema.parse(second.data).posts[0]!.id).not.toBe(nativeContentSchema.parse(first.data).posts[0]!.id);
    await expect(reader.read("contentMonitor",{network:"instagram"},next)).rejects.toThrow("INVALID_MONITOR_CURSOR");
    await expect(reader.read("contentMonitor",{}, {...next,authorizationContext:"reviewer"})).rejects.toThrow("INVALID_MONITOR_CURSOR");
    snapshot.posts[0]!.access="denied"; await expect(reader.read("contentMonitor",{},next)).rejects.toThrow("MONITOR_SNAPSHOT_CHANGED");
    now+=15*60_000;await expect(reader.read("contentMonitor",{},next)).rejects.toThrow("MONITOR_CURSOR_EXPIRED");
  });
  it("separates the finite run's no-change and failed checks, never turns a failed source check into deletion or a retry grant",async()=>{
    const reader=open(),content=nativeContentSchema.parse((await reader.read("contentMonitor",{},page)).data);
    const result=await reader.read("hourlyRun",{runId:content.latestRunRef},page),run=nativeRunSchema.parse(result.data);
    expect(run).toMatchObject({counts:{unchanged:1,failed:1,changed:0},schedule:"disabled",nextRun:null});
    expect(run.checks[1]).toMatchObject({state:"failed",access:"loginRequired",lastSuccessAt:expect.any(String),checkpoint:expect.any(String)});
    expect(result.capabilities[0]?.state).toBe("held");
    snapshot.runs[0]!.checks.push(snapshot.runs[0]!.checks[0]!);expect(monitorSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
  it("serves verified saved campaign publications without J08, excludes acquisition proxies, and keeps totals unknown",async()=>{
    await ingest(event("published-native","published"));
    await ingest(event("current-metrics","postMetrics",{details:{postId:"EVT_ONLY",views:0,engagements:null,blockers:[]}}));
    await ingest(event("unverified-network","published",{sourceAccount:{...fixtureRef("social-cat","recruit-account"),accountId:scope.accountId},
      details:{postId:"DO_NOT_INCLUDE",blockers:[]}}));
    const result=await open(false).read("contentMonitor",{},page),data=nativeContentSchema.parse(result.data);
    expect(result.partial).toBe(true);expect(data).toMatchObject({sourceState:"unconfigured",total:1,views:null,posts:[{measurement:{views:0,semantics:"unknown"}}]});
    expect(data.posts[0]!.id).not.toContain("EVT_ONLY");
  });
  it("denies foreign scopes, rejects impossible source times, and expires enrollment even when receipts remain on file",async()=>{
    snapshot.scope.accountId="other";await expect(open().read("watchlist",{},page)).rejects.toThrow("SOURCE_SCOPE_DENIED");
    snapshot=monitorFixture();snapshot.observedAt=new Date(now+1).toISOString();await expect(open().read("contentMonitor",{},page)).rejects.toThrow("MONITOR_SOURCE_INVALID");
    snapshot=monitorFixture();now+=3600_000;const result=await open().read("watchlist",{},page);
    expect(result.stale).toBe(true);expect(nativeWatchlistSchema.parse(result.data)).toMatchObject({sourceState:"expired",active:0});
  });
  it("aggregates matching J18 order receipts, retains refunds, and holds mismatched window or multi-post attribution",async()=>{
    const first=snapshot.posts[0]!;
    first.attribution!.orders=1;first.attribution!.net!.minorUnits=1000;
    snapshot.posts[1]={...structuredClone(first),postId:"EXAMPLE_B",originalUrl:"https://www.instagram.com/reel/EXAMPLE_B/",publicationReceipt:"publication-b"};
    const order=(name:string,post:string,amount:number,opportunity:string)=>event(name,amount?"retainedOrder":"refund",{
      opportunityId:opportunity,sourceAccount:{...fixtureRef("shopify-collabs","checkout-account"),accountId:scope.accountId},
      details:{orderId:"order-"+opportunity,postId:post,retainedMinor:amount,currency:"USD",attributionVersion:"attr-v1",
        attributionWindow:"observed checkout window",blockers:[]}});
    await ingest(order("order-first","EXAMPLE_A",1000,"one"));
    await ingest(order("order-second","EXAMPLE_B",1000,"two"));
    const reader=open(),read=async()=>nativeContentSchema.parse((await reader.read("contentMonitor",{},page)).data);
    expect(await read()).toMatchObject({orders:2,net:{minorUnits:2000,currency:"USD"}});
    now+=5000;snapshot.observedAt=new Date(now).toISOString();
    first.attribution!.net!.minorUnits=0;
    await ingest(order("refund-first","EXAMPLE_A",0,"one"));
    expect(funnel.read().outcomes.filter(m=>m.name.startsWith("Attributed")).map(m=>[m.name,m.value])).toEqual([
      ["Attributed orders",2],["Attributed net sales",1000]]);
    expect(await read()).toMatchObject({orders:2,net:{minorUnits:1000,currency:"USD"}});
    snapshot.posts[1]!.attribution!.window="Different attribution period";
    expect(await read()).toMatchObject({orders:null,net:null});
    snapshot.posts[1]!.attribution!.window="observed checkout window";
    now+=5000;await ingest(order("ambiguous-order","EXAMPLE_A",1000,"two"));
    expect(await read()).toMatchObject({orders:null,net:null});
  });
  it("expires the monitor at the server's 90-minute ceiling despite an extended source lease",async()=>{
    snapshot.validUntil=new Date(now+24*3600_000).toISOString();
    const cutoff=Date.parse(snapshot.observedAt)+90*60_000,reader=open();
    now=cutoff-1;
    expect(nativeWatchlistSchema.parse((await reader.read("watchlist",{},page)).data)).toMatchObject({sourceState:"current",active:1});
    now=cutoff;
    const expired=await reader.read("watchlist",{},page);
    expect(expired).toMatchObject({stale:true,partial:true});
    expect(nativeWatchlistSchema.parse(expired.data)).toMatchObject({sourceState:"expired",active:0});
    const content=nativeContentSchema.parse((await reader.read("contentMonitor",{network:"instagram"},page)).data);
    expect(content).toMatchObject({sourceState:"expired",total:1,views:null,orders:null});
    expect(content.posts[0]!.measurement?.views).toBe(0); // Historical facts remain visible, never current totals.
  });
  it("bounds continuation expiry to the original observation even when the next read renews the lease",async()=>{
    snapshot.validUntil=new Date(now+24*3600_000).toISOString();
    const cutoff=Date.parse(snapshot.observedAt)+90*60_000,reader=open();
    now=cutoff-1000;
    const first=await reader.read("contentMonitor",{}, {limit:1,cursor:null});
    expect(first.hasMore).toBe(true);
    now=cutoff;snapshot.observedAt=new Date(now).toISOString();
    await expect(reader.read("contentMonitor",{}, {limit:1,cursor:first.nextCursor})).rejects.toThrow("MONITOR_CURSOR_EXPIRED");
  });
  it("checks the maximum observation age after a slow source read",async()=>{
    snapshot.validUntil=new Date(now+24*3600_000).toISOString();
    const cutoff=Date.parse(snapshot.observedAt)+90*60_000;
    now=cutoff-1;
    const reader=createMonitorReader({db:store.database,scope,secret,funnel,intake:{monitorMembership:()=>members},now:()=>now,
      source:async()=>{now=cutoff;return structuredClone(snapshot);}});
    const result=await reader.read("watchlist",{},page);
    expect(result.stale).toBe(true);
    expect(nativeWatchlistSchema.parse(result.data)).toMatchObject({sourceState:"expired",active:0});
  });
  it("shows first-observed removals without inventing an earlier publication date, and new source facts invalidate a continuation",async()=>{
    await ingest(event("first-seen-removed","removed",{occurredAt:null,details:{postId:"REMOVED_FIRST",blockers:[]}}));
    const reader=open(false),result=nativeContentSchema.parse((await reader.read("contentMonitor",{},page)).data);
    expect(result.posts[0]).toMatchObject({visibility:"deleted",publishedAt:null,measurement:null});
    const detail=nativePostSchema.parse((await reader.read("postPerformance",{postId:result.posts[0]!.id},page)).data);
    expect(detail.publicationHistory.map(h=>h.state)).toEqual(["deleted"]);
  });
  it("anchors an initial snapshot after awaited source verification and never extends an existing cursor lease",async()=>{
    const reader=createMonitorReader({db:store.database,scope,secret,funnel,intake:{monitorMembership:()=>members},now:()=>now,source:async()=>{
      now+=100;snapshot.observedAt=new Date(now).toISOString();return structuredClone(snapshot);
    }});
    const first=await reader.read("contentMonitor",{}, {limit:1,cursor:null});
    expect(Date.parse(nativeContentSchema.parse(first.data).observedAt)).toBe(now);
    now+=15*60_000;
    await expect(reader.read("contentMonitor",{}, {limit:1,cursor:first.nextCursor})).rejects.toThrow("MONITOR_CURSOR_EXPIRED");
  });
  it("quarantines conflicting counters at the same instant even when timestamp offsets differ",async()=>{
    const post=snapshot.posts[0]!,first=post.measurements[0]!;
    post.measurements.push({...first,at:first.at.replace("09:59:00.000Z","01:59:00.000-08:00"),receipt:"second-same-instant",views:100});
    expect(Date.parse(post.measurements[1]!.at)).toBe(Date.parse(first.at));
    const data=nativeContentSchema.parse((await open().read("contentMonitor",{network:"instagram"},page)).data);
    expect(data).toMatchObject({views:null,orders:null,posts:[{measurement:null,conflict:true}]});
  });
  it("does not report a rounded signed net-sales sum as an exact safe amount",async()=>{
    const first=snapshot.posts[0]!, amounts=[Number.MAX_SAFE_INTEGER,2,-Number.MAX_SAFE_INTEGER,-2];
    snapshot.posts=amounts.map((amount,i)=>({...structuredClone(first),postId:"BOUNDARY_"+i,originalUrl:null,
      attribution:{...first.attribution!,orders:0,net:{minorUnits:amount,currency:"USD"}}}));
    const data=nativeContentSchema.parse((await open().read("contentMonitor",{},page)).data);
    // Exact zero is independently complete. Floating-point intermediate overflow produced -1 and incorrectly held it.
    expect(data).toMatchObject({orders:0,net:{minorUnits:0,currency:"USD"}});
  });
  it("keeps partial coverage, empty observations and mixed currency distinct from a verified zero",async()=>{
    snapshot.posts=[snapshot.posts[0]!];snapshot.coverage="partial";
    const partial=await open().read("contentMonitor",{},page);
    expect(partial.partial).toBe(true);
    expect(nativeContentSchema.parse(partial.data)).toMatchObject({sourceState:"partial",views:null,orders:null});
    snapshot.coverage="complete";snapshot.posts=[];
    expect(nativeContentSchema.parse((await open().read("contentMonitor",{},page)).data)).toMatchObject({total:0,views:null,orders:null});
    snapshot=monitorFixture();snapshot.posts[1]={...structuredClone(snapshot.posts[0]!),postId:"SECOND",originalUrl:null};
    snapshot.posts[1]!.attribution!.net!.currency="EUR";
    expect(nativeContentSchema.parse((await open().read("contentMonitor",{},page)).data)).toMatchObject({views:0,orders:null,net:null});
  });
  it("retains exact interval basis and holds mixed cumulative/interval totals",async()=>{
    snapshot.posts=[snapshot.posts[0]!];
    Object.assign(snapshot.posts[0]!.measurements[0]!,{views:100,semantics:"interval",definition:"Native views during selected window",window:"2026-11-05T09:59Z to 2026-11-06T09:59Z"});
    const reader=open(),data=nativeContentSchema.parse((await reader.read("contentMonitor",{},page)).data);
    expect(data).toMatchObject({views:100,metricBasis:{semantics:"interval",definition:"Native views during selected window",window:"2026-11-05T09:59Z to 2026-11-06T09:59Z",context:"organic"}});
    const second=structuredClone(snapshot.posts[0]!);second.postId="OTHER_BASIS";second.originalUrl=null;second.measurements[0]!.semantics="cumulative";
    snapshot.posts.push(second);
    expect(nativeContentSchema.parse((await reader.read("contentMonitor",{},page)).data)).toMatchObject({views:null,rate:null,metricBasis:null});
  });
});

describe("bounded native monitor control evidence",()=>{
  it("projects exact history, competing identity and message/status context without raw identifiers",async()=>{
    addMonitorReviewEvidence(snapshot);
    const reader=open(),w=nativeWatchlistSchema.parse((await reader.read("watchlist",{},page)).data),r=w.profiles.find(p=>p.network==="instagram")!;
    expect(r.state).toBe("identity-review");expect(w.active).toBe(0);
    expect(r.review).toMatchObject({state:"current",historyComplete:true,history:[{decision:"quarantined",at:snapshot.reviewEvidence![0]!.history[0]!.at,identityEvidence:[expect.stringMatching(/^identity-evidence-/)],decisionReceipt:expect.stringMatching(/^receipt-/)}]});
    expect(r.review?.candidates).toHaveLength(2);
    expect(r.messages).toHaveLength(1);expect(r.messages?.[0]).toMatchObject({network:"instagram",account:expect.stringMatching(/^account-/),detail:{state:"current",currentStatus:"draft",proposedStatus:"ready",expectedVersion:expect.stringMatching(/^version-/)}});
    const run=nativeRunSchema.parse((await reader.read("hourlyRun",{runId:w.latestRunRef},page)).data);
    expect(run.observations[0]).toEqual(r.messages![0]);
    for(const raw of ["synthetic-conversation","synthetic-message-event","synthetic-original-profile-proof","synthetic-competing-creator","publishing-a"])
      expect(JSON.stringify(w)).not.toContain(raw);
  });
  it("keeps optional evidence backward compatible and does not invent intake history",async()=>{
    const w=nativeWatchlistSchema.parse((await open().read("watchlist",{},page)).data);
    expect(w.profiles[0]?.review).toMatchObject({state:"unavailable",history:[]});
  });
  it.each(["creatorId","revision","profileId"] as const)("rejects foreign %s review joins",async key=>{
    addMonitorReviewEvidence(snapshot);const r=snapshot.reviewEvidence![0]!;
    if(key==="revision")r.revision++;else r[key]="foreign-identity";
    expect(monitorSnapshotSchema.safeParse(snapshot).success).toBe(false);
    await expect(open().read("watchlist",{},page)).rejects.toThrow("MONITOR_SOURCE_INVALID");
  });
  it("rejects duplicate evidence, foreign candidate context and future event/history evidence",()=>{
    addMonitorReviewEvidence(snapshot);snapshot.reviewEvidence!.push(structuredClone(snapshot.reviewEvidence![0]!));expect(monitorSnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.reviewEvidence!.pop();snapshot.reviewEvidence![0]!.candidates[0]!.account="foreign-account";expect(monitorSnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.reviewEvidence![0]!.candidates[0]!.account="publishing-a";
    snapshot.reviewEvidence![0]!.history[0]!.at=new Date(now+1).toISOString();expect(monitorSnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot=addMonitorReviewEvidence(monitorFixture());snapshot.runs[0]!.inbox[0]!.context!.observedAt=new Date(now+1).toISOString();expect(monitorSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
  it("withholds denied and independently expired evidence even when the outer snapshot is fresh",async()=>{
    addMonitorReviewEvidence(snapshot);snapshot.reviewEvidence![0]!.access="denied";snapshot.runs[0]!.inbox[0]!.context!.access="denied";
    let w=nativeWatchlistSchema.parse((await open().read("watchlist",{},page)).data),r=w.profiles.find(p=>p.network==="instagram")!;
    expect(r.review).toMatchObject({state:"denied",history:[],candidates:[],receipt:null});expect(r.messages![0]!.detail).toMatchObject({state:"denied",conversationId:null,currentStatus:null});
    snapshot.reviewEvidence![0]!.access="authorized";snapshot.runs[0]!.inbox[0]!.context!.access="authorized";
    now+=91*60_000;snapshot.observedAt=new Date(now).toISOString();snapshot.validUntil=new Date(now+3600_000).toISOString();
    w=nativeWatchlistSchema.parse((await open().read("watchlist",{},page)).data);r=w.profiles.find(p=>p.network==="instagram")!;
    expect(w.sourceState).toBe("current");expect(r.review).toMatchObject({state:"expired",history:[]});expect(r.messages![0]!.detail).toMatchObject({state:"expired",messageId:null});
  });
  it("quarantines conflicting canonical owners without selecting another creator's history",async()=>{
    addMonitorReviewEvidence(snapshot);members.records.push({...structuredClone(members.records[0]!),creatorId:"competing-owner"});members.total++;
    const w=nativeWatchlistSchema.parse((await open().read("watchlist",{},page)).data),r=w.profiles.find(p=>p.network==="instagram")!;
    expect(r).toMatchObject({state:"identity-review",review:{state:"quarantined",history:[],candidates:[]},messages:[]});
  });
  it("deduplicates repeated exact source events across runs and invalidates cursors on review changes",async()=>{
    addMonitorReviewEvidence(snapshot);snapshot.runs.push({...structuredClone(snapshot.runs[0]!),id:"another-run"});
    const reader=open(),w=nativeWatchlistSchema.parse((await reader.read("watchlist",{},page)).data);
    expect(w.profiles.find(p=>p.network==="instagram")!.messages).toHaveLength(1);
    const first=await reader.read("watchlist",{}, {limit:1,cursor:null});snapshot.reviewEvidence![0]!.historyComplete=false;
    await expect(reader.read("watchlist",{}, {limit:1,cursor:first.nextCursor})).rejects.toThrow("MONITOR_SNAPSHOT_CHANGED");
  });
});

it("counts the destination review set independently of current monitoring-state filter",async()=>{
  addMonitorReviewEvidence(snapshot);
  const data=nativeWatchlistSchema.parse((await open().read("watchlist",{state:"active"},page)).data);
  expect(data).toMatchObject({total:0,pending:0,pendingReviewTotal:1});
});
it("rejects conflicting repeated message facts rather than selecting an arbitrary run",()=>{
  addMonitorReviewEvidence(snapshot);snapshot.runs.push({...structuredClone(snapshot.runs[0]!),id:"conflicting-run"});
  snapshot.runs[1]!.inbox[0]!.context!.proposedStatus="closed";
  expect(monitorSnapshotSchema.safeParse(snapshot).success).toBe(false);
});
it("preserves dated exclusion reason and owner receipts without treating last check as the decision time",async()=>{
  addMonitorReviewEvidence(snapshot);members.records[0]!.suppressed=true;
  const at=new Date(now-3600_000).toISOString();snapshot.reviewEvidence![0]!.exclusion={at,reasonCode:"suppressed",owner:"private-source-owner",receipt:"private-exclusion-receipt"};
  const data=nativeWatchlistSchema.parse((await open().read("watchlist",{},page)).data),r=data.profiles.find(p=>p.network==="instagram")!;
  expect(r).toMatchObject({state:"excluded",review:{exclusion:{at,reasonCode:"suppressed",owner:expect.stringMatching(/^owner-/),receipt:expect.stringMatching(/^receipt-/)}}});
  expect(r.lastCheck).not.toBe(at);expect(JSON.stringify(r)).not.toContain("private-source-owner");
});

it.each(["denied","expired"] as const)("does not resolve a known ambiguous identity when its evidence becomes %s",async state=>{
  addMonitorReviewEvidence(snapshot);
  if(state==="denied")snapshot.reviewEvidence![0]!.access="denied";
  else {now+=91*60_000;snapshot.observedAt=new Date(now).toISOString();snapshot.validUntil=new Date(now+3600_000).toISOString();}
  const w=nativeWatchlistSchema.parse((await open().read("watchlist",{},page)).data),r=w.profiles.find(p=>p.network==="instagram")!;
  expect(w).toMatchObject({sourceState:"current",active:0,pendingReviewTotal:1});
  expect(r).toMatchObject({state:"identity-review",review:{state,candidates:[],history:[],receipt:null}});
});
