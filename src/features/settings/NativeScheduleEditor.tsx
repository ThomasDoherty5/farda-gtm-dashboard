import { useState } from "react";
import { z } from "zod";
import type { ReadResponse, SaveResourceResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { useSave } from "@/adapter/useSave";
import { Button } from "@/components/Button";
import { SelectField, TextField } from "@/components/Field";
import { DetailRows, Panel, Split, kit } from "@/components/PageKit";
import { ActionError, blockedReason, LeaveGuard } from "@/features/approvals/shared";
import { CADENCES, TIMEZONES } from "@/fixtures/settings";
import { DST_POLICY, nextRun, nativeScheduleDetailSchema, scheduleDraftSchema, type NativeScheduleDetail, type NativeScheduleDraft } from "@/creator-agent/scheduleCadence";

const initial: NativeScheduleDraft = { cadence: "weekdays", timezone: "America/Los_Angeles", localTime: "08:30", activeCohortOverride: false };
type Reconciliation = { state:"required"|"reading"|"failed" } | { state:"reviewed"; detail:NativeScheduleDetail };
const validInstant = z.string().datetime({offset:true}).refine(value=>Number.isFinite(Date.parse(value)));

function matchingSave(receipt: SaveResourceResponse<NativeScheduleDraft>, resourceRef:string, sent:NativeScheduleDraft, base:string, prior:NativeScheduleDetail) {
  const previous = /^j([1-9]\d*)-d(0|[1-9]\d*)$/.exec(base);
  if (!previous || !Number.isSafeInteger(Number(previous[2]))) return false;
  const saved = scheduleDraftSchema.safeParse(receipt.record);
  if (!saved.success || JSON.stringify(saved.data) !== JSON.stringify(sent) || !validInstant.safeParse(receipt.persistedAt).success) return false;
  const noChange = receipt.reasonCodes.length === 1 && receipt.reasonCodes[0] === "NO_CHANGE";
  if (noChange && (prior.savedForJobVersion !== prior.jobVersion || JSON.stringify(prior.draft) !== JSON.stringify(sent))) return false;
  const revision = Number(previous[2]) + (noChange ? 0 : 1);
  return receipt.executionCertainty === "applied" && receipt.resourceRef === resourceRef && receipt.persistedByRef.trim().length > 0 &&
    (noChange || !receipt.reasonCodes.length) && revision > 0 && Number.isSafeInteger(revision) && receipt.resourceVersion === `j${previous[1]}-d${revision}`;
}

export function NativeScheduleEditor({data,res,reload}:{data:NativeScheduleDetail;res:ReadResponse<unknown>;reload:()=>Promise<{isSuccess:boolean;data?:ReadResponse<unknown>}>}) {
  const [edit,setEdit] = useState<{ base:string; value:NativeScheduleDraft } | null>(null);
  const [message,setMessage] = useState("");
  const [reconciliation,setReconciliation] = useState<Reconciliation | null>(null);
  const save = useSave<NativeScheduleDraft,NativeScheduleDraft>();
  const value = edit?.value ?? data.draft ?? initial;
  const invalid = scheduleDraftSchema.safeParse(value);
  const dirty = edit !== null && JSON.stringify(scheduleDraftSchema.safeParse(edit.value).data ?? edit.value) !== JSON.stringify(data.draft);
  const conflict = edit !== null && (edit.base !== data.draftVersion || save.error instanceof AdapterError && save.error.body.code === "STALE_VERSION");
  const update = (change:Partial<NativeScheduleDraft>) => { setMessage(""); setEdit({base:edit?.base ?? data.draftVersion,value:{...value,...change}}); };
  const next = nextRun(value,new Date(data.observedAt));
  const saveBlocked = blockedReason(res,"saveScheduleDraft") ?? (reconciliation ? "Reconcile the saved draft before saving again." : conflict ? "Review the current draft before saving." : !invalid.success ? "Correct the local time or cadence." : null);
  const onSave = () => {
    if (saveBlocked || !invalid.success) return;
    const sent = invalid.data, base = edit?.base ?? data.draftVersion, resourceRef = "schedule-"+data.jobId;
    setMessage("");
    setEdit(previous => previous ?? {base,value:sent});
    save.mutate({resourceKind:"configurationDraft",resourceRef,expectedVersion:base,payload:sent},{
      onSuccess: receipt => {
        if (!matchingSave(receipt,resourceRef,sent,base,data)) {
          setReconciliation({state:"required"});
          return;
        }
        setEdit(previous => previous && JSON.stringify(scheduleDraftSchema.safeParse(previous.value).data ?? previous.value) !== JSON.stringify(sent) ? {...previous,base:receipt.resourceVersion} : null);
        setMessage(`Saved draft ${receipt.resourceVersion} at ${receipt.persistedAt}. Schedule disabled.`);
      },
      onError: error => {
        if (error instanceof AdapterError && error.body.executionCertainty === "uncertain") setReconciliation({state:"required"});
      }
    });
  };
  const inspectSaved = async () => {
    setReconciliation({state:"reading"});
    try {
      const read = await reload();
      const parsed = nativeScheduleDetailSchema.safeParse(read.data?.data);
      if (!read.isSuccess || !parsed.success || parsed.data.jobId !== data.jobId) throw new Error("UNVERIFIED_SCHEDULE_READ");
      setReconciliation({state:"reviewed",detail:parsed.data});
    } catch { setReconciliation({state:"failed"}); }
  };
  return <>
    <LeaveGuard dirty={dirty && !save.isPending} subject="schedule draft" />
    <Split>
      <Panel title="Registered job" headingId="registered-job-title" note="Saved job registry">
        <DetailRows rows={[["Definition version",String(data.jobVersion)],["Schedule","Disabled"],["Draft version",data.draft ? data.draftVersion : "No saved draft"],
          ["Saved at",data.updatedAt ?? "No saved draft"],["Read at",data.observedAt]]}/>
        {data.savedForJobVersion !== null && data.savedForJobVersion !== data.jobVersion && <p role="status">This draft was saved for job version {data.savedForJobVersion}. Review it against the current job before saving.</p>}
        <p className={kit.small}>Provider triggers and delivery receipts are unavailable for this draft.</p>
      </Panel>
      <Panel title="Schedule" headingId="schedule-settings-title" testId="schedule-settings" note={data.draft ? "Edit the saved draft." : "Choose an initial draft. The suggested values have not been saved."}>
        <SelectField label="Cadence" value={value.cadence} onChange={v=>update({cadence:v as NativeScheduleDraft["cadence"]})} options={[...CADENCES]}/>
        <TextField label="Local time" value={value.localTime} onChange={v=>update({localTime:v})} error={invalid.success ? null : "Use HH:MM between 00:00 and 23:59."}/>
        <SelectField label="Time zone" value={value.timezone} onChange={v=>update({timezone:v as NativeScheduleDraft["timezone"]})} options={TIMEZONES.map(v=>({label:v,value:v}))}/>
        <label><input type="checkbox" checked={value.activeCohortOverride} onChange={e=>update({activeCohortOverride:e.target.checked})}/> Request active-cohort override in this draft</label>
        <p className={kit.small} data-testid="next-run">{next ? `Preview from the saved read time: ${next.label} (${value.timezone}).` : "Preview unavailable for this draft."} Schedule disabled. {DST_POLICY}</p>
        {save.error && <ActionError error={save.error}/>}
        {reconciliation && <section aria-label="Unverified schedule save">
          <p role="alert">Save unverified. Your edits are preserved. Read the saved job before deciding whether to save again.</p>
          {reconciliation.state === "failed" && <p>The current saved draft could not be verified.</p>}
          <Button variant="secondary" loading={reconciliation.state === "reading"} onClick={()=>void inspectSaved()}>Read saved draft</Button>
          {reconciliation.state === "reviewed" && <>
            <DetailRows rows={[["Verified version",reconciliation.detail.draftVersion],["Saved cadence",reconciliation.detail.draft?.cadence ?? "No saved draft"],
              ["Saved local time",reconciliation.detail.draft?.localTime ?? "No saved draft"],["Saved timezone",reconciliation.detail.draft?.timezone ?? "No saved draft"],
              ["Saved override",reconciliation.detail.draft ? reconciliation.detail.draft.activeCohortOverride ? "Requested" : "Off" : "No saved draft"]]} />
            <Button variant="secondary" onClick={()=>{setEdit(null);setReconciliation(null);save.reset();}}>Use verified draft</Button>
            <Button variant="secondary" onClick={()=>{setEdit({base:reconciliation.detail.draftVersion,value});setReconciliation(null);save.reset();}}>Keep edits on verified version</Button>
          </>}
        </section>}
        {conflict && !reconciliation && <div role="status"><p>Review your edits against the current saved draft.</p>
          <DetailRows rows={[["Saved cadence",data.draft?.cadence ?? "No saved draft"],["Saved local time",data.draft?.localTime ?? "Unknown"],["Saved timezone",data.draft?.timezone ?? "Unknown"],
            ["Saved override",data.draft ? data.draft.activeCohortOverride ? "Requested" : "Off" : "Unknown"],["Current version",data.draftVersion]]}/>
          <Button variant="secondary" onClick={()=>void reload()}>Refresh current draft</Button>
          <Button variant="secondary" onClick={()=>{setEdit(null);save.reset();setMessage("");}}>Use current saved draft</Button>
          {edit && edit.base !== data.draftVersion && <Button variant="secondary" onClick={()=>{setEdit({...edit,base:data.draftVersion});save.reset();}}>Keep edits on current version</Button>}
        </div>}
        {message && <p role="status" data-testid="save-status">{message}</p>}
        <Button loading={save.isPending} disabledReason={saveBlocked} onClick={onSave}>Save draft</Button>
      </Panel>
    </Split>
  </>;
}
