import { useParams } from "react-router-dom";
import type { AssessmentData } from "@/adapter/demoScorecards";
import { useView } from "@/adapter/useView";
import type { AgentAssessmentRecord } from "@/creator-agent/readViews";
import { Alert } from "@/components/Alert";
import { LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { AcquisitionTabs } from "@/features/acquisition/AcquisitionTabs";
import { QualificationDetails, decisionLabel, rating } from "@/features/acquisition/AgentQualification";
import { evidenceReviewPath } from "@/features/acquisition/creatorReviewPaths";
import { ViewShell } from "@/features/analytics/parts";
import { CommerceView } from "./CommerceView";
import { ScorecardView } from "./ScorecardView";
import a from "@/features/analytics/Analytics.module.css";
import styles from "@/features/acquisition/Acquisition.module.css";

/**
 * `/creators/:creatorId/assessments/:assessmentId` holds three read-only historical v2 sources (37:74, 37:251, 65:814).
 * The returned record's kind picks the layout. Current v3 addresses identify an exact saved agent run;
 * historical v2 snapshots keep their original read-only layouts.
 */
export function AssessmentPage() {
  const { creatorId = "", assessmentId = "" } = useParams();
  const query = useView<{ creatorId: string; assessmentId: string }, AssessmentData | AgentAssessmentRecord>("assessmentRecord", { creatorId, assessmentId });
  const record = query.data?.data ?? null;
  return (
    <section aria-labelledby="assessment-title" data-figma-source={record ? (record.kind === "creator-v3" ? "102:364" : record.kind === "content-v2" ? "37:74" : record.kind === "tiktok-commerce-v2" ? "37:251" : "65:814") : undefined} className={a.page}>
      {!record && <h1 id="assessment-title" style={{ font: "var(--text-h1)", margin: 0 }}>Creator assessment</h1>}
      <ViewShell query={query} subject="The assessment" emptyTitle="No assessment" emptyBody="The source responded, but there is no assessment record to show.">
        {(data) => data.kind === "creator-v3" ? (data.creatorId === creatorId && data.assessmentId === assessmentId ? <CurrentAssessment record={data} /> : <><h1 id="assessment-title" style={{ font: "var(--text-h1)", margin: 0 }}>Creator assessment</h1><EmptyState state="Error" title="Assessment identity mismatch" alert><p>The returned record does not match this creator and saved run. No assessment is displayed.</p></EmptyState></>) : data.kind === "sc-commerce-v2" ? <CommerceView record={data} /> : <ScorecardView record={data} />}
      </ViewShell>
    </section>
  );
}

function CurrentAssessment({ record }: { record: AgentAssessmentRecord }) {
  const reviewPath = record.evidenceId === null ? null : evidenceReviewPath(record.creatorId, record.evidenceId);
  return <>
    <div className={styles.titleRow}>
      <div className={styles.heading}>
        <h1 id="assessment-title">Creator qualification</h1>
        <p>{record.creatorId} · {record.qualification.briefId} · Saved run {record.runId}</p>
      </div>
      <LinkButton variant="secondary" to="/creators/discovery">Daily sourcing</LinkButton>
      {reviewPath && <LinkButton to={reviewPath}>Review source evidence</LinkButton>}
    </div>
    <AcquisitionTabs current="Daily sourcing" evidencePath={reviewPath} />
    <section className={styles.card} aria-labelledby="saved-run-title">
      <h2 id="saved-run-title" className={styles.h2}>Saved assessment</h2>
      <p className={styles.small}>Recorded <time dateTime={record.recordedAt}>{record.recordedAt}</time> · Revision {record.revision} · {record.stale ? "Stale" : "Current saved run"}. Configuration values below belong to this saved run; current publications are listed in daily sourcing.</p>
      {(record.stale || record.superseded) && <Alert state="warning" title={record.superseded ? "This run has been superseded" : "This assessment needs a fresh review"}>
        <p>The effective state is review needed. Its original result and source packet remain available as history and do not authorize a current invitation or activation.</p>
      </Alert>}
      <DataTable caption="Critical content ratings" columns={[{ label: "Criterion" }, { label: "Saved rating" }]} rows={[["Routine fit", rating(record.qualification.criteria.routine)], ["Demonstration", rating(record.qualification.criteria.demo)]]} />
      <QualificationDetails assessment={record.qualification} packet={record.agentEvidence} savedConfiguration />
      {(record.stale || record.superseded) && <details>
        <summary>Original as-assessed decision: {decisionLabel[record.assessedQualification.state]}</summary>
        <p className={styles.small}>Historical decision only. The effective qualification above controls readiness.</p>
        <DataTable caption="Original as-assessed decision" columns={[{ label: "Reference" }, { label: "Original value" }]} rows={[
          ["Decision", decisionLabel[record.assessedQualification.state]], ["Content qualification", record.assessedQualification.contentQualification],
          ["Model", record.assessedQualification.modelId], ["Configuration version", record.assessedQualification.config.version ?? "Unknown"],
          ["Configuration hash", record.assessedQualification.config.hash ?? "Unknown"], ["Evidence revision", record.assessedQualification.evidenceRevision],
          ["Terms revision", record.assessedQualification.termsRevision],
          ["Score", record.assessedQualification.score?.total ?? "Unknown"],
        ]} />
      </details>}
    </section>
  </>;
}
