import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { seedReconciliation } from "@/fixtures/reconciliation";
import { renderRoute } from "@/test/renderWithAdapter";

const PATH = "/automations?tab=reconciliation";
const open = async (adapter = createDemoAdapter()) => {
  renderRoute(PATH, adapter);
  await screen.findByTestId("recon-conflicts");
  return { adapter, user: userEvent.setup() };
};
const rows = (id: string) => within(screen.getByTestId(id)).getAllByRole("row").slice(1);

describe("FE13-05 nightly reconciliation and conflict repair", () => {
  it("the run summary is derived from the pairs: compared = matched + conflicts", async () => {
    const seed = seedReconciliation();
    for (const p of seed.pairs) expect(p.matched + p.conflicts).toBe(p.compared);
    await open();
    expect(screen.getByTestId("recon-summary")).toHaveTextContent("770 compared · 768 matched · 2 conflicts");
    expect(rows("recon-pairs")).toHaveLength(3);
  });

  it("every conflict names which side is authoritative and proposes a repair that never overwrites it", async () => {
    await open();
    const r = rows("conflict-table");
    expect(r).toHaveLength(2);
    expect(r[0]).toHaveTextContent("Shopify: $12.00 · Commission ledger: $12.50");
    expect(r[0]).toHaveTextContent("Shopify is authoritative for refunds");
    expect(r[0]).toHaveTextContent("The paid receipt is not rewritten");
    expect(r[1]).toHaveTextContent("The sheet is not edited from here");
  });

  it("requesting a repair goes through the adapter, shows approval pending, and changes neither system", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(adapter);
    await user.click(screen.getByRole("button", { name: "Request repair for CONF-001" }));
    expect(await screen.findByTestId("repair-ack")).toHaveTextContent("waiting for approval from founder; nothing was changed in either system");
    expect(spy.mock.calls[0]![0]).toMatchObject({ operation: "requestApproval", actionKind: "requestConflictRepair", payload: { conflictId: "CONF-001" } });
    await waitFor(() => expect(within(rows("conflict-table")[0]!).getByText("Repair requested")).toBeInTheDocument());
    expect(within(rows("conflict-table")[1]!).getByRole("button", { name: "Request repair for CONF-002" })).toBeInTheDocument();
  });

  it("the audit trail is append-only: a request adds an entry and leaves the earlier ones as they were", async () => {
    const { user } = await open();
    const before = rows("audit-table").map((r) => r.textContent);
    expect(before).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Request repair for CONF-002" }));
    await waitFor(() => expect(rows("audit-table")).toHaveLength(4));
    const after = rows("audit-table").map((r) => r.textContent);
    expect(after.slice(0, 3)).toEqual(before);
    expect(after[3]).toContain("Repair requested");
    expect(after[3]).toContain("CONF-002");
    expect(after[3]).toContain("nothing was changed in either system");
  });

  it("a repair can't be requested twice, and a stale version is refused", async () => {
    const adapter = createDemoAdapter();
    const base = { operation: "requestApproval" as const, actionKind: "requestConflictRepair", entityRefs: [], approvalRef: null, manifestRef: null, schemaVersion: "x", requestId: "r", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" as const } };
    await expect(adapter.submitAction({ ...base, expectedVersion: "old", idempotencyKey: "k1", payload: { conflictId: "CONF-001" } })).rejects.toMatchObject({ body: { code: "STALE_VERSION" } });
    await expect(adapter.submitAction({ ...base, expectedVersion: "rec1", idempotencyKey: "k2", payload: { conflictId: "CONF-001" } })).resolves.toMatchObject({ state: "approvalPending", receiptRefs: [] });
    await expect(adapter.submitAction({ ...base, expectedVersion: "rec2", idempotencyKey: "k3", payload: { conflictId: "CONF-001" } })).rejects.toMatchObject({ body: { code: "VALIDATION_FAILED" } });
    await expect(adapter.submitAction({ ...base, expectedVersion: "rec2", idempotencyKey: "k4", payload: { conflictId: "NOPE" } })).rejects.toMatchObject({ body: { code: "RECORD_NOT_FOUND" } });
    await expect(adapter.submitAction({ ...base, expectedVersion: "rec1", idempotencyKey: "k2", payload: { conflictId: "CONF-001" } })).resolves.toMatchObject({ state: "approvalPending" });
  });

  it("is a separate cadence from daily sourcing and hourly monitoring", async () => {
    await open();
    expect(screen.getByText(/Nightly · 02:00 PT · separate from daily sourcing and hourly monitoring/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconciliation" })).toHaveAttribute("aria-current", "page");
  });

  it("shows a pending state, never demo conflicts, on the live adapter", async () => {
    renderRoute(PATH, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId("recon-conflicts")).not.toBeInTheDocument();
  });
});
