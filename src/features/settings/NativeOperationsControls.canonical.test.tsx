import {webcrypto} from "node:crypto";
import {act,screen,waitFor,within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {createDemoAdapter} from "@/adapter/demoAdapter";
import type {FardaAdapter} from "@/adapter/adapter";
import type {ActionRequest} from "@/adapter/contract";
import {AdapterError} from "@/adapter/errors";
import {nativeOperationsControlSchema,type NativeOperationsControl} from "@/creator-agent/operationsControlsSchema";
import {renderRoute,testClient} from "@/test/renderWithAdapter";
import "./AutomationsPage";

const target={kind:"task" as const,targetRef:"synthetic-finite-target",title:"Synthetic finite task",details:[["Scope","One synthetic item"]] as [string,string][],allowed:true,reasonCodes:[],effect:"previewOnly" as const,items:[{itemRef:"synthetic-item",targetRef:"synthetic-subject",units:1,spendMinor:0}]};
const stamp=()=>new Date().toISOString();
function harness(options:{lost?:boolean;pending?:boolean;named?:boolean;leaseMs?:number;legacyOnly?:boolean}={}){
 const demo=createDemoAdapter(),commands:ActionRequest<unknown>[]=[],filters:unknown[]=[];
 let recorded=false;
 const adapter:FardaAdapter={...demo,kind:"live",readView:(async request=>{
  const response=await demo.readView(request);if(request.viewKey!=="operationsControl")return response;
  filters.push(request.filters);
  const data=nativeOperationsControlSchema.parse(response.data),f=request.filters as {proposalRequestKey?:string;mine?:boolean};
  const current=commands.at(-1),marker=Object.entries(sessionStorage).filter(([key])=>key.startsWith("operations-control-pending:")).map(([,value])=>JSON.parse(value)).find(m=>m.key===f.proposalRequestKey);
  const receipt=f.proposalRequestKey&&recorded&&current?{requestKey:f.proposalRequestKey,actorRef:"agent-reviewer",state:"recorded" as const,baseVersion:current.expectedVersion,actionRef:"synthetic-intent",manifestDigest:"d".repeat(64),payloadDigest:marker?.hash??"e".repeat(64),createdAt:stamp(),reason:"Synthetic reason"}:null;
  const projected:NativeOperationsControl={...data,actorRef:"agent-reviewer",role:"reviewer",sourceState:"current",sourceObservedAt:stamp(),
   namedActor:options.named===false?{state:"unavailable",personRef:null,roles:[],observedAt:null,validUntil:null}:{state:"verified",personRef:"synthetic-person",roles:["operator"],observedAt:stamp(),validUntil:new Date(Date.now()+(options.leaseMs??60_000)).toISOString()},
   actions:[{kind:target.kind,targetRef:target.targetRef,title:target.title,details:target.details,allowed:true,reasonCodes:[]}],canonicalActions:options.legacyOnly?[]:[target],records:[{id:"synthetic-record",title:"Protected source record",details:[["Proof","Synthetic source proof"]]}],
   localRuns:f.mine?[{id:"synthetic-mine",title:"Assigned synthetic run",details:[["Assignment","synthetic-person"]]}]:[],
   runFilterEvidence:{matched:f.mine?1:0,unknownPlatform:0,assignment:options.named===false?"named-principal-unverified":"named-principal-verified"},
   proposalReconciliation:receipt,
   canonicalReconciliation:receipt?{requestKey:receipt.requestKey,state:options.pending?"pending":"recorded",approvalRef:options.pending?null:"synthetic-approval",manifestRef:options.pending?null:"synthetic-manifest",version:null,executionCertainty:options.pending?"uncertain":"applied"}:null};
  return {...response,data:nativeOperationsControlSchema.parse(projected)};
 }) as FardaAdapter["readView"],submitAction:async request=>{
  commands.push(request);recorded=true;
  if(options.lost)throw new AdapterError({code:"NETWORK_ERROR",message:"Synthetic lost acknowledgment",executionCertainty:"uncertain",retryable:false,retryAfterMs:null,requestId:request.requestId,correlationId:null});
  return {schemaVersion:request.schemaVersion,requestId:request.requestId,scope:{...request.requestedScope,authorizationScopeVersion:"synthetic"},actionRef:"synthetic-approval",approvalRef:"synthetic-approval",manifestRef:"synthetic-manifest",runRef:null,state:"draft",payloadVersion:"synthetic-version",policyVersion:"synthetic-policy",modelVersion:null,offerVersion:null,nextAction:null,nextPollAfterMs:null,receiptRefs:[],reasonCodes:[],executionCertainty:"applied"};
 }};
 return {adapter,commands,filters};
}
async function draft(){
 const user=userEvent.setup();
 const trigger=(await screen.findAllByRole("button",{name:"Request task"}))[0]!;
 await waitFor(()=>expect(trigger).not.toHaveAttribute("aria-disabled","true"));await user.click(trigger);
 const chooser=within(screen.getAllByRole("dialog",{hidden:true}).find(d=>within(d).queryByRole("heading",{name:"Choose a registered task",hidden:true}))!);
 await user.click(chooser.getByRole("button",{name:"Draft Synthetic finite task",hidden:true}));
 const dialog=within(screen.getAllByRole("dialog",{hidden:true}).find(d=>within(d).queryByRole("heading",{name:"Request task",hidden:true}))!);
 await user.type(dialog.getByLabelText("Reason"),"Synthetic protected reason");
 await user.click(dialog.getByRole("button",{name:"Create approval preview",hidden:true}));
 return user;
}
beforeEach(()=>{Object.defineProperty(crypto,"subtle",{configurable:true,value:webcrypto.subtle});});
afterEach(()=>{sessionStorage.clear();vi.restoreAllMocks();});

it("creates the exact finite canonical preview and opens the existing approval workflow only after readback",async()=>{
 const {adapter,commands}=harness();renderRoute("/automations",adapter);await draft();
 await waitFor(()=>expect(commands).toHaveLength(1));
 await waitFor(()=>expect(screen.queryByText("Exact request verification failed. Further proposals remain held.")).not.toBeInTheDocument());
 const link=await screen.findByRole("link",{name:"Open exact approval preview"});expect(link).toHaveAttribute("href","/approvals/synthetic-approval");
 expect(commands).toHaveLength(1);expect(commands[0]).toMatchObject({operation:"previewAction",actionKind:"previewOperationsControl",payload:{kind:"task",targetRef:target.targetRef,reason:"Synthetic protected reason",itemRefs:["synthetic-item"]}});
 expect(commands.some(c=>c.operation==="requestApproval"||c.actionKind==="proposeOperationsReview")).toBe(false);
 expect(Object.keys(sessionStorage).filter(k=>k.startsWith("operations-control-pending:"))).toHaveLength(0);
});
it("retains the original key after a lost acknowledgement and recovers without a second submit",async()=>{
 const {adapter,commands}=harness({lost:true});renderRoute("/automations",adapter);const user=await draft();
 const reconcile=await screen.findByRole("button",{name:"Reconcile exact request"});
 const stored=JSON.stringify(Object.entries(sessionStorage));expect(stored).toContain(commands[0]!.idempotencyKey);expect(stored).not.toContain("Synthetic protected reason");
 await user.click(reconcile);await screen.findByRole("link",{name:"Open exact approval preview"});expect(commands).toHaveLength(1);
});
it("keeps a recorded application intent held when canonical preview readback is still pending",async()=>{
 const {adapter,commands}=harness({lost:true,pending:true});renderRoute("/automations",adapter);const user=await draft();
 await user.click(await screen.findByRole("button",{name:"Reconcile exact request"}));
 await screen.findByText(/Application intent recorded; canonical preview is not yet verified/);
 expect(screen.queryByRole("link",{name:"Open exact approval preview"})).not.toBeInTheDocument();expect(commands).toHaveLength(1);
 expect(JSON.stringify(Object.entries(sessionStorage))).toContain(commands[0]!.idempotencyKey);
});
it("binds Assigned to me to the named source person and preserves the filter in the URL",async()=>{
 const {adapter,filters}=harness();const router=renderRoute("/automations",adapter);const user=userEvent.setup();
 const mine=await screen.findByRole("button",{name:"Assigned to me"});await waitFor(()=>expect(mine).not.toHaveAttribute("aria-disabled","true"));await user.click(mine);
 await screen.findByText("Assigned synthetic run");expect(router.state.location.search).toContain("controlMine=true");expect(filters).toContainEqual({section:"runs",mine:true});
 expect(screen.getByRole("button",{name:"Assigned to me"})).toHaveAttribute("aria-pressed","true");
 await user.click(screen.getByRole("button",{name:"Clear history filters"}));await waitFor(()=>expect(router.state.location.search).not.toContain("controlMine"));
});
it("does not expose legacy local proposals as actionable canonical tasks",async()=>{
 const {adapter}=harness({legacyOnly:true,named:false});renderRoute("/automations",adapter);
 await screen.findByText("No finite authorized proposal is available for this scope. Resolve source access or the owned evidence gap before requesting work.");
 expect(screen.getByRole("button",{name:"Assigned to me"})).toHaveAttribute("aria-disabled","true");expect(screen.queryByRole("button",{name:"Draft Synthetic finite task"})).not.toBeInTheDocument();
});
it("clears protected source evidence when the named authority lease expires while idle",async()=>{
 const {adapter}=harness({leaseMs:150});const client=testClient();renderRoute("/automations",adapter,client);
 await screen.findByText("Protected source record");
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,200));});
 await screen.findByText(/Source authority expired/);expect(screen.queryByText("Protected source record")).not.toBeInTheDocument();
 expect(JSON.stringify(client.getQueryCache().getAll().map(q=>q.state.data))).not.toContain("Synthetic source proof");client.clear();
});
