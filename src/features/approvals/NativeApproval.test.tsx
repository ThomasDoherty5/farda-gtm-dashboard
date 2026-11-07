import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import type { FardaAdapter } from "@/adapter/adapter";
import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { renderRoute } from "@/test/renderWithAdapter";
import { nativeApprovalViewSchema, nativeRunViewSchema, type NativeApprovalView, type NativeRunView } from "@/creator-agent/actions/views";
import { nativeCommandSchema, validNativeAcknowledgment } from "./NativeApprovalActions";
import { nativeMoney } from "./NativeApprovalPage";

const approval = (): NativeApprovalView => nativeApprovalViewSchema.parse({kind:"native-approval",approvalRef:"approval-opaque",manifestRef:"manifest-opaque",version:"av1-1.1-opaque",policyVersion:"policy-opaque",actionKind:"synthetic-task",phase:"other",manifestVersion:1,current:{state:"approved",reasonCodes:[]},createdAt:"2026-11-06T12:00:00Z",expiresAt:"2026-11-07T12:00:00Z",bounds:{maxItems:2,maxUnits:1,maxSpendMinor:0,currency:"USD"},exposure:{state:"unknown",reason:"Authoritative economic exposure unavailable"},items:[{itemRef:"item-one",targetRef:"target-one",itemVersion:"version-one",units:0,spendMinor:0},{itemRef:"item-two",targetRef:"target-two",itemVersion:"version-two",units:1,spendMinor:0}],versions:{product:{state:"required",version:"product-opaque"},terms:{state:"notApplicable",policyVersion:"policy-opaque",reason:"Local task"},rights:{state:"notApplicable",policyVersion:"policy-opaque",reason:"Local task"}},requestState:"recorded",sourceEffect:"none",decision:{receiptRef:"decision-opaque",decision:"approved",decidedAt:"2026-11-06T12:01:00Z",actorRef:"person-opaque"},appDecision:{allowed:false,reasonCode:"APPROVAL_CHANNEL_REQUIRED"},approvedIsSent:false});
const run = (): NativeRunView => nativeRunViewSchema.parse({kind:"native-run",runRef:"run-opaque",version:"av1-1.1-run",approvalRef:"approval-opaque",manifestRef:"manifest-opaque",state:"queued",control:"active",current:{state:"ready",reasonCodes:[]},executionCertainty:"notApplied",counts:{total:2,due:2,deferred:0,leased:0,held:0,completed:0,cancelled:0,failed:0,reconcile:0,reused:0},usage:{workSteps:0,externalCalls:null,modelCalls:0,sourceQuota:"unknown",zapierTasks:"unknown",runtimeCost:"unknown"},items:[{itemRef:"item-one",receiptRef:null,sourceEffect:null,observedAt:null},{itemRef:"item-two",receiptRef:null,sourceEffect:null,observedAt:null}]});
const scope={workspaceId:"w",accountIds:["a"],environment:"sandbox" as const,authorizationScopeVersion:"scope-one"};
function fixture() {
  let a=approval(),r=run(),denied=false;
  const calls:ActionRequest<unknown>[]=[];
  const caps=["requestApproval","reconcileApproval","dispatchApprovedAction","lookup","pauseRun","cancelUnsent","resumeRun"].map(actionKind=>({actionKind,state:"available" as const,reasonCodes:[]}));
  const res=(request:ReadRequest<unknown>,data:unknown):ReadResponse<unknown>=>({schemaVersion:SCHEMA_VERSION,requestId:request.requestId,scope,dataVersion:"read-one",dataState:"ready",data,sourceFreshness:[],coverage:{expectedCount:2,observedCount:2,missingCount:0,complete:true,reasonCodes:[]},capabilities:caps,page:{nextCursor:null,hasMore:false},refresh:{nextPollAfterMs:null}});
  const demo=createDemoAdapter();
  const ack=(request:ActionRequest<unknown>):ActionResponse=>({schemaVersion:SCHEMA_VERSION,requestId:request.requestId,scope,actionRef:a.approvalRef,state:request.operation==="requestApproval"?"approvalPending":request.operation==="controlRun"?"paused":"queued",runRef:request.operation==="requestApproval"?null:r.runRef,approvalRef:request.approvalRef,manifestRef:request.manifestRef,payloadVersion:request.operation==="requestApproval"?request.expectedVersion:r.version,policyVersion:"policy-opaque",modelVersion:null,offerVersion:null,reasonCodes:["SOURCE_EFFECT_NOT_CONFIRMED"],receiptRefs:[],nextAction:null,nextPollAfterMs:null,executionCertainty:"applied"});
  let answer:(request:ActionRequest<unknown>)=>Promise<ActionResponse>=async request=>ack(request);
  const adapter: FardaAdapter={...demo,environment:"sandbox",kind:"live",readView:(async(request:ReadRequest<unknown>)=>{if(denied)throw new AdapterError({code:"FORBIDDEN",message:"No access",requestId:request.requestId,correlationId:null,retryable:false,retryAfterMs:null});if(request.viewKey==="approvalDetail")return res(request,a);if(request.viewKey==="runDetail")return res(request,r);return res(request,null);}) as FardaAdapter["readView"],submitAction:async request=>{calls.push(request);return answer(request);}};
  return {adapter,calls,ack,approval:()=>a,run:()=>r,setApproval:(v:NativeApprovalView)=>{a=v;},setRun:(v:NativeRunView)=>{r=v;},answer:(fn:typeof answer)=>{answer=fn;},deny:()=>{denied=true;},allow:()=>{denied=false;}};
}
beforeEach(()=>sessionStorage.clear());
afterEach(cleanup);
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,"showModal"), originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,"close");
beforeAll(()=>{Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute("open","");}});Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute("open");}});});
afterAll(()=>{if(originalShow)Object.defineProperty(HTMLDialogElement.prototype,"showModal",originalShow);else Reflect.deleteProperty(HTMLDialogElement.prototype,"showModal");if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,"close",originalClose);else Reflect.deleteProperty(HTMLDialogElement.prototype,"close");});
const button=(name:string)=>screen.getByRole("button",{name});

