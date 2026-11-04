import { useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AdapterError } from "@/adapter/errors";
import { useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import type { TaskRequest } from "@/adapter/demoSettings";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { SelectField, TextField } from "@/components/Field";
import { Kpi } from "@/components/Kpi";
import { DetailRows, Halves, Notice, Page, PageHeader, Panel, Row, kit } from "@/components/PageKit";
import { SearchField } from "@/components/Search";
import { ViewError } from "@/components/ViewError";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { RUN_PLATFORMS, RUN_STATES, type AutomationData, type AutomationRun } from "@/fixtures/settings";
import { ReconciliationPage } from "./ReconciliationPage";
import { AutomationNav, CadenceNotice } from "./shared";

type Tab = "runs" | "zaps" | "reporting";
const TABS: Tab[] = ["runs", "zaps", "reporting"];
const allowed = (options: readonly { value: string }[], raw: string | null) => (options.some((o) => o.value === raw) ? (raw as string) : "all");

/** Automation runs, with the Zaps and Reporting subviews (Figma source 14:637, owner THO-305). Read work; Request task only proposes, and never dispatches. */
export function AutomationsPage() {
  const [search] = useSearchParams();
  return search.get("tab") === "reconciliation" ? <ReconciliationPage /> : <RunsPage />;
}

function RunsPage() {
  const { adapter } = useScope();
  const [search] = useSearchParams();
  const tab: Tab = (TABS as string[]).includes(search.get("tab") ?? "") ? (search.get("tab") as Tab) : "runs";
  const query = useView<Record<string, never>, AutomationData>("automationRuns", {});
  const [taskOpen, setTaskOpen] = useState(false);
  const demo = adapter.kind === "demo";
  const data = query.data?.data ?? null;
  const taskBlocked = query.data ? blockedReason(query.data, "requestTask") : "Available once runs have loaded.";

  return (
    <Page labelledBy="automations-title" source="14:637">
      <PageHeader id="automations-title" title="Every action, accounted for." subtitle="Runs · Zapier orchestration and browser execution share one traceable handoff.">
        <LinkButton variant="secondary" to="/automations?tab=zaps" style={{ minWidth: 176 }}>View Zapier</LinkButton>
        <Button aria-haspopup="dialog" style={{ minWidth: 176 }} disabledReason={taskBlocked} onClick={() => setTaskOpen(true)}>Request task</Button>
      </PageHeader>
      <AutomationNav current={tab} width={152} />
      <CadenceNotice title="Daily sourcing and hourly monitoring" funnel>
        Daily runs discover permitted lifestyle prospects, collect direct evidence and propose finite invitations. Hourly runs monitor enrolled content and inbox activity. Both keep source permissions, current policy and exact approvals.
      </CadenceNotice>
      <Notice kind="plain" title={demo ? "Demo · execution access is not validated" : "Execution access is not validated"}>
        Run states below are examples. A human approves the exact outbound action; the browser works inside its source platform and saves the result.
      </Notice>
      <ReadState res={query.data} subject="Automation runs" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading runs…" />}
      {query.isError && <ViewError error={query.error} subject="Automation runs" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (data ? <Body data={data} tab={tab} /> : <EmptyState state="Empty" title="No automation runs yet"><p>The source responded, but no run has ever been recorded.</p></EmptyState>)}
      {data && <TaskDialog open={taskOpen} data={data} demo={demo} onClose={() => setTaskOpen(false)} />}
    </Page>
  );
}

function Body({ data, tab }: { data: AutomationData; tab: Tab }) {
  if (tab === "zaps") return <Zaps data={data} />;
  if (tab === "reporting") return <Reports data={data} />;
  return <Runs data={data} />;
}

function Runs({ data }: { data: AutomationData }) {
  const [search, setSearch] = useSearchParams();
  const platform = allowed(RUN_PLATFORMS, search.get("platform"));
  const state = allowed(RUN_STATES, search.get("state"));
  const mine = search.get("mine") === "1";
  const q = search.get("q") ?? "";
  const [dialog, setDialog] = useState<{ kind: string; run: AutomationRun } | null>(null);
  const searchId = useId();

  const update = (changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    }
    setSearch(next, { replace });
  };
  const rows = useMemo(
    () => data.runs.filter((r) => (platform === "all" || r.platform === platform) && (state === "all" || r.state === state) && (!mine || r.assignedToMe) && (!q.trim() || `${r.id} ${r.name}`.toLowerCase().includes(q.trim().toLowerCase()))),
    [data.runs, platform, state, mine, q],
  );
  const filtered = platform !== "all" || state !== "all" || mine || q !== "";

  return (
    <>
      <div className={kit.kpis}>
        {data.kpis.map((k) => <Kpi key={k.label} label={k.label} context={k.context} testId={`metric-${k.label}`}>{k.value}</Kpi>)}
      </div>

      <Row>
        <SearchField id={searchId} label="Search run or collaboration" placeholder="Search run or collaboration" value={q} onChange={(v) => update({ q: v }, true)} />
        <FilterButton name="Platform" title="Choose a platform" options={[...RUN_PLATFORMS]} value={platform} onChange={(v) => update({ platform: v })} width={176} bare />
        <FilterButton name="State" title="Choose a run state" options={[...RUN_STATES]} value={state} onChange={(v) => update({ state: v })} width={152} bare />
        <Button variant="secondary" aria-pressed={mine} style={{ minWidth: 184 }} onClick={() => update({ mine: mine ? null : "1" })}>Assigned to me</Button>
        <Button variant="ghost" style={{ minWidth: 160 }} onClick={() => update({ platform: null, state: null, mine: null, q: null })}>Clear filters</Button>
      </Row>

      <Panel headingGap={6} title="Prioritize the next safe action" note="Status is determined by evidence from the source." headingId="runs-title" testId="run-list">
        <p role="status" className={filtered ? kit.small : "visually-hidden"} data-testid="run-count">Showing {rows.length} of {data.runs.length} example runs{filtered ? " for the current filters" : ""}.</p>
        {data.runs.length === 0 ? (
          <EmptyState state="Empty" title="No runs have ever been recorded" />
        ) : rows.length === 0 ? (
          <EmptyState state="Empty" title="No runs match these filters"><p>Nothing in the {data.runs.length} example runs matches. Clear the filters to see them all.</p></EmptyState>
        ) : (
          <DataTable
            variant="dense"
            caption="Automation runs"
            columns={[{ label: "Run / workflow", width: "28.846%" }, { label: "Executor", width: "18.109%" }, { label: "State", width: "17.788%" }, { label: "Updated", width: "17.147%" }, { label: "Next action" }]}
            rows={rows.map((r) => [
              r.name,
              r.executor,
              <Badge key="s" tone={r.chip.tone} width={190}>{r.chip.label}</Badge>,
              r.updated,
              r.next.to ? (
                <LinkButton key="n" variant={r.next.variant} to={r.next.to} style={{ minWidth: 186 }}>{r.next.label}</LinkButton>
              ) : (
                <Button key="n" variant={r.next.variant} aria-haspopup="dialog" style={{ minWidth: 186 }} onClick={() => setDialog({ kind: r.next.dialog ?? "trace", run: r })}>{r.next.label}</Button>
              ),
            ])}
            minWidth={860}
          />
        )}
      </Panel>

      <Halves>
        <Panel headingGap={6} title="One request, one approved revision" note="The operator can inspect these fields before any action." headingId="contract-title">
          <DetailRows rows={data.contract} wide />
          <div><LinkButton variant="secondary" to="/runs/demo-run-approval?tab=approval" style={{ minWidth: 210 }}>Open run detail</LinkButton></div>
        </Panel>
        <Panel headingGap={6} title="Paused is a useful state" note="Keep the next step visible without guessing the outcome." headingId="recovery-title">
          <DataTable variant="dense" caption="Paused states and the next step" columns={[{ label: "State", width: "37.755%" }, { label: "Next step" }]} rows={data.recovery.map((r) => [r.state, r.next])} minWidth={0} />
          <div><LinkButton variant="secondary" to="/runs/demo-run-uncertain?tab=recovery" style={{ minWidth: 238 }}>Open recovery detail</LinkButton></div>
        </Panel>
      </Halves>

      <Dialog open={dialog?.kind === "takeover"} title={dialog ? `Take over ${dialog.run.id}` : ""} badge="Demo" onClose={() => setDialog(null)}>
        <p>This run is paused at a source sign-in. A person completes that sign-in in the source tool, so no session or password is ever entered or stored here.</p>
        <p>Taking over needs a server-confirmed assignment for this task. The demo has none, so nothing is taken over and the run's state doesn't change.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "trace"} title={dialog ? `${dialog.run.id} trace` : ""} badge="Demo" onClose={() => setDialog(null)}>
        <p>This is an example row. The demo records no trace, receipt or history for it, so none is shown.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
    </>
  );
}

