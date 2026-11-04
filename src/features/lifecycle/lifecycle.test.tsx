import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { renderRoute } from "@/test/renderWithAdapter";

const open = async (path: string, ready: string | RegExp) => {
  const router = renderRoute(path, createDemoAdapter());
  await screen.findByRole("heading", { name: ready, level: 2 });
  return { router, user: userEvent.setup() };
};
// jsdom has no modal <dialog>, so it is never "open" to the accessibility tree: find it by its heading instead.
const dialog = (title: RegExp | string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);
const metric = (label: string) => screen.getByTestId(`metric-${label}`);

describe("customer lifecycle (5:289)", () => {
  const go = () => open("/customers/lifecycle", "Four flows, one clear consent rule");

  it("shows aggregate counts, labeled as illustrative", async () => {
    await go();
    expect(metric("Consented early access")).toHaveTextContent("428");
    expect(metric("Paired devices")).toHaveTextContent("86");
    expect(screen.getByText(/all figures below are illustrative aggregates/)).toBeInTheDocument();
    expect(screen.getByText(/not a measured Farda result/)).toBeInTheDocument();
  });

  it("derives week-one activation from the counts", async () => {
    await go();
    expect(screen.getByText(/Week-one activation: 64 \/ 86 = 74.4%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Week-one active/ })).toHaveAttribute("aria-valuenow", "74.4");
  });

  it("marks the four flows as not deployed, and links each to its own route", async () => {
    await go();
    const table = screen.getByTestId("flows");
    expect(within(table).getAllByText("Setup required")).toHaveLength(3);
    const href = (name: string) => within(table).getByRole("link", { name }).getAttribute("href");
    expect(href("Early access")).toBe("/customers/flows/early-access");
    expect(href("Abandoned cart")).toBe("/customers/flows/abandoned-checkout");
    expect(href("Review request")).toBe("/customers/flows/review-request");
    expect(href("View flow →")).toBe("/customers/flows/setup");
  });

  it("marks the lifecycle as the current page, and links to its neighbours", async () => {
    await go();
    expect(screen.getByRole("link", { name: "Customer lifecycle" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "GTM overview" })).toHaveAttribute("href", "/overview");
    expect(screen.getByRole("link", { name: "Launch control" })).toHaveAttribute("href", "/launch?view=control");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "true");
  });

  it("explains that there is no email tool to open, rather than linking somewhere", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "Open email tool" }));
    const d = dialog("Open email tool");
    expect(d.getByText(/No email platform is selected/)).toBeInTheDocument();
    expect(d.queryByRole("link", { hidden: true })).not.toBeInTheDocument();
  });

  it("defines each metric", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "Metric definitions" }));
    expect(dialog("Metric definitions").getByText(/Pairing doesn't prove data ingestion or any health outcome/)).toBeInTheDocument();
  });

  it("shows a pending state live, never the demo counts", async () => {
    renderRoute("/customers/lifecycle", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-Consented early access")).not.toBeInTheDocument();
  });
});

describe("setup help flow (5:404)", () => {
  const go = () => open("/customers/flows/setup", "Delivery → eligibility → message → exit");

  it("describes a paused flow in six steps, and nothing can be edited or sent", async () => {
    await go();
    const steps = within(screen.getByTestId("flow-steps")).getAllByRole("listitem");
    expect(steps).toHaveLength(6);
    expect(screen.getByText("Flow paused")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/No live automation or provider configuration has been changed/)).toBeInTheDocument();
  });

  it("lists when it never sends", async () => {
    await go();
    const list = within(screen.getByTestId("eligibility"));
    for (const reason of ["Consent is missing or withdrawn", "Contact is suppressed or bounced", "The order was refunded or canceled", "This flow already sent for the order", "Required data is stale or unavailable"]) expect(list.getByText(reason)).toBeInTheDocument();
  });

  it("goes back to the lifecycle, and says there is no provider to open", async () => {
    const { user } = await go();
    expect(screen.getByRole("link", { name: "Back to lifecycle" })).toHaveAttribute("href", "/customers/lifecycle");
    await user.click(screen.getByRole("button", { name: "Open provider" }));
    expect(dialog("Open provider").getByText(/No email provider is selected/)).toBeInTheDocument();
  });
});

