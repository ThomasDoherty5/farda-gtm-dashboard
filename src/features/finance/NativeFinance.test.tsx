import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { TransportFailure } from "@/adapter/transport";
import type { NativeCommissionLedger, NativePayable, NativeSettlement } from "@/creator-agent/settlements/contract";
import { settlementSourceFixture } from "@/creator-agent/settlements/fixtures.testkit";
import { renderRoute, testClient } from "@/test/renderWithAdapter";
import { moneyFact } from "./NativeFinance";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

const fixture = () => {
  const source = settlementSourceFixture({ workspaceId: "w", accountId: "a", environment: "sandbox" });
  const common = { version: "native-ledger-v1", source: { state: "current" as const, observedAt: "2026-11-07T12:00:00Z", sourceUpdatedAt: "2026-11-07T12:00:00Z", validUntil: "2099-01-01T00:00:00Z", revision: "source-v1", reasonCodes: [], synthetic: true }, accountingPolicy: { state: "unknown" as const, reference: null }, capabilities: { match: false, export: false, pay: false as const } };
  const ledger: NativeCommissionLedger = { kind: "native-commission-ledger", economics: null, stateTotals: null, ...common, currency: "USD", records: source.records, coverage: { returned: 3, total: 3, complete: true }, totals: { eligible: source.money(120000), accrued: source.money(33000), creatorPaid: source.money(18000), contribution: source.unknown }, export: null };
  const payable: NativePayable = { kind: "native-payable", ...common, record: source.records.find(record => record.provider === "externalManual")! };
  return { source, ledger, payable };
};
function harness(data: NativeCommissionLedger | NativePayable | NativeSettlement, path = "/finance/commissions") {
  const state = { denied: false }, requests: unknown[] = [], reads: { viewKey: string; filters: unknown }[] = [], client = testClient();
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") { requests.push(request); throw new Error("Unexpected mutation in read-only financial inspection"); }
    reads.push({ viewKey: request.envelope.viewKey, filters: request.envelope.filters });
    if (state.denied) throw new TransportFailure("http", { status: 403, body: { code: "FORBIDDEN", executionCertainty: "notApplied" } });
    return respondWith(request.envelope, data, { dataVersion: data.version, capabilities: [] });
  } } });
  const router = renderRoute(path, adapter, client);
  return { state, requests, reads, client, router };
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

it("keeps known zero, unknown and N/A distinct in native money facts", () => {
  const { source } = fixture();
  expect(moneyFact(source.money(0))).toContain("0.00");
  expect(moneyFact(source.unknown)).toMatch(/^Unknown/);
  expect(moneyFact({ ...source.unknown, state: "notApplicable" })).toMatch(/^N\/A/);
});
it("never exports native source rows in the browser when read capabilities contain no export grant", async () => {
  const { ledger } = fixture(), h = harness(ledger), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Export ledger" }));
  const dialog = screen.getByRole("dialog", { name: "Export the commission ledger" });
  expect(within(dialog).getByRole("button", { name: "Request CSV export" })).toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).queryByText("Demo")).not.toBeInTheDocument();
  expect(h.requests).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Download CSV" })).not.toBeInTheDocument();
});
it("keeps native provider filters and record navigation free of fixture scenario and demo IDs", async () => {
  const { ledger } = fixture(), h = harness(ledger, "/finance/commissions?scenario=paid&provider=collabs");
  await screen.findByRole("table", { name: "Commission and historical obligation records" });
  expect(h.reads.find(read => read.viewKey === "commissionLedger")?.filters).toEqual({ provider: "collabs" });
  expect(screen.getByRole("link", { name: "Reconcile payout" })).toHaveAttribute("href", "/finance/settlements/collabs-one");
  expect(document.querySelector('a[href*="COMM-DEMO"]')).toBeNull();
  expect(screen.getByText(/source-backed cost breakdown was not supplied/)).toBeInTheDocument();
});
it("retains the historical accepted amount and shows absent execution evidence as unknown", async () => {
  const { payable } = fixture(); payable.record!.historical!.acceptedAmount = { minorUnits: 27500, currency: "USD" };
  const h = harness(payable, "/finance/payables/payable-one");
  await screen.findByTestId("native-payment-request");
  expect(screen.getByTestId("native-payment-request")).toHaveTextContent("USD 275.00");
  expect(screen.getByTestId("native-payment-lifecycle")).toHaveTextContent("Unknown · execution evidence not supplied");
  expect(document.querySelector('a[href*="demo-offer"]')).toBeNull();
  expect(h.requests).toHaveLength(0);
});
it("clears open financial evidence after a denied refetch", async () => {
  const { ledger } = fixture(), h = harness(ledger), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Inspect evidence for collabs-one" }));
  expect(screen.getByRole("dialog", { name: "Financial source evidence" })).toHaveTextContent("collabs-one-receipt");
  h.state.denied = true;
  await act(async () => { await h.client.invalidateQueries(); });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Financial source evidence" })).not.toBeInTheDocument());
  expect(screen.queryByText("collabs-one-receipt")).not.toBeInTheDocument();
});
it("withholds the whole protected record when its display lease is already expired", async () => {
  const { payable } = fixture(); payable.source.validUntil = "2020-01-01T00:00:00Z";
  harness(payable, "/finance/payables/payable-one");
  await screen.findByText(/Current source access is unavailable or expired/);
  expect(screen.queryByTestId("native-payment-request")).not.toBeInTheDocument();
  expect(screen.queryByText("fixture-creator")).not.toBeInTheDocument();
});

