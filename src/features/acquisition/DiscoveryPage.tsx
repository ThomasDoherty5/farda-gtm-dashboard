import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { SkeletonCard, EmptyState } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoney } from "@/components/MetricValue";
import { ViewError } from "@/components/ViewError";
import { blockedReason } from "@/features/approvals/shared";
import type { DiscoveryData } from "@/fixtures/discovery";
import type { AgentModelSummary, AgentSourcingData } from "@/creator-agent/readViews";
import { DEMO_BATCH_ID, DEMO_CREATOR_ID, DEMO_EVIDENCE_ID, DEMO_HOURLY_RUN_ID } from "@/fixtures/ids";
import { AcquisitionTabs } from "./AcquisitionTabs";
import { decisionLabel } from "./AgentQualification";
import { creatorAssessmentPath, evidenceReviewPath } from "./creatorReviewPaths";
import { FilterButton } from "./FilterButton";
import { PlanView } from "./PlanView";
import styles from "./Acquisition.module.css";

const SOURCES = [
  { value: "both", label: "SC + TikTok Shop" },
  { value: "social-cat", label: "Social Cat" },
  { value: "tiktok-shop", label: "TikTok Shop" },
];
const PUBLISHING = [
  { value: "both", label: "IG + TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
];

const allowed = (options: { value: string }[], raw: string | null) => (options.some((o) => o.value === raw) ? (raw as string) : "both");
const usd = (minorUnits: number) => formatMoney({ minorUnits, currency: "USD" });
const evidencePath = `/creators/${DEMO_CREATOR_ID}/evidence/${DEMO_EVIDENCE_ID}`;
type DiscoveryReadData = DiscoveryData | AgentSourcingData;
const isAgentSourcing = (data: DiscoveryReadData): data is AgentSourcingData => "kind" in data && data.kind === "agent-sourcing";

/** Daily sourcing and invitation plan (Figma source 102:555, owner THO-287). Read work only: nothing here starts a source action. */
export function DiscoveryPage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, DiscoveryReadData>("discoverySummary", {});
  const demo = adapter.kind === "demo";
  const data = query.data?.data;
  const current = data && isAgentSourcing(data) ? data : null;
  const firstEvidence = current?.records.find((record) => record.evidenceId !== null);
  const reviewPath = firstEvidence?.evidenceId ? evidenceReviewPath(firstEvidence.creatorId, firstEvidence.evidenceId) : demo && !current ? evidencePath : null;
  return (
    <section aria-labelledby="discovery-title" data-figma-source="102:555" className={styles.page}>
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          <h1 id="discovery-title">Find the next right fit.</h1>
          <p>Daily acquisition workspace · commission-only offers · source access and capacity to validate</p>
        </div>
        {reviewPath ? <LinkButton variant="secondary" to={reviewPath} style={{ minWidth: 166 }}>Review evidence</LinkButton> : <Button variant="secondary" style={{ minWidth: 166 }} disabledReason="No saved source record is available to review.">Review evidence</Button>}
        <LinkButton to="/settings/capabilities" style={{ minWidth: 162 }}>Validate access</LinkButton>
      </div>
      <AcquisitionTabs current="Daily sourcing" evidencePath={reviewPath} />
      <ReadState res={query.data} subject="Daily sourcing" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading daily sourcing…" />}
      {query.isError && <ViewError error={query.error} subject="Daily sourcing" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data &&
        (data ? isAgentSourcing(data) ? <AgentSourcing data={data} /> : demo ? <Body res={query.data as ReadResponse<DiscoveryData>} data={data} demo /> : <EmptyState state="Empty" title="Saved sourcing records unavailable"><p>This source has not returned the current creator records. Review evidence when a saved record is available.</p></EmptyState> : <EmptyState state="Empty" title="No sourcing plan yet"><p>The source responded, but no daily plan is configured.</p></EmptyState>)}
    </section>
  );
}

