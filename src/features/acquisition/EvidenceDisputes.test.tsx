import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { DEMO_EVIDENCE_DISPUTED_ID, DEMO_EVIDENCE_PARTIAL_ID } from "@/fixtures/evidence";
import { renderRoute } from "@/test/renderWithAdapter";

const open = async (id: string, adapter = createDemoAdapter()) => {
  renderRoute(`/creators/demo-creator-1/evidence/${id}`, adapter);
  await screen.findByTestId("disputes");
  return { adapter, user: userEvent.setup() };
};
const section = () => within(screen.getByTestId("disputes"));
// jsdom has no modal <dialog>, so it is never "open" to the accessibility tree: find it by its heading instead.
const dialog = () => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: "Disagree or override", hidden: true }))!);
const disputeButton = (name: RegExp) => section().getByRole("button", { name });

describe("reviewer disagreement and override (VE-08)", () => {
  it("has nothing to dispute before a review is saved, and says so without blaming the reviewer", async () => {
    await open("demo-evidence-1");
    expect(section().getByTestId("no-first-review")).toHaveTextContent("No review is on file to dispute");
    expect(section().queryByRole("button", { name: /Disagree or override/ })).toBeNull();
    expect(screen.getByTestId("readiness")).toHaveTextContent("No completed review exists");
    expect(screen.getByTestId("readiness")).not.toHaveTextContent("contested");
  });

  it("shows the first reviewer's record read-only, with who, when and which version", async () => {
    await open(DEMO_EVIDENCE_PARTIAL_ID);
    expect(section().getByText(/Recorded by reviewer at version 3/)).toBeInTheDocument();
    const rows = section().getAllByRole("list", { name: "First reviewer's observations" })[0]!;
    expect(within(rows).getAllByRole("listitem")).toHaveLength(3);
    expect(within(rows).getByText("Voiceover over soft music.")).toBeInTheDocument();
    expect(within(rows).getAllByText("Recorded")).toHaveLength(3);
  });

  it("asks for a reason, and records nothing without one", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "saveResource");
    const { user } = await open(DEMO_EVIDENCE_PARTIAL_ID, adapter);
    await user.click(disputeButton(/audio and narrative 0:00 to 0:12/i));
    const form = dialog();
    await user.click(form.getByRole("button", { name: "Record disagreement", hidden: true }));
    expect(form.getByText(/Give a reason of at least 12 characters/)).toBeInTheDocument();
    expect(form.getByLabelText("Reason")).toHaveAttribute("aria-invalid", "true");
    expect(spy).not.toHaveBeenCalled();
  });

  it("records a disagreement beside the original, and nothing else changes", async () => {
    const { user } = await open(DEMO_EVIDENCE_PARTIAL_ID);
    const coverage = screen.getByTestId("metric-Audio coverage").textContent;
    await user.click(disputeButton(/audio and narrative 0:00 to 0:12/i));
    const form = dialog();
    await user.type(form.getByLabelText("Reason"), "There is no voiceover in this clip.");
    await user.click(form.getByRole("button", { name: "Record disagreement", hidden: true }));

    expect(await screen.findByTestId("dispute-status")).toHaveTextContent("Recorded at version 4. The first reviewer's record is unchanged.");
    const entry = await screen.findByTestId("dispute-entry");
    expect(entry).toHaveAttribute("data-stance", "disagree");
    expect(entry).toHaveTextContent("Voiceover over soft music.");
    expect(entry).toHaveTextContent("Disagrees. Proposes no replacement.");
    expect(entry).toHaveTextContent("There is no voiceover in this clip.");
    // The original is still there, now marked disputed; coverage, watched and readiness did not move.
    expect(section().getAllByText(/Voiceover over soft music\./).length).toBeGreaterThan(1);
    expect(section().getByText("Disputed")).toBeInTheDocument();
    expect(screen.getByTestId("metric-Audio coverage").textContent).toBe(coverage);
    expect(screen.getAllByRole("button", { name: "Mark watched" })[0]).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("readiness")).toHaveTextContent("Not ready");
    expect(screen.getByTestId("readiness")).toHaveTextContent("contested");
  });

  it("an override needs a valid replacement, or an explicit removal", async () => {
    const { user } = await open(DEMO_EVIDENCE_PARTIAL_ID);
    await user.click(disputeButton(/opening hook 0:00 to 0:08/i));
    const form = dialog();
    await user.click(form.getByRole("radio", { name: /Override/, hidden: true }));
    await user.type(form.getByLabelText("Reason"), "The opening is a different scene.");
    await user.click(form.getByRole("button", { name: "Record override", hidden: true }));
    expect(form.getByLabelText("What it should say")).toHaveAttribute("aria-invalid", "true");

    await user.click(form.getByRole("checkbox", { name: "Remove this observation instead of replacing it", hidden: true }));
    expect(form.queryByLabelText("What it should say")).toBeNull();
    await user.click(form.getByRole("button", { name: "Record override", hidden: true }));
    const entry = await screen.findByTestId("dispute-entry");
    expect(entry).toHaveAttribute("data-stance", "override");
    expect(entry).toHaveTextContent("Remove this observation.");
    expect(within(screen.getByTestId("disputes")).getAllByText(/Opens on a morning routine at a desk\./).length).toBeGreaterThan(1);
  });

  it("is blocked while the draft has unsaved edits, with the reason on the page", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "saveResource");
    const { user } = await open(DEMO_EVIDENCE_PARTIAL_ID, adapter);
    await user.click(screen.getByRole("button", { name: "Remove observation 0:00 to 0:12" }));
    const button = disputeButton(/audio and narrative 0:00 to 0:12/i);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(/Save or discard your draft first/);
    await user.click(button);
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows an existing override beside the original it disputes, with its reason and who recorded it", async () => {
    await open(DEMO_EVIDENCE_DISPUTED_ID);
    const entry = screen.getByTestId("dispute-entry");
    expect(entry).toHaveTextContent("Override");
    expect(entry).toHaveTextContent("Voiceover over soft music.");
    expect(entry).toHaveTextContent("Music only, no speech.");
    expect(entry).toHaveTextContent("The audio is music only");
    expect(entry).toHaveTextContent("Recorded by second reviewer");
    expect(section().getByText("Disputed")).toBeInTheDocument();
  });

  it("typing in the video field does not invalidate a saved dispute; only a saved change does", async () => {
    const { user } = await open(DEMO_EVIDENCE_DISPUTED_ID);
    const invalidated = () => within(screen.getByTestId("dispute-entry")).queryByText(/^Invalidated:/);
    expect(invalidated()).toBeNull();
    await user.clear(screen.getByLabelText("Original video URL"));
    await user.type(screen.getByLabelText("Original video URL"), "https://www.instagram.com/reel/NEWREEL0001/");
    expect(invalidated()).toBeNull(); // the draft is unsaved, so the saved record and its dispute still stand
  });

  it("marks a dispute invalidated once the saved video or checkout route differs", async () => {
    const adapter = createDemoAdapter();
    const save = (version: string, mediaUrl: string, checkoutRoute: string, key: string) => adapter.saveResource({
      schemaVersion: "1", operation: "saveResource", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" },
      resourceKind: "evidenceDraft", resourceRef: DEMO_EVIDENCE_DISPUTED_ID, expectedVersion: version, idempotencyKey: key, requestId: key,
      payload: { mediaUrl, checkoutRoute, observations: [] },
    } as never);
    const record = (await adapter.readView({ schemaVersion: "1", operation: "readView", viewKey: "evidenceRecord", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" }, filters: { creatorId: "demo-creator-1", evidenceId: DEMO_EVIDENCE_DISPUTED_ID }, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "q" } as never) as { data: { version: string; mediaUrl: string; checkoutRoute: string } }).data;
    await save(record.version, record.mediaUrl, record.checkoutRoute === "website" ? "tiktok-shop" : "website", "route-change");
    await open(DEMO_EVIDENCE_DISPUTED_ID, adapter);
    expect(within(screen.getByTestId("dispute-entry")).getByText("Invalidated: different route")).toBeInTheDocument();
  });

  it("shows a conflict when the record changed, and keeps the dialog and the typed reason", async () => {
    const adapter = createDemoAdapter();
    const { user } = await open(DEMO_EVIDENCE_PARTIAL_ID, adapter);
    await user.click(disputeButton(/audio and narrative 0:00 to 0:12/i));
    const form = dialog();
    await user.type(form.getByLabelText("Reason"), "There is no voiceover in this clip.");
    await adapter.saveResource({
      schemaVersion: "1", operation: "saveResource", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" },
      resourceKind: "evidenceDraft", resourceRef: DEMO_EVIDENCE_PARTIAL_ID, expectedVersion: "v3", idempotencyKey: "other-tab", requestId: "r",
      payload: { mediaUrl: "https://www.instagram.com/reel/DEMOREEL001/", checkoutRoute: "tiktok-shop", observations: [] },
    } as never).catch(() => undefined);
    await user.click(form.getByRole("button", { name: "Record disagreement", hidden: true }));
    expect(await screen.findByTestId("action-error")).toHaveTextContent("This record changed");
    expect(screen.queryByTestId("dispute-entry")).toBeNull();
    expect(form.getByLabelText("Reason")).toHaveValue("There is no voiceover in this clip.");
  });
});
