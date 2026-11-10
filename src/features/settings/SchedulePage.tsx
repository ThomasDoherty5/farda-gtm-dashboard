import { NativeOperationsControls } from "./NativeOperationsControls";
import { useId, useState } from "react";
import { useParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { scopeKey, useScope } from "@/adapter/scope";
import { useSave } from "@/adapter/useSave";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { SelectField, TextField } from "@/components/Field";
import { Divider, DetailRows, Halves, Notice, Page, PageHeader, Panel, Small, Split, Steps, kit } from "@/components/PageKit";
import { ReadState } from "@/components/ReadState";
import { ViewError } from "@/components/ViewError";
import { ActionError, blockedReason, LeaveGuard } from "@/features/approvals/shared";
import { CADENCES, TIMEZONES, type Cadence, type ScheduleData, type ScheduleDraft } from "@/fixtures/settings";
import { DEMO_NOW } from "@/fixtures/overview";
import type { NativeScheduleDetail } from "@/creator-agent/scheduleCadence";
import { NativeScheduleEditor } from "./NativeScheduleEditor";
import { nextRun, DST_POLICY, validateSchedule } from "./schedule";
import { AutomationNav, CadenceNotice, InfoDialog } from "./shared";

/** Zap and report schedule (Figma source 14:911, owner THO-305). Saving a draft is separate from enabling, and enabling stays blocked until the server verifies a connection. */
export function SchedulePage() {
  const context = useScope();
  const { adapter } = context;
  const { jobId = "" } = useParams();
  const query = useView<{ jobId: string }, ScheduleData | NativeScheduleDetail>("scheduleDetail", { jobId });
  const answer = query.isPlaceholderData ? null : query.data?.data;
  const data = answer?.jobId === jobId ? answer : null;
  const native = data && "kind" in data ? data : null;
  const demoData = adapter.kind === "demo" && data && !("kind" in data) ? data : null;
  const demo = adapter.kind === "demo";
  const [dialog, setDialog] = useState<"zapier" | null>(null);
  const enableBlocked = !demo ? "Source-owned schedule activation is unavailable from this draft editor." : query.data ? blockedReason(query.data, "enableSchedule") : "Available once the schedule has loaded.";

  return (
    <Page labelledBy="schedule-title" source="14:911">
      <PageHeader id="schedule-title" title={demoData?.title ?? "Zap and report schedule"} subtitle={demoData?.subtitle ?? "Schedule, inputs, output and recovery for one automation."}>
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 176 }} onClick={() => setDialog("zapier")}>Open Zapier</Button>
        <Button style={{ minWidth: 184 }} disabledReason={enableBlocked} reasonFor="enable-reason">Enable schedule</Button>
      </PageHeader>
      <AutomationNav current="reporting" width={152} />
      <CadenceNotice title="Separate cadences, separate approval boundaries" funnel>
        Daily sourcing and review plans use current permitted capacity; hourly monitoring checks enrolled profiles. Neither cadence bypasses human approval for outreach, and neither is represented as live without verified access.
      </CadenceNotice>
      <Notice kind="plain" title={demo?"Proposed configuration · currently paused":"Saved draft and source runtime are separate"} descriptionId="enable-reason">
        {demo?"Source connections, sandbox proof and owner approval are required before enabling live delivery. Zapier is the planned runner.":"Saving changes only the versioned draft. Installed cadence, current source configuration and delivery require separate source evidence; missing evidence remains unknown."}
      </Notice>
      {/* A partial or stale read is said in words, not only by a badge. */}
      <ReadState res={query.data} subject="This schedule" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading schedule…" />}
      {query.isError && <ViewError error={query.error} subject="This schedule" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (native ? <NativeScheduleEditor key={JSON.stringify([scopeKey(context),jobId])} data={native} res={query.data} reload={() => query.refetch()} />
        : demoData ? <Body res={query.data as ReadResponse<ScheduleData>} data={demoData} demo={demo} /> : <EmptyState state="Empty" title="No schedule yet"><p>The source responded, but this automation has no schedule.</p></EmptyState>)}
      {!demo && native && <NativeOperationsControls section="reports" jobRef={jobId}/>}
      <InfoDialog open={dialog === "zapier"} title="Open Zapier" demo={demo} onClose={() => setDialog(null)}>
        <p>No verified Zapier link or sign-in handoff is available from the server, so none is offered. This page saves schedule drafts. Zapier execution requires a separate verified connection.</p>
      </InfoDialog>
    </Page>
  );
}

