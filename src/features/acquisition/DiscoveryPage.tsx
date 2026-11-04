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
import { DEMO_BATCH_ID, DEMO_CREATOR_ID, DEMO_EVIDENCE_ID, DEMO_HOURLY_RUN_ID } from "@/fixtures/ids";
import { AcquisitionTabs } from "./AcquisitionTabs";
import { FilterButton } from "./FilterButton";
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

/** Daily sourcing and invitation plan (Figma source 102:555, owner THO-287). Read work only: nothing here starts a source action. */
export function DiscoveryPage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, DiscoveryData>("discoverySummary", {});
  const demo = adapter.kind === "demo";
  return (
    <section aria-labelledby="discovery-title" data-figma-source="102:555" className={styles.page}>
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          <h1 id="discovery-title">Find the next right fit.</h1>
          <p>Daily acquisition workspace · commission-only offers · source access and capacity to validate</p>
        </div>
        <LinkButton variant="secondary" to={evidencePath} style={{ minWidth: 166 }}>Review evidence</LinkButton>
        <LinkButton to="/settings/capabilities" style={{ minWidth: 162 }}>Validate access</LinkButton>
      </div>
      <AcquisitionTabs current="Daily sourcing" />
      <ReadState res={query.data} subject="Daily sourcing" only={["stale"]} />
      {query.isPending && <SkeletonCard label="Loading daily sourcing…" />}
      {query.isError && <ViewError error={query.error} subject="Daily sourcing" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data &&
        (query.data.data ? <Body res={query.data as ReadResponse<DiscoveryData>} data={query.data.data} demo={demo} /> : <EmptyState state="Empty" title="No sourcing plan yet"><p>The source responded, but no daily plan is configured.</p></EmptyState>)}
    </section>
  );
}

function Body({ res, data, demo }: { res: ReadResponse<DiscoveryData>; data: DiscoveryData; demo: boolean }) {
  const [search, setSearch] = useSearchParams();
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
          <LinkButton variant="secondary" to="/settings/capabilities" style={{ minWidth: 172 }}>Open capabilities</LinkButton>
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
