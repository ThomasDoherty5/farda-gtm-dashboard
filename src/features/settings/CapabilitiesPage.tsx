import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import type { PermissionEvidence, PermissionRecord } from "@/adapter/demoSettings";
import { useScope } from "@/adapter/scope";
import { useSave } from "@/adapter/useSave";
import type { SavedBindings } from "@/creator-agent/operationsView";
import { SavedBindingPanel } from "./SavedOperations";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { SelectField, TextField } from "@/components/Field";
import { Kpi } from "@/components/Kpi";
import { Gates, Notice, Page, PageHeader, Panel, Small, kit } from "@/components/PageKit";
import { SectionTabs } from "@/components/SectionTabs";
import { ViewError } from "@/components/ViewError";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { CAPABILITY_TABS, type CapabilityData, type CapabilityRow, type CapabilityTab } from "@/fixtures/settings";
import { CadenceNotice } from "./shared";

const TAB_LABEL: Record<CapabilityTab, string> = { capabilities: "Capabilities", access: "Access evidence", attribution: "Attribution tests", exceptions: "Exceptions" };
const TAB_WIDTH: Record<CapabilityTab, number> = { capabilities: 116, access: 137, attribution: 151, exceptions: 102 };
const STATE_TONE = { unverified: "neutral", unsupported: "neutral", denied: "warning", unknown: "neutral" } as const;
const STATE_LABEL = { unverified: "Unverified", unsupported: "Unsupported", denied: "Denied", unknown: "Unknown" } as const;

/** Channel capabilities (Figma source 66:641, owner THO-305). Capability, permission and live access are separate checks; nothing here grants or runs anything. */
export function CapabilitiesPage() {
  const { adapter } = useScope();
  const [search] = useSearchParams();
  const tab = (CAPABILITY_TABS as readonly string[]).includes(search.get("tab") ?? "") ? (search.get("tab") as CapabilityTab) : "capabilities";
  const query = useView<Record<string, never>, CapabilityData | SavedBindings>("channelCapabilities", {});
  const [planOpen, setPlanOpen] = useState(false);
  const demo = adapter.kind === "demo";
  const data = query.data?.data ?? null;

  return (
    <Page labelledBy="capabilities-title" source="66:641">
      <PageHeader id="capabilities-title" title="Ready means verified." subtitle="Provider capability, permission and live account access are three separate checks">
        <LinkButton variant="secondary" to="/settings/capabilities?tab=access" style={{ minWidth: 198 }}>Review evidence</LinkButton>
        <Button aria-haspopup="dialog" style={{ minWidth: 200 }} disabledReason={!demo ? "The saved ledger is read-only." : data ? null : "Available once capabilities have loaded."} onClick={() => setPlanOpen(true)}>Plan validation</Button>
      </PageHeader>
      <SectionTabs label="Capability sections" tabs={CAPABILITY_TABS.map((t) => ({ label: TAB_LABEL[t], to: t === "capabilities" ? "/settings/capabilities" : `/settings/capabilities?tab=${t}`, width: TAB_WIDTH[t], current: t === tab }))} />
      <CadenceNotice title="Validate the route for each action">
        Daily discovery and direct lifestyle review require permitted access; hourly monitoring checks enrolled creators separately. Unsupported API capability does not grant browser permission.
      </CadenceNotice>
      <Notice title={demo ? "No integration is connected in this demo" : "Account-specific permission evidence"}>
        Documented support is not account readiness. A browser route is an execution option after capability and provider authorization are verified; it is never a permission bypass.
      </Notice>
      <ReadState res={query.data} subject="Channel capabilities" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading capabilities…" />}
      {query.isError && <ViewError error={query.error} subject="Channel capabilities" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (data && "kind" in data ? <SavedBindingPanel data={data} page="capabilities" tab={tab} /> : data && demo ? <Body res={query.data as ReadResponse<CapabilityData>} data={data} tab={tab} demo={demo} planOpen={planOpen} closePlan={() => setPlanOpen(false)} /> : <EmptyState state="Empty" title="No capabilities listed"><p>No account-scoped capability data is available.</p></EmptyState>)}
    </Page>
  );
}

type BodyProps = { res: ReadResponse<CapabilityData>; data: CapabilityData; tab: CapabilityTab; demo: boolean; planOpen: boolean; closePlan: () => void };

