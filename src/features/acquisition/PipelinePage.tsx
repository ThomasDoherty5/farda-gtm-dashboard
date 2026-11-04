import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatCompact, formatCount, formatMoney } from "@/components/MetricValue";
import { ViewError } from "@/components/ViewError";
import { dateTime } from "@/features/approvals/shared";
import { DEMO_CREATOR_ID, DEMO_EVIDENCE_ID } from "@/fixtures/ids";
import { CURRENT_STAGES, DEFAULT_PIPELINE_FILTERS, type PipelineData, type PipelineFilters } from "@/fixtures/pipeline";
import { AcquisitionTabs } from "./AcquisitionTabs";
import { BranchesView } from "./BranchesView";
import { FilterButton } from "./FilterButton";
import { carriedSearch, FACET_NAMES, FACETS, parseFilters } from "./pipelineFilters";
import { currentCount, currentTotal, netBySource, outcomeTotals, sendTotals, stageRows, type StageRow } from "./pipelineMetrics";
import acquisition from "./Acquisition.module.css";
import styles from "./Pipeline.module.css";

/** Figma sets these counts tight against the dot so the line fits on one; a thin space keeps them apart (design-map.md). */
const THIN = "\u200A";
const evidencePath = `/creators/${DEMO_CREATOR_ID}/evidence/${DEMO_EVIDENCE_ID}`;
const na = (value: number | null) => (value === null ? "N/A" : formatCount(value));
const NO_SEND_REASON = "N/A · an inbound application has no outbound send, so there is nothing to count.";
const usd = (m: Parameters<typeof formatMoney>[0]) => formatMoney(m);

/** Full acquisition pipeline (Figma source 102:74, owner THO-289). `?view=branches` shows terminal paths and the optional sample and content branches. */
export function PipelinePage() {
  const [search] = useSearchParams();
  return search.get("view") === "branches" ? <BranchesView /> : <PipelineView />;
}

/** The funnel. Read work only: nothing here sends, approves or changes a source. */
function PipelineView() {
  const { adapter } = useScope();
  const [search, setSearch] = useSearchParams();
  const filters = parseFilters(search);
  const query = useView<PipelineFilters, PipelineData>("pipelineSummary", filters);
  const setFilter = (key: keyof PipelineFilters, value: string) => {
    const next = new URLSearchParams(search);
    if (value === DEFAULT_PIPELINE_FILTERS[key]) next.delete(key);
    else next.set(key, value);
    setSearch(next);
  };
  const demo = adapter.kind === "demo";
  return (
    <section aria-labelledby="pipeline-title" data-figma-source="102:74" className={acquisition.page}>
      <div className={acquisition.titleRow}>
        <div className={acquisition.heading}>
          <h1 id="pipeline-title">From discovery to repeat sales.</h1>
          <p>{filters.route === "inbound" ? "Synthetic inbound applications · Sep–Oct 2026 · applicants are never invited by us · one opportunity per creator" : "Mature synthetic cohort · Sep–Oct 2026 · outbound invitations · one opportunity per creator"}</p>
        </div>
        <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 156 }}>Daily sourcing</LinkButton>
        <LinkButton to={evidencePath} style={{ minWidth: 162 }}>Review evidence</LinkButton>
      </div>
      <AcquisitionTabs current="Pipeline" />
      <div className={acquisition.controls}>
        <FilterButton name="Source" title="Choose acquisition source" options={[...FACETS.source]} value={filters.source} onChange={(v) => setFilter("source", v)} width={174} />
        <FilterButton name="Route" title="Choose inbound or outbound route" options={[...FACETS.route]} value={filters.route} onChange={(v) => setFilter("route", v)} width={160} />
        <FilterButton name="Network" title="Choose publishing network" options={[...FACETS.network]} value={filters.network} onChange={(v) => setFilter("network", v)} width={174} />
        <FilterButton name="Checkout" title="Choose checkout destination" options={[...FACETS.checkout]} value={filters.checkout} onChange={(v) => setFilter("checkout", v)} width={174} />
        <FilterButton name="Cohort window" title="Choose cohort start window" options={[...FACETS.window]} value={filters.window} onChange={(v) => setFilter("window", v)} width={174} bare />
        <FilterButton name="Policy" title="Choose policy version" options={[...FACETS.policy]} value={filters.policy} onChange={(v) => setFilter("policy", v)} width={160} />
        <Badge tone="violet" width={174}>{demo ? "Illustrative cohort" : "Cohort"}</Badge>
      </div>
      <div className={acquisition.context}>
        <p className={acquisition.contextTitle}>Commission-only acquisition</p>
        <p className={acquisition.small}>No upfront content fee. Product and shipping need separate approval. This example assumes a validated model; current v3 publication remains pending.</p>
      </div>
      {query.isPending && <SkeletonCard label="Loading the acquisition pipeline…" />}
      {query.isError && <ViewError error={query.error} subject="The acquisition pipeline" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data &&
        (query.data.data && query.data.dataState !== "empty" ? (
          <Body res={query.data as ReadResponse<PipelineData>} data={query.data.data} demo={demo} />
        ) : (
          <EmptyState state="Empty" title="No opportunities match"><p>The source responded, but no opportunity matches these filters. This is an empty selection, not a count of zero. Clear a filter to widen the cohort.</p></EmptyState>
        ))}
      {demo && <p className={acquisition.small}>Illustrative completed-cohort scenario · no real creators qualified or invitations sent · no approved v3 weights are implied.</p>}
    </section>
  );
}

