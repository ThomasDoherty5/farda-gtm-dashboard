import { useState } from "react";
import { Link } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { ContextLine, DetailRows, Halves, Page, PageHeader, Panel, PillNav, Small, kit } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import { InfoDialog } from "@/features/settings/shared";
import type { LifecycleData } from "@/fixtures/lifecycle";
import { formatCount, percent } from "./metrics";
import styles from "./Lifecycle.module.css";

/** Customer lifecycle (Figma source 5:289, owner THO-304). Aggregate counts only: no contact record, consent or send lives here. */
export function LifecyclePage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, LifecycleData>("lifecycleOverview", {});
  const [dialog, setDialog] = useState<"definitions" | "tool" | null>(null);
  const demo = adapter.kind === "demo";
  const data = query.data?.data ?? null;

  return (
    <Page labelledBy="lifecycle-title" source="5:289">
      <PageHeader id="lifecycle-title" title="From first interest to everyday use." subtitle="Follow consent, delivery, setup and support without copying private customer records.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 184 }} disabledReason={data ? null : "Available once the lifecycle has loaded."} onClick={() => setDialog("definitions")}>Metric definitions</Button>
        <Button aria-haspopup="dialog" style={{ minWidth: 184 }} onClick={() => setDialog("tool")}>Open email tool</Button>
      </PageHeader>
      <PillNav label="Overview sections" items={[{ label: "GTM overview", to: "/overview", width: 132 }, { label: "Customer lifecycle", to: "/customers/lifecycle", width: 180, current: true }, { label: "Launch control", to: "/launch?view=control", width: 148 }]} />
      {query.isPending && <SkeletonCard label="Loading the customer lifecycle…" />}
      {query.isError && <ViewError error={query.error} subject="The customer lifecycle" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (data ? <Body res={query.data as ReadResponse<LifecycleData>} data={data} demo={demo} /> : <EmptyState state="Empty" title="No lifecycle data yet"><p>The source responded, but no customer flow has ever been recorded.</p></EmptyState>)}
      <InfoDialog open={dialog === "tool"} title="Open email tool" demo={demo} onClose={() => setDialog(null)}>
        <p>No email platform is selected, so there is no tool to open and no verified link to offer. Contacts, consent and suppression will live in the selected provider, and nothing is sent from here.</p>
      </InfoDialog>
      {data && (
        <InfoDialog open={dialog === "definitions"} title="Metric definitions" demo={demo} onClose={() => setDialog(null)}>
          <DetailRows rows={data.metrics.map((m) => [m.label, m.definition] as const)} />
        </InfoDialog>
      )}
    </Page>
  );
}

function Body({ data, demo }: { res: ReadResponse<LifecycleData>; data: LifecycleData; demo: boolean }) {
  const activation = percent(data.activation.weekOne, data.activation.paired);
  const share = data.activation.paired > 0 ? (100 * data.activation.weekOne) / data.activation.paired : 0;
  return (
    <>
      <ContextLine badge={data.context.badge}>{data.context.text}</ContextLine>
      <KpiRow>
        {data.metrics.map((m) => <Kpi key={m.label} label={m.label} context={m.context} testId={`metric-${m.label}`}>{formatCount(m.value)}</Kpi>)}
      </KpiRow>

      <Panel title="Four flows, one clear consent rule" note="The selected email provider owns contact records, preferences and suppression. This dashboard displays aggregate outcomes." headingId="flows-title" large headingGap={20} testId="flows">
        <DataTable
          variant="ledger"
          caption="Customer communication flows"
          columns={[{ label: "FLOW", width: "17.628%" }, { label: "ENTRY & EXIT", width: "37.981%" }, { label: "DELIVERY GATE", width: "31.25%" }, { label: "STATE" }]}
          rows={data.flows.map((f) => [
            // One action per row: where the state column already links to the flow, the name is text, not a second link to the same place.
            f.state.endsWith("→") ? f.name : <Link key="n" to={`/customers/flows/${f.key}`} className={kit.cellLink}>{f.name}</Link>,
            f.entryExit,
            f.gate,
            f.state.endsWith("→") ? <Link key="s" to={`/customers/flows/${f.key}`} className={kit.cellLink}>{f.state}</Link> : f.state,
          ])}
          minWidth={760}
        />
      </Panel>

      <Halves>
        <Panel title="Did setup help people get started?" headingId="activation-title" large tight testId="activation-card">
          <DetailRows rows={[["Paired count", formatCount(data.activation.paired)], ["Active in week one", formatCount(data.activation.weekOne)]]} wide />
          <div className={styles.track} role="progressbar" aria-label="Week-one active, as a share of paired" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 10) / 10}><div className={styles.fill} style={{ width: `${share}%` }} /></div>
          <Small>Week-one activation: {data.activation.weekOne} / {data.activation.paired} = {activation ?? "unknown"}. Count-only telemetry; no account, device or health details in this dashboard.</Small>
          <div><LinkButton variant="secondary" to="/customers/activation" style={{ minWidth: "min(300px, 100%)" }}>View activation definitions</LinkButton></div>
        </Panel>
        <Panel title="Close the loop after purchase" headingId="loop-title" large tight testId="close-loop">
          <p className={styles.bodyInk}>{data.closeLoop}</p>
          <div><Badge tone="warning" width={280}>{data.returnsAwaitingInspection} returns awaiting inspection</Badge></div>
          <Small>{data.closeLoopNote}</Small>
          <div><LinkButton to="/support/cases/demo-case-1" style={{ minWidth: 260 }}>Open support queue</LinkButton></div>
        </Panel>
      </Halves>
      <Small>{data.sources}</Small>
      {demo && <Small>Demo · every figure is an illustrative aggregate, not a measured Farda result.</Small>}
    </>
  );
}
