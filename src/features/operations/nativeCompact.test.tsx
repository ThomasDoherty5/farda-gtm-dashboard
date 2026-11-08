import userEvent from "@testing-library/user-event";
import { cleanup, screen } from "@testing-library/react";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
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
  function SourceBody() { useRegisterOperationsCohort({ ...scope, home: "all", basis: "requestedAt" }); return null; }
  function Probe() {
    const [mounted, setMounted] = useState(true);
    const { cohort } = useOperationsCohort();
    return <>{mounted && <SourceBody />}<p>{cohort ? `Registered ${cohort.startAt}` : "No registered source cohort"}</p><button onClick={() => setMounted(false)}>Withdraw source body</button></>;
  }
  renderWithAdapter(<OperationsCohortProvider><Probe /></OperationsCohortProvider>, source().adapter);
  expect(await screen.findByText(`Registered ${scope.startAt}`)).toBeVisible();
  await userEvent.setup().click(screen.getByRole("button", { name: "Withdraw source body" }));
  expect(await screen.findByText("No registered source cohort")).toBeVisible();
});
