import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { SCHEMA_VERSION } from "@/adapter/contract";
import { respondWith } from "@/adapter/demoViews";
import { renderRoute } from "@/test/renderWithAdapter";
import type { NativeScheduleDetail, NativeScheduleDraft } from "@/creator-agent/scheduleCadence";

const ref = "synthetic-job-ref";
const time = "2026-11-05T17:00:00.000Z";
const sent: NativeScheduleDraft = {cadence:"weekdays",localTime:"09:15",timezone:"America/Los_Angeles",activeCohortOverride:false};
const initial: NativeScheduleDetail = {kind:"saved-schedule-draft",source:"saved-operations",jobId:ref,jobVersion:1,draftVersion:"j1-d0",
  draft:null,savedForJobVersion:null,updatedAt:null,observedAt:time,scheduleState:"disabled",preview:null};
function renderEditor(firstReceipt: Record<string,unknown>) {
  const saved = structuredClone(initial), keys: string[] = [];
  const adapter = createLiveAdapter("sandbox",{transport:{async send(request) {
    if(request.kind === "read") return respondWith(request.envelope, structuredClone(saved),{dataVersion:saved.draftVersion,
      capabilities:[{actionKind:"saveScheduleDraft",state:"available",reasonCodes:[]},{actionKind:"enableSchedule",state:"held",reasonCodes:["DISABLED"]}]});
    if(request.kind !== "save") throw new Error("unexpected action");
    const envelope = request.envelope;
    keys.push(envelope.idempotencyKey);
    const record = envelope.payload as NativeScheduleDraft;
    Object.assign(saved,{draft:{...record},updatedAt:time,savedForJobVersion:1,draftVersion:"j1-d"+keys.length});
    const receipt = {schemaVersion:SCHEMA_VERSION,requestId:envelope.requestId,scope:{...envelope.requestedScope,authorizationScopeVersion:"synthetic"},
      resourceRef:envelope.resourceRef,resourceVersion:saved.draftVersion,persistedAt:time,persistedByRef:"synthetic-reviewer",record,
      reasonCodes:[],executionCertainty:"applied"};
    return keys.length === 1 ? {...receipt,...firstReceipt} : receipt;
  }}});
  renderRoute("/automations/"+ref+"/schedule",adapter);
  return {saved,keys};
}
describe("schedule save acknowledgments through the authenticated adapter",()=>{
  it.each([
    ["a different draft",{record:{...sent,localTime:"08:30"}}],
    ["a blank version",{resourceVersion:""}],
    ["a different job version",{resourceVersion:"j2-d1"}],
    ["a skipped revision",{resourceVersion:"j1-d9"}],
    ["a date with an invalid offset",{persistedAt:"2026-11-05T17:00:00+99:99"}],
    ["a no-change acknowledgment for an unsaved draft",{resourceVersion:"j1-d0",reasonCodes:["NO_CHANGE"]}],
    ["an unconfirmed outcome",{executionCertainty:"uncertain"}],
  ])("holds %s until the operator reads the saved job and chooses a reconciliation",async(_name,receipt)=>{
    const {keys,saved}=renderEditor(receipt as Record<string,unknown>);
    const user=userEvent.setup(), input=await screen.findByLabelText("Local time");
    await user.clear(input);await user.type(input,"09:15");await user.click(screen.getByRole("button",{name:"Save draft"}));
    const hold=await screen.findByRole("region",{name:"Unverified schedule save"});
    expect(hold).toHaveTextContent("Save unverified");expect(input).toHaveValue("09:15");
    expect(screen.queryByTestId("save-status")).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Save draft"})).toHaveAttribute("aria-disabled","true");
    await user.click(screen.getByRole("button",{name:"Save draft"})); expect(keys).toHaveLength(1);
    expect(within(hold).queryByRole("button",{name:"Keep edits on verified version"})).not.toBeInTheDocument();
    // The operator's independent read sees the actual saved record, which may differ from both draft and acknowledgment.
    saved.draft={...sent,localTime:"10:45"};
    await user.click(within(hold).getByRole("button",{name:"Read saved draft"}));
    expect(await within(hold).findByText("10:45")).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Save draft"})).toHaveAttribute("aria-disabled","true");expect(keys).toHaveLength(1);
    await user.click(within(hold).getByRole("button",{name:"Keep edits on verified version"}));expect(input).toHaveValue("09:15");
    await user.click(screen.getByRole("button",{name:"Save draft"}));await waitFor(()=>expect(screen.getByTestId("save-status")).toHaveTextContent("Saved draft j1-d2"));
    expect(new Set(keys).size).toBe(2);
  });
  it("confirms the exact submitted record, valid version and timestamp",async()=>{
    renderEditor({}); const user=userEvent.setup(), input=await screen.findByLabelText("Local time");
    await user.clear(input);await user.type(input,"09:15");await user.click(screen.getByRole("button",{name:"Save draft"}));
    expect(await screen.findByTestId("save-status")).toHaveTextContent("Saved draft j1-d1 at "+time);
    expect(screen.queryByRole("region",{name:"Unverified schedule save"})).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Enable schedule"})).toHaveAttribute("aria-disabled","true");
  });
});
