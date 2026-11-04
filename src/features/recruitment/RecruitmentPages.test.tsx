import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { AdapterError } from "@/adapter/errors";
import { respondWith } from "@/adapter/demoViews";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { invitationDemo, recruitmentDemo } from "@/fixtures/recruitment";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";

const metric = (label: string) => screen.getByTestId(`metric-${label}`);
// jsdom has no modal <dialog>, so find it by its heading.
const dialog = (title: string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);
const open = async (path: string, ready: string, adapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findByTestId(`metric-${ready}`);
  return { router, adapter, user: userEvent.setup() };
};
const choose = async (user: ReturnType<typeof userEvent.setup>, button: string, title: string, option: string) => {
  await user.click(screen.getByRole("button", { name: button }));
  await user.click(dialog(title).getByRole("radio", { name: option, hidden: true }));
};

describe("Social Cat recruitment (38:131)", () => {
  const PATH = "/creators/social-cat/recruitment";

  it("shows the planning allocation, which adds up, and a known zero for extra samples", async () => {
    await open(PATH, "Historical allocation");
    expect(metric("Historical allocation")).toHaveTextContent("22");
    expect(metric("Instagram primary")).toHaveTextContent("17");
    expect(metric("TikTok → website")).toHaveTextContent("5");
    expect(metric("Additional cross-posts")).toHaveTextContent("0 extra samples");
    expect(screen.getByText("Planning reference · not current stock")).toBeInTheDocument();
  });

  it("states commission-only, and keeps usage unknown", async () => {
    await open(PATH, "Historical allocation");
    expect(screen.getByText("Commission-only acquisition")).toBeInTheDocument();
    expect(screen.getByText(/No upfront content fee\. Product and shipping need separate approval/)).toBeInTheDocument();
    expect(screen.getByText("Actual usage unknown")).toBeInTheDocument();
    expect(screen.getByText("$299 / month")).toBeInTheDocument();
  });

  it("recomputes the queue for a publishing network and keeps it in the URL (CTRL-074)", async () => {
    const { user, router } = await open(PATH, "Historical allocation");
    expect(within(screen.getByTestId("recruit-queue")).getAllByRole("row")).toHaveLength(5);
    await choose(user, "Publishing networks: Instagram + TikTok", "Choose publishing networks", "TikTok");
    await waitFor(() => expect(metric("Historical allocation")).toHaveTextContent("5"));
    expect(router.state.location.search).toBe("?networks=tiktok");
    expect(within(screen.getByTestId("recruit-queue")).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("@claire.everyday")).toBeInTheDocument();
    expect(screen.queryByText("@new.creator")).not.toBeInTheDocument();
  });

  it("filters by recruitment route (CTRL-075), and says so when nothing matches", async () => {
    const { user } = await open(`${PATH}?networks=tiktok&route=outbound`, "Historical allocation");
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(/No creator in the queue matches/);
    await choose(user, "Route: Found by us", "Choose the recruitment route", "Inbound applications");
    await waitFor(() => expect(screen.getByText("@claire.everyday")).toBeInTheDocument());
  });

  it("links Find Creators, research and the scores (CTRL-076, 077)", async () => {
    await open(PATH, "Historical allocation");
    expect(screen.getByRole("link", { name: "Find Creators" })).toHaveAttribute("href", "/creators/discovery");
    expect(screen.getByRole("link", { name: "Research profile" })).toHaveAttribute("href", "/creators/demo-creator-1/evidence/demo-evidence-1");
    for (const link of screen.getAllByRole("link", { name: "Prior content score" })) expect(link).toHaveAttribute("href", expect.stringContaining("/assessments/"));
    expect(screen.getByRole("link", { name: "Recruitment queue" })).toHaveAttribute("aria-current", "page");
  });

  it("previews a discovery run without starting one (CTRL-078)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(PATH, "Historical allocation", adapter);
    await user.click(screen.getByRole("button", { name: "Preview discovery run" }));
    expect(dialog("Preview discovery run").getByText(/No job has been started/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the draft honest: an illustrative rate, $0 upfront, and a message built from the terms (CTRL-079–084)", async () => {
    const { user } = await open(PATH, "Historical allocation");
    expect(screen.getByLabelText("Affiliate terms")).toHaveValue("Draft 15% · $0 upfront");
    expect(screen.getByTestId("draft-message")).toHaveTextContent("15% of eligible website merchandise sales, with no upfront content fee");
    expect(screen.getByText("Affiliate draft v1 · not approved")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Affiliate terms"));
    await user.type(screen.getByLabelText("Affiliate terms"), "20% · $0 upfront");
    expect(screen.getByTestId("draft-message")).toHaveTextContent("20% of eligible");
    expect(screen.getByLabelText("Delivery window")).toHaveValue("Confirm in the source thread");
  });

  it("refuses an upfront fee, explains it on the field, and carries it into the review (CTRL-081)", async () => {
    const { user } = await open(PATH, "Historical allocation");
    await user.clear(screen.getByLabelText("Affiliate terms"));
    await user.type(screen.getByLabelText("Affiliate terms"), "15% · $150 upfront");
    expect(screen.getByLabelText("Affiliate terms")).toBeInvalid();
    expect(screen.getByText("New acquisition has no upfront or guaranteed fee. Use $0, or remove it.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Review affiliate terms" })[0]!);
    expect(dialog("Review affiliate terms").getByRole("alert", { hidden: true })).toHaveTextContent("no upfront or guaranteed fee");
  });

  it("validates sample units and the delivery window, and never invents a date (CTRL-083, 084)", async () => {
    const { user } = await open(PATH, "Historical allocation");
    await user.clear(screen.getByLabelText("Sample allocation"));
    await user.type(screen.getByLabelText("Sample allocation"), "1 creator · 2 samples");
    expect(screen.getByText("One sample per creator at most.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Delivery window"));
    await user.type(screen.getByLabelText("Delivery window"), "next week");
    expect(screen.getByLabelText("Delivery window")).toBeInvalid();
    await user.clear(screen.getByLabelText("Delivery window"));
    expect(screen.getByLabelText("Delivery window")).toBeValid();
  });

  it("opens an exact review that is not an approval, and resets the draft", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(PATH, "Historical allocation", adapter);
    await user.click(screen.getAllByRole("button", { name: "Review affiliate terms" })[0]!);
    const review = dialog("Review affiliate terms");
    expect(review.getByText("15% of eligible website merchandise sales · $0 upfront")).toBeInTheDocument();
    expect(review.getByText("Not set · confirm in the source thread")).toBeInTheDocument();
    expect(review.getByText(/Nothing has been approved or sent/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Rights"));
    await user.type(screen.getByLabelText("Rights"), "Rights agreed");
    await user.click(screen.getByRole("button", { name: "Reset to the illustrative draft" }));
    expect(screen.getByLabelText("Rights")).toHaveValue("Rights to negotiate");
  });

  it("keeps sample, content and rights gated, each with its own reason (CTRL-085–087)", async () => {
    const { user } = await open(PATH, "Historical allocation");
    for (const name of ["Sample after acceptance", "Content after agreement", "Rights to agree"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription(/Sample, content and rights stay locked until each one's own gate is met/);
      await user.click(button);
    }
    expect(screen.getByText(/Social Cat owns recruitment and collaboration/)).toBeInTheDocument();
  });

  it("keeps the history tabs read-only with the policy visible (CTRL-088–090)", async () => {
    await open(PATH, "Historical allocation");
    for (const name of ["Gifted · history", "Paid · history", "Hybrid · history"]) {
      const tab = screen.getByRole("button", { name });
      expect(tab).toHaveAttribute("aria-disabled", "true");
      expect(tab).toHaveAccessibleDescription(/New offers are affiliate-only with no upfront content fee/);
    }
    expect(screen.getByText("Not allowed")).toBeInTheDocument();
    expect(screen.getByText("Permission missing")).toBeInTheDocument();
  });

  it("shows stale, empty and pending states", async () => {
    await open(PATH, "Historical allocation", scriptedAdapter(async (request) => respondWith(request, recruitmentDemo, { dataVersion: "x", dataState: "stale" })));
    expect(screen.getByTestId("view-stale")).toBeInTheDocument();
  });

  it("shows a pending state, never demo numbers, when the backend isn't published", async () => {
    renderRoute(PATH, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId("metric-Historical allocation")).not.toBeInTheDocument();
  });
});

describe("TikTok invitation (38:348)", () => {
  const PATH = "/creators/tiktok/invitations/new";

  it("shows the prior v2 score as history, with unknown quota left unknown", async () => {
    await open(PATH, "Creator fit score");
    expect(metric("Creator fit score")).toHaveTextContent("86 / 100");
    expect(screen.getByText("Prior v2 · read-only · hard gates pending")).toBeInTheDocument();
    expect(screen.getByText("Prior TT-COMMERCE-v2 · 86")).toBeInTheDocument();
    expect(metric("Live quota remaining")).toHaveTextContent("N/A");
    expect(metric("Conditional Shop samples")).toHaveTextContent("15 planned");
    expect(screen.getByText("Invitation acceptance is not sample approval")).toBeInTheDocument();
  });

  it("blocks Send with its reason on screen, and a click does nothing (CTRL-100)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user, router } = await open(PATH, "Creator fit score", adapter);
    const send = screen.getByRole("button", { name: "Send request · blocked" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAccessibleDescription(/verified listing, source quota, final validity dates and exact-action approval/);
    await user.click(send);
    expect(spy).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe(PATH);
  });

  it("requires exact start and end times before the request can be approved (CTRL-097, 098)", async () => {
    const { user } = await open(PATH, "Creator fit score");
    expect(screen.getByLabelText("Invitation starts")).toHaveValue("");
    expect(screen.getByLabelText("Invitation starts")).toHaveAttribute("placeholder", "Set before approval");
    await user.click(screen.getAllByRole("button", { name: "Review exact request" })[0]!);
    const review = dialog("Review exact request");
    expect(review.getByRole("alert", { hidden: true })).toHaveTextContent(/starts: Enter an exact start/);
    expect(review.getByRole("alert", { hidden: true })).toHaveTextContent(/expires: Enter an exact end/);
    expect(review.getByRole("alert", { hidden: true })).toHaveTextContent(/No approval has been requested/);
    expect(review.getByText(/This is a preview, not an approval or a send/)).toBeInTheDocument();
  });

  it("accepts a valid window, converts it to an exact instant, and rejects an end before the start", async () => {
    const { user } = await open(PATH, "Creator fit score");
    await user.type(screen.getByLabelText("Invitation starts"), "2026-11-10 09:00 PT");
    await user.type(screen.getByLabelText("Invitation expires"), "2026-11-08 09:00 PT");
    expect(screen.getByText("The invitation must expire after it starts.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Invitation expires"));
    await user.type(screen.getByLabelText("Invitation expires"), "2026-11-17 09:00 PT");
    expect(screen.getByLabelText("Invitation expires")).toBeValid();
    await user.click(screen.getAllByRole("button", { name: "Review exact request" })[0]!);
    const review = dialog("Review exact request");
    expect(review.getByText(/2026-11-10 09:00 PT \(.*Nov 10, 2026/)).toBeInTheDocument();
    expect(review.getByRole("alert", { hidden: true })).not.toHaveTextContent(/starts:/);
    expect(review.getByRole("alert", { hidden: true })).toHaveTextContent(/Source capability is unverified/);
  });

  it("never resolves a creator from a similar handle, and keeps the commission free of a fee (CTRL-093, 095)", async () => {
    const { user } = await open(PATH, "Creator fit score");
    await user.clear(screen.getByLabelText("Creator"));
    await user.type(screen.getByLabelText("Creator"), "@studio.rae2");
    expect(screen.getByText(/No creator matches this exact handle/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Commission"));
    await user.type(screen.getByLabelText("Commission"), "12% plus flat fee");
    expect(screen.getByText("New acquisition has no upfront or guaranteed fee.")).toBeInTheDocument();
    expect(screen.getByTestId("draft-message")).toHaveTextContent("The proposed commission is 12%");
  });

  it("keeps a free sample a separate approval (CTRL-096), and Automate Invitations off", async () => {
    await open(PATH, "Creator fit score");
    expect(screen.getByLabelText("Sample")).toHaveValue("Free sample · separate approval");
    expect(screen.getByText("Native Automate Invitations: off")).toBeInTheDocument();
    expect(screen.getByText(/No silent enablement/)).toBeInTheDocument();
  });

  it("links uncertain outcomes to recovery, and previews receipts as synthetic", async () => {
    const { user } = await open(PATH, "Creator fit score");
    expect(screen.getByRole("link", { name: "Explore uncertain invitation" })).toHaveAttribute("href", "/runs/demo-run-uncertain?tab=recovery");
    expect(screen.getByRole("link", { name: "Prepare invitation" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "Preview confirmed invitation" }));
    expect(dialog("Confirmed invitation · synthetic").getByText(/Only that receipt means sent/)).toBeInTheDocument();
  });

  it("shows an error and no numbers when the read fails with no access", async () => {
    renderRoute(PATH, scriptedAdapter(async () => {
      throw new AdapterError({ code: "FORBIDDEN", message: "no", requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    }));
    expect(await screen.findByRole("heading", { name: "No access to this account" })).toBeInTheDocument();
  });

  it("labels a stale read, and shows an empty state with no draft", async () => {
    await open(PATH, "Creator fit score", scriptedAdapter(async (request) => respondWith(request, invitationDemo, { dataVersion: "x", dataState: "stale" })));
    expect(screen.getByTestId("view-stale")).toBeInTheDocument();
  });
});
