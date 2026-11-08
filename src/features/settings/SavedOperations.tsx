import { useEffect, useState } from "react";
import { scopeKey, useScope } from "@/adapter/scope";
import { useSearchParams } from "react-router-dom";
import type { SavedBinding, SavedBindings, SavedRuns } from "@/creator-agent/operationsView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { DetailRows, Panel, Row, Small, Split, kit } from "@/components/PageKit";
import { Kpi } from "@/components/Kpi";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { SearchField } from "@/components/Search";

const stamp = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" }) : "Unknown";
const counts = (coverage: SavedBindings["coverage"], noun: string) =>
  `Showing ${coverage.returned} of ${coverage.total} saved ${noun}.${coverage.partial ? " The remaining records are outside this read limit." : ""}`;
const tone = (state: SavedBinding["state"]) => state === "Ready" ? "success" : state === "Blocked" || state === "Expired" ? "warning" : "neutral";

function useSelection(key: string) {
  const [params, setParams] = useSearchParams();
  const ctx = useScope();
  const context = JSON.stringify([scopeKey(ctx), params.get("tab"), params.get("savedSearch"), params.get("savedState")]);
  // A selection carried across a tab, search, state or scope change is withheld until the URL drops it.
  const [previous, setPrevious] = useState(context);
  const [carried, setCarried] = useState(false);
  if (previous !== context) { setPrevious(context); setCarried(params.has(key)); }
  else if (carried && !params.has(key)) setCarried(false);
  useEffect(() => {
    if (carried) setParams(p => { const next = new URLSearchParams(p); next.delete(key); return next; }, {replace:true});
  }, [carried, key, setParams]);
  return { id: carried || previous !== context ? null : params.get(key), select: (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set(key, id); else next.delete(key);
    setParams(next, { replace: id === null });
  } };
}

export function SavedBindingPanel({ data, page, tab }: { data: SavedBindings; page: "connections" | "capabilities"; tab?: string }) {
  const selection = useSelection(page === "connections" ? "connection" : "inspect");
  const selected = data.records.find(row => row.id === selection.id);
  const rows = tab === "exceptions" ? data.records.filter(row => row.state !== "Ready") : data.records;
  const title = page === "connections" ? "Source systems" : tab === "access" ? "Access evidence" : tab === "exceptions" ? "Capability exceptions" : "Account capabilities";
  if (tab === "attribution") return <Panel title="Attribution tests" headingId="saved-attribution"><p>Attribution test results are unavailable from the capability ledger.</p></Panel>;
  const table = <Panel title={title} headingId="saved-bindings-title" testId="saved-bindings" note={counts(data.coverage, "bindings")}>
        {rows.length ? <DataTable variant="ledger" caption="Saved account and action bindings" columns={[{ label: "Provider / action" }, { label: "Account / route" }, { label: "Permission" }, { label: "Evidence" }]} rows={rows.map(row => [
          <span key="who">{row.provider}<br />{row.action}</span>, <span key="where">{row.account}<br />{row.route} · {row.mode}</span>,
          <Badge key="state" tone={tone(row.state)}>{row.state}</Badge>, <Button key="inspect" variant="secondary" aria-haspopup="dialog" onClick={() => selection.select(row.id)}>Inspect binding</Button>,
        ])} /> : <p>{data.coverage.total === 0 ? "No bindings are saved in this workspace and account. Provider coverage is unknown." : "No exceptions in the displayed bindings."}</p>}
      </Panel>;
  const freshness = <Panel title="Source freshness" headingId="saved-freshness">
        <DetailRows rows={[["Ledger read", stamp(data.observedAt)], ["Provider coverage", "Unknown"]]} />
        <Small>Each binding shows the state observed when its page was read. Refresh to recheck loaded permissions.</Small>
        <LinkButton variant="secondary" to={page === "connections" ? "/settings/capabilities" : "/settings/connections"}>{page === "connections" ? "Inspect available actions" : "View connections"}</LinkButton>
      </Panel>;
  return <>
    {page === "connections" ? <Split>{table}{freshness}</Split> : <>{table}{freshness}</>}
    <Dialog open={Boolean(selected)} title="Binding evidence" onClose={() => selection.select(null)}>
      <Button variant="secondary" style={{ position: "sticky", top: 0, zIndex: 1 }} onClick={() => selection.select(null)}>Close</Button>
      {selected && <><DetailRows rows={[
        ["Provider / action", selected.provider + " · " + selected.action], ["Account", selected.account], ["Route / mode", selected.route + " · " + selected.mode],
        ["Permission at read time", selected.state], ["Binding revision", String(selected.revision)], ["Owner", selected.owner], ["Permission checked", stamp(selected.checkedAt)],
        ["Permission expires", stamp(selected.expiresAt)], ["Permission receipt", selected.receipt ?? "Missing"], ["Source observation", stamp(selected.observedAt)],
        ["Source health state", selected.sourceHealth?.state ?? "Unknown"], ["Source health checked", stamp(selected.sourceHealth?.checkedAt ?? null)],
        ["Source permission / session", [selected.sourceHealth?.permission ?? "unknown", selected.sourceHealth?.session ?? "unknown"].join(" / ")],
        ["Observation coverage", selected.sourceHealth?.coverage ?? "Unknown"], ["Mirror updated", stamp(selected.sourceHealth?.mirrorUpdatedAt ?? null)],
        ["Last successful source read", stamp(selected.lastSuccessAt)], ["Source updated", stamp(selected.sourceUpdatedAt)], ["Source freshness", selected.freshness],
        ["Reasons", selected.blockers.join(", ") || "None recorded"],
      ]} /><Small>Setup and permission changes require authorization in the owning system.</Small></>}
    </Dialog>
  </>;
}

