import { SourceReadGrant } from "@/components/SourceReadGrant";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link,useParams,useSearchParams } from "react-router-dom";
import { usePagedView } from "@/adapter/usePagedView";
import { SCHEMA_VERSION } from "@/adapter/contract";
import { scopeKey,useScope } from "@/adapter/scope";
import { Button,LinkButton } from "@/components/Button";
import { Field } from "@/components/Field";
import { Dialog } from "@/components/Dialog";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/Badge";
import { SearchField } from "@/components/Search";
import { SectionTabs } from "@/components/SectionTabs";
import { SkeletonCard } from "@/components/EmptyState";
import { ViewError } from "@/components/ViewError";
import { Card,ChoiceButton,DetailRow,KpiCard,KpiGrid,SectionHeading,Table,dateTime,usdExact } from "@/features/analytics/parts";
import type { NativeContent,NativeWatchlist,NativeRun,NativePost } from "@/creator-agent/monitor/contract";
import a from "@/features/analytics/Analytics.module.css";
import m from "./Monitor.module.css";
import n from "./NativeMonitor.module.css";
import buttonStyles from "@/components/Button.module.css";

type Native=NativeContent|NativeWatchlist|NativeRun|NativePost;
const value=(n:number|null)=>n===null?"Unknown":n.toLocaleString("en-US");
const stamp=(s:string|null)=>s?dateTime(s):"Unknown";
const sourceLabels={current:"Current source snapshot",partial:"Partial source coverage",expired:"Expired source snapshot",
  unconfigured:"Hourly monitoring source not configured",unavailable:"Hourly monitoring source unavailable"};

