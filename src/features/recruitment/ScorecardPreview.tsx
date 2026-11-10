import { useView } from "@/adapter/useView";
import { LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { CommercialEligibility } from "@/features/commercial/CommercialEligibility";
import commercialStyles from "@/features/commercial/CommercialEligibility.module.css";
import { commercialAssessmentPath } from "@/features/commercial/selection";
import { evidenceReviewPath } from "@/features/acquisition/creatorReviewPaths";
import { Pending } from "@/features/creators/creatorsShared";
import type { ScorecardPreview, ScorecardSelection } from "@/creator-agent/scorecardPreview";
import { BareTitle, acquisition } from "./recruitmentShared";

export function ScorecardPreviewPage({ selection }: {selection: ScorecardSelection}) {
  const filters = {batchId: "scorecard-preview", selection};
  const query = useView<typeof filters, ScorecardPreview>("batchDetail", filters, null);
  const data = query.data?.data;
  const positive=data?.items.filter(item=>item.commercialEligibility?.state==="eligible")??[];
  const deadlines=positive.map(item=>item.commercialEligibility?.validity?.validUntil);
  const finiteDeadlines=deadlines.filter((value):value is string=>typeof value==="string"&&Number.isFinite(Date.parse(value)));
  const earliest=finiteDeadlines.length?new Date(Math.min(...finiteDeadlines.map(Date.parse))).toISOString():null;
  const leaseCurrent=useSourceLease(earliest);
  const current = !query.isError && !query.isFetching && !query.isPlaceholderData && query.data?.dataState !== "stale";
  const countKnown=current&&data?.items.every(item=>item.commercialEligibility!==undefined)&&(!positive.length||(deadlines.length===finiteDeadlines.length&&leaseCurrent));
  return <section aria-labelledby="batch-title" className={acquisition.page} data-figma-source="66:821">
    <BareTitle id="batch-title" title={selection.some(member=>member.phase!==undefined && member.phase!=="invitation")?"Finite commercial review":"Invitation preview"} />
    <LinkButton variant="secondary" to="/creators/discovery">Choose saved assessments</LinkButton>
    <Pending query={query} subject="the invitation preview">
      {data?.kind === "agent-scorecard-preview" && (data.selectedCount ? <section className={acquisition.card}>
        <h2 className={acquisition.h2}>{data.selectedCount} selected · {data.items.filter(i => i.status === "eligible").length} content-qualified · {countKnown ? positive.length : "Unknown"} commercially eligible</h2>
        <p className={acquisition.small}>Read-only finite preview. Saved content qualification and current commercial eligibility are separate. Approval and sending require their own exact source evidence.</p>
        <DataTable caption="Selected invitation assessments" columns={[{label:"Creator and saved assessment"},{label:"Route and score"},{label:"Evidence and terms"},{label:"Content review status"},{label:"Current commercial eligibility"}]}
          rows={data.items.map(i => [
            i.status === "unavailable" ? i.creatorId : <LinkButton key={i.runId} variant="secondary" to={commercialAssessmentPath(i.creatorId,i.runId,selection.find(m=>m.creatorId===i.creatorId && m.runId===i.runId))}>{i.creatorId}</LinkButton>,
            <div key={i.runId} className={acquisition.stack}>{i.route ?? "Unknown route"} · {i.score ?? "Unknown score"}<br/>{i.modelId ?? "Unknown model"}<br/>
              <details><summary>Score basis</summary><p className={commercialStyles.reference}>{i.configHash ?? "Unknown configuration"}</p>{i.criteria.map(c => <p key={c.id}>{c.id} · {c.weight}% · {c.rating ?? "Unknown"} / 5</p>)}</details>
            </div>,
            <div key={i.runId} className={commercialStyles.reference}>{i.evidenceRevision ?? "Evidence unknown"} · {i.termsRevision ?? "Terms version unknown"}<br/>
              {i.evidencePostId && <LinkButton variant="ghost" to={evidenceReviewPath(i.creatorId,i.evidencePostId)}>View evidence</LinkButton>}
              <p>{i.acceptedOffer ? `Accepted offer ${i.acceptedOffer.offerId} · ${i.acceptedOffer.version}` : "Acceptance unverified"}</p>
            </div>,
            <div key={i.runId}>{i.stale ? "Stale · review needed" : i.status === "eligible" ? "Content-qualified for invitation review" : i.status === "hold" ? "Hold" : i.status === "unavailable" ? "Exact run unavailable" : "Review needed"}<br/>{i.reasonCodes.join(", ")}</div>,
            <CommercialEligibility key={`commercial-${i.runId}`} data={i.commercialEligibility} compact current={current}/>,
          ])} />
      </section> : <EmptyState state="Empty" title="No assessments selected"><p>Choose the exact creator assessments to preview from daily sourcing.</p></EmptyState>)}
    </Pending>
  </section>;
}
