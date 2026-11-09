import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { operationsRecord, syntheticCustomer, syntheticAuditReason } from "@/creator-agent/operationsReads/fixtures.testkit";
import { renderRoute } from "@/test/renderWithAdapter";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

afterEach(cleanup);
it("withholds customer values and prior rationale even if a native read incorrectly supplies them", async () => {
  const writes: unknown[] = [];
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") { writes.push(request); throw new Error("A read must not disclose customer data"); }
    const view = request.envelope.viewKey === "orderCustomer" ? "orderCustomer" : "orderDetail";
    const data = operationsRecord(view);
    data.provenance = { ...(data.provenance as object), validUntil: "2099-01-01T00:00:00Z", version: "native-v1" };
    return respondWith(request.envelope, data, { dataVersion: "native-v1", capabilities: [{ actionKind: "revealCustomerDetails", state: "available", reasonCodes: [] }] });
  } } });
  const user = userEvent.setup();
  renderRoute("/orders/TEST-SH-1042", adapter);
  await user.click(await screen.findByRole("button", { name: "Customer details (restricted)" }));
  const dialog = screen.getByRole("dialog", { name: "Customer details" });
  expect(within(dialog).getByTestId("customer-denied")).toHaveTextContent("purpose-bound");
  expect(screen.queryByText(syntheticCustomer.email)).not.toBeInTheDocument();
  expect(screen.queryByText(syntheticAuditReason)).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "Reveal customer details" })).not.toBeInTheDocument();
  expect(writes).toHaveLength(0);
});

it("preserves native analytics scope and labels partial daily totals as observed evidence", async () => {
  const reads: { viewKey: string; filters: unknown }[] = [];
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") throw new Error("No native effect");
    reads.push({ viewKey: request.envelope.viewKey, filters: request.envelope.filters });
    const data = operationsRecord("fulfillmentAnalytics");
    data.provenance = { ...(data.provenance as object), validUntil: "2099-01-01T00:00:00Z", version: "native-v1" };
    return respondWith(request.envelope, data, { dataVersion: "native-v1", dataState: "partial" });
  } } });
  const filters = { home: "H1", startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-07T00:00:00Z", timezone: "UTC" };
  renderRoute(`/analytics/fulfillment?${new URLSearchParams(filters)}`, adapter);
  expect(await screen.findByText("Observed shipped orders")).toBeVisible();
  expect(screen.getByText("Observed daily rows only · full-period total unknown")).toBeVisible();
  expect(reads).toContainEqual({ viewKey: "fulfillmentAnalytics", filters: { days: 14, ...filters } });
  const href = screen.getByRole("link", { name: "Review exceptions" }).getAttribute("href")!;
  const target = new URL(href, "https://example.test");
  expect(target.pathname).toBe("/operations");
  expect(target.searchParams.get("view")).toBe("shipping");
  expect(target.searchParams.get("home")).toBe("H1");
  expect(target.searchParams.get("startAt")).toBe(filters.startAt);
  expect(screen.queryByText(/The demo holds/)).not.toBeInTheDocument();
});

it("renders the completed native return chain from independent confirmed events, never legacy free-form receipt text", async () => {
  const data = operationsRecord("returnDetail");
  data.provenance = { ...(data.provenance as object), validUntil: "2099-01-01T00:00:00Z", version: "native-v1" };
  data.state = "resolved";
  data.completionVerified = true;
  data.resolved = { chain: [{ outcome: "Unverified legacy success", receipt: "legacy-unverified-receipt", confirmedAt: "2026-11-06T11:50:00Z" }], refunded: { minorUnits: 4000, currency: "USD" }, returnedUnits: 1, restockedUnits: 0, retainedUnits: 1, replacement: "Not requested", caseRef: "synthetic-case" };
  const kinds = ["returnReceived", "inventoryQuarantined", "refundSettled", "accountingPosted", "caseClosed"];
  data.nativeEvents = kinds.map(kind => ({ kind, state: "confirmed", receiptRef: `verified-${kind}`, sourceRef: `source-${kind}`, eventAt: "2026-11-06T11:50:00Z", observedAt: "2026-11-06T11:55:00Z", reasonCode: null }));
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") throw new Error("No native effect");
    return respondWith(request.envelope, data, { dataVersion: "native-v1" });
  } } });
  renderRoute("/returns/TEST-RET-028", adapter);
  const chain = await screen.findByTestId("return-chain");
  for (const kind of kinds) {
    expect(within(chain).getByText(`verified-${kind}`, { exact: false })).toBeVisible();
    expect(within(chain).getByText(`source-${kind}`, { exact: false })).toBeVisible();
  }
  expect(within(chain).getByText("Inventory quarantined")).toBeVisible();
  expect(screen.queryByText("Unverified legacy success")).not.toBeInTheDocument();
  expect(screen.queryByText("legacy-unverified-receipt")).not.toBeInTheDocument();
});