function PageReads<T extends Native>({view,filters,kind,render,before}:{view:string;filters:Record<string,string>;kind:T["kind"];
  render:(pages:T[])=>ReactNode;before?:(latest:T)=>ReactNode}){
  const ctx=useScope(),client=useQueryClient(),pageSize=50;
  const query=usePagedView<Record<string,string>,T>(view,filters,null,pageSize);
  const frozenKey=JSON.stringify([...scopeKey(ctx),SCHEMA_VERSION,"cursor-pages",view,filters,null,pageSize]);
  useEffect(()=>()=>{const key=JSON.parse(frozenKey);void client.cancelQueries({queryKey:key,exact:true});client.removeQueries({queryKey:key,exact:true});},[client,frozenKey]);
  const pages=(query.isError?undefined:query.data)?.pages.flatMap(p=>p.data?.kind===kind?[p.data]:[])??[];
  const latest=pages.at(-1);
  const restart=()=>client.resetQueries({queryKey:JSON.parse(frozenKey),exact:true});
  return <>
    {!latest&&<h1 id="native-monitor-title" className={n.loadingTitle}>{kind==="saved-content-monitor"?"Creator content, without the blind spots.":kind==="saved-monitor-watchlist"?"Know who the agent is watching.":"Every hourly check leaves evidence."}</h1>}
    {query.isPending && <SkeletonCard label="Loading saved monitoring evidence…"/>}
    {query.isError && <ViewError error={query.error} subject="Monitoring evidence" hasPriorData={Boolean(latest)} onRetry={()=>void restart()}/>}
    {latest && <SourceReadGrant validUntil={pages.map(p=>p.readAccess?.validUntil).filter((v):v is string=>!!v).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]} title="Monitoring evidence" titleId="native-monitor-title" refresh={()=>void restart()}>
      {before?.(latest)}
      {render(pages)}
      {query.hasNextPage && <Button variant="secondary" loading={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage({cancelRefetch:false})}>Load more saved records</Button>}
      {query.isFetchNextPageError && <Button variant="secondary" onClick={()=>void restart()}>Restart this list</Button>}
    </SourceReadGrant>}
    {!query.isPending && !query.isError && !latest && <p role="status">No matching scoped monitoring record is available. Provider coverage is unknown.</p>}
  </>;
}
function SourceStamp({data}:{data:Native}){
  const text=`${sourceLabels[data.sourceState]} · Source as of ${stamp(data.sourceAsOf)} · Saved ledger read ${stamp(data.observedAt)}.${!data.membershipComplete?" Intake coverage is partial.":""}`;
  // Chromium exposes role=status as AT-SPI statusbar. Give that object the
  // same visible message as its name, so direct status inspection and caret
  // navigation do not announce an unnamed "statusbar" with blank contents.
  return <p className={a.small} role="status" aria-label={text} aria-atomic="true">{text}</p>;
}
const options=(pairs:[string,string][])=>pairs.map(([value,label])=>({value,label}));
const sources=options([["all","All intake sources"],["social-cat","Social Cat"],["tiktok-affiliate","TikTok affiliate"]]);
function useFilters(){
  const [params,set]=useSearchParams();
  const get=(key:string,allowed:string[],fallback:string)=>allowed.includes(params.get(key)??"")?params.get(key)!:fallback;
  const change=(key:string,selection:string)=>set(p=>{const n=new URLSearchParams(p);if(!selection||selection==="all")n.delete(key);else n.set(key,selection);return n;},{replace:key==="q"});
  return {params,get,change};
}
function Heading({title,sub,children}:{title:string;sub:string;children:ReactNode}){
  return <div className={a.titleRow}><div className={a.heading}><h1 id="native-monitor-title">{title}</h1><p>{sub}</p></div>{children}</div>;
}
const context=(title:string,detail:string)=><section className={n.notice} aria-label="Current acquisition policy"><p className={a.label}>{title}</p><p className={a.small}>{detail}</p><div className={a.actions} style={{gap:10}}><LinkButton variant="secondary" style={{minWidth:170}} to="/creators/discovery">Daily sourcing</LinkButton><LinkButton variant="secondary" style={{minWidth:209}} to="/creators/pipeline">Full acquisition funnel</LinkButton></div></section>;
function Choice({label,title,value,options,onChange,width=200}:{label:string;title:string;value:string;options:{value:string;label:string}[];onChange:(v:string)=>void;width?:number}){return <ChoiceButton legend={label} title={title} value={value} options={options} onChange={onChange} width={width} buttonLabel={c=>c.label} applyOnDone/>;}
function EmptyPlot({children,height=252}:{children:ReactNode;height?:number}){return <div style={{minHeight:height}} className={n.emptyPlot} role="status">{children}</div>;}
function SectionTitle({id,children}:{id:string;children:ReactNode}){return <h2 id={id} className={a.cardH2}>{children}</h2>;}
const metricRate=(metric:NativePost["post"]["measurement"])=>metric&&metric.views!==null&&metric.views>0&&metric.likes!==null&&metric.comments!==null&&metric.shares!==null?((metric.likes+metric.comments+metric.shares)*100/metric.views).toFixed(1)+"%":"Unknown";
function RunLink({id,label="View hourly runs"}:{id:string|null;label?:string}){
  return id?<LinkButton style={{minWidth:166}} to={`/runs/${encodeURIComponent(id)}`}>{label}</LinkButton>:
    <Button style={{minWidth:166}} disabledReason="No verified hourly run reference is available.">{label}</Button>;
}
function postSales(p:NativePost["post"]){return p.attribution?.level==="post"&&p.attribution.complete?p.attribution:null;}
export function NativeContentMonitor(){
  const {params,get,change}=useFilters();
  const filters={source:get("source",sources.map(s=>s.value),"all"),network:get("network",["all","instagram","tiktok"],"all"),window:get("window",["last-30","last-7"],"last-30"),q:(params.get("q")??"").slice(0,80)};
  return <section aria-labelledby="native-monitor-title" data-figma-source="23:73" className={`${a.page} ${m.native}`}>
    <PageReads<NativeContent> view="contentMonitor" kind="saved-content-monitor" filters={filters} before={latest=><>
      <Heading title="Creator content, without the blind spots." sub="Track published posts, creator replies, and measurable results from one watchlist."><LinkButton variant="secondary" style={{minWidth:172}} to="/creators/watchlist">Open watchlist</LinkButton><RunLink id={latest.latestRunRef}/></Heading>
      <div className={m.tabsRow}><SectionTabs label="Creator workspace" tabs={[{label:"Social Cat",to:"/creators/social-cat?view=dashboard",width:164},{label:"TikTok Shop",to:"/creators/tiktok?view=dashboard",width:164},{label:"Content monitor",to:"/content",width:164,current:true},{label:"Watchlist",to:"/creators/watchlist",width:164}]}/><span style={{flex:"0 1 110px"}}/><Badge tone="warning" width={264}>Read-only · source authorization applies</Badge></div>
      {context("Hourly monitoring · enrolled creators","Monitor posted content and inbox changes hourly when authorized. New-creator discovery and lifestyle evidence review are separate daily workflows.")}
      <div className={m.filtersRow}><Badge tone="violet" width={256}>Selected source scope</Badge><Choice label="Intake source" title="Filter by creator source" value={filters.source} options={sources} onChange={v=>change("source",v)} width={192}/><Choice label="Post network" title="Filter by post network" value={filters.network} options={options([["all","All post networks"],["instagram","Instagram"],["tiktok","TikTok"]])} onChange={v=>change("network",v)} width={184}/><Choice label="Observation window" title="Choose an observation window" value={filters.window} options={options([["last-30","Last 30 days"],["last-7","Last 7 days"]])} onChange={v=>change("window",v)} width={156}/><span style={{flex:"0 1 160px"}}/><div className={n.snapshot}><SourceStamp data={latest}/></div></div>
    </>} render={pages=>{
      const latest=pages.at(-1)!,posts=pages.flatMap(d=>d.posts);
      return <><KpiGrid>
        <KpiCard label={latest.metricBasis?.semantics==="cumulative"?"Cumulative views":"Observed views"} context={latest.metricBasis?`${latest.metricBasis.definition} · ${latest.metricBasis.semantics} · ${latest.metricBasis.window} · ${latest.metricBasis.context}`:"Comparable source basis unavailable"}>{value(latest.views)}</KpiCard>
        <KpiCard label="Engagement rate" context="Likes, comments and shares / views">{latest.rate===null?"Unknown":latest.rate.toFixed(1)+"%"}</KpiCard>
        <KpiCard label="Attributed orders" context="Reconciled attribution window">{value(latest.orders)}</KpiCard><KpiCard label="Attributed net sales" context="After discounts and refunds">{latest.net?usdExact(latest.net):"Unknown"}</KpiCard>
      </KpiGrid><div className={n.contentSplit}><Card labelledBy="audience-title"><div className={m.headRow}><SectionTitle id="audience-title">Content finding its audience.</SectionTitle><span style={{flex:"0 1 160px"}}/><Badge tone="violet" width={126}>History unavailable</Badge></div><p className={a.small}>Cumulative views · comparable historical snapshots required</p><EmptyPlot>No scoped cumulative time series was supplied. A current snapshot cannot establish a growth curve.</EmptyPlot><p className={a.small}>Post snapshots, not unique reach · missing metrics remain unknown</p></Card>
      <section className={m.coverage} aria-labelledby="coverage-title"><h2 id="coverage-title">Keep every creator in view.</h2><p className={m.coverageText}>Sheets owns the watchlist. Notion owns collaborations and approvals.</p><div className={m.numbers}><div><strong>Unknown</strong><span>Cohort creators</span></div><div><strong>{latest.total}</strong><span>Saved scoped posts</span></div><div><strong>Unknown</strong><span>Complete coverage</span></div></div><p className={m.darkSmall}>Saved results do not establish provider-wide monitoring coverage.</p><span><Badge tone="warning" width={252} testId="coverage-intake-state">{latest.membershipComplete?"Intake membership supplied":"Partial intake coverage"}</Badge></span><LinkButton variant="secondary" to="/creators/watchlist">Inspect coverage</LinkButton></section></div>
      <Card labelledBy="saved-posts"><div className={m.headRow} style={{alignItems:"flex-start"}}><SectionTitle id="saved-posts">Posts worth paying attention to.</SectionTitle><span style={{flex:"0 1 300px"}}/><SearchField label="Search saved posts" placeholder="Search handle or post" value={filters.q} onChange={v=>change("q",v.slice(0,80))} fluid/></div>
        {posts.length?<Table caption="Saved campaign posts" columns={[{label:"CREATOR / POST",width:260},{label:"NETWORK",width:160},{label:"VIEWS",width:150},{label:"ENGAGEMENT",width:180},{label:"ORDERS",width:140},{label:"NET SALES",width:150},{label:"LAST CHECK",width:208}]} rows={posts.map(p=>({key:p.id,cells:[<Link className={m.rowLink} to={"/content/"+encodeURIComponent(p.id)}>{p.creator} · {p.id}</Link>,p.network+(p.conflict?" · conflicting evidence":p.visibility!=="public"?" · "+p.visibility:""),value(p.measurement?.views??null),metricRate(p.measurement),value(postSales(p)?.orders??null),postSales(p)?.net?usdExact(postSales(p)!.net!):"Unknown",stamp(p.measurement?.at??null)]}))}/>:<p>No matching saved campaign posts. Provider-wide post count is unknown.</p>}
        <p className={a.small}>{posts.length} of {latest.total} saved posts. Engagement = (likes + comments + shares) / views for comparable posts only. Missing components and unlike windows remain unknown.</p></Card>
      <div className={n.contentSplit}><Card labelledBy="signals-title"><SectionHeading id="signals-title" level={3} title="New posts. New replies. A clear next step."/><p className={a.small}>Review exact source observations in the hourly run. A saved post does not establish a new reply or authorize outreach.</p><div className={a.actions}><RunLink id={latest.latestRunRef} label="Review source changes"/></div></Card><section className={m.subtle} aria-labelledby="availability-title"><SectionHeading id="availability-title" level={3} title="Know where a number comes from."/><p className={a.small}>Content metrics retain source definitions and windows. Net sales require reconciled order attribution.</p><p style={{font:"var(--text-small)",color:"var(--color-violet)"}}>Read-only checks · replies stay in the approval queue</p></section></div></>;
    }}/>
  </section>;
}

