import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import type { FardaAdapter } from "@/adapter/adapter";
import { supportDemo } from "@/fixtures/support";
import { renderRoute } from "@/test/renderWithAdapter";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});

const open = (path: string, adapter: FardaAdapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  return { router, user: userEvent.setup() };
};
const metric = (label: string) => screen.getByTestId(`metric-${label}`);
const CASE = "/support/cases/TEST-ISS-021";

describe("support workspace", () => {
  it("keeps the 14-day cohort figures consistent: 45 tickets, 27 first-contact, 18 of 300 returns", async () => {
    open(CASE);
    expect(await screen.findByTestId("metric-First contact resolution")).toHaveTextContent("60%");
    expect(screen.getByText("27 of 45 cohort tickets")).toBeInTheDocument();
    expect(metric("Returns")).toHaveTextContent("6.0%");
    expect(screen.getByText("18 / 300 delivered units · same cohort")).toBeInTheDocument();
    expect(screen.getByText("14-day cohort · 45 tickets")).toBeInTheDocument();
    const mix = within(screen.getByTestId("issue-mix")).getByRole("list", { name: "Tickets by type" });
    expect(within(mix).getAllByRole("img").map((m) => m.getAttribute("aria-label"))).toEqual(["Setup / pairing: 18", "Shipping: 12", "Returns: 6", "Hardware: 9"]);
    const d = supportDemo("TEST-ISS-021")!;
    expect(d.cohort.tickets.reduce((n, t) => n + t.count, 0)).toBe(45);
    expect(screen.getByText("15 tickets / 100 delivered")).toBeInTheDocument();
  });

  it("separates the seven all-time open items from the six cohort-open tickets (FE10-04)", async () => {
    open(CASE);
    expect(await screen.findByTestId("metric-All-time open queue")).toHaveTextContent("7");
    expect(screen.getByText("6 open in the 14-day cohort")).toBeInTheDocument();
    expect(screen.getByText("All-time queue · source remains Intercom")).toBeInTheDocument();
  });

  it("derives the Fin cost share from the cost and the cap", async () => {
    open(CASE);
    expect(await screen.findByTestId("metric-Fin cost")).toHaveTextContent("$48 / $150");
    expect(screen.getByText("Demo monthly cap · 32% used")).toBeInTheDocument();
  });

  it("shows the selected case, and each queue row links to its own case", async () => {
    const { router, user } = open(CASE);
    const panel = await screen.findByTestId("case-panel");
    expect(within(panel).getByText("Human handoff")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "TEST-SP-0093" })).toHaveAttribute("href", "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129");
    await user.click(within(screen.getByTestId("queue-table")).getByRole("link", { name: /TEST-ISS-018/ }));
    expect(router.state.location.pathname).toBe("/support/cases/TEST-ISS-018");
    expect(await within(await screen.findByTestId("case-panel")).findByRole("link", { name: "TEST-RET-028" })).toHaveAttribute("href", "/returns/TEST-RET-028");
  });

  it("lists every state with its words, not only its color", async () => {
    open(CASE);
    const table = await screen.findByTestId("queue-table");
    for (const state of ["Needs reply", "Waiting", "In review", "Resolved"]) expect(within(table).getByText(state)).toBeInTheDocument();
  });

  it("mirrors no conversation text or customer detail, and offers no way to reply or reopen", async () => {
    open(CASE);
    await screen.findByTestId("case-panel");
    expect(document.body.textContent).not.toMatch(/@|street|avenue|dear customer/i);
    expect(screen.queryByRole("button", { name: /reply|reopen|assign|refund now/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Conversation text and personal details stay in Intercom/)).toBeInTheDocument();
  });

  it("hands off to Intercom with a dialog that says no verified link exists", async () => {
    const { user } = open(CASE);
    await user.click(await screen.findByRole("button", { name: "View conversation" }));
    expect(screen.getByText(/No verified link is available/)).toBeInTheDocument();
  });

  it("explains the cohort in a dialog and offers no other period the demo can't show", async () => {
    const { user } = open(CASE);
    await user.click(await screen.findByRole("button", { name: "14-day cohort" }));
    expect(screen.getByText(/The demo holds only this cohort/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("warns when the mirror is behind", async () => {
    open(`${CASE}?scenario=stale`);
    expect(await screen.findByTestId("source-freshness")).toHaveTextContent(/The mirror is behind: synced 3 hours ago/);
  });

  it("keeps the heading and says so for a case that does not exist", async () => {
    open("/support/cases/nope");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Support & returns");
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("Record not found");
  });

  it("never falls back to demo data on a live route", async () => {
    open(CASE, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("case-panel")).not.toBeInTheDocument();
  });
});
