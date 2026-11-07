import {act,screen,waitFor,within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {createDemoAdapter} from "@/adapter/demoAdapter";
import type {FardaAdapter} from "@/adapter/adapter";
import {AdapterError} from "@/adapter/errors";
import {dropProtectedData} from "@/adapter/useView";
import {scopeKey} from "@/adapter/scope";
import {nativeOperationsControlSchema} from "@/creator-agent/operationsControlsSchema";
import {renderRoute,scopeFor,testClient} from "@/test/renderWithAdapter";
import "./AutomationsPage";
const native=():FardaAdapter=>{
 const demo=createDemoAdapter();
 return {...demo,kind:"live",readView:(async request=>{
  const response=await demo.readView(request);
  if(request.viewKey!=="operationsControl")return response;
  const data=nativeOperationsControlSchema.parse(response.data);
  return {...response,data:{...data,actorRef:"agent-reviewer",role:"reviewer",sourceState:"current",sourceObservedAt:data.observedAt,
   actions:[{kind:"task",targetRef:"synthetic-target",title:"Synthetic bounded task",details:[["Scope","Synthetic finite item"]],allowed:true,reasonCodes:[]}]}};
 }) as FardaAdapter["readView"]};
};
afterEach(()=>{sessionStorage.clear();vi.restoreAllMocks();});
it("scrubs all legacy control marker namespaces even when the current source read is denied",async()=>{
 const first="operations-control-pending:other-account:team",second="operations-control-pending:other-section:reports";
 const marker={key:"10000000-0000-4000-8000-000000000001",base:"oc1-"+"a".repeat(64),hash:"b".repeat(64),actor:"agent-reviewer",section:"runs",payload:{kind:"task",targetRef:"opaque-legacy-target",reason:"Synthetic protected legacy reason"},id:null,digest:null};
 sessionStorage.setItem(first,JSON.stringify(marker));sessionStorage.setItem(second,JSON.stringify({...marker,key:"10000000-0000-4000-8000-000000000002"}));
 const adapter=native();adapter.readView=async request=>{throw new AdapterError({code:"FORBIDDEN",message:"Synthetic denied source",requestId:request.requestId,correlationId:null,retryable:false,retryAfterMs:null});};
 renderRoute("/automations",adapter);expect((await screen.findAllByRole("alert")).some(node=>node.textContent?.includes("No access to this account"))).toBe(true);
 await waitFor(()=>expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("Synthetic protected legacy reason"));
 for(const key of [first,second]){const saved=JSON.parse(sessionStorage.getItem(key)!);expect(saved).toMatchObject({hash:marker.hash,kind:"task",targetRef:"opaque-legacy-target"});expect(saved).not.toHaveProperty("payload");}
});
it("does not restore or submit a protected reason after denial and same-version re-entry while its hash is pending",async()=>{
 const adapter=native(),submit=vi.spyOn(adapter,"submitAction"),client=testClient(),root=scopeKey({principal:"tester",scope:scopeFor("demo")});
 let resolveDigest:(v:ArrayBuffer)=>void=()=>{};const digest=vi.fn(()=>new Promise<ArrayBuffer>(r=>resolveDigest=r));
 const original=Object.getOwnPropertyDescriptor(crypto,"subtle");Object.defineProperty(crypto,"subtle",{configurable:true,value:{digest}});
 try{
  renderRoute("/automations",adapter,client);const user=userEvent.setup();
  await waitFor(()=>expect(screen.getAllByRole("button",{name:"Request task"})[0]).not.toHaveAttribute("aria-disabled","true"));
  await user.click(screen.getAllByRole("button",{name:"Request task"})[0]!);
  const chooser=within(screen.getAllByRole("dialog",{hidden:true}).find(d=>within(d).queryByRole("heading",{name:"Choose a registered task",hidden:true}))!);
  await user.click(chooser.getByRole("button",{name:"Draft Synthetic bounded task",hidden:true}));
  const form=within(screen.getAllByRole("dialog",{hidden:true}).find(d=>within(d).queryByRole("heading",{name:"Request task",hidden:true}))!);
  await user.type(form.getByLabelText("Reason"),"Synthetic protected in-flight reason");await user.click(form.getByRole("button",{name:"Save proposal for review",hidden:true}));await waitFor(()=>expect(digest).toHaveBeenCalledTimes(1));
  const prior=client.getQueriesData({queryKey:root}).find(([key])=>key.includes("operationsControl"))!;expect(prior[1]).toBeTruthy();
  await act(async()=>{dropProtectedData(client,root);client.setQueryData(prior[0],prior[1]);resolveDigest(new Uint8Array(32).buffer);});
  await waitFor(()=>expect(form.getByText(/Source access changed while preparing/)).toBeInTheDocument());
  expect(submit).not.toHaveBeenCalled();expect(JSON.stringify(client.getQueryCache().getAll().map(q=>q.state.data))).not.toContain("Synthetic protected in-flight reason");expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("Synthetic protected in-flight reason");
 }finally{if(original)Object.defineProperty(crypto,"subtle",original);else Reflect.deleteProperty(crypto,"subtle");client.clear();}
});
