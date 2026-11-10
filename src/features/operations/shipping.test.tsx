import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { inventoryDemo, isLate } from "@/fixtures/inventory";
import { heldRows, operationsDemo } from "@/fixtures/operations";
import { EXCEPTION_KINDS, isInTransit, opsExceptionsDemo, sandboxChain, shipmentsDemo } from "@/fixtures/opsShipping";
import { DEMO_NOW } from "@/fixtures/overview";
import { renderRoute } from "@/test/renderWithAdapter";
import { exceptionCounts } from "./ShippingPanels";

const SHIPPING = "/operations?view=shipping";
const openShipping = async (adapter = createDemoAdapter()) => {
  renderRoute(SHIPPING, adapter);
  await screen.findByTestId("in-transit");
  return { adapter };
};
const rows = (id: string) => within(screen.getByTestId(id)).getAllByRole("row").slice(1);

describe("OPS270-04 in transit excludes confirmed delivered", () => {
  it("counts only shipments the carrier has not confirmed delivered", () => {
    const transit = shipmentsDemo.filter(isInTransit).map((s) => s.ref);
    expect(transit).toEqual(["TEST-SP-0087", "TEST-SP-0088", "TEST-SP-0089"]);
    expect(shipmentsDemo.filter((s) => s.carrierState === "delivered").every((s) => !isInTransit(s))).toBe(true);
  });

  it("a delivered report the carrier hasn't confirmed is still in transit, and lost, returned and label-only are not", () => {
    const by = (state: string) => shipmentsDemo.find((s) => s.carrierState === state)!;
    expect(isInTransit(by("deliveredUnconfirmed"))).toBe(true);
    for (const state of ["delivered", "lost", "returned", "labelCreated"]) expect(isInTransit(by(state))).toBe(false);
  });

  it("the shipping view says 3 in transit and that confirmed deliveries are not counted", async () => {
    await openShipping();
    expect(screen.getByRole("heading", { name: "3 in transit" })).toBeInTheDocument();
    expect(screen.getByText(/1 confirmed delivered are not counted/)).toBeInTheDocument();
    const r = rows("shipments-table");
    expect(r.find((x) => x.textContent!.includes("TEST-SP-0090"))).toBeUndefined();
    expect(r[0]).toHaveTextContent(/Lost|Returned/);
    expect(r.find((x) => x.textContent!.includes("TEST-SP-0089"))).toHaveTextContent(/Delivered, not confirmed by the carrier.*In transit/);
  });
});

describe("FE09-05 each exception kind is evidenced", () => {
  it("counts every kind from the rows, and none is hidden behind another", async () => {
    expect(exceptionCounts(opsExceptionsDemo)).toEqual({ aging: 2, failedLabel: 1, failedScan: 1, duplicateShipment: 1, stockShortage: 1, uncertainRefund: 1 });
    await openShipping();
    for (const k of EXCEPTION_KINDS) expect(screen.getByTestId(`exc-${k.kind}`)).toHaveTextContent(k.label);
    expect(screen.getByTestId("exc-aging")).toHaveTextContent("Aging · 2");
    expect(screen.getByTestId("exc-uncertainRefund")).toHaveTextContent("Uncertain refund · 1");
  });

  it("aging is the queue's own over-48-hours rows, so the two never disagree", () => {
    const over = operationsDemo.queue.rows.filter((r) => r.waitingHours > operationsDemo.warnAfterHours).map((r) => r.ref);
    expect(opsExceptionsDemo.filter((e) => e.kind === "aging").map((e) => e.ref).sort()).toEqual(over.sort());
  });

  it("an uncertain refund points to reconciliation, never to a second refund", async () => {
    await openShipping();
    const row = rows("exceptions-table").find((r) => r.textContent!.includes("Uncertain refund"))!;
    expect(row).toHaveTextContent("The refund request has no provider receipt yet");
    expect(within(row).getByRole("link", { name: "Reconcile before any second refund" })).toBeInTheDocument();
  });

  it("every exception links to a record", async () => {
    await openShipping();
    for (const e of opsExceptionsDemo) expect(screen.getAllByRole("link", { name: e.next }).some((l) => l.getAttribute("href") === e.to)).toBe(true);
  });
});

describe("OPS270-08 linked sandbox order, sample and shortage", () => {
  it("the chain uses the same refs as the queue, the held rows, the transfer and the stock screen", () => {
    const refs = Object.fromEntries(sandboxChain.map((c) => [c.key, c.ref]));
    expect(operationsDemo.queue.rows.map((r) => r.ref)).toContain(refs.order);
    expect(operationsDemo.queue.rows.map((r) => r.ref)).toContain(refs.sample);
    const shortage = heldRows.find((r) => r.ref === refs.shortage)!;
    expect(shortage.hold!.reason).toMatch(/Not enough available stock at Home H2/);
    expect(operationsDemo.transfers.map((t) => t.ref)).toContain(refs.transfer);
    expect(inventoryDemo().transfer.key).toBe(refs.transfer);
    expect(operationsDemo.transfers.find((t) => t.ref === refs.transfer)!.toHome).toBe(shortage.home);
  });

  it("the shipping view walks order → sample → shortage → transfer in that order, with links", async () => {
    await openShipping();
    const items = within(screen.getByTestId("sandbox-chain")).getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("data-testid"))).toEqual(["chain-order", "chain-sample", "chain-shortage", "chain-transfer"]);
    expect(items[2]).toHaveTextContent("Not enough available stock at Home H2");
    expect(items[3]).toHaveTextContent("receipt not confirmed");
    expect(screen.getByText(/Sandbox records only\. Nothing here moves stock, ships or refunds\./)).toBeInTheDocument();
  });

  it("a pending backend shows no shipping detail", async () => {
    renderRoute(SHIPPING, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("in-transit")).not.toBeInTheDocument();
  });
});

