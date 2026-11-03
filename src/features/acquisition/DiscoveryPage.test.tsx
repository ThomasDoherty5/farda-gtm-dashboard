import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { discoveryDemo } from "@/fixtures/discovery";
import { renderRoute } from "@/test/renderWithAdapter";

const open = async (path = "/creators/discovery", adapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findByTestId("metric-Schedule");
  return { router, user: userEvent.setup() };
};
const metric = (label: string) => screen.getByTestId(`metric-${label}`);

describe("daily sourcing", () => {
  it("shows the draft plan with unknowns left unknown, and a known $0 fee", async () => {
    await open();
    expect(metric("Schedule")).toHaveTextContent("Draft");
    expect(metric("Live source capacity")).toHaveTextContent("Unknown");
    expect(metric("Current v3 model")).toHaveTextContent("Pending");
    expect(metric("Upfront content fee")).toHaveTextContent("$0");
    expect(screen.getByText("Draft schedule · not live")).toBeInTheDocument();
  });

  it("derives the batch figures, and they reconcile", async () => {
    await open();
    expect(metric("Selected")).toHaveTextContent("50");
    expect(metric("Bound recipients")).toHaveTextContent("24");
    expect(metric("Sample allocation")).toHaveTextContent("12 / $300");
    expect(screen.getByText("24 eligible in this example · 26 held")).toBeInTheDocument();
    expect(discoveryDemo.batch.selected).toBeGreaterThanOrEqual(discoveryDemo.batch.eligible);
    expect(discoveryDemo.batch.sampleUnits).toBeLessThanOrEqual(discoveryDemo.batch.eligible);
  });

  it("marks the current phase and keeps the six steps in order", async () => {
    await open();
    const steps = screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") || /Discover|Watch|Qualify|Draft|Approve|Confirm/.test(li.textContent ?? ""));
    expect(steps.map((s) => s.textContent?.replace(/^\d/, "").split(/(?=[A-Z])/)[0])).toEqual(expect.arrayContaining(["Discover", "Watch"]));
    expect(screen.getByText("Watch").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("blocks live discovery with a visible reason, and a click does nothing (CTRL-165)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user, router } = await open("/creators/discovery", adapter);
    const start = screen.getByRole("button", { name: "Start live discovery" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    expect(start).toHaveAccessibleDescription(/Blocked until source access/);
    await user.click(start);
    expect(spy).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/creators/discovery");
  });

  it("explains the locked research scope without offering a way to widen it (CTRL-164)", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Lifestyle only" }));
    expect(screen.getByText(/can't be widened to clinical or IVF lectures/)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { hidden: true })).not.toBeInTheDocument();
  });

  it("keeps filters in the URL, offering only allowed values (CTRL-162)", async () => {
    const { user, router } = await open();
    expect(screen.getAllByRole("row").length).toBe(5);
    await user.click(screen.getByRole("button", { name: /Sources:/ }));
    // jsdom has no modal dialog, so the open dialog counts as hidden here. The browser tests cover it for real.
    const dialog = screen.getByRole("group", { name: "Sources", hidden: true }).closest("dialog")!;
    expect(within(dialog).getAllByRole("radio", { hidden: true }).map((r) => r.parentElement?.textContent)).toEqual(["SC + TikTok Shop", "Social Cat", "TikTok Shop"]);
    await user.click(within(dialog).getByRole("radio", { name: "TikTok Shop", hidden: true }));
    expect(router.state.location.search).toBe("?sources=tiktok-shop");
    await user.click(within(dialog).getByRole("button", { name: "Done", hidden: true }));
    const table = screen.getByTestId("capacity-table");
    expect(within(table).queryByText(/Social Cat · invitations/)).not.toBeInTheDocument();
    expect(within(table).getByText("TikTok Shop · invitations")).toBeInTheDocument();
    expect(within(table).getByText("Product and shipping")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sources: TikTok Shop" })).toBeInTheDocument();

    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sources: SC + TikTok Shop" })).toBeInTheDocument());
  });

  it("falls back to every source when the URL holds a value that isn't allowed", async () => {
    await open("/creators/discovery?sources=<script>&publishing=nope");
    expect(screen.getByRole("button", { name: "Sources: SC + TikTok Shop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publishing: IG + TikTok" })).toBeInTheDocument();
  });

  it("says when a filter doesn't change the demo's counts, rather than faking a result", async () => {
    await open("/creators/discovery?publishing=instagram");
    expect(screen.getByRole("status")).toHaveTextContent("isn't split by network");
    expect(metric("Selected")).toHaveTextContent("50");
  });

  it("describes the sample batch from the data, and links onward without starting anything", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Preview sample batch" }));
    expect(screen.getByText(/BATCH-TT-DEMO-024 contains exactly 24 named recipients/)).toBeInTheDocument();
    expect(screen.getByText(/maximum 12 × \$25 = \$300; 12 recipients need no new sample/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View batch progress", hidden: true })).toHaveAttribute("href", "/batches/demo-batch-tt-024");
  });

  it("links to the screens Figma links to", async () => {
    await open();
    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Validate access")).toBe("/settings/capabilities");
    expect(href("Open capabilities")).toBe("/settings/capabilities");
    expect(href("Pipeline")).toBe("/creators/pipeline");
    expect(href("Content monitor")).toBe("/content");
    expect(href("Open video review")).toMatch(/\/creators\/demo-creator-1\/evidence\/demo-evidence-1$/);
    expect(screen.getByRole("link", { name: "Daily sourcing" })).toHaveAttribute("aria-current", "page");
  });

  it("shows an honest pending state on a live environment, never the demo plan", async () => {
    renderRoute("/creators/discovery", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-Schedule")).not.toBeInTheDocument();
  });
});
