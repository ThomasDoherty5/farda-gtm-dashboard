import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { usePagedView } from "@/adapter/usePagedView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { SkeletonCard } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { DetailRows, Panel, Row, Small } from "@/components/PageKit";
import { SectionTabs } from "@/components/SectionTabs";
import { ViewError } from "@/components/ViewError";
import { useScope } from "@/adapter/scope";
import { scopeKey } from "@/adapter/scope";
import { SCHEMA_VERSION } from "@/adapter/contract";
import { useQueryClient } from "@tanstack/react-query";
import type { CreatorPlatformFilters, CreatorPlatformKey, PlatformMetric, PlatformRow, SavedCreatorPlatform } from "@/creator-agent/creatorPlatformViews";
import { PageTitle } from "./creatorsShared";
import styles from "./Creators.module.css";
import live from "./SavedCreatorPlatform.module.css";

const views = {
  socialCatBoard: ["Social Cat","Creators, from hello to impact.","6:24"], socialCatDashboard: ["Social Cat","Social Cat","23:275"],
  tiktokBoard: ["TikTok","TikTok Shop, built on relationships.","9:143"], tiktokDashboard: ["TikTok","TikTok Shop","23:440"],
} as const;
const phases: Record<string, string> = {
  discovered:"Prospects", directReviewed:"Qualification", qualified:"Qualification", approval:"Invitations", queued:"Invitations", attempt:"Invitations",
  uncertain:"Invitations", confirmedSent:"Invitations", reply:"Negotiation", matched:"Negotiation", terms:"Onboarding", tracking:"Onboarding",
  sampleRequested:"Onboarding", noSample:"Onboarding", sampleApproved:"Onboarding", sampleShipped:"Onboarding", sampleDelivered:"Onboarding",
  briefAccepted:"Production", productionSubmitted:"Production", productionBlocked:"Production", contentAccepted:"Revision and review",
  publicationPlanned:"Posting", scheduled:"Posting", published:"Posting", removed:"Posting", adAuthorized:"Posting",
  retainedOrder:"Measurement", refund:"Measurement", postMetrics:"Measurement", paid:"Measurement", settled:"Measurement", legacyPayable:"Measurement",
  review:"Repeat and close", repeatEligible:"Repeat and close", repeatParticipation:"Repeat and close", expired:"Repeat and close", declined:"Repeat and close", optOut:"Repeat and close",
};
const phaseOrder = [...new Set(Object.values(phases)),"Unmapped"];
const words = (value: string) => value.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/-/g," ").replace(/^./,c=>c.toUpperCase());
const stamp = (value: string | null) => value ? new Intl.DateTimeFormat("en-US",{ dateStyle:"medium",timeStyle:"short",timeZone:"UTC" }).format(new Date(value))+" UTC" : "Unknown";
const known = (values: string[]) => values.length ? values.join(", ") : "Unknown";
const path = (view: CreatorPlatformKey) => view.startsWith("socialCat") ? "/creators/social-cat" : "/creators/tiktok";
function metricText(metric: PlatformMetric) {
  if (metric.value === null) return "Unavailable";
  const monetary = /^([A-Z]{3}) minor units$/.exec(metric.unit);
  if (metric.label === "Attributed net sales" && monetary) {
    const formatter = new Intl.NumberFormat("en-US",{ style:"currency",currency:monetary[1] });
    return formatter.format(metric.value / (10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2)));
  }
  const value = new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(metric.value);
  return metric.unit === "%" ? value+"%" : value;
}

