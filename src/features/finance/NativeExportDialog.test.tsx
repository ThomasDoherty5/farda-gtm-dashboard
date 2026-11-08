import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { SCHEMA_VERSION } from "@/adapter/contract";
import { TransportFailure } from "@/adapter/transport";
import { renderWithAdapter } from "@/test/renderWithAdapter";
import { settlementSourceFixture } from "@/creator-agent/settlements/fixtures.testkit";
import type { NativeCommissionLedger } from "@/creator-agent/settlements/contract";
import type { ExportReceipt } from "@/creator-agent/actions/contract";
import { NativeExportDialog } from "./NativeExportDialog";

beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};});
afterEach(()=>{cleanup();sessionStorage.clear();});
function setup(denyArtifact=false){
  const fixture=settlementSourceFixture({workspaceId:"w",accountId:"a",environment:"sandbox"}),filters={state:"all" as const,startAt:"2026-11-01T00:00:00Z",endAt:"2026-11-08T00:00:00Z",timezone:"UTC",currency:"USD" as const};
  const marker={requestKey:"original-export",expectedVersion:"original-v1",payload:{format:"csv" as const,filters}};
  sessionStorage.setItem(JSON.stringify(["native-ledger-export-v1","farda","tester","sandbox","w","a"]),JSON.stringify(marker));
  const data:NativeCommissionLedger={kind:"native-commission-ledger",version:"current-ledger-v2",source:{state:"current",observedAt:"2026-11-07T12:00:00Z",sourceUpdatedAt:null,validUntil:"2099-01-01T00:00:00Z",revision:"v2",reasonCodes:[],synthetic:true},
    accountingPolicy:{state:"unknown",reference:null},capabilities:{export:true,match:false,pay:false},currency:"USD",records:[],coverage:{returned:0,total:0,complete:true},stateTotals:null,economics:null,
    totals:{eligible:fixture.money(0),accrued:fixture.money(0),creatorPaid:fixture.money(0),contribution:fixture.unknown},export:{sourceVersion:"new-v2",filters}};
  const receipt:ExportReceipt={kind:"ledger-export",artifactRef:"original-artifact",runRef:"original-job",requestKey:marker.requestKey,principalRef:"tester",payloadDigest:"a".repeat(64),sourceVersion:"original-v1",rowCount:110,byteLength:30,sha256:"b".repeat(64),createdAt:"2026-11-07T12:00:00Z",expiresAt:"2099-01-01T00:00:00Z",asOf:"2026-11-07T12:00:00Z",contentType:"text/csv;charset=utf-8",confersRelease:false};
  const reads:{viewKey:string;filters:unknown}[]=[],writes:unknown[]=[];
  const adapter=createLiveAdapter("sandbox",{transport:{async send(request){
    if(request.kind!=="read"){writes.push(request);throw Error("Recovery must never generate another export");}
    reads.push({viewKey:request.envelope.viewKey,filters:request.envelope.filters});
    if(request.envelope.viewKey==="ledgerExportRequest")return respondWith(request.envelope,{kind:"native-ledger-export-request",requestKey:marker.requestKey,state:"succeeded",receipt,progress:{processedRows:110,totalRows:110},reasonCodes:[]},{dataVersion:"original-export-v1"});
    if(denyArtifact)throw new TransportFailure("http",{status:403,body:{code:"FORBIDDEN",executionCertainty:"notApplied"}});
    return {...respondWith(request.envelope,{kind:"native-ledger-export-artifact",receipt,body:"record,amount\r\nfictional,100\r\n"},{dataVersion:"original-artifact-v1"}),coverage:{expectedCount:110,observedCount:110,missingCount:0,complete:true,reasonCodes:[]}};
  }}});
  const response=respondWith({schemaVersion:SCHEMA_VERSION,operation:"readView",requestId:"current-ledger",requestedScope:{workspaceId:"w",accountIds:["a"],environment:"sandbox"},viewKey:"commissionLedger",filters:{},period:null,sort:[],page:{cursor:null,limit:50}},data,{dataVersion:"current-ledger-v2"});
  renderWithAdapter(<NativeExportDialog open data={data} response={response} onClose={()=>{}} />,adapter);
  return {reads,writes,marker};
}
it("retrieves an already-created original artifact after the current ledger revision changes, without re-exporting",async()=>{
  const w=setup(),user=userEvent.setup();const retrieve=await screen.findByRole("button",{name:"Retrieve authorized CSV"});expect(retrieve).not.toHaveAttribute("aria-disabled","true");
  await user.click(retrieve);await screen.findByText("Whole-snapshot CSV verified by the source service.");
  expect(screen.getByRole("button",{name:"Download CSV"})).not.toHaveAttribute("aria-disabled","true");
  expect(w.reads).toEqual([{viewKey:"ledgerExportRequest",filters:w.marker},{viewKey:"ledgerExportArtifact",filters:{artifactRef:"original-artifact"}}]);expect(w.writes).toHaveLength(0);
});
it("still requires fresh artifact authorization and never enables a denied download",async()=>{
  const w=setup(true),user=userEvent.setup();await user.click(await screen.findByRole("button",{name:"Retrieve authorized CSV"}));
  await screen.findByText(/Original request(?: is unavailable|: unknown)/);
  expect(screen.queryByRole("button",{name:"Download CSV"})).not.toBeInTheDocument();
  expect(screen.queryByText("Whole-snapshot CSV verified by the source service.")).not.toBeInTheDocument();
  expect(w.reads.some(read=>read.viewKey==="ledgerExportArtifact")).toBe(true);expect(w.writes).toHaveLength(0);
});
