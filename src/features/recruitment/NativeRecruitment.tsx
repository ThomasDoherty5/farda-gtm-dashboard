import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import type { NativeRecruitmentView } from "@/creator-agent/readViews";
import { scorecardPreviewPath, type ScorecardSelection } from "@/creator-agent/scorecardPreview";
import { Button, LinkButton } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { DataTable } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { decisionLabel } from "@/features/acquisition/AgentQualification";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { CommercialEligibility } from "@/features/commercial/CommercialEligibility";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { commercialAssessmentPath } from "@/features/commercial/selection";
import { PageTitle, Pending, SourceButton, StaleNotice } from "@/features/creators/creatorsShared";
import { ContextBox, Steps, acquisition, creators } from "./recruitmentShared";

const networks = [{value:"both",label:"Instagram + TikTok"},{value:"instagram",label:"Instagram"},{value:"tiktok",label:"TikTok"}];
const routes = [{value:"queue",label:"Campaign applicants"},{value:"inbound",label:"Inbound applications"},{value:"outbound",label:"Found by us"}];
type Filters = NativeRecruitmentView["filters"];
const offerLink = (row: NativeRecruitmentView["rows"][number]) => `/offers/${encodeURIComponent(row.offerId!)}?${new URLSearchParams({...(row.offerVersion ? {offerVersion:row.offerVersion}:{}),phase:row.phase})}`;
const exactSelection = (row: NativeRecruitmentView["rows"][number]): ScorecardSelection[number] | null => row.runId === null ? null : ({
  creatorId:row.creatorId,runId:row.runId,...(row.offerId===null?{}:{offerId:row.offerId}),...(row.offerVersion===null?{}:{offerVersion:row.offerVersion}),phase:row.phase,
});

/** Source membership is supplied by the service; local offers never create a recruitment queue. */
export function NativeRecruitment() {
  const [search,setSearch]=useSearchParams();
  const network=search.get("networks"),route=search.get("route");
  const filters:Filters={networks:network==="instagram"||network==="tiktok"?network:"both",route:route==="inbound"||route==="outbound"?route:"queue"};
  const query=useView<Filters,NativeRecruitmentView>("recruitmentQueue",filters,null);
  const data=query.data?.data;
  const leaseCurrent=useSourceLease(data?.validUntil);
  const sameFilters=data?.filters.networks===filters.networks&&data.filters.route===filters.route;
  const current=!!data&&sameFilters&&leaseCurrent&&!query.isError&&!query.isFetching&&!query.isPlaceholderData&&query.data?.dataState!=="stale";
  const setFilter=(key:keyof Filters,value:string)=>{const next=new URLSearchParams(search);next.set(key,value);setSearch(next);};
  return <section aria-labelledby="rec-title" data-figma-source="38:131" className={acquisition.page}>
    <PageTitle id="rec-title" title="Find the right creators. Move every match forward." subtitle="Source-confirmed recruitment membership · content and commercial checks stay separate">
      <SourceButton label="Open Social Cat" title="Open Social Cat" width={176}/><Button variant="secondary" onClick={()=>void query.refetch()}>Refresh recruitment evidence</Button>
    </PageTitle>
    <nav className={creators.contextActions} aria-label="Recruitment views"><LinkButton variant="primary" aria-current="page" to="/creators/social-cat/recruitment">Recruitment queue</LinkButton><LinkButton variant="secondary" to="/creators/discovery">Daily sourcing</LinkButton><LinkButton variant="secondary" to="/creators/pipeline">Full acquisition funnel</LinkButton></nav>
    <ContextBox title="Commission-only acquisition" text="A content assessment does not establish commercial agreement. Review the exact saved offer and its current phase before requesting a source approval."/>
    <div className={creators.row}><FilterButton name="Publishing networks" title="Choose publishing networks" options={networks} value={filters.networks} onChange={v=>setFilter("networks",v)} bare/><FilterButton name="Route" title="Choose the recruitment route" options={routes} value={filters.route} onChange={v=>setFilter("route",v)} bare/><LinkButton variant="secondary" to="/creators/discovery">Find Creators</LinkButton></div>
    <Pending query={query} subject="the recruitment queue">
      {data && !leaseCurrent && <p role="status">The source membership lease expired. Rows are retained evidence; refresh before selecting new work.</p>}
      {data?.kind==="native-recruitment" && sameFilters && query.data && !query.isError && !query.isFetching && !query.isPlaceholderData && <><StaleNotice res={query.data}/><SourceQueue data={data} current={current}/></>}
      {data && (!sameFilters || data.kind!=="native-recruitment") && <EmptyState state="Error" title="Recruitment source mismatch" alert><p>No queue is displayed because the returned source context does not match the selected filters.</p></EmptyState>}
    </Pending>
    <section className={creators.panel} aria-labelledby="rec-flow-title"><h2 id="rec-flow-title" className={acquisition.h2}>Keep each lifecycle step bound to its source.</h2><Steps label="Recruitment flow" steps={["Discover + dedupe","Score + evidence","Approve action","Invite + agree","Sample + create","Verify + settle"]}/><p className={acquisition.small}>These are workflow stages, not evidence that a creator has completed them. Native match, accepted obligations, shipment, publication and settlement require their own source records.</p></section>
    <div className={creators.pairWide}>
      <section className={creators.panel} aria-labelledby="rec-terms-title"><h2 id="rec-terms-title" className={acquisition.h2}>Terms, per publishing network.</h2><p>Select an exact saved offer from a source row to inspect or edit proposed deliverables, commission, rights, sample allocation and delivery window.</p><p className={acquisition.small}>No recipient, rate, content obligation or delivery date is inferred from the queue. Changes must be saved and reviewed as a new exact version.</p></section>
      <section className={`${creators.panel} ${creators.panelViolet}`} aria-labelledby="rec-invite-title"><h2 id="rec-invite-title" className={acquisition.h2}>Review a finite invitation set.</h2><p>Select source rows above to inspect their exact saved assessments and offers. A preview does not approve, send or accept an invitation.</p><p className={acquisition.small}>Invitation wording and source execution are not included in this read-only queue.</p></section>
    </div>
    <section className={creators.panel} aria-labelledby="rec-match-title"><h2 id="rec-match-title" className={acquisition.h2}>A match is the beginning.</h2><div className={creators.contextActions}>
      <Button disabledReason="Needs source-confirmed acceptance plus separately approved stock and cost.">Sample after acceptance</Button><Button disabledReason="Needs applicable accepted content obligations.">Content after agreement</Button><Button disabledReason="Needs an explicit rights scope and term; affiliation grants no reuse rights.">Rights to agree</Button><LinkButton variant="secondary" to="/finance/commissions">Commission ledger</LinkButton><LinkButton variant="secondary" to="/content">Content monitor</LinkButton>
    </div></section>
    <section className={creators.panel} aria-labelledby="rec-policy-title"><h2 id="rec-policy-title" className={acquisition.h2}>Current policy. Separate settlement responsibilities.</h2><p>New acquisition is commission-only. Accepted historical content fees and earned rewards stay in their original records. The external affiliate provider owns attribution and settlement; current permission, accepted terms, sample authority and reuse rights are separate checks.</p><LinkButton variant="secondary" to="/settings/capabilities">Channel access and capacity</LinkButton></section>
  </section>;
}

