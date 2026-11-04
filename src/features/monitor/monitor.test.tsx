import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { overviewOriginal, type OverviewFixtureKey } from "@/fixtures/overview";
import { contentMonitorDemo, hourlyRunDemo, monitorPosts, postPerformanceDemo, watchlistDemo } from "@/fixtures/monitor";
import { renderRoute } from "@/test/renderWithAdapter";
import { curvePoints, deltaHeight, engagement, interactionsOf, sumKnown } from "./monitorMath";

const open = (path: string, fixture: OverviewFixtureKey = "FX-01-happy-read") => renderRoute(path, createDemoAdapter({ fixture }));
const metric = (id: string) => screen.findByTestId(`metric-${id}`);
const openDialog = async () => {
  await waitFor(() => expect(screen.getAllByRole("dialog", { hidden: true }).some((d) => d.querySelector("h2"))).toBe(true));
  return screen.getAllByRole("dialog", { hidden: true }).find((d) => d.querySelector("h2"))!;
};

describe("demo records reconcile to the shared creator cohort", () => {
  it("the five posts add up to the Overview's 240,000 views, 12,000 interactions, 180 orders and $5,796", () => {
    expect(sumKnown(monitorPosts, (p) => p.views)).toBe(240_000);
    expect(monitorPosts.reduce((s, p) => s + (interactionsOf(p.interactions) ?? 0), 0)).toBe(12_000);
    expect(sumKnown(monitorPosts, (p) => p.orders)).toBe(overviewOriginal.attributedOrders.value);
    expect(monitorPosts.reduce((s, p) => s + (p.netSales?.minorUnits ?? 0), 0)).toBe(overviewOriginal.attributedNetSales.value!.minorUnits);
    expect(engagement(monitorPosts)?.ratePct).toBe(5);
  });

  it("the view curve ends at the post total, and the daily deltas add up to the post's views", () => {
    expect(contentMonitorDemo.curve.thousands.at(-1)).toBe(240);
    expect(postPerformanceDemo.dailyDeltas.reduce((s, d) => s + d.thousands, 0) * 1000).toBe(postPerformanceDemo.views);
  });

  it("the watchlist counts add up", () => {
    const t = watchlistDemo.totals;
    expect(t.active + t.identityReview + t.excluded).toBe(t.tracked);
    expect(t.socialCat + t.tiktok).toBe(t.tracked);
  });
});

describe("rules", () => {
  it("a missing count makes the total unknown, never a partial sum or zero", () => {
    expect(sumKnown([{ ...monitorPosts[0]!, views: null }, monitorPosts[1]!], (p) => p.views)).toBeNull();
    expect(sumKnown([], (p) => p.views)).toBeNull();
    expect(engagement([{ ...monitorPosts[0]!, interactions: null }])).toBeNull();
    const partial = engagement([monitorPosts[0]!, { ...monitorPosts[1]!, interactions: null }]);
    expect(partial).toMatchObject({ included: 1, excluded: 1 });
  });

  it("the curve and bars use one zero-based scale", () => {
    const { max, pts } = curvePoints([3, 240], 732, 204);
    expect(max).toBe(240);
    expect(pts.at(-1)).toEqual({ x: 732, y: 0 });
    expect(pts[0]!.y).toBeCloseTo(201.45, 2);
    expect([deltaHeight(17, 17), deltaHeight(1, 17), deltaHeight(8, 17), deltaHeight(0, 0)]).toEqual([180, 11, 85, 0]);
  });
});