export function NativeWatchlistPage(){
  const {get,change}=useFilters();
  const filters={source:get("source",sources.map(s=>s.value),"all"),state:get("state",["all","active","identity-review","excluded"],"all"),cohort:get("cohort",["all","only-launch-a"],"all")==="only-launch-a"?"launch-a":"all"};
  return <section className={`${a.page} ${m.native}`} data-figma-source="25:166" aria-labelledby="native-monitor-title">
    <PageReads<NativeWatchlist> view="watchlist" kind="saved-monitor-watchlist" filters={filters} before={latest=><>
      <Heading title="Know who the agent is watching." sub="New applications and affiliate signups become deduplicated tracking profiles."><LinkButton variant="secondary" style={{minWidth:160}} to="/content">View monitor</LinkButton><Button style={{minWidth:184}} onClick={()=>change("state","identity-review")}>{latest.pendingReviewTotal===undefined?"Review matches":`Review ${latest.pendingReviewTotal} matches`}</Button></Heading>
      {context("Watchlist intake and acquisition are distinct","New profiles begin identity pending. Enrollment does not imply qualification, accepted terms or outreach approval. Daily discovery can propose candidates for review.")}<div className={m.ctx}><Badge tone="violet" width={200}>Saved watchlist</Badge><SourceStamp data={latest}/></div>
    </>} render={pages=>{
      const latest=pages.at(-1)!,rows=pages.flatMap(d=>d.profiles);
      return <><KpiGrid><KpiCard label="Tracked profiles" context="Saved profile rows">{latest.total}</KpiCard><KpiCard label="Active monitoring" context="Current matching enrollment">{latest.active}</KpiCard><KpiCard label="Identity review" context={`${latest.unverified} additional eligibility states unverified`} warn>{latest.pending}</KpiCard><KpiCard label="Excluded" context="Suppression or closed intake">{latest.excluded}</KpiCard></KpiGrid>
      <div className={m.filtersRow} style={{gap:16,alignItems:"center"}}><Choice label="Intake source" title="Filter by intake source" value={filters.source} options={sources} onChange={v=>change("source",v)}/><Choice label="Monitoring state" title="Filter by monitoring state" value={filters.state} options={options([["all","All monitoring states"],["active","Active"],["identity-review","Identity review"],["excluded","Excluded"]])} onChange={v=>change("state",v)} width={220}/><Choice label="Cohort" title="Choose a named cohort" value={filters.cohort} options={options([["all","All cohorts"],["launch-a","Launch cohort A"]])} onChange={v=>change("cohort",v==="launch-a"?"only-launch-a":"all")}/></div>
      <WatchlistEvidence rows={rows} latest={latest}/></>;
    }}/>
  </section>;
}