it("opens native statement candidates without proposing when matching authority is absent", async () => {
  const { source, payable } = fixture();
  const settlement: NativeSettlement = { ...payable, kind: "native-settlement", record: source.records.find(record => record.provider === "collabs")! };
  const h = harness(settlement, "/finance/settlements/collabs-one"), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Match statement" }));
  const dialog = screen.getByRole("dialog", { name: "Match provider statement" });
  expect(within(dialog).getByRole("button", { name: "Preview exact match" })).toHaveAttribute("aria-disabled", "true");
  expect(h.requests).toHaveLength(0);
});
it("withholds even a verified external link on synthetic financial evidence", async () => {
  const { payable } = fixture();
  payable.record!.links.push({ kind: "currentOffer", targetRef: "offer-source", state: "verified", url: "https://example.com/source-offer", observedAt: "2026-11-07T12:00:00Z", validUntil: "2099-01-01T00:00:00Z" });
  harness(payable, "/finance/payables/payable-one");
  await screen.findByTestId("native-payment-request");
  expect(screen.getByRole("button", { name: "Current affiliate terms" })).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("link", { name: /Current affiliate terms/ })).not.toBeInTheDocument();
  const held = screen.getByRole("button", { name: "Current affiliate terms" });
  const reason = document.getElementById(held.getAttribute("aria-describedby")!);
  expect(reason).toBeVisible();
  expect(reason).toHaveTextContent("Source link unavailable. Refresh source access.");
  expect(reason?.parentElement).toBe(held.parentElement);
});
it("renders source execution only from its independent event", async () => {
  const { payable } = fixture();
  payable.record!.facts.push({ ref: "execution-event", state: "executed", amount: null, eventAt: "2026-11-07T12:00:00Z", observedAt: "2026-11-07T12:00:00Z", evidenceRef: "execution-proof", nativeRef: null });
  harness(payable, "/finance/payables/payable-one");
  expect(await screen.findByTestId("native-payment-lifecycle")).toHaveTextContent("Source execution observed");
});
it("holds export when its persisted original marker is malformed instead of minting a new request key", async () => {
  sessionStorage.setItem(JSON.stringify(["native-ledger-export-v1", "farda", "tester", "sandbox", "w", "a"]), "{damaged");
  const { ledger } = fixture();
  ledger.capabilities.export = true;
  ledger.export = { sourceVersion: "snapshot-v1", filters: { state: "all", startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-08T00:00:00Z", timezone: "UTC", currency: "USD" } };
  const h = harness(ledger), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Export ledger" }));
  const dialog = screen.getByRole("dialog", { name: "Export the commission ledger" });
  await user.click(within(dialog).getByRole("button", { name: "Request CSV export" }));
  expect(within(dialog).getByRole("button", { name: "Request CSV export" })).toHaveAttribute("aria-disabled", "true");
  expect(h.requests).toHaveLength(0);
  expect(sessionStorage.getItem(JSON.stringify(["native-ledger-export-v1", "farda", "tester", "sandbox", "w", "a"]))).toBe("{damaged");
});
