import type { NativeLaunchReconciliation } from "@/creator-agent/analytics/views";
import { NativeReconciliation } from "./NativeReconciliation";
import { useReportingPeriod } from "./reportingPeriod";
import { Link } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { formatCount, formatMoneyExact } from "@/components/MetricValue";
import type { ReconciliationData } from "@/fixtures/analytics";
import { FRESHNESS_WORDS, classifyFreshness } from "./freshness";
import type { MatrixCell, MatrixRow } from "./reconciliation";
import { Card, PageHeader, SectionHeading, Table, ViewShell, dateTime } from "./parts";
import styles from "./Analytics.module.css";

const show = (unit: MatrixRow["unit"], cell: MatrixCell) => (cell.value === null ? "N/A" : unit === "usd" ? formatMoneyExact({ minorUnits: cell.value, currency: "USD" }) : formatCount(cell.value));
const STATUS: Record<MatrixRow["status"], { label: string; tone: "success" | "danger" | "warning" }> = {
  matches: { label: "Matches", tone: "success" },
  differs: { label: "Differs", tone: "danger" },
  unknown: { label: "Not reconciled", tone: "warning" },
};

/** Source freshness and the overview-to-detail reconciliation matrix (GTM275). Read-only; it explains numbers and changes none. */
export function ReconciliationPage() {
  const period = useReportingPeriod();
  const query = useView<Record<string, never>, ReconciliationData | NativeLaunchReconciliation>("launchReconciliation", {}, period);
  return (
    <section aria-labelledby="recon-title" className={styles.page}>
      <PageHeader id="recon-title" title="Do the pages agree?" subtitle="Each source's freshness, and every figure the Overview shares with a detail page.">
        <LinkButton variant="secondary" to="/launch" style={{ minWidth: 172 }}>Back to the snapshot</LinkButton>
      </PageHeader>
      <ViewShell query={query} subject="Reconciliation" emptyTitle="Nothing to reconcile" emptyBody="The source responded, but there is no freshness or reconciliation data to show.">
        {(data) => data.datasetKey === "analytics-native" ? <NativeReconciliation data={data} refresh={() => void query.refetch()} refreshing={query.isFetching} /> : <Body data={data} />}
      </ViewShell>
    </section>
  );
}

function Body({ data }: { data: ReconciliationData }) {
  const rows = data.freshness.map((f) => ({ f, state: classifyFreshness(f, data.asOf) }));
  const differing = data.matrix.filter((m) => m.status !== "matches").length;
  return (
    <>
      <Card labelledBy="fresh-title" className={styles.gap18} testId="freshness">
        <SectionHeading id="fresh-title" title="Each source has its own freshness" note="One source's state never describes another's. Only fresh and no-change values read as current." />
        <Table
          caption="Source freshness"
          columns={[{ label: "Source", width: 240 }, { label: "State", width: 150 }, { label: "Last good sync", width: 220 }, { label: "Feeds", width: 300 }, { label: "What it means", width: 420 }]}
          rows={rows.map(({ f, state }) => ({
            key: f.sourceId,
            cells: [
              f.label,
              <Badge key="s" tone={FRESHNESS_WORDS[state].tone}>{FRESHNESS_WORDS[state].label}</Badge>,
              f.lastSourceSuccessAt ? dateTime(f.lastSourceSuccessAt) : "Never",
              f.feeds,
              FRESHNESS_WORDS[state].meaning,
            ],
          }))}
        />
      </Card>
      <Card labelledBy="matrix-title" className={styles.gap18} testId="matrix">
        <SectionHeading id="matrix-title" title={differing === 0 ? "Every shared figure matches" : `${differing} of ${data.matrix.length} shared figures need attention`} note="Exact values, not rounded. A page with no value makes the row Not reconciled, never a match." />
        <Table
          caption="Overview to detail reconciliation matrix"
          columns={[{ label: "Metric", width: 220 }, { label: "Status", width: 160 }, { label: "Where it appears", width: 800 }]}
          rows={data.matrix.map((m) => ({
            key: m.metric,
            cells: [
              m.metric,
              <Badge key="b" tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>,
              <span key="c">
                {m.cells.map((c, i) => <span key={c.page}>{i > 0 && " · "}<Link to={c.route}>{c.page}</Link> {show(m.unit, c)}</span>)}
                {m.reason && <span style={{ display: "block", color: "var(--color-muted)" }}>{m.reason}</span>}
              </span>,
            ],
          }))}
        />
      </Card>
    </>
  );
}