type WatchRow=NativeWatchlist["profiles"][number];
type Message=NativeRun["observations"][number];
function MessageDetails({event}:{event:Message}){
  const d=event.detail;
  return <><DetailRow label="Profile" value={event.profile}/><DetailRow label="Network / account" value={event.network+" · "+event.account}/><DetailRow label="Observed" value={stamp(event.at)}/>
    <DetailRow label="Original event receipt" value={event.receipt}/><DetailRow label="Interpretation" value={event.interpretation}/>
    {d?.state==="current"?<><DetailRow label="Source context observed" value={stamp(d.observedAt)}/><DetailRow label="Exact conversation" value={d.conversationId??"Unavailable"}/>
      <DetailRow label="Exact message" value={d.messageId??"Unavailable"}/><DetailRow label="Source version" value={d.sourceVersion??"Unavailable"}/>
      <DetailRow label="Status at observation" value={d.currentStatus??"Unavailable"}/><DetailRow label="Suggested status at observation" value={d.proposedStatus??"Unavailable"}/>
      <DetailRow label="Expected source version" value={d.expectedVersion??"Unavailable"}/></>:<p role="status">Message context {d?.state??"unavailable"}. Refresh authorized source evidence before reviewing this message.</p>}
    <p>Read-only context from the dated authorized source observation, not a live permission grant. Message contents remain in the source. Reviewing does not send a reply or apply a status change.</p></>;
}
function HistoryDetails({row}:{row:WatchRow}){
  const r=row.review;
  return <section className={m.reviewEvidence}><h3>{row.handle??row.profile??row.creator}</h3>
    {r?.state==="current"?<><p>{r.historyComplete?"Complete supplied history":"Partial supplied history"} · observed {stamp(r.observedAt)} · {r.receipt}</p>
      {r.history.length?<DataTable caption={"Intake history for "+(row.profile??row.creator)} columns={[{label:"Event / time"},{label:"Decision"},{label:"Identity evidence"},{label:"Original / decision receipts"}]}
        rows={r.history.map(h=>[h.id+" · "+stamp(h.at),h.kind+" · "+h.decision,h.identityEvidence.join(" · "),h.receipt+" · "+h.decisionReceipt])}/>:<p>No intake history entries were supplied. Current profile checks are not historical intake events.</p>}</>:
      <p role="status">Intake evidence {r?.state??"unavailable"}. Original identity history has not been verified for this exact profile and revision.</p>}</section>;
}
function WatchlistEvidence({rows,latest}:{rows:WatchRow[];latest:NativeWatchlist}){
  const [mapping,setMapping]=useState(false);
  const [selection,setSelection]=useState<{kind:"history"}|{kind:"identity"|"message";creator:string;profile:string|null;event?:string}|null>(null);
  // Keep only selection keys: access revocation or a changed source packet cannot leave a copied private row in an open dialog.
  const row=selection&&selection.kind!=="history"?rows.find(r=>r.creator===selection.creator&&r.profile===selection.profile):null;
  const event=selection&&selection.kind==="message"?row?.messages?.find(e=>e.id===selection.event):null;
  const review=row?.review;
  return <><Card labelledBy="registry-heading"><SectionTitle id="registry-heading">The sheet is the tracking registry</SectionTitle><p className={a.small}>One stable profile key per platform account. Linked accounts share a creator ID; profile count is not unique people. Showing {rows.length} of {latest.total} saved rows.</p>
    {rows.length?<Table caption="Canonical creator and profile evidence" columns={[{label:"CREATOR / PROFILE",width:300},{label:"SIGNUP SOURCE",width:250},{label:"MONITORING",width:170},{label:"LAST CHECK",width:150},{label:"NEXT STEP",width:378}]} rows={rows.map(r=>({key:JSON.stringify([r.creator,r.profile]),cells:[(r.handle??r.profile??r.creator)+" · "+(r.network??"Unknown"),r.source??"Unknown",<Badge tone={r.state==="active"?"success":r.state==="identity-review"?"warning":"neutral"} width={144}>{r.state==="identity-review"?"Identity review":r.state==="active"?"Active":r.state==="excluded"?"Excluded":"Unverified"}</Badge>,stamp(r.lastCheck),<div className={n.actions}>
      <button className={m.linkBtn} aria-haspopup="dialog" onClick={()=>setSelection({kind:"identity",creator:r.creator,profile:r.profile})}>{r.state==="excluded"?"View exclusion reason":"Match the correct profile"} <span aria-hidden="true">→</span></button>
      {r.messages?.length?r.messages.map(e=><button key={e.id} className={m.linkBtn} aria-haspopup="dialog" onClick={()=>setSelection({kind:"message",creator:r.creator,profile:r.profile,event:e.id})}>Review new message · {stamp(e.at)} <span aria-hidden="true">→</span></button>):<Button variant="ghost" className={m.linkBtn} disabledReason="No exact source conversation and message observation was supplied.">Review new message</Button>}</div>]}))}/>:<p>No matching local intake records. Provider enrollment is unknown.</p>}
    </Card><div className={n.halves}><Card labelledBy="intake-queue-title"><SectionTitle id="intake-queue-title">Every signup enters a clear queue</SectionTitle><p className={a.small}>1 Discover a new application or affiliate signup.</p><p className={a.small}>2 Upsert the source ID; preserve the original signup event.</p><p className={a.small}>3 Match handle, profile URL, creator and collaboration.</p><p className={a.small}>4 Activate eligible profiles; queue ambiguous matches.</p><div className={a.actions}><Button variant="secondary" style={{minWidth:240}} aria-haspopup="dialog" onClick={()=>setSelection({kind:"history"})}>Open intake history</Button></div></Card>
    <Card labelledBy="mapping-title"><SectionTitle id="mapping-title">What the agent needs to know</SectionTitle><p className={a.small}>Creator ID · source signup ID · intake platform · posting network · profile URL · campaign · collaboration · tracking status · last checked · next due · exclusion reason.</p><hr className={a.divider}/><p className={a.small}>Restricted account access stays in the connected browser session. Messages remain in their source; this sheet stores only status, evidence links and timestamps.</p><div className={a.actions}><Button variant="secondary" style={{minWidth:240}} aria-haspopup="dialog" onClick={()=>setMapping(true)}>View sheet mapping</Button></div></Card></div>
    <p className={m.footer}>Google Sheets tracking source / Notion collaboration and approval records / source platforms retain the original conversations.</p>
    <Dialog open={mapping} title="Tracking sheet mapping" onClose={()=>setMapping(false)}><p>Canonical intake maps creator, network, account and profile identity to exact Notion and Sheets handoff receipts. Only matching current enrollment can activate monitoring. Missing or competing identity evidence remains held.</p><p>No sheet URL or write authority is inferred from these receipts.</p><Button onClick={()=>setMapping(false)}>Close mapping</Button></Dialog>
    <Dialog open={selection!==null} title={selection?.kind==="history"?"Intake history":selection?.kind==="message"?"New message evidence":row?.state==="excluded"?"Exclusion reason":"Match the correct profile"} onClose={()=>setSelection(null)}>
      {selection?.kind==="history"?<><p>History for {rows.length} loaded profiles in the current source, state and cohort filters; {latest.total} profiles match. Load more saved records to include later pages.</p>{rows.map(r=><HistoryDetails key={r.profile??r.creator} row={r}/>)}</>:
        selection?.kind==="message"?event?<MessageDetails event={event}/>:<p role="status">This exact message is no longer available in the current authorized source snapshot.</p>:
          row?<><DetailRow label="Creator / profile" value={row.creator+" · "+(row.profile??"Unknown")}/><DetailRow label="Account / network" value={(row.account??"Unknown")+" · "+(row.network??"Unknown")}/>
            <DetailRow label="Current reason" value={row.reason}/><DetailRow label="Notion receipt" value={row.notionReceipt??"Unverified"}/><DetailRow label="Sheets receipt" value={row.sheetsReceipt??"Unverified"}/><HistoryDetails row={row}/>
            {review?.state==="current"&&<>{review.candidates.length?<div className={m.reviewEvidence}><DataTable caption="Competing identity evidence" columns={[{label:"Creator / profile"},{label:"Account / network"},{label:"Receipt"}]}
              rows={review.candidates.map(c=>[c.creatorId+" · "+c.profileId,c.account+" · "+c.network,c.receipt])}/></div>:<p>No competing identity evidence was supplied.</p>}
              {review.exclusion?<><DetailRow label="Exclusion reason" value={review.exclusion.reasonCode}/><DetailRow label="Effective" value={stamp(review.exclusion.at)}/><DetailRow label="Owner" value={review.exclusion.owner}/><DetailRow label="Exclusion receipt" value={review.exclusion.receipt}/></>:<p>No dated exclusion decision was supplied.</p>}</>}
            <p>Ambiguous identities stay quarantined. Reviewing does not merge identities, enroll a profile or remove an exclusion.</p></>:<p role="status">This profile is no longer available in the current authorized scope.</p>}
      <Button variant="secondary" onClick={()=>setSelection(null)}>Return to watchlist</Button>
    </Dialog>
  </>;
}
function RunObservations({events}:{events:Message[]}){
  const [selected,setSelected]=useState<string|null>(null),event=events.find(e=>e.id===selected);
  return <>{events.length?<Table caption="Observed source changes" columns={[{label:"EVIDENCE",width:350},{label:"SOURCE",width:310},{label:"RESULT",width:360},{label:"ACTION",width:228}]} rows={events.map(e=>({key:e.id,cells:[e.kind,e.profile+" · "+e.network,e.interpretation==="suggestion"?"Suggested status · review exact observation":"Source observation recorded",<button className={m.linkBtn} aria-haspopup="dialog" onClick={()=>setSelected(e.id)}>{e.interpretation==="suggestion"?"Review status suggestion":"Review source observation"} <span aria-hidden="true">→</span></button>]}))}/>:<p>No source events returned in this snapshot.</p>}
    <div style={{display:"contents"}}><Dialog open={selected!==null} title="Source observation evidence" onClose={()=>setSelected(null)}>{event?<MessageDetails event={event}/>:<p role="status">This observation is no longer available.</p>}<Button onClick={()=>setSelected(null)}>Return to run</Button></Dialog></div></>;
}

