import { useView } from "@/adapter/useView";
import { operationsControlFreshnessMs, type OperationsControlFilters, type NativeOperationsControl } from "@/creator-agent/operationsControlsSchema";
import { useSourceLease } from "@/adapter/useSourceLease";
import { Button, LinkButton } from "@/components/Button";
import { SourceReadGrant } from "@/components/SourceReadGrant";
import { ReadState } from "@/components/ReadState";
import { ViewError } from "@/components/ViewError";
import { DataTable } from "@/components/DataTable";

/** The existing controls service owns report configuration and execution. */
export function NativeReportSchedule() {
  const query = useView<OperationsControlFilters, NativeOperationsControl>("operationsControl", { section: "reports" });
  const data = query.data?.data;
  const freshnessExpired = useSourceLease(data?.sourceObservedAt ? new Date(Date.parse(data.sourceObservedAt) + operationsControlFreshnessMs + 1).toISOString() : null);
  const sourceState = freshnessExpired && data?.sourceState === "current" ? "stale" : data?.sourceState;
  return <section aria-labelledby="launch-report-schedule">
    <h3 id="launch-report-schedule">Report scheduling</h3>
    <p>Configuration and report delivery are separate. Viewing a schedule never enables recurring execution.</p>
    {query.isPending && <p role="status">Loading report schedule evidence…</p>}
    {query.isError && <ViewError error={query.error} subject="Report scheduling" hasPriorData={false} onRetry={() => void query.refetch()} />}
    <ReadState res={query.data} subject="Report scheduling" only={["partial", "stale"]} />
    {data && !query.isError && <SourceReadGrant validUntil={data.readAccess?.validUntil ?? data.namedActor?.validUntil} title="Report scheduling" refresh={() => void query.refetch()}>
      <p>Source {sourceState} · observed {data.sourceObservedAt ?? "N/A"}</p>
      {freshnessExpired && <p role="status">Report evidence is stale. Refresh before relying on configuration or next-run times.</p>}
      {!data.records.length ? <p>Schedule, timezone, owner and next run N/A: no report configuration supplied by the source.</p> : data.records.map(record => <DataTable key={record.id} caption={record.title} minWidth={440} columns={[{ label: "Report setting" }, { label: "Source evidence" }]} rows={record.details.map(([name, value]) => [name, value])} />)}
      <Button variant="ghost" onClick={() => void query.refetch()}>Refresh report evidence</Button>
    </SourceReadGrant>}
    <LinkButton variant="secondary" to="/automations?tab=reporting">Manage reports with the source owner</LinkButton>
  </section>;
}
