import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link,useParams,useSearchParams } from "react-router-dom";
import { usePagedView } from "@/adapter/usePagedView";
import { SCHEMA_VERSION } from "@/adapter/contract";
import { scopeKey,useScope } from "@/adapter/scope";
import { Button,LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { SelectField,TextField } from "@/components/Field";
import { SkeletonCard } from "@/components/EmptyState";
import { ViewError } from "@/components/ViewError";
import { Card,DetailRow,KpiCard,KpiGrid,SectionHeading,dateTime,usdExact } from "@/features/analytics/parts";
import type { NativeContent,NativeWatchlist,NativeRun,NativePost } from "@/creator-agent/monitor/contract";
import a from "@/features/analytics/Analytics.module.css";
import m from "./Monitor.module.css";

type Native=NativeContent|NativeWatchlist|NativeRun|NativePost;
const value=(n:number|null)=>n===null?"Unknown":n.toLocaleString("en-US");
const stamp=(s:string|null)=>s?dateTime(s):"Unknown";
const sourceLabels={current:"Current source snapshot",partial:"Partial source coverage",expired:"Expired source snapshot",
  unconfigured:"Hourly monitoring source not configured",unavailable:"Hourly monitoring source unavailable"};

function PageReads<T extends Native>({view,filters,kind,render}:{view:string;filters:Record<string,string>;kind:T["kind"];
  render:(pages:T[])=>ReactNode}){
  const ctx=useScope(),client=useQueryClient(),pageSize=50;
  const query=usePagedView<Record<string,string>,T>(view,filters,null,pageSize);
  const frozenKey=JSON.stringify([...scopeKey(ctx),SCHEMA_VERSION,"cursor-pages",view,filters,null,pageSize]);
  useEffect(()=>()=>{const key=JSON.parse(frozenKey);void client.cancelQueries({queryKey:key,exact:true});client.removeQueries({queryKey:key,exact:true});},[client,frozenKey]);
  const pages=query.data?.pages.flatMap(p=>p.data?.kind===kind?[p.data]:[])??[];
  const latest=pages.at(-1);
  const restart=()=>client.resetQueries({queryKey:JSON.parse(frozenKey),exact:true});
  return <>
    {query.isPending && <SkeletonCard label="Loading saved monitoring evidence…"/>}
    {query.isError && <ViewError error={query.error} subject="Monitoring evidence" hasPriorData={Boolean(latest)} onRetry={()=>void restart()}/>}
    {latest && <>
      <div className={a.small} role="status">{sourceLabels[latest.sourceState]} · Source as of {stamp(latest.sourceAsOf)} · Saved ledger read {stamp(latest.observedAt)}.
        {!latest.membershipComplete && " Intake coverage is partial."}</div>
      {render(pages)}
      {query.hasNextPage && <Button variant="secondary" loading={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage({cancelRefetch:false})}>Load more saved records</Button>}
      {query.isFetchNextPageError && <Button variant="secondary" onClick={()=>void restart()}>Restart this list</Button>}
    </>}
    {!query.isPending && !query.isError && !latest && <p role="status">No matching scoped monitoring record is available. Provider coverage is unknown.</p>}
  </>;
}
const options=(pairs:[string,string][])=>pairs.map(([value,label])=>({value,label}));
const sources=options([["all","All intake sources"],["social-cat","Social Cat"],["tiktok-affiliate","TikTok affiliate"]]);
function useFilters(){
  const [params,set]=useSearchParams();
  const get=(key:string,allowed:string[],fallback:string)=>allowed.includes(params.get(key)??"")?params.get(key)!:fallback;
  const change=(key:string,selection:string)=>set(p=>{const n=new URLSearchParams(p);if(!selection||selection==="all")n.delete(key);else n.set(key,selection);return n;},{replace:true});
  return {params,get,change};
}
function Heading({title,sub,children}:{title:string;sub:string;children:ReactNode}){
  return <div className={a.titleRow}><div className={a.heading}><h1 id="native-monitor-title">{title}</h1><p>{sub}</p></div>{children}</div>;
}
const context=(title:string,detail:string)=><div className={m.subtle}><strong>{title}</strong><p>{detail}</p></div>;
function RunLink({id}:{id:string|null}){
  return id?<LinkButton to={`/runs/${encodeURIComponent(id)}`}>View latest hourly run</LinkButton>:
    <Button disabledReason="No verified hourly run reference is available.">View latest hourly run</Button>;
}
function postSales(p:NativePost["post"]){return p.attribution?.level==="post"&&p.attribution.complete?p.attribution:null;}
export function NativeContentMonitor(){
  const {params,get,change}=useFilters();
  const filters={source:get("source",sources.map(s=>s.value),"all"),network:get("network",["all","instagram","tiktok"],"all"),
    window:get("window",["last-30","last-7"],"last-30"),q:(params.get("q")??"").slice(0,80)};
  return <section aria-labelledby="native-monitor-title" data-figma-source="23:73" className={`${a.page} ${m.native}`}>
    <Heading title="Creator content, without the blind spots." sub="Published content, recorded checks and attributable outcomes."><LinkButton variant="secondary" to="/creators/watchlist">Open watchlist</LinkButton></Heading>
    {context("Hourly monitoring · enrolled creators","Daily sourcing and evidence review use separate workflows.")}<div className={m.ctx}><Link to="/creators/discovery">Daily sourcing and evidence review</Link><Link to="/creators/pipeline">Full acquisition funnel</Link></div>
    <div className={m.filtersRow}><SelectField label="Intake source" value={filters.source} options={sources} onChange={v=>change("source",v)}/>
      <SelectField label="Post network" value={filters.network} options={options([["all","All networks"],["instagram","Instagram"],["tiktok","TikTok"]])} onChange={v=>change("network",v)}/>
      <SelectField label="Observation window" value={filters.window} options={options([["last-30","Last 30 days"],["last-7","Last 7 days"]])} onChange={v=>change("window",v)}/>
      <TextField label="Search saved posts" value={filters.q} onChange={v=>change("q",v.slice(0,80))}/></div>
    <PageReads<NativeContent> view="contentMonitor" kind="saved-content-monitor" filters={filters} render={pages=>{
      const latest=pages.at(-1)!,posts=pages.flatMap(d=>d.posts);
      return <><RunLink id={latest.latestRunRef}/><KpiGrid>
        <KpiCard label="Observed views" context={latest.metricBasis ? `${latest.metricBasis.definition} · ${latest.metricBasis.semantics} · ${latest.metricBasis.window} · ${latest.metricBasis.context}` : "Comparable source basis unavailable"}>{value(latest.views)}</KpiCard>
        <KpiCard label="Engagement rate" context="Likes, comments and shares / views">{latest.rate===null?"Unknown":latest.rate.toFixed(1)+"%"}</KpiCard>
        <KpiCard label="Attributed orders" context="Reconciled attribution window">{value(latest.orders)}</KpiCard>
        <KpiCard label="Attributed net sales" context="After discounts and refunds">{latest.net?usdExact(latest.net):"Unknown"}</KpiCard>
      </KpiGrid><Card labelledBy="saved-posts"><SectionHeading id="saved-posts" title="Posts worth paying attention to." note={`${posts.length} of ${latest.total} saved posts. Missing components and unlike windows remain unknown.`}/>
        {posts.length?<DataTable caption="Saved campaign posts" variant="ledger" columns={[{label:"Post / creator"},{label:"Network / visibility"},{label:"Views"},{label:"Orders / net sales"},{label:"Last measurement"}]}
          rows={posts.map(p=>[<Link key={p.id} to={"/content/"+encodeURIComponent(p.id)}>{p.id} · {p.creator}</Link>,p.network+" · "+p.visibility,value(p.measurement?.views??null),
            value(postSales(p)?.orders??null)+" · "+(postSales(p)?.net?usdExact(postSales(p)!.net!):"Unknown"),stamp(p.measurement?.at??null)])}/>:
          <p>No matching saved campaign posts. Provider-wide post count is unknown.</p>}</Card></>;
    }}/>
  </section>;
}

export function NativeWatchlistPage(){
  const {get,change}=useFilters();
  const filters={source:get("source",sources.map(s=>s.value),"all"),state:get("state",["all","active","identity-review","excluded"],"all"),
    cohort:get("cohort",["all","only-launch-a"],"all")==="only-launch-a"?"launch-a":"all"};
  return <section className={`${a.page} ${m.native}`} data-figma-source="25:166" aria-labelledby="native-monitor-title">
    <Heading title="Know who the agent is watching." sub="Canonical intake and Sheets enrollment evidence for each profile."><LinkButton variant="secondary" to="/content">View monitor</LinkButton></Heading>
    {context("Watchlist intake and acquisition are distinct","New profiles require identity review. An enrollment receipt does not approve a message or offer.")}
    <div className={m.filtersRow}><SelectField label="Intake source" value={filters.source} options={sources} onChange={v=>change("source",v)}/>
      <SelectField label="Monitoring state" value={filters.state} options={options([["all","All states"],["active","Active"],["identity-review","Identity review"],["excluded","Excluded"]])} onChange={v=>change("state",v)}/>
      <SelectField label="Cohort" value={filters.cohort} options={options([["all","All cohorts"],["launch-a","Launch cohort A"]])} onChange={v=>change("cohort",v==="launch-a"?"only-launch-a":"all")}/></div>
    <PageReads<NativeWatchlist> view="watchlist" kind="saved-monitor-watchlist" filters={filters} render={pages=>{
      const latest=pages.at(-1)!,rows=pages.flatMap(d=>d.profiles);
      return <><KpiGrid><KpiCard label="Tracked profiles" context="Saved profile rows">{latest.total}</KpiCard><KpiCard label="Active monitoring" context="Current matching enrollment">{latest.active}</KpiCard>
        <KpiCard label="Identity review" context={`${latest.unverified} additional eligibility states unverified`}>{latest.pending}</KpiCard><KpiCard label="Excluded" context="Suppression or closed intake">{latest.excluded}</KpiCard></KpiGrid>
        <Card labelledBy="registry-heading"><SectionHeading id="registry-heading" title="The sheet is the tracking registry." note={`Showing ${rows.length} of ${latest.total} saved rows. A profile is not a distinct person.`}/>
          {rows.length?<DataTable caption="Canonical creator and profile evidence" variant="ledger" columns={[{label:"Creator / profile"},{label:"Intake / network"},{label:"Monitoring"},{label:"Source receipts"},{label:"Last check"}]}
            rows={rows.map(r=>[r.creator+" · "+(r.handle??r.profile??"Profile unknown"),(r.source??"Unknown")+" · "+(r.network??"Unknown"),r.state+" · "+r.reason,
              "Notion "+(r.notionReceipt??"unverified")+" · Sheets "+(r.sheetsReceipt??"unverified"),stamp(r.lastCheck)])}/>:<p>No matching local intake records. Provider enrollment is unknown.</p>}</Card></>;
    }}/>
  </section>;
}

export function NativeHourlyPage(){
  const {runId=""}=useParams();
  return <section className={`${a.page} ${m.native}`} data-figma-source="25:307" aria-labelledby="native-monitor-title">
    <Heading title="Every hourly check leaves evidence." sub="Read-only observations, incomplete checks and source recovery."><LinkButton variant="secondary" to="/content">Back to monitor</LinkButton></Heading>
    <PageReads<NativeRun> view="hourlyRun" kind="saved-monitor-run" filters={{runId}} render={pages=>{
      const r=pages.at(-1)!,checks=pages.flatMap(p=>p.checks);
      return <><KpiGrid><KpiCard label="Checked profiles" context={`Of ${r.snapshotSize} selected profiles`}>{r.counts.changed+r.counts.unchanged}</KpiCard>
        <KpiCard label="Unchanged" context="Confirmed source observations">{r.counts.unchanged}</KpiCard><KpiCard label="Failed / deferred" context="Separate recovery states">{r.counts.failed} / {r.counts.deferred}</KpiCard>
        <KpiCard label="Unknown / skipped" context={r.complete?"Complete finite snapshot":"Partial finite snapshot"}>{r.counts.unknown} / {r.counts.skipped}</KpiCard></KpiGrid>
        {!r.complete && <p role="status">{r.snapshotSize-Object.values(r.counts).reduce((total,n)=>total+n,0)} selected profiles have no recorded check outcome.</p>}
        <Card labelledBy="run-trace"><SectionHeading id="run-trace" title="Checkpointed, source by source." note={`Run ${r.runId} · observed ${stamp(r.runAt)} · ${r.runReceipt}`}/>
          <DataTable caption="Read-only run trace" variant="ledger" columns={[{label:"Profile / network"},{label:"Outcome / access"},{label:"Observed / last success"},{label:"Evidence / recovery"}]}
            rows={checks.map(c=>[c.profile+" · "+c.network,c.state+" · "+c.access,stamp(c.at)+" · "+stamp(c.lastSuccessAt),
              [c.receipt,c.checkpoint,c.reason,c.owner].filter(Boolean).join(" · ")||"Evidence unknown"])}/>
        </Card><Card labelledBy="run-policy"><SectionHeading id="run-policy" title="Hourly policy" />
          <DetailRow label="Recorded schedule" value={r.schedule}/><DetailRow label="Timezone" value={r.timezone??"Unknown"}/>
          <DetailRow label="Next run in snapshot" value={stamp(r.nextRun)}/><DetailRow label="Retry policy" value={r.retryPolicy??"Unverified"}/>
          <Link to="/settings/connections">Inspect source connections</Link>
          <Button disabledReason="A verified J08 retry authority for this exact profile is unavailable.">Retry failed profile</Button></Card>
        <Card labelledBy="run-events"><SectionHeading id="run-events" title="Observed events stay separate from inferred status."/>
          {r.observations.length?<DataTable caption="Observed source changes" columns={[{label:"Event"},{label:"Profile"},{label:"Observation"},{label:"Receipt"}]}
            rows={r.observations.map(e=>[e.kind+" · "+e.interpretation,e.profile,stamp(e.at),e.receipt])}/>:<p>No source events returned in this snapshot.</p>}</Card></>;
    }}/>
  </section>;
}

export function NativePostBody({data}:{data:NativePost}){
  const p=data.post,attribution=p.attribution,sales=postSales(p),metric=p.measurement;
  return <div className={`${m.nativeSections} ${m.native}`}><div className={a.titleRow}><div className={a.heading}><h1 id="post-title">One post. Its evidence and impact.</h1><p>{p.network} · {p.id} · Published {stamp(p.publishedAt)}</p></div>
    <LinkButton variant="secondary" to="/content">Back to monitor</LinkButton>
    {p.originalUrl && p.visibility==="public" && p.access==="authorized" && data.sourceState==="current" ? <a href={p.originalUrl} target="_blank" rel="noreferrer">Open source post</a>:
      <Button disabledReason="Current exact native post access is unverified.">Open source post</Button>}</div>
    <p role="status">{sourceLabels[data.sourceState]} · {p.conflict?"Conflicting evidence requires reconciliation.":`Visibility ${p.visibility} · access ${p.access}`}. Source as of {stamp(data.sourceAsOf)}.</p>
    <KpiGrid><KpiCard label="Views" context={metric?.definition??"Metric definition unavailable"}>{value(metric?.views??null)}</KpiCard>
      <KpiCard label="Engagement rate" context="Complete likes + comments + shares / views">{metric && metric.views!==null && metric.views>0 && metric.likes!==null && metric.comments!==null && metric.shares!==null ?
        ((metric.likes+metric.comments+metric.shares)*100/metric.views).toFixed(1)+"%":"Unknown"}</KpiCard>
      <KpiCard label="Attributed orders" context="Post-level matching required">{value(sales?.orders??null)}</KpiCard><KpiCard label="Attributed net sales" context="Retained, within the attribution window">{sales?.net?usdExact(sales.net):"Unknown"}</KpiCard></KpiGrid>
    <Card labelledBy="post-lineage"><SectionHeading id="post-lineage" title="Known, sourced and traceable"/>
      <DetailRow label="Campaign / asset lineage" value={p.campaign+" · "+(p.creative??"Creative unknown")+" · "+(p.deliverable??"Deliverable unknown")}/>
      <DetailRow label="Campaign assignment receipt" value={p.campaignReceipt}/>
      <DetailRow label="Publishing account / recruitment" value={p.account+" · "+p.enrollmentSource}/>
      <DetailRow label="Publication receipt" value={p.publicationReceipt}/><DetailRow label="Publication-age checkpoint" value={p.checkpointHours===null?"Unknown":p.checkpointHours+"h"}/>
      {p.collaborationRef && <Link to={"/collaborations/"+encodeURIComponent(p.collaborationRef)}>Open collaboration</Link>}
      <DataTable caption="Publication observation history" columns={[{label:"State"},{label:"Observation time"},{label:"Native receipt"}]}
        rows={data.publicationHistory.map(h=>[h.state,stamp(h.at),h.receipt])}/></Card>
    <Card labelledBy="post-metrics"><SectionHeading id="post-metrics" title="Source metric observations" note="Source snapshots retain their native window and counter basis."/>
      {data.history.length?<DataTable caption="Post metric observations" variant="ledger" columns={[{label:"Observed / receipt"},{label:"Definition / window"},{label:"Basis / context"},{label:"Views / interactions"},{label:"Cumulative change"}]}
        rows={data.history.map((h,i)=>{const prior=data.history[i-1],comparable=!p.conflict&&prior&&prior.semantics==="cumulative"&&h.semantics==="cumulative"&&
          h.definition===prior.definition&&h.window===prior.window&&h.context!=="unknown"&&h.context===prior.context&&h.views!==null&&prior.views!==null&&Date.parse(prior.at)!==Date.parse(h.at);
          return [stamp(h.at)+" · "+h.receipt,h.definition+" · "+h.window,h.semantics+" · "+h.context,value(h.views)+" views · "+
            [value(h.likes),value(h.comments),value(h.shares)].join(" / ")+" likes / comments / shares",comparable?value(h.views!-prior.views!):"Unknown"];})}/>:<p>No comparable native measurements are available.</p>}</Card>
    <Card labelledBy="post-sales"><SectionHeading id="post-sales" title="Sales require an order match."/>
      <DetailRow label="Attribution level" value={attribution?.level??"Unknown"}/><DetailRow label="Window / receipt" value={attribution?attribution.window+" · "+attribution.receipt:"Unknown"}/>
      {attribution && attribution.level!=="post" && <DetailRow label={attribution.level+"-level outcomes"} value={value(attribution.orders)+" orders · "+
        (attribution.net?usdExact(attribution.net):"Net sales unknown")+". No share is assigned to this post."}/>}
      <DetailRow label="TikTok native GMV" value={p.network!=="tiktok"?"Not applicable":attribution?.gmv?usdExact(attribution.gmv)+" · "+attribution.gmvDefinition:"Unknown"}/>
    </Card>
  </div>;
}
