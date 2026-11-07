import { screen } from "@testing-library/react";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { nativeContentSchema } from "@/creator-agent/monitor/contract";
import { renderRoute } from "@/test/renderWithAdapter";

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