function Body({ res, data, demo }: { res: ReadResponse<PipelineData>; data: PipelineData; demo: boolean }) {
  const [inspecting, setInspecting] = useState(false);
  const { sources, filters } = data;
  const rows = stageRows(sources);
  const first = rows[0]!;
  const stage = (key: string) => rows.find((r) => r.key === key)!;
  const sent = stage("confirmedSent");
  const matched = stage("matched");
  const terms = stage("terms");
  const published = stage("published");
  const retained = stage("retained");
  const sends = sendTotals(sources);
  const outcomes = outcomeTotals(sources);
  const total = currentTotal(sources);
  const queueTo = filters.source === "tiktok-shop" ? "/creators/tiktok?view=board" : "/creators/social-cat?view=board";
  const closed = sources.reduce((a, s) => ({ waiting: a.waiting + s.closed.waiting, declined: a.declined + s.closed.declined, expired: a.expired + s.closed.expired }), { waiting: 0, declined: 0, expired: 0 });
  const dispatch = sources.some((s) => s.dispatch === null) ? null : sources.reduce((a, s) => ({ queued: a.queued + s.dispatch!.queued, toReconcile: a.toReconcile + s.dispatch!.toReconcile }), { queued: 0, toReconcile: 0 });
  const stageContext: Record<string, string> = {
    dispatch: dispatch ? `${dispatch.queued} queued ·${THIN}${dispatch.toReconcile} reconcile` : "N/A · no outbound dispatch",
    matchPending: `${closed.waiting} waiting ·${THIN}${closed.declined} declined ·${THIN}${closed.expired} expired`,
  };
  const carried = carriedSearch(filters);
  const unsplit = data.unsplit.map((k) => FACET_NAMES[k]);
  const inbound = filters.route === "inbound";

  return (
    <>
      {res.dataState === "stale" && (
        <Alert state="warning" title="This pipeline may be out of date" testId="pipeline-stale">
          <p>Counts below are from the last successful read, not current.</p>
        </Alert>
      )}
      {res.dataState === "partial" && (
        <Alert state="warning" title="Some pipeline data is missing" testId="pipeline-partial">
          <p>{res.coverage.missingCount ?? "Some"} expected records are missing, so unknown counts show N/A rather than zero.</p>
        </Alert>
      )}
      {unsplit.length > 0 && (
        <p className={acquisition.small} role="status">Filtered by {unsplit.join(", ")}. This demo cohort isn't split by {unsplit.length > 1 ? "those" : "that"}, so its counts don't change.</p>
      )}

      <KpiRow>
        <Kpi label="Confirmed invitations" context={inbound ? "N/A · applicants are never sent an outbound invitation" : `${na(sent.reached)} unique opportunities · not ${na(sends?.attempts ?? null)} attempts`} testId="metric-Confirmed invitations">{na(sent.reached)}</Kpi>
        <Kpi label="Matched / accepted" context={`${matched.conversion ?? "N/A"} of confirmed sends · source-native meaning`} testId="metric-Matched / accepted">{na(matched.reached)}</Kpi>
        <Kpi label="Terms confirmed" context="Acceptance is separate from a Social Cat match" testId="metric-Terms confirmed">{na(terms.reached)}</Kpi>
        <Kpi label="Retained-order creators" context={`${na(retained.reached)} of ${na(published.reached)} published creators · not ${na(outcomes.orders)} orders`} testId="metric-Retained-order creators">{na(retained.reached)}</Kpi>
      </KpiRow>

      <section className={styles.panel} aria-labelledby="funnel-title" data-testid="funnel">
        <div className={acquisition.sectionHead}>
          <div className={acquisition.sectionTitle}>
            <h2 id="funnel-title" className={acquisition.h2}>See the whole journey.</h2>
            <p className={acquisition.small}>Previous-stage conversion and median elapsed time among reached opportunities. Not advanced is not necessarily lost.</p>
          </div>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 172 }} onClick={() => setInspecting(true)}>Inspect cohort</Button>
        </div>
        <Funnel rows={rows} scaleMax={data.scaleMax} />
        <div className={styles.notes}>
          {sources.map((s, i) => (
            <Badge key={s.source} tone={i === 0 ? "violet" : "neutral"} width={152}>{na(s.reached[0] ?? null)} {s.label}</Badge>
          ))}
          <p className={acquisition.small}>Inbound applications use a separate route: accepting an applicant creates a match, with no invented outbound invitation.</p>
        </div>
      </section>

      <div className={styles.pair}>
        <section className={`${styles.panel} ${styles.panelTight}`} aria-labelledby="native-title">
          <div className={acquisition.sectionTitle}>
            <h2 id="native-title" className={acquisition.h2}>A match is a beginning.</h2>
            <p className={acquisition.small}>Keep the source milestone and accepted terms separate.</p>
          </div>
          <DataTable
            caption="Source milestones and accepted terms"
            columns={[{ label: "Source", width: "32.43%" }, { label: "Matched / accepted", width: "32.43%" }, { label: "Terms", width: "17.57%" }, { label: "Active" }]}
            rows={sources.map((s) => [s.label, `${na(s.reached[5] ?? null)} ${s.nativeMilestone}`, na(s.reached[6] ?? null), na(s.reached[7] ?? null)])}
            testId="native-table"
            minWidth={480}
          />
          <p className={acquisition.small}>Social Cat match → contract acceptance. TikTok native acceptance can also evidence terms when its receipt supports them.</p>
        </section>

        <section className={`${styles.panel} ${styles.panelTight}`} aria-labelledby="sends-title">
          <div className={acquisition.sectionTitle}>
            <h2 id="sends-title" className={acquisition.h2}>Count the result, not the click.</h2>
            <p className={acquisition.small}>{sends ? `${sends.approved} approvals resolve to ${sends.confirmed} sent, ${sends.uncertain} uncertain and ${sends.queued} queued.` : NO_SEND_REASON}</p>
          </div>
          {sends ? (
            <>
              <ul className={styles.balance} aria-label={`${sends.confirmed} confirmed, ${sends.uncertain} uncertain, ${sends.queued} queued`} data-testid="send-balance">
                {([["confirmed", sends.confirmed, `${sends.confirmed} confirmed`], ["uncertain", sends.uncertain, String(sends.uncertain)], ["queued", sends.queued, String(sends.queued)]] as const)
                  .filter(([, count]) => count > 0)
                  .map(([key, count, label]) => (
                    <li key={key} className={`${styles.segment} ${styles[key]}`} style={{ flex: `${count} 1 0` }} aria-hidden="true">{label}</li>
                  ))}
              </ul>
              <div className={styles.legend}>
                <Badge tone="warning" width={140}>Uncertain · {sends.uncertain}</Badge>
                <Badge width={126}>Queued · {sends.queued}</Badge>
                <Badge tone="violet" width={132}>Replies · {sends.replies}</Badge>
              </div>
              <p className={acquisition.small}>{sends.attempts} attempts across {sends.opportunities} opportunities. The {sends.attempts - sends.opportunities} additional attempts follow confirmed non-application; neither uncertain result is blindly retried.</p>
            </>
          ) : (
            <div className={styles.legend} data-testid="send-na">
              <Badge tone="warning" width={140}>Uncertain · N/A</Badge>
              <Badge width={126}>Queued · N/A</Badge>
              <Badge tone="violet" width={132}>Replies · N/A</Badge>
            </div>
          )}
          <div>
            {sends && sends.uncertain > 0 ? (
              <LinkButton variant="secondary" to="/runs/demo-run-uncertain?tab=recovery" style={{ minWidth: 242 }}>Reconcile uncertain sends</LinkButton>
            ) : (
              <Button variant="secondary" style={{ minWidth: 242 }} disabledReason={sends ? "No send has an uncertain outcome." : NO_SEND_REASON}>Reconcile uncertain sends</Button>
            )}
          </div>
        </section>
      </div>

      <section className={styles.panel} aria-labelledby="work-title" data-testid="current-work">
        <div className={acquisition.sectionHead}>
          <div className={acquisition.sectionTitle}>
            <h2 id="work-title" className={acquisition.h2}>Where the work sits today.</h2>
            <p className={acquisition.small}>Exclusive stage counts add to {formatCount(total)}. Every held item retains a reason, owner and next action.</p>
          </div>
          <div className={acquisition.actions}>
            <LinkButton variant="secondary" to={`/creators/pipeline?view=branches${carried ? `&${carried}` : ""}`} style={{ minWidth: 172 }}>Paths and branches</LinkButton>
            <LinkButton variant="secondary" to={queueTo} style={{ minWidth: 172 }}>Open work queue</LinkButton>
          </div>
        </div>
        {[CURRENT_STAGES.slice(0, 5), CURRENT_STAGES.slice(5)].map((group, i) => (
          <div key={i} className={styles.stageRow}>
            {group.map((s) => (
              <Kpi key={s.key} label={s.label} context={inbound && s.key === "dispatch" ? "N/A · no outbound dispatch" : (stageContext[s.key] ?? s.next ?? "")} testId={`stage-${s.label}`}>{na(currentCount(sources, s.key))}</Kpi>
            ))}
          </div>
        ))}
      </section>

      <section className={styles.panel} aria-labelledby="outcomes-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="outcomes-title" className={acquisition.h2}>Follow the content through to commerce.</h2>
          <p className={acquisition.small}>Independent demo cohort · {outcomes.posts} posts / {outcomes.comparablePosts} with comparable metrics · Sep–Oct 2026</p>
        </div>
        <KpiRow>
          <Kpi label="Views" context={`Comparable snapshot across ${outcomes.comparablePosts} posts`} testId="metric-Views">{formatCompact(outcomes.views)}</Kpi>
          <Kpi label="Engagement rate" context={`${formatCount(outcomes.engagements)} likes + comments + shares / ${formatCount(outcomes.views)} views`} testId="metric-Engagement rate">{outcomes.engagementRate ?? "N/A"}</Kpi>
          <Kpi label="Attributed orders" context={`${outcomes.fullyRefunded} fully refunded · ${outcomes.retained} retained`} testId="metric-Attributed orders">{outcomes.orders}</Kpi>
          <Kpi label="Attributed net sales" context={`${usd(outcomes.merchandise)} merchandise − ${usd(outcomes.refunds)} refunds`} testId="metric-Attributed net sales">{usd(outcomes.net)}</Kpi>
        </KpiRow>
        <p className={acquisition.small}>
          {na(retained.reached)} creators have retained orders. {netBySource(data).map((s) => `${s.label} source contributes ${usd(s.net)}`).join("; ")}. Daily acquisition cohort; hourly monitoring keeps its own coverage and cohort.
        </p>
      </section>

      <Dialog open={inspecting} title="Inspect cohort" badge={demo ? "Demo" : undefined} onClose={() => setInspecting(false)}>
        <dl className={styles.cohortList}>
          <div><dt>Cohort</dt><dd>{data.cohort.label}</dd></div>
          <div><dt>Membership</dt><dd>{na(first.reached)} opportunities · {sources.map((s) => `${na(s.reached[0] ?? null)} ${s.label}`).join(" + ")}</dd></div>
          <div><dt>Filters</dt><dd>{(Object.keys(FACETS) as (keyof PipelineFilters)[]).map((k) => `${FACET_NAMES[k]}: ${FACETS[k].find((o) => o.value === filters[k])?.label}`).join(" · ")}</dd></div>
          <div><dt>Grain</dt><dd>{data.cohort.grain}</dd></div>
          <div><dt>As of</dt><dd>{dateTime(data.cohort.asOf)}</dd></div>
        </dl>
        <DataTable
          caption="Achievement counts by stage"
          columns={[{ label: "Stage" }, { label: "Reached" }, { label: "Previous stage" }, { label: "Conversion" }, { label: "Median" }]}
          rows={rows.map((r, i) => [r.label, na(r.reached), i === 0 ? "—" : na(rows[i - 1]!.reached), r.conversion ?? "N/A", medianLabel(r)])}
          testId="cohort-table"
          minWidth={520}
        />
        <p>Achievement counts say how many opportunities reached a stage. They overlap, so they don't add up. Current-stage counts are exclusive and are shown separately; the two are never mixed.</p>
        <Button variant="secondary" onClick={() => setInspecting(false)}>Close</Button>
      </Dialog>
    </>
  );
}

