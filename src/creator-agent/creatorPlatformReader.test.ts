// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentStore } from "./store.ts";
import { FunnelRepository } from "./funnelStore.ts";
import { platformEnvelope, platformEvent as event } from "./creatorPlatformFixtures.testkit.ts";
import { digest } from "./config.ts";
import { jan } from "./funnelFixtures.testkit.ts";
import { openCollaborationRef, sealCollaborationRef } from "./creatorPlatformReferences.ts";
import { readCreatorPlatformView } from "./creatorPlatformReader.ts";
import type { CreatorPlatformKey } from "./creatorPlatformViews.ts";
import { funnelEventSchema, type FunnelEvent } from "./funnelContract.ts";

const scope = {workspaceId:"synthetic-workspace",accountId:"synthetic-account",environment:"sandbox" as const};
const secret = "synthetic-private-store-key";
let store: AgentStore;
let funnel: FunnelRepository;
let clock: number;
const proof = new Map<string,string>();
beforeEach(() => {
  clock = Date.parse(jan(25)); proof.clear();
  store=new AgentStore(":memory:",scope);
  funnel=new FunnelRepository(store.database,scope,{resolve:async(_scope,_job,ref)=>proof.has(ref)?{...scope,eventHash:proof.get(ref)!}:null},()=>new Date(clock));
});
afterEach(()=>store.close());
async function ingest(e: FunnelEvent) { proof.set(e.evidenceRef.provenanceRef,digest(e)); await funnel.ingest(platformEnvelope(e)); }
const inputs = (viewKey:CreatorPlatformKey, filters:unknown={}) => ({viewKey,filters,scope,db:store.database,funnel,secret,limit:25,cursor:null,role:"reader" as const,now:()=>clock});
const metric = (data:ReturnType<typeof readCreatorPlatformView>["data"],label:string) => data.metrics.find(item=>item.label===label)!;

