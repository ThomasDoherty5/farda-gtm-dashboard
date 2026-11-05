import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { DEMO_EVIDENCE_PARTIAL_ID, DEMO_MEDIA_URL } from "@/fixtures/evidence";
import { renderRoute } from "@/test/renderWithAdapter";
import { syntheticAgentEvidence, syntheticQualification } from "@/test/creatorQualification";
import type { ReadRequest, ReadResponse } from "@/adapter/contract";
import type { EvidenceRecord } from "./evidenceTypes";
import { bindConfig } from "@/creator-agent/config";
import approvedWebsiteManifest from "@/creator-agent/configurations/website-affiliate-v3.2026-11-04.json";
import { assessCreator } from "@/creator-agent/policy";
import { syntheticPacket, withActivationEvidence } from "@/creator-agent/testFixtures";

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

/** Models an adapter answer, not a local scoring path. The real service integration is tested separately. */
function withAgent(qualification = syntheticQualification(), agentEvidence = syntheticAgentEvidence()) {
  const adapter = createDemoAdapter();
  const read = adapter.readView.bind(adapter);
  const answer = async (request: ReadRequest<unknown>): Promise<ReadResponse<unknown>> => {
    const response = await read(request);
    return request.viewKey === "evidenceRecord" ? { ...response, data: { ...response.data as EvidenceRecord, qualification, agentEvidence } } : response;
  };
  vi.spyOn(adapter, "readView").mockImplementation(answer as typeof adapter.readView);
  return adapter;
}

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
    expect(dialog("Model status").getByText(/The evidence policy is approved/)).toBeInTheDocument();
    expect(screen.queryByText(/Weights stay unpublished until/)).not.toBeInTheDocument();
  });

  it("reads server zero/unknown critical ratings without replacing them with historical values or enabling actions", async () => {
    const qualification = syntheticQualification({ state: "hold", contentQualification: "hold", criteria: { routine: 0, demo: null } });
    const adapter = withAgent(qualification);
    const send = vi.spyOn(adapter, "submitAction");
    const { user } = await open("demo-evidence-1", adapter);
    expect(metric("Routine compatibility")).toHaveTextContent("0 / 5");
    expect(metric("Creative quality")).toHaveTextContent("Unknown");
    expect(metric("Saved model")).toHaveTextContent("Unbound when assessed");
    await user.click(screen.getByRole("button", { name: "Inspect model status" }));
    const details = screen.getByTestId("agent-qualification");
    expect(details).toHaveTextContent("Hold");
    expect(details).toHaveTextContent("2026-11-04");
    expect(details).toHaveTextContent("synthetic-evidence-1");
    expect(details).toHaveTextContent("Unknown — no bound score returned for this saved assessment");
    expect(screen.getAllByRole("button", { name: "Mark watched" })[0]).toHaveAttribute("aria-disabled", "true");
    expect(send).not.toHaveBeenCalled();
  });

  it("separates low-like metadata, sampled visual evidence and prompted comments in the server inspection", async () => {
    const { user } = await open("demo-evidence-1", withAgent());
    await user.click(screen.getByRole("button", { name: "Inspect model status" }));
    const details = within(screen.getByTestId("agent-qualification"));
    const baseline = details.getByRole("region", { name: "Server-selected recent metadata baseline", hidden: true });
    expect(baseline).toHaveTextContent("40 · exact");
    expect(details.getByText("1 / 3")).toBeInTheDocument();
    expect(details.getByText(/Metadata inclusion does not give deep-review/)).toBeInTheDocument();
    expect(details.getByRole("region", { name: "Server video review provenance", hidden: true })).toHaveTextContent("3 sampled points · 0s continuous coverage");
    const comments = details.getByRole("region", { name: "Observed comment rows synthetic-post-1", hidden: true });
    expect(comments).toHaveTextContent("How does the container open?");
    expect(comments).toHaveTextContent("Product understanding");
    expect(comments).toHaveTextContent("Prompted keyword");
    expect(comments).toHaveTextContent("Author unknown");
    expect(details.getByText(/not verified Farda orders/)).toBeInTheDocument();
  });

  it("keeps missing comments and baseline views unknown, and never rescores when the legacy draft route changes", async () => {
    const qualification = syntheticQualification({
      config: { status: "bound", version: "synthetic-config-7", hash: "synthetic-hash", baselineHash: "synthetic-baseline", numericHash: "synthetic-numeric" },
      configuration: { criteria: [{ id: "synthetic-routine", label: "Synthetic routine", weight: 43, rating: 3 }, { id: "synthetic-demo", label: "Synthetic demonstration", weight: 57, rating: 4 }], bands: [{ id: "Synthetic baseline", min: 0 }], arithmetic: "weight*rating/5;round-complete-total;no-rescaling" },
      metadata: { ...syntheticQualification().metadata, coverage: "partial", medianViews: null, minViews: null, maxViews: null, comparableViewCount: 0, reasonCodes: ["VIEWS_UNAVAILABLE"] },
      comments: [{ postId: "synthetic-post-1", status: "unavailable", rowCount: null, uniqueAuthors: null, unknownAuthorRows: null, promptedRows: null, creatorRows: null, promotionalRows: null, categoryCounts: null, ordering: null, reason: "Comments inaccessible" }],
    });
    const packet = syntheticAgentEvidence();
    packet.posts[0]!.comments = { status: "unavailable", reason: "Comments inaccessible" };
    const { user } = await open("demo-evidence-1", withAgent(qualification, packet));
    expect(metric("Saved model")).toHaveTextContent("Bound when assessed");
    await user.selectOptions(screen.getByLabelText("Checkout route"), "tiktok-shop");
    await user.click(screen.getByRole("button", { name: "Inspect model status" }));
    const details = within(screen.getByTestId("agent-qualification"));
    expect(details.getByRole("region", { name: "Agent assessment versions", hidden: true })).toHaveTextContent("WEBSITE-AFFILIATE-v3");
    expect(details.getByRole("region", { name: "Agent assessment versions", hidden: true })).toHaveTextContent("synthetic-config-7");
    expect(details.getByRole("region", { name: "Saved criterion weights", hidden: true })).toHaveTextContent("43%");
    expect(details.getByRole("region", { name: "Saved criterion weights", hidden: true })).toHaveTextContent("57%");
    expect(details.getByRole("region", { name: "Saved aggregate bands", hidden: true })).toHaveTextContent("Synthetic baseline");
    expect(details.getByRole("region", { name: "Metadata baseline summary", hidden: true })).toHaveTextContent("Unknown–Unknown");
    expect(details.getByRole("region", { name: "Buyer response sampling summary", hidden: true })).toHaveTextContent("Unknown rows · Unknown unique authors");
    expect(details.getByText(/Comments unavailable: Comments inaccessible/)).toBeInTheDocument();
    expect(dialog("Model status").getByText(/Editing the clip, route or observations here does not change its qualification/)).toBeInTheDocument();
  });

  it("labels a stale assessment's former binding as saved, without claiming it is the current published model", async () => {
    const qualification = syntheticQualification({
      state: "reviewNeeded",
      config: { status: "bound", version: "synthetic-previous-config", hash: "synthetic-previous-hash", baselineHash: "synthetic-baseline", numericHash: "synthetic-numeric" },
      configuration: {
        criteria: [{ id: "synthetic-routine", label: "Synthetic routine", weight: 43, rating: 3 }, { id: "synthetic-demo", label: "Synthetic demonstration", weight: 57, rating: 4 }],
        bands: [{ id: "Synthetic saved band", min: 0 }], arithmetic: "weight*rating/5;round-complete-total;no-rescaling",
      },
      gates: [{ id: "currentBasis", state: "unknown", reason: "The current configuration changed or is unavailable; this saved assessment needs a fresh review." }],
      reasonCodes: ["CURRENT_CONFIG_CHANGED"],
    });
    const { user } = await open("demo-evidence-1", withAgent(qualification));
    expect(metric("Saved model")).toHaveTextContent("Bound when assessed");
    expect(screen.queryByTestId("metric-Published model")).not.toBeInTheDocument();
    expect(screen.getByText(/as-assessed configuration synthetic-previous-config/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inspect model status" }));
    const details = within(screen.getByTestId("agent-qualification"));
    expect(details.getByText("Review needed", { exact: false })).toBeInTheDocument();
    expect(details.getByRole("region", { name: "Saved criterion weights", hidden: true })).toHaveTextContent("43%");
    expect(details.getByRole("region", { name: "Saved aggregate bands", hidden: true })).toHaveTextContent("Synthetic saved band");
    expect(details.queryByRole("region", { name: "Bound current criterion weights", hidden: true })).not.toBeInTheDocument();
    expect(details.getByRole("region", { name: "Server qualification gates", hidden: true })).toHaveTextContent("current configuration changed or is unavailable");
    expect(dialog("Model status").getByText(/current model publications are listed in daily sourcing/)).toBeInTheDocument();
  });

  it("reports an unknown record honestly", async () => {
    renderRoute("/creators/demo-creator-1/evidence/nope", createDemoAdapter());
    expect(await screen.findByRole("heading", { name: /not found|couldn't|can't/i })).toBeInTheDocument();
    expect(screen.queryByTestId("metric-Visual coverage")).not.toBeInTheDocument();
  });

  it("reads the approved bound weight table, actual server score and supplied criterion proof without a local decision", async () => {
    const packet = withActivationEvidence(syntheticPacket("website"));
    packet.creatorId = "demo-creator-1";
    packet.ratings = { routine: 5, demo: 4 };
    packet.criterionRatings = { verifiedCommerce: 3, audienceAlignment: 4, reliability: 4, offerEconomics: 4 };
    packet.criterionEvidenceRefs = Object.fromEntries(Object.keys(packet.criterionRatings).map((id) => [id, [`synthetic:approved-proof:${id}`]]));
    // Static JSON import works in jsdom; filesystem-based loadApprovedBindings is exercised by the real Node HTTP suite.
    const manifest = approvedWebsiteManifest[0]!;
    const binding = bindConfig(manifest.current, manifest.baseline, manifest.expectedBaselineHash);
    const qualification = assessCreator(packet, binding);
    expect(qualification.score!.total).toBe(82);
    const { user } = await open("demo-evidence-1", withAgent(qualification, packet));
    expect(metric("Saved model")).toHaveTextContent("Bound when assessed");
    expect(metric("Routine compatibility")).toHaveTextContent("5 / 5");
    expect(metric("Creative quality")).toHaveTextContent("4 / 5");
    await user.click(screen.getByRole("button", { name: "Inspect model status" }));
    const details = within(screen.getByTestId("agent-qualification"));
    expect(details.getByText(/Activation ready/)).toBeInTheDocument();
    expect(details.getByRole("region", { name: "Agent assessment versions", hidden: true })).toHaveTextContent("2026-11-04.launch-v1");
    const weights = details.getByRole("region", { name: "Saved criterion weights", hidden: true });
    expect(weights).toHaveTextContent("25%");
    expect(weights).toHaveTextContent("20%");
    expect(weights).toHaveTextContent("synthetic:approved-proof:verifiedCommerce");
    expect(details.getByText(/total82|total 82/)).toHaveTextContent("priorityReview");
    expect(screen.getAllByRole("button", { name: "Mark watched" })[0]).toHaveAttribute("aria-disabled", "true");
  });
});
