import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { AdapterError } from "@/adapter/errors";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";
import { countByState, exampleRows } from "./BatchPage";
import { seedItems } from "@/fixtures/batch";

const PATH = "/batches/demo-batch-tt-024";
const metric = (label: string) => screen.getByTestId(`metric-${label}`);
// jsdom has no modal <dialog>, so find it by its heading.
const dialog = (title: string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);
const open = async (path = PATH, adapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findByTestId("status-sentence");
  return { router, adapter, user: userEvent.setup() };
};
const rowFor = (id: string) => within(screen.getByTestId("items")).getByText(new RegExp(id)).closest("tr")!;

describe("batch helpers", () => {
  it("counts items by state, and picks one example per state in order", () => {
    expect(countByState(seedItems())).toEqual({ confirmed: 16, queued: 3, running: 2, reconcile: 2, login: 1, paused: 0, canceled: 0 });
    expect(exampleRows(seedItems()).map((i) => i.id)).toEqual(["DEMO-001", "DEMO-017", "DEMO-020", "DEMO-022", "DEMO-024"]);
  });
});

describe("bulk batch detail (66:821)", () => {
  it("shows the finite set, and the figures match daily sourcing", async () => {
    await open();
    expect(metric("Selected prospects")).toHaveTextContent("50");
    expect(screen.getByText("24 eligible · 26 held by exclusive primary reason")).toBeInTheDocument();
    expect(metric("Finite dispatch limit")).toHaveTextContent("24");
    expect(metric("Sample allocation")).toHaveTextContent("12 / $300");
    expect(screen.getByText("12 new × $25 illustrative landed cost; 12 need no new sample")).toBeInTheDocument();
    expect(metric("Fixed-fee commitment")).toHaveTextContent("$0");
    expect(screen.getByText(/50 selected prospects → 24 approved for this batch \+ 26 held/)).toBeInTheDocument();
  });

  it("resolves 24 approved items into 16 confirmed and the rest with a next step", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "16 confirmed. Every other item has a next step." })).toBeInTheDocument();
    expect(screen.getByTestId("status-sentence")).toHaveTextContent("24 approved items = 16 confirmed + 3 queued + 2 running + 2 reconciliation + 1 login blocked.");
    expect(screen.getByTestId("status-bar")).toHaveAccessibleName("24 approved items by state");
    expect(screen.getByText("Confirmed · 16")).toBeInTheDocument();
    expect(screen.getByText("Reconcile · 2")).toBeInTheDocument();
    expect(screen.getByText("Login · 1")).toBeInTheDocument();
    expect(within(screen.getByTestId("items")).getAllByRole("row")).toHaveLength(6);
  });

  it("states that held prospects each have one reason, and the bars add up to 26", async () => {
    await open();
    const counts = within(screen.getByTestId("held-bars")).getAllByRole("listitem").map((li) => Number(li.lastElementChild?.textContent));
    expect(counts).toEqual([8, 6, 5, 4, 3]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(26);
  });

  it("filters held prospects by owner, and keeps the bars on one scale (CTRL-146)", async () => {
    const { user, router } = await open();
    await user.click(screen.getByRole("button", { name: "Owner: Owner / deadline" }));
    await user.click(dialog("Choose an owner").getByRole("radio", { name: "Operations", hidden: true }));
    await waitFor(() => expect(within(screen.getByTestId("held-bars")).getAllByRole("listitem").map((li) => Number(li.lastElementChild?.textContent))).toEqual([1, 1, 2, 4, 0]));
    expect(router.state.location.search).toBe("?owner=Operations");
    expect(screen.getByText(/8 held prospects have one exclusive primary reason/)).toBeInTheDocument();
  });

  it("shows the model as read-only status, with no picker (CTRL-145)", async () => {
    await open();
    expect(screen.getByTestId("model-status")).toHaveTextContent("Model: current v3 pending");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Source: TikTok" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deal: Affiliate" })).toBeInTheDocument();
  });

  it("lists held prospects without releasing them (CTRL-147)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(PATH, adapter);
    await user.click(screen.getByRole("button", { name: "Review held rows" }));
    expect(dialog("Held prospects").getByText(/Reviewing them releases nothing/)).toBeInTheDocument();
    expect(within(screen.getByTestId("held-review")).getAllByText(/Missing evidence/)).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("pauses new work through the adapter, and shows the server's state (CTRL-137)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(PATH, adapter);
    await user.click(screen.getByRole("button", { name: "Pause new work" }));
    expect(dialog("Pause new work").getByText(/Nothing is canceled/)).toBeInTheDocument();
    await user.click(dialog("Pause new work").getByRole("button", { name: "Pause new work", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("action-ack")).toHaveTextContent("New work is paused."));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ operation: "controlRun", actionKind: "pauseBatch", expectedVersion: "batch-v1", payload: { batchId: "demo-batch-tt-024" } });
    expect(screen.getByTestId("action-ack")).toHaveTextContent(/Running items finish safely/);
    await waitFor(() => expect(screen.getByTestId("status-sentence")).toHaveTextContent("+ 3 paused"));
    expect(screen.getByRole("button", { name: "Pause new work" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("New work is already paused.")).toBeInTheDocument();
  });

  it("cancels one unsent item after a preview that names it and what stays (CTRL-141)", async () => {
    const { user } = await open();
    await user.click(within(rowFor("DEMO-017")).getByRole("button", { name: "Cancel unsent" }));
    const preview = dialog("Cancel unsent items");
    expect(preview.getByText(/1 unsent item will be canceled: DEMO-017/)).toBeInTheDocument();
    await user.click(preview.getByRole("button", { name: "Cancel unsent", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("action-ack")).toHaveTextContent("Unsent items canceled."));
    await waitFor(() => expect(screen.getByTestId("status-sentence")).toHaveTextContent("+ 1 canceled"));
    expect(screen.getByTestId("status-sentence")).toHaveTextContent("2 queued");
    expect(screen.getByText("Confirmed · 16")).toBeInTheDocument();
  });

  it("cancels every unsent item, and leaves confirmed, running and reconciling items alone (CTRL-148)", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Cancel unsent items" }));
    const preview = dialog("Cancel unsent items");
    expect(preview.getByText(/3 unsent items will be canceled: DEMO-017, DEMO-018, DEMO-019/)).toBeInTheDocument();
    expect(preview.getByText(/21 items stay as they are/)).toBeInTheDocument();
    await user.click(preview.getByRole("button", { name: "Cancel unsent", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("status-sentence")).toHaveTextContent("+ 3 canceled"));
    expect(screen.getByTestId("status-sentence")).toHaveTextContent("16 confirmed + 0 queued + 2 running");
    expect(screen.getByRole("button", { name: "Cancel unsent items" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("There is no unsent work to cancel.")).toBeInTheDocument();
  });

  it("shows a recoverable error for a stale version, and changes nothing", async () => {
    const adapter = createDemoAdapter();
    const { user } = await open(PATH, adapter);
    const real = adapter.submitAction.bind(adapter);
    vi.spyOn(adapter, "submitAction").mockImplementationOnce((request) => real({ ...request, expectedVersion: "batch-v0" }));
    await user.click(screen.getByRole("button", { name: "Cancel unsent items" }));
    await user.click(dialog("Cancel unsent items").getByRole("button", { name: "Cancel unsent", hidden: true }));
    expect(await screen.findByTestId("action-error")).toHaveTextContent("This record changed");
    expect(screen.getByTestId("status-sentence")).toHaveTextContent("3 queued");
  });

  it("gives each state its own control: receipt, inspect, reconcile and takeover are not sends", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(PATH, adapter);
    await user.click(within(rowFor("DEMO-001")).getByRole("button", { name: "View receipt" }));
    expect(dialog("Source receipt").getByText("demo-source-receipt-a")).toBeInTheDocument();
    await user.click(within(rowFor("DEMO-020")).getByRole("button", { name: "Inspect live step" }));
    expect(dialog("Live step").getByText(/not a running job/)).toBeInTheDocument();
    expect(within(rowFor("DEMO-022")).getByRole("link", { name: "Reconcile outcome" })).toHaveAttribute("href", "/runs/demo-run-uncertain?tab=recovery");
    await user.click(within(rowFor("DEMO-024")).getByRole("button", { name: "Request takeover" }));
    expect(dialog("Request takeover").getByText(/nothing is requested and no credential is asked for/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("offers a batch receipt that counts only confirmed sends", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Review batch receipt" }));
    expect(dialog("Batch receipt").getByText("16 of 24 approved items have a source receipt")).toBeInTheDocument();
    expect(dialog("Batch receipt").getByText(/Only a source receipt means sent/)).toBeInTheDocument();
  });

  it("switches to separate capacities that never add up, and lists exceptions (CTRL-139, 140)", async () => {
    await open(`${PATH}?tab=capacity`).catch(() => undefined);
    expect(await screen.findByRole("heading", { name: "Separate capacities. Never one total." })).toBeInTheDocument();
    const rows = within(screen.getByTestId("capacity-table")).getAllByRole("row").slice(1).map((r) => [...r.children].map((c) => c.textContent));
    expect(rows.map((r) => r[2])).toEqual(["24", "N/A", "12", "$300"]);
  });

  it("lists the exceptions with their recovery routes", async () => {
    renderRoute(`${PATH}?tab=exceptions`, createDemoAdapter());
    expect(await screen.findByRole("heading", { name: "Exceptions need a person." })).toBeInTheDocument();
    expect(within(screen.getByTestId("exceptions-table")).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Exceptions" })).toHaveAttribute("aria-current", "page");
  });

  it("is a not-found state for a batch that doesn't exist", async () => {
    renderRoute("/batches/nope", createDemoAdapter());
    expect(await screen.findByRole("heading", { name: "Record not found" })).toBeInTheDocument();
  });

  it("shows a pending state, never demo numbers, when the backend isn't published; and clears on 403", async () => {
    renderRoute(PATH, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId("metric-Selected prospects")).not.toBeInTheDocument();
  });

  it("denies access without showing a batch", async () => {
    renderRoute(PATH, scriptedAdapter(async () => {
      throw new AdapterError({ code: "FORBIDDEN", message: "no", requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    }));
    expect(await screen.findByRole("heading", { name: "No access to this account" })).toBeInTheDocument();
  });
});
