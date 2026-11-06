import { useView } from "@/adapter/useView";
import { LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { creatorAssessmentPath, evidenceReviewPath } from "@/features/acquisition/creatorReviewPaths";
import { Pending } from "@/features/creators/creatorsShared";
import type { ScorecardPreview, ScorecardSelection } from "@/creator-agent/scorecardPreview";
import { BareTitle, acquisition } from "./recruitmentShared";

export function ScorecardPreviewPage({ selection }: {selection: ScorecardSelection}) {
  const filters = {batchId: "scorecard-preview", selection};
  const query = useView<typeof filters, ScorecardPreview>("batchDetail", filters, null);
  const data = query.data?.data;
  return <section aria-labelledby="batch-title" className={acquisition.page} data-figma-source="66:821">
    <BareTitle id="batch-title" title="Invitation preview" />
    <LinkButton variant="secondary" to="/creators/discovery">Choose saved assessments</LinkButton>
    <Pending query={query} subject="the invitation preview">
      {data?.kind === "agent-scorecard-preview" && (data.selectedCount ? <section className={acquisition.card}>
        <h2 className={acquisition.h2}>{data.selectedCount} selected · {data.items.filter(i => i.status === "eligible").length} eligible for invitation review</h2>
        <p className={acquisition.small}>Read-only preview. Approval and sending are separate actions.</p>
        <DataTable caption="Selected invitation assessments" columns={[{label:"Creator and saved assessment"},{label:"Route and score"},{label:"Evidence and terms"},{label:"Review status"}]}
          rows={data.items.map(i => [
            i.status === "unavailable" ? i.creatorId : <LinkButton key={i.runId} variant="secondary" to={creatorAssessmentPath(i.creatorId,i.runId)}>{i.creatorId}</LinkButton>,
            <div key={i.runId} className={acquisition.stack}>{i.route ?? "Unknown route"} · {i.score ?? "Unknown score"}<br/>{i.modelId ?? "Unknown model"}<br/>
              <details><summary>Score basis</summary><p>{i.configHash ?? "Unknown configuration"}</p>{i.criteria.map(c => <p key={c.id}>{c.id} · {c.weight}% · {c.rating ?? "Unknown"} / 5</p>)}</details>
            </div>,
            <div key={i.runId}>{i.evidenceRevision ?? "Evidence unknown"} · {i.termsRevision ?? "Terms version unknown"}<br/>
              {i.evidencePostId && <LinkButton variant="ghost" to={evidenceReviewPath(i.creatorId,i.evidencePostId)}>View evidence</LinkButton>}
              <p>{i.acceptedOffer ? `Accepted offer ${i.acceptedOffer.offerId} · ${i.acceptedOffer.version}` : "Acceptance unverified"}</p>
            </div>,
            <div key={i.runId}>{i.stale ? "Stale · review needed" : i.status === "eligible" ? "Eligible for invitation review" : i.status === "hold" ? "Hold" : i.status === "unavailable" ? "Exact run unavailable" : "Review needed"}<br/>{i.reasonCodes.join(", ")}</div>,
          ])} />
      </section> : <EmptyState state="Empty" title="No assessments selected"><p>Choose the exact creator assessments to preview from daily sourcing.</p></EmptyState>)}
    </Pending>
  </section>;
}