describe("content monitor (23:73)", () => {
  it("shows the cohort totals with their denominators", async () => {
    open("/content");
    expect(await metric("views")).toHaveTextContent("240.0k");
    expect(await metric("engagement")).toHaveTextContent("5.0%");
    expect(screen.getByText("12,000 interactions / 240,000 views")).toBeInTheDocument();
    expect(await metric("orders")).toHaveTextContent("180");
    expect(await metric("net-sales")).toHaveTextContent("$5,796");
    expect(screen.getByRole("link", { name: "Content monitor" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Demo · hourly plan not live")).toBeInTheDocument();
  });

  it("CTRL-049: the network filter is URL state and recomputes the totals with a stated denominator", async () => {
    const user = userEvent.setup();
    const router = open("/content");
    await user.click(await screen.findByRole("button", { name: "All post networks" }));
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole("radio", { name: "Instagram", hidden: true }));
    await user.click(within(dialog).getByRole("button", { name: "Done", hidden: true }));
    await waitFor(() => expect(router.state.location.search).toBe("?network=instagram"));
    expect(await screen.findByText(/Showing 1 of 5 posts/)).toBeInTheDocument();
    expect(await metric("views")).toHaveTextContent("60.0k");
  });

  it("CTRL-051: a search with no match says so and is not zero posts; a search that matches filters the table", async () => {
    const user = userEvent.setup();
    open("/content");
    const box = await screen.findByRole("searchbox", { name: "Search handle or post" });
    await user.type(box, "nobody");
    expect(await screen.findByText(/No posts match “nobody”/)).toBeInTheDocument();
    expect(screen.getByText(/isn't zero posts/)).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "P-003");
    const table = await screen.findByRole("table", { name: "Creator post performance" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(within(table).getByText("@dailywithjo · P-003")).toBeInTheDocument();
  });

  it("CTRL-050: a window with no snapshot has unknown counts, not zeros", async () => {
    open("/content?window=last-7");
    expect(await metric("views")).toHaveTextContent("N/A");
    expect(await metric("orders")).toHaveTextContent("N/A");
    expect(screen.getByText(/counts are unknown, not zero/)).toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });

  it("FX-04: a post missing its interactions is left out of the engagement rate", async () => {
    open("/content", "FX-04-missing-metric");
    expect(await metric("engagement")).not.toHaveTextContent("N/A");
    expect(screen.getByText(/interactions \/ \d/)).toBeInTheDocument();
  });

  it("Inspect coverage is a read-only disclosure", async () => {
    const user = userEvent.setup();
    open("/content");
    await user.click(await screen.findByRole("button", { name: "Inspect coverage" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/kept as N\/A, not zero/)).toBeInTheDocument();
    expect(within(dialog).getByText(/starts no check and enrolls no one/)).toBeInTheDocument();
  });

  it("an account without access sees no data", async () => {
    open("/content", "FX-08-forbidden-account");
    expect(await screen.findByRole("alert")).toHaveTextContent("No access to this account");
    expect(screen.queryByTestId("metric-views")).not.toBeInTheDocument();
  });
});

describe("watchlist (25:166)", () => {
  it("shows data-bound counts and keeps unknown separate from zero", async () => {
    open("/creators/watchlist");
    expect(await metric("tracked")).toHaveTextContent("40");
    expect(await metric("identity")).toHaveTextContent("5");
    expect(await screen.findByRole("button", { name: "Review 5 matches" })).toBeInTheDocument();
    expect(screen.getByText("24 Social Cat intake / 16 TikTok intake")).toBeInTheDocument();
    expect(screen.getByText("12 reporting creators are a subset of the active watchlist.")).toBeInTheDocument();
  });

  it("CTRL-060: the state filter is URL state and says the rows are a sample of the watchlist", async () => {
    open("/creators/watchlist?state=excluded");
    expect(await screen.findByText(/Showing 1 of 40 profiles/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Creator watchlist" });
    expect(within(table).getByText(/@calm\.with\.jo/)).toBeInTheDocument();
  });

  it("CTRL-058: reviewing matches quarantines, and merges nothing", async () => {
    const user = userEvent.setup();
    open("/creators/watchlist");
    await user.click(await screen.findByRole("button", { name: "Review 5 matches" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/reviewing them doesn't merge any identity/)).toBeInTheDocument();
    expect(within(dialog).getByText(/@move\.with\.ana/)).toBeInTheDocument();
  });

  it("CTRL-211 and CTRL-212: identity and exclusion open read-only with their evidence", async () => {
    const user = userEvent.setup();
    open("/creators/watchlist");
    await user.click(await screen.findByRole("button", { name: "Match the correct profile →" }));
    expect(within(await openDialog()).getByText(/Quarantined\. Nothing is merged\./)).toBeInTheDocument();
    await user.click(within(await openDialog()).getByRole("button", { name: "Close", hidden: true }));
    await user.click(screen.getByRole("button", { name: "View exclusion reason →" }));
    await waitFor(async () => expect(within(await openDialog()).getByText(/doesn't remove the exclusion/)).toBeInTheDocument());
  });

  it("an empty answer is not zero profiles", async () => {
    open("/creators/watchlist", "FX-03-empty-filter");
    expect(await screen.findByText(/That is not zero profiles/)).toBeInTheDocument();
  });
});

describe("hourly run (25:307)", () => {
  it("shows the run's outcome counts, and the failure that needs a person", async () => {
    open("/runs/demo-run-hourly");
    expect(await metric("checked")).toHaveTextContent("31 / 32");
    expect(screen.getByText("1 browser session needs reconnection")).toBeInTheDocument();
    expect(await metric("posts")).toHaveTextContent("4");
    expect(await metric("inbox")).toHaveTextContent("9");
    expect(await metric("reviews")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Review 2 changes" })).toBeInTheDocument();
    expect(screen.getByText(/RUN-MON-1029-1000/)).toBeInTheDocument();
  });

  it("CTRL-019 to CTRL-021: the schedule, next run and retry policy are read-only snapshots", async () => {
    open("/runs/demo-run-hourly");
    for (const [label, value] of [["Schedule", "Every hour, on the hour"], ["Next example run", "11:00 AM PT"], ["Retry behavior", "Resume from checkpoint"]] as const) {
      const field = await screen.findByLabelText(label);
      expect(field).toHaveValue(value);
      expect(field).toHaveAttribute("readonly");
    }
    expect(screen.getByRole("link", { name: "Manage schedule" })).toHaveAttribute("href", "/automations/demo-jobId/schedule");
  });

  it("CTRL-022: retrying the failed profile is blocked with a reason, and nothing is shown as retried", async () => {
    const user = userEvent.setup();
    open("/runs/demo-run-hourly");
    await user.click(await screen.findByRole("button", { name: "Retry failed profile" }));
    expect(await screen.findByText(/Not retried: @everyday\.lee needs its source session reconnected first\. Nothing ran, and nothing was resent\./)).toBeInTheDocument();
    expect(screen.queryByText(/retried successfully|Retry state: succeeded/)).not.toBeInTheDocument();
  });

  it("CTRL-213: a status suggestion shows current and proposed values and can't overwrite the source", async () => {
    const user = userEvent.setup();
    open("/runs/demo-run-hourly");
    await user.click(await screen.findByRole("button", { name: "Review status suggestion →" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText("ready for review")).toBeInTheDocument();
    expect(within(dialog).getByText(/can't silently overwrite an authoritative source fact/)).toBeInTheDocument();
  });

  it("Reconnect source is a login handoff that never takes credentials", async () => {
    const user = userEvent.setup();
    open("/runs/demo-run-hourly");
    await user.click(await screen.findByRole("button", { name: "Reconnect source" }));
    expect(within(await openDialog()).getByText(/This app never sees credentials/)).toBeInTheDocument();
  });

  it("an approval run is not an hourly run", async () => {
    open("/runs/demo-run-hourly-nope");
    expect(await screen.findByRole("alert")).toHaveTextContent("This isn't an hourly monitoring run.");
  });
});

describe("post performance (25:481)", () => {
  it("shows the post's own metrics, with GMV kept apart from net sales", async () => {
    open("/content/P-001");
    expect(await metric("views")).toHaveTextContent("84,000");
    expect(await metric("engagement")).toHaveTextContent("6.0%");
    expect(screen.getByText("5,040 interactions / 84,000 views")).toBeInTheDocument();
    expect(await metric("orders")).toHaveTextContent("62");
    expect(await metric("net-sales")).toHaveTextContent("$2,015");
    expect(screen.getByText(/never relabeled as net sales/)).toBeInTheDocument();
    expect(screen.getByText(/Saves and unique reach are unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Daily views gained: Oct 19 1k/ })).toBeInTheDocument();
  });

  it("FE07-05: TikTok-reported GMV is labeled as GMV in the attribution evidence, and net sales is defined as after discounts and refunds", async () => {
    const user = userEvent.setup();
    open("/content/P-001");
    expect(await metric("net-sales")).toHaveTextContent("$2,015");
    expect(screen.getByText("After discounts and refunds; USD")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View attribution evidence" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText("GMV")).toBeInTheDocument();
    expect(within(dialog).getByText("TikTok-reported GMV is kept apart and is never net sales")).toBeInTheDocument();
    expect(within(dialog).getByText(/\$2,015 after discounts and refunds/)).toBeInTheDocument();
    expect(screen.getByText(/TikTok-reported GMV is retained separately with its source definition and window/)).toBeInTheDocument();
  });

  it("a post with no consecutive snapshots says so instead of drawing a flat chart", async () => {
    open("/content/P-002");
    expect(await screen.findByText(/Daily snapshots aren't available for this post/)).toBeInTheDocument();
    expect(await metric("views")).toHaveTextContent("60,000");
  });

  it("FX-04: missing views and interactions read N/A, not zero", async () => {
    open("/content/P-001", "FX-04-missing-metric");
    expect(await metric("views")).toHaveTextContent("N/A");
    expect(await metric("engagement")).toHaveTextContent("N/A");
    expect(screen.getByText(/Interactions are unavailable for this post\. They stay unknown, not zero\./)).toBeInTheDocument();
  });

  it("Open source post names that no verified link exists", async () => {
    const user = userEvent.setup();
    open("/content/P-001");
    await user.click(await screen.findByRole("button", { name: "Open source post" }));
    expect(within(await openDialog()).getByText(/No verified source URL in this build/)).toBeInTheDocument();
  });

  it("an unknown post shows not found with a heading", async () => {
    open("/content/P-999");
    expect(await screen.findByRole("alert")).toHaveTextContent("Record not found");
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(hourlyRunDemo.runId).toBe("demo-run-hourly");
  });
});
