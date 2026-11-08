import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { FunnelRepository } from "../funnelStore.ts";
import type { OperationsScope } from "../operations.ts";
import { openOperationsToken,sealOperationsToken } from "../operationsTokens.ts";
import { digest } from "../config.ts";
import { monitorFilters,monitorSnapshotSchema,nativeContentSchema,nativeWatchlistSchema,nativeRunSchema,nativePostSchema,
  type MonitorSnapshot,type MonitorSourceReader,type MonitorViewKey,type NativeWatchlist } from "./contract.ts";
import { effectiveEvents,projectPosts,monitorTotals,type Alias } from "./posts.ts";
export { monitorFilters,monitorViewKeys,type MonitorSourceReader,type MonitorViewKey } from "./contract.ts";

export class MonitorError extends Error {
  readonly code:string;readonly status:number;
  constructor(code:string,status:number){super(code);this.code=code;this.status=status;}
}
type Membership = { total:number; complete:boolean; records:{
  creatorId:string;revision:number;identityState:"resolved"|"needsReview";watchlistEligibility:"active"|"identityPending"|"excluded";suppressed:boolean;
  profiles:{network:"instagram"|"tiktok";accountId:string;sourceId:string|null;handle:string|null}[];
  relationships:{recruitmentSource:string;state:string;campaignKey:string|null}[];
  handoffs:{target:string;key:string;state:string;receiptRef:string|null;revision:number;canonicalReceiptRef:string|null}[];
  sourceStatus:"verified"|"pending"|"unavailable";
}[] };
type Options={db:DatabaseSync;scope:OperationsScope;secret:string;funnel:Pick<FunnelRepository,"snapshot">;
  intake:{monitorMembership(limit?:number):Membership}; source?:MonitorSourceReader;now?:()=>number};
const pageSchema=z.object({version:z.literal(1),context:z.string(),offset:z.number().int().positive().safe(),asOf:z.string().datetime(),
  sourceAsOf:z.string().datetime({offset:true}).nullable(),watermark:z.number().int().nonnegative().safe(),basis:z.string(),expires:z.number().int().nonnegative().safe()}).strict();
const profileKey=(network:string,account:string,profile:string)=>JSON.stringify([network,account,profile]);
// D-13 is a server ceiling; a source cannot extend it by issuing a longer lease.
const monitorMaxAgeMs=90*60_000;
function messageRow(e:MonitorSnapshot["runs"][number]["inbox"][number],source:MonitorSnapshot|null,fresh:boolean,alias:Alias,now:number){
  const c=e.context,state=!fresh || c && Date.parse(c.observedAt)+monitorMaxAgeMs<=now?"expired" as const:source?.coverage!=="complete"?"unavailable" as const:!c?"unavailable" as const:c.access==="authorized"?"current" as const:c.access;
  const visible=state==="current"?c:null;
  return {id:alias("event",JSON.stringify([e.network,e.account,e.id])),network:e.network,account:alias("account",e.account),profile:alias("profile",profileKey(e.network,e.account,e.profileId)),at:e.at,receipt:alias("receipt",e.receipt),kind:e.kind,interpretation:e.interpretation,
    detail:{state,observedAt:visible?.observedAt??null,conversationId:visible?alias("conversation",JSON.stringify([e.network,e.account,visible.conversationId])):null,
      messageId:visible?alias("message",JSON.stringify([e.network,e.account,visible.conversationId,visible.messageId])):null,
      sourceVersion:visible?alias("version",visible.sourceVersion):null,currentStatus:visible?.currentStatus??null,proposedStatus:visible?.proposedStatus??null,
      expectedVersion:visible?.expectedVersion?alias("version",visible.expectedVersion):null}};
}
const unavailableReview=(state:"unavailable"|"quarantined"="unavailable"):NonNullable<NativeWatchlist["profiles"][number]["review"]>=>
  ({state,observedAt:null,receipt:null,historyComplete:false,history:[],candidates:[],exclusion:null});