function Details({ row }: { row: PlatformRow }) {
  return <>
    <DetailRows rows={[["Creator",row.creator],["Acquisition account",row.account],["Opportunity",row.opportunity],
      ["Current work stage",words(row.stage)],["Owner",row.owner ?? "Unknown"],["Next action",row.nextAction],["Due",stamp(row.dueAt)],
      ["Updated source evidence",stamp(row.observedAt)],["Stage age",row.ageDays === null ? "Unknown" : Math.floor(row.ageDays)+" days"],
      ["Blockers",row.blockers.length ? row.blockers.join(", ") : "None recorded"],["Publishing network",known(row.networks)],
      ["Checkout",known(row.checkouts)],["Payout owner",known(row.payouts)],["Saved terms evidence",row.terms],["Prior qualification evidence",row.qualification],["Current scoring model", "Unknown from the saved funnel"],
      ["Policy reference",row.policyVersion],["Historical payable",row.historicalPayable ? "Source observation saved" : "No saved observation"]]} />
    {row.collaborations.map(ref => <Row key={ref}>
      <LinkButton variant="secondary" to={"/collaborations/"+encodeURIComponent(ref)+"?tab=content"}>Content and publication</LinkButton>
      <LinkButton variant="secondary" to={"/collaborations/"+encodeURIComponent(ref)+"?tab=overview"}>Collaboration and renewal evidence</LinkButton>
    </Row>)}
    {row.deliveries.length > 0 && <DataTable caption="Deliverable observations" columns={[{label:"Deliverable"},{label:"State"},{label:"Last observed"}]}
      rows={row.deliveries.map(d => [d.id,words(d.state),stamp(d.observedAt)])} />}
    <Small>Showing the latest {row.evidence.length} of {row.historyTotal} saved observations.</Small>
    <ol aria-label="Recent source observations" className={live.history}>{row.evidence.map((e,i) => <li key={i}>{words(e.state)} · {stamp(e.observedAt)}</li>)}</ol>
  </>;
}
function ActionsTable({ rows, open }: { rows: PlatformRow[]; open: (id: string) => void }) {
  return <DataTable caption="Current saved opportunities" columns={[{label:"Creator / stage"},{label:"Owner and next action"},{label:"Due / age"},{label:"Blocker / freshness"},{label:"Evidence"}]}
    rows={rows.map(r => [<span key="creator">{r.creator}<br />{words(r.stage)}</span>,<span key="action">{r.owner ?? "Owner unknown"}<br />{r.nextAction}</span>,
      <span key="due">{stamp(r.dueAt)}<br />{r.ageDays === null ? "Age unknown" : Math.floor(r.ageDays)+" days in stage"}</span>,
      <span key="status">{r.blockers[0] ?? "No saved blocker"}<br />{stamp(r.observedAt)}</span>,
      <Button key="e" variant="secondary" aria-haspopup="dialog" onClick={()=>open(r.id)}>Inspect opportunity</Button>])} />;
}
function StageChart({ data }: { data: SavedCreatorPlatform }) {
  const counts = phaseOrder.map(phase => [phase,data.stages.filter(s=>(phases[s.state] ?? "Unmapped")===phase).reduce((n,s)=>n+s.count,0)] as const);
  return <Panel title="Current work stages" headingId="current-stages" note="Each saved opportunity appears once in its current stage.">
    <ul aria-label="Exclusive current stages and counts" className={live.stageCounts}>{counts.map(([label,count])=>
      <li key={label}><span>{label}</span><span className={live.track} aria-hidden="true"><span style={{width:(data.total?100*count/data.total:0)+"%"}} /></span><strong>{count}</strong></li>)}</ul>
  </Panel>;
}
function Snapshot({ data, rows, board, layout, open }: { data: SavedCreatorPlatform; rows: PlatformRow[]; board: boolean; layout: string; open: (id:string)=>void }) {
  return <>
    <KpiRow columns={4}>{data.metrics.map(metric => <Kpi key={metric.label} label={metric.label}
      context={metric.reason ?? `${metric.denominator ?? "Unknown"} denominator · ${metric.window ?? "window unknown"}`}>{metricText(metric)}</Kpi>)}</KpiRow>
    <Panel title="Source and cohort" headingId="platform-coverage" note="Figures summarize saved observations for the acquisition source. Provider-wide totals are unknown.">
      <DetailRows rows={[["Acquisition source",data.platform],["Saved opportunities / creators",data.total+" / "+data.observedCreators],["Saved observations",String(data.observedEvents)],
        ["Cohort start / end (exclusive)",(data.cohortStart ?? "Earliest saved")+" / "+(data.cohortEnd ?? "Through snapshot")],
        ["Publishing networks",known(data.sourceNetworks)],["Source windows",known(data.sourceWindows)],["Latest source observation",stamp(data.latestObservation)],
        ["Ledger read as of",stamp(data.asOf)],["Access gaps / unmapped observations",data.sourceOutages+" / "+data.unknownStates]]} />
    </Panel>
    <StageChart data={data} />
    {!board && data.platform === "TikTok" && <Panel title="Checkout and payout ownership" headingId="payout-lanes" note="A TikTok publication does not establish a TikTok Shop order.">
      <DataTable caption="Recorded checkout and payout lanes" columns={[{label:"Checkout route"},{label:"Payout owner"},{label:"Saved opportunities"}]} rows={data.checkoutLanes.map(lane=>[lane.checkout,lane.payout,lane.opportunities])}/>
    </Panel>}
    {!board && <Panel title={data.platform==="Social Cat" ? "Linked Instagram and TikTok insights" : "Publishing evidence"} headingId="native-insights"
      note={`The latest ${data.postSamples.length} of ${data.postSampleTotal} saved post snapshots. Figures require publishing-account evidence.`}>
      {data.postSamples.length ? <DataTable caption="Native post insights and coverage" columns={[{label:"Post / network"},{label:"Views"},{label:"Engagements"},{label:"Window / observation"}]}
        rows={data.postSamples.map(post=>[post.post+" · "+post.network,post.views ?? "Unavailable",post.engagements ?? "Unavailable",
          <span key="time">{post.window ?? "Unknown window"}<br/>{stamp(post.observedAt)}<br/>{post.sourceVerified ? "Native source verified" : "Native evidence unavailable"}</span>])}/> :
        <p>No native post snapshot is saved for this selection.</p>}
    </Panel>}
    {!board && <Panel title="Acquisition achievements" headingId="achievements" note="An opportunity can reach several milestones. Match and accepted terms have distinct receipts.">
      <DataTable caption="Overlapping acquisition achievements" columns={[{label:"Milestone"},{label:"Saved opportunities reached"}]} rows={data.achievements.map(a=>[words(a.state),a.count])} />
    </Panel>}
    <Panel title={board ? "Platform work board" : "Action queue"} headingId="platform-queue" note={`Showing ${rows.length} of ${data.total} saved opportunities.`}>
      {!rows.length && <p>No opportunities match these filters in the saved ledger. Provider activity is unknown.</p>}
      {rows.length > 0 && (board && layout !== "list" && !(data.platform === "TikTok" && layout === "default") ? <div className={live.board}>{phaseOrder.filter(phase=>rows.some(r=>(phases[r.stage]??"Unmapped")===phase)).map(phase=>
        <section key={phase} className={styles.column}><h3>{phase}</h3>{rows.filter(r=>(phases[r.stage]??"Unmapped")===phase).map(r=>
          <article key={r.id} className={live.card}><Badge>{words(r.stage)}</Badge><h4>{r.creator}</h4><p>{r.owner ?? "Owner unknown"} · {r.nextAction}</p>
            <Small>Due {stamp(r.dueAt)} · {r.ageDays === null ? "age unknown" : Math.floor(r.ageDays)+" days in stage"}</Small>
            <Small>{r.blockers[0] ?? "No saved blocker"} · observed {stamp(r.observedAt)}</Small>
            <Button variant="secondary" aria-haspopup="dialog" onClick={()=>open(r.id)}>Inspect opportunity</Button></article>)}</section>)}</div> : <ActionsTable rows={rows} open={open}/>)}
    </Panel>
  </>;
}

