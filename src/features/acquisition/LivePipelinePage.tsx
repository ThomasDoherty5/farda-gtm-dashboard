import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Button, LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Dialog } from "@/components/Dialog";
import { DataTable } from "@/components/DataTable";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ViewError } from "@/components/ViewError";
import { Kpi, KpiRow } from "@/components/Kpi";
import { funnelFilterSchema, stageNames, type FunnelFilters, type LivePipeline } from "@/creator-agent/funnelContract";
import { FilterButton } from "./FilterButton";
import { AcquisitionTabs } from "./AcquisitionTabs";
import { Funnel } from "./FunnelChart";
import { percent } from "./pipelineMetrics";
import acquisition from "./Acquisition.module.css";
import styles from "./Pipeline.module.css";

const dimensions = [
  ["source", "Acquisition source"],
  ["account", "Provider account"],
  ["route", "Acquisition route"],
  ["network", "Publishing network"],
  ["checkout", "Checkout destination"],
  ["cohort", "Campaign cohort"],
  ["start", "Cohort from (UTC)"],
  ["end", "Cohort before (UTC)"],
  ["asOf", "As of (UTC)"],
  ["policy", "Policy version"],
  ["offer", "Offer version"],
] as const;
const choices: Partial<Record<keyof FunnelFilters, string[]>> = {
  route: ["inbound", "outbound"],
  network: ["instagram", "tiktok", "other", "unknown"],
  checkout: ["website", "tiktok-shop", "unknown"],
};
const dates: readonly string[] = ["start", "end", "asOf"];
const fmt = (v: number | null) => (v === null ? "N/A" : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const stageLabel = (key: string) => stageNames[key as keyof typeof stageNames] ?? key;
const headings = (...labels: string[]) => labels.map((label) => ({ label }));

export function LivePipelinePage({ branches }: { branches: boolean }) {
  const [search, setSearch] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const args = Object.fromEntries(dimensions.flatMap(([k]) => (search.has(k) ? [[k, search.get(k)]] : [])));
  const parsed = funnelFilterSchema.safeParse(args);
  const setFilter = (form: HTMLFormElement) => {
    const data = new FormData(form),
      next = new URLSearchParams();
    if (branches) next.set("view", "branches");
    for (const [key] of dimensions) {
      const value = String(data.get(key) ?? "").trim();
      if (!value) continue;
      if (dates.includes(key)) {
        const date = new Date(value + "Z");
        if (!Number.isFinite(date.getTime())) {
          setError("Enter a valid UTC date and time.");
          return;
        }
        next.set(key, date.toISOString());
      } else next.set(key, value);
    }
    const check = funnelFilterSchema.safeParse(
      Object.fromEntries(dimensions.flatMap(([k]) => (next.has(k) ? [[k, next.get(k)]] : []))),
    );
    if (!check.success) {
      setError("Check the cohort dates and filter values.");
      return;
    }
    setError("");
    setSearch(next);
    setEditing(false);
  };
  const facet = (key: "source" | "network" | "checkout", name: string, options: string[]) => {
    const value = search.get(key) ?? "";
    const update = (selection: string) => {
      const next = new URLSearchParams(search);
      if (selection) next.set(key, selection);
      else next.delete(key);
      setSearch(next);
    };
    return (
      <FilterButton
        name={name}
        title={"Choose " + name.toLowerCase()}
        value={value}
        onChange={update}
        options={[
          { value: "", label: "All" },
          ...[...new Set([...options, ...(value ? [value] : [])])].map((v) => ({ value: v, label: v })),
        ]}
        width={174}
      />
    );
  };
  const toggle = new URLSearchParams(search);
  if (branches) toggle.delete("view");
  else toggle.set("view", "branches");
  return (
    <section
      className={acquisition.page}
      data-testid="live-acquisition"
      data-figma-source="102:74"
      aria-labelledby="pipeline-title"
    >
      <div className={acquisition.titleRow}>
        <div className={acquisition.heading}>
          <h1 id="pipeline-title">
            {branches ? "Closed paths and optional branches." : "From discovery to repeat sales."}
          </h1>
          <p>Daily acquisition · saved source observations · opportunity cohort</p>
        </div>
        <LinkButton variant="secondary" to="/creators/discovery">
          Daily sourcing
        </LinkButton>
        <LinkButton to={"/creators/pipeline?" + toggle.toString()}>
          {branches ? "Back to pipeline" : "Paths and branches"}
        </LinkButton>
      </div>
      <AcquisitionTabs current="Pipeline" />
      <div className={acquisition.controls}>
        {facet("source", "Source", ["social-cat", "tiktok-shop"])}
        {facet("network", "Network", choices.network!)}
        {facet("checkout", "Checkout", choices.checkout!)}
        <Button variant="secondary" aria-haspopup="dialog" onClick={() => setEditing(true)}>
          Filter cohort
        </Button>
        <Badge tone="violet">{Object.keys(args).length} filters</Badge>
      </div>
      <div className={acquisition.context}>
        <p className={acquisition.contextTitle}>Commission-only acquisition</p>
        <p className={acquisition.small}>
          Product and shipping require separate approval. Historical payables retain their original receipts.
        </p>
      </div>
      <Dialog open={editing} title="Filter cohort" onClose={() => setEditing(false)}>
        <form
          className={styles.filters}
          onSubmit={(e) => {
            e.preventDefault();
            setFilter(e.currentTarget);
          }}
        >
          {dimensions.map(([key, label]) => (
            <label key={key}>
              {label}
              {choices[key] ? (
                <select name={key} defaultValue={args[key] ?? ""}>
                  <option value="">All</option>
                  {choices[key]!.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input
                  name={key}
                  type={dates.includes(key) ? "datetime-local" : "text"}
                  maxLength={240}
                  defaultValue={dates.includes(key) ? (args[key] ?? "").slice(0, 16) : (args[key] ?? "")}
                />
              )}
            </label>
          ))}
          {error && <p role="alert">{error}</p>}
          <Button type="submit">Apply filters</Button>
          <Button
            variant="secondary"
            onClick={() => {
              setSearch(branches ? { view: "branches" } : {});
              setEditing(false);
              setError("");
            }}
          >
            Clear filters
          </Button>
        </form>
      </Dialog>
      {parsed.success ? (
        <Cohort key={JSON.stringify(parsed.data)} filters={parsed.data} branches={branches} />
      ) : (
        <EmptyState state="Error" title="Invalid cohort filters">
          Open Filter cohort to correct the dates or selections.
        </EmptyState>
      )}
    </section>
  );
}
function Cohort({ filters, branches }: { filters: FunnelFilters; branches: boolean }) {
  const query = useView<FunnelFilters, LivePipeline>(branches ? "pipelineBranches" : "pipelineSummary", filters);
  if (query.isPending) return <SkeletonCard label="Loading the acquisition pipeline…" />;
  if (query.isError)
    return (
      <ViewError
        error={query.error}
        subject="The acquisition pipeline"
        hasPriorData={false}
        onRetry={() => void query.refetch()}
      />
    );
  const data = query.data?.data;
  if (data && data.datasetKey !== "funnel-ledger")
    return (
      <EmptyState state="Error" title="Funnel data unavailable">
        This connection has not supplied a saved funnel projection.
      </EmptyState>
    );
  if (!data || !data.coverage.opportunities)
    return (
      <EmptyState state="Empty" title="No acquisition events match">
        No source observations are recorded for this selection. Adjust the filters to check a different cohort.
      </EmptyState>
    );
  return (
    <>
      {query.data?.dataState === "stale" && <p role="status">Showing an earlier saved acquisition snapshot.</p>}
      <Contents data={data} branches={branches} />
    </>
  );
}
function QuantityTable({ label, data }: { label: string; data: LivePipeline["outcomes"] }) {
  return (
    <DataTable
      caption={label}
      columns={headings("Measure", "Value", "Unit", "Coverage / denominator")}
      rows={data.map((x) => [x.name, fmt(x.value), x.unit, x.reason ?? fmt(x.denominator)])}
    />
  );
}
function Contents({ data, branches }: { data: LivePipeline; branches: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [inspectCohort, setInspectCohort] = useState(false);
  const item = data.queue.find((r) => r.id === selected);
  const rows = data.milestones.map((m) => ({
    key: m.key,
    label: stageNames[m.key],
    reached: m.reached,
    conversion: percent(m.advanced, m.eligible),
    medianDays: m.medianDays == null ? null : Math.round(m.medianDays * 100) / 100,
    notAdvanced: m.eligible != null && m.advanced != null ? m.eligible - m.advanced : null,
  }));
  const info = data.coverage;
  const inboundOnly = data.queue.every((q) => q.route === "inbound");
  return (
    <>
      <p className={acquisition.small} role="status">
        {info.opportunities} opportunities · {info.creators} observed creators · {info.mature} mature, {info.immature}{" "}
        immature, {info.unknownMaturity} unknown maturity · as of {data.asOf} UTC.{" "}
        {info.incomplete &&
          `Partial coverage: ${info.missingTimes} missing event times, ${info.unresolvedIdentity} unresolved identities, ${info.unavailable} access or mapping exceptions.`}
      </p>
      {!branches && (
        <>
          <KpiRow>
            {(["confirmedSent", "matched", "terms", "retainedOrder"] as const).map((key) => (
              <Kpi key={key} label={stageNames[key]} context="Distinct observed opportunities">
                {inboundOnly && key === "confirmedSent"
                  ? "N/A"
                  : fmt(data.milestones.find((s) => s.key === key)?.reached ?? null)}
              </Kpi>
            ))}
          </KpiRow>
          <section className={styles.panel}>
            <div className={acquisition.sectionHead}>
              <h2 className={acquisition.h2}>See the whole journey.</h2>
              <Button variant="secondary" aria-haspopup="dialog" onClick={() => setInspectCohort(true)}>
                Inspect cohort
              </Button>
            </div>
            <Dialog open={inspectCohort} title="Inspect cohort" onClose={() => setInspectCohort(false)}>
              <p>
                {info.opportunities} opportunities and {info.creators} observed creators. {info.mature} have reached
                their recorded maturity time.
              </p>
              <p>
                Counts use individual opportunities with recorded stage receipts. Conversion uses mature opportunities
                observed at both stages over the eligible mature previous stage. Elapsed time uses known event times in
                UTC.
              </p>
              <p>Snapshot: {data.asOf}</p>
              <Button variant="secondary" onClick={() => setInspectCohort(false)}>
                Close
              </Button>
            </Dialog>
            <Funnel
              rows={rows.map((r) => (inboundOnly && r.key === "confirmedSent" ? { ...r, reached: null } : r))}
              scaleMax={info.opportunities}
            />
            <DataTable
              caption="Opportunity milestones and matching denominators"
              columns={headings(
                "Milestone",
                "Reached",
                "Eligible prior stage",
                "Reached both",
                "Conversion",
                "Known time pairs",
                "Median days",
              )}
              rows={data.milestones.map((m) => [
                stageNames[m.key],
                inboundOnly && m.key === "confirmedSent" ? "N/A" : m.reached,
                fmt(m.eligible),
                fmt(m.advanced),
                percent(m.advanced, m.eligible) ?? "N/A",
                m.knownPairs,
                fmt(m.medianDays),
              ])}
            />
          </section>
          <div className={styles.pair}>
            <section className={styles.panel}>
              <h2 className={acquisition.h2}>Count the result, not the click.</h2>
              <DataTable
                caption="Observed invitation activity"
                columns={headings("Event", "Count")}
                rows={Object.entries(data.sends).map(([k, v]) => [
                  (
                    {
                      attempts: "Dispatch attempts",
                      recipients: "Distinct attempted recipients",
                      confirmed: "Confirmed sends",
                      uncertain: "Uncertain sends",
                      queued: "Queued unsent",
                      replies: "Replies",
                      matched: "Native matches / acceptances",
                    } as Record<string, string>
                  )[k],
                  inboundOnly && !["matched", "replies"].includes(k) ? "N/A" : v,
                ])}
              />
            </section>
            <section className={styles.panel}>
              <h2 className={acquisition.h2}>A match is a beginning.</h2>
              <p>
                Inbound applications have no outbound invitation. A native match and accepted offer terms have separate
                source receipts.
              </p>
            </section>
          </div>
        </>
      )}
      <section className={styles.panel}>
        <h2 className={acquisition.h2}>Where the work sits today.</h2>
        <p>
          {Object.entries(data.queueCounts)
            .map(([s, n]) => stageLabel(s) + " " + n)
            .join(" · ")}
        </p>
        <DataTable
          caption="Current opportunity work queue"
          columns={headings("Opportunity", "Current stage", "Owner", "Age (days)", "Blockers", "Next action")}
          rows={data.queue.map((q) => [
            <Button variant="ghost" onClick={() => setSelected(q.id)}>
              Inspect {q.id}
            </Button>,
            stageLabel(q.stage),
            q.owner ?? "Unassigned",
            fmt(q.ageDays),
            q.blockers.join(" · ") || "None recorded",
            q.nextAction,
          ])}
        />
        {Object.keys(data.exclusions).length > 0 && (
          <p>
            Primary exclusions ·{" "}
            {Object.entries(data.exclusions)
              .map(([k, v]) => k + " " + v)
              .join(" · ")}
          </p>
        )}
      </section>
      <section className={styles.panel}>
        <h2 className={acquisition.h2}>
          {branches ? "Samples, obligations and repeat participation" : "Follow the content through to commerce."}
        </h2>
        {branches ? (
          <QuantityTable label="Lifecycle and optional branches" data={data.lifecycle} />
        ) : (
          <>
            <QuantityTable label="Mature cohort outcomes" data={data.outcomes} />
            <p className={acquisition.small}>
              Daily acquisition outcomes use this cohort’s maturity and source coverage. Hourly content monitoring uses
              its own reporting window.
            </p>
          </>
        )}
      </section>
      <details className={styles.panel}>
        <summary>Throughput and acquisition costs</summary>
        <QuantityTable label="Acquisition economics" data={data.economics} />
      </details>
      <Dialog open={Boolean(item)} title="Opportunity evidence" onClose={() => setSelected(null)}>
        {item && (
          <>
            <p>
              {item.id} · {item.creator} · {item.source} / {item.account} · {item.route}
            </p>
            <p>
              Source quota {fmt(item.quotaLimit)} · {item.quotaPeriod ?? "period unknown"}
            </p>
            <DataTable
              caption="Saved event receipts"
              columns={headings("Fact", "Source evidence", "Occurred / observed (UTC)", "Context")}
              rows={item.facts.map((f) => [
                f.type,
                f.url ? (
                  <a href={f.url} rel="noopener noreferrer" target="_blank">
                    {f.evidence}
                  </a>
                ) : (
                  f.evidence
                ),
                [f.occurredAt ?? "Unknown", f.observedAt].join(" / "),
                [
                  f.version,
                  f.nativeAction,
                  f.nativeActor,
                  f.deliverable,
                  f.post,
                  f.review,
                  f.attribution,
                  f.window,
                  f.runId,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ])}
            />
          </>
        )}
        <Button variant="secondary" onClick={() => setSelected(null)}>
          Close
        </Button>
      </Dialog>
    </>
  );
}