function Body({ res, data, tab, demo, planOpen, closePlan }: BodyProps) {
  const [search, setSearch] = useSearchParams();
  const [dialog, setDialog] = useState<{ kind: "record" | "plan"; row: CapabilityRow } | null>(null);
  const inspect = data.rows.find((r) => r.id === search.get("inspect")) ?? null;
  const setInspect = (id: string | null) => {
    const next = new URLSearchParams(search);
    if (id) next.set("inspect", id);
    else next.delete("inspect");
    setSearch(next, { replace: id === null });
  };

  return (
    <>
      {tab === "capabilities" && (
        <>
          <Panel title="Use the right owner for each action." note="Published workflows guide setup; native observations and evidence unlock the live route." headingId="matrix-title" large roomy testId="capability-matrix">
            <DataTable
              caption="Channel execution capability matrix"
              columns={[{ label: "Surface / action", width: "24.84%" }, { label: "Preferred route", width: "22.276%" }, { label: "Current evidence", width: "30.288%" }, { label: "Fallback / next step" }]}
              rows={data.rows.map((r) => [
                r.surface,
                r.route,
                <span key="e" data-state-kind={r.kind}>
                  {r.evidence}
                  {data.recorded[r.id] && <><br /><span className={kit.small}>Evidence recorded as version {data.recorded[r.id]!.version.replace("v", "")} · not provider authority</span></>}
                </span>,
                <RowAction key="a" row={r} onRecord={() => setDialog({ kind: "record", row: r })} onPlan={() => setDialog({ kind: "plan", row: r })} onInspect={() => setInspect(r.id)} />,
              ])}
              minWidth={900}
            />
            <Small>{data.rowsNote}</Small>
          </Panel>
          <Panel title="Prove the route before scaling it." note="Before inviting, validate a feasible authorized route. Test issued links before commerce activation; creator payout setup is required before payout." headingId="tests-title" large testId="route-tests">
            <Gates gates={data.tests.map((t) => ({ chip: t.chip, tone: "neutral" as const, title: t.title, note: t.note }))} />
          </Panel>
          <Panel title="Capacity is more than one number." note="Each account/action shares API and browser limits. Refresh source capacity before every write." headingId="capacity-title" large testId="capacity">
            <div className={kit.kpis}>
              {data.capacity.map((c) => <Kpi key={c.label} label={c.label} context={c.context} testId={`metric-${c.label}`}>{c.value}</Kpi>)}
            </div>
            <Small>{data.capacityNote}</Small>
          </Panel>
        </>
      )}
      {tab === "access" && <AccessEvidence data={data} />}
      {tab === "attribution" && (
        <Panel title="Attribution tests" note="Versioned source-backed tests. Expected and observed results stay separate, and a test that has not run has no result." headingId="attribution-title" testId="attribution-tests">
          <DataTable caption="Attribution tests" columns={[{ label: "Test" }, { label: "Expected result" }, { label: "Observed" }, { label: "State" }]} rows={data.tests.map((t) => [t.title, t.expected, "Unknown · not run", <Badge key="s">{t.chip}</Badge>])} minWidth={720} />
        </Panel>
      )}
      {tab === "exceptions" && (
        <Panel title="Provider exceptions" note="Current exceptions keep their original record IDs and recovery reasons." headingId="exceptions-title" testId="exceptions">
          {data.exceptions.length === 0 ? (
            <EmptyState state="Empty" title="No provider exceptions recorded"><p>Nothing has been recorded. That is not a finding that every provider is working: sources are unverified.</p></EmptyState>
          ) : (
            <DataTable caption="Provider exceptions" columns={[{ label: "Record" }, { label: "Reason" }]} rows={data.exceptions.map((e) => [e.record, e.reason])} minWidth={0} />
          )}
        </Panel>
      )}
      {demo && <Small>{data.footnote}</Small>}

      <PlanDialog open={planOpen} rows={data.rows.filter((r) => r.action.plan.length)} demo={demo} onClose={closePlan} />
      <PlanDialog open={dialog?.kind === "plan"} rows={dialog ? [dialog.row] : []} demo={demo} onClose={() => setDialog(null)} />
      <RecordDialog open={dialog?.kind === "record"} row={dialog?.row ?? null} rows={data.rows} res={res} data={data} demo={demo} onClose={() => setDialog(null)} />
      <Dialog open={inspect !== null} title={inspect ? `Available actions · ${inspect.surface}` : ""} badge={demo ? "Demo" : undefined} onClose={() => setInspect(null)}>
        {inspect && (
          <>
            <p>Each action is shown with what is verified. Inspecting an action never runs it.</p>
            <DataTable caption="Available actions" columns={[{ label: "Action" }, { label: "State" }, { label: "Evidence" }]} rows={inspect.capabilities.map((c) => [c.action, <Badge key="s" tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge>, c.note])} minWidth={0} />
          </>
        )}
        <Button variant="secondary" onClick={() => setInspect(null)}>Close</Button>
      </Dialog>
    </>
  );
}

function RowAction({ row, onRecord, onPlan, onInspect }: { row: CapabilityRow; onRecord: () => void; onPlan: () => void; onInspect: () => void }) {
  const style = { minWidth: 246 };
  switch (row.action.type) {
    case "commitment":
      return <LinkButton variant="secondary" to="/offers/demo-offerId" style={style}>{row.action.label}</LinkButton>;
    case "record":
      return <Button variant="secondary" aria-haspopup="dialog" style={style} onClick={onRecord}>{row.action.label}</Button>;
    case "inspect":
      return <Button variant="secondary" aria-haspopup="dialog" style={style} onClick={onInspect}>{row.action.label}</Button>;
    default:
      return <Button variant="secondary" aria-haspopup="dialog" style={style} onClick={onPlan}>{row.action.label}</Button>;
  }
}

