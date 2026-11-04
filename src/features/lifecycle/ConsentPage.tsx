import { useRef, useState } from "react";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Alert } from "@/components/Alert";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { ContextLine, Page, PageHeader, Panel, Small } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import { InfoDialog } from "@/features/settings/shared";
import type { ConsentData } from "@/fixtures/lifecycle";
import { consentReconciles, consentSegments, formatCount, percent } from "./metrics";
import styles from "./Lifecycle.module.css";

/**
 * Consent and audience eligibility (Figma source 11:750, owner THO-304). Counts only: consent stays in the email provider.
 * Unknown consent is held, never counted as opted in, and a snapshot whose categories don't add up is refused rather than drawn.
 */
export function ConsentPage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, ConsentData>("consentEligibility", {});
  const [providerOpen, setProviderOpen] = useState(false);
  const exclusionsRef = useRef<HTMLDivElement>(null);
  const demo = adapter.kind === "demo";
  const data = query.data?.data ?? null;

  const reviewExclusions = () => {
    exclusionsRef.current?.scrollIntoView?.({ block: "start" });
    exclusionsRef.current?.focus();
  };

  return (
    <Page labelledBy="consent-title" source="11:750">
      <PageHeader id="consent-title" title="A clear view of who is eligible." subtitle="Consent stays in the email provider. Only aggregate counts appear here.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 160 }} onClick={() => setProviderOpen(true)}>Open provider</Button>
        <Button style={{ minWidth: 184 }} disabledReason={data ? null : "Available once the snapshot has loaded."} onClick={reviewExclusions}>Review exclusions</Button>
      </PageHeader>
      <ReadState res={query.data} subject="Consent eligibility" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading consent eligibility…" />}
      {query.isError && <ViewError error={query.error} subject="Consent eligibility" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (data ? <Body res={query.data as ReadResponse<ConsentData>} data={data} demo={demo} exclusionsRef={exclusionsRef} /> : <EmptyState state="Empty" title="No consent snapshot yet"><p>The source responded, but no provider snapshot exists. That isn't a finding that nobody is eligible.</p></EmptyState>)}
      <InfoDialog open={providerOpen} title="Open provider" demo={demo} onClose={() => setProviderOpen(false)}>
        <p>No email provider is selected, so there is no provider to open and no verified link to offer. Consent, preferences and suppression will live there, and none is copied into this dashboard.</p>
      </InfoDialog>
    </Page>
  );
}

function Body({ data, demo, exclusionsRef }: { res: ReadResponse<ConsentData>; data: ConsentData; demo: boolean; exclusionsRef: React.RefObject<HTMLDivElement> }) {
  if (!consentReconciles(data))
    return (
      <Alert state="error" title="This snapshot doesn't add up">
        <p>The four consent categories don't total the {formatCount(data.total)} records, so no eligible count is shown. Nothing will be sent from this snapshot.</p>
      </Alert>
    );
  const segments = consentSegments(data);
  const share = percent(data.eligible, data.total);
  return (
    <>
      <ContextLine badge={data.context.badge} width={180}>{data.context.text}</ContextLine>
      <KpiRow>
        <Kpi label="Eligible now" context={`${share ?? "Unknown"} of ${formatCount(data.total)} records`} testId="metric-Eligible now">{formatCount(data.eligible)}</Kpi>
        <Kpi label="Opted out" context="Excluded from every pending send" testId="metric-Opted out">{formatCount(data.withdrawn)}</Kpi>
        <Kpi label="Bounced / suppressed" context="Provider suppression wins" testId="metric-Bounced / suppressed">{formatCount(data.suppressed)}</Kpi>
        <Kpi label="Consent unknown" context="Held until source resolves" warn testId="metric-Consent unknown">{formatCount(data.unknown)}</Kpi>
      </KpiRow>

      <Panel title="Send only to the eligible audience" headingId="audience-title" large testId="audience">
        <div className={styles.bar} role="img" aria-label={`Consent across ${formatCount(data.total)} records: ${segments.map((s) => s.label).join(", ")}.`} data-testid="consent-bar">
          {segments.map((s) => <span key={s.key} style={{ width: `${(100 * s.count) / data.total}%`, background: s.color }} />)}
        </div>
        <ul className={styles.legend}>
          {segments.map((s) => <li key={s.key}><Badge tone={s.tone} width={288}>{s.label}</Badge></li>)}
        </ul>
        <Small>The bar uses one mutually exclusive category per record. Unknown is not treated as opted in.</Small>
      </Panel>

      <div ref={exclusionsRef} tabIndex={-1} id="exclusions" style={{ outline: "none" }}>
        <Panel title="Why an enrollment stops" headingId="exclusions-title" large tight testId="exclusions">
          <DataTable
            variant="ledger"
            caption="Why an enrollment stops"
            columns={[{ label: "REASON", width: "24.038%" }, { label: "ACTION", width: "37.66%" }, { label: "RECOVERY" }]}
            rows={data.exclusions.map((e) => [e.reason, e.action, e.recovery])}
            minWidth={720}
          />
        </Panel>
      </div>
      <Small>{data.footnote}</Small>
      {demo && <Small>Demo · this is an illustrative snapshot of 1,000 synthetic records. No contact or consent record exists.</Small>}
    </>
  );
}