it("holds native support navigation instead of opening the demo Intercom dialog", async () => {
  const data = operationsRecord("shippingException");
  data.provenance = { ...(data.provenance as object), validUntil: "2099-01-01T00:00:00Z", version: "native-v1" };
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") throw new Error("No native effect");
    return respondWith(request.envelope, data, { dataVersion: "native-v1" });
  } } });
  renderRoute("/shipments/TEST-SP-0093/exceptions/TEST-EVT-129", adapter);
  const support = await screen.findByRole("button", { name: "Open source support case" });
  expect(support).toHaveAttribute("aria-disabled", "true");
  await userEvent.setup().click(support);
  expect(screen.queryByRole("button", { name: "Open case in Intercom" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("binds a native health read to the requested cohort and preserves it on source-order navigation", async () => {
  const filters = { home: "H1", startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-07T00:00:00Z", timezone: "UTC" };
  const reads: unknown[] = [];
  const data = operationsRecord("opsHealth");
  data.provenance = { ...(data.provenance as object), validUntil: "2099-01-01T00:00:00Z", version: "native-v1" };
  data.reportingScope = { ...filters, basis: "eventAt" };
  data.orders = [{ orderRef: "source-order", state: "Lost", reservationRef: "source-reservation", shipmentRef: "source-shipment", home: "H1", unitsOrdered: 1, unitsShipped: 0, note: "Source receipt pending" }];
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") throw new Error("Read-only health");
    reads.push(request.envelope.filters);
    return respondWith(request.envelope, data, { dataVersion: "native-v1" });
  } } });
  renderRoute(`/analytics/fulfillment?view=health&${new URLSearchParams(filters)}`, adapter);
  const link = await screen.findByRole("link", { name: "source-order" });
  expect(reads).toContainEqual(filters);
  const target = new URL(link.getAttribute("href")!, "https://example.test");
  expect(target.pathname).toBe("/orders/source-order");
  for (const [key, value] of Object.entries(filters)) expect(target.searchParams.get(key)).toBe(value);
});

it("keeps each held source action with its visible explanation and preserves horizontal independent refund events", async () => {
  const data = operationsRecord("orderDetail");
  data.provenance = { ...(data.provenance as object), validUntil: "2099-01-01T00:00:00Z", version: "native-v1" };
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") throw new Error("No native effect");
    return respondWith(request.envelope, data, { dataVersion: "native-v1" });
  } } });
  renderRoute("/orders/TEST-SH-1042", adapter);
  const button = (await screen.findAllByRole("button", { name: "Open source order" }))[0]!;
  const explanation = document.getElementById(button.getAttribute("aria-describedby")!);
  expect(explanation).toBeVisible();
  expect(explanation?.parentElement).toBe(button.parentElement);
  const panel = screen.getByRole("region", { name: "Refunds have their own lifecycle" });
  expect(within(panel).getAllByRole("listitem")).toHaveLength(6);
  for (const label of ["Refund requested", "Refund settled", "Return received", "Stock reconciled", "Replacement created", "Replacement shipped"]) expect(within(panel).getByText(label)).toBeVisible();
  expect(within(panel).getAllByText("Unknown · no independent source receipt was returned.")).toHaveLength(6);
});


it("keeps refund request unknown after a settled refund and retains both independently supplied inventory outcomes", async () => {
  const data = operationsRecord("orderDetail");
  data.provenance = { ...(data.provenance as object), validUntil: "2099-01-01T00:00:00Z", version: "native-v1" };
  data.nativeEvents = ["refundSettled", "inventoryQuarantined", "inventoryRestocked"].map(kind => ({ kind, state: "confirmed", eventAt: "2026-11-06T11:50:00Z", observedAt: "2026-11-06T11:55:00Z", receiptRef: `independent-${kind}`, sourceRef: `source-${kind}`, reasonCode: null }));
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") throw new Error("No native effect");
    return respondWith(request.envelope, data, { dataVersion: "native-v1" });
  } } });
  renderRoute("/orders/TEST-SH-1042", adapter);
  const panel = await screen.findByRole("region", { name: "Refunds have their own lifecycle" });
  expect(within(panel).getByText("Refund requested").closest("li")).toHaveTextContent("Unknown");
  expect(within(panel).getByText("Stock reconciled").closest("li")).toHaveTextContent("independent-inventoryQuarantined");
  expect(within(panel).getByText("Stock reconciled").closest("li")).toHaveTextContent("independent-inventoryRestocked");
  expect(within(panel).getByText("Stock reconciled").closest("li")).toHaveTextContent("Reconciliation unknown");
  expect(within(panel).getByText("Stock reconciled").className).toMatch(/neutral/);
  expect(within(panel).getByText("Replacement created").closest("li")).toHaveTextContent("Unknown");
});