function profileReview(record:Membership["records"][number],p:Membership["records"][number]["profiles"][number]|null,source:MonitorSnapshot|null,fresh:boolean,unambiguous:boolean,alias:Alias,now:number){
  if(!unambiguous)return unavailableReview("quarantined");
  const evidence=p&&source?.reviewEvidence?.find(r=>r.creatorId===record.creatorId&&r.revision===record.revision&&r.network===p.network&&r.account===p.accountId&&r.profileId===p.sourceId);
  if(!evidence || record.sourceStatus==="unavailable")return unavailableReview();
  const state=!fresh || Date.parse(evidence.observedAt)+monitorMaxAgeMs<=now?"expired" as const:source?.coverage!=="complete"?"unavailable" as const:evidence.access==="authorized"?"current" as const:evidence.access;
  if(state!=="current")return {...unavailableReview(),state};
  return {state,observedAt:evidence.observedAt,receipt:alias("receipt",evidence.receipt),historyComplete:evidence.historyComplete,
    history:evidence.history.map(h=>({...h,id:alias("intake-event",h.id),receipt:alias("receipt",h.receipt),identityEvidence:h.identityEvidence.map(r=>alias("identity-evidence",r)),decisionReceipt:alias("receipt",h.decisionReceipt)})),
    candidates:evidence.candidates.map(c=>({...c,creatorId:alias("creator",c.creatorId),account:alias("account",c.account),profileId:alias("profile",profileKey(c.network,c.account,c.profileId)),receipt:alias("receipt",c.receipt)})),
    exclusion:evidence.exclusion?{...evidence.exclusion,owner:alias("owner",evidence.exclusion.owner),receipt:alias("receipt",evidence.exclusion.receipt)}:null};
}
function watchRows(intake:Membership,source:MonitorSnapshot|null,fresh:boolean,alias:Alias,now:number):NativeWatchlist["profiles"]{
  const owners=new Map<string,Set<string>>(),members=new Map<string,MonitorSnapshot["members"]>(),checks=new Map<string,string>();
  for(const record of intake.records)for(const profile of record.profiles)if(profile.sourceId){
    const id=profileKey(profile.network,profile.accountId,profile.sourceId),set=owners.get(id)??new Set<string>();
    set.add(record.creatorId);owners.set(id,set);
  }
  for(const member of source?.members??[]){
    const id=profileKey(member.network,member.account,member.profileId),rows=members.get(id)??[];
    rows.push(member);members.set(id,rows);
  }
  for(const run of source?.runs??[])for(const c of run.checks)if(c.at){
    const id=profileKey(c.network,c.account,c.profileId),prior=checks.get(id);
    if(!prior || Date.parse(c.at)>Date.parse(prior))checks.set(id,c.at);
  }
  const local = intake.records.flatMap(record=>{
    const confirmed=record.handoffs.filter(h=>h.revision===record.revision && h.state==="confirmed" && h.receiptRef);
    const notion=confirmed.find(h=>h.target==="notion-creator-crm");
    const sheets=confirmed.find(h=>h.target==="sheets-watchlist" && h.canonicalReceiptRef===notion?.receiptRef);
    return (record.profiles.length?record.profiles:[null]).map(p=>{
      const id=p?.sourceId?profileKey(p.network,p.accountId,p.sourceId):null;
      const matches=id?members.get(id)??[]:[],ownerCount=id?owners.get(id)?.size??0:0;
      const m=matches.length===1&&ownerCount===1&&matches[0]!.creatorId===record.creatorId&&matches[0]!.revision===record.revision ? matches[0]! : null;
      const currentHandoffs=record.sourceStatus==="verified" && m && notion && sheets && m.notionReceipt===notion.receiptRef && m.sheetsReceipt===sheets.receiptRef;
      const independent=record.sourceStatus!=="unavailable" && m?.verification && m.verification.sheetsCanonicalReceipt===m.notionReceipt;
      const member=m && (currentHandoffs || independent) ? m:null;
      const hasOpen=record.relationships.some(r=>r.state==="active");
      const review=profileReview(record,p,source,fresh,ownerCount<=1&&matches.length<=1,alias,now);
      // Withholding private evidence is not an identity-resolution event. An exact
      // supplied competing claim keeps the quarantine even after its read lease ends.
      const competingEvidence=source?.reviewEvidence?.some(r=>r.creatorId===record.creatorId&&r.revision===record.revision&&
        r.network===p?.network&&r.account===p.accountId&&r.profileId===p.sourceId&&r.candidates.length>1)??false;
      const state=record.suppressed || record.watchlistEligibility==="excluded" ? "excluded" as const :
        competingEvidence || record.identityState==="needsReview" || !p?.sourceId || ownerCount>1 || matches.length>1 || record.watchlistEligibility==="identityPending" && !independent ? "identity-review" as const :
        member && fresh && intake.complete && source?.coverage==="complete" && hasOpen && (record.watchlistEligibility==="active" || independent) ? "active" as const : "eligibility-unverified" as const;
      const sources=new Set(record.relationships.filter(r=>r.state==="active").map(r=>r.recruitmentSource));
      const sourceName=sources.size===1?[...sources][0]!:null;
      return {creator:alias("creator",record.creatorId),network:p?.network??null,account:p?alias("account",p.accountId):null,
        profile:p?.sourceId?alias("profile",JSON.stringify([p.network,p.accountId,p.sourceId])):null,handle:record.sourceStatus==="unavailable"?null:p?.handle??null,state,
        source:sourceName==="tiktok-shop"?"tiktok-affiliate":sourceName,cohort:member?.cohort??null,
        notionReceipt:member?alias("receipt",member.notionReceipt):notion?.receiptRef?alias("receipt",notion.receiptRef):null,
        sheetsReceipt:member?alias("receipt",member.sheetsReceipt):sheets?.receiptRef?alias("receipt",sheets.receiptRef):null,
        lastCheck:id?checks.get(id)??null:null,
        review,
        messages:ownerCount===1&&matches.length===1&&m&&record.sourceStatus!=="unavailable"?[...new Map([...(source?.runs??[])].sort((a,b)=>a.observedAt.localeCompare(b.observedAt)).flatMap(run=>run.inbox)
          .filter(e=>e.creatorId===record.creatorId&&e.network===p?.network&&e.account===p.accountId&&e.profileId===p.sourceId)
          .map(e=>[JSON.stringify([e.network,e.account,e.id]),e] as const)).values()]
          .sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100).map(e=>messageRow(e,source,fresh,alias,now)):[],
        reason:state==="excluded"?"Suppressed or excluded by intake.":state==="identity-review"?"Reviewed identity is missing or ambiguous.":
          state==="active"?"Current Sheets enrollment matches canonical intake and both handoff receipts.":"Current matching Sheets enrollment has not been verified."};
    });
  });
  const seen=new Set<string>();
  const conflicts=new Set([...owners].filter(([,claims])=>claims.size>1).map(([id])=>alias("profile",id)));
  const output:NativeWatchlist["profiles"]=[];
  for(const row of local){
    if(row.profile && seen.has(row.profile))continue;
    if(row.profile)seen.add(row.profile);
    const ambiguous=row.profile && conflicts.has(row.profile);
    output.push(ambiguous?{...row,creator:alias("identity-review",row.profile!),handle:null,state:"identity-review",cohort:null,
      source:null,notionReceipt:null,sheetsReceipt:null,review:unavailableReview("quarantined"),messages:[],reason:"Multiple intake creators claim this network/account/profile. Identity is quarantined."}:row);
  }
  for(const [id,unmatched] of members){
    const profile=alias("profile",id);
    if(seen.has(profile))continue;
    const member=unmatched[0]!;
    output.push({creator:alias("identity-review",id),network:member.network,profile,account:alias("account",member.account),handle:null,
      state:"identity-review",source:null,cohort:null,notionReceipt:null,sheetsReceipt:null,lastCheck:checks.get(id)??null,review:unavailableReview("quarantined"),messages:[],
      reason:"Source row has no exact canonical intake match. It requires identity review."});
  }
  return output.sort((a,b)=>(a.profile??a.creator).localeCompare(b.profile??b.creator));
}

