import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FardaAdapter } from "@/adapter/adapter";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { AdapterError } from "@/adapter/errors";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { renderRoute } from "@/test/renderWithAdapter";

const open = async (path: string, adapter: FardaAdapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findAllByRole("heading", { level: 2 });
  return { router, user: userEvent.setup(), adapter };
};
const status = () => screen.getByTestId("approval-status");
const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("approval detail", () => {
  it("shows the exact payload, version, role and independent channels", async () => {
    await open("/approvals/demo-approval-exact");
    expect(status()).toHaveTextContent("Pending");
    expect(screen.getByTestId("approval-version")).toHaveTextContent("Version 1");
    expect(screen.getByText("Assigned operator")).toBeInTheDocument();
    expect(screen.getByText("demo-handle-one")).toBeInTheDocument();
    expect(screen.getByText("Instagram, TikTok")).toBeInTheDocument();
    expect(screen.getByText("Website")).toBeInTheDocument();
    expect(screen.getByText("15% per eligible sale")).toBeInTheDocument();
    expect(screen.getByTestId("exact-message")).toHaveTextContent("per-sale commission");
  });

  it("shows Figma's archived sample read-only, with nothing to approve or send", async () => {
    await open("/approvals/demo-approval-042");
    expect(screen.getByText("Historical approval snapshot")).toBeInTheDocument();
    expect(screen.getByText("APR-0042")).toBeInTheDocument();
    expect(screen.getByText("30 Oct · 18:00 PT")).toBeInTheDocument();
    expect(screen.getByText("No message has been sent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve this version" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send approved action" })).not.toBeInTheDocument();
  });

  it("offers a decision here as well as in Slack, on current records", async () => {
    await open("/approvals/demo-approval-exact");
    expect(screen.getByRole("heading", { name: "Decide here" })).toBeInTheDocument();
    expect(screen.getByText("Decide here or in Slack.")).toBeInTheDocument();
    expect(screen.getByText(/The first decision recorded wins/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open approval channel" })).toBeInTheDocument();
  });

  it("refuses a second decision on a version already decided elsewhere", async () => {
    const adapter = createDemoAdapter();
    const { user } = await open("/approvals/demo-approval-exact", adapter);
    await adapter.submitAction({ schemaVersion: "x", operation: "decideApproval", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" }, actionKind: "decideApproval", entityRefs: [], expectedVersion: "v1", approvalRef: "demo-approval-exact", manifestRef: null, idempotencyKey: "from-slack", payload: { decision: "approved" }, requestId: "r" });
    await user.click(button("Approve this version"));
    expect(await screen.findByTestId("action-error")).toHaveTextContent("already decided");
    await waitFor(() => expect(status()).toHaveTextContent("Approved, not sent"));
  });

  it("marks the selected queue item, and links to the others", async () => {
    await open("/approvals/demo-approval-042");
    expect(screen.getByRole("link", { name: /@routine\.with\.ella/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /@mira\.moves/ })).toHaveAttribute("href", "/approvals/demo-approval-exact");
  });

  it("explains a missing source link rather than inventing one", async () => {
    const { user } = await open("/approvals/demo-approval-042");
    await user.click(button("Open approval channel"));
    expect(screen.getByText(/No verified link is available/)).toBeInTheDocument();
  });

  it("goes approved, then sent only with a receipt", async () => {
    const { user } = await open("/approvals/demo-approval-exact");
    await user.click(button("Approve this version"));
    await waitFor(() => expect(status()).toHaveTextContent("Approved, not sent"));
    expect(status()).not.toHaveTextContent(/Sent,/);
    expect(screen.queryByTestId("source-receipt")).not.toBeInTheDocument();

    await user.click(button("Send approved action"));
    expect(await screen.findByTestId("source-receipt")).toHaveTextContent("synthetic demo receipt");
    expect(status()).toHaveTextContent("Sent, source receipt on file");
    expect(screen.queryByRole("button", { name: "Send approved action" })).not.toBeInTheDocument();
  });

  it("FE04-02: the page shows the same approval, run and receipt refs end to end", async () => {
    const { user } = await open("/approvals/demo-approval-exact");
    await user.click(button("Approve this version"));
    await waitFor(() => expect(status()).toHaveTextContent("Approved, not sent"));
    await user.click(button("Send approved action"));
    expect(await screen.findByTestId("source-receipt")).toHaveTextContent("demo-source-receipt-demo-approval-exact");
    expect(screen.getByRole("link", { name: "Open run" })).toHaveAttribute("href", "/runs/demo-run-exact?tab=approval");
  });

  it("FE04-04: a founder can decide the founder-only commitment, and approving it still sends and pays nothing", async () => {
    const { user } = await open("/approvals/demo-approval-founder", createDemoAdapter({ actorRole: "founder" }));
    await user.click(button("Approve this version"));
    await waitFor(() => expect(status()).toHaveTextContent("Approved, not sent"));
    expect(status()).not.toHaveTextContent(/Paid|Sent,/);
    expect(screen.queryByTestId("source-receipt")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pay/ })).not.toBeInTheDocument();
  });

  it("explains a policy block, stays pending, and sends nothing", async () => {
    const { user } = await open("/approvals/demo-approval-fee");
    expect(screen.getByText("$500")).toBeInTheDocument();
    await user.click(button("Approve this version"));
    const error = await screen.findByTestId("action-error");
    expect(error).toHaveTextContent("commission-only");
    expect(error).toHaveTextContent("Nothing was sent.");
    expect(error).toHaveFocus();
    expect(status()).toHaveTextContent("Pending");
  });

  it("requires a reason to reject, and keeps other edits when that fails", async () => {
    const { user } = await open("/approvals/demo-approval-exact");
    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "Draft in progress");
    await user.click(button("Reject"));
    const reason = screen.getByLabelText("Reason");
    expect(reason).toHaveAccessibleDescription("Enter a reason for rejecting.");
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Message")).toHaveValue("Draft in progress");
    expect(status()).toHaveTextContent("Pending");

    await user.type(reason, "Wrong creator.");
    await user.click(button("Reject"));
    await waitFor(() => expect(status()).toHaveTextContent("Rejected"));
    expect(screen.getByText("Wrong creator.")).toBeInTheDocument();
  });

  it("maps a server field error to the field and keeps the draft", async () => {
    const { user } = await open("/approvals/demo-approval-exact");
    await user.click(button("Save as new version"));
    expect(await screen.findByLabelText("Message")).toHaveAccessibleDescription("Change the message, or approve it as written.");
  });

  it("makes an edit a new version that needs its own approval", async () => {
    const { user } = await open("/approvals/demo-approval-exact");
    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "Edited words.");
    await user.click(button("Save as new version"));
    await waitFor(() => expect(screen.getByTestId("approval-version")).toHaveTextContent("Version 2"));
    expect(status()).toHaveTextContent("Pending");
    expect(screen.getByTestId("exact-message")).toHaveTextContent("Edited words.");
    expect(button("Approve this version")).toBeInTheDocument();
  });

  it("on a conflict, applies nothing and shows what changed before a fresh decision", async () => {
    const { user } = await open("/approvals/demo-approval-conflict");
    await user.click(button("Approve this version"));
    expect(await screen.findByTestId("action-error")).toHaveTextContent("This record changed");
    const changes = await screen.findByTestId("version-changes");
    expect(changes).toHaveTextContent("Commission: 15% → 20%");
    expect(screen.getByTestId("approval-version")).toHaveTextContent("Version 2");
    expect(status()).toHaveTextContent("Pending");
    await user.click(button("Approve this version"));
    await waitFor(() => expect(status()).toHaveTextContent("Approved, not sent"));
  });

  it("explains an expired approval and blocks decisions, while keeping the button focusable", async () => {
    const { user } = await open("/approvals/demo-approval-expired");
    expect(status()).toHaveTextContent("Expired");
    const approve = button("Approve this version");
    expect(approve).toHaveAttribute("aria-disabled", "true");
    expect(approve).toHaveAccessibleDescription(/expired/);
    await user.click(approve);
    expect(screen.queryByTestId("action-error")).not.toBeInTheDocument();
  });

  it("shows why a role can't decide, and the page stays readable", async () => {
    await open("/approvals/demo-approval-founder");
    expect(screen.getByText("Founder")).toBeInTheDocument();
    expect(button("Approve this version")).toHaveAccessibleDescription(/role/);
    expect(screen.getByText("Pay accepted historical fee")).toBeInTheDocument();
  });

  it("does not double-submit on a double click", async () => {
    const adapter = createDemoAdapter({ latencyMs: 5 });
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open("/approvals/demo-approval-exact", adapter);
    await user.dblClick(button("Approve this version"));
    await waitFor(() => expect(status()).toHaveTextContent("Approved, not sent"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("uses one idempotency key for a retried action, and a new one for a changed action", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open("/approvals/demo-approval-fee", adapter);
    await user.click(button("Approve this version"));
    await screen.findByTestId("action-error");
    await user.click(button("Approve this version"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "Changed.");
    await user.click(button("Save as new version"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    const keys = spy.mock.calls.map(([request]) => request.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("clears the page when an action reports an expired session", async () => {
    const adapter = createDemoAdapter();
    vi.spyOn(adapter, "submitAction").mockRejectedValue(new AdapterError({ code: "SESSION_EXPIRED", message: "Your session expired.", requestId: null, correlationId: null, retryable: false, retryAfterMs: null }));
    const { user } = await open("/approvals/demo-approval-exact", adapter);
    await user.click(button("Approve this version"));
    await waitFor(() => expect(screen.queryByTestId("exact-message")).not.toBeInTheDocument());
  });

  it("shows not-found with a parent link, and a neutral denial with no record details", async () => {
    await open("/approvals/does-not-exist");
    expect(screen.getByRole("heading", { name: "Record not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to approvals" })).toHaveAttribute("href", "/approvals");
  });

  it("denies a forbidden record without leaking it", async () => {
    await open("/approvals/demo-approval-forbidden");
    expect(screen.getByRole("heading", { name: "No access to this account" })).toBeInTheDocument();
    expect(screen.queryByTestId("exact-message")).not.toBeInTheDocument();
  });

  it("renders a live environment as integration pending, never demo data", async () => {
    renderRoute("/approvals/demo-approval-exact", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("exact-message")).not.toBeInTheDocument();
  });
});

describe("approval history (CTRL-026 to CTRL-028)", () => {
  it("opens each version read-only, with its decision and no decision controls", async () => {
    const { user, router } = await open("/approvals/demo-approval-history");
    await user.click(screen.getByRole("link", { name: "Approval history" }));
    await screen.findByRole("heading", { name: "Approval history" });
    expect(within(within(screen.getByRole("main")).getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("link", { name: "View historical approval v1" }));
    expect(await screen.findByRole("heading", { name: "Version v1" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("no new authority");
    expect(screen.getByText("Tone the opening down.")).toBeInTheDocument();
    expect(screen.getByText("demo-decision-receipt-h1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(router.state.location.search).toBe("?version=v1");
  });

  it("deep-links to a version, and handles a version that doesn't exist", async () => {
    await open("/approvals/demo-approval-history?version=v9");
    expect(screen.getByRole("heading", { name: "Version not found" })).toBeInTheDocument();
  });
});

describe("agent run approval (CTRL-042, CTRL-043)", () => {
  it("pauses unsent work only and reports the acknowledged scope", async () => {
    const { user } = await open("/runs/demo-run-batch?tab=approval");
    expect(screen.getByTestId("run-counts")).toHaveTextContent("Confirmed: 1 · Failed: 1 · Held: 1 · Unsent: 2");
    await user.click(button("Pause run"));
    expect(await screen.findByTestId("pause-ack")).toHaveTextContent("confirmed actions stay on record");
    expect(screen.getByTestId("run-counts")).toHaveTextContent("Confirmed: 1 · Failed: 1 · Held: 1 · Paused: 2");
    expect(screen.getByText("demo-source-receipt-a")).toBeInTheDocument();
    expect(button("Pause run")).toHaveAttribute("aria-disabled", "true");
  });

  it("offers no invented Slack link", async () => {
    const { user } = await open("/runs/demo-run-approval?tab=approval");
    await user.click(button("View historical approval in Slack"));
    expect(screen.getByText(/No verified link is available/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Slack/ })).not.toBeInTheDocument();
  });

  it("shows the hourly monitor variant when no tab is given, and says an approval run isn't one", async () => {
    renderRoute("/runs/demo-run-batch", createDemoAdapter());
    expect(await screen.findByRole("alert")).toHaveTextContent("This isn't an hourly monitoring run.");
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});

describe("unknown-outcome recovery (CTRL-044 to CTRL-047)", () => {
  it("blocks recording and retrying until the source is checked, then records the found receipt", async () => {
    const { user } = await open("/runs/demo-run-uncertain?tab=recovery");
    const record = button("Record confirmed sent");
    expect(record).toHaveAccessibleDescription(/independent evidence/);
    await user.click(record);
    expect(screen.getByTestId("run-status")).toHaveTextContent("Outcome unknown");

    await user.click(button("Check the source"));
    expect(await screen.findByText(/Source receipt demo-source-receipt-prior found/)).toBeInTheDocument();
    await waitFor(() => expect(button("Record confirmed sent")).not.toHaveAttribute("aria-disabled"));
    expect(button("Request a fresh attempt")).toHaveAttribute("aria-disabled", "true");

    await user.click(button("Record confirmed sent"));
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Sent, source receipt on file"));
    expect(screen.getByText("demo-source-receipt-prior")).toBeInTheDocument();
  });

  it("queues a fresh attempt only when the source proves the first never ran, without calling it sent", async () => {
    const { user } = await open("/runs/demo-run-unsent?tab=recovery");
    await user.click(button("Check the source"));
    expect(await screen.findByText(/never ran/)).toBeInTheDocument();
    await waitFor(() => expect(button("Request a fresh attempt")).not.toHaveAttribute("aria-disabled"));
    expect(button("Record confirmed sent")).toHaveAttribute("aria-disabled", "true");
    await user.click(button("Request a fresh attempt"));
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Queued, not sent"));
    expect(screen.getByText("Attempt")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("keeps both paths blocked when the source shows nothing, and acknowledges Keep paused from the server", async () => {
    const { user } = await open("/runs/demo-run-noevidence?tab=recovery");
    await user.click(button("Check the source"));
    expect(await screen.findByText(/no evidence either way/)).toBeInTheDocument();
    expect(button("Record confirmed sent")).toHaveAttribute("aria-disabled", "true");
    expect(button("Request a fresh attempt")).toHaveAttribute("aria-disabled", "true");
    await user.click(button("Keep paused"));
    expect(await screen.findByTestId("pause-ack")).toBeInTheDocument();
    expect(screen.getByTestId("run-status")).toHaveTextContent("Outcome unknown");
    expect(button("Keep paused")).toHaveAccessibleDescription("Already paused.");
  });

  it("links to the approval history", async () => {
    await open("/runs/demo-run-uncertain?tab=recovery");
    expect(screen.getByRole("link", { name: "View approval history" })).toHaveAttribute("href", "/approvals/demo-approval-uncertain?view=history");
  });

  it("carries an uncertain send from the approval page into recovery", async () => {
    const { user, router } = await open("/approvals/demo-approval-uncertain");
    await user.click(button("Approve this version"));
    await user.click(await screen.findByRole("button", { name: "Send approved action" }));
    await waitFor(() => expect(status()).toHaveTextContent("Outcome unknown"));
    expect(screen.queryByRole("button", { name: "Send approved action" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Open recovery" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/demo-run-uncertain"));
    expect(router.state.location.search).toBe("?tab=recovery");
    expect(await screen.findByTestId("run-status")).toHaveTextContent("Outcome unknown");
  });

  it("shows not-found for a missing run", async () => {
    await open("/runs/nope?tab=recovery");
    expect(screen.getByRole("heading", { name: "Record not found" })).toBeInTheDocument();
  });
});

describe("agent run from Figma", () => {
  it("shows steps with text statuses, and the current lifecycle stage", async () => {
    await open("/runs/demo-run-approval?tab=approval");
    expect(screen.getByRole("heading", { level: 1, name: "Social Cat, step by step." })).toBeInTheDocument();
    expect(screen.getAllByText("Complete")).toHaveLength(3);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    expect(screen.getAllByText("Blocked")).toHaveLength(3);
    expect(screen.getByText("Terms & brief").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("tells the operator what takeover does, and starts nothing", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open("/runs/demo-run-uncertain?tab=recovery", adapter);
    await user.click(button("Take over"));
    expect(screen.getByText(/No success is inferred from a timeout/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("demo entry points", () => {
  it("lists labeled scenarios in demo, and the plain index in live", async () => {
    renderRoute("/approvals", createDemoAdapter());
    expect(await screen.findByRole("link", { name: "Exact approval, then send" })).toHaveAttribute("href", "/approvals/demo-approval-exact");
  });

  it("offers no demo records on a live environment", async () => {
    renderRoute("/approvals", createLiveAdapter("sandbox"));
    expect(await screen.findByText(/Screens in this section/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Exact approval, then send" })).not.toBeInTheDocument();
  });
});
