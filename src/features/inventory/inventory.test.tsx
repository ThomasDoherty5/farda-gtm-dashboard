import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { AdapterError } from "@/adapter/errors";
import type { FardaAdapter } from "@/adapter/adapter";
import { availableOf, inventoryDemo } from "@/fixtures/inventory";
import { fulfillmentDemo, operationsDemo } from "@/fixtures/operations";
import { renderRoute } from "@/test/renderWithAdapter";
import { healthOf } from "./InventoryPage";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});

const open = (path: string, adapter: FardaAdapter = createDemoAdapter()) => {
  renderRoute(path, adapter);
  return userEvent.setup();
};
const metric = (label: string) => screen.getByTestId(`metric-${label}`);

describe("stock by home", () => {
  it("reconciles on hand, reserved and available, and flags the home below its threshold", async () => {
    open("/inventory");
    expect(await screen.findByTestId("metric-On hand")).toHaveTextContent("196");
    expect(metric("Reserved")).toHaveTextContent("28");
    expect(metric("Available")).toHaveTextContent("168");
    expect(metric("At risk")).toHaveTextContent("1 home");
    expect(screen.getByText("Home H2 below 20-unit threshold")).toBeInTheDocument();
    const rows = within(screen.getByTestId("stock-table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").slice(0, 3).map((c) => c.textContent))).toEqual([["100", "14", "86"], ["28", "10", "18"], ["68", "4", "64"]]);
    expect(within(rows[1]!).getByText("Low stock")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Healthy")).toBeInTheDocument();
  });

  it("reads the same balances as the Operations and fulfillment screens (OPS270-STOCK-02)", () => {
    const inv = inventoryDemo();
    expect(operationsDemo.stock.map((s) => [s.home, s.onHand, s.reserved])).toEqual(inv.rows.map((r) => [r.home, r.onHand, r.reserved]));
    expect(fulfillmentDemo(14).stock.map((s) => [s.home, s.available, s.reserved])).toEqual(inv.rows.map((r) => [r.home, availableOf(r), r.reserved]));
  });

  it("scopes the totals, the movements and the table to one home", async () => {
    open("/inventory?home=H2");
    expect(await screen.findByTestId("metric-On hand")).toHaveTextContent("28");
    expect(metric("Available")).toHaveTextContent("18");
    expect(within(screen.getByTestId("movement-log")).queryByText("TEST-MOV-0187")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("movement-log")).getByText("TEST-MOV-0188")).toBeInTheDocument();
  });

  it("shows a reservation as less available, never as less on hand (FE10-02)", async () => {
    open("/inventory");
    const log = await screen.findByTestId("movement-log");
    expect(within(log).getByText("−2 available")).toBeInTheDocument();
    expect(within(log).getByText("−1 on hand")).toBeInTheDocument();
    expect(within(log).getByText("+1 on hand")).toBeInTheDocument();
  });

  it("leaves received units unknown until the destination confirms, never zero", async () => {
    open("/inventory");
    const panel = await screen.findByTestId("transfer-panel");
    expect(within(panel).getByText("Not confirmed")).toBeInTheDocument();
    expect(within(panel).getByText("Transfer · Home H1 → Home H2")).toBeInTheDocument();
    expect(within(panel).getByText("Home transfer · awaiting receipt")).toBeInTheDocument();
    expect(within(panel).getByRole("img", { name: /step 2 of 3/ })).toBeInTheDocument();
  });

  it("surfaces a Shopify count that disagrees with the ledger and keeps the ledger balance", async () => {
    open("/inventory?scenario=conflict");
    expect(await screen.findByTestId("stock-conflict")).toHaveTextContent(/Shopify observed 30; the movements give 28 on hand/);
    expect(metric("On hand")).toHaveTextContent("196");
    expect(within(screen.getByTestId("stock-table")).getByText("Needs review")).toBeInTheDocument();
  });

  it("excludes a movement without its receipt from the balances, and says so", async () => {
    open("/inventory?scenario=delayed");
    expect(await screen.findByText(/Not counted · Receipt not recorded/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/excluded from the balances above/);
    expect(metric("On hand")).toHaveTextContent("196");
  });

  it("treats an unread Shopify snapshot as unknown, not as a mismatch", () => {
    const row = inventoryDemo("unread").rows.find((r) => r.home === "H3")!;
    expect(row.shopifyObserved).toMatchObject({ state: "unknown", value: null });
    expect(healthOf(row).label).toBe("Healthy");
  });

  it("warns when the mirror is behind and blocks transfer requests", async () => {
    open("/inventory?scenario=stale");
    expect(await screen.findByTestId("source-freshness")).toHaveTextContent(/Synced 3 hours ago/);
    expect(screen.getByRole("button", { name: "Request transfer" })).toHaveAttribute("aria-disabled", "true");
  });

  it("shows a recoverable error when the mirror is unreachable, and no balances", async () => {
    open("/inventory?scenario=unavailable");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reached/);
    expect(screen.queryByTestId("metric-On hand")).not.toBeInTheDocument();
  });

  it("never falls back to demo data on a live route", async () => {
    open("/inventory", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-On hand")).not.toBeInTheDocument();
  });

  it("holds fictional source links behind a dialog that performs no action", async () => {
    const user = open("/inventory");
    await user.click(await screen.findByRole("button", { name: "Open source for Home H2" }));
    expect(screen.getByText(/No verified link is available/)).toBeInTheDocument();
  });
});

