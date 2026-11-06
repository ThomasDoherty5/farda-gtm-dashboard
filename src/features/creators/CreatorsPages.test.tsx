import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { AdapterError } from "@/adapter/errors";
import { respondWith } from "@/adapter/demoViews";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { socialCatBoardDemo, socialCatDashboardDemo, tiktokDashboardDemo } from "@/fixtures/creators";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";

const metric = (label: string) => screen.getByTestId(`metric-${label}`);
// jsdom has no modal <dialog>, so find it by its heading.
const dialog = (title: string) => within(screen.getAllByRole("dialog", { hidden: true }).find((d) => within(d).queryByRole("heading", { name: title, hidden: true }))!);
const open = async (path: string, ready: string, adapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findByTestId(`metric-${ready}`);
  return { router, adapter, user: userEvent.setup() };
};
const chooseOption = async (user: ReturnType<typeof userEvent.setup>, button: string, title: string, option: string) => {
  await user.click(screen.getByRole("button", { name: button }));
  await user.click(dialog(title).getByRole("radio", { name: option, hidden: true }));
};

describe("Social Cat lifecycle board (6:24)", () => {
  const BOARD = "/creators/social-cat?view=board";

  it("shows the stage counts, and they add up to the active collaborations", async () => {
    await open(BOARD, "Active collaborations");
    expect(metric("Active collaborations")).toHaveTextContent("66");
    expect(metric("Needs your decision")).toHaveTextContent("08");
    expect(metric("Content ready")).toHaveTextContent("06");
    const counts = ["applicants", "negotiating", "brief", "creating", "approved"].map((k) => Number(screen.getByTestId(`count-${k}`).textContent));
    expect(counts).toEqual([24, 12, 8, 16, 6]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(66);
  });

  it("keeps an unknown cost unknown, and says why", async () => {
    await open(BOARD, "Active collaborations");
    expect(metric("Cost per live video")).toHaveTextContent("N/A");
    expect(screen.getByText("N/A with zero live posts · costs may be incomplete")).toBeInTheDocument();
  });

  it("labels the snapshot as illustrative and commission-only, with no new upfront fee on a card", async () => {
    await open(BOARD, "Active collaborations");
    expect(screen.getByText("Operational stages and acquisition conversion")).toBeInTheDocument();
    expect(screen.getByText(/New offers are commission-only; accepted historical terms remain valid/)).toBeInTheDocument();
    expect(screen.getByText(/Illustrative creator handles and counts/)).toBeInTheDocument();
    expect(screen.queryByText(/Paid UGC/)).not.toBeInTheDocument();
    expect(screen.getByText("12% commission · proposed")).toBeInTheDocument();
  });

  it("recomputes for an owner and keeps it in the URL (CTRL-024)", async () => {
    const { user, router } = await open(BOARD, "Active collaborations");
    await chooseOption(user, "Owner: All owners", "Choose an owner", "Thomas");
    await waitFor(() => expect(metric("Active collaborations")).toHaveTextContent("16"));
    expect(router.state.location.search).toBe("?view=board&owner=Thomas");
    expect(metric("Needs your decision")).toHaveTextContent("03");
    expect(screen.getByText("@routine.with.ella")).toBeInTheDocument();
    expect(screen.getByText("@cozybyclaire")).toBeInTheDocument();
    expect(screen.queryByText("@lena.everyday")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Owner: Thomas" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Showing Thomas's collaborations: 16 in this view.");
  });

  it("restores the owner from the URL, and ignores one that isn't allowed", async () => {
    await open(`${BOARD}&owner=Operator`, "Active collaborations");
    expect(screen.getByRole("button", { name: "Owner: Operator" })).toBeInTheDocument();
    expect(metric("Active collaborations")).toHaveTextContent("13");
  });

  it("falls back to every owner for a value that isn't allowed", async () => {
    await open(`${BOARD}&owner=nobody`, "Active collaborations");
    expect(screen.getByRole("button", { name: "Owner: All owners" })).toBeInTheDocument();
    expect(metric("Active collaborations")).toHaveTextContent("66");
  });

  it("offers a list layout with the same records, without changing the cohort (CTRL-025)", async () => {
    const { user, router } = await open(BOARD, "Active collaborations");
    await chooseOption(user, "Layout: Board view", "Choose the board layout", "List view");
    expect(router.state.location.search).toBe("?view=board&layout=list");
    const table = await screen.findByTestId("lifecycle-list");
    expect(within(table).getAllByRole("row")).toHaveLength(11);
    expect(metric("Active collaborations")).toHaveTextContent("66");
    expect(screen.queryByTestId("lifecycle-board")).not.toBeInTheDocument();
  });

  it("marks Review queue as the current view, with no extra history entry (CTRL-023)", async () => {
    const { router, user } = await open(BOARD, "Active collaborations");
    const link = screen.getByRole("link", { name: "Review queue" });
    expect(link).toHaveAttribute("aria-current", "page");
    await user.click(link);
    expect(router.state.location.search).toBe("?view=board");
    expect(router.state.historyAction).not.toBe("PUSH");
  });

  it("hands off to the source without inventing a link, and never writes", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(BOARD, "Active collaborations", adapter);
    await user.click(screen.getByRole("button", { name: "Open Notion" }));
    expect(dialog("Open Notion").getByText(/No verified link is available for this record/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("links cards to the collaboration and the approval to its detail", async () => {
    await open(BOARD, "Active collaborations");
    expect(screen.getAllByRole("link", { name: "View collaboration →" })[0]).toHaveAttribute("href", "/collaborations/demo-collaboration-1?tab=overview");
    expect(screen.getByRole("link", { name: "Open approval detail" })).toHaveAttribute("href", "/approvals/demo-approval-042");
  });

  it("defaults an unknown view to the dashboard", async () => {
    await open("/creators/social-cat?view=bogus", "Linked-post views");
  });
});

describe("Social Cat dashboard (23:275)", () => {
  const DASH = "/creators/social-cat?view=dashboard";

  it("shows the cohort metrics with their coverage", async () => {
    await open(DASH, "Linked-post views");
    expect(metric("Linked-post views")).toHaveTextContent("90.0k");
    expect(screen.getByText("2 measurable posts · snapshot total")).toBeInTheDocument();
    expect(metric("Engagement rate")).toHaveTextContent("4.67%");
    expect(screen.getByText("4,200 interactions / 90,000 views")).toBeInTheDocument();
    expect(metric("Attributed orders")).toHaveTextContent("68");
    expect(metric("Attributed net sales")).toHaveTextContent("$2,176");
    expect(screen.getByText("2 of 4 posts measurable")).toBeInTheDocument();
    expect(screen.getByText(/Social Cat does not provide these post metrics/)).toBeInTheDocument();
  });

  it("recomputes for a publishing network, and keeps the all-network scale (CTRL-052–054)", async () => {
    const { user, router } = await open(DASH, "Linked-post views");
    const all = screen.getByRole("button", { name: "All publishing networks" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Instagram" }));
    await waitFor(() => expect(metric("Linked-post views")).toHaveTextContent("50.0k"));
    expect(router.state.location.search).toBe("?view=dashboard&network=instagram");
    expect(metric("Engagement rate")).toHaveTextContent("5.00%");
    expect(metric("Attributed orders")).toHaveTextContent("40");
    expect(metric("Attributed net sales")).toHaveTextContent("$1,296");
    expect(screen.getByRole("button", { name: "Instagram" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All publishing networks" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("region", { name: /shared 90k scale/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "TikTok" }));
    await waitFor(() => expect(metric("Linked-post views")).toHaveTextContent("40.0k"));
    await user.click(screen.getByRole("button", { name: "All publishing networks" }));
    await waitFor(() => expect(metric("Linked-post views")).toHaveTextContent("90.0k"));
    expect(router.state.location.search).toBe("?view=dashboard");
  });

  it("offers the chart as a table whose last day is the cohort total", async () => {
    await open(DASH, "Linked-post views");
    const table = screen.getByRole("table", { name: /Cumulative linked-post views by day/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(14);
    expect(within(rows.at(-1)!).getByRole("rowheader")).toHaveTextContent("Oct 29");
    expect(within(rows.at(-1)!).getByRole("cell")).toHaveTextContent("90,000");
  });

  it("keeps the gated history tabs unavailable, with the reason on screen (CTRL-055–057)", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user, router } = await open(DASH, "Linked-post views", adapter);
    for (const name of ["Gifted · history", "Paid · history", "Hybrid · history"]) {
      const tab = screen.getByRole("button", { name });
      expect(tab).toHaveAttribute("aria-disabled", "true");
      expect(tab).toHaveAccessibleDescription(/Read-only\. Past fees payable\. New offers commission-only\./);
      await user.click(tab);
    }
    expect(screen.getByRole("link", { name: "Affiliate" })).toHaveAttribute("aria-current", "page");
    expect(router.state.location.search).toBe("?view=dashboard");
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the pilot cohort apart, and derives its commission", async () => {
    await open(DASH, "Linked-post views");
    expect(screen.getByText("Synthetic cohort B · never add these values to the 30-day Launch A performance above.")).toBeInTheDocument();
    expect(metric("Net eligible sales")).toHaveTextContent("$1,800");
    expect(metric("Net accrued commission")).toHaveTextContent("$270");
    expect(screen.getByText("$300 gross less $30 reversed")).toBeInTheDocument();
    expect(metric("Cash commission paid")).toHaveTextContent("$90");
    expect(metric("Estimated contribution")).toHaveTextContent("$462.17");
  });

  it("reads the invitation-to-sales strip from the pipeline cohort", async () => {
    await open(DASH, "Linked-post views");
    const strip = within(screen.getByTestId("funnel-strip"));
    expect(strip.getAllByRole("definition").filter((d) => /^\d+$/.test(d.textContent ?? "")).map((d) => d.textContent)).toEqual(["27", "18", "15", "12", "9", "6"]);
    expect(strip.getByText("Match ≠ signed terms")).toBeInTheDocument();
    expect(strip.getByRole("link", { name: "Full acquisition funnel" })).toHaveAttribute("href", "/creators/pipeline");
  });

  it("links the title actions, the queue and the offer", async () => {
    await open(DASH, "Linked-post views");
    expect(screen.getByRole("link", { name: "Review applications" })).toHaveAttribute("href", "/creators/social-cat/recruitment");
    expect(screen.getByRole("link", { name: "Recruitment queue" })).toHaveAttribute("href", "/creators/social-cat/recruitment");
    expect(screen.getByRole("link", { name: "Open action queue" })).toHaveAttribute("href", "/creators/social-cat?view=board");
    expect(screen.getByRole("link", { name: "Configure offer" })).toHaveAttribute("href", "/offers/demo-offer-1");
    expect(screen.getByRole("link", { name: "Commission ledger" })).toHaveAttribute("href", "/finance/commissions");
    expect(screen.getByRole("link", { name: "Social Cat" })).toHaveAttribute("aria-current", "page");
  });
});

describe("TikTok funnel board (9:143)", () => {
  const BOARD = "/creators/tiktok?view=board";

  it("shows the nine stages, which add up to the creators in the funnel", async () => {
    await open(BOARD, "Creators in funnel");
    expect(metric("Creators in funnel")).toHaveTextContent("62");
    expect(metric("Awaiting approval")).toHaveTextContent("07");
    expect(metric("Posts published")).toHaveTextContent("03");
    expect(metric("Attributed sales")).toHaveTextContent("N/A");
    const tiles = within(screen.getByTestId("tiktok-stages")).getAllByRole("listitem").map((li) => Number(li.textContent?.slice(0, 2)));
    expect(tiles).toEqual([24, 12, 8, 6, 4, 3, 2, 2, 1]);
    expect(tiles.reduce((a, b) => a + b, 0)).toBe(62);
  });

  it("searches the worklist, keeps the query in the URL, and tells no matches from no data (CTRL-001)", async () => {
    const { user, router } = await open(BOARD, "Creators in funnel");
    const table = () => within(screen.getByTestId("worklist"));
    expect(table().getAllByRole("row")).toHaveLength(6);
    await user.type(screen.getByRole("searchbox", { name: "Search TikTok creators" }), "operations");
    await waitFor(() => expect(table().getAllByRole("row")).toHaveLength(2));
    expect(table().getByText("@dailywithjo")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?view=board&q=operations");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 5 sample records match “operations”.");
    await user.clear(screen.getByRole("searchbox", { name: "Search TikTok creators" }));
    await user.type(screen.getByRole("searchbox", { name: "Search TikTok creators" }), "zzz");
    expect(await screen.findByText(/No creator matches “zzz”/)).toBeInTheDocument();
    expect(screen.queryByTestId("worklist")).not.toBeInTheDocument();
  });

  it("restores the query from the URL", async () => {
    await open(`${BOARD}&q=posted`, "Creators in funnel");
    expect(screen.getByRole("searchbox", { name: "Search TikTok creators" })).toHaveValue("posted");
    expect(within(screen.getByTestId("worklist")).getByText("@cozybyclaire")).toBeInTheDocument();
  });

  it("states that approval comes before action, and that a source receipt is required", async () => {
    await open(BOARD, "Creators in funnel");
    expect(screen.getByText("Approval comes before action.")).toBeInTheDocument();
    expect(screen.getByText("Source receipt required")).toBeInTheDocument();
    expect(screen.getByText(/Voluntary gifts have no contractual posting obligation/)).toBeInTheDocument();
  });

  it("links to the other platform's board", async () => {
    await open(BOARD, "Creators in funnel");
    expect(screen.getByRole("link", { name: "Social Cat" })).toHaveAttribute("href", "/creators/social-cat?view=board");
  });
});

describe("TikTok dashboard (23:440)", () => {
  const DASH = "/creators/tiktok?view=dashboard";

  it("shows the cohort metrics, reconciled with the posts table", async () => {
    await open(DASH, "Post views");
    expect(metric("Post views")).toHaveTextContent("150.0k");
    expect(metric("Engagement rate")).toHaveTextContent("5.2%");
    expect(metric("Attributed orders")).toHaveTextContent("112");
    expect(metric("Attributed net sales")).toHaveTextContent("$3,620");
    expect(screen.getByText("3 of 5 posts measurable")).toBeInTheDocument();
    const rows = within(screen.getByTestId("posts-table")).getAllByRole("row").slice(1).map((r) => [...r.children].map((c) => c.textContent));
    expect(rows).toEqual([["@studio.rae", "84,000", "62", "$2,015"], ["@dailywithjo", "42,000", "31", "$995"], ["@oliviasunday", "24,000", "19", "$610"]]);
  });

  it("shows the share of orders that are traceable", async () => {
    await open(DASH, "Post views");
    expect(screen.getByRole("img", { name: "112 of 140 TikTok Shop orders attributed" })).toBeInTheDocument();
    expect(screen.getByText("80% of the demo’s 140 TikTok Shop orders")).toBeInTheDocument();
  });

  it("states native settlement as provider-owned, with no second manual commission payment", async () => {
    await open(DASH, "Post views");
    expect(screen.getByText(/no second manual commission payment/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Native settlement & rates" })).toHaveAttribute("href", "/finance/settlements/demo-settlement-1");
    expect(screen.getByRole("link", { name: "Prepare invitation" })).toHaveAttribute("href", "/creators/tiktok/invitations/new");
  });

  it("offers the chart as a table on the cohort's own scale", async () => {
    await open(DASH, "Post views");
    const table = screen.getByRole("table", { name: /Cumulative post views by day/ });
    expect(within(table).getAllByRole("row").at(-1)).toHaveTextContent("150,000");
    expect(screen.getByRole("region", { name: /shared 150k scale/ })).toBeInTheDocument();
  });

  it("shows N/A, not zero, when no post is measurable", async () => {
    const adapter = scriptedAdapter(async (request) => respondWith(request, { ...tiktokDashboardDemo, cohort: { ...tiktokDashboardDemo.cohort, measurablePosts: 0 } }, { dataVersion: "x" }));
    await open(DASH, "Post views", adapter);
    expect(metric("Post views")).toHaveTextContent("N/A");
    expect(metric("Engagement rate")).toHaveTextContent("N/A");
    expect(screen.getByText("No measurable post yet")).toBeInTheDocument();
    expect(metric("Attributed orders")).toHaveTextContent("112");
  });
});

describe("states shared by every view", () => {
  it.each([
    ["/creators/social-cat?view=board", "Active collaborations", socialCatBoardDemo],
    ["/creators/social-cat?view=dashboard", "Linked-post views", socialCatDashboardDemo],
    ["/creators/tiktok?view=dashboard", "Post views", tiktokDashboardDemo],
  ] as const)("labels a stale read on %s as not current", async (path, ready, data) => {
    await open(path, ready, scriptedAdapter(async (request) => respondWith(request, data, { dataVersion: "x", dataState: "stale" })));
    expect(screen.getByTestId("view-stale")).toHaveTextContent(/not current/);
  });

  it.each([["/creators/social-cat?view=board"], ["/creators/social-cat?view=dashboard"], ["/creators/tiktok?view=board"], ["/creators/tiktok?view=dashboard"]])("shows an empty state, not zeros, for no data on %s", async (path) => {
    renderRoute(path, scriptedAdapter(async (request) => respondWith(request, null, { dataVersion: "x", dataState: "empty" })));
    expect(await screen.findByRole("heading", { name: /^No .* (match|yet)$/ })).toBeInTheDocument();
  });

  it.each([["/creators/social-cat?view=board"], ["/creators/tiktok?view=dashboard"]])("shows a pending state, never demo numbers, when the backend isn't published (%s)", async (path) => {
    renderRoute(path, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId(/^metric-/)).not.toBeInTheDocument();
  });

  it("clears protected data on a 403", async () => {
    renderRoute("/creators/social-cat?view=dashboard", scriptedAdapter(async () => {
      throw new AdapterError({ code: "FORBIDDEN", message: "no", requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    }));
    expect(await screen.findByRole("heading", { name: "No access to this account" })).toBeInTheDocument();
    expect(screen.queryByTestId(/^metric-/)).not.toBeInTheDocument();
  });

  it("includes the filter in the request, so a different filter is a different read", async () => {
    const adapter = scriptedAdapter(async (request) => respondWith(request, filterOf(request.filters), { dataVersion: "x" }));
    function filterOf(f: unknown) { return { ...socialCatDashboardDemo, network: (f as { network: "all" }).network }; }
    const { user } = await open("/creators/social-cat?view=dashboard", "Linked-post views", adapter);
    await user.click(screen.getByRole("button", { name: "TikTok" }));
    await waitFor(() => expect(adapter.calls.map((c) => c.filters)).toEqual([{ network: "all" }, { network: "tiktok" }]));
  });
});

describe("FE02-05 commission-only policy and historical terms (links are covered by the daily and hourly destinations tests)", () => {
  it.each([["/creators/social-cat?view=dashboard", "Linked-post views"], ["/creators/tiktok?view=dashboard", "Post views"]])("%s says new acquisition is commission-only", async (path, ready) => {
    await open(path, ready);
    expect(screen.getByText("Commission-only acquisition")).toBeInTheDocument();
    expect(screen.getByText(/No upfront content fee; product and shipping are approved separately/)).toBeInTheDocument();
  });

  it.each(["/creators/social-cat?view=board", "/creators/tiktok?view=board"])("%s keeps accepted historical terms valid", async (path) => {
    renderRoute(path, createDemoAdapter());
    expect(await screen.findByText(/New offers are commission-only; accepted historical terms remain valid/)).toBeInTheDocument();
  });
});

describe("acquisition source, publishing network, checkout and payout owner stay separate (FE02-03)", () => {
  const fields = () => within(screen.getByTestId("channel-route"));
  const field = (name: string) => screen.getByTestId("channel-route").querySelector(`[data-field="${name}"]`)!.textContent;

  it("the Social Cat dashboard names all four, and says a TikTok post is not a TikTok Shop order", async () => {
    await open("/creators/social-cat?view=dashboard", "Linked-post views");
    expect(field("acquisition-source")).toBe("Source: Social Cat");
    expect(field("publishing-network")).toBe("Publishing: Instagram + TikTok");
    expect(field("checkout")).toBe("Checkout: Shopify website");
    expect(field("payout-owner")).toBe("Payout: Collabs provider (illustrative)");
    expect(screen.getByTestId("route-note")).toHaveTextContent("A TikTok post is not a TikTok Shop order.");
    expect(fields().getByText(/Publishing: Instagram \+ TikTok/)).toBeInTheDocument();
  });

  it("the TikTok dashboard names all four, with the source different from the publishing network and the checkout", async () => {
    await open("/creators/tiktok?view=dashboard", "Post views");
    expect(field("acquisition-source")).toBe("Source: Affiliate Center");
    expect(field("publishing-network")).toBe("Publishing: TikTok");
    expect(field("checkout")).toBe("Checkout: TikTok Shop");
    expect(field("payout-owner")).toBe("Payout: TikTok native settlement");
    const values = ["acquisition-source", "publishing-network", "checkout", "payout-owner"].map((n) => field(n)!.split(": ")[1]);
    expect(new Set(values).size).toBe(4);
  });

  it("the Social Cat dashboard keeps four distinct values too", async () => {
    await open("/creators/social-cat?view=dashboard", "Linked-post views");
    const values = ["acquisition-source", "publishing-network", "checkout", "payout-owner"].map((n) => field(n)!.split(": ")[1]);
    expect(new Set(values).size).toBe(4);
  });
});

describe("daily acquisition and hourly monitoring are distinct destinations (FE02-05)", () => {
  const link = (name: string) => (screen.getByRole("link", { name }) as HTMLAnchorElement).getAttribute("href");

  it.each([
    ["Social Cat dashboard", "/creators/social-cat?view=dashboard", "Linked-post views"],
    ["TikTok dashboard", "/creators/tiktok?view=dashboard", "Post views"],
    ["Social Cat board", "/creators/social-cat?view=board", "Active collaborations"],
    ["TikTok board", "/creators/tiktok?view=board", "Creators in funnel"],
  ])("the %s links daily sourcing and hourly monitoring separately", async (_name, path, ready) => {
    await open(path, ready);
    expect(link("Daily sourcing")).toBe("/creators/discovery");
    expect(link("Hourly monitoring")).toBe("/runs/demo-run-hourly");
    expect(link("Daily sourcing")).not.toBe(link("Hourly monitoring"));
  });

  it("the hourly destination is the read-only run, not the sourcing plan", async () => {
    const { router, user } = await open("/creators/tiktok?view=dashboard", "Post views");
    await user.click(screen.getByRole("link", { name: "Hourly monitoring" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/demo-run-hourly"));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});