const medianLabel = (row: StageRow) => (row.medianDays === null ? "N/A" : `${row.medianDays}d`);

/** The funnel drawing. Bars share one vertical scale (`scaleMax`), so a filtered funnel stays comparable with the whole. */
function Funnel({ rows, scaleMax }: { rows: StageRow[]; scaleMax: number }) {
  const baseline = 272;
  const plot = 220;
  const ticks = [0, 30, 60, 90, 120];
  return (
    <div className={styles.chartScroll} role="region" aria-label={`Opportunity cohort funnel · counts on a shared ${scaleMax} scale`} tabIndex={0}>
      <div className={styles.chart}>
        {ticks.map((t) => {
          const y = baseline - (t * plot) / 120;
          return (
            <span key={t} aria-hidden="true">
              <span className={styles.tick} style={{ top: y - 8 }}>{t}</span>
              <span className={styles.grid} style={{ top: y }} />
            </span>
          );
        })}
        <ol className={styles.columns}>
          {rows.map((r, i) => {
            const height = r.reached === null ? 0 : (r.reached / scaleMax) * plot;
            const top = baseline - height;
            return (
              <li key={r.key} className={styles.column} style={{ left: 42 + i * 120 }} data-testid={`funnel-${r.key}`}>
                {r.reached !== null && <span className={`${styles.bar} ${i < 3 ? styles.early : styles.later}`} style={{ top, height }} aria-hidden="true" />}
                <p className={styles.count} style={{ top: top - 36 }}>{r.reached === null ? "N/A" : r.reached}</p>
                <p className={styles.stage}>{r.label}</p>
                <p className={styles.conversion}>{i === 0 ? "Cohort" : (r.conversion ?? "N/A")}</p>
                <p className={styles.fact} style={{ top: 370 }}>{i === 0 ? "Cohort start" : `${r.medianDays === null ? "N/A" : `${r.medianDays}d`} median`}</p>
                {i > 0 && <p className={styles.fact} style={{ top: 392 }}>{r.notAdvanced === null ? "N/A" : r.notAdvanced} not advanced</p>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
