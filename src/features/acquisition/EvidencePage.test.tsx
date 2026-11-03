import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { DEMO_EVIDENCE_PARTIAL_ID, DEMO_MEDIA_URL } from "@/fixtures/evidence";
import { renderRoute } from "@/test/renderWithAdapter";

const NEW_URL = "https://www.instagram.com/reel/NEWREEL0001/";
const open = async (id = "demo-evidence-1", adapter = createDemoAdapter()) => {
  const router = renderRoute(`/creators/demo-creator-1/evidence/${id}`, adapter);
  await screen.findByTestId("metric-Visual coverage");
  return { router, adapter, user: userEvent.setup() };
};
const metric = (label: string) => screen.getByTestId(`metric-${label}`);
const urlField = () => screen.getByLabelText("Original video URL");
const saves = () => screen.getAllByRole("button", { name: "Save partial review" });
// jsdom has no modal <dialog>, so it is never "open" to the accessibility tree: find it by its heading instead.
const dialog = (title: string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);

describe("video evidence review", () => {
  it("starts with nothing reviewed, and every unknown left unknown", async () => {
    await open();
    expect(metric("Visual coverage")).toHaveTextContent("Not reviewed");
    expect(metric("Audio coverage")).toHaveTextContent("Not reviewed");
    expect(metric("Creative quality")).toHaveTextContent("Unknown");
    expect(metric("Commerce confidence")).toHaveTextContent("Unknown");
    expect(metric("Published model")).toHaveTextContent("Pending");
    expect(screen.getByText("Playback pending")).toBeInTheDocument();
    expect(screen.queryByTestId("save-status")).not.toBeInTheDocument();
  });

  it("never lets a click mark the video watched, and says why on screen (CTRL-154)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open("demo-evidence-1", adapter);
    for (const button of screen.getAllByRole("button", { name: "Mark watched" })) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription(/Blocked until permitted playback/);
      await user.click(button);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("derives the route's model from the destination", async () => {
    const { user } = await open();
    expect(screen.getByTestId("model-badge")).toHaveTextContent(/WEBSITE/i);
    await user.selectOptions(screen.getByLabelText("Checkout route"), "tiktok-shop");
    expect(screen.getByTestId("model-badge")).toHaveTextContent("TIKTOK-SHOP-AFFILIATE-v3");
  });

  it("blocks adding an observation until there is a valid address, with the reason visible", async () => {
    const { user } = await open();
    const add = screen.getByRole("button", { name: "Add time-coded observation" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription(/valid original video URL/);
    await user.click(add);
    expect(screen.queryByRole("heading", { name: "Add time-coded observation", hidden: true })).not.toBeInTheDocument();
  });

  it("refuses a profile address with an error tied to the field, and saves nothing (CTRL-156)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "saveResource");
    const { user } = await open("demo-evidence-1", adapter);
    await user.type(urlField(), "https://www.instagram.com/demo.creator/");
    await user.click(saves()[0]!);
    expect(await screen.findByText(/profile/i, { selector: "[role=alert]" })).toBeInTheDocument();
    expect(urlField()).toHaveAttribute("aria-invalid", "true");
    expect(urlField()).toHaveAccessibleDescription(/profile/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("records an observation, counts coverage, saves, and still isn't a completed review", async () => {
    const { user } = await open();
    await user.type(urlField(), NEW_URL);
    await user.click(screen.getByRole("button", { name: "Add time-coded observation" }));
    const form = dialog("Add time-coded observation");
    await user.type(form.getByLabelText("From (m:ss)"), "0:00");
    await user.type(form.getByLabelText("To (m:ss)"), "0:08");
    await user.type(form.getByLabelText("Observation"), "Opens on a desk setup.");
    await user.click(form.getByRole("button", { name: "Add observation", hidden: true }));

    expect(metric("Visual coverage")).toHaveTextContent("Partial · 0:08 observed");
    expect(metric("Audio coverage")).toHaveTextContent("Not reviewed");
    expect(screen.getByText("Opens on a desk setup.")).toBeInTheDocument();

    await user.click(saves()[0]!);
    const status = await screen.findByTestId("save-status");
    expect(status).toHaveTextContent("Saved as version 2");
    expect(status).toHaveTextContent("A saved draft is not a completed review");
    expect(screen.getAllByRole("button", { name: "Mark watched" })[0]).toHaveAttribute("aria-disabled", "true");
    expect(urlField()).toHaveValue(NEW_URL);
  });

  it("rejects an observation with an end before its start, and keeps the dialog open", async () => {
    const { user } = await open(DEMO_EVIDENCE_PARTIAL_ID);
    await user.click(screen.getByRole("button", { name: "Add time-coded observation" }));
    const form = dialog("Add time-coded observation");
    await user.type(form.getByLabelText("From (m:ss)"), "0:30");
    await user.type(form.getByLabelText("To (m:ss)"), "0:10");
    await user.type(form.getByLabelText("Observation"), "Something.");
    await user.click(form.getByRole("button", { name: "Add observation", hidden: true }));
    expect(form.getByText("The end must be after the start.")).toBeInTheDocument();
    expect(metric("Visual coverage")).toHaveTextContent("0:31 observed");
  });

  it("changing the video invalidates earlier observations instead of re-attributing them", async () => {
    const { user } = await open(DEMO_EVIDENCE_PARTIAL_ID);
    expect(metric("Visual coverage")).toHaveTextContent("Partial · 0:31 observed");
    expect(metric("Audio coverage")).toHaveTextContent("Partial · 0:12 observed");
    expect(urlField()).toHaveValue(DEMO_MEDIA_URL);
    await user.clear(urlField());
    await user.type(urlField(), NEW_URL);
    expect(metric("Visual coverage")).toHaveTextContent("Not reviewed");
    expect(screen.getByText(/3 earlier observations were recorded against a different video/)).toBeInTheDocument();
    expect(screen.getAllByText("Invalidated: different video").length).toBeGreaterThan(0);
  });

  it("removes an observation from the draft without saving", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "saveResource");
    const { user } = await open(DEMO_EVIDENCE_PARTIAL_ID, adapter);
    await user.click(screen.getByRole("button", { name: "Remove observation 0:00 to 0:12" }));
    expect(metric("Audio coverage")).toHaveTextContent("Not reviewed");
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows a stale save as a conflict and keeps the draft", async () => {
    const adapter = createDemoAdapter();
    const { user } = await open("demo-evidence-1", adapter);
    await user.type(urlField(), NEW_URL);
    await adapter.saveResource({
      schemaVersion: "1", operation: "saveResource", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" },
      resourceKind: "evidenceDraft", resourceRef: "demo-evidence-1", expectedVersion: "v1", idempotencyKey: "other-tab", requestId: "r",
      payload: { mediaUrl: null, checkoutRoute: "tiktok-shop", observations: [] },
    } as never);
    await user.click(saves()[0]!);
    expect(await screen.findByTestId("action-error")).toHaveTextContent("This record changed");
    expect(urlField()).toHaveValue(NEW_URL);
  });

  it("opens the model status dialog with the unpublished state", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Inspect model status" }));
    expect(dialog("Model status").getByText(/Publication: Pending/)).toBeInTheDocument();
  });

  it("reports an unknown record honestly", async () => {
    renderRoute("/creators/demo-creator-1/evidence/nope", createDemoAdapter());
    expect(await screen.findByRole("heading", { name: /not found|couldn't|can't/i })).toBeInTheDocument();
    expect(screen.queryByTestId("metric-Visual coverage")).not.toBeInTheDocument();
  });
});