it("shows scoped local empty with unknown provider coverage on all four native views",()=>{
  for(const key of ["socialCatBoard","socialCatDashboard","tiktokBoard","tiktokDashboard"] as const) {
    const result=readCreatorPlatformView(inputs(key)); expect(result.data).toMatchObject({viewKey:key,total:0,providerCoverage:"unknown",records:[]});
    expect(result.data.metrics.every(m=>m.value===null)).toBe(true);
  }
});
it("isolates acquisition, publication, checkout and payout; a native match is distinct from accepted terms and saved history",async()=>{
  const a=scope.accountId;
  await ingest(event(a,"private-match","matched","creator-a",{patch:{network:"tiktok",checkout:"website"},details:{owner:"Founder",dueAt:jan(26)}}));
  await ingest(event(a,"private-prod","productionSubmitted","creator-a",{day:7,patch:{network:"tiktok",checkout:"website"},details:{deliverableId:"private-file",payoutOwner:"external-affiliate"}}));
  await ingest(event(a,"private-accepted","terms","other",{acquisition:"tiktok-shop",patch:{checkout:"tiktok-shop"}}));
  const sc=readCreatorPlatformView(inputs("socialCatBoard")).data, tt=readCreatorPlatformView(inputs("tiktokBoard")).data;
  expect(sc.total).toBe(1); expect(tt.total).toBe(1); const row=sc.records[0]!;
  expect(row).toMatchObject({stage:"productionSubmitted",networks:["tiktok"],checkouts:["website"],payouts:["external-affiliate"],owner:"Founder",dueAt:jan(26),terms:"no saved acceptance"});
  expect(row.deliveries[0]?.state).toBe("productionSubmitted"); expect(sc.achievements.find(v=>v.state==="matched")?.count).toBe(1);
  expect(sc.achievements.find(v=>v.state==="terms")?.count).toBe(0);
  expect(tt.records[0]!.terms).toBe("accepted");
  expect(JSON.stringify(sc)).not.toMatch(/private-file|native-private|synthetic-collaboration/);
  expect(openCollaborationRef(scope,secret,row.collaborations[0]!)).toBe("synthetic-collaboration-creator-a");
  expect(()=>openCollaborationRef({...scope,accountId:"another"},secret,row.collaborations[0]!)).toThrow("INVALID_COLLABORATION_REFERENCE");
  expect(()=>openCollaborationRef(scope,secret,sealCollaborationRef(scope,"other", "private-id"))).toThrow();
});
it("keeps Views independent of missing engagements and rejects recruitment-only or mixed native insight windows",async()=>{
  const a=scope.accountId;
  const metrics=event(a,"insight","postMetrics","p",{producer:"instagram",details:{postId:"private-post",views:0,engagements:null}});
  await ingest(metrics);
  let d=readCreatorPlatformView(inputs("socialCatDashboard")).data;
  expect(metric(d,"Views").value).toBe(0); expect(metric(d,"Engagement rate").value).toBeNull(); expect(metric(d,"Attributed orders").value).toBeNull();
  await ingest(event(a,"sc-native","postMetrics","q",{producer:"social-cat",details:{postId:"other-post",views:99,engagements:10}}));
  d=readCreatorPlatformView(inputs("socialCatDashboard")).data;
  expect(metric(d,"Views").value).toBeNull();
});
it("uses full matched membership for metrics, deduplicates a post, keeps known money in minor units and catches disputed cross-platform attribution",async()=>{
  const a=scope.accountId;
  for(const [id,op,day,views] of [["p-a","a",5,30],["p-b","b",6,50]] as const) {
    await ingest(event(a,id,"postMetrics",op,{producer:"instagram",day,details:{postId:"same-post",views,engagements:5}}));
  }
  const order={orderId:"cross-platform-order",currency:"USD",retainedMinor:1250,attributionVersion:"v1",attributionWindow:"30d"};
  await ingest(event(a,"retained","retainedOrder","a",{details:order}));
  const r=readCreatorPlatformView({...inputs("socialCatDashboard"),limit:1});
  expect(r.total).toBe(2); expect(r.data.records).toHaveLength(1);
  expect(metric(r.data,"Views")).toMatchObject({value:50,denominator:1}); expect(metric(r.data,"Engagement rate").value).toBe(10);
  expect(metric(r.data,"Attributed net sales")).toMatchObject({value:1250,unit:"USD minor units"});
  await ingest(event(a,"other-order","retainedOrder","c",{acquisition:"tiktok-shop",details:order}));
  expect(metric(readCreatorPlatformView(inputs("socialCatDashboard")).data,"Attributed net sales").value).toBeNull();
});
it("pins membership across late backfill and correction, refuses foreign filter/role/scope and expired cursors",async()=>{
  for(const op of ["b","c"])await ingest(event(scope.accountId,"event-"+op,"discovered",op));
  const initial = {...inputs("socialCatBoard"),limit:1}, first=readCreatorPlatformView(initial);
  expect(first.nextCursor).toBeTruthy();
  await ingest(event(scope.accountId,"event-a","qualified","a"));
  await ingest(event(scope.accountId,"replacement-c","discovered","c",{day:10,details:{owner:"Founder"},patch:{correctsEventId:"event-c",ingestIdentity:{nativeId:"native:event-c",fingerprint:null,sourceVersion:"2"}}}));
  const next=readCreatorPlatformView({...initial,cursor:first.nextCursor});
  expect(next.data.offset).toBe(1); expect(next.total).toBe(2); expect(next.data.records[0]?.owner).toBeNull(); expect(next.data.records[0]!.id).not.toBe(first.data.records[0]!.id);
  expect(readCreatorPlatformView(initial).total).toBe(3);
  expect(readCreatorPlatformView({...initial,limit:10}).data.records.map(row=>row.owner)).toContain("Founder");
  for(const patch of [{role:"reviewer" as const},{filters:{owner:"Founder"}},{viewKey:"tiktokBoard" as const},{limit:2}])
    expect(()=>readCreatorPlatformView({...initial,...patch,cursor:first.nextCursor})).toThrow("CREATOR_PLATFORM_CURSOR_INVALID");
  expect(()=>readCreatorPlatformView({...initial,scope:{...scope,accountId:"other"},cursor:first.nextCursor})).toThrow("CREATOR_PLATFORM_SCOPE_MISMATCH");
  clock+=15*60_000; expect(()=>readCreatorPlatformView({...initial,cursor:first.nextCursor})).toThrow("CREATOR_PLATFORM_CURSOR_INVALID");
});
it("keeps source loss separate from a known local count and rejects reversed cohort windows",async()=>{
  await ingest(event(scope.accountId,"outage","sourceOutage","x"));
  expect(funnelEventSchema.safeParse({...event(scope.accountId,"x","qualified","q"),observedAt:"2026-01-05T00:00:00+99:99"}).success).toBe(false);
  const result=readCreatorPlatformView(inputs("socialCatBoard")).data;
  expect(result).toMatchObject({total:1,sourceOutages:1,providerCoverage:"unknown"});
  expect(result.records[0]!.blockers).toContain("Source access incomplete");
  expect(()=>readCreatorPlatformView(inputs("socialCatDashboard",{start:"2026-01-20",end:"2026-01-10"}))).toThrow();
});

it("does not choose conflicting equal-time post receipts or present unsafe sums as exact",async()=>{
  const a=scope.accountId;
  for(const [id,op,views] of [["one","a",10],["two","b",15]] as const)
    await ingest(event(a,id,"postMetrics",op,{producer:"instagram",details:{postId:"same-native-post",views,engagements:1}}));
  const disputed=readCreatorPlatformView(inputs("socialCatDashboard")).data;
  expect(metric(disputed,"Views").value).toBeNull();
  expect(disputed.postSamples[0]).toMatchObject({sourceVerified:false,views:null});
  await ingest(event(a,"new-proof","postMetrics","a",{producer:"instagram",day:9,details:{postId:"same-native-post",views:Number.MAX_SAFE_INTEGER,engagements:1}}));
  await ingest(event(a,"other-proof","postMetrics","b",{producer:"instagram",day:9,details:{postId:"other-native-post",views:1,engagements:1}}));
  const totals=readCreatorPlatformView(inputs("socialCatDashboard")).data;
  expect(metric(totals,"Views").value).toBeNull();
  expect(metric(totals,"Engagement rate").value).toBeNull();
});