/** Actual saved source packets and current model publication; no illustrative batch or capacity is substituted. */
function AgentSourcing({ data }: { data: AgentSourcingData }) {
  return <>
    <KpiRow>
      <Kpi label="Saved creators" context={`${data.records.length} displayed${data.partial ? ` of ${data.total}` : ""}`}>{data.total}</Kpi>
      <Kpi label="Published models" context="Independent website and TikTok Shop configurations">{data.models.filter((model) => model.status === "bound").length} / 2</Kpi>
      <Kpi label="Policy" context={`Agent ${data.agentVersion} · schema ${data.agentSchemaVersion}`}>{data.policyVersion}</Kpi>
    </KpiRow>
    <section className={styles.card} aria-labelledby="saved-sourcing-title">
      <div className={styles.sectionTitle}>
        <h2 id="saved-sourcing-title" className={styles.h2}>Saved creator sourcing</h2>
        <p className={styles.small}>Latest saved assessment per creator. Open a saved run to inspect its evidence and qualification. This list does not send invitations.</p>
      </div>
      {data.records.length ? <DataTable caption="Saved creator sourcing records" columns={[{ label: "Creator / brief" }, { label: "Checkout route / state" }, { label: "Saved run" }, { label: "Review" }]} rows={data.records.map((record) => [
        <span key={record.creatorId}>{record.creatorId}<br />{record.briefId}</span>,
        <span key={`${record.creatorId}-state`}>{record.checkoutRoute === "website" ? "Website" : "TikTok Shop"}<br /><Badge tone={record.stale || record.state === "hold" ? "warning" : "violet"}>{record.stale ? "Review needed · stale" : decisionLabel[record.state]}</Badge></span>,
        <span key={record.runId}>{record.runId}<br />Revision {record.revision} · <time dateTime={record.recordedAt}>{record.recordedAt}</time></span>,
        <div key={`${record.runId}-links`} className={styles.actions}>
          <LinkButton variant="secondary" to={creatorAssessmentPath(record.creatorId, record.runId)}>View assessment</LinkButton>
          {record.evidenceId !== null ? <LinkButton variant="secondary" to={evidenceReviewPath(record.creatorId, record.evidenceId)}>Review source evidence</LinkButton> : <span className={styles.small}>Source link unavailable for this saved run.</span>}
        </div>,
      ])} /> : <EmptyState state="Empty" title="No saved creators yet"><p>No reviewed creator packets have been saved in this workspace.</p></EmptyState>}
      {data.partial && <p className={styles.small}>Showing {data.records.length} of {data.total} saved creators. This is a partial list.</p>}
    </section>
    {data.models.map((model) => <PublishedModel key={model.modelId} model={model} />)}
  </>;
}

function PublishedModel({ model }: { model: AgentModelSummary }) {
  return <section className={styles.card} aria-label={`Current model ${model.modelId}`}>
    <h2 className={styles.h2}>{model.modelId}</h2>
    <p><Badge tone={model.status === "bound" ? "success" : "warning"}>{model.status === "bound" ? "Published" : "Not published"}</Badge> · {model.configVersion ?? "Version unknown"}</p>
    <DataTable caption={`Current publication ${model.modelId}`} columns={[{ label: "Reference" }, { label: "Published value" }]} rows={[
      ["Configuration hash", model.configHash ?? "Unknown"], ["Approved baseline hash", model.baselineHash ?? "Unknown"], ["Numerical configuration hash", model.numericHash ?? "Unknown"],
    ]} />
    {model.criteria && model.bands ? <>
      <DataTable caption={`Current criterion weights ${model.modelId}`} columns={[{ label: "Criterion / ID" }, { label: "Unchanged weight" }]} rows={model.criteria.map((criterion) => [`${criterion.label} · ${criterion.id}`, `${criterion.weight}%`])} />
      <DataTable caption={`Current aggregate bands ${model.modelId}`} columns={[{ label: "Band" }, { label: "Minimum" }]} rows={model.bands.map((band) => [band.id, band.min])} />
      <p className={styles.small}>Arithmetic: {model.arithmetic}. Published values are read-only.</p>
      <p className={styles.small}>{model.decisionRules ? `Invitation score minimum: ${model.decisionRules.invitationMinScore ?? "No aggregate minimum"} · Activation minimum: ${model.decisionRules.activationMinScore} · Minimum weight coverage: ${model.decisionRules.minCoveragePct}%. Evidence, critical floors and stage gates also apply.` : "Decision rules not returned; readiness requires review."}</p>
    </> : <p className={styles.small}>Current weights and bands are unavailable. No historical model is substituted.</p>}
  </section>;
}

function Body({ res, data, demo }: { res: ReadResponse<DiscoveryData>; data: DiscoveryData; demo: boolean }) {
  const [search, setSearch] = useSearchParams();
  if (search.get("view") === "plan") return <PlanView res={res} data={data} />;
  return <PlanSummary res={res} data={data} demo={demo} search={search} setSearch={setSearch} />;
}

