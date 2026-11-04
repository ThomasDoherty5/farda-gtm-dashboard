import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { AdapterError } from "@/adapter/errors";
import { respondWith } from "@/adapter/demoViews";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { pipelineDemo, pipelineSources } from "@/fixtures/pipeline";
import { branchesDemo } from "@/fixtures/pipelineBranches";
import { sampleTotals, terminalTotals, violationsPossible } from "./branchMetrics";
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

  it("CF-01 (CTRL-150–152): network, checkout, window and policy recompute the counts and live in the URL", async () => {
    const { user, router } = await open();
    const pick = async (button: string, title: string, option: string) => {
      await user.click(screen.getByRole("button", { name: button }));
      await user.click(dialog(title).getByRole("radio", { name: option, hidden: true }));
    };
    await pick("Network: All", "Choose publishing network", "TikTok");
    await waitFor(() => expect(metric("Confirmed invitations")).toHaveTextContent("22"));
    await pick("Checkout: All", "Choose checkout destination", "Website");
    await waitFor(() => expect(metric("Confirmed invitations")).toHaveTextContent("16"));
    await pick("Policy: All", "Choose policy version", "2026-10");
    await waitFor(() => expect(metric("Confirmed invitations")).toHaveTextContent("16"));
    expect(router.state.location.search).toBe("?network=tiktok&checkout=website&policy=policy-2026-10");
    expect(screen.queryByRole("status", { name: "" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /shared 120 scale/ })).toBeInTheDocument();
  });

  it("CF-01: the inbound route is a separate cohort where the outbound send stage is N/A, not zero", async () => {
    const { user, router } = await open();
    await user.click(screen.getByRole("button", { name: "Route: Outbound" }));
    await user.click(dialog("Choose inbound or outbound route").getByRole("radio", { name: "Inbound", hidden: true }));
    await waitFor(() => expect(metric("Confirmed invitations")).toHaveTextContent("N/A"));
    expect(router.state.location.search).toBe("?route=inbound");
    expect(screen.getByText(/applicants are never sent an outbound invitation/)).toBeInTheDocument();
    expect(within(funnel("confirmedSent")).getAllByText("N/A").length).toBeGreaterThan(0);
    expect(within(funnel("confirmedSent")).queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByTestId("stage-Dispatch")).toHaveTextContent("N/A");
    expect(screen.getByText(/applicants are never invited by us/)).toBeInTheDocument();
  });

  it("CF-01: the inbound route prints N/A, with a reason, wherever there is no send data", async () => {
    await open("/creators/pipeline?route=inbound");
    const reason = /inbound application has no outbound send/;
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    expect(screen.queryByText(/approvals resolve to/)).not.toBeInTheDocument();
    expect(screen.queryByText(/attempts across/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("send-balance")).not.toBeInTheDocument();
    expect(screen.getByText("Uncertain · N/A")).toBeInTheDocument();
    expect(screen.getByText("Queued · N/A")).toBeInTheDocument();
    expect(screen.getByText("Replies · N/A")).toBeInTheDocument();
    expect(screen.getByTestId("stage-Dispatch")).not.toHaveTextContent(/\b0 queued/);
    expect(screen.getByText("N/A · no outbound dispatch")).toBeInTheDocument();
    expect(screen.getByTestId("metric-Confirmed invitations")).not.toHaveTextContent(/\b0 attempts/);
    const reconcile = screen.getByRole("button", { name: "Reconcile uncertain sends" });
    expect(reconcile).toHaveAttribute("aria-disabled", "true");
  });

  it("CF-01: a selection with no cells is an empty state, not a zero funnel", async () => {
    await open("/creators/pipeline?route=inbound");
    const { user } = { user: userEvent.setup() };
    await user.click(screen.getByRole("button", { name: "Source: Both" }));
    await user.click(dialog("Choose acquisition source").getByRole("radio", { name: "TikTok Shop", hidden: true }));
    expect(await screen.findByRole("heading", { name: "No opportunities match" })).toBeInTheDocument();
    expect(screen.getByText(/not a count of zero/)).toBeInTheDocument();
    expect(screen.queryByTestId("funnel")).not.toBeInTheDocument();
  });

  it("CF-01: the cohort start and policy version are named in the cohort definition", async () => {
    const { user } = await open("/creators/pipeline?window=oct&policy=policy-2026-09");
    await user.click(screen.getByRole("button", { name: "Inspect cohort" }));
    expect(dialog("Inspect cohort").getByText(/cohort window: Oct 01–Oct 30 · policy version: 2026-09/)).toBeInTheDocument();
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

describe("terminal paths and optional branches (CF-05, CF-07)", () => {
  const BRANCHES = "/creators/pipeline?view=branches";
  const openBranches = async (path = BRANCHES) => {
    const router = renderRoute(path, createDemoAdapter());
    await screen.findByTestId("terminal-paths");
    return { router, user: userEvent.setup() };
  };
  const text = (id: string) => screen.getByTestId(id).textContent ?? "";

  it("CF-05: decline, opt-out and expiry are terminal and keep their suppression", async () => {
    await openBranches();
    expect(text("terminal-declined")).toContain("4");
    expect(text("terminal-optOut")).toContain("2");
    expect(text("terminal-expired")).toContain("4");
    expect(screen.getByText(/Suppression is kept/)).toBeInTheDocument();
    expect(screen.getByText(/An earlier approval is never reused|an earlier approval is never reused/i)).toBeInTheDocument();
  });

  it("CF-05: a repeat contact is a new opportunity that needs fresh approval, and an opt-out can never repeat", async () => {
    await openBranches();
    const rows = within(screen.getByTestId("repeat-cases")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Declined");
    expect(rows[0]).toHaveTextContent("New opportunity after a fresh suppression check");
    expect(rows[0]).toHaveTextContent("Fresh approval required · none on file");
    expect(rows[1]).toHaveTextContent("Expired");
    expect(rows[2]).toHaveTextContent("Opt-outPermanentNot allowed");
    expect(rows[2]).not.toHaveTextContent("Fresh approval required");
  });

  it("CF-05: terminal counts reconcile with the funnel's closed paths", () => {
    const closed = pipelineSources.reduce((a, s) => ({ declined: a.declined + s.closed.declined, expired: a.expired + s.closed.expired }), { declined: 0, expired: 0 });
    expect(terminalTotals(branchesDemo.sources)).toMatchObject(closed);
  });

  it("CF-07: a sample is optional; acceptance gates shipment, approved stock and cost gate reservation, tracking gates commerce", async () => {
    await openBranches();
    expect(text("sample-accepted")).toContain("36");
    expect(text("sample-requested")).toContain("21");
    expect(screen.getByText("15 continue without a sample")).toBeInTheDocument();
    expect(screen.getByText(/Acceptance gates shipment\. Approved stock and cost gate reservation\. Tracking gates commerce activation\./)).toBeInTheDocument();
  });

  it("CF-07: delivered is N/A, not zero, when a source has no carrier receipt", async () => {
    await openBranches();
    expect(text("sample-shipped")).toContain("11 / N/A");
    expect(sampleTotals(branchesDemo.sources).delivered).toBeNull();
  });

  it("CF-07: sample and content counts reconcile with the funnel and with each other", () => {
    for (const s of branchesDemo.sources) {
      const funnel = pipelineSources.find((p) => p.source === s.source)!;
      expect(s.sample.accepted).toBe(funnel.reached[5]);
      expect(s.sample.requested + s.sample.notRequested).toBe(s.sample.accepted);
      expect(s.content.terms).toBe(funnel.reached[6]);
      expect(s.content.trackingActive).toBe(funnel.reached[7]);
      expect(s.content.withObligation + s.content.withoutObligation).toBe(s.content.terms);
      expect(s.content.posted + s.content.due + s.content.overdue).toBe(s.content.withObligation);
      expect(s.content.postedVoluntarily + s.content.noneYet).toBe(s.content.withoutObligation);
    }
  });

  it("CF-07: only a committed obligation can be overdue; uncommitted content is never a violation", async () => {
    await openBranches();
    expect(screen.getByText(/A missing post is a violation only where the accepted terms create the obligation/)).toBeInTheDocument();
    expect(screen.getByText(/no violation possible/)).toBeInTheDocument();
    expect(screen.getByText(/3 overdue/)).toBeInTheDocument();
    expect(violationsPossible(branchesDemo.sources[0]!.content)).toBe(branchesDemo.sources[0]!.content.withObligation);
  });

  it("CF-10: the drilldowns reach the sample, content, approval and recovery contexts", async () => {
    await openBranches();
    expect(screen.getByRole("link", { name: "Open a sample context" })).toHaveAttribute("href", "/collaborations/demo-collaboration-1");
    expect(screen.getByRole("link", { name: "Open the content monitor" })).toHaveAttribute("href", "/content");
    expect(screen.getByRole("link", { name: "Open an approval" })).toHaveAttribute("href", "/approvals/demo-approval-exact");
    expect(screen.getByRole("link", { name: "Open run recovery" })).toHaveAttribute("href", "/runs/demo-run-uncertain?tab=recovery");
  });

  it("the source filter narrows the branches too, and the pipeline links here", async () => {
    await openBranches(`${BRANCHES}&source=tiktok-shop`);
    expect(text("sample-accepted")).toContain("18");
    expect(text("sample-shipped")).toContain("5 / N/A");
  });

  it("a pending backend shows no branch numbers", async () => {
    renderRoute(BRANCHES, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-paths")).not.toBeInTheDocument();
  });
});

describe("CF-08 and CF-10 across pipeline and monitor", () => {
  it("CF-08: the pipeline's commerce figures are the acquisition cohort's, and the monitor keeps its own coverage and cohort", async () => {
    await open();
    expect(screen.getByText(/Daily acquisition cohort; hourly monitoring keeps its own coverage and cohort/)).toBeInTheDocument();
    expect(screen.getByText(/Independent demo cohort/)).toBeInTheDocument();
    for (const name of ["Views", "Engagement rate", "Attributed orders", "Attributed net sales"]) expect(metric(name)).toBeInTheDocument();
  });

  it("CF-08: the monitor shows the same four metrics beside its own hourly cohort and coverage labels", async () => {
    renderRoute("/content", createDemoAdapter());
    expect(await screen.findByTestId("metric-engagement")).toBeInTheDocument();
    expect(screen.getByTestId("metric-orders")).toBeInTheDocument();
    expect(screen.getByTestId("metric-net-sales")).toBeInTheDocument();
    expect(screen.getByText(/Launch cohort A/)).toBeInTheDocument();
    expect(screen.getByText(/Hourly monitoring/)).toBeInTheDocument();
    expect(screen.getByText(/New-creator discovery and lifestyle evidence review are separate daily workflows/)).toBeInTheDocument();
    expect(screen.queryByText(/Independent demo cohort/)).not.toBeInTheDocument();
  });

  it("carries the source, route and network filters through Paths and branches and back, and says which apply", async () => {
    const q = "?source=social-cat&route=inbound&network=instagram";
    const { user, router } = await (async () => {
      const r = renderRoute(`/creators/pipeline${q}`, createDemoAdapter());
      await screen.findByTestId("metric-Confirmed invitations");
      return { router: r, user: userEvent.setup() };
    })();
    const link = screen.getByRole("link", { name: "Paths and branches" });
    expect(link).toHaveAttribute("href", "/creators/pipeline?view=branches&source=social-cat&route=inbound&network=instagram");
    await user.click(link);
    await screen.findByTestId("terminal-paths");
    const note = screen.getByTestId("branches-filters");
    expect(note).toHaveTextContent(/source: Social Cat/);
    expect(note).toHaveTextContent(/route: Inbound/);
    expect(note).toHaveTextContent(/split by source only, so route, publishing network do not change them/);
    const back = screen.getByRole("link", { name: "Back to pipeline" });
    expect(back).toHaveAttribute("href", "/creators/pipeline?source=social-cat&route=inbound&network=instagram");
    await user.click(back);
    await screen.findByTestId("metric-Confirmed invitations");
    expect(router.state.location.search).toBe(q);
  });

  it("CF-10: the pipeline's drilldowns reach the run recovery, work queue, evidence and branches", async () => {
    await open();
    expect(screen.getByRole("link", { name: "Reconcile uncertain sends" })).toHaveAttribute("href", "/runs/demo-run-uncertain?tab=recovery");
    expect(screen.getByRole("link", { name: "Open work queue" })).toHaveAttribute("href", "/creators/social-cat?view=board");
    expect(screen.getByRole("link", { name: "Review evidence" })).toHaveAttribute("href", "/creators/demo-creator-1/evidence/demo-evidence-1");
    expect(screen.getByRole("link", { name: "Paths and branches" })).toHaveAttribute("href", "/creators/pipeline?view=branches");
  });
});
