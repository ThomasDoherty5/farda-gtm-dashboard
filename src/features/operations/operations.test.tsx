import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { AdapterError } from "@/adapter/errors";
import type { FardaAdapter } from "@/adapter/adapter";
import { fulfillmentDemo, orderDemo, returnDemo } from "@/fixtures/operations";
import { renderRoute } from "@/test/renderWithAdapter";

// jsdom has no modal dialogs, so give <dialog> the open state a browser would.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});

const open = async (path: string, adapter: FardaAdapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  return { router, user: userEvent.setup() };
};
const metric = (label: string) => screen.getByTestId(`metric-${label}`);

describe("operations overview", () => {
  it("shows the queue, stock and exceptions from one dataset", async () => {
    await open("/operations");
    expect(await screen.findByTestId("metric-To ship")).toHaveTextContent("18");
    expect(screen.getByText("4 waiting more than 2 days")).toBeInTheDocument();
    expect(metric("Time to ship")).toHaveTextContent("1.2 days");
    const rows = within(screen.getByTestId("queue-table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("rowheader")[0]!.textContent)).toEqual(["TEST-SH-1042", "TEST-SC-0081", "TEST-TT-1038", "TEST-SH-1045", "TEST-SC-0085"]);
    expect(screen.getByText("Home H2 is below its 20-unit threshold.")).toBeInTheDocument();
    expect(screen.getByText("2 shipments need attention")).toBeInTheDocument();
  });

  it("warns on work older than two days and keeps order and sample identities separate", async () => {
    await open("/operations");
    const table = await screen.findByTestId("queue-table");
    expect(within(table).getByText("2.4 days")).toBeInTheDocument();
    expect(within(table).getAllByRole("link", { name: "View sample" })).toHaveLength(2);
    expect(within(table).getAllByRole("link", { name: "View order" })).toHaveLength(3);
  });

  it("scopes totals to one home and says issues are not assigned to a home", async () => {
    await open("/operations?home=H2");
    expect(await screen.findByTestId("metric-To ship")).toHaveTextContent("6");
    expect(metric("Open issues")).toHaveTextContent("N/A");
    expect(within(screen.getByTestId("queue-table")).queryByText("TEST-SH-1042")).not.toBeInTheDocument();
  });

  it("lists held work apart from the ready queue, with the reason and the source action (OPS270-03)", async () => {
    await open("/operations?scenario=holds");
    const held = await screen.findByTestId("held-panel");
    expect(within(held).getByText(/Sample not approved yet/)).toBeInTheDocument();
    expect(within(held).getByText(/Not enough available stock at Home H2/)).toBeInTheDocument();
    expect(within(held).getByText(/Resolve the order's identity in Shopify/)).toBeInTheDocument();
    expect(within(screen.getByTestId("queue-table")).queryByText("TEST-SC-0090")).not.toBeInTheDocument();
  });

  it("separates a known zero from an unknown figure", async () => {
    const { unmount } = render0("/operations?scenario=unknown");
    expect(await screen.findByTestId("metric-Time to ship")).toHaveTextContent("N/A");
    expect(screen.getByText("The warehouse mirror has not provided timing yet.")).toBeInTheDocument();
    expect(metric("To ship")).toHaveTextContent("18");
    unmount();
  });

  it("says the source is behind when the mirror is stale", async () => {
    await open("/operations?scenario=stale");
    expect(await screen.findByTestId("source-freshness")).toHaveTextContent(/Synced 3 hours ago/);
    expect(screen.getByTestId("source-freshness")).toHaveTextContent(/behind its source/);
  });

  it("shows an empty queue as a known zero, not a failure", async () => {
    await open("/operations?scenario=empty");
    expect(await screen.findByTestId("metric-To ship")).toHaveTextContent("0");
    expect(screen.getByText(/known zero from the warehouse mirror, not a missing read/)).toBeInTheDocument();
  });

  it("shows a recoverable error when the mirror is unreachable", async () => {
    await open("/operations?scenario=unavailable");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reached/);
    expect(screen.queryByTestId("metric-To ship")).not.toBeInTheDocument();
  });

  it("never falls back to demo data on a live route", async () => {
    await open("/operations", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-To ship")).not.toBeInTheDocument();
  });

  it("makes the current section a current-view control with no history push (CTRL-166)", async () => {
    const { router } = await open("/operations");
    await screen.findByTestId("metric-To ship");
    const before = router.state.historyAction;
    expect(screen.getByRole("link", { name: "Overview", current: "page" })).toBeInTheDocument();
    expect(router.state.historyAction).toBe(before);
  });
});

function render0(path: string) {
  renderRoute(path, createDemoAdapter());
  return { unmount: () => undefined };
}

describe("order detail", () => {
  it("keeps paid, label, carrier and delivery as separate facts", async () => {
    await open("/orders/TEST-SH-1031");
    await screen.findByTestId("metric-Order total");
    const lifecycle = screen.getByRole("list", { name: "Fulfillment lifecycle" });
    const titles = within(lifecycle).getAllByRole("listitem").map((li) => li.querySelector("p")!.firstChild!.textContent);
    expect(titles).toEqual(["Order paid", "Label created", "Carrier accepted", "Shipped", "Delivered", "Return received", "Refund", "Replacement"]);
    expect(within(lifecycle).getByText(/Not delivered\. The carrier reported it lost/)).toBeInTheDocument();
    expect(within(lifecycle).getByText(/no replacement order exists/)).toBeInTheDocument();
  });

  it("shows a known $0.00 refund as zero", async () => {
    await open("/orders/TEST-SH-1042");
    expect(await screen.findByTestId("metric-Refunded")).toHaveTextContent("$0.00");
  });

  it("shows a sample's total as N/A with the reason, never $0", async () => {
    await open("/orders/TEST-SC-0081");
    expect(await screen.findByTestId("metric-Order total")).toHaveTextContent("N/A");
    expect(screen.getAllByText("A sample is not a sale.").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sample TEST-SC-0081");
  });

  it("holds fictional source links behind a dialog that performs no action", async () => {
    const { user } = await open("/orders/TEST-SH-1042");
    await user.click(await screen.findByRole("button", { name: "Open Shopify" }));
    expect(screen.getByText(/No verified link is available/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open in a new tab/ })).not.toBeInTheDocument();
  });

  it("keeps the heading and explains an order that does not exist", async () => {
    await open("/orders/nope");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Order nope");
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("Record not found");
  });

  it("minimizes personal data: no customer name, email or address is rendered", async () => {
    await open("/orders/TEST-SH-1042");
    await screen.findByTestId("metric-Order total");
    expect(document.body.textContent).not.toMatch(/@|street|avenue/i);
    expect(screen.getByText("No customer details are mirrored")).toBeInTheDocument();
  });
});

const EXCEPTION = "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129";

describe("shipping exception", () => {
  it("shows the carrier trace newest first and the protected address", async () => {
    await open(EXCEPTION);
    expect(await screen.findByTestId("metric-Carrier state")).toHaveTextContent("Lost");
    expect(screen.getByText("Ship-from location · address protected")).toBeInTheDocument();
    expect(metric("Shipping cost")).toHaveTextContent("$6.75");
    expect(screen.getByText("Event time and sync time are different")).toBeInTheDocument();
  });

  it("requires a choice and a reason, and keeps what was typed", async () => {
    const { user } = await open(EXCEPTION);
    await user.click(await screen.findByRole("button", { name: "Record next step" }));
    const dialog = screen.getByRole("dialog", { name: "Record the next step" });
    await user.type(within(dialog).getByLabelText("Reason"), "Carrier confirmed lost");
    await user.click(within(dialog).getByRole("button", { name: "Record next step" }));
    expect((await within(dialog).findAllByText("Choose refund or replacement.")).length).toBeGreaterThan(0);
    expect(within(dialog).getByLabelText("Reason")).toHaveValue("Carrier confirmed lost");
  });

  it("records the decision as waiting for approval, never as refunded or shipped", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(EXCEPTION, adapter);
    await user.click(await screen.findByRole("button", { name: "Record next step" }));
    const dialog = screen.getByRole("dialog", { name: "Record the next step" });
    await user.click(within(dialog).getByRole("radio", { name: /Send a replacement/ }));
    await user.type(within(dialog).getByLabelText("Reason"), "Carrier confirmed lost");
    await user.click(within(dialog).getByRole("button", { name: "Record next step" }));
    const recorded = await screen.findByTestId("decision-recorded");
    expect(recorded).toHaveTextContent("Next step recorded: replacement");
    expect(recorded).toHaveTextContent("Waiting for approval. Nothing has been refunded or shipped.");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ operation: "requestApproval", actionKind: "recordShippingDecision", expectedVersion: "ex1" });
    // A second decision is blocked with a visible reason.
    await waitFor(() => expect(screen.getByRole("button", { name: "Record next step" })).toHaveAttribute("aria-disabled", "true"));
  });

  it("shows a stale version as a conflict and sends nothing twice (FE09-04)", async () => {
    const adapter = createDemoAdapter();
    vi.spyOn(adapter, "submitAction").mockRejectedValueOnce(new AdapterError({ code: "STALE_VERSION", message: "This exception changed. Reload it before recording a decision.", requestId: "r", correlationId: "c", retryable: false, retryAfterMs: null, executionCertainty: "notApplied" }));
    const { user } = await open(EXCEPTION, adapter);
    await user.click(await screen.findByRole("button", { name: "Record next step" }));
    const dialog = screen.getByRole("dialog", { name: "Record the next step" });
    await user.click(within(dialog).getByRole("radio", { name: /Refund the order/ }));
    await user.type(within(dialog).getByLabelText("Reason"), "Lost");
    await user.click(within(dialog).getByRole("button", { name: "Record next step" }));
    expect(await within(dialog).findByTestId("action-error")).toHaveTextContent("This record changed");
    expect(within(dialog).getByRole("button", { name: "Reload the record" })).toBeInTheDocument();
    expect(screen.queryByTestId("decision-recorded")).not.toBeInTheDocument();
  });
});

describe("return and replacement", () => {
  const RETURN = "/returns/TEST-RET-028";

  it("keeps close unavailable, with its reason, until receipts exist (CTRL-214)", async () => {
    const { user } = await open(RETURN);
    const close = await screen.findByRole("button", { name: "Close unavailable" });
    expect(close).toHaveAttribute("aria-disabled", "true");
    expect(close).toHaveAccessibleDescription(/Needs the inventory receipt/);
    await user.click(close);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Return TEST-RET-028");
    expect(screen.getAllByText("Pending")).toHaveLength(3);
  });

  it("previews a replacement without refunding or shipping (CTRL-176)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(RETURN, adapter);
    await user.click(await screen.findByRole("button", { name: "Preview replacement plan" }));
    expect(screen.getByText(/This preview refunds nothing and ships nothing/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats the fields as a draft that can be reset (CTRL-173 to 175)", async () => {
    const { user } = await open(RETURN);
    await user.selectOptions(await screen.findByLabelText("Resolution"), "replacement");
    expect(screen.getByLabelText("Resolution")).toHaveValue("replacement");
    await user.click(screen.getByRole("button", { name: "Reset to the source's selection" }));
    expect(screen.getByLabelText("Resolution")).toHaveValue("refund");
  });

  it("prepares the task for approval and reports it as not yet done", async () => {
    const { user } = await open(RETURN);
    await user.click(await screen.findByRole("button", { name: "Prepare browser task" }));
    const status = await screen.findByTestId("proposal-status");
    expect(status).toHaveTextContent("Prepared, waiting for approval");
    expect(status).toHaveTextContent("Nothing has been refunded, restocked or shipped.");
    expect(screen.getByRole("button", { name: "Prepare browser task" })).toHaveAttribute("aria-disabled", "true");
  });

  it("requires a reason", async () => {
    const { user } = await open(RETURN);
    const reason = await screen.findByLabelText("Reason");
    await user.clear(reason);
    await user.click(screen.getByRole("button", { name: "Prepare browser task" }));
    expect(await screen.findByText("Enter the operational reason.")).toBeInTheDocument();
    expect(reason).toHaveValue("");
  });

  it("shows the resolved chain only from receipts", async () => {
    await open(`${RETURN}?scenario=resolved`);
    expect(await screen.findByRole("heading", { level: 1, name: "Return resolved" })).toBeInTheDocument();
    const chain = screen.getByTestId("return-chain");
    expect(within(chain).getAllByRole("row")).toHaveLength(6);
    expect(within(chain).getByText("TEST-REF-1028-1")).toBeInTheDocument();
    expect(screen.getByTestId("metric-Refunded")).toHaveTextContent("$34.99 refunded");
    expect(screen.queryByRole("button", { name: "Prepare browser task" })).not.toBeInTheDocument();
  });

  it("the fixture's restock verdict comes from the inspection receipt", () => {
    const r = returnDemo("TEST-RET-028")!;
    expect(r.inspection).toMatchObject({ receiptRef: "TEST-INSP-028", resellable: true });
    expect(returnDemo("TEST-RET-999")).toBeNull();
  });
});

describe("fulfillment analytics", () => {
  it("derives the headline from the daily rows", async () => {
    await open("/analytics/fulfillment");
    expect(await screen.findByTestId("metric-Orders shipped")).toHaveTextContent("329");
    expect(screen.getByText("+17.9% vs prior 14 days (279)")).toBeInTheDocument();
    expect(screen.getByTestId("best-day")).toHaveTextContent("32 orders · Oct 22");
    expect(fulfillmentDemo(14).daily.reduce((n, d) => n + d.shipped, 0)).toBe(329);
  });

  it("offers the chart as a table too", async () => {
    await open("/analytics/fulfillment");
    const table = await screen.findByRole("table", { name: "Orders shipped and open backlog per day" });
    expect(within(table).getAllByRole("row")).toHaveLength(15);
    expect(screen.getByRole("img", { name: /329 shipped in total/ })).toBeInTheDocument();
  });

  it("says a comparison is not available instead of showing zero", async () => {
    await open("/analytics/fulfillment?days=7");
    expect(await screen.findByTestId("metric-Orders shipped")).toHaveTextContent("177");
    expect(screen.getByText("The previous period is not in the demo data.")).toBeInTheDocument();
    expect(screen.getByText(/N\/A\. The demo holds no delivery mix/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Showing 7 of 14 days/);
  });

  it("marks the home below its threshold", async () => {
    await open("/analytics/fulfillment");
    expect(await screen.findByText("Home H2 · 18 available · below 20-unit threshold")).toBeInTheDocument();
  });
});

describe("fixtures", () => {
  it("has no customer contact details", () => {
    expect(JSON.stringify(orderDemo("TEST-SH-1042"))).not.toMatch(/@|\d{3}-\d{4}/);
  });
});
