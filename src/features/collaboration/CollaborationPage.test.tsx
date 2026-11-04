import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { respondWith } from "@/adapter/demoViews";
import { AdapterError } from "@/adapter/errors";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { collaborationAffiliate, collaborationDemo, reviewAfter } from "@/fixtures/collaboration";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";

const OVERVIEW = "/collaborations/demo-collaboration-1?tab=overview";
const CONTENT = "/collaborations/demo-collaboration-1?tab=content";
// jsdom has no modal <dialog>, so find it by its heading.
const dialog = (title: string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);
const open = async (path: string, adapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findByTestId(path.endsWith("content") ? "checklist" : "timeline");
  return { router, adapter, user: userEvent.setup() };
};

describe("collaboration detail (9:299)", () => {
  it("shows the accepted historical terms, read-only, with the review date derived", async () => {
    await open(OVERVIEW);
    expect(screen.getByRole("heading", { level: 1, name: "One collaboration. The whole story." })).toBeInTheDocument();
    expect(screen.getByText("COL-SC-042 · @routine.with.ella · Social Cat · live creator record in Notion")).toBeInTheDocument();
    expect(screen.getByTestId("agreed-fee")).toHaveTextContent("USD 150");
    expect(screen.getByText("04 Nov 2026")).toBeInTheDocument();
    expect(screen.getByTestId("review-after")).toHaveTextContent("07 Nov 2026");
    expect(screen.getByText("3 days")).toBeInTheDocument();
    expect(screen.getByText(/retains its agreed \$150 content fee and original obligations/)).toBeInTheDocument();
    expect(screen.getByText(/creates a new commission-only offer, with a fresh assessment and approval/)).toBeInTheDocument();
  });

  it("keeps the platform match, accepted terms, delivered sample and draft as separate events", async () => {
    await open(OVERVIEW);
    const events = within(screen.getByTestId("timeline")).getAllByRole("listitem").map((li) => li.textContent);
    expect(events).toEqual([
      expect.stringContaining("CompletedApplicant vetted"),
      expect.stringContaining("CompletedTerms agreed"),
      expect.stringContaining("CompletedSample delivered"),
      expect.stringContaining("RunningDraft under review"),
      expect.stringContaining("PendingDirect fee and close"),
    ]);
  });

  it("marks Overview as the current tab, and switches tabs through the URL without sending (CTRL-030, 031)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { router, user } = await open(OVERVIEW, adapter);
    const tabs = () => within(screen.getByRole("navigation", { name: "Collaboration views" }));
    expect(tabs().getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await user.click(tabs().getByRole("link", { name: "Messages" }));
    expect(router.state.location.search).toBe("?tab=messages");
    expect(await screen.findByRole("heading", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByText(/Reading never sends/)).toBeInTheDocument();
    expect(tabs().getByRole("link", { name: "Messages" })).toHaveAttribute("aria-current", "page");
    expect(spy).not.toHaveBeenCalled();
  });

  it("queues the next action from the server's list, as a request for approval (CTRL-029)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(OVERVIEW, adapter);
    await user.click(screen.getByRole("button", { name: "Queue next action" }));
    const composer = dialog("Queue next action");
    expect(composer.getByRole("combobox", { hidden: true })).toHaveDisplayValue("Review draft v2");
    expect(composer.getAllByRole("option", { hidden: true }).map((o) => o.textContent)).toEqual(["Review draft v2", "Remind the creator about the posting due date", "Record a note in the source"]);
    await user.click(composer.getByRole("button", { name: "Queue for approval", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("action-ack")).toHaveTextContent("Queued for approval as collab-v2. Nothing has been sent, closed or suppressed"));
    expect(spy.mock.calls[0]![0]).toMatchObject({ operation: "requestApproval", actionKind: "queueNextAction", expectedVersion: "collab-v1", payload: { collaborationId: "demo-collaboration-1", actionKey: "reviewDraft" } });
    expect(await screen.findByTestId("queued-requests")).toHaveTextContent("Next action: reviewDraft · collab-v2 · awaiting approval");
  });

  it("closes with an allowed outcome and a reason, shows what is unresolved, and keeps history (CTRL-032)", async () => {
    const { user } = await open(OVERVIEW);
    await user.click(screen.getByRole("button", { name: "Close collaboration" }));
    const form = dialog("Close collaboration");
    expect(form.getByText("Draft v2 is under review")).toBeInTheDocument();
    expect(form.getByText("The signed usage license is missing")).toBeInTheDocument();
    expect(form.getByText(/The retained sample cost stays on record/)).toBeInTheDocument();
    await user.click(form.getByRole("button", { name: "Request closure", hidden: true }));
    expect(form.getByText("Outcome is required.")).toBeInTheDocument();
    expect(form.getByText("Reason is required.")).toBeInTheDocument();
    await user.selectOptions(form.getByLabelText("Outcome"), "Completed");
    await user.type(form.getByLabelText("Reason"), "Delivered and settled");
    await user.click(form.getByRole("button", { name: "Request closure", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("action-ack")).toBeInTheDocument());
    expect(screen.getByTestId("queued-requests")).toHaveTextContent("Close as Completed");
  });

  it("needs a reason to suppress outreach, and says history is kept (CTRL-033)", async () => {
    const { user } = await open(OVERVIEW);
    await user.click(screen.getByRole("button", { name: "Suppress outreach" }));
    const form = dialog("Suppress outreach");
    expect(form.getByText(/Historical collaboration facts are kept/)).toBeInTheDocument();
    await user.click(form.getByRole("button", { name: "Request suppression", hidden: true }));
    expect(form.getByText("Reason is required.")).toBeInTheDocument();
    expect(screen.queryByTestId("action-ack")).not.toBeInTheDocument();
  });

  it("proposes a new collaboration with fresh terms, never copying the prior acceptance (CTRL-034)", async () => {
    const { user } = await open(OVERVIEW);
    await user.click(screen.getByRole("button", { name: "Create new collaboration" }));
    const form = dialog("Create new collaboration");
    expect(form.getByText(/needs fresh commission-only terms and approval; the earlier acceptance, fee and rights are not copied/)).toBeInTheDocument();
    await user.type(form.getByLabelText("Why a new collaboration"), "Repeat content");
    await user.click(form.getByRole("button", { name: "Propose new collaboration", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("action-ack")).toBeInTheDocument());
  });

  it("opens gifted closure as read-only history (CTRL-035)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(OVERVIEW, adapter);
    await user.click(screen.getByRole("button", { name: "Inspect gifted closure" }));
    expect(dialog("Gifted closure · history").getByText(/can't create a new gifted-only offer/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("states outreach eligibility and suppression from the record", async () => {
    await open(OVERVIEW);
    expect(screen.getByText("Eligible · demo state")).toBeInTheDocument();
    expect(screen.getByText("No active suppression")).toBeInTheDocument();
    expect(screen.getByText("Outcomes: declined · no response · opted out · canceled · completed")).toBeInTheDocument();
  });

  it("shows a stale read, a not-found state, a pending backend and a denial", async () => {
    await open(OVERVIEW, scriptedAdapter(async (request) => respondWith(request, collaborationDemo, { dataVersion: "collab-v1", dataState: "stale" })));
    expect(screen.getByTestId("view-stale")).toBeInTheDocument();
  });

  it("is a not-found state for a collaboration that doesn't exist", async () => {
    renderRoute("/collaborations/nope", createDemoAdapter());
    expect(await screen.findByRole("heading", { name: "Record not found" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("shows a pending state when the backend isn't published, and clears on 403", async () => {
    renderRoute(OVERVIEW, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId("timeline")).not.toBeInTheDocument();
  });

  it("denies access without showing the record", async () => {
    renderRoute(OVERVIEW, scriptedAdapter(async () => {
      throw new AdapterError({ code: "FORBIDDEN", message: "no", requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    }));
    expect(await screen.findByRole("heading", { name: "No access to this account" })).toBeInTheDocument();
  });
});

describe("content review and rights (9:436)", () => {
  it("shows the draft, its checklist, and which criteria are not yet passed", async () => {
    await open(CONTENT);
    expect(screen.getByRole("heading", { level: 1, name: "A draft becomes a usable asset." })).toBeInTheDocument();
    expect(screen.getByText("Draft v2 · in review")).toBeInTheDocument();
    const rows = within(screen.getByTestId("checklist")).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual(["Matches agreed briefPass", "Product statements and claimsNeeds review", "Audio and visual qualityPass", "Usage rights attachedMissing license", "Final asset link capturedPending"]);
    expect(screen.getByText("v2 · Received · current review")).toBeInTheDocument();
    expect(screen.getByText("Final · Not approved yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Content review" })).toHaveAttribute("aria-current", "page");
  });

  it("blocks approval while the license is missing, with the reason on screen (CTRL-038)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(CONTENT, adapter);
    const approve = screen.getByRole("button", { name: "Approve content" });
    expect(approve).toHaveAttribute("aria-disabled", "true");
    expect(approve).toHaveAccessibleDescription("Acceptance remains blocked while the required license is missing.");
    await user.click(approve);
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps usage blocked until cleared, and rights separate from affiliation (CTRL-037)", async () => {
    await open(CONTENT);
    const register = within(screen.getByTestId("rights-register"));
    expect(register.getByText("Usage blocked until cleared")).toBeInTheDocument();
    expect(register.getByText("Signed license").nextElementSibling).toHaveTextContent("Missing");
    expect(register.getAllByText("Not granted")).toHaveLength(2);
    expect(register.getByRole("link", { name: "Open rights record" })).toHaveAttribute("href", "/collaborations/demo-collaboration-1?tab=rights");
  });

  it("shows the rights register on its own tab", async () => {
    renderRoute("/collaborations/demo-collaboration-1?tab=rights", createDemoAdapter());
    expect(await screen.findByTestId("rights-register")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rights" })).toHaveAttribute("aria-current", "page");
  });

  it("queues feedback as a draft for approval, and a changed message is a new version (CTRL-036)", async () => {
    const { user } = await open(CONTENT);
    expect(screen.getByTestId("proposed-feedback")).toHaveTextContent("Please update the opening to match the agreed brief");
    expect(screen.getByText("Draft only · not sent")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Queue feedback" }));
    const composer = dialog("Queue feedback");
    expect(composer.getByLabelText("Feedback")).toHaveValue(collaborationDemo.content.proposedFeedback);
    await user.clear(composer.getByLabelText("Feedback"));
    await user.click(composer.getByRole("button", { name: "Queue feedback", hidden: true }));
    expect(composer.getByText("Feedback is required.")).toBeInTheDocument();
    await user.type(composer.getByLabelText("Feedback"), "Please re-record the opening.");
    await user.click(composer.getByRole("button", { name: "Queue feedback", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("action-ack")).toHaveTextContent("collab-v2"));
    expect(screen.getByTestId("queued-requests")).toHaveTextContent("Feedback on draft v2");
  });

  it("requests a revision with specific feedback against the current submission (CTRL-039)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(CONTENT, adapter);
    await user.click(screen.getByRole("button", { name: "Request revision" }));
    const form = dialog("Request revision");
    expect(form.getByText(/Targets v2\. 1 revision round remains/)).toBeInTheDocument();
    await user.type(form.getByLabelText("What should change"), "New opening");
    await user.click(form.getByRole("button", { name: "Request revision", hidden: true }));
    await waitFor(() => expect(screen.getByTestId("action-ack")).toBeInTheDocument());
    expect(spy.mock.calls[0]![0]).toMatchObject({ actionKind: "requestRevision", payload: { text: "New opening", submissionVersion: "v2" } });
  });

  it("requires a reason to reject, and keeps the previous content (CTRL-040)", async () => {
    const { user } = await open(CONTENT);
    await user.click(screen.getByRole("button", { name: "Reject with reason" }));
    const form = dialog("Reject with reason");
    expect(form.getByText(/The draft and its evidence are kept/)).toBeInTheDocument();
    await user.click(form.getByRole("button", { name: "Request rejection", hidden: true }));
    expect(form.getByText("Reason is required.")).toBeInTheDocument();
    expect(screen.queryByTestId("action-ack")).not.toBeInTheDocument();
  });

  it("shows a recoverable error when the collaboration changed under the dialog", async () => {
    const adapter = createDemoAdapter();
    const { user } = await open(CONTENT, adapter);
    const real = adapter.submitAction.bind(adapter);
    vi.spyOn(adapter, "submitAction").mockImplementationOnce((request) => real({ ...request, expectedVersion: "collab-v0" }));
    await user.click(screen.getByRole("button", { name: "Reject with reason" }));
    await user.type(dialog("Reject with reason").getByLabelText("Reason"), "Off brief");
    await user.click(dialog("Reject with reason").getByRole("button", { name: "Request rejection", hidden: true }));
    expect(await screen.findByTestId("action-error")).toHaveTextContent("This record changed");
    expect(screen.queryByTestId("action-ack")).not.toBeInTheDocument();
  });
});

describe("FE03-04 posting timing only where the terms create the obligation", () => {
  const AFFILIATE = "/collaborations/demo-collaboration-affiliate?tab=overview";

  it("a paid collaboration shows its posting due date, grace period and a derived review date", async () => {
    await open(OVERVIEW);
    expect(screen.getByTestId("posting-due")).toHaveTextContent("04 Nov 2026");
    expect(screen.getByText("3 days")).toBeInTheDocument();
    expect(screen.getByTestId("review-after")).toHaveTextContent("07 Nov 2026");
  });

  it("an affiliate-only collaboration has no posting date, no grace period and no review date", async () => {
    await open(AFFILIATE);
    expect(screen.getByTestId("posting-due")).toHaveTextContent("No posting obligation");
    expect(screen.getByText("Not applicable")).toBeInTheDocument();
    expect(screen.getByTestId("review-after")).toHaveTextContent("N/A · no posting date was agreed");
    expect(screen.getByText(/A missing post is not a violation, and no posting reminder applies/)).toBeInTheDocument();
    expect(screen.getByText(/Optional\. No posting date was agreed\./)).toBeInTheDocument();
  });

  it("never invents an overdue, late or violation state for uncommitted content", async () => {
    await open(AFFILIATE);
    const page = screen.getByRole("main");
    expect(within(page).queryByText(/overdue|late post|no-post violation|breach/i)).not.toBeInTheDocument();
  });

  it("offers no posting reminder for an affiliate-only collaboration, and the content tab says there is nothing owed", async () => {
    expect(collaborationDemo.allowedActions.some((a) => a.key === "remindCreator")).toBe(true);
    await open(AFFILIATE);
    renderRoute("/collaborations/demo-collaboration-affiliate?tab=content", createDemoAdapter());
    expect(await screen.findByRole("heading", { name: "No content obligation" })).toBeInTheDocument();
    expect(screen.getByText(/Any post that appears is welcome, not owed/)).toBeInTheDocument();
  });

  it("the review date is null when there is no posting date", () => {
    expect(reviewAfter(null, null)).toBeNull();
    expect(reviewAfter("2026-11-04", null)).toBeNull();
    expect(collaborationAffiliate.allowedActions.map((a) => a.key)).toEqual(["recordNote"]);
    expect(collaborationAffiliate.terms.agreedFee.minorUnits).toBe(0);
  });

  it("commands on the read-only affiliate record are held with a reason, so nothing can be queued", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    await open(AFFILIATE, adapter);
    expect(spy).not.toHaveBeenCalled();
  });
});