export function NativeHourlyPage(){
  const {runId=""}=useParams(),evidenceRef=useRef<HTMLHeadingElement>(null);
  return <section className={`${a.page} ${m.native}`} data-figma-source="25:307" aria-labelledby="native-monitor-title">
    <PageReads<NativeRun> view="hourlyRun" kind="saved-monitor-run" filters={{runId}} before={r=><>
      <Heading title="Every hourly check leaves evidence." sub="Review new posts, conversation changes and partial failures before the next run."><LinkButton variant="secondary" style={{minWidth:176}} to="/content">Back to monitor</LinkButton><Button style={{minWidth:184}} onClick={()=>{evidenceRef.current?.scrollIntoView({block:"start"});evidenceRef.current?.focus();}}>Review {r.observations.filter(e=>e.interpretation==="suggestion").length} changes</Button></Heading>
      {context("Hourly monitoring run","This run checks enrolled profiles, posts and inbox updates. It does not discover new prospects or send unsolicited outreach. Daily sourcing has its own permitted-capacity plan.")}<div className={m.ctx}><Badge tone="violet" width={200}>Saved hourly run</Badge><div className={n.runContext}><p className={a.small}>{r.runId} · {stamp(r.runAt)} · {r.runReceipt}</p><SourceStamp data={r}/></div></div>
    </>} render={pages=>{
      const r=pages.at(-1)!,checks=pages.flatMap(p=>p.checks);
      const stages=[
        ["Read the watchlist",`${r.snapshotSize} selected profiles. ${r.counts.skipped} skipped; ${r.counts.unknown} unknown.`,"Snapshot supplied"],
        ["Open authenticated source sessions",`${r.counts.failed} failed and ${r.counts.deferred} deferred profile checks. Exact access and last success are retained below.`,"See evidence"],
        ["Discover linked Farda content","A separate stage completion receipt was not supplied.","Unknown"],
        ["Read post snapshots",`${r.counts.changed} changed; ${r.counts.unchanged} unchanged profile checks. This does not establish each stage's completion.`,"See evidence"],
        ["Read conversation changes",`${r.observations.length} source events supplied. Original receipts remain separate from inferred status.`,"Recorded"],
        ["Reconcile order attribution","An order-reconciliation stage receipt was not supplied.","Unknown"],
        ["Publish the run result",`${r.complete?"Complete":"Partial"} finite check snapshot · observed ${stamp(r.runAt)}.`,r.complete?"Recorded":"Partial"],
      ];
      return <>
      <KpiGrid><KpiCard label="Profiles checked" context={`${r.counts.failed} failed · ${r.counts.deferred} deferred`}>{r.counts.changed+r.counts.unchanged} / {r.snapshotSize}</KpiCard><KpiCard label="New post links" context={`${r.observations.filter(e=>e.kind==="post").length} supplied post events; verified new-link total unavailable`}>Unknown</KpiCard><KpiCard label="Inbox changes" context="Supplied source events; provider-wide total unknown">{r.observations.filter(e=>e.kind!=="post").length}</KpiCard><KpiCard label="Status reviews" context="Message-derived suggestions await review" warn>{r.observations.filter(e=>e.interpretation==="suggestion").length}</KpiCard></KpiGrid>
      {!r.complete&&<p role="status">{r.snapshotSize-Object.values(r.counts).reduce((total,n)=>total+n,0)} selected profiles have no recorded check outcome.</p>}
      <div className={n.detailSplit}><Card labelledBy="run-trace"><SectionTitle id="run-trace">Checkpointed, source by source</SectionTitle><ol className={m.stages} aria-label="Run stages">{stages.map(([title,note,status],i)=><li key={title}><div className={m.stageRow}><Badge tone="violet" width={40}>{String(i+1).padStart(2,"0")}</Badge><div className={m.stageCopy}><strong>{title}</strong><span>{note}</span></div><Badge tone={status==="Partial"?"warning":"neutral"} width={126}>{status}</Badge></div><hr className={a.divider}/></li>)}</ol>
      <details className={n.history}><summary>Inspect profile check receipts</summary><DataTable caption="Read-only run trace" variant="ledger" columns={[{label:"Profile / network"},{label:"Outcome / access"},{label:"Observed / last success"},{label:"Evidence / recovery"}]} rows={checks.map(c=>[c.profile+" · "+c.network,c.state+" · "+c.access,stamp(c.at)+" · "+stamp(c.lastSuccessAt),[c.receipt,c.checkpoint,c.reason,c.owner].filter(Boolean).join(" · ")||"Evidence unknown"])}/></details></Card>
      <Card labelledBy="run-policy" className={a.card20}><SectionTitle id="run-policy">Hourly policy</SectionTitle><div className={m.fields} style={{display:"contents"}}><Field label="Schedule" helpText={"Recorded schedule · timezone "+(r.timezone??"Unknown")}>{props=><input {...props} readOnly aria-disabled="true" value={r.schedule}/>}</Field><Field label="Next run in snapshot" helpText="No execution or cadence is inferred from this snapshot.">{props=><input {...props} readOnly aria-disabled="true" value={stamp(r.nextRun)}/>}</Field><Field label="Retry behavior" helpText="Completed source events are retained in the saved run.">{props=><input {...props} readOnly aria-disabled="true" value={r.retryPolicy??"Unverified"}/>}</Field></div><p className={a.small}>Reconnecting a session does not resend messages or repeat completed source writes.</p><LinkButton variant="secondary" style={{width:"100%"}} to="/settings/connections">Reconnect source</LinkButton><Button variant="secondary" style={{width:"100%"}} disabledReason="An exact authorized schedule configuration reference was not supplied. Schedule changes remain with the source owner.">Manage schedule</Button><Button variant="secondary" style={{width:"100%"}} disabledReason="A verified J08 retry authority for this exact profile is unavailable.">Retry failed profile</Button></Card></div>
      <Card labelledBy="run-events"><h2 id="run-events" ref={evidenceRef} tabIndex={-1} className={a.cardH2}>Observed events stay separate from inferred status</h2><RunObservations events={r.observations}/><p className={a.small}>This monitoring run reads source content and conversations. Any outbound message, payment or commercial commitment follows its separate approval workflow.</p></Card><p className={m.footer}>Every snapshot retains its observed time and original receipt; unknown counts remain unavailable.</p></>;
    }}/>
  </section>;
}

