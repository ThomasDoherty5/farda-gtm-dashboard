import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import type { FardaAdapter } from "@/adapter/adapter";
import { AdapterError } from "@/adapter/errors";
import { CONNECTION_KINDS, connectionsDemo } from "@/fixtures/settings";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";

const open = async (path: string, ready: string | RegExp, adapter: FardaAdapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findByRole("heading", { name: ready, level: 2 });
  return { router, user: userEvent.setup() };
};
// jsdom has no modal <dialog>, so it is never "open" to the accessibility tree: find it by its heading instead.
// The browser tests cover real focus and keyboard behavior.
const dialog = (title: RegExp | string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);

describe("connections (7:876)", () => {
  const go = () => open("/settings/connections", "Source systems");

  it("shows each system's state in words, and an unknown last success as unknown", async () => {
    await go();
    const table = screen.getByTestId("source-systems");
    const row = (name: string) => within(table).getByRole("row", { name: new RegExp(name) });
    expect(within(row("Notion")).getByText("Connected")).toBeInTheDocument();
    expect(within(row("Intercom")).getByText("Needs setup")).toBeInTheDocument();
    expect(within(row("Intercom")).getByText("Not yet tested")).toBeInTheDocument();
    expect(within(row("Email platform")).getByText("To choose")).toBeInTheDocument();
    expect(within(row("Email platform")).getByText("Not connected")).toBeInTheDocument();
  });

  it("keeps setup required, missing permission, expired login, unsupported API, outage and unknown as separate states (FE13-02)", () => {
    expect(new Set(CONNECTION_KINDS).size).toBe(CONNECTION_KINDS.length);
    expect(CONNECTION_KINDS).toEqual(expect.arrayContaining(["setupRequired", "validated", "missingPermission", "expiredLogin", "unsupportedApi", "outage", "unknown"]));
    const kinds = connectionsDemo.systems.map((s) => s.kind);
    expect(kinds).toContain("setupRequired");
    expect(kinds).toContain("toChoose");
  });

  it("never says an unverified source is connected (a green row doesn't prove completeness)", async () => {
    await go();
    for (const row of connectionsDemo.systems.filter((s) => s.kind !== "validated")) {
      const cells = within(screen.getByRole("row", { name: (n) => n.startsWith(row.system) }));
      expect(cells.queryByText("Connected")).not.toBeInTheDocument();
    }
    expect(screen.getByText(/A green connection does not prove the data is complete/)).toBeInTheDocument();
    expect(screen.getByTestId("freshness")).toHaveTextContent("Support" + "Setup required");
  });

  it("Check connections shows Checking, then a result that doesn't claim a provider was contacted (CTRL-002)", async () => {
    const demo = createDemoAdapter();
    let release: () => void = () => undefined;
    let calls = 0;
    const adapter = scriptedAdapter(async (request) => {
      calls += 1;
      if (calls > 1) await new Promise<void>((resolve) => { release = resolve; });
      return demo.readView(request);
    });
    const { user } = await open("/settings/connections", "Source systems", adapter);
    const check = screen.getByRole("button", { name: "Check connections" });
    await user.click(check);
    await waitFor(() => expect(check).toHaveAttribute("aria-busy", "true"));
    act(() => release());
    expect(await screen.findByTestId("check-status")).toHaveTextContent("no provider was contacted");
    expect(check).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("source-systems")).toHaveTextContent("Needs setup");
  });

  it("a failed check keeps the earlier observations and says they may be out of date", async () => {
    let calls = 0;
    const demo = createDemoAdapter();
    const adapter = scriptedAdapter(async (request) => {
      calls += 1;
      if (calls > 1) throw new AdapterError({ code: "SOURCE_UNAVAILABLE", message: "The data service could not be reached.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
      return demo.readView(request);
    });
    const { user } = await open("/settings/connections", "Source systems", adapter);
    await user.click(screen.getByRole("button", { name: "Check connections" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("last successful read and may be out of date");
    expect(screen.getByTestId("source-systems")).toHaveTextContent("Notion · creator records");
    expect(screen.queryByTestId("check-status")).not.toBeInTheDocument();
  });

  it("Open setup targets the selected connection in the URL, offers no invented handoff, and enables nothing (CTRL-004)", async () => {
    const { user, router } = await go();
    await user.click(screen.getByRole("button", { name: "Open setup" }));
    expect(router.state.location.search).toBe("?connection=intercom");
    const d = dialog(/Setup · Intercom/);
    expect(d.getByText(/No verified authorization handoff is available/)).toBeInTheDocument();
    expect(d.queryByRole("link", { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByTestId("source-systems")).toHaveTextContent("Needs setup");
  });

  it("restores the setup dialog from a deep link", async () => {
    await open("/settings/connections?connection=email", "Source systems");
    expect(dialog(/Decision · Email platform/).getByText(/No email platform is chosen/)).toBeInTheDocument();
  });

  it("links to the screens Figma links to", async () => {
    await go();
    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("View Zapier")).toBe("/automations?tab=zaps");
    expect(href("Open sync run history")).toBe("/automations?from=connections");
    expect(href("Channel access")).toBe("/settings/capabilities");
    expect(href("Daily sourcing")).toBe("/creators/discovery");
    expect(screen.getByRole("link", { name: "Connections" })).toHaveAttribute("aria-current", "page");
  });

  it("shows an honest pending state on a live environment, never the demo list", async () => {
    renderRoute("/settings/connections", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("source-systems")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check connections" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("team permissions (7:1085)", () => {
  const go = () => open("/settings/team", "Who can do what");

  it("shows the matrix and two ownership gaps, derived from the owners", async () => {
    await go();
    const row = within(screen.getByRole("row", { name: /Approve Pay step/ }));
    expect(row.getAllByRole("cell").map((c) => c.textContent)).toEqual(["Yes", "No", "No"]);
    expect(screen.getByText("2 ownership gaps")).toBeInTheDocument();
    expect(screen.getByTestId("owner-coverage")).toHaveTextContent("SupportNeeds assignment");
  });

  it("View source roles keeps application roles and provider authority apart, and grants nothing (CTRL-172)", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "View source roles" }));
    const d = dialog("Source roles");
    expect(d.getByText(/Provider roles are not read in this demo/)).toBeInTheDocument();
    expect(d.getAllByText("Not read").length).toBeGreaterThan(3);
    expect(d.getByRole("link", { name: "Inspect action capabilities", hidden: true })).toHaveAttribute("href", "/settings/capabilities");
  });

  it("names the roles with no owner in the owner register", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "Open owner register" }));
    expect(dialog("Owner register").getByText(/Support and Automation/)).toBeInTheDocument();
  });

  it("links to launch control", async () => {
    await go();
    expect(screen.getByRole("link", { name: "Open launch control" })).toHaveAttribute("href", "/launch?view=control");
  });

  it("shows a pending state live", async () => {
    renderRoute("/settings/team", createLiveAdapter("production"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("role-matrix")).not.toBeInTheDocument();
  });
});

describe("automation runs (14:637)", () => {
  const go = (path = "/automations") => open(path, "Prioritize the next safe action", createDemoAdapter());
  const rows = () => within(screen.getByTestId("run-list")).getAllByRole("row").slice(1);

  it("lists the example runs with their states and next actions", async () => {
    await go();
    expect(rows()).toHaveLength(7);
    expect(screen.getByRole("link", { name: "Reconcile" })).toHaveAttribute("href", "/runs/demo-run-uncertain?tab=recovery");
    expect(screen.getByRole("link", { name: "Review approval" })).toHaveAttribute("href", "/approvals/demo-approval-042");
    expect(screen.getByTestId("metric-Needs a decision")).toHaveTextContent("08");
  });

  it("filters through the URL, labels the denominator and clears (CTRL-008 to CTRL-012)", async () => {
    const { user, router } = await go();
    await user.type(screen.getByRole("searchbox", { name: "Search run or collaboration" }), "zap");
    expect(router.state.location.search).toBe("?q=zap");
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId("run-count")).toHaveTextContent("Showing 2 of 7 example runs for the current filters.");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.state.location.search).toBe("");
    expect(rows()).toHaveLength(7);
  });

  it("combines platform, state and assigned-to-me, and tells no matches from no data", async () => {
    await go("/automations?platform=social-cat&state=login&mine=1");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("RUN-SC-1038");
    expect(screen.getByRole("button", { name: "Assigned to me" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says no runs match, rather than showing an empty table or an error", async () => {
    await go("/automations?platform=zapier&state=login");
    expect(screen.getByRole("heading", { name: "No runs match these filters" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to every value when the URL holds one that isn't allowed", async () => {
    await go("/automations?platform=<script>&state=nope");
    expect(rows()).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Platform: All platforms" })).toBeInTheDocument();
  });

  it("Take over explains it needs an assignment and changes nothing", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "Take over" }));
    expect(dialog("Take over RUN-SC-1038").getByText(/Taking over needs a server-confirmed assignment/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /RUN-SC-1038/ })).toHaveTextContent("Login required");
  });

  it("Zaps and Reporting are addressable subviews, and selecting one runs nothing (CTRL-015, CTRL-016)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    await open("/automations?tab=zaps", "Zaps and their schedules", adapter);
    expect(screen.getByRole("link", { name: "Zaps" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "View schedule" })).toHaveAttribute("href", "/automations/zap-12/schedule");
    expect(spy).not.toHaveBeenCalled();
  });

  it("the reporting subview marks itself current", async () => {
    await open("/automations?tab=reporting", "Reporting schedules");
    expect(screen.getByRole("link", { name: "Reporting" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Agent runs" })).not.toHaveAttribute("aria-current");
  });

  describe("Request task (CTRL-006)", () => {
    const fill = async (user: ReturnType<typeof userEvent.setup>, overrides: { jobType?: string; account?: string; scope?: string; reason?: string } = {}) => {
      const d = dialog("Request a task");
      await user.selectOptions(d.getByLabelText("Job type"), overrides.jobType ?? "daily-sourcing");
      await user.selectOptions(d.getByLabelText("Account"), overrides.account ?? "social-cat");
      await user.type(d.getByLabelText("Entity or scope"), overrides.scope ?? "Batch TT-024");
      await user.type(d.getByLabelText("Reason"), overrides.reason ?? "Plan today's discovery within permitted capacity");
      return d;
    };

    it("offers only registered job types, previews a finite plan, and creates an approval request without dispatching", async () => {
      const adapter = createDemoAdapter();
      const spy = vi.spyOn(adapter, "submitAction");
      const { user } = await go();
      await user.click(screen.getByRole("button", { name: "Request task" }));
      const d = dialog("Request a task");
      const options = within(d.getByLabelText("Job type")).getAllByRole("option", { hidden: true }).map((o) => o.textContent);
      expect(options).toEqual(["Choose a job type", "Daily sourcing plan", "Lifestyle evidence review", "Hourly monitor check"]);
      await fill(user);
      expect(d.getByText("Plan preview · finite")).toBeInTheDocument();
      await user.click(d.getByRole("button", { name: "Create approval request", hidden: true }));
      expect(await d.findByTestId("task-status")).toHaveTextContent("waiting for a decision, and nothing was dispatched");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("shows a pending state live", async () => {
    renderRoute("/automations", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("run-list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request task" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("request task validation, against the demo service", () => {
  it("rejects an unregistered job type, a missing account and a short reason, field by field", async () => {
    const adapter = createDemoAdapter();
    const base = { operation: "requestApproval" as const, actionKind: "requestTask", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" as const }, entityRefs: [], expectedVersion: "v1", approvalRef: null, manifestRef: null, schemaVersion: "x", requestId: "r" };
    const err = await adapter.submitAction({ ...base, idempotencyKey: "k1", payload: { jobType: "delete-everything", account: "", scope: "", reason: "no" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).body.fieldErrors).toMatchObject({ jobType: expect.any(String), account: expect.any(String), scope: expect.any(String), reason: expect.any(String) });
    expect((err as AdapterError).body.executionCertainty).toBe("notApplied");
  });

  it("returns the same result for a repeated key, and refuses a changed payload under that key", async () => {
    const adapter = createDemoAdapter();
    const base = { operation: "requestApproval" as const, actionKind: "requestTask", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" as const }, entityRefs: [], expectedVersion: "v1", approvalRef: null, manifestRef: null, schemaVersion: "x", requestId: "r", idempotencyKey: "same" };
    const payload = { jobType: "daily-sourcing", account: "social-cat", scope: "Batch", reason: "A long enough reason" };
    const first = await adapter.submitAction({ ...base, payload });
    const second = await adapter.submitAction({ ...base, payload });
    expect(second.actionRef).toBe(first.actionRef);
    expect(first.state).toBe("approvalPending");
    await expect(adapter.submitAction({ ...base, payload: { ...payload, scope: "Another batch" } })).rejects.toMatchObject({ body: { code: "MANIFEST_CHANGED" } });
  });
});

describe("zap and report schedule (14:911)", () => {
  const go = (path = "/automations/zap-12/schedule") => open(path, "Schedule");

  it("shows a paused proposal, with Enable schedule blocked and the reason visible (CTRL-014)", async () => {
    const { user } = await go();
    expect(screen.getByRole("heading", { name: "A reliable daily handoff.", level: 1 })).toBeInTheDocument();
    const enable = screen.getByRole("button", { name: "Enable schedule" });
    expect(enable).toHaveAttribute("aria-disabled", "true");
    expect(enable).toHaveAccessibleDescription(/Source connections, sandbox proof and owner approval are required/);
    await user.click(enable);
    expect(screen.getByTestId("schedule-settings")).toHaveTextContent("Paused");
  });

  it("derives the next run from the draft and states the daylight-saving policy (CTRL-018)", async () => {
    await go();
    expect(screen.getByTestId("next-run")).toHaveTextContent("Next run if enabled (derived, not active): Tue, Nov 3, 8:30 AM PST.");
    expect(screen.getByTestId("next-run")).toHaveTextContent("runs once, at its first occurrence");
  });

  it("saves a draft as a new version that doesn't enable the schedule (CTRL-017)", async () => {
    const { user } = await go();
    await user.selectOptions(screen.getByLabelText("Cadence"), "daily");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    const status = await screen.findByTestId("save-status");
    expect(status).toHaveTextContent("Saved as version 2. A saved draft does not enable the schedule.");
    expect(screen.getByRole("button", { name: "Enable schedule" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Cadence")).toHaveValue("daily");
  });

  it("shows a field error and saves nothing for an invalid time", async () => {
    const adapter = createDemoAdapter();
    const save = vi.spyOn(adapter, "saveResource");
    const { user } = await go();
    const time = screen.getByLabelText("Local time");
    await user.clear(time);
    await user.type(time, "25:99");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Enter a time as HH:MM, from 00:00 to 23:59.")).toBeInTheDocument();
    expect(time).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("next-run")).toHaveTextContent("not available until the draft is valid");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the daily schedule separate from the other report schedules", async () => {
    await go();
    const others = screen.getByTestId("other-schedules");
    expect(within(others).getByText("Launch pulse")).toBeInTheDocument();
    expect(within(others).getByText("L through L+3; disabled until L is approved")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reporting" })).toHaveAttribute("aria-current", "page");
  });

  it("shows a missing schedule as not found, with a page heading and no invented schedule", async () => {
    renderRoute("/automations/demo-jobId/schedule", createDemoAdapter());
    expect(await screen.findByRole("alert")).toHaveTextContent("does not exist or was removed");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Zap and report schedule");
    expect(screen.queryByTestId("zap-pipeline")).not.toBeInTheDocument();
  });

  it("refuses a stale save, with the current version, and keeps the draft", async () => {
    const adapter = createDemoAdapter();
    const base = { schemaVersion: "x", operation: "saveResource" as const, requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" as const }, resourceKind: "configurationDraft" as const, resourceRef: "schedule-zap-12", requestId: "r" };
    const draft = { cadence: "daily", localTime: "09:00", timezone: "UTC", activeCohortOverride: false };
    await adapter.saveResource({ ...base, expectedVersion: "v1", idempotencyKey: "a", payload: draft });
    await expect(adapter.saveResource({ ...base, expectedVersion: "v1", idempotencyKey: "b", payload: { ...draft, localTime: "10:00" } })).rejects.toMatchObject({ body: { code: "STALE_VERSION", currentVersion: "v2" } });
  });

  it("shows a pending state live", async () => {
    renderRoute("/automations/zap-12/schedule", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("schedule-settings")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable schedule" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("channel capabilities (66:641)", () => {
  const go = (path = "/settings/capabilities") => open(path, "Use the right owner for each action.");

  it("shows every route as unverified or missing permission, and none as ready", async () => {
    await go();
    const matrix = screen.getByTestId("capability-matrix");
    expect(within(matrix).getByText("Express automation authorization missing")).toBeInTheDocument();
    expect(within(matrix).getAllByText(/unverified/).length).toBe(5);
    expect(within(matrix).queryByText(/\bready\b|\bverified\b(?! )/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Not run")).toHaveLength(5);
  });

  it("shows capacity in separate units, and Read source as a value, not a number", async () => {
    await go();
    expect(screen.getByTestId("metric-Social Cat invitations")).toHaveTextContent("5,000 / mo");
    expect(screen.getByTestId("metric-Social Cat collaborations")).toHaveTextContent("30 / mo");
    expect(screen.getByTestId("metric-TikTok native quota")).toHaveTextContent("Read source");
  });

  it("tabs live in the URL, and re-selecting the current tab adds nothing (CTRL-131 to CTRL-133, CTRL-233)", async () => {
    const { router } = await open("/settings/capabilities?tab=access", "Access evidence");
    expect(screen.getByRole("link", { name: "Access evidence" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("access-evidence")).toHaveTextContent("Denied · authorization missing");
    expect(router.state.location.search).toBe("?tab=access");
  });

  it("an unknown tab value falls back to Capabilities", async () => {
    await go("/settings/capabilities?tab=<script>");
    expect(screen.getByRole("link", { name: "Capabilities" })).toHaveAttribute("aria-current", "page");
  });

  it("the attribution tab keeps expected and observed results apart, with nothing observed", async () => {
    await open("/settings/capabilities?tab=attribution", "Attribution tests");
    const rows = within(screen.getByTestId("attribution-tests")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).toHaveTextContent("Unknown · not run");
  });

  it("the exceptions tab says nothing is recorded, not that every provider works", async () => {
    await open("/settings/capabilities?tab=exceptions", "No provider exceptions recorded");
    expect(screen.getByText(/not a finding that every provider is working/)).toBeInTheDocument();
  });

  it("Record permission saves evidence with a reviewer and version, and grants nothing (CTRL-134)", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "Record permission" }));
    const d = dialog("Record permission evidence");
    await user.type(d.getByLabelText("Reviewer"), "Owner");
    await user.type(d.getByLabelText("Evidence"), "Saw the authorization request in the provider console");
    await user.type(d.getByLabelText("Observed on"), "2026-11-02");
    await user.click(d.getByRole("button", { name: "Save evidence", hidden: true }));
    expect(await d.findByTestId("record-status")).toHaveTextContent("Evidence saved as version 1 (demo). It does not grant access.");
    const matrix = screen.getByTestId("capability-matrix");
    await waitFor(() => expect(matrix).toHaveTextContent("Evidence recorded as version 1 · not provider authority"));
    expect(matrix).toHaveTextContent("Express automation authorization missing");
  });

  it("rejects incomplete or future-dated evidence with field errors", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "Record permission" }));
    const d = dialog("Record permission evidence");
    await user.type(d.getByLabelText("Observed on"), "2027-01-01");
    await user.click(d.getByRole("button", { name: "Save evidence", hidden: true }));
    expect(await d.findByText("Name the reviewer.")).toBeInTheDocument();
    expect(d.getByText("Describe the evidence in at least 10 characters.")).toBeInTheDocument();
    expect(d.getByText("The observation can't be in the future.")).toBeInTheDocument();
  });

  it("Inspect available actions opens account-scoped capabilities and runs nothing (CTRL-136)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user, router } = await open("/settings/capabilities", "Use the right owner for each action.", adapter);
    await user.click(screen.getByRole("button", { name: "Inspect available actions" }));
    expect(router.state.location.search).toBe("?inspect=shopify-flow");
    const d = dialog(/Available actions · Shopify Flow/);
    expect(d.getByText("Inspecting an action never runs it.", { exact: false })).toBeInTheDocument();
    expect(d.getAllByText(/Unverified|Unknown/).length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("Validate buttons show a plan and run nothing", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open("/settings/capabilities", "Use the right owner for each action.", adapter);
    await user.click(screen.getByRole("button", { name: "Validate Collabs" }));
    expect(dialog("Plan · Validate Collabs").getByText(/Nothing is run from here/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("Review commitment links to the offer's commitment preview", async () => {
    await go();
    expect(screen.getByRole("link", { name: "Review commitment" })).toHaveAttribute("href", "/offers/demo-offerId");
  });

  it("shows a pending state live", async () => {
    renderRoute("/settings/capabilities", createLiveAdapter("production"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("capability-matrix")).not.toBeInTheDocument();
    expect(screen.getByText("No integration is verified")).toBeInTheDocument();
  });
});
