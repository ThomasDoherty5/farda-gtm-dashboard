import type { FunnelEvent } from "../funnelContract.ts";
import { projectFunnel } from "../funnelProjection.ts";
import { nativePost } from "../creatorPlatformReader.ts";
import { sealCollaborationRef } from "../creatorPlatformReferences.ts";
import type { OperationsScope } from "../operations.ts";
import { originalPostUrl,type MonitorSnapshot,type NativePost } from "./contract.ts";

export type Alias=(kind:string,value:string)=>string;
type Post=NativePost["post"];
type Measurement=NativePost["history"][number];
type Visibility=NativePost["publicationHistory"][number];
type Projected={post:Post;history:Measurement[];publicationHistory:Visibility[]};
export type MonitorPublication=Projected;
const nativeKey=(network:string,account:string,postId:string)=>JSON.stringify([network,account,postId]);
const sourceId=(ref:FunnelEvent["sourceAccount"]|null)=>ref?.canonicalId ?? ref?.sourceId ?? null;
export function effectiveEvents(events:FunnelEvent[]) {
  const corrected=new Set(events.map(e=>e.correctsEventId).filter(Boolean));
  return events.filter(e=>!corrected.has(e.eventId));
}
function selectMeasurement(history:Measurement[]) {
  const latest=history.at(-1);if(!latest)return {measurement:null,conflict:false};
  const fact=(m:Measurement)=>JSON.stringify([m.definition,m.window,m.semantics,m.context,m.views,m.likes,m.comments,m.shares,m.saves,m.reach]);
  const conflict=history.some(m=>Date.parse(m.at)===Date.parse(latest.at) && fact(m)!==fact(latest));
  return {measurement:conflict ? null : latest,conflict};
}
/** Membership requires a recorded Farda publication, never a like threshold or a creator-name match. */
export function projectPosts(events:FunnelEvent[],snapshot:MonitorSnapshot|null,alias:Alias,scope:OperationsScope,secret:string):Map<string,Projected>{
  const posts=new Map<string,Projected>();
  const sourcePosts=new Map((snapshot?.posts??[]).map(p=>[nativeKey(p.network,p.account,p.postId),p]));
  const native=events.filter(e=>nativePost(e) && e.details.postId && sourceId(e.sourceAccount) &&
    (e.network==="instagram" || e.network==="tiktok"));
  for(const event of native.filter(e=>e.eventType==="published" || e.eventType==="removed").sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt))){
    const account=event.sourceAccount.sourceId ?? event.sourceAccount.canonicalId!;
    const key=nativeKey(event.network,account,event.details.postId!);
    const campaign=sourceId(event.campaignCohortRef),creator=sourceId(event.creatorRef);
    if(!campaign || !creator || event.campaignCohortRef.identityState!=="resolved" || event.creatorRef.identityState!=="resolved")continue;
    const existing=posts.get(key);
    if(existing){
      if(existing.post.campaign!==alias("campaign",campaign) || existing.post.creator!==alias("creator",creator))existing.post.conflict=true;
      continue;
    }
    const source=event.acquisitionRef?.source, collaboration=sourceId(event.collaborationRef);
    const network=event.network as "instagram"|"tiktok";
    const post:Post={id:alias("post",key),originalUrl:event.evidenceRef.url?originalPostUrl(network,event.details.postId!,event.evidenceRef.url):null,
      network,account:alias("account",account),creator:alias("creator",creator),campaign:alias("campaign",campaign),campaignReceipt:alias("receipt",event.campaignCohortRef.provenanceRef),
      collaborationRef:collaboration?sealCollaborationRef(scope,secret,collaboration):null,
      creative:event.details.creativeId?alias("creative",event.details.creativeId):null,deliverable:event.details.deliverableId?alias("deliverable",event.details.deliverableId):null,
      enrollmentSource:source==="social-cat"?"social-cat":source==="tiktok-shop"?"tiktok-affiliate":"unknown",publishedAt:event.eventType==="published"?event.occurredAt:null,
      publicationReceipt:alias("receipt",event.evidenceRef.provenanceRef),visibility:event.eventType==="published"?"public":"deleted",visibilityAt:event.observedAt,
      visibilityReceipt:alias("receipt",event.evidenceRef.provenanceRef),access:"unknown",checkpointHours:null,measurement:null,attribution:null,conflict:false};
    posts.set(key,{post,history:[],publicationHistory:[]});
  }
  for(const [key,p] of sourcePosts){
    const existing=posts.get(key);
    const post:Post={id:alias("post",key),network:p.network,account:alias("account",p.account),creator:alias("creator",p.creatorId),
      campaign:alias("campaign",p.campaign),campaignReceipt:alias("receipt",p.campaignReceipt),collaborationRef:p.collaborationId?sealCollaborationRef(scope,secret,p.collaborationId):null,
      creative:p.creativeId?alias("creative",p.creativeId):null,deliverable:p.deliverableId?alias("deliverable",p.deliverableId):null,
      enrollmentSource:p.enrollmentSource,publishedAt:p.publishedAt,publicationReceipt:alias("receipt",p.publicationReceipt),
      originalUrl:p.originalUrl?originalPostUrl(p.network,p.postId,p.originalUrl):null,visibility:p.visibility,visibilityAt:p.visibilityAt,
      visibilityReceipt:p.visibilityReceipt?alias("receipt",p.visibilityReceipt):null,access:p.access,checkpointHours:p.checkpointHours,
      measurement:null,attribution:p.attribution?{...p.attribution,receipt:alias("receipt",p.attribution.receipt),version:alias("terms",p.attribution.version)}:null,
      conflict:!!existing && (existing.post.conflict || existing.post.creator!==alias("creator",p.creatorId) || existing.post.campaign!==alias("campaign",p.campaign))};
    const history=p.measurements.map(m=>({...m,receipt:alias("receipt",m.receipt)}));
    const publicationHistory:Visibility[]=[...(p.publishedAt?[{state:"public" as const,at:p.publishedAt,receipt:post.publicationReceipt}]:[]),
      ...(p.publicationHistory??[]).map(h=>({...h,receipt:alias("receipt",h.receipt)}))];
    if(p.visibilityAt && post.visibilityReceipt)publicationHistory.push({state:p.visibility,at:p.visibilityAt,receipt:post.visibilityReceipt});
    posts.set(key,{post,history,publicationHistory});
  }
  for(const e of native){
    const account=e.sourceAccount.sourceId ?? e.sourceAccount.canonicalId!;
    const item=posts.get(nativeKey(e.network,account,e.details.postId!)); if(!item)continue;
    const receipt=alias("receipt",e.evidenceRef.provenanceRef);
    const creator=sourceId(e.creatorRef),campaign=sourceId(e.campaignCohortRef);
    if(!creator || !campaign || item.post.creator!==alias("creator",creator) || item.post.campaign!==alias("campaign",campaign)){
      item.post.conflict=true;continue;
    }
    if(e.eventType==="published" || e.eventType==="removed"){
      const state=e.eventType==="removed"?"deleted":"public";
      item.publicationHistory.push({state,at:e.observedAt,receipt});
      if(!item.post.visibilityAt || Date.parse(e.observedAt)>Date.parse(item.post.visibilityAt)){
        item.post.visibility=state;item.post.visibilityAt=e.observedAt;item.post.visibilityReceipt=receipt;
      } else if(Date.parse(e.observedAt)===Date.parse(item.post.visibilityAt) && state!==item.post.visibility)item.post.conflict=true;
    }
    // The generic event contains no component breakdown; a reported total cannot be relabeled as likes or shares.
    if(e.eventType==="postMetrics" && e.evidenceRef.window && !item.history.some(m=>m.receipt===receipt)){
      item.history.push({at:e.observedAt,receipt,definition:e.evidenceRef.definition,window:e.evidenceRef.window,context:"unknown",
        semantics:"unknown",views:e.details.views ?? null,likes:null,comments:null,shares:null,saves:null,reach:null});
    }
  }
  for(const value of posts.values()){
    value.history.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at) || a.receipt.localeCompare(b.receipt));
    value.publicationHistory.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at) || a.receipt.localeCompare(b.receipt));
    value.publicationHistory=value.publicationHistory.filter((entry,i,list)=>list.findIndex(x=>x.state===entry.state && x.at===entry.at && x.receipt===entry.receipt)===i);
    const result=selectMeasurement(value.history);
    value.post.conflict ||= result.conflict;
    value.post.measurement=value.post.conflict ? null : result.measurement;
    if(value.post.conflict){value.post.attribution=null;value.post.originalUrl=null;value.post.visibility="unverified";}
  }
  return posts;
}