export function NativePostBody({data}:{data:NativePost}){
  const p=data.post,attribution=p.attribution,sales=postSales(p),metric=p.measurement;
  const comparable=(i:number)=>{const h=data.history[i],prior=data.history[i-1];return !p.conflict&&h&&prior&&prior.semantics==="cumulative"&&h.semantics==="cumulative"&&h.definition===prior.definition&&h.window===prior.window&&h.context!=="unknown"&&h.context===prior.context&&h.views!==null&&prior.views!==null&&Date.parse(prior.at)<Date.parse(h.at);};
  const deltas=data.history.slice(1).map((h,j)=>({at:h.at,delta:comparable(j+1)?h.views!-data.history[j]!.views!:null}));
  const chartable=deltas.length>0&&deltas.every(d=>d.delta!==null&&d.delta>=0),max=Math.max(1,...deltas.map(d=>d.delta??0));
  return <div className={`${m.nativeSections} ${m.native}`}><div className={a.titleRow}><div className={a.heading}><h1 id="post-title">One post. Its evidence and impact.</h1><p>{p.network} · {p.id} · Published {stamp(p.publishedAt)}</p></div><LinkButton variant="secondary" style={{minWidth:176}} to="/content">Back to monitor</LinkButton>
    {p.originalUrl&&p.visibility==="public"&&p.access==="authorized"&&data.sourceState==="current"?<LinkButton style={{minWidth:184}} to={p.originalUrl} target="_blank" rel="noreferrer">Open source post</LinkButton>:<Button style={{minWidth:184}} disabledReason="Current exact native post access is unverified.">Open source post</Button>}</div>
    <div className={m.ctx}><Badge tone={data.sourceState==="current"?"violet":"warning"} width={200}>Saved post evidence</Badge><p className={a.small} role="status">{sourceLabels[data.sourceState]} · {p.conflict?"Conflicting evidence requires reconciliation.":`Visibility ${p.visibility} · access ${p.access}`}. Source as of {stamp(data.sourceAsOf)}.</p></div>
    <KpiGrid><KpiCard label="Views" context={metric?.definition??"Metric definition unavailable"}>{value(metric?.views??null)}</KpiCard><KpiCard label="Engagement rate" context="Complete likes + comments + shares / views">{metricRate(metric)}</KpiCard><KpiCard label="Attributed orders" context="Post-level matching required">{value(sales?.orders??null)}</KpiCard><KpiCard label="Attributed net sales" context="Retained, within the attribution window">{sales?.net?usdExact(sales.net):"Unknown"}</KpiCard></KpiGrid>
    <div className={n.detailSplit}><Card labelledBy="post-metrics"><SectionTitle id="post-metrics">Views gained since publication</SectionTitle><p className={a.small}>Changes between consecutive, comparable cumulative source snapshots. Chart dates use UTC.</p>
      {chartable?<div className={m.curveWrap} role="region" tabIndex={0} aria-label="Views gained since publication"><div className={m.bars} role="img" aria-label={deltas.map(d=>`${stamp(d.at)}: ${d.delta} views`).join("; ")}>{deltas.map(d=><div key={d.at} className={m.barCol}><div className={m.bar} style={{height:Math.round(180*d.delta!/max)}}/><span className={m.n}>{value(d.delta)}</span><span className={m.d}>{new Date(d.at).toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})}</span></div>)}</div></div>:<EmptyPlot height={280}>No comparable native measurements are available for a growth chart. Missing observations and revised counters are not zero growth.</EmptyPlot>}
      <p className={a.small}>Views are cumulative source observations; delta bars may be corrected when a platform revises its counts.</p>
      <details className={n.history}><summary>Inspect source metric observations</summary>{data.history.length?<DataTable caption="Post metric observations" variant="ledger" columns={[{label:"Observed / receipt"},{label:"Definition / window"},{label:"Basis / context"},{label:"Views / interactions"},{label:"Cumulative change"}]} rows={data.history.map((h,i)=>[stamp(h.at)+" · "+h.receipt,h.definition+" · "+h.window,h.semantics+" · "+h.context,value(h.views)+" views · "+[value(h.likes),value(h.comments),value(h.shares)].join(" / ")+" likes / comments / shares",comparable(i)?value(h.views!-data.history[i-1]!.views!):"Unknown"])}/>:<p>No comparable native measurements are available.</p>}</details></Card>
      <Card labelledBy="post-lineage"><SectionTitle id="post-lineage">Known, sourced and traceable</SectionTitle><DetailRow label="Network" value={p.network}/><DetailRow label="Intake source" value={p.enrollmentSource}/><DetailRow label="Creator ID" value={p.creator}/><DetailRow label="Content ID" value={p.id}/><DetailRow label="Metric source" value={metric?.definition??"Unknown"}/><DetailRow label="Sales source" value={attribution?"Reconciled attribution receipt":"Unknown"}/><hr className={a.divider}/><p className={a.small}>Likes {value(metric?.likes??null)} + comments {value(metric?.comments??null)} + shares {value(metric?.shares??null)}. Saves {value(metric?.saves??null)}; unique reach {value(metric?.reach??null)}.</p><details className={n.history}><summary>Inspect campaign and publication receipts</summary><DetailRow label="Campaign / asset lineage" value={p.campaign+" · "+(p.creative??"Creative unknown")+" · "+(p.deliverable??"Deliverable unknown")}/><DetailRow label="Campaign assignment receipt" value={p.campaignReceipt}/><DetailRow label="Publishing account" value={p.account}/><DetailRow label="Publication receipt" value={p.publicationReceipt}/><DetailRow label="Publication-age checkpoint" value={p.checkpointHours===null?"Unknown":p.checkpointHours+"h"}/></details></Card></div>
      <div className={n.halves}><Card labelledBy="post-sales"><SectionTitle id="post-sales">Sales require an order match</SectionTitle><p className={a.small}>{sales?`${value(sales.orders)} distinct matched orders are attributed to this post.`:"Post-level order matching is unavailable. Creator-level outcomes are never allocated to a post without evidence."}</p><p className={a.small}>TikTok-reported GMV is retained separately with its source definition and window. It is never relabeled as net sales.</p><details className={n.history}><summary style={{minWidth:280,alignSelf:"flex-start"}} className={`${buttonStyles.button} ${buttonStyles.secondary}`}>View attribution evidence</summary><DetailRow label="Attribution level" value={attribution?.level??"Unknown"}/><DetailRow label="Window / receipt" value={attribution?attribution.window+" · "+attribution.receipt:"Unknown"}/>{attribution&&attribution.level!=="post"&&<DetailRow label={attribution.level+"-level outcomes"} value={value(attribution.orders)+" orders · "+(attribution.net?usdExact(attribution.net):"Net sales unknown")+". No share is assigned to this post."}/>}<DetailRow label="TikTok native GMV" value={p.network!=="tiktok"?"Not applicable":attribution?.gmv?usdExact(attribution.gmv)+" · "+attribution.gmvDefinition:"Unknown"}/></details></Card>
      <Card labelledBy="post-conversation"><SectionTitle id="post-conversation">The conversation explains the next step</SectionTitle><span><Badge tone={p.visibility==="public"?"success":"warning"} width={200} testId="post-publication-state">{p.visibility==="public"?"Public observation recorded":p.visibility}</Badge></span><p className={a.small}>Original publication receipts and observation times are retained. Message claims alone cannot approve payment or confirm an order.</p><div className={a.actions}>{p.collaborationRef?<LinkButton variant="secondary" style={{minWidth:280}} to={"/collaborations/"+encodeURIComponent(p.collaborationRef)}>Open collaboration</LinkButton>:<Button variant="secondary" style={{minWidth:280}} disabledReason="No exact authorized collaboration reference was supplied.">Open collaboration</Button>}</div><details className={n.history}><summary>Inspect publication observation history</summary><DataTable caption="Publication observation history" columns={[{label:"State"},{label:"Observation time"},{label:"Native receipt"}]} rows={data.publicationHistory.map(h=>[h.state,stamp(h.at),h.receipt])}/></details></Card></div>
      <p className={m.footer}>Saved source observations · post reporting retains its own attribution window, metric basis and permission state.</p>
  </div>;
}
