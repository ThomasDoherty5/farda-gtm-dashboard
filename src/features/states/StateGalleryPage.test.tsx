import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { renderRoute } from "@/test/renderWithAdapter";

const open = async () => {
  renderRoute("/design-system/states", createDemoAdapter());
  await screen.findByRole("heading", { name: "Every state has a next step", level: 1 });
  return userEvent.setup();
};
// jsdom has no modal <dialog>, so it is never "open" to the accessibility tree: find it by its heading instead.
const dialog = (title: string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);

describe("recovery state gallery (12:534)", () => {
  it("shows the twelve states, each named by a badge and with a next step", async () => {
    await open();
    const states = screen.getAllByRole("article");
    expect(states).toHaveLength(12);
    for (const state of states) {
      expect(within(state).getByRole("heading", { level: 3 })).toBeInTheDocument();
      expect(within(state).queryAllByRole("button").length + within(state).queryAllByRole("link").length).toBeGreaterThan(0);
    }
  });

  it("says Loading is busy and blocks its button, with the reason read out (CTRL-217)", async () => {
    await open();
    const card = screen.getByTestId("state-loading");
    expect(card).toHaveAttribute("aria-busy", "true");
    const button = within(card).getByRole("button", { name: "Loading…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Loading your orders");
    expect(within(card).getByRole("status")).toHaveTextContent("Loading your orders");
  });

  it("keeps Retry off after an uncertain outcome, and offers reconciliation instead (CTRL-218)", async () => {
    const user = await open();
    const card = screen.getByTestId("state-uncertain");
    const retry = within(card).getByRole("button", { name: "Retry disabled" });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).toHaveAccessibleDescription(/a duplicate send is possible/);
    await user.click(retry);
    expect(within(card).getByRole("heading", { name: "Confirm the send before retrying", level: 3 })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Reconcile in source" })).toHaveAttribute("href", "/runs/demo-run-uncertain?tab=recovery");
  });

  it("Keep task dismisses the confirmation and changes nothing (CTRL-177)", async () => {
    const user = await open();
    expect(screen.queryByTestId("kept-status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep task" }));
    expect(screen.getByTestId("kept-status")).toHaveTextContent("Nothing was canceled, and your edits are unchanged.");
    expect(screen.getByRole("heading", { name: "Cancel this queued task?" })).toBeInTheDocument();
  });

  it("sends each recovery to a logical destination", async () => {
    await open();
    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Open connections")).toBe("/settings/connections");
    expect(href("Open source health")).toBe("/settings/connections");
    expect(href("View failed run")).toBe("/runs/demo-run-uncertain");
    expect(href("View approval request")).toBe("/approvals/demo-approval-founder");
    expect(href("Reload source record")).toBe("/approvals/demo-approval-conflict");
    expect(href("View receipt")).toBe("/runs/demo-run-approval?tab=approval");
    expect(href("Review launch plan")).toBe("/launch?view=control");
  });

  it("never asks for a credential, and says so", async () => {
    const user = await open();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(/Never paste credentials into this UI/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Take over browser" }));
    expect(dialog("Take over browser").getByText(/No password, code or session is ever entered or stored in this app/)).toBeInTheDocument();
  });

  it("explains an example control that has no real target, and labels the page a development reference", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(dialog("Clear filters").getByText(/Here there are no filters, so nothing changes/)).toBeInTheDocument();
    expect(screen.getByText(/Development reference/)).toBeInTheDocument();
  });

  it("is routable, and highlights Automations as Figma does", async () => {
    await open();
    expect(screen.getByRole("link", { name: "Automations" })).toHaveAttribute("aria-current", "true");
  });
});