function AccessEvidence({ data }: { data: CapabilityData }) {
  const recorded = Object.entries(data.recorded);
  return (
    <Panel title="Access evidence" note="Verified access by source, account and action, with freshness. Unknown stays unknown." headingId="access-title" testId="access-evidence">
      <DataTable caption="Access evidence" columns={[{ label: "Source" }, { label: "Action" }, { label: "State" }, { label: "Last observed" }]} rows={data.accessEvidence.map((a) => [a.source, a.action, a.state, a.observed])} minWidth={640} />
      {recorded.length > 0 && (
        <DataTable
          caption="Evidence recorded this session"
          columns={[{ label: "Recorded for" }, { label: "Reviewer" }, { label: "Observed on" }, { label: "Version" }]}
          rows={recorded.map(([id, r]) => [data.rows.find((x) => x.id === id)?.surface ?? id, r.reviewer, r.observedOn, r.version])}
          minWidth={560}
        />
      )}
      <Small>Recorded evidence supports a review. It is never the provider's permission, and it can't grant or bypass it.</Small>
    </Panel>
  );
}

/** A validation plan: the checks a person would run. Nothing here runs a check or calls a provider. */
function PlanDialog({ open, rows, demo, onClose }: { open: boolean; rows: CapabilityRow[]; demo: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} title={rows.length === 1 ? `Plan · ${rows[0]!.action.label}` : "Validation plan"} badge={demo ? "Demo" : undefined} onClose={onClose}>
      <p>These are the checks to run, in order. Nothing is run from here, and validating needs an authorized account and owner.</p>
      {rows.map((r) => (
        <div key={r.id} className={kit.stack} style={{ width: "100%" }}>
          <p className={kit.contextTitle} style={{ margin: 0 }}>{r.surface}</p>
          <ol className={kit.small} style={{ margin: 0, paddingLeft: "var(--space-20)" }}>{r.action.plan.map((p) => <li key={p}>{p}</li>)}</ol>
        </div>
      ))}
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Dialog>
  );
}

/** Record permission (CTRL-134): saves evidence with its reviewer, date and version. It cannot grant or bypass actual provider authority. */
function RecordDialog({ open, row, rows, res, data, demo, onClose }: { open: boolean; row: CapabilityRow | null; rows: CapabilityRow[]; res: ReadResponse<CapabilityData>; data: CapabilityData; demo: boolean; onClose: () => void }) {
  const [rowId, setRowId] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [evidence, setEvidence] = useState("");
  const [observedOn, setObservedOn] = useState("");
  const save = useSave<PermissionEvidence, PermissionRecord>();
  const id = rowId || row?.id || "";
  const errors = save.error instanceof AdapterError ? save.error.body.fieldErrors ?? {} : {};
  const blocked = blockedReason(res, "recordPermissionEvidence");
  const saved = save.data;

  const onSave = () => save.mutate({ resourceKind: "evidenceDraft", resourceRef: `permission-${id}`, expectedVersion: data.recorded[id]?.version ?? null, payload: { rowId: id, reviewer, evidence, observedOn } });

  return (
    <Dialog open={open} title="Record permission evidence" badge={demo ? "Demo" : undefined} onClose={onClose}>
      <p>Record what a reviewer actually saw. This is evidence for the review, not a grant: the provider still decides what is allowed.</p>
      <SelectField label="Source and action" value={id} onChange={setRowId} error={errors.rowId ?? null} options={rows.map((r) => ({ value: r.id, label: r.surface }))} />
      <TextField label="Reviewer" value={reviewer} onChange={setReviewer} error={errors.reviewer ?? null} />
      <TextField label="Evidence" multiline value={evidence} onChange={setEvidence} error={errors.evidence ?? null} helpText="What was observed, and where. At least 10 characters." />
      <TextField label="Observed on" value={observedOn} onChange={setObservedOn} error={errors.observedOn ?? null} placeholder="YYYY-MM-DD" />
      {save.error && !Object.keys(errors).length && <ActionError error={save.error} />}
      {saved && <p role="status" className={kit.status} data-testid="record-status">Evidence saved as version {saved.resourceVersion.replace("v", "")}{demo ? " (demo)" : ""}. It does not grant access.</p>}
      <Button loading={save.isPending} disabledReason={blocked} onClick={onSave}>Save evidence</Button>
      <Button variant="secondary" onClick={() => { save.reset(); onClose(); }}>{saved ? "Close" : "Cancel"}</Button>
    </Dialog>
  );
}