export function SavedRunFilters({data}:{data:SavedRuns|null}) {
  const [params, updateParams] = useSearchParams();
  const query = params.get("savedSearch") ?? "", state = params.get("savedState") ?? "all";
  const filters = (q: string, st: string) => updateParams(p => {
    const next = new URLSearchParams(p); next.delete("run");
    if (q) next.set("savedSearch",q.slice(0,120)); else next.delete("savedSearch");
    if (st !== "all") next.set("savedState",st); else next.delete("savedState");
    return next;
  },{replace:true});
  return     <Row>
      <SearchField id="saved-run-search" value={query} label="Search saved runs" placeholder="Run, job, correlation or state" onChange={v => filters(v,state)} />
      <FilterButton name="State" title="Choose a run state" value={state} onChange={v => filters(query,v)} options={[{ value: "all", label: "All states" },
        ...Array.from(new Set((data?.records ?? []).map(row => row.state).concat(state !== "all" ? [state] : []))).sort().map(value => ({ value, label: value }))]} />
      <Button variant="ghost" onClick={() => filters("","all")}>Clear filters</Button>
    </Row>;
}

export function SavedRunsPanel({ data, tab }: { data: SavedRuns; tab: "runs" | "zaps" | "reporting" }) {
  const [params] = useSearchParams();
  const query = params.get("savedSearch") ?? "", state = params.get("savedState") ?? "all";
  const selection = useSelection("run");
  const selected = data.records.find(row => row.id === selection.id);
  if (tab === "reporting") return <Panel title="Reporting schedules" headingId="saved-reports"><p>Report destinations and delivery schedules are unavailable from this job registry.</p></Panel>;
  if (tab === "zaps") return <Panel title="Registered jobs" headingId="saved-jobs" note={counts(data.jobCoverage, "jobs")}>
    <Small>The registration state is local. Provider schedules and next run times are unknown.</Small>
    {data.jobs.length ? <DataTable variant="ledger" caption="Saved job definitions" columns={[{ label: "Job" }, { label: "Version" }, { label: "Mode" }, { label: "Local state" }]} rows={data.jobs.map(job =>
      [job.scheduleRef ? <LinkButton key={job.id} variant="ghost" to={`/automations/${encodeURIComponent(job.scheduleRef)}/schedule`}>{job.id} schedule draft</LinkButton> : job.id, job.version, job.mode, job.paused ? "Paused" : job.enabled ? "Enabled locally" : "Disabled"])} /> : <p>No jobs are registered in this workspace and account.</p>}
  </Panel>;
  const visible = data.records.filter(row => (state === "all" || state === row.state) && [row.id, row.job, row.correlation, row.state].some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  return <>
    <div className={kit.kpis}>
      <Kpi label="Saved runs" context="Scoped run ledger">{data.coverage.total}</Kpi>
      <Kpi label="Registered jobs" context="Scoped job registry">{data.jobCoverage.total}</Kpi>
      <Kpi label="Displayed runs" context={data.coverage.partial ? "Partial coverage" : "Complete local read"}>{data.coverage.returned}</Kpi>
      <Kpi label="Provider run volume" context="Separate source required">Unknown</Kpi>
    </div>

    <Panel title="Automation runs" headingId="saved-runs-title" testId="saved-runs" note={counts(data.coverage, "runs")}>
    {visible.length ? <DataTable variant="dense" caption="Saved run traces" columns={[{ label: "Run / job" }, { label: "State" }, { label: "Observed" }, { label: "Next action" }]} rows={visible.map(run =>
      [<span key="run">{run.id}<br />{run.job} · v{run.version}</span>, run.state, stamp(run.observedAt), <Button key="detail" variant="secondary" aria-haspopup="dialog" onClick={() => selection.select(run.id)}>Inspect run</Button>])} />
      : <p>{data.coverage.total ? "No displayed runs match this search." : "No runs are saved in this workspace and account. Provider run volume is unknown."}</p>}
    <Small>Ledger read {stamp(data.observedAt)}. Result receipts identify saved artifacts and recorded source outcomes.</Small>
    <Dialog open={Boolean(selected)} title="Saved run trace" onClose={() => selection.select(null)}>
      <Button variant="secondary" style={{ position: "sticky", top: 0, zIndex: 1 }} onClick={() => selection.select(null)}>Close</Button>
      {selected && <DetailRows rows={[["Run", selected.id], ["Job / version", selected.job + " · v" + selected.version], ["Correlation", selected.correlation],
        ["Mode / state", selected.mode + " · " + selected.state], ["Observed", stamp(selected.observedAt)], ["Completed items", selected.completed + " of " + selected.items],
        ["Blockers", selected.blockers.join(", ") || "None recorded"], ["Recorded result receipts", String(selected.receiptCount)], ["First recorded receipt", selected.receipt ?? "None recorded"]]} />}
    </Dialog>
  </Panel></>;
}