function SourceQueue({data,current}:{data:NativeRecruitmentView;current:boolean}) {
  const basis=JSON.stringify([data.sourceAlias,data.filters,data.rows.map(r=>[r.opportunityRef,r.creatorId,r.runId,r.offerId,r.offerVersion,r.phase])]);
  const [selection,setSelection]=useState<{basis:string;refs:string[]}>({basis,refs:[]});
  const selected=selection.basis===basis?selection.refs:[];
  const members=data.rows.filter(r=>selected.includes(r.opportunityRef)).flatMap(r=>{const m=exactSelection(r);return m?[m]:[];});
  const reviewLabel=members.some(member=>member.phase!=="invitation")?"Review selected commercial set":"Review selected invitation set";
  const toggle=(ref:string,checked:boolean)=>setSelection({basis,refs:checked?[...selected,ref]:selected.filter(r=>r!==ref)});
  return <div className={creators.pairWide}>
    <section className={creators.panel} aria-labelledby="rec-queue-title"><h2 id="rec-queue-title" className={acquisition.h2}>Focus on the next useful action.</h2>
      <p>{data.coverage.returned} source rows returned · {data.coverage.total===null?"Total unknown":`${data.coverage.total} in the reported source set`} · {data.coverage.complete?"Complete reported set":"Partial source coverage"}.</p>
      <p className={acquisition.small}>Verified at {data.observedAt} · Valid until {data.validUntil}. Source membership does not authorize contact.</p>
      {data.rows.length===0?<p role="status">The source returned no matching rows. This is not a claim about creators outside this reported source set.</p>:<DataTable caption="Recruitment queue" minWidth={980} columns={[{label:"Select"},{label:"Creator / source context"},{label:"Content qualification"},{label:"Current commercial eligibility"},{label:"Exact saved records"}]}
        rows={data.rows.map((row,index)=>{
          const member=exactSelection(row);
          return [<Checkbox key={row.opportunityRef} label={`Select source row ${index+1}`} checked={selected.includes(row.opportunityRef)} disabled={!current||member===null||(!selected.includes(row.opportunityRef)&&(members.length>=25||members.some(m=>m.creatorId===row.creatorId)))} onChange={v=>toggle(row.opportunityRef,v)}/>,<div key={row.opportunityRef}>{row.creatorId}<p>{row.network} · {row.route}</p></div>,<div key={row.opportunityRef}>{row.assessment?`${row.assessment.stale?"Stale · ":""}${decisionLabel[row.assessment.state]} · Score ${row.assessment.score??"Unknown"}`:"Assessment unavailable"}</div>,<CommercialEligibility key={row.opportunityRef} data={row.commercialEligibility} compact current={current}/>,<div key={row.opportunityRef} className={acquisition.stack}>{member?<LinkButton variant="secondary" to={commercialAssessmentPath(row.creatorId,member.runId,member)}>Review saved assessment</LinkButton>:<p>Exact assessment unavailable; this row cannot enter a finite preview.</p>}{row.offerId?<LinkButton variant="secondary" to={offerLink(row)}>Review saved offer</LinkButton>:<p>No exact offer selected.</p>}</div>];
        })}/>}
      <p className={acquisition.small}>{members.length} selected · maximum 25 exact creators, one row per creator. A source row with no saved assessment cannot be included.</p>
      {current&&members.length>0?<LinkButton to={scorecardPreviewPath(members)}>{reviewLabel}</LinkButton>:<Button disabledReason={!current?"Refresh current source evidence before selecting new work.":"Choose at least one source row with an exact saved assessment."}>{reviewLabel}</Button>}
    </section>
    <section className={`${creators.panel} ${creators.panelDark}`} aria-labelledby="rec-plan-title"><h2 id="rec-plan-title" className={acquisition.h2} style={{color:"var(--color-onDark)"}}>Plan and capacity</h2><p>Unknown</p><p className={acquisition.small}>The recruitment source does not return plan price, remaining invitation quota, collaboration slots, sample stock or renewal time. Returned queue rows are not available capacity.</p><LinkButton variant="secondary" to="/settings/capabilities">Inspect source access and capacity</LinkButton></section>
  </div>;
}
