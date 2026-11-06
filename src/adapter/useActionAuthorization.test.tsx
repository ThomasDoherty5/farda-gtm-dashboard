import {act,screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {it,expect} from "vitest";
import {scriptedAdapter,renderWithAdapter} from "@/test/renderWithAdapter";
import {respondWith} from "./demoViews";
import {AdapterError} from "./errors";
import {useAction} from "./useAction";
import {useView} from "./useView";
import {usePagedView} from "./usePagedView";

it("a forbidden action clears the open private draft and prevents an earlier paged read from repopulating it",async()=>{
  let release:(()=>void)|undefined;
  const adapter=scriptedAdapter(async req=>{
    if(req.viewKey==="delayed")await new Promise<void>(resolve=>{release=resolve;});
    return respondWith(req,"protected source",{dataVersion:"synthetic-v1"});
  });
  adapter.submitAction=async req=>{throw new AdapterError({code:"FORBIDDEN",message:"Access denied",requestId:req.requestId,correlationId:null,retryable:false,retryAfterMs:null,executionCertainty:"notApplied"});};
  function Surface(){
    const source=useView<object,string>("source",{}),late=usePagedView<object,string>("delayed",{}),action=useAction<object>();
    return <><p>{source.data?.data && "Private proposal draft"}</p><p>{late.data?.pages[0]?.data}</p><p>{action.error?.message}</p>
      <button onClick={()=>action.mutate({operation:"requestApproval",actionKind:"proposeCollaborationReview",expectedVersion:"synthetic-v1",entityRefs:[],approvalRef:null,manifestRef:null,payload:{}})}>Propose</button></>;
  }
  const {client}=renderWithAdapter(<Surface/>,adapter);
  await screen.findByText("Private proposal draft");await waitFor(()=>expect(release).toBeTypeOf("function"));
  await userEvent.setup().click(screen.getByRole("button",{name:"Propose"}));await screen.findByText("Access denied");
  expect(screen.queryByText("Private proposal draft")).not.toBeInTheDocument();
  await act(async()=>release!());
  expect(screen.queryByText("protected source")).not.toBeInTheDocument();
  expect(JSON.stringify(client.getQueryCache().getAll().map(q=>q.state.data))).not.toContain("protected source");
});
