import type { ProvenanceValue } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { MetricValue, formatCount, formatMoney } from "@/components/MetricValue";
import { ViewError } from "@/components/ViewError";
import type { OverviewData } from "@/fixtures/overview";
import { engagementRate } from "./metrics";

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" }).format(new Date(iso));

/**
 * Performance overview (Figma source 10:217, owner THO-293).
 * DATA SLICE ONLY: values, states and provenance follow the adapter contract.
 * Layout, chart geometry and visuals are PENDING Figma intake; no fidelity is claimed.
 */
export function OverviewPage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, OverviewData>("overviewSummary", {});

  return (
    <section aria-labelledby="overview-title" data-figma-source="10:217">
      <h1 id="overview-title" style={{ font: "var(--text-h1)", marginTop: 0 }}>Performance overview</h1>
      {query.isPending && <p role="status">Loading overview…</p>}
      {query.isError && <ViewError error={query.error} subject="The overview" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && <Body res={query.data} environment={adapter.environment} />}
    </section>
  );
}

function Body({ res, environment }: { res: NonNullable<ReturnType<typeof useView<Record<string, never>, OverviewData>>["data"]>; environment: string }) {
  const freshness = res.sourceFreshness[0];
  return (
    <>
      <p style={{ font: "var(--text-small)", color: "var(--color-text-muted)" }}>
        Metrics as of {freshness?.lastSourceSuccessAt ? dateTime(freshness.lastSourceSuccessAt) : "unknown"} · Environment: {environment}
      </p>
      {res.dataState === "stale" && (
        <div role="alert">Source data is stale ({freshness?.staleReasonCode ?? "reason unknown"}). Values below are the last successful sync, not current.</div>
      )}
      {res.dataState === "partial" && (
        <div role="alert">
          Partial data: {res.coverage.observedCount} of {res.coverage.expectedCount} source records are available. Totals cover only those records.
        </div>
      )}
      {res.dataState === "empty" || !res.data ? (
        <div>
          <h2 style={{ font: "var(--text-h2)" }}>No matching records</h2>
          <p>The source responded, but nothing matches the current filters.</p>
        </div>
      ) : (
        <Metrics data={res.data} />
      )}
    </>
  );
}

function Metrics({ data }: { data: OverviewData }) {
  const eng = engagementRate(data.posts);
  const views = data.posts.every((p) => p.views !== null) ? data.posts.reduce((s, p) => s + (p.views ?? 0), 0) : null;
  const viewsValue: ProvenanceValue<number> = views === null
    ? { ...data.orders, state: "unknown", value: null, reasonCode: "VIEWS_UNAVAILABLE" }
    : { ...data.orders, value: views };
  const engValue: ProvenanceValue<number> = eng.state === "known"
    ? { ...data.orders, value: eng.ratePct }
    : { ...data.orders, state: "notApplicable", value: null, reasonCode: eng.reasonCode === "NO_COMPLETE_POSTS" ? "SHARES_UNAVAILABLE" : eng.reasonCode };

  const items: { label: string; node: JSX.Element; note?: string }[] = [
    { label: "Orders", node: <MetricValue value={data.orders} format={formatCount} />, note: "All store orders in period" },
    { label: "Store sales", node: <MetricValue value={data.storeSales} format={formatMoney} />, note: "Accounting basis provisional until the net-sales definition is frozen" },
    { label: "Post views", node: <MetricValue value={viewsValue} format={formatCount} />, note: `Latest cumulative views across ${data.posts.length} posts` },
    { label: "Engagement rate", node: <MetricValue value={engValue} format={(v) => `${v.toFixed(1)}%`} />, note: "(likes + comments + shares) ÷ views; saves excluded" },
    { label: "Attributed orders", node: <MetricValue value={data.attributedOrders} format={formatCount} />, note: "Distinct source + order ID; code → UTM → platform" },
    { label: "Attributed net sales", node: <MetricValue value={data.attributedNetSales} format={formatMoney} />, note: "Not GMV" },
  ];
  return (
    <>
      <h2 style={{ font: "var(--text-h2)" }}>Key metrics</h2>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--space-4)" }}>
        {items.map((i) => (
          <div key={i.label} style={{ border: "1px solid var(--color-border)", padding: "var(--space-4)" }}>
            <dt style={{ font: "var(--text-label)" }}>{i.label}</dt>
            <dd style={{ margin: 0, font: "var(--text-metric)" }} data-testid={`metric-${i.label}`}>{i.node}</dd>
            {i.note && <dd style={{ margin: 0, font: "var(--text-small)", color: "var(--color-text-muted)" }}>{i.note}</dd>}
          </div>
        ))}
      </dl>
    </>
  );
}
