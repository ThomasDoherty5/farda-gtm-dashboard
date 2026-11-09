import userEvent from "@testing-library/user-event";
import { act, cleanup, screen } from "@testing-library/react";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { TransportFailure } from "@/adapter/transport";
import { operationsRecord } from "@/creator-agent/operationsReads/fixtures.testkit";
import { useState } from "react";
import { OperationsCohortProvider, useOperationsCohort, useRegisterOperationsCohort } from "./OperationsCohortContext";
import { renderRoute, renderWithAdapter } from "@/test/renderWithAdapter";

const state = vi.hoisted(() => ({ layout: "mobile" as "mobile" | "tablet" }));
vi.mock("./useLayout", () => ({ useLayout: () => state.layout }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
const scope = { home: "all", startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-07T00:00:00Z", timezone: "UTC", basis: "requestedAt" };
function source(partial = false) {
  const reads: { viewKey: string; filters: unknown }[] = [];
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") throw new Error("Read-only compact journey");
    const view = request.envelope.viewKey === "operationsShipping" ? "operationsShipping" : "operationsOverview";
    reads.push({ viewKey: view, filters: request.envelope.filters });
    const data = operationsRecord(view);
    if (view === "operationsShipping") data.shipments = [
      { ref: "sample-shipment", orderRef: null, sampleRef: "sample-origin", home: "H1", requestedAt: "2026-11-02T00:00:00Z", eventAt: null, carrierState: "labelCreated", lastScan: null, shipmentDetail: { kind: "hub", shipmentRef: "sample-shipment" }, originDetail: { kind: "sample", ref: "sample-origin" } },
      { ref: "lost-shipment", orderRef: "source-order", sampleRef: null, home: "H1", requestedAt: "2026-11-02T00:00:00Z", eventAt: "2026-11-05T00:00:00Z", carrierState: "lost", lastScan: null, shipmentDetail: { kind: "exception", shipmentRef: "lost-shipment", exceptionRef: "lost-event" }, originDetail: { kind: "order", ref: "source-order" } },
    ];
    data.reportingScope = scope;
    data.provenance = { ...(data.provenance as object), validUntil: "2099-01-01T00:00:00Z", version: "compact-v1" };
    if (partial && view === "operationsOverview") data.queue = { rows: [], total: 0 };
    const response = respondWith(request.envelope, data, { dataVersion: "compact-v1", dataState: partial ? "partial" : "ready" });
    response.coverage.complete = !partial;
    return response;
  } } });
  return { adapter, reads };
}
it.each(["mobile", "tablet"] as const)("renders shipping on %s and carries the source-default cohort into navigation and reads", async layout => {
  state.layout = layout;
  const { adapter, reads } = source();
  renderRoute("/operations?view=shipping", adapter);
  expect(await screen.findByTestId("shipments-table")).toBeVisible();
  expect(screen.queryByTestId("queue-panel")).not.toBeInTheDocument();
  expect(reads).toContainEqual({ viewKey: "operationsShipping", filters: { home: scope.home, startAt: scope.startAt, endAt: scope.endAt, timezone: scope.timezone } });
  expect(screen.queryByRole("link", { name: "Home H1" })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Menu" }));
  const home = new URL(screen.getByRole("link", { name: "Home H1" }).getAttribute("href")!, "https://example.test");
  expect(home.searchParams.get("home")).toBe("H1");
  expect(home.searchParams.get("startAt")).toBe(scope.startAt);
  expect(home.searchParams.get("view")).toBe("shipping");
  const health = new URL(screen.getByRole("link", { name: "Issues and fulfillment health" }).getAttribute("href")!, "https://example.test");
  expect(health.searchParams.get("view")).toBe("health");
  expect(health.searchParams.get("home")).toBe("all");
  expect(health.searchParams.get("endAt")).toBe(scope.endAt);
  await userEvent.setup().click(screen.getByRole("button", { name: "Close menu" }));
  const shipment = new URL(screen.getByRole("link", { name: "sample-shipment" }).getAttribute("href")!, "https://example.test");
  expect(shipment.pathname).toBe("/operations");
  expect(shipment.searchParams.get("view")).toBe("hub");
  expect(shipment.searchParams.get("ship-query")).toBe("sample-shipment");
  expect(shipment.searchParams.get("startAt")).toBe(scope.startAt);
  expect(screen.getByRole("link", { name: "Sample sample-origin" })).toHaveAttribute("href", expect.stringContaining("/orders/sample-origin?"));
  expect(screen.getByRole("link", { name: "lost-shipment" })).toHaveAttribute("href", expect.stringContaining("/shipments/lost-shipment/exceptions/lost-event?"));
  const shipmentRows = screen.getByTestId("shipments-table").querySelectorAll("tbody tr");
  expect(shipmentRows[0]).toHaveTextContent("lost-shipment");
  expect(shipmentRows[1]).toHaveTextContent("sample-shipment");
});
it.each(["mobile", "tablet"] as const)("does not claim a known empty queue from partial %s evidence", async layout => {
  state.layout = layout;
  const { adapter } = source(true);
  renderRoute("/operations", adapter);
  expect(await screen.findByText("Dispatch evidence is incomplete. It is unknown whether more orders or samples are waiting.")).toBeVisible();
  expect(screen.queryByText(/Nothing is waiting/)).not.toBeInTheDocument();
  expect(screen.queryByText("No eligible dispatch rows were returned for this home.")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Menu" }));
  expect(screen.getByRole("link", { name: "Review shipping" })).toHaveAttribute("href", expect.stringContaining("view=shipping"));
});


it("clears registered menu context when the protected source body unmounts", async () => {
  function SourceBody({home}:{home:"all"|"H1"}) { useRegisterOperationsCohort({ ...scope, home, basis: "requestedAt" }); return null; }
  function Probe() {
    const [mounted, setMounted] = useState(true);
    const [home,setHome]=useState<"all"|"H1">("all");
    const [renders,setRenders]=useState(0);
    const { cohort } = useOperationsCohort();
    return <>{mounted && <SourceBody home={home} />}<p>{cohort ? `Registered ${cohort.home} ${cohort.startAt}` : "No registered source cohort"}</p><p>Parent renders {renders}</p><button onClick={()=>setRenders(n=>n+1)}>Render equivalent cohort</button><button onClick={()=>setHome("H1")}>Change source home</button><button onClick={() => setMounted(false)}>Withdraw source body</button></>;
  }
  renderWithAdapter(<OperationsCohortProvider><Probe /></OperationsCohortProvider>, source().adapter);
  expect(await screen.findByText(`Registered all ${scope.startAt}`)).toBeVisible();
  await userEvent.setup().click(screen.getByRole("button",{name:"Render equivalent cohort"}));
  expect(screen.getByText("Parent renders 1")).toBeVisible();
  expect(screen.getByText(`Registered all ${scope.startAt}`)).toBeVisible();
  await userEvent.setup().click(screen.getByRole("button",{name:"Change source home"}));
  expect(await screen.findByText(`Registered H1 ${scope.startAt}`)).toBeVisible();
  await userEvent.setup().click(screen.getByRole("button", { name: "Withdraw source body" }));
  expect(await screen.findByText("No registered source cohort")).toBeVisible();
});

type ShippingState="pending"|"empty"|"partial"|"stale"|"error"|"ready";
function shippingSource(initial:ShippingState) {
  let current=initial,resolvePending:()=>void=()=>undefined;
  const reads:{viewKey:string;filters:unknown}[]=[];
  const adapter=createLiveAdapter("sandbox",{transport:{async send(request){
    if(request.kind!=="read")throw new Error("No effects in shipping state fixtures");
    const view=request.envelope.viewKey==="operationsShipping"?"operationsShipping":"operationsOverview";
    reads.push({viewKey:view,filters:request.envelope.filters});
    if(view==="operationsShipping"&&current==="pending")await new Promise<void>(resolve=>{resolvePending=resolve;});
    if(view==="operationsShipping"&&current==="error")throw new TransportFailure("http",{status:503,body:{code:"SOURCE_UNAVAILABLE",message:"Fictional shipping source unavailable",requestId:request.envelope.requestId,correlationId:null,retryable:false,retryAfterMs:null,executionCertainty:"notApplied"}});
    const status=view==="operationsOverview"?"ready":current;
    const data=operationsRecord(view);
    data.reportingScope=scope;
    data.provenance={...(data.provenance as object),validUntil:"2099-01-01T00:00:00Z",version:"state-v1"};
    const dataState=status==="empty"||status==="partial"||status==="stale"?status:"ready";
    const response=respondWith(request.envelope,dataState==="ready"?data:null,{dataVersion:"state-v1",dataState});
    response.coverage=dataState==="empty"?{expectedCount:0,observedCount:0,missingCount:0,complete:true,reasonCodes:[]}:
      dataState==="ready"?{expectedCount:1,observedCount:1,missingCount:0,complete:true,reasonCodes:[]}:
      {expectedCount:null,observedCount:null,missingCount:null,complete:false,reasonCodes:[dataState==="stale"?"SOURCE_STALE":"SOURCE_COVERAGE_PARTIAL"]};
    return response;
  }}});
  return {adapter,reads,ready:()=>{current="ready";resolvePending();}};
}
it.each(["mobile","tablet"] as const)("announces pending shipping evidence on %s instead of an empty screen",async layout=>{
  state.layout=layout;
  const w=shippingSource("pending");renderRoute("/operations?view=shipping",w.adapter);
  expect(await screen.findByText("Loading shipping evidence…")).toBeInTheDocument();
  expect(screen.queryByRole("heading",{name:"No shipping data yet"})).not.toBeInTheDocument();
  expect(screen.queryByTestId("shipments-table")).not.toBeInTheDocument();
  await act(async()=>{w.ready();});
  expect(await screen.findByTestId("shipments-table")).toBeVisible();
});
it.each(["empty","partial","stale"] as const)("distinguishes a %s null shipping result and refreshes its original cohort",async initial=>{
  state.layout="mobile";
  const w=shippingSource(initial);renderRoute("/operations?view=shipping",w.adapter);
  const empty=initial==="empty";
  expect(await screen.findByRole("heading",{name:empty?"No shipping data yet":"Shipping evidence unavailable"})).toBeVisible();
  if(!empty){
    expect(screen.getByText("Incomplete or stale source evidence cannot establish that no shipments exist.")).toBeVisible();
    expect(screen.queryByRole("heading",{name:"No shipping data yet"})).not.toBeInTheDocument();
  }
  expect(screen.queryByTestId("shipments-table")).not.toBeInTheDocument();
  w.ready();await userEvent.setup().click(screen.getByRole("button",{name:"Refresh shipping evidence"}));
  expect(await screen.findByTestId("shipments-table")).toBeVisible();
  expect(w.reads.filter(read=>read.viewKey==="operationsShipping").map(read=>read.filters)).toEqual([scopeFilters(),scopeFilters()]);
});
it("retries a shipping error through the same source-bound compact view",async()=>{
  state.layout="tablet";
  const w=shippingSource("error");renderRoute("/operations?view=shipping",w.adapter);
  expect(await screen.findByRole("heading",{name:"Data unavailable"})).toBeVisible();
  expect(screen.queryByTestId("shipments-table")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading",{name:"No shipping data yet"})).not.toBeInTheDocument();
  w.ready();await userEvent.setup().click(screen.getByRole("button",{name:"Try again"}));
  expect(await screen.findByTestId("shipments-table")).toBeVisible();
  expect(w.reads.filter(read=>read.viewKey==="operationsShipping").map(read=>read.filters)).toEqual([scopeFilters(),scopeFilters()]);
});
function scopeFilters(){return {home:scope.home,startAt:scope.startAt,endAt:scope.endAt,timezone:scope.timezone};}

it("keeps the source-bound period editor in the workspace menu and restores its outer trigger", async () => {
  state.layout = "mobile";
  const { adapter } = source();
  renderRoute("/operations", adapter);
  await screen.findByTestId("metric-To ship");
  expect(screen.queryByRole("button", { name: "Reporting period" })).not.toBeInTheDocument();
  const user = userEvent.setup(), menu = screen.getByRole("button", { name: "Menu" });
  await user.click(menu);
  await user.click(screen.getByRole("button", { name: "Reporting period" }));
  expect(screen.getByRole("dialog", { name: "Reporting period" })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Explore the Farda workspace." })).not.toBeInTheDocument();
  expect((screen.getByLabelText("Start (UTC)") as HTMLInputElement).value).toMatch(/^2026-11-01T00:00/);
  await user.click(screen.getByRole("button", { name: "Cancel period change" }));
  expect(menu).toHaveFocus();
});


it("distinguishes independently reported source totals from a partial visible queue", async () => {
  state.layout = "mobile";
  const h = source(true);
  renderRoute("/operations", h.adapter);
  const notice = await screen.findByTestId("view-partial");
  expect(notice).toHaveTextContent("The visible queue is incomplete");
  expect(notice).toHaveTextContent("Independently reported source totals can exceed these returned rows");
  expect(notice).not.toHaveTextContent("Totals below cover only what was read");
});