export function createMonitorReader(options:Options){
  const {db,scope,secret,funnel,intake,source}=options,clock=options.now??Date.now;
  const bound=db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
  if(bound?.workspace_id!==scope.workspaceId || bound.account_id!==scope.accountId || scope.environment!=="sandbox")
    throw new MonitorError("DATABASE_SCOPE_MISMATCH",403);
  const key=createHmac("sha256",secret).update(JSON.stringify(["monitor-display.v1",scope])).digest();
  const alias:Alias=(kind,value)=>kind+"-"+createHmac("sha256",key).update(JSON.stringify([kind,value])).digest("hex").slice(0,24);
  async function read(view:MonitorViewKey,raw:unknown,page:{cursor:string|null;limit:number;authorizationContext?:string}) {
    const filters=monitorFilters[view].parse(raw),limit=z.number().int().min(1).max(100).parse(page.limit);
    const context=digest([scope,view,filters,limit,page.authorizationContext??"reader"]),start=clock();
    let cursor:z.infer<typeof pageSchema>|null=null;
    if(page.cursor!==null){
      try {cursor=pageSchema.parse(openOperationsToken(scope,secret,"monitor-page.v1",page.cursor));}
      catch {throw new MonitorError("INVALID_MONITOR_CURSOR",400);}
      if(cursor.context!==context || cursor.expires<=start)throw new MonitorError(cursor.expires<=start?"MONITOR_CURSOR_EXPIRED":"INVALID_MONITOR_CURSOR",409);
    }
    const reply=source?await source(scope):null;
    const result=reply===null?null:monitorSnapshotSchema.safeParse(reply);
    if(result && !result.success)throw new MonitorError("MONITOR_SOURCE_INVALID",502);
    const s=result?.data??null,now=clock();
    if(s && (s.scope.accountId!==scope.accountId || s.scope.workspaceId!==scope.workspaceId || s.scope.environment!==scope.environment))
      throw new MonitorError("SOURCE_SCOPE_DENIED",403);
    if(s && Date.parse(s.observedAt)>now)throw new MonitorError("MONITOR_SOURCE_INVALID",502);
    const sourceExpires=s?Math.min(Date.parse(s.validUntil),Date.parse(s.observedAt)+monitorMaxAgeMs):null;
    const expired=sourceExpires!==null && sourceExpires<=now;
    const sourceState=!s ? source?"unavailable" as const:"unconfigured" as const : expired?"expired" as const:s.coverage==="partial"?"partial" as const:"current" as const;
    const asOf=cursor?.asOf??new Date(now).toISOString();
    db.exec("BEGIN");
    try{
      const members=intake.monitorMembership(2000);
      const saved=view==="contentMonitor" || view==="postPerformance" ? funnel.snapshot({asOf},cursor?.watermark):{watermark:0,events:[]};
      // An authenticated lease renewal with the same revision and facts does not create new list membership.
      const sourceFacts=s ? [s.scope,s.version,s.coverage,s.members,s.posts,s.runs,s.reviewEvidence??null]:null;
      const evidenceAge=s?[(s.reviewEvidence??[]).map(r=>Date.parse(r.observedAt)+monitorMaxAgeMs<=now),s.runs.flatMap(r=>r.inbox.map(e=>e.context?Date.parse(e.context.observedAt)+monitorMaxAgeMs<=now:null))]:null;
      const basis=digest([members,sourceFacts,sourceState,evidenceAge]);
      if(cursor && (cursor.basis!==basis || cursor.expires<=now))throw new MonitorError("MONITOR_SNAPSHOT_CHANGED",409);
      const watches=watchRows(members,s,!expired,alias,now);
      const latestRun=(s?.runs??[]).slice().sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)||a.id.localeCompare(b.id))[0];
      const meta={observedAt:asOf,sourceState,sourceAsOf:cursor?cursor.sourceAsOf:s?.observedAt??null,sourceVersion:s?alias("source",s.version):null,
        latestRunRef:latestRun?alias("run",latestRun.id):null,membershipComplete:members.complete};
      const offset=cursor?.offset??0;
      let total=0,returned=0;
      const slice=<T>(items:T[])=>{total=items.length;const values=items.slice(offset,offset+limit);returned=values.length;return values;};
      let data;
      if(view==="watchlist"){
        const f=monitorFilters.watchlist.parse(filters);
        const chosen=watches.filter(w=>(f.source==="all"||w.source===f.source)&&(f.state==="all"||w.state===f.state)&&(f.cohort==="all"||w.cohort===f.cohort));
        data=nativeWatchlistSchema.parse({...meta,kind:"saved-monitor-watchlist",profiles:slice(chosen),total:chosen.length,
          active:chosen.filter(w=>w.state==="active").length,pending:chosen.filter(w=>w.state==="identity-review").length,
          pendingReviewTotal:watches.filter(w=>w.state==="identity-review"&&(f.source==="all"||w.source===f.source)&&(f.cohort==="all"||w.cohort===f.cohort)).length,
          excluded:chosen.filter(w=>w.state==="excluded").length,unverified:chosen.filter(w=>w.state==="eligibility-unverified").length});
      } else if(view==="hourlyRun"){
        const id=monitorFilters.hourlyRun.parse(filters).runId;
        const run=s?.runs.find(r=>alias("run",r.id)===id);
        if(!run)data=null;
        else {
          const counts={changed:0,unchanged:0,skipped:0,failed:0,deferred:0,unknown:0};
          for(const c of run.checks)counts[c.state]++;
          const checks=slice(run.checks).map(c=>({profile:alias("profile",JSON.stringify([c.network,c.account,c.profileId])),network:c.network,state:c.state,
            access:c.access,at:c.at,lastSuccessAt:c.lastSuccessAt,receipt:c.receipt?alias("receipt",c.receipt):null,checkpoint:c.checkpoint?alias("checkpoint",c.checkpoint):null,
            owner:c.owner?alias("owner",c.owner):null,reason:c.reason}));
          data=nativeRunSchema.parse({...meta,kind:"saved-monitor-run",runId:id,runAt:run.observedAt,runReceipt:alias("receipt",run.receipt),
            snapshotSize:run.snapshotSize,complete:run.complete,checks,counts,timezone:run.timezone,schedule:run.schedule,nextRun:run.nextRun,retryPolicy:run.retryPolicy,
            observations:run.inbox.map(e=>messageRow(e,s,!expired,alias,now))});
        }
      } else {
        const events=effectiveEvents(saved.events),publications=projectPosts(events,s,alias,scope,secret),posts=[...publications.values()];
        if(view==="postPerformance"){
          const id=monitorFilters.postPerformance.parse(filters).postId,item=posts.find(p=>p.post.id===id);
          data=item?nativePostSchema.parse({...meta,kind:"saved-monitor-post",...item}):null;total=returned=data?1:0;
        } else {
          const f=monitorFilters.contentMonitor.parse(filters),from=Date.parse(asOf)-(f.window==="last-7"?7:30)*86400000;
          // A post has a creator/account/network, not a profile ID. Search a handle
          // only when that exact tuple resolves to one permitted active profile.
          // Count all matching rows before eligibility filtering to avoid guessing
          // between multiple profiles on the same publishing account.
          const handleRows=new Map<string,NativeWatchlist["profiles"]>();
          for(const row of watches){
            const key=JSON.stringify([row.creator,row.network,row.account]),prior=handleRows.get(key)??[];
            prior.push(row);handleRows.set(key,prior);
          }
          const query=f.q.trim().toLowerCase(),handleQuery=query.replace(/^@/,"");
          const matchesHandle=(p:{creator:string;network:string;account:string;conflict:boolean})=>{
            const candidates=handleRows.get(JSON.stringify([p.creator,p.network,p.account]));
            const row=candidates?.length===1?candidates[0]:undefined;
            return Boolean(!p.conflict&&handleQuery&&row?.state==="active"&&row.handle?.toLowerCase().replace(/^@/,"").includes(handleQuery));
          };
          const chosen=posts.map(({post})=>({...post,measurement:post.measurement && Date.parse(post.measurement.at)>=from?post.measurement:null}))
            .filter(p=>(f.source==="all"||p.enrollmentSource===f.source)&&(f.network==="all"||p.network===f.network)&&
              (!query || [p.id,p.creator,p.network,p.campaign].some(value=>value.toLowerCase().includes(query)) || matchesHandle(p)))
            .sort((a,b)=>(b.publishedAt?Date.parse(b.publishedAt):0)-(a.publishedAt?Date.parse(a.publishedAt):0)||a.id.localeCompare(b.id));
          data=nativeContentSchema.parse({...meta,kind:"saved-content-monitor",posts:slice(chosen),total:chosen.length,window:f.window,
            ...monitorTotals(chosen,sourceState==="current" && members.complete,events,asOf,alias,publications)});
        }
      }
      const more=offset+returned<total,partial=returned<total || sourceState!=="current" || !members.complete || (data?.kind==="saved-monitor-run"&&!data.complete);
      const expires=cursor?.expires??Math.min(now+15*60_000,sourceExpires!==null&&!expired?sourceExpires:Number.MAX_SAFE_INTEGER);
      const nextCursor=more?sealOperationsToken(scope,secret,"monitor-page.v1",{version:1,context,offset:offset+limit,asOf,sourceAsOf:meta.sourceAsOf,watermark:saved.watermark,basis,expires}):null;
      db.exec("COMMIT");
      return {data,total,returned,partial,stale:expired,nextCursor,hasMore:more,capabilities:[{actionKind:"retryMonitorProfile",state:"held" as const,
        reasonCodes:["J08_RETRY_AUTHORITY_UNVERIFIED"]}]};
    } catch(error){db.exec("ROLLBACK");throw error;}
  }
  return {read};
}
