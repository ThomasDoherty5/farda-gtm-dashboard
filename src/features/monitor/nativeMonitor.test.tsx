import { act,screen,within,waitFor } from "@testing-library/react";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import userEvent from "@testing-library/user-event";
import { nativeContentSchema,nativeWatchlistSchema } from "@/creator-agent/monitor/contract";
import { renderRoute,testClient } from "@/test/renderWithAdapter";

describe("native monitoring metric basis",()=>{
  it.each(["interval","cumulative"] as const)("labels %s observations with their exact source window",async semantics=>{
    const data=nativeContentSchema.parse({kind:"saved-content-monitor",observedAt:"2026-11-06T10:00:00Z",sourceState:"current",
      sourceAsOf:"2026-11-06T09:59:00Z",sourceVersion:"source-synthetic",latestRunRef:null,membershipComplete:true,
      posts:[],total:0,views:100,rate:1,orders:null,net:null,window:"last-30",
      metricBasis:{definition:"Source view counter",window:"Previous 24 hours",semantics,context:"organic"}});
    const adapter=createLiveAdapter("sandbox",{transport:{async send(request){
      if(request.kind!=="read" || request.envelope.viewKey!=="contentMonitor")throw new Error("Unexpected operation");
      return respondWith(request.envelope,data,{dataVersion:"synthetic-basis-v1"});
    }}});
    renderRoute("/content",adapter);
    expect(await screen.findByText("Observed views",{exact:true})).toBeInTheDocument();
    expect(screen.getByText(`Source view counter · ${semantics} · Previous 24 hours · organic`)).toBeInTheDocument();
    expect(screen.queryByText("Cumulative views",{exact:true})).not.toBeInTheDocument();
  });
});

describe("native watchlist review controls",()=>{
  const originalShow=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,"showModal"),originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,"close");
  beforeAll(()=>{
    Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute("open","");}});
    Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute("open");}});
  });
  afterAll(()=>{
    if(originalShow)Object.defineProperty(HTMLDialogElement.prototype,"showModal",originalShow);else Reflect.deleteProperty(HTMLDialogElement.prototype,"showModal");
    if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,"close",originalClose);else Reflect.deleteProperty(HTMLDialogElement.prototype,"close");
  });
  const at="2026-11-06T10:00:00Z";
  const fixture=()=>nativeWatchlistSchema.parse({kind:"saved-monitor-watchlist",observedAt:at,sourceState:"current",sourceAsOf:at,sourceVersion:"source-v1",latestRunRef:null,membershipComplete:true,
    total:1,active:0,pending:1,pendingReviewTotal:1,excluded:0,unverified:0,profiles:[{creator:"creator-a",network:"instagram",account:"account-a",profile:"profile-a",handle:"synthetic.creator",state:"identity-review",
      source:"social-cat",cohort:null,notionReceipt:"receipt-notion",sheetsReceipt:"receipt-sheet",lastCheck:at,reason:"Identity review required.",
      review:{state:"current",observedAt:at,receipt:"receipt-review",historyComplete:true,history:[{id:"event-a",at,kind:"identity",decision:"quarantined",receipt:"receipt-original",identityEvidence:["identity-proof"],decisionReceipt:"receipt-decision"}],
        candidates:[{creatorId:"creator-a",network:"instagram",account:"account-a",profileId:"profile-a",receipt:"receipt-candidate"}],exclusion:null},
      messages:[{id:"message-event",network:"instagram",account:"account-a",profile:"profile-a",at,receipt:"receipt-message",kind:"reply",interpretation:"observed",
        detail:{state:"current",observedAt:at,conversationId:"conversation-a",messageId:"message-a",sourceVersion:"version-a",currentStatus:"draft",proposedStatus:"ready",expectedVersion:"expected-a"}}]}]});
  it("navigates the pending set and closes exact history before identity review",async()=>{
    const data=fixture(),user=userEvent.setup(),adapter=createLiveAdapter("sandbox",{transport:{async send(request){
      if(request.kind!=="read")throw new Error("No writes permitted");return respondWith(request.envelope,data,{dataVersion:"review-v1"});
    }}}),router=renderRoute("/creators/watchlist",adapter);
    await user.click(await screen.findByRole("button",{name:"Review 1 matches"}));await waitFor(()=>expect(router.state.location.search).toContain("state=identity-review"));
    const history=await screen.findByRole("button",{name:"Open intake history"});await user.click(history);
    const dialog=screen.getByRole("dialog",{name:"Intake history"});expect(within(dialog).getByText("receipt-original · receipt-decision")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button",{name:"Return to watchlist"}));expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Match the correct profile"}));expect(screen.getByRole("table",{name:"Competing identity evidence"})).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:/merge|enroll/i})).not.toBeInTheDocument();
  });
  it("replaces open exact message context with a denied state after source revalidation",async()=>{
    let data=fixture();const user=userEvent.setup(),client=testClient(),adapter=createLiveAdapter("sandbox",{transport:{async send(request){
      if(request.kind!=="read")throw new Error("No writes permitted");return respondWith(request.envelope,data,{dataVersion:data.sourceVersion!});
    }}});renderRoute("/creators/watchlist",adapter,client);
    await user.click(await screen.findByRole("button",{name:/Review new message ·/}));expect(within(screen.getByRole("dialog")).getByText("conversation-a")).toBeInTheDocument();
    data=structuredClone(data);data.sourceVersion="source-v2";
    data.profiles[0]!.messages![0]!.detail={state:"denied",observedAt:null,conversationId:null,messageId:null,sourceVersion:null,currentStatus:null,proposedStatus:null,expectedVersion:null};
    await act(async()=>{await client.invalidateQueries();});
    await waitFor(()=>expect(screen.queryByText("conversation-a")).not.toBeInTheDocument());expect(screen.getByText(/Message context denied/)).toBeInTheDocument();
  });
});
