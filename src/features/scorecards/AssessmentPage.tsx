import { useParams } from "react-router-dom";
import type { AssessmentData } from "@/adapter/demoScorecards";
import { useView } from "@/adapter/useView";
import { ViewShell } from "@/features/analytics/parts";
import { CommerceView } from "./CommerceView";
import { ScorecardView } from "./ScorecardView";
import a from "@/features/analytics/Analytics.module.css";

/**
 * `/creators/:creatorId/assessments/:assessmentId` holds three read-only historical v2 sources (37:74, 37:251, 65:814).
 * The returned record's kind picks the layout, so the address never chooses a scoring model. Current v3 evidence
 * lives in the lifestyle evidence review.
 */
export function AssessmentPage() {
  const { creatorId = "", assessmentId = "" } = useParams();
  const query = useView<{ creatorId: string; assessmentId: string }, AssessmentData>("assessmentRecord", { creatorId, assessmentId });
  const record = query.data?.data ?? null;
  return (
    <section aria-labelledby="assessment-title" data-figma-source={record ? (record.kind === "content-v2" ? "37:74" : record.kind === "tiktok-commerce-v2" ? "37:251" : "65:814") : undefined} className={a.page}>
      {!record && <h1 id="assessment-title" style={{ font: "var(--text-h1)", margin: 0 }}>Creator assessment</h1>}
      <ViewShell query={query} subject="The assessment" emptyTitle="No assessment" emptyBody="The source responded, but there is no assessment record to show.">
        {(data) => (data.kind === "sc-commerce-v2" ? <CommerceView record={data} /> : <ScorecardView record={data} />)}
      </ViewShell>
    </section>
  );
}