function Zaps({ data }: { data: AutomationData }) {
  return (
    <Panel headingGap={6} title="Zaps and their schedules" note="Selecting this tab runs nothing. Provider references are not verified in the demo." headingId="zaps-title" testId="zap-list">
      <DataTable
        variant="dense"
        caption="Zaps and their schedules"
        columns={[{ label: "Zap" }, { label: "Trigger" }, { label: "State" }, { label: "Provider reference" }, { label: "Schedule" }]}
        rows={data.zaps.map((z) => [
          z.name,
          z.trigger,
          <Badge key="s" tone={z.state.tone} width={128}>{z.state.label}</Badge>,
          z.provider,
          z.scheduleTo ? <LinkButton key="l" variant="ghost" to={z.scheduleTo}>View schedule</LinkButton> : "No schedule",
        ])}
        minWidth={760}
      />
    </Panel>
  );
}

function Reports({ data }: { data: AutomationData }) {
  return (
    <Panel headingGap={6} title="Reporting schedules" note="Each report is configured separately, and none is live without verified access." headingId="reports-title" testId="report-list">
      <DataTable variant="ledger" caption="Reporting schedules" columns={[{ label: "Report" }, { label: "Timing" }, { label: "Enablement / exit" }]} rows={data.reports.map((r) => [r.name, r.timing, r.enablement])} minWidth={720} />
      <div><LinkButton variant="secondary" to="/automations/zap-12/schedule" style={{ minWidth: 248 }}>Open the daily digest schedule</LinkButton></div>
    </Panel>
  );
}

