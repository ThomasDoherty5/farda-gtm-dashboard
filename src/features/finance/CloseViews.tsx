import { useView } from "@/adapter/useView";
import { Badge, type BadgeTone } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { FlatTable, Note, Notice, Page, PageHeader, Panel } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { cpaPolicyLabel, currentRevision, isLocked, MONTH_STATUS_LABEL, supersededBy, type Manifest, type MonthRow, type MonthStatus } from "@/fixtures/financeClose";
import { FinanceNav } from "./FinanceNav";

const TONE: Record<MonthStatus, BadgeTone> = { open: "neutral", reconciling: "warning", blocked: "danger", awaitingCpa: "warning", readyToExport: "violet", exporting: "violet", failed: "danger", closed: "success", reopened: "warning", revised: "violet" };

function Shell({ id, title, subtitle, children, query }: { id: string; title: string; subtitle: string; children: React.ReactNode; query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown; data: unknown } }) {
  return (
    <Page aria-labelledby={id}>
      <PageHeader id={id} title={title} subtitle={subtitle}>
        <LinkButton variant="secondary" to="/finance/close/2026-10" style={{ minWidth: 190 }}>Back to the close</LinkButton>
      </PageHeader>
      <FinanceNav current="close" />
      {query.isPending && <SkeletonCard label="Loading…" />}
      {query.isError && query.error && <ViewError error={query.error} subject={title} hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {children}
    </Page>
  );
}

/** Which months are open, closed, reopened or revised (FIN274-02/03). A revision keeps the one it replaced readable; a reopened month is not locked. */
export function MonthsView() {
  const query = useView<Record<string, never>, { datasetKey: "finance-months-demo"; months: MonthRow[] }>("monthsHistory", {});
  const months = query.data?.data?.months ?? null;
  return (
    <Shell id="months-title" title="Months, closes and revisions." subtitle="Finance / Month-end · A close can be reopened or revised, and nothing is overwritten." query={query}>
      {query.data && !months && <EmptyState state="Empty" title="No months recorded"><p>The source responded, but no period history exists. That is not an all-open ledger.</p></EmptyState>}
      {months && (
        <>
          <Notice tone="violet" label="Synthetic" title="Demo months, not a ledger" testId="months-notice">Nothing here is closed in a real ledger. A month closes only through the accounting package and a CPA sign-off.</Notice>
          <Panel title="Months" subtitle="Status, sign-off and every revision" testId="months">
            <FlatTable
              caption="Months"
              testId="months-table"
              columns={[{ label: "Month", width: 150 }, { label: "Status", width: 140 }, { label: "Lock", width: 190 }, { label: "Revisions", width: 520 }]}
              rows={months.map((m) => ({
                key: m.period,
                cells: [
                  m.label,
                  <Badge key="s" tone={TONE[m.status]}>{MONTH_STATUS_LABEL[m.status]}</Badge>,
                  isLocked(m) ? `Locked at revision ${currentRevision(m)}` : m.status === "reopened" ? "Not locked: reopened, needs a new sign-off" : m.status === "open" ? "Not locked: still open" : "Not locked: current revision is not signed off",
                  m.revisions.length === 0 ? "None yet" : m.revisions.map((r) => `r${r.n} ${r.at}: ${r.reason}${supersededBy(m, r.n) ? ` (superseded by r${supersededBy(m, r.n)}, still readable)` : ""}`).join(" · "),
                ],
              }))}
            />
          </Panel>
          <Panel title="Tax treatment" subtitle="Jurisdiction notes, not rules" testId="tax-notes">
            <ul aria-label="Tax notes">{months.map((m) => <li key={m.period} data-testid={`tax-${m.period}`}><strong>{m.label}</strong>: {m.taxNote}</li>)}</ul>
            <Note>{cpaPolicyLabel({ reference: null })}. No tax rule or rate is set in this app.</Note>
          </Panel>
        </>
      )}
    </Shell>
  );
}

/** The dry-run month and report manifest (FIN-EVIDENCE): what a real close would produce, with the CPA tax-policy reference. Nothing is generated. */
export function ManifestView() {
  const query = useView<Record<string, never>, Manifest>("reportManifest", {});
  const m = query.data?.data ?? null;
  return (
    <Shell id="manifest-title" title="What a close would produce." subtitle="Finance / Month-end · Dry-run manifest, synthetic." query={query}>
      {query.data && !m && <EmptyState state="Empty" title="No manifest"><p>The source responded, but no dry-run manifest exists.</p></EmptyState>}
      {m && (
        <>
          <Notice tone="warning" label="Dry run" title={`${m.manifestId} · ${m.label}`} testId="manifest-notice">Synthetic and labeled. No report has been generated and no period is closed. {cpaPolicyLabel(m.policy)}.</Notice>
          <Panel title="Report manifest" subtitle="Each report the close would export" testId="manifest">
            <FlatTable
              caption="Report manifest"
              testId="manifest-table"
              columns={[{ label: "Report", width: 190 }, { label: "Period", width: 90 }, { label: "Expected files", width: 280 }, { label: "Basis", width: 240 }, { label: "State", width: 150 }, { label: "Tax-policy reference", width: 240 }]}
              rows={m.rows.map((r) => ({ key: r.report, cells: [r.report, r.period, r.expectedFiles.join(", "), `${r.basis} · ${r.source}`, `${r.state} · no timestamp or checksum`, cpaPolicyLabel(r.policyRef)] }))}
            />
          </Panel>
        </>
      )}
    </Shell>
  );
}