export function SavedCreatorPlatformPage({ viewKey }: { viewKey: CreatorPlatformKey }) {
  const [params,setParams] = useSearchParams();
  const [selection,setSelection] = useState<string | null>(null);
  const context = useScope(), client = useQueryClient();
  const [platform,title,source] = views[viewKey], board = viewKey.endsWith("Board");
  const queryText = params.get("q") ?? "", owner = params.get("owner") ?? "", network = params.get("network") ?? "all";
  const filters: CreatorPlatformFilters = { ...(queryText ? {q:queryText} : {}), ...(owner ? {owner} : {}),
    ...(network !== "all" && ["instagram","tiktok","other","unknown"].includes(network) ? {network:network as CreatorPlatformFilters["network"]} : {}),
    ...(params.get("start") ? {start:params.get("start")!} : {}), ...(params.get("end") ? {end:params.get("end")!} : {}) };
  const query = usePagedView<CreatorPlatformFilters,SavedCreatorPlatform>(viewKey,filters,null,25);
  const pages = query.data?.pages ?? [], first = pages[0]?.data;
  const records: PlatformRow[] = [];
  const ids = new Set<string>();
  let valid = true;
  for (const response of pages) {
    const page = response.data;
    if (!page || page.kind!=="saved-creator-platform" || page.viewKey!==viewKey || page.platform!==platform || page.offset !== records.length ||
        page.asOf!==first?.asOf || page.total!==first?.total || page.records.some(r=>ids.has(r.id))) { valid=false; break; }
    for (const row of page.records) { if (ids.has(row.id)) valid=false; ids.add(row.id); records.push(row); }
  }
  const data = valid ? first : undefined;
  const selected = data ? records.find(r=>r.id===selection) : null;
  const set = (key:string, value:string) => { const next=new URLSearchParams(params); if(value && value!=="all")next.set(key,value);else next.delete(key);
    setSelection(null);setParams(next,{replace:true}); };
  const tab = (target:CreatorPlatformKey) => { const next = new URLSearchParams(params); next.set("view",target.endsWith("Board")?"board":"dashboard");
    return path(target)+"?"+next.toString(); };
  const restart = () => client.resetQueries({queryKey:[...scopeKey(context),SCHEMA_VERSION,"cursor-pages",viewKey,filters,null,25],exact:true});
  return <section aria-labelledby="creator-platform-title" className={styles.page} data-figma-source={source}>
    <PageTitle id="creator-platform-title" title={title} subtitle={platform+" · saved creator work and source observations"}>
      <LinkButton variant="secondary" to="/creators/discovery">Daily sourcing</LinkButton>
      <LinkButton variant="secondary" to="/content">Hourly monitoring</LinkButton>
    </PageTitle>
    <SectionTabs label="Creator platform views" tabs={(Object.keys(views) as CreatorPlatformKey[]).map(key=>({label:views[key][0]+" "+(key.endsWith("Board")?"board":"dashboard"),to:tab(key),current:key===viewKey}))}/>
    <Panel title="Recruitment terms and source scope" headingId="platform-policy">
      <p>New invitations are commission-only. Samples require separate approval. Historical commitments remain visible in their owning records.</p>
      <LinkButton variant="secondary" to="/creators/pipeline">Full acquisition funnel</LinkButton>
    </Panel>
    <div className={live.filters}>
      <label>Search saved opportunities<input type="search" value={queryText} onChange={e=>set("q",e.target.value)}/></label>
      <label>Owner<input value={owner} onChange={e=>set("owner",e.target.value)} placeholder="All owners"/></label>
      <label>Publishing network<select value={network} onChange={e=>set("network",e.target.value)}>{["all","instagram","tiktok","other","unknown"].map(v=><option key={v} value={v}>{words(v)}</option>)}</select></label>
      <label>Cohort start<input type="date" value={params.get("start")??""} onChange={e=>set("start",e.target.value)}/></label>
      <label>Cohort end (exclusive)<input type="date" value={params.get("end")??""} onChange={e=>set("end",e.target.value)}/></label>
      {board && <label>Layout<select value={params.get("layout")??(platform==="TikTok"?"list":"board")} onChange={e=>set("layout",e.target.value)}><option value="board">Board</option><option value="list">List</option></select></label>}
    </div>
    {query.isPending && <SkeletonCard label="Loading saved creator work…"/>}
    {query.isError && <Small>Use a narrower cohort window if the source reports that this read is too large.</Small>}
    {query.isError && <ViewError subject="Creator platform observations" error={query.error} hasPriorData={Boolean(data)} onRetry={()=>void restart()}/>}
    {!valid && <p role="alert">The saved list does not match this view. <Button onClick={()=>void restart()}>Reload list</Button></p>}
    {data && <><Snapshot data={data} rows={records} board={board} layout={params.get("layout")??"default"} open={setSelection}/>
      {query.hasNextPage && <Button variant="secondary" loading={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage({cancelRefetch:false})}>Load more opportunities</Button>}</>}
    <Dialog open={!!selected} title="Opportunity evidence" onClose={()=>setSelection(null)}><Button variant="secondary" style={{position:"sticky",top:0,zIndex:1}} onClick={()=>setSelection(null)}>Close</Button>
      {selected && <Details row={selected}/>}</Dialog>
  </section>;
}