describe("FE09-03 customer data only to authorized roles", () => {
  const ORDER = "/orders/TEST-SH-1042";
  const openOrder = async (actorRole?: string) => {
    renderRoute(ORDER, createDemoAdapter({ actorRole }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Customer details (restricted)" }));
    return user;
  };

  it("shows no customer detail by default, and the page keeps saying none is mirrored", async () => {
    renderRoute(ORDER, createDemoAdapter());
    expect(await screen.findByText("No customer details are mirrored")).toBeInTheDocument();
    expect(screen.queryByText(/example\.test/)).not.toBeInTheDocument();
  });

  it("an unauthorized role is told why and nothing is revealed or logged", async () => {
    await openOrder("reviewer");
    expect(await screen.findByTestId("customer-denied")).toHaveTextContent("You don't have the role this decision needs.");
    expect(screen.getByTestId("customer-denied")).toHaveTextContent("nothing was revealed or logged");
    expect(screen.queryByRole("button", { name: "Reveal customer details", hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/example\.test/)).not.toBeInTheDocument();
  });

  it("the server refuses an unauthorized reveal even if the button were forced", async () => {
    const adapter = createDemoAdapter({ actorRole: "reviewer" });
    const request = { operation: "controlRun" as const, actionKind: "revealCustomerDetails", entityRefs: [], expectedVersion: "x", approvalRef: null, manifestRef: null, schemaVersion: "x", requestId: "r", idempotencyKey: "k", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" as const }, payload: { orderRef: "TEST-SH-1042", reason: "I would like to look" } };
    await expect(adapter.submitAction(request)).rejects.toMatchObject({ body: { code: "SOURCE_AUTHORITY_DENIED", executionCertainty: "notApplied" } });
  });

  it("an operations role must give a reason, then sees synthetic placeholders and a log entry", async () => {
    const user = await openOrder("operations");
    await user.click(await screen.findByRole("button", { name: "Reveal customer details", hidden: true }));
    expect(await screen.findByText("Say why in at least 10 characters.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/example\.test/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Reason", { selector: "input, textarea" }), "Checking the delivery address");
    await user.click(screen.getByRole("button", { name: "Reveal customer details", hidden: true }));
    const shown = await screen.findByTestId("customer-revealed");
    expect(shown).toHaveTextContent("Test Customer 1042");
    expect(shown).toHaveTextContent("test-1042@example.test");
    expect(shown).toHaveTextContent("Synthetic placeholder values");
    await waitFor(() => expect(screen.getByTestId("customer-audit")).toHaveTextContent("CUST-AUD-1 · operations · Checking the delivery address"));
  });

  it("a reload starts hidden again for a new session, and the log is per order", async () => {
    const adapter = createDemoAdapter({ actorRole: "founder" });
    const direct = (orderId: string) => adapter.readView({ schemaVersion: "x", operation: "readView", viewKey: "orderCustomer", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" }, filters: { orderId }, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r" });
    expect(((await direct("TEST-SH-1042")).data as { revealed: unknown }).revealed).toBeNull();
    await adapter.submitAction({ operation: "controlRun", actionKind: "revealCustomerDetails", entityRefs: [], expectedVersion: "x", approvalRef: null, manifestRef: null, schemaVersion: "x", requestId: "r", idempotencyKey: "k", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" }, payload: { orderRef: "TEST-SH-1042", reason: "Checking the delivery address" } });
    expect(((await direct("TEST-SH-1042")).data as { revealed: unknown }).revealed).not.toBeNull();
    expect(((await direct("TEST-SC-0081")).data as { revealed: unknown }).revealed).toBeNull();
    expect(((await createDemoAdapter({ actorRole: "founder" }).readView({ schemaVersion: "x", operation: "readView", viewKey: "orderCustomer", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" }, filters: { orderId: "TEST-SH-1042" }, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r" })).data as { revealed: unknown }).revealed).toBeNull();
  });
});

describe("FE10-05 a late transfer and a stale mirror", () => {
  it("a transfer past its expected date and not received is late, and a received one never is", () => {
    const t = inventoryDemo("late").transfer;
    expect(isLate(t, DEMO_NOW)).toBe(true);
    expect(isLate({ ...t, stage: "received" }, DEMO_NOW)).toBe(false);
    expect(isLate(inventoryDemo().transfer, DEMO_NOW)).toBe(false);
  });

  it("the stock page says it is late, keeps on-hand unchanged and counts nothing until the receipt", async () => {
    renderRoute("/inventory?scenario=late", createDemoAdapter());
    const alert = await screen.findByTestId("transfer-late");
    expect(alert).toHaveTextContent("TEST-TR-012 is late");
    expect(alert).toHaveTextContent("has not confirmed receipt");
    expect(alert).toHaveTextContent("not counted until the source records the receipt");
    expect(await screen.findByTestId("metric-On hand")).toHaveTextContent("196");
  });

  it("the default stock page shows no late alert", async () => {
    renderRoute("/inventory", createDemoAdapter());
    await screen.findByTestId("metric-On hand");
    expect(screen.queryByTestId("transfer-late")).not.toBeInTheDocument();
  });
});