describe("transfer request", () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>, from: string, to: string, units: string, reason = "Rebalance stock") => {
    await user.click(await screen.findByRole("button", { name: "Request transfer" }));
    const dialog = screen.getByRole("dialog", { name: "Request a stock transfer" });
    await user.selectOptions(within(dialog).getByLabelText("From"), from);
    await user.selectOptions(within(dialog).getByLabelText("To"), to);
    if (units) await user.type(within(dialog).getByLabelText("Units"), units);
    if (reason) await user.type(within(dialog).getByLabelText("Reason"), reason);
    await user.click(within(dialog).getByRole("button", { name: "Request transfer" }));
    return dialog;
  };

  it("queues a request for approval and moves nothing", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const user = open("/inventory", adapter);
    await fill(user, "H1", "H2", "10");
    const pending = await screen.findByTestId("pending-requests");
    expect(pending).toHaveTextContent("10 units · Home H1 → Home H2. Waiting for approval. No stock has moved.");
    expect(metric("On hand")).toHaveTextContent("196");
    expect(spy.mock.calls[0]![0]).toMatchObject({ operation: "requestApproval", actionKind: "requestStockTransfer", expectedVersion: "inv1" });
  });

  it("refuses more than the available units, naming the field and the limit", async () => {
    const user = open("/inventory");
    const dialog = await fill(user, "H2", "H1", "20");
    expect(await within(dialog).findByText("Only 18 available at Home H2.")).toBeInTheDocument();
    expect(screen.queryByTestId("pending-requests")).not.toBeInTheDocument();
  });

  it("refuses the same home, a missing quantity and a missing reason, keeping what was typed", async () => {
    const user = open("/inventory");
    const dialog = await fill(user, "H1", "H1", "5");
    expect((await within(dialog).findAllByText("The destination must differ from the source.")).length).toBeGreaterThan(0);
    expect(within(dialog).getByLabelText("Units")).toHaveValue("5");
  });

  it("shows a stale ledger version as a conflict", async () => {
    const adapter = createDemoAdapter();
    vi.spyOn(adapter, "submitAction").mockRejectedValueOnce(new AdapterError({ code: "STALE_VERSION", message: "Stock changed. Reload it before requesting a transfer.", requestId: "r", correlationId: "c", retryable: false, retryAfterMs: null, executionCertainty: "notApplied" }));
    const user = open("/inventory", adapter);
    const dialog = await fill(user, "H1", "H3", "4");
    expect(await within(dialog).findByTestId("action-error")).toHaveTextContent("This record changed");
  });
});