function Body({ res, data, demo }: { res: ReadResponse<ScheduleData>; data: ScheduleData; demo: boolean }) {
  const [draft, setDraft] = useState<ScheduleDraft>(data.draft);
  const [synced, setSynced] = useState(data.draftVersion);
  const [dialog, setDialog] = useState<"evidence" | "failed" | null>(null);
  const save = useSave<ScheduleDraft, ScheduleDraft>();
  const timeId = useId();
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.draft);
  // Follow the server to a newer version only while there is no unsaved draft, so a conflict never discards one.
  if (synced !== data.draftVersion && !dirty) {
    setSynced(data.draftVersion);
    setDraft(data.draft);
  }
  const serverErrors = save.error instanceof AdapterError ? save.error.body.fieldErrors ?? {} : {};
  const [shown, setShown] = useState(false);
  const local = shown ? validateSchedule(draft) : {};
  const errors = { ...serverErrors, ...local };
  const next = nextRun(draft, demo ? new Date(DEMO_NOW) : new Date());
  const saveBlocked = blockedReason(res, "saveScheduleDraft");
  const noChange = save.data?.reasonCodes.includes("NO_CHANGE");

  const onSave = () => {
    setShown(true);
    if (Object.keys(validateSchedule(draft)).length) return;
    save.mutate({ resourceKind: "configurationDraft", resourceRef: `schedule-${data.jobId}`, expectedVersion: data.draftVersion, payload: draft });
  };

  return (
    <>
      <LeaveGuard dirty={dirty && !save.isPending} />
      <Split>
        <Panel headingGap={6} title="Only useful exceptions reach the team" note="One digest; every item links to its owning record." headingId="pipeline-title" testId="zap-pipeline">
          <Steps steps={data.steps} divided />
        </Panel>
        <Panel headingGap={6} title="Schedule" note="Edit in Zapier; keep a versioned decision." headingId="schedule-settings-title" testId="schedule-settings">
          <SelectField label="Cadence" value={draft.cadence} onChange={(v) => setDraft({ ...draft, cadence: v as Cadence })} error={errors.cadence ?? null} helpText="Active-cohort exceptions need an explicit override." options={[...CADENCES]} />
          <TextField label="Local time" value={draft.localTime} onChange={(v) => setDraft({ ...draft, localTime: v })} error={errors.localTime ?? null} helpText={`${draft.timezone} · daylight saving aware`} placeholder="08:30" />
          <SelectField label="Time zone" value={draft.timezone} onChange={(v) => setDraft({ ...draft, timezone: v })} error={errors.timezone ?? null} options={TIMEZONES.map((z) => ({ value: z, label: z }))} />
          <p className={kit.small} data-testid="next-run" id={timeId}>
            {next ? `Next run if enabled (derived, not active): ${next.label}.` : "Next run: not available until the draft is valid."} {DST_POLICY}
          </p>
          <DetailRows rows={[["Destination", data.destination], ["Owner", data.owner], ["State", data.state]]} />
          {save.error && !Object.keys(serverErrors).length && <ActionError error={save.error} />}
          {(save.data || data.draftVersion !== "v1") && (
            <p role="status" className={kit.status} data-testid="save-status">
              {noChange ? "Nothing to save: the draft matches version " : "Saved as version "}{data.draftVersion.replace("v", "")}. A saved draft does not enable the schedule.
            </p>
          )}
          <div><Button style={{ minWidth: 212 }} loading={save.isPending} disabledReason={saveBlocked} onClick={onSave}>Save draft</Button></div>
        </Panel>
      </Split>

      <Halves>
        <Panel headingGap={6} title="Preview the team will receive" note="Demo payload · aggregate counts and creator handles only" headingId="digest-title" testId="digest-preview">
          <div><Badge tone="warning" width={160}>{data.digest.count}</Badge></div>
          {data.digest.groups.map((g) => (
            <div key={g.heading} className={kit.stack}>
              <p className={kit.contextTitle} style={{ margin: 0 }}>{g.heading}</p>
              <div>{g.lines.map((l) => <p key={l} style={{ margin: 0 }}>{l}</p>)}</div>
            </div>
          ))}
          <Divider />
          <Small>{data.digest.footnote}</Small>
          <div><Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 248 }} onClick={() => setDialog("evidence")}>Open preview evidence</Button></div>
        </Panel>
        <Panel headingGap={6} title="History and recovery" note="A failed post is different from a failed source query." headingId="history-title" testId="run-history">
          <DataTable variant="dense" caption="Sandbox run history" columns={[{ label: "Run", width: "38.435%" }, { label: "Result", width: "32.653%" }, { label: "Receipt" }]} rows={data.history.map((h) => [h.run, h.result, h.receipt])} minWidth={0} />
          <Divider />
          <Small>{data.historyNote}</Small>
          <div><Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 212 }} onClick={() => setDialog("failed")}>Open failed run</Button></div>
        </Panel>
      </Halves>

      <Panel headingGap={6} title="Other reporting schedules" note="Each uses the same source, period and receipt contract." headingId="others-title" testId="other-schedules">
        <DataTable variant="dense" caption="Other reporting schedules" columns={[{ label: "Report", width: "24.038%" }, { label: "Timing", width: "33.654%" }, { label: "Enablement / exit" }]} rows={data.others.map((o) => [o.report, o.timing, o.enablement])} minWidth={720} />
      </Panel>
      {demo && <Small>Demo · this schedule is a paused example. No report is posted and no Zap is running.</Small>}

      <InfoDialog open={dialog === "evidence"} title="Preview evidence" demo={demo} onClose={() => setDialog(null)}>
        <p>The preview above is the whole demo payload. No Slack message was posted, so there is no message ID or receipt to open.</p>
      </InfoDialog>
      <InfoDialog open={dialog === "failed"} title="Failed run" demo={demo} onClose={() => setDialog(null)}>
        <p>The 27 Oct sandbox run failed on a connection error and posted nothing. The demo keeps no run trace, so none can be opened. Fix the source and rerun the read steps; check the report key and receipt before reposting.</p>
      </InfoDialog>
    </>
  );
}
