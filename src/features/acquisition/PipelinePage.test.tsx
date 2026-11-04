import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { AdapterError } from "@/adapter/errors";
import { respondWith } from "@/adapter/demoViews";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { pipelineDemo, pipelineSources } from "@/fixtures/pipeline";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";

const open = async (path = "/creators/pipeline", adapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findByTestId("metric-Confirmed invitations");
  return { router, adapter, user: userEvent.setup() };
};
const metric = (label: string) => screen.getByTestId(`metric-${label}`);
const funnel = (key: string) => screen.getByTestId(`funnel-${key}`);
// jsdom has no modal <dialog>, so find it by its heading.
const dialog = (title: string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);

describe("full acquisition pipeline", () => {
  it("shows the headline counts with their exact denominators, and says attempts are not invitations", async () => {
    await open();
    expect(metric("Confirmed invitations")).toHaveTextContent("54");
    expect(screen.getByText("54 unique opportunities · not 58 attempts")).toBeInTheDocument();
    expect(metric("Matched / accepted")).toHaveTextContent("36");
    expect(screen.getByText("66.7% of confirmed sends · source-native meaning")).toBeInTheDocument();
    expect(metric("Terms confirmed")).toHaveTextContent("30");
    expect(screen.getByText("Acceptance is separate from a Social Cat match")).toBeInTheDocument();
    expect(metric("Retained-order creators")).toHaveTextContent("12");
    expect(screen.getByText("12 of 18 published creators · not 40 orders")).toBeInTheDocument();
  });

  it("states commission-only acquisition and labels the cohort as illustrative", async () => {
    await open();
    expect(screen.getByText("Commission-only acquisition")).toBeInTheDocument();
    expect(screen.getByText(/No upfront content fee\. Product and shipping need separate approval/)).toBeInTheDocument();
    expect(screen.getByText("Illustrative cohort")).toBeInTheDocument();
    expect(screen.getByText(/no real creators qualified or invitations sent/)).toBeInTheDocument();
  });

  it("draws every stage with its conversion, median and not-advanced count", async () => {
    await open();
    expect(within(funnel("discovered")).getByText("120")).toBeInTheDocument();
    expect(within(funnel("discovered")).getByText("Cohort start")).toBeInTheDocument();
    const matched = within(funnel("matched"));
    expect(matched.getByText("66.7%")).toBeInTheDocument();
    expect(matched.getByText("4d median")).toBeInTheDocument();
    expect(matched.getByText("18 not advanced")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /counts on a shared 120 scale/ })).toBeInTheDocument();
  });

  it("keeps a Social Cat match apart from accepted terms, and TikTok acceptance in its own words", async () => {
    await open();
    const table = screen.getByTestId("native-table");
    const sc = within(within(table).getByRole("rowheader", { name: "Social Cat" }).closest("tr")!);
    expect(sc.getByText("18 matched")).toBeInTheDocument();
    expect(sc.getAllByRole("cell").map((c) => c.textContent)).toEqual(["18 matched", "15", "12"]);
    expect(within(within(table).getByRole("rowheader", { name: "TikTok Shop" }).closest("tr")!).getByText("18 accepted")).toBeInTheDocument();
    expect(screen.getByText(/Inbound applications use a separate route/)).toBeInTheDocument();
  });

  it("counts results, not clicks: 54 confirmed, 2 uncertain, 4 queued, and no blind retry", async () => {
    await open();
    expect(screen.getByText("60 approvals resolve to 54 sent, 2 uncertain and 4 queued.")).toBeInTheDocument();
    expect(screen.getByTestId("send-balance")).toHaveAccessibleName("54 confirmed, 2 uncertain, 4 queued");
    expect(screen.getByText("Uncertain · 2")).toBeInTheDocument();
    expect(screen.getByText("Queued · 4")).toBeInTheDocument();
    expect(screen.getByText("Replies · 30")).toBeInTheDocument();
    expect(screen.getByText(/58 attempts across 56 opportunities/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconcile uncertain sends" })).toHaveAttribute("href", "/runs/demo-run-uncertain?tab=recovery");
  });

  it("splits the work exclusively, and the stages add up to the cohort", async () => {
    await open();
    const cards = screen.getAllByTestId(/^stage-/).map((e) => Number(e.textContent));
    expect(cards).toEqual([24, 24, 12, 6, 18, 6, 6, 6, 6, 12]);
    expect(cards.reduce((a, b) => a + b, 0)).toBe(120);
    expect(screen.getByText("Exclusive stage counts add to 120. Every held item retains a reason, owner and next action.")).toBeInTheDocument();
    expect(screen.getByText("4 queued · 2 reconcile")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open work queue" })).toHaveAttribute("href", "/creators/social-cat?view=board");
  });

  it("derives the commerce outcomes, with a known $0 refund kept apart from unknown", async () => {
    await open();
    expect(metric("Views")).toHaveTextContent("120.0k");
    expect(metric("Engagement rate")).toHaveTextContent("4.0%");
    expect(metric("Attributed orders")).toHaveTextContent("40");
    expect(screen.getByText("2 fully refunded · 38 retained")).toBeInTheDocument();
    expect(metric("Attributed net sales")).toHaveTextContent("$1,140");
    expect(screen.getByText("$1,200 merchandise − $60 refunds")).toBeInTheDocument();
    expect(screen.getByText(/Social Cat source contributes \$450; TikTok Shop source contributes \$690/)).toBeInTheDocument();
  });

  it("recomputes for the source filter, keeps the shared scale, and puts the filter in the URL (CTRL-149)", async () => {
    const { user, router } = await open();
    await user.click(screen.getByRole("button", { name: "Source: Both" }));
    await user.click(dialog("Choose acquisition source").getByRole("radio", { name: "TikTok Shop", hidden: true }));
    await waitFor(() => expect(metric("Confirmed invitations")).toHaveTextContent("27"));
    expect(router.state.location.search).toBe("?source=tiktok-shop");
    expect(within(funnel("discovered")).getByText("60")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Source: TikTok Shop" })).toBeInTheDocument();
    expect(screen.getByText("60 TikTok Shop")).toBeInTheDocument();
    expect(screen.queryByText("60 Social Cat")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /shared 120 scale/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open work queue" })).toHaveAttribute("href", "/creators/tiktok?view=board");
  });

  it("restores filters from the URL, and ignores a value that isn't allowed", async () => {
    await open("/creators/pipeline?source=social-cat&network=bogus");
    expect(screen.getByRole("button", { name: "Source: Social Cat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Network: All" })).toBeInTheDocument();
    expect(metric("Confirmed invitations")).toHaveTextContent("27");
  });

  it("is honest that the demo can't split the other facets (CTRL-150–152)", async () => {
    await open("/creators/pipeline?network=tiktok&window=oct");
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent("Filtered by publishing network, cohort window. This demo cohort isn't split by those, so its counts don't change.");
    expect(metric("Confirmed invitations")).toHaveTextContent("54");
    expect(screen.getByRole("button", { name: "Cohort window: Oct 01–Oct 30" })).toHaveTextContent("Oct 01–Oct 30");
  });

  it("opens the cohort definition with a table that reconciles with the chart (CTRL-153)", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Inspect cohort" }));
    const inspect = dialog("Inspect cohort");
    expect(inspect.getByText("120 opportunities · 60 Social Cat + 60 TikTok Shop")).toBeInTheDocument();
    expect(inspect.getByText(/Opportunity: one per creator and route/)).toBeInTheDocument();
    expect(inspect.getByText(/Nov 2, 2026/)).toBeInTheDocument();
    const rows = [...screen.getByTestId("cohort-table").querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent));
    expect(rows[0]).toEqual(["Discovered", "120", "—", "N/A", "N/A"]);
    expect(rows[5]).toEqual(["Matched / accepted", "36", "54", "66.7%", "4d"]);
    expect(inspect.getByText(/Current-stage counts are exclusive and are shown separately/)).toBeInTheDocument();
  });

  it("makes no source write from any control", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open("/creators/pipeline", adapter);
    await user.click(screen.getByRole("button", { name: "Inspect cohort" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("marks Pipeline as the current section without a duplicate history entry (CTRL-235)", async () => {
    const { router, user } = await open();
    const link = screen.getByRole("link", { name: "Pipeline" });
    expect(link).toHaveAttribute("aria-current", "page");
    await user.click(link);
    expect(router.state.location.pathname).toBe("/creators/pipeline");
    expect(router.state.historyAction).not.toBe("PUSH");
  });

  it("shows N/A for a missing median and an unknown count, never zero", async () => {
    const [sc, tt] = pipelineSources;
    const adapter = scriptedAdapter(async (request) =>
      respondWith(request, { ...pipelineDemo, sources: [{ ...sc!, medianDays: sc!.medianDays.map((d, i) => (i === 5 ? null : d)) }, { ...tt!, reached: tt!.reached.map((n, i) => (i === 7 ? null : n)), medianDays: tt!.medianDays.map((d, i) => (i === 5 ? null : d)) }] }, { dataVersion: "x", dataState: "partial" }),
    );
    await open("/creators/pipeline", adapter);
    expect(within(funnel("matched")).getByText("N/A median")).toBeInTheDocument();
    expect(within(funnel("tracking")).getAllByText("N/A")).toHaveLength(2);
    expect(within(funnel("tracking")).getByText("N/A not advanced")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-partial")).toBeInTheDocument();
  });

  it("labels a stale read as not current", async () => {
    const adapter = scriptedAdapter(async (request) => respondWith(request, pipelineDemo, { dataVersion: "x", dataState: "stale" }));
    await open("/creators/pipeline", adapter);
    expect(screen.getByTestId("pipeline-stale")).toHaveTextContent(/not current/);
  });

  it("shows an empty state when no opportunity matches", async () => {
    const adapter = scriptedAdapter(async (request) => respondWith(request, null, { dataVersion: "x", dataState: "empty" }));
    renderRoute("/creators/pipeline", adapter);
    expect(await screen.findByRole("heading", { name: "No opportunities match" })).toBeInTheDocument();
    expect(screen.queryByTestId("metric-Confirmed invitations")).not.toBeInTheDocument();
  });

  it("shows a pending state, never demo numbers, when the backend isn't published", async () => {
    renderRoute("/creators/pipeline", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId("metric-Confirmed invitations")).not.toBeInTheDocument();
  });

  it("clears protected data on a 403", async () => {
    const adapter = scriptedAdapter(async () => {
      throw new AdapterError({ code: "FORBIDDEN", message: "no", requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    });
    renderRoute("/creators/pipeline", adapter);
    expect(await screen.findByRole("heading", { name: "No access to this account" })).toBeInTheDocument();
    expect(screen.queryByTestId("metric-Confirmed invitations")).not.toBeInTheDocument();
  });
});
