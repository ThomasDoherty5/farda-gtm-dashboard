import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatCount } from "@/components/MetricValue";
import { ViewError } from "@/components/ViewError";
import { DEMO_COLLABORATION_ID } from "@/fixtures/ids";
import type { BranchesData, TerminalKind } from "@/fixtures/pipelineBranches";
import { DEFAULT_PIPELINE_FILTERS, type PipelineFilters } from "@/fixtures/pipeline";
import { AcquisitionTabs } from "./AcquisitionTabs";
import { carriedSearch, FACET_NAMES, FACETS, parseFilters } from "./pipelineFilters";
import { contentTotals, sampleTotals, terminalTotals } from "./branchMetrics";
import acquisition from "./Acquisition.module.css";
import styles from "./Pipeline.module.css";

const na = (value: number | null) => (value === null ? "N/A" : formatCount(value));
const KIND: Record<TerminalKind, string> = { declined: "Declined", optOut: "Opt-out", expired: "Expired" };

/** Terminal paths, repeat paths and the optional sample and content branches of the pipeline (CF-05, CF-07). Read work only. */
export function BranchesView() {
  const { adapter } = useScope();
  const [search] = useSearchParams();
  const filters = parseFilters(search);
  const source = filters.source;
  const back = carriedSearch(filters);
  const ignored = (Object.keys(DEFAULT_PIPELINE_FILTERS) as (keyof PipelineFilters)[]).filter((k) => k !== "source" && filters[k] !== DEFAULT_PIPELINE_FILTERS[k]);
  const query = useView<{ source: string }, BranchesData>("pipelineBranches", { source });
  const demo = adapter.kind === "demo";
  return (
    <section aria-labelledby="branches-title" data-figma-source="102:74" className={acquisition.page}>
      <div className={acquisition.titleRow}>
        <div className={acquisition.heading}>
          <h1 id="branches-title">Closed paths and optional branches.</h1>
          <p>Terminal outcomes keep their suppression · samples and content are optional unless the terms say otherwise</p>
        </div>
        <LinkButton variant="secondary" to={back ? `/creators/pipeline?${back}` : "/creators/pipeline"} style={{ minWidth: 156 }}>Back to pipeline</LinkButton>
      </div>
      <AcquisitionTabs current="Pipeline" />
      {back && (
        <p className={acquisition.small} role="status" data-testid="branches-filters">
          Filters carried from the pipeline: {(Object.keys(DEFAULT_PIPELINE_FILTERS) as (keyof PipelineFilters)[]).filter((k) => filters[k] !== DEFAULT_PIPELINE_FILTERS[k]).map((k) => `${FACET_NAMES[k]}: ${FACETS[k].find((o) => o.value === filters[k])?.label}`).join(" · ")}.{" "}
          {ignored.length > 0 ? `These branch counts are split by source only, so ${ignored.map((k) => FACET_NAMES[k]).join(", ")} ${ignored.length > 1 ? "do" : "does"} not change them.` : "Source is applied to these counts."}
        </p>
      )}
      {query.isPending && <SkeletonCard label="Loading paths and branches…" />}
      {query.isError && <ViewError error={query.error} subject="The pipeline branches" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data &&
        (query.data.data && query.data.dataState !== "empty" ? (
          <Body res={query.data as ReadResponse<BranchesData>} data={query.data.data} demo={demo} />
        ) : (
          <EmptyState state="Empty" title="No branch data"><p>The source responded, but there are no terminal paths or branches to show. That is not zero.</p></EmptyState>
        ))}
      {demo && <p className={acquisition.small}>Illustrative completed-cohort scenario · synthetic placeholder handles · no real creator was contacted or suppressed.</p>}
    </section>
  );
}