/**
 * Request task (CTRL-006). Collects a permission-filtered draft, previews the finite plan and creates an approval request.
 * It never dispatches, and a job type can only be one of the registered ones.
 */
function TaskDialog({ open, data, demo, onClose }: { open: boolean; data: AutomationData; demo: boolean; onClose: () => void }) {
  const [jobType, setJobType] = useState("");
  const [account, setAccount] = useState("");
  const [scope, setScope] = useState("");
  const [reason, setReason] = useState("");
  const submit = useAction<TaskRequest>();
  const job = data.jobTypes.find((j) => j.value === jobType);
  const errors = submit.error instanceof AdapterError ? submit.error.body.fieldErrors ?? {} : {};
  const done = submit.data;

  const send = () =>
    submit.mutate({ operation: "requestApproval", actionKind: "requestTask", entityRefs: [], expectedVersion: "v1", approvalRef: null, manifestRef: null, payload: { jobType, account, scope, reason } });

  return (
    <Dialog open={open} title="Request a task" badge={demo ? "Demo" : undefined} onClose={onClose}>
      <p>This creates an approval request. Nothing runs until an authorized person approves the exact plan.</p>
      <SelectField label="Job type" value={jobType} onChange={setJobType} error={errors.jobType ?? null} options={[{ value: "", label: "Choose a job type" }, ...data.jobTypes.map((j) => ({ value: j.value, label: j.label }))]} />
      <SelectField label="Account" value={account} onChange={setAccount} error={errors.account ?? null} options={[{ value: "", label: "Choose an account" }, ...data.accounts]} />
      <TextField label="Entity or scope" value={scope} onChange={setScope} error={errors.scope ?? null} helpText="The creator, batch or collaboration this task covers." />
      <TextField label="Reason" multiline value={reason} onChange={setReason} error={errors.reason ?? null} helpText="At least 10 characters." />
      {job && (
        <div>
          <p className={kit.contextTitle}>Plan preview · finite</p>
          <ol className={kit.small} style={{ margin: "var(--space-8) 0 0", paddingLeft: "var(--space-20)" }}>{job.plan.map((p) => <li key={p}>{p}</li>)}</ol>
        </div>
      )}
      {submit.error && !Object.keys(errors).length && <ActionError error={submit.error} />}
      {done && (
        <p role="status" className={kit.status} data-testid="task-status">
          Approval request {done.actionRef} created{demo ? " (demo)" : ""}. It is waiting for a decision, and nothing was dispatched.
        </p>
      )}
      <Button loading={submit.isPending} disabledReason={done ? "Already requested. Close this and start a new request for another task." : null} onClick={send}>Create approval request</Button>
      <Button variant="secondary" onClick={() => { submit.reset(); onClose(); }}>{done ? "Close" : "Cancel"}</Button>
    </Dialog>
  );
}