describe.each([
  ["early-access", "Confirm channel consent", "Confirmed email subscription", "Welcome: on opt-in"],
  ["abandoned-checkout", "Receive checkout event", "Eligible checkout abandoned", "4 hours after checkout"],
  ["review-request", "Confirm delivery", "Confirmed order delivery", "14 days after delivery"],
] as const)("%s flow", (flow, firstStep, event, timing) => {
  const go = () => open(`/customers/flows/${flow}`, "Every entry has a defined exit");

  it("shows the six steps, the provider-owned event and the configured timing", async () => {
    await go();
    expect(within(screen.getByTestId("flow-steps")).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText(firstStep)).toBeInTheDocument();
    const event_ = screen.getByLabelText("Entry event");
    expect(event_).toHaveValue(event);
    expect(event_).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Timing")).toHaveValue(timing);
  });

  it("locks the three mandatory policies: checked, read-only, explained, and unchangeable (CTRL-182 to CTRL-196)", async () => {
    const { user } = await go();
    const policies = screen.getByRole("group", { name: "Mandatory send policies, locked" });
    const boxes = within(policies).getAllByRole("checkbox");
    expect(boxes.map((b) => b.nextElementSibling?.textContent)).toEqual(["Recheck consent before send", "Stop on opt-out or suppression", "Prevent duplicate enrollment"]);
    for (const box of boxes) {
      expect(box).toBeChecked();
      expect(box).toHaveAttribute("aria-readonly", "true");
      await user.click(box);
      expect(box).toBeChecked();
    }
    expect(policies).toHaveAccessibleDescription(/The server enforces them at send time/);
  });

  it("saves a draft as a new version that doesn't enable the flow or send anything", async () => {
    const { user } = await go();
    const template = screen.getByLabelText("Message template");
    await user.clear(template);
    await user.type(template, "A reworded draft");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByTestId("save-status")).toHaveTextContent("Saved as version 2. A saved draft doesn't enable the flow, publish it or send anything.");
    expect(screen.getByLabelText("Message template")).toHaveValue("A reworded draft");
  });

  it("refuses an empty template name with a field error, and saves nothing", async () => {
    const adapter = createDemoAdapter();
    const save = vi.spyOn(adapter, "saveResource");
    renderRoute(`/customers/flows/${flow}`, adapter);
    await screen.findByRole("heading", { name: "Every entry has a defined exit" });
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Message template"));
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Name the template in 3 to 80 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText("Message template")).toHaveAttribute("aria-invalid", "true");
    expect(save).not.toHaveBeenCalled();
  });

  it("previews synthetic template content that can't be sent", async () => {
    const adapter = createDemoAdapter();
    const submit = vi.spyOn(adapter, "submitAction");
    renderRoute(`/customers/flows/${flow}`, adapter);
    await screen.findByRole("heading", { name: "Every entry has a defined exit" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Preview template" }));
    const d = dialog("Template preview");
    expect(d.getByText(/can't be sent/)).toBeInTheDocument();
    expect(d.getByTestId("template-preview")).toHaveTextContent(/\{\{first_name\}\}/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("says the sandbox tests have not run, and enabling stays blocked", async () => {
    await go();
    expect(screen.getByText(/no sandbox test has been run/)).toBeInTheDocument();
    expect(screen.getByText(/Enabling stays blocked until these checks pass/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Enable/ })).not.toBeInTheDocument();
  });

  it("shows a pending state live", async () => {
    renderRoute(`/customers/flows/${flow}`, createLiveAdapter("production"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId("flow-settings")).not.toBeInTheDocument();
  });
});

it("holds the early-access launch notice and says L is not set", async () => {
  await open("/customers/flows/early-access", "Every entry has a defined exit");
  expect(screen.getByText("L is not set. Launch notices remain paused until founder sign-off.")).toBeInTheDocument();
  expect(screen.getByText("Hold")).toBeInTheDocument();
});

describe("flow saves, against the demo service", () => {
  const base = { schemaVersion: "x", operation: "saveResource" as const, requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" as const }, resourceKind: "configurationDraft" as const, requestId: "r" };

  it("refuses a stale version with the current one, and a timing outside the approved list", async () => {
    const adapter = createDemoAdapter();
    const ok = { timing: "24 hours after checkout", template: "One checkout reminder" };
    await adapter.saveResource({ ...base, resourceRef: "flow-abandoned-checkout", expectedVersion: "v1", idempotencyKey: "a", payload: ok });
    await expect(adapter.saveResource({ ...base, resourceRef: "flow-abandoned-checkout", expectedVersion: "v1", idempotencyKey: "b", payload: { ...ok, template: "Another" } })).rejects.toMatchObject({ body: { code: "STALE_VERSION", currentVersion: "v2" } });
    await expect(adapter.saveResource({ ...base, resourceRef: "flow-abandoned-checkout", expectedVersion: "v2", idempotencyKey: "c", payload: { ...ok, timing: "7 days after checkout" } })).rejects.toMatchObject({ body: { code: "VALIDATION_FAILED", fieldErrors: { timing: expect.any(String) } } });
  });

  it("returns the original result for a repeated key and refuses a changed payload under it", async () => {
    const adapter = createDemoAdapter();
    const payload = { timing: "4 hours after checkout", template: "Reworded" };
    const first = await adapter.saveResource({ ...base, resourceRef: "flow-abandoned-checkout", expectedVersion: "v1", idempotencyKey: "same", payload });
    const second = await adapter.saveResource({ ...base, resourceRef: "flow-abandoned-checkout", expectedVersion: "v1", idempotencyKey: "same", payload });
    expect(second.resourceVersion).toBe(first.resourceVersion);
    await expect(adapter.saveResource({ ...base, resourceRef: "flow-abandoned-checkout", expectedVersion: "v1", idempotencyKey: "same", payload: { ...payload, template: "Different" } })).rejects.toMatchObject({ body: { code: "MANIFEST_CHANGED" } });
  });
});

describe("consent (11:750)", () => {
  const go = () => open("/customers/consent", "Send only to the eligible audience");

  it("shows eligible, opted out, suppressed and unknown counts, with eligibility derived", async () => {
    await go();
    expect(metric("Eligible now")).toHaveTextContent("740");
    expect(screen.getByText("74.0% of 1,000 records")).toBeInTheDocument();
    expect(metric("Opted out")).toHaveTextContent("130");
    expect(metric("Bounced / suppressed")).toHaveTextContent("60");
    expect(metric("Consent unknown")).toHaveTextContent("70");
  });

  it("never counts unknown consent as opted in, and says so", async () => {
    await go();
    expect(screen.getByText("Held until source resolves")).toBeInTheDocument();
    expect(screen.getByText("The bar uses one mutually exclusive category per record. Unknown is not treated as opted in.")).toBeInTheDocument();
  });

  it("gives the bar a text alternative with every category", async () => {
    await go();
    expect(screen.getByRole("img", { name: /740 eligible, 130 withdrawn, 60 suppressed, 70 unknown/ })).toBeInTheDocument();
  });

  it("lists why an enrollment stops, and Review exclusions moves focus there", async () => {
    const { user } = await go();
    expect(within(screen.getByTestId("exclusions")).getAllByRole("row")).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "Review exclusions" }));
    expect(document.getElementById("exclusions")).toHaveFocus();
  });

  it("says there is no provider to open", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "Open provider" }));
    expect(dialog("Open provider").getByText(/No email provider is selected/)).toBeInTheDocument();
  });

  it("shows a pending state live, and no eligible count", async () => {
    renderRoute("/customers/consent", createLiveAdapter("production"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-Eligible now")).not.toBeInTheDocument();
  });
});

describe("activation and retention (11:852)", () => {
  const go = () => open("/customers/activation", "First-week cohort");

  it("derives every share from the counts", async () => {
    await go();
    expect(screen.getByText(/Paired\s+86 units · 86.0% of delivered/)).toBeInTheDocument();
    expect(screen.getByText(/Active in week one\s+64 units · 74.4% of paired/)).toBeInTheDocument();
    expect(screen.getByTestId("metric-Pairing → week-one active")).toHaveTextContent("74.4%");
    expect(screen.getByText("64 active / 86 paired")).toBeInTheDocument();
  });

  it("gives each funnel bar a name and a value", async () => {
    await go();
    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["100", "86", "64"]);
    expect(screen.getByRole("progressbar", { name: /Paired/ })).toBeInTheDocument();
  });

  it("says pairing failures aren't subtracted, and that live export is blocked", async () => {
    await go();
    expect(screen.getByText(/Failure events are not subtracted from the cohort automatically/)).toBeInTheDocument();
    expect(screen.getByText("Live export blocked")).toBeInTheDocument();
  });

  it("marks only day 7 as defined; the rest are proposed", async () => {
    await go();
    const horizons = within(screen.getByTestId("retention")).getAllByRole("listitem");
    expect(horizons.map((h) => h.textContent)).toEqual(["Day 7First-use activationDefined", "Day 30Continued use cohortProposed", "Day 60Dormant cohort recoveryProposed", "Day 90Sustained use reviewProposed"]);
  });

  it("explains the source contract and the cohort without inventing a link", async () => {
    const { user } = await go();
    await user.click(screen.getByRole("button", { name: "View source contract" }));
    expect(dialog("Source contract").getByText(/Live export is blocked/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Demo cohort" }));
    expect(dialog("Cohort").getByText(/not a measured Farda cohort/)).toBeInTheDocument();
  });

  it("shows a pending state live, never zero activation", async () => {
    renderRoute("/customers/activation", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("cohort")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("0.0%")).not.toBeInTheDocument());
  });
});