describe("native exact approval and finite handoff",()=>{
  it("branches before the legacy creator model, preserves unknowns and keeps app decisions disabled",async()=>{
    const w=fixture();renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByRole("heading",{name:"Exact action manifest"});
    expect(screen.getByTestId("native-approval-status")).toHaveTextContent("Approved, awaiting dispatch");
    expect(button("Approve this version")).toHaveAccessibleDescription(/APPROVAL_CHANNEL_REQUIRED/);
    expect(screen.getByText(/Unknown · Authoritative economic exposure/)).toBeInTheDocument();
    expect(screen.queryByText(/Social Cat|routine.with.ella|15% per/)).not.toBeInTheDocument();
    expect(w.calls).toHaveLength(0);
  });
  it("queues exactly the selected subset, never marks queued work done and links the acknowledged run",async()=>{
    const w=fixture(),u=userEvent.setup();renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(screen.getByLabelText("Select item 2"));await u.click(button("Queue selected approved items"));
    expect(await screen.findByRole("link",{name:"Open recorded run"})).toHaveAttribute("href","/runs/run-opaque?tab=approval");
    expect(w.calls[0]).toMatchObject({operation:"dispatchApprovedAction",expectedVersion:"av1-1.1-opaque",payload:{itemRefs:["item-one"]},entityRefs:[]});
    expect(screen.getByTestId("native-approval-status")).toHaveTextContent("Approved, awaiting dispatch");
    expect(button("Queue selected approved items")).toHaveAccessibleDescription(/already has a recorded handoff/);
  });
  it("rejects an empty finite selection and can restore the whole manifest with keyboard controls",async()=>{
    const w=fixture(),u=userEvent.setup();renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(screen.getByLabelText("Select item 1"));await u.click(screen.getByLabelText("Select item 2"));expect(button("Queue selected approved items")).toHaveAccessibleDescription(/at least one/);await u.click(button("Select whole manifest"));expect(screen.getByLabelText("Select item 1")).toBeChecked();expect(screen.getByLabelText("Select item 2")).toBeChecked();expect(w.calls).toHaveLength(0);
  });
  it("does not forget a recorded finite handoff after a separate approval readback command or reload",async()=>{
    const w=fixture(),u=userEvent.setup();renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(button("Queue selected approved items"));await screen.findByRole("link",{name:"Open recorded run"});await u.click(button("Reconcile approval evidence"));await waitFor(()=>expect(w.calls).toHaveLength(2));expect(w.calls[1]!.operation).toBe("requestApproval");cleanup();renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByRole("link",{name:"Open recorded run"});expect(button("Queue selected approved items")).toHaveAttribute("aria-disabled","true");
  });
  it("keeps unknown original key/version/subset across unmount and a newer source version",async()=>{
    const w=fixture(),u=userEvent.setup();w.answer(async()=>{throw new Error("lost acknowledgment");});renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(screen.getByLabelText("Select item 2"));await u.click(button("Queue selected approved items"));await screen.findByRole("heading",{name:"Keep the original request"});const first=w.calls[0]!;
    cleanup();w.setApproval({...w.approval(),version:"av1-2.2-opaque",manifestVersion:2,manifestRef:"manifest-new"});w.answer(async request=>({...w.ack(request),manifestRef:first.manifestRef}));renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByRole("button",{name:"Recover original request"});expect(button("Queue selected approved items")).toHaveAccessibleDescription(/Recover the original/);await u.click(button("Recover original request"));await screen.findByRole("link",{name:"Open recorded run"});
    expect(w.calls[1]).toMatchObject({idempotencyKey:first.idempotencyKey,expectedVersion:first.expectedVersion,manifestRef:first.manifestRef,payload:first.payload});
    const stored=Object.keys(sessionStorage).map(k=>sessionStorage.getItem(k)).join("");expect(stored).not.toMatch(/private-message|rationale|creatorHandle/);
  });
  it("holds malformed acknowledgment without a fresh-key retry",async()=>{
    const w=fixture(),u=userEvent.setup();w.answer(async request=>({...w.ack(request),manifestRef:"foreign-manifest"}));renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(button("Queue selected approved items"));await screen.findByRole("heading",{name:"Keep the original request"});expect(button("Queue selected approved items")).toHaveAttribute("aria-disabled","true");await u.click(button("Recover original request"));await waitFor(()=>expect(w.calls).toHaveLength(2));expect(w.calls[1]!.idempotencyKey).toBe(w.calls[0]!.idempotencyKey);
  });
  it.each(["malformed","different-record"])("does not erase the uncertainty fence for %s persisted recovery metadata",async variant=>{
    const w=fixture(),u=userEvent.setup();w.answer(async()=>{throw new Error("lost ACK");});renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(button("Queue selected approved items"));await screen.findByRole("heading",{name:"Keep the original request"});const key=Object.keys(sessionStorage).find(k=>k.startsWith("native-action:"))!,m=JSON.parse(sessionStorage.getItem(key)!);cleanup();sessionStorage.setItem(key,variant==="malformed"?"broken-json":JSON.stringify({...m,command:{...m.command,approvalRef:"different-approval"}}));renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByText(/Recovery metadata is invalid/);expect(button("Queue selected approved items")).toHaveAttribute("aria-disabled","true");expect(screen.queryByRole("button",{name:"Recover original request"})).not.toBeInTheDocument();expect(w.calls).toHaveLength(1);
  });
  it("history is read-only and explicitly does not substitute the current version for an absent older one",async()=>{
    const w=fixture();renderRoute("/approvals/approval-opaque?version=99",w.adapter);await screen.findByRole("heading",{name:"Historical version unavailable"});expect(screen.getByText(/not a substitute/)).toBeInTheDocument();expect(screen.queryByRole("button",{name:"Queue selected approved items"})).not.toBeInTheDocument();expect(w.calls).toHaveLength(0);
  });
  it.each(["FORBIDDEN","RATE_LIMITED"])("keeps the lost-ACK intent held after generic %s/notApplied replay refusal",async code=>{
    const w=fixture(),u=userEvent.setup();w.answer(async()=>{throw new Error("lost ACK");});renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(button("Queue selected approved items"));await screen.findByRole("heading",{name:"Keep the original request"});const first=w.calls[0]!;
    w.answer(async()=>{if(code==="FORBIDDEN")w.deny();throw new AdapterError({code,message:"Current transport refused",requestId:null,correlationId:null,retryable:false,retryAfterMs:null,executionCertainty:"notApplied"});});await u.click(button("Recover original request"));await waitFor(()=>expect(w.calls).toHaveLength(2));cleanup();w.allow();renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByRole("heading",{name:"Keep the original request"});expect(button("Queue selected approved items")).toHaveAttribute("aria-disabled","true");
    w.answer(async request=>w.ack(request));await u.click(button("Recover original request"));await screen.findByRole("link",{name:"Open recorded run"});expect(w.calls.map(c=>c.idempotencyKey)).toEqual([first.idempotencyKey,first.idempotencyKey,first.idempotencyKey]);
  });
  it("does not restore a successful late action response after a concurrent read denies the scope",async()=>{
    const w=fixture(),u=userEvent.setup();let finish:((r:ActionResponse)=>void)|undefined;w.answer(()=>new Promise(resolve=>{finish=resolve;}));renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(button("Queue selected approved items"));await waitFor(()=>expect(w.calls).toHaveLength(1));w.deny();await u.click(button("Refresh approval evidence"));await waitFor(()=>expect(screen.queryByText("target-one")).not.toBeInTheDocument());await act(async()=>{finish!(w.ack(w.calls[0]!));await new Promise(resolve=>setTimeout(resolve,20));});expect(screen.queryByRole("link",{name:"Open recorded run"})).not.toBeInTheDocument();cleanup();w.allow();renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByRole("heading",{name:"Keep the original request"});
  });
  it("clears protected approval data on denied action and never restores a late receipt",async()=>{
    const w=fixture(),u=userEvent.setup();w.answer(async()=>{w.deny();throw new AdapterError({code:"FORBIDDEN",message:"No access",requestId:null,correlationId:null,retryable:false,retryAfterMs:null,executionCertainty:"uncertain"});});renderRoute("/approvals/approval-opaque",w.adapter);await screen.findByLabelText("Select item 1");await u.click(button("Queue selected approved items"));await waitFor(()=>expect(screen.queryByText("target-one")).not.toBeInTheDocument());expect(screen.queryByRole("link",{name:"Open recorded run"})).not.toBeInTheDocument();
  });
});
describe("native run receipt and recovery presentation",()=>{
  it("previews the exact finite run before canceling only eligible unsent work",async()=>{
    const w=fixture(),u=userEvent.setup();renderRoute("/runs/run-opaque?tab=approval",w.adapter);await screen.findByRole("heading",{name:"Exact approved work"});await u.click(button("Cancel unsent items"));expect(await screen.findByRole("dialog",{name:"Review cancellation of unsent work"})).toBeInTheDocument();expect(w.calls).toHaveLength(0);expect(screen.getByText(/Missing receipt does not mean unsent/)).toBeInTheDocument();await u.click(button("Request eligible cancellation"));await waitFor(()=>expect(w.calls).toHaveLength(1));expect(w.calls[0]).toMatchObject({operation:"controlRun",actionKind:"cancelUnsent",runRef:"run-opaque",expectedVersion:"av1-1.1-run",payload:{control:"cancel"}});
  });
  it("shows zero confirmed, unknown native usage and source-gated recovery rather than fabricated business steps",async()=>{
    const w=fixture();w.setRun({...w.run(),executionCertainty:"uncertain",current:{state:"uncertain",reasonCodes:["SOURCE_OUTCOME_UNKNOWN"]},state:"reconcile"});renderRoute("/runs/run-opaque?tab=recovery",w.adapter);await screen.findByRole("heading",{name:"The action may already have completed."});expect(screen.getByRole("progressbar")).toHaveAttribute("value","0");expect(button("Record confirmed sent")).toHaveAccessibleDescription(/browser assertion/);expect(button("Request a fresh attempt")).toHaveAccessibleDescription(/closed not-applied/);expect(screen.queryByText("Pay")).not.toBeInTheDocument();
  });
  it("retains exact run version and control through a lost pause ACK and reload",async()=>{
    const w=fixture(),u=userEvent.setup();w.answer(async()=>{throw new Error("lost pause ACK");});renderRoute("/runs/run-opaque?tab=approval",w.adapter);await screen.findByRole("heading",{name:"Exact approved work"});await u.click(button("Pause run"));await screen.findByRole("button",{name:"Recover original request"});const first=w.calls[0]!;cleanup();w.setRun({...w.run(),version:"av1-2.2-run",control:"paused"});w.answer(async request=>w.ack(request));renderRoute("/runs/run-opaque?tab=recovery",w.adapter);await screen.findByRole("button",{name:"Recover original request"});await u.click(button("Recover original request"));await waitFor(()=>expect(w.calls).toHaveLength(2));expect(w.calls[1]).toMatchObject({idempotencyKey:first.idempotencyKey,expectedVersion:first.expectedVersion,payload:{control:"pause"}});
  });
  it("reconciles only by native lookup and distinguishes a confirmed local artifact from a provider action",async()=>{
    const w=fixture(),u=userEvent.setup();w.answer(async request=>{w.setRun({...w.run(),items:[{itemRef:"item-one",receiptRef:"effect-opaque",sourceEffect:"localArtifact",observedAt:"2026-11-06T12:10:00Z"},w.run().items[1]!]});return w.ack(request);});renderRoute("/runs/run-opaque?tab=recovery",w.adapter);await screen.findByRole("heading",{name:"Exact approved work"});await u.click(button("Reconcile source result"));await screen.findByText("Local artifact confirmed");expect(w.calls[0]).toMatchObject({operation:"reconcileRun",actionKind:"lookup",payload:{request:"lookup"},runRef:"run-opaque"});expect(screen.queryByText("Provider action confirmed")).not.toBeInTheDocument();expect(screen.getByRole("progressbar")).toHaveAttribute("value","1");
  });
});
it("the native controller rejects injected payload text, duplicate subset and foreign scope acknowledgment",()=>{
  const command={entityRefs:[],expectedVersion:"v1",approvalRef:"approval-opaque",manifestRef:"manifest-opaque",runRef:null,operation:"dispatchApprovedAction",actionKind:"dispatchApprovedAction",payload:{itemRefs:["item-one"]}};
  expect(nativeCommandSchema.safeParse({...command,payload:{itemRefs:["item-one"],message:"private"}}).success).toBe(false);expect(nativeCommandSchema.safeParse({...command,payload:{itemRefs:["item-one","item-one"]}}).success).toBe(false);
  const w=fixture(),c=nativeCommandSchema.parse(command),r=w.ack({...c,schemaVersion:SCHEMA_VERSION,requestedScope:scope,idempotencyKey:"k",requestId:"r"});expect(validNativeAcknowledgment({...r,scope:{...scope,accountIds:["other"]}},c,scope)).toBe(false);
});
it("keeps exact cents for the largest allowed minor-unit bound",()=>expect(nativeMoney(Number.MAX_SAFE_INTEGER)).toBe("$90,071,992,547,409.91"));