function safeSum(values:(number|null)[]):number|null {
  if(!values.length || values.some(n=>n===null))return null;
  const sum=values.reduce<bigint>((total,n)=>total+BigInt(n!),0n);
  return sum<=BigInt(Number.MAX_SAFE_INTEGER) && sum>=BigInt(Number.MIN_SAFE_INTEGER)?Number(sum):null;
}
function reconciledSales(posts:Post[],events:FunnelEvent[],asOf:string,alias:Alias,publications:ReadonlyMap<string,Projected>){
  const unknown={orders:null,net:null};
  const claims=posts.map(p=>p.attribution);
  if(!claims.every(c=>c?.complete && c.level==="post" && c.orders!==null && c.net &&
    c.window===claims[0]?.window && c.version===claims[0]?.version && c.net.currency===claims[0]?.net?.currency))return unknown;
  const orderTotal=safeSum(claims.map(c=>c?.orders??null)),netTotal=safeSum(claims.map(c=>c?.net?.minorUnits??null));
  const currency=claims[0]!.net!.currency;
  if(orderTotal===null || netTotal===null)return unknown;
  const cohorts=new Set(posts.map(p=>JSON.stringify([p.creator,p.campaign])));
  const financial=events.filter(e=>(e.eventType==="retainedOrder" || e.eventType==="refund") &&
    cohorts.has(JSON.stringify([alias("creator",sourceId(e.creatorRef)??""),alias("campaign",sourceId(e.campaignCohortRef)??"")])));
  if(!financial.length)return posts.length===1 || orderTotal===0&&netTotal===0?{orders:orderTotal,net:{minorUnits:netTotal,currency}}:unknown;
  const selected=new Set(posts.map(p=>p.id));
  const postIndex=new Map<string,Projected[]>();
  for(const [key,item] of publications){
    const [network,,nativeId]=JSON.parse(key) as string[];
    const identity=JSON.stringify([network,nativeId,item.post.creator,item.post.campaign]);
    postIndex.set(identity,[...(postIndex.get(identity)??[]),item]);
  }
  const linked:FunnelEvent[]=[];
  // An order receipt with no post assignment stays creator/campaign-wide. Never divide it across posts.
  const assigned=new Map<string,Set<string>>();
  for(const e of financial){
    if(!e.details.postId || !e.details.orderId || e.evidenceRef.access!=="verified" || !e.maturationAt || Date.parse(e.maturationAt)>Date.parse(asOf) ||
      e.details.attributionWindow!==claims[0]!.window || alias("terms",e.details.attributionVersion??"")!==claims[0]!.version ||
      e.details.currency!==currency || e.details.retainedMinor==null || e.details.blockers.length)return unknown;
    // A checkout account isn't a publishing account. Match the native post only if one campaign/creator owner exists.
    const matches=postIndex.get(JSON.stringify([e.network,e.details.postId,alias("creator",sourceId(e.creatorRef)??""),
      alias("campaign",sourceId(e.campaignCohortRef)??"")]))??[];
    if(matches.length!==1 || matches[0]!.post.conflict)return unknown;
    const postId=matches[0]!.post.id;
    const keys=assigned.get(e.details.orderId)??new Set<string>();keys.add(postId);assigned.set(e.details.orderId,keys);
    if(keys.size!==1)return unknown;
    if(selected.has(postId))linked.push(e);
  }
  const result=projectFunnel(linked,{},asOf);
  const orders=result.outcomes.find(m=>m.name==="Attributed orders")?.value;
  const net=result.outcomes.find(m=>m.name==="Attributed net sales")?.value;
  return orders===orderTotal && net===netTotal ? {orders,net:{minorUnits:net,currency}}:unknown;
}
export function monitorTotals(posts:Post[],complete:boolean,financial:FunnelEvent[],asOf:string,alias:Alias,publications:ReadonlyMap<string,Projected>){
  if(!complete || !posts.length || posts.some(p=>p.conflict))return {views:null,rate:null,orders:null,net:null,metricBasis:null};
  const measures=posts.map(p=>p.measurement);
  const comparable=measures.every(m=>m && m.semantics!=="unknown" && m.context!=="unknown" &&
    m.definition===measures[0]?.definition && m.window===measures[0]?.window && m.semantics===measures[0]?.semantics && m.context===measures[0]?.context);
  const views=comparable?safeSum(measures.map(m=>m?.views??null)):null;
  const interactions=comparable?safeSum(measures.flatMap(m=>[m?.likes??null,m?.comments??null,m?.shares??null])):null;
  const rate=views!==null && views>0 && interactions!==null ? 100*interactions/views:null;
  const first=measures[0];
  const metricBasis=comparable && first ? {definition:first.definition,window:first.window,semantics:first.semantics,context:first.context}:null;
  return {views,rate,metricBasis,...reconciledSales(posts,financial,asOf,alias,publications)};
}