function PlanSummary({ res, data, demo, search, setSearch }: { res: ReadResponse<DiscoveryData>; data: DiscoveryData; demo: boolean; search: URLSearchParams; setSearch: (next: URLSearchParams) => void }) {
  const sources = allowed(SOURCES, search.get("sources"));
  const publishing = allowed(PUBLISHING, search.get("publishing"));
  const [dialog, setDialog] = useState<"batch" | "scope" | null>(null);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value === "both") next.delete(key);
    else next.set(key, value);
    setSearch(next);
  };

  const rows = useMemo(() => data.capacityRows.filter((r) => sources === "both" || r.id === "shared" || r.id === sources), [data.capacityRows, sources]);
  const { batch } = data;
  const held = batch.selected - batch.eligible;
  const allocation = { minorUnits: batch.sampleUnits * batch.sampleUnitCost.minorUnits, currency: batch.sampleUnitCost.currency };
  const noSample = batch.eligible - batch.sampleUnits;
  const liveBlocked = blockedReason(res, "startLiveDiscovery");
  const fee = data.upfrontFee.state === "known" && data.upfrontFee.value ? formatMoney(data.upfrontFee.value) : "Unknown";

  return (
    <>
      <div className={styles.controls}>
        <FilterButton name="Sources" title="Choose sources" options={SOURCES} value={sources} onChange={(v) => setFilter("sources", v)} width={252} />
        <FilterButton name="Publishing" title="Choose publishing networks" options={PUBLISHING} value={publishing} onChange={(v) => setFilter("publishing", v)} width={230} />
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 166 }} onClick={() => setDialog("scope")}>Lifestyle only</Button>
        <Badge tone="warning" width={230}>Draft schedule · not live</Badge>
      </div>
      {publishing !== "both" && <p className={styles.small} role="status">Publishing filter: {PUBLISHING.find((o) => o.value === publishing)!.label}. The demo's sample batch isn't split by network, so its counts don't change.</p>}

      <KpiRow>
        <Kpi label="Schedule" context={data.schedule.context} testId="metric-Schedule">{data.schedule.label}</Kpi>
        <Kpi label="Live source capacity" context={data.liveCapacityContext} testId="metric-Live source capacity">{data.liveCapacity.state === "known" && data.liveCapacity.value !== null ? data.liveCapacity.value : "Unknown"}</Kpi>
        <Kpi label="Current v3 model" context={data.model.context} testId="metric-Current v3 model">{data.model.label}</Kpi>
        <Kpi label="Upfront content fee" context="Product and shipping are separate" testId="metric-Upfront content fee">{fee}</Kpi>
      </KpiRow>

      <section className={`${styles.card} ${styles.cardWide}`} aria-labelledby="plan-title">
        <div className={styles.sectionTitle}>
          <h2 id="plan-title" className={styles.h2}>One daily plan. A visible next step.</h2>
          <p className={styles.small}>Discovery is read work. Sending is a separately approved, bounded source action.</p>
        </div>
        <ol className={styles.phases}>
          {data.phases.map((phase, i) => (
            <li key={phase.title} className={styles.phase} aria-current={i === data.currentPhase ? "step" : undefined}>
              <Badge tone="violet" width={42}>{i + 1}</Badge>
              <span className={styles.phaseTitle}>{phase.title}</span>
              <span className={styles.small}>{phase.note}</span>
            </li>
          ))}
        </ol>
        <div className={styles.actions}>
          <LinkButton to={evidencePath} style={{ minWidth: 196 }}>Open video review</LinkButton>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 220 }} onClick={() => setDialog("batch")}>Preview sample batch</Button>
          <div className={styles.gated}><Button style={{ minWidth: 210 }} disabledReason={liveBlocked ?? "Not available."}>Start live discovery</Button></div>
        </div>
        <p className={styles.small}>The maximum permitted batch depends on validated source permissions, live quotas and eligible work. Unknown limits do not mean unlimited access.</p>
      </section>

      <section className={styles.card} aria-labelledby="limits-title">
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>
            <h2 id="limits-title" className={styles.h2}>Respect each source's limits.</h2>
            <p className={styles.small}>Invitation quota, collaboration capacity, source rate limits, stock and budget use different units.</p>
          </div>
          <div className={styles.actions}>
            <LinkButton variant="secondary" to="/creators/discovery?view=plan" style={{ minWidth: 172 }}>Plan detail</LinkButton>
            <LinkButton variant="secondary" to="/settings/capabilities" style={{ minWidth: 172 }}>Open capabilities</LinkButton>
          </div>
        </div>
        <DataTable
          caption="Source capacity and permissions"
          columns={[{ label: "Source / capacity", width: "22.1%" }, { label: "Current evidence", width: "14.4%" }, { label: "Meaning", width: "39.7%" }, { label: "Next step" }]}
          rows={rows.map((r) => [r.source, r.evidence, r.meaning, r.next])}
          testId="capacity-table"
        />
      </section>

      <div className={styles.pair}>
        <section className={styles.card} aria-labelledby="cadence-title">
          <div className={styles.sectionTitle}>
            <h2 id="cadence-title" className={styles.h2}>Two cadences. Different work.</h2>
            <p className={styles.small}>Keep discovery and monitoring easy to distinguish.</p>
          </div>
          <div className={styles.cadence}><Badge tone="violet" width={98}>Daily</Badge><p>Find → review → qualify → propose finite invitations</p></div>
          <div className={styles.cadence}><Badge width={98}>Hourly</Badge><p>Read enrolled creators' posts, inbox and status changes</p></div>
          <p className={styles.small}>Hourly monitoring never auto-sends a reply or accepts terms. A discovered profile starts with identity review.</p>
          <div><LinkButton variant="secondary" to={`/runs/${DEMO_HOURLY_RUN_ID}`} style={{ minWidth: 208 }}>Open hourly monitor</LinkButton></div>
        </section>
        <section className={styles.card} aria-labelledby="policy-title">
          <div className={styles.sectionTitle}>
            <h2 id="policy-title" className={styles.h2}>Commission is the offer.</h2>
            <p className={styles.small}>No upfront content fee or guaranteed content payment.</p>
          </div>
          <dl className={styles.details}>
            <div><dt>Active acquisition</dt><dd>Commission only</dd></div>
            <div><dt>Upfront / guaranteed fee</dt><dd>{fee}</dd></div>
            <div><dt>Product + shipping</dt><dd>Separate approval</dd></div>
            <div><dt>Existing obligations</dt><dd>Preserved</dd></div>
          </dl>
          <p className={styles.small}>If a creator requests an upfront fee, hold for a terms mismatch. Historical paid/hybrid records cannot create a new prohibited commitment.</p>
        </section>
      </div>

      <section className={styles.card} aria-labelledby="batch-title">
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>
            <h2 id="batch-title" className={styles.h2}>Preview the boundaries before approving.</h2>
            <p className={styles.small}>Separate synthetic {batch.selected}-prospect batch · not today's real sourcing result or the mature cohort funnel.</p>
          </div>
          <LinkButton variant="secondary" to={`/batches/${DEMO_BATCH_ID}`} style={{ minWidth: 172 }}>Open sample batch</LinkButton>
        </div>
        <KpiRow>
          <Kpi label="Selected" context={`${batch.eligible} eligible in this example · ${held} held`} testId="metric-Selected">{batch.selected}</Kpi>
          <Kpi label="Bound recipients" context="No open-ended dispatch" testId="metric-Bound recipients">{batch.eligible}</Kpi>
          <Kpi label="Sample allocation" context={`${batch.sampleUnits} × ${usd(batch.sampleUnitCost.minorUnits)} illustrative allocation`} testId="metric-Sample allocation">{batch.sampleUnits} / {usd(allocation.minorUnits)}</Kpi>
          <Kpi label="Guaranteed fee" context="Earned commissions are not capped" testId="metric-Guaranteed fee">{fee}</Kpi>
        </KpiRow>
        <p className={styles.small}>Pause/cancel affects unsent items. Confirmed receipts remain intact; uncertain outcomes reconcile before retry. Changing recipient, terms, policy or sample bounds requires renewed approval.</p>
      </section>
      {demo && <p className={styles.small}>Draft plan and illustrative workflow · no schedule, source action or offer is activated by this design.</p>}

      <Dialog open={dialog === "batch"} title="Approved finite batch · demo manifest" badge={demo ? "Demo" : undefined} onClose={() => setDialog(null)}>
        <p>{batch.batchId} contains exactly {batch.eligible} named recipients with the approved {batch.rateLabel} example. Fixed content fees: {fee}. New samples: maximum {batch.sampleUnits} × {usd(batch.sampleUnitCost.minorUnits)} = {usd(allocation.minorUnits)}; {noSample} recipients need no new sample.</p>
        <p>Recheck source state, permissions, stock and quota before each action. Adding recipients or changing terms requires fresh approval. The dispatch limit is not a cap on earned commission liability.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
        <LinkButton to={`/batches/${DEMO_BATCH_ID}`}>View batch progress</LinkButton>
      </Dialog>
      <Dialog open={dialog === "scope"} title="Research scope is locked" onClose={() => setDialog(null)}>
        <p>Lifestyle only is the current research scope: GRWM, workday routines, organizing, travel and practical product use. It can't be widened to clinical or IVF lectures, or generic medical talking heads.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
    </>
  );
}