function Body({ res, data, demo }: { res: ReadResponse<BranchesData>; data: BranchesData; demo: boolean }) {
  const terminal = terminalTotals(data.sources);
  const sample = sampleTotals(data.sources);
  const content = contentTotals(data.sources);
  return (
    <>
      {res.dataState === "stale" && <p className={acquisition.small} role="status">These counts are from the last successful read, not current.</p>}
      <section className={styles.panel} aria-labelledby="terminal-title" data-testid="terminal-paths">
        <div className={acquisition.sectionTitle}>
          <h2 id="terminal-title" className={acquisition.h2}>A closed path stays closed.</h2>
          <p className={acquisition.small}>Decline, opt-out and expiry are terminal for that opportunity. Suppression is kept. Another contact is a new opportunity and needs a fresh suppression check and a fresh approval; an earlier approval is never reused.</p>
        </div>
        <KpiRow>
          <Kpi label="Declined" context="Suppressed for this opportunity" testId="terminal-declined">{terminal.declined}</Kpi>
          <Kpi label="Opt-out" context="Permanent suppression · no repeat contact" testId="terminal-optOut">{terminal.optOut}</Kpi>
          <Kpi label="Expired" context="No response in time · suppression kept" testId="terminal-expired">{terminal.expired}</Kpi>
        </KpiRow>
        <DataTable
          caption="Repeat and new-opportunity paths"
          columns={[{ label: "Creator" }, { label: "Prior outcome" }, { label: "Suppression" }, { label: "Repeat path" }, { label: "Approval" }]}
          rows={data.repeatCases.map((c) => [
            c.handle,
            KIND[c.prior],
            c.suppression === "permanent" ? <Badge key="s" tone="danger">Permanent</Badge> : <Badge key="s" tone="warning">Preserved</Badge>,
            c.repeatAllowed ? "New opportunity after a fresh suppression check" : "Not allowed",
            c.repeatAllowed ? "Fresh approval required · none on file" : "Not applicable",
          ])}
          testId="repeat-cases"
          minWidth={720}
        />
        <p className={acquisition.small}>Demo handles are placeholders. This page reads the paths; it never lifts a suppression or sends anything.</p>
      </section>

      <section className={styles.panel} aria-labelledby="sample-title" data-testid="sample-branch">
        <div className={acquisition.sectionTitle}>
          <h2 id="sample-title" className={acquisition.h2}>A sample is optional.</h2>
          <p className={acquisition.small}>Acceptance gates shipment. Approved stock and cost gate reservation. Tracking gates commerce activation. A product-held opportunity continues without a sample.</p>
        </div>
        <KpiRow>
          <Kpi label="Accepted or matched" context="The branch starts here" testId="sample-accepted">{na(sample.accepted)}</Kpi>
          <Kpi label="Sample requested" context={`${na(sample.notRequested)} continue without a sample`} testId="sample-requested">{na(sample.requested)}</Kpi>
          <Kpi label="Stock and cost approved" context="Gates reservation" testId="sample-approved">{na(sample.stockCostApproved)}</Kpi>
          <Kpi label="Shipped / delivered" context={sample.delivered === null ? "Delivered is N/A: no carrier receipt for one source" : "Delivered from carrier receipts"} testId="sample-shipped">{na(sample.shipped)} / {na(sample.delivered)}</Kpi>
        </KpiRow>
        <div className={styles.legend}>
          <LinkButton variant="secondary" to={`/collaborations/${DEMO_COLLABORATION_ID}`} style={{ minWidth: 200 }}>Open a sample context</LinkButton>
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="content-title" data-testid="content-branch">
        <div className={acquisition.sectionTitle}>
          <h2 id="content-title" className={acquisition.h2}>Only a committed post can be missed.</h2>
          <p className={acquisition.small}>A missing post is a violation only where the accepted terms create the obligation. Without one it is an unposted opportunity, not a breach.</p>
        </div>
        <KpiRow>
          <Kpi label="Terms confirmed" context="The branch starts here" testId="content-terms">{na(content.terms)}</Kpi>
          <Kpi label="With a content obligation" context={`${content.posted} posted · ${content.due} due · ${content.overdue} overdue`} testId="content-with">{na(content.withObligation)}</Kpi>
          <Kpi label="No content obligation" context={`${content.postedVoluntarily} posted anyway · ${content.noneYet} none yet · no violation possible`} testId="content-without">{na(content.withoutObligation)}</Kpi>
          <Kpi label="Tracking active" context={`Commerce activation waits on tracking · ${content.terms - content.trackingActive} not yet`} testId="content-tracking">{na(content.trackingActive)}</Kpi>
        </KpiRow>
        <div className={styles.legend}>
          <LinkButton variant="secondary" to="/content" style={{ minWidth: 200 }}>Open the content monitor</LinkButton>
          <LinkButton variant="secondary" to="/approvals/demo-approval-exact" style={{ minWidth: 200 }}>Open an approval</LinkButton>
          <LinkButton variant="secondary" to="/runs/demo-run-uncertain?tab=recovery" style={{ minWidth: 200 }}>Open run recovery</LinkButton>
        </div>
        {demo && <p className={acquisition.small}>Drilldowns open demo records.</p>}
      </section>
    </>
  );
}
