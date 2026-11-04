import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { attributionDemo, campaignFunnelDemo, customerJourneyDemo, launchControlDemo, paidMediaDemo } from "@/fixtures/analytics";
import { socialCatDashboardDemo } from "@/fixtures/creators";
import { overviewOriginal, type OverviewFixtureKey } from "@/fixtures/overview";
import { renderRoute } from "@/test/renderWithAdapter";
import { weekBarHeight, weekTotals } from "./attributionMath";
import { STEPS, capacityUse, maturePosting, totals } from "./funnelMath";
import { averageRating, niceScale, rate } from "./journeyMath";
import { checkProposal, goBlockedReason, isCalendarDate, summarizeGates } from "./launchRules";
import { channelRates, compact, pctText, rightsLabel } from "./paidMediaMath";

const open = (path: string, fixture: OverviewFixtureKey = "FX-01-happy-read") => renderRoute(path, createDemoAdapter({ fixture }));
/** jsdom has no modal dialog, so an open dialog counts as hidden. Closed dialogs render no heading, so the open one is the one with a title. */
const openDialog = async () => {
  await waitFor(() => expect(screen.getAllByRole("dialog", { hidden: true }).some((d) => d.querySelector("h2"))).toBe(true));
  return screen.getAllByRole("dialog", { hidden: true }).find((d) => d.querySelector("h2"))!;
};
const metric = (id: string) => screen.findByTestId(`metric-${id}`);

describe("demo datasets reconcile (FE01-03)", () => {
  it("weekly receipts sum to the Overview channel totals and net receipts", () => {
    const t = weekTotals(attributionDemo.weeks);
    expect(t.shopify).toBe(836_400);
    expect(t.tiktok).toBe(423_200);
    expect(t.shopify + t.tiktok).toBe(overviewOriginal.netReceipts.value!.minorUnits);
    expect(attributionDemo.channels).toBe(overviewOriginal.channels);
  });

  it("attribution methods sum to the 400 orders", () => {
    expect(attributionDemo.attribution.reduce((s, a) => s + a.orders, 0)).toBe(overviewOriginal.orders.value);
  });

  it("paid media: $5,000 of media plus $2,000 creator and sample economics is the $7,000 acquisition-cost fixture", () => {
    const media = paidMediaDemo.channels.reduce((s, c) => s + c.spend.minorUnits, 0);
    expect(media + paidMediaDemo.creatorSampleEconomics.minorUnits).toBe(overviewOriginal.marketingSpend.minorUnits);
  });

  it("the funnel totals are the sum of the campaigns and shipped plus reserved never exceeds the cap", () => {
    const t = totals(campaignFunnelDemo.campaigns);
    expect(STEPS.map((s) => t[s])).toEqual([980, 76, 38, 35, 31, 19]);
    for (const c of campaignFunnelDemo.campaigns) expect(capacityUse(c).over).toBe(false);
  });

  it("support categories, resolutions and review stars each add up to their stated totals", () => {
    expect(customerJourneyDemo.tickets.reduce((s, t) => s + t.count, 0)).toBe(45);
    expect(customerJourneyDemo.resolution.byFin + customerJourneyDemo.resolution.byPeople + customerJourneyDemo.resolution.open).toBe(45);
    expect(customerJourneyDemo.reviews.stars.reduce((s, r) => s + r.count, 0)).toBe(customerJourneyDemo.reviews.ratedCount.value);
    expect(customerJourneyDemo.returns.received + customerJourneyDemo.returns.awaitingInspection).toBe(customerJourneyDemo.returns.returned);
  });
});

describe("rules", () => {
  it("bar heights are proportional to value on a zero baseline", () => {
    expect(weekBarHeight(0)).toBe(0);
    expect(weekBarHeight(260_000)).toBe(134);
    expect(weekBarHeight(117_600)).toBe(weekBarHeight(58_800) * 2 || weekBarHeight(117_600));
  });

  it("calendar dates reject roll-over and wrong shapes", () => {
    expect(isCalendarDate("2027-01-15")).toBe(true);
    expect(isCalendarDate("2027-02-30")).toBe(false);
    expect(isCalendarDate("2027-1-5")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });

  it("an empty proposed date is valid and means L stays unset; evidence is required either way", () => {
    expect(checkProposal("", "https://example.test/sample")).toMatchObject({ ok: true, proposedDate: null });
    expect(checkProposal("", "")).toMatchObject({ ok: false, evidenceError: "Required before founder review." });
    expect(checkProposal("2027-02-30", "x").dateError).toMatch(/calendar date/);
    expect(checkProposal("2027-01-15", "http://insecure.test/x").evidenceError).toMatch(/https/);
    expect(checkProposal("2027-01-15", "NOTION-123")).toMatchObject({ ok: true, proposedDate: "2027-01-15" });
  });

  it("Go needs a set date and every required gate passing", () => {
    expect(goBlockedReason(false, 2)).toBe("Go is unavailable: the launch date is unset and 2 required gates are blocked.");
    expect(goBlockedReason(true, 1)).toBe("Go is unavailable: 1 required gate is blocked.");
    expect(goBlockedReason(true, 0)).toBeNull();
    expect(summarizeGates(launchControlDemo.gates)).toEqual({ total: 8, passed: 6, blocked: 2 });
  });

  it("a zero denominator is N/A, never zero", () => {
    expect(rate(5, 0, 2)).toBeNull();
    expect(pctText(5, 0)).toBe("N/A");
    expect(averageRating([{ star: 5, count: 0 }])).toBeNull();
    expect(maturePosting(5, 5, 0).rate).toBeNull();
    expect(channelRates({ ...paidMediaDemo.channels[0]!, impressions: 0, clicks: 0 })).toMatchObject({ ctr: "N/A", cpm: "N/A", cpc: "N/A" });
  });

  it("states the rates the design shows", () => {
    expect(rate(260, 16_000, 2)).toBe("1.63");
    expect(rate(45, 300, 1)).toBe("15.0");
    expect(averageRating(customerJourneyDemo.reviews.stars)).toBe("4.6");
    expect(maturePosting(31, 5, 19)).toMatchObject({ mature: 26, noPost: 7 });
    expect(niceScale(18)).toBe(20);
    expect(niceScale(13)).toBe(15);
    expect(compact(800_000)).toBe("800k");
    expect(compact(500)).toBe("500");
    expect(rightsLabel({ rights: "expiring", expiresInDays: 12 })).toBe("Expires in 12d");
  });
});

describe("launch snapshot (3:6)", () => {
  it("keeps L unset and shows the demo figures with their labels", async () => {
    open("/launch?view=snapshot");
    expect(await screen.findByTestId("launch-date")).toHaveTextContent("L is not set");
    expect(await metric("conversations")).toHaveTextContent("128");
    expect(await metric("budget")).toHaveTextContent("$40,000");
    expect(await metric("decisions")).toHaveTextContent("03");
    expect(screen.getByText(/Mirrored data is edited in its source tool/)).toBeInTheDocument();
  });

  it("shows N/A with a reason when a metric is missing, not zero", async () => {
    open("/launch?view=snapshot", "FX-04-missing-metric");
    expect(await metric("conversations")).toHaveTextContent(/N\/A/);
    expect(await metric("conversations")).not.toHaveTextContent(/^0/);
  });

  it("shows a recoverable error, and no data, when the account is forbidden", async () => {
    open("/launch?view=snapshot", "FX-08-forbidden-account");
    expect(await screen.findByRole("alert")).toHaveTextContent("No access to this account");
    expect(screen.queryByTestId("metric-conversations")).not.toBeInTheDocument();
  });

  it("an unavailable backend shows a pending state, never demo data", async () => {
    renderRoute("/launch?view=snapshot", createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not connected/);
    expect(screen.queryByTestId("metric-conversations")).not.toBeInTheDocument();
  });
});

describe("launch control (14:74)", () => {
  it("counts gates from the rows and exposes the current tab", async () => {
    open("/launch?view=control");
    expect(await metric("gates")).toHaveTextContent("6 / 8");
    expect(await metric("blockers")).toHaveTextContent("02");
    expect(screen.getByRole("link", { name: "Launch control" })).toHaveAttribute("aria-current", "page");
  });

  it("CTRL-198: an evidence button opens a labeled handoff and completes nothing", async () => {
    const user = userEvent.setup();
    open("/launch?view=control");
    await user.click(await screen.findByRole("button", { name: /Open task: Production-spec sample accepted/ }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/labeled demo placeholder/)).toBeInTheDocument();
    expect(within(dialog).getByText(/nothing here is marked complete/)).toBeInTheDocument();
  });

  it("CTRL-199: Go is unavailable while L is unset, and recording is disabled with its reason", async () => {
    const user = userEvent.setup();
    open("/launch?view=control");
    await user.click(await screen.findByRole("button", { name: "Record in Notion" }));
    const dialog = await openDialog();
    expect(within(dialog).getByRole("radio", { name: "Go", hidden: true })).toBeDisabled();
    expect(within(dialog).getByText(/Go is unavailable: the launch date is unset and 2 required gates are blocked/)).toBeInTheDocument();
    const record = within(dialog).getByRole("button", { name: "Record decision", hidden: true });
    expect(record).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByText(/recording in Notion isn't connected/)).toBeInTheDocument();
    await user.click(record);
    expect(within(dialog).queryByText(/recorded|saved successfully/i)).not.toBeInTheDocument();
  });

  it("CTRL-200/201: a date proposal needs a real date and evidence, and is never shown as approved", async () => {
    const user = userEvent.setup();
    open("/launch?view=control");
    await user.type(await screen.findByLabelText("Proposed L"), "2027-02-30");
    await user.click(screen.getByRole("button", { name: "Open date proposal" }));
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/real calendar date/);
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/Required before founder review/);
    await user.clear(screen.getByLabelText("Proposed L"));
    await user.type(screen.getByLabelText("Proposed L"), "2027-01-15");
    await user.type(screen.getByLabelText("Reason / evidence"), "NOTION-SAMPLE-1");
    expect(await screen.findByRole("status")).toHaveTextContent("Proposed L 2027-01-15 is a draft, not an approved date");
    expect(screen.getByRole("status")).toHaveTextContent("No schedule is enabled");
  });
});

describe("performance attribution (14:377)", () => {
  it("shows the Overview's net receipts, contribution, CAC and MER with their denominators", async () => {
    open("/analytics/attribution");
    expect(await metric("net-receipts")).toHaveTextContent("$12,596");
    expect(screen.getByText("400 orders · AOV $31.49")).toBeInTheDocument();
    expect(await metric("contribution")).toHaveTextContent("$5,680");
    expect(screen.getByText("45.09% · proposed definition")).toBeInTheDocument();
    expect(await metric("cac")).toHaveTextContent("$25.00");
    expect(screen.getByText("$7,000 ÷ 280 new retained customers")).toBeInTheDocument();
    expect(await metric("mer")).toHaveTextContent("1.80×");
    expect(await metric("platform-roas")).toHaveTextContent("2.40×");
  });

  it("selecting a week shows that week's totals", async () => {
    const user = userEvent.setup();
    open("/analytics/attribution");
    await user.click(await screen.findByRole("button", { name: /Wk 4: Shopify \$2,600/ }));
    const status = screen.getAllByRole("status").find((s) => /Wk 4/.test(s.textContent ?? ""))!;
    expect(status).toHaveTextContent("Total $3,900");
  });

  it("missing inputs show N/A with a reason rather than zero", async () => {
    open("/analytics/attribution", "FX-04-missing-metric");
    expect(await metric("contribution")).toHaveTextContent(/N\/A/);
    expect(await metric("platform-roas")).toHaveTextContent(/N\/A/);
  });

  it("CTRL-203: reviewing unattributed orders assigns no creator", async () => {
    const user = userEvent.setup();
    open("/analytics/attribution");
    await user.click(await screen.findByRole("button", { name: "Review unattributed" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/40 of 400 \(10%\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/doesn't assign a creator/)).toBeInTheDocument();
  });
});

describe("paid media (30:349)", () => {
  it("states each rate with its denominator", async () => {
    open("/analytics/paid-media");
    expect(await metric("media-spend")).toHaveTextContent("$5,000");
    expect(await metric("ctr")).toHaveTextContent("16k / 2.00%");
    expect(await metric("cpc")).toHaveTextContent("$0.31");
    expect(screen.getByText("16,000 clicks ÷ 800,000 impressions")).toBeInTheDocument();
    expect(screen.getByText(/never added to Shopify\/TikTok order totals/)).toBeInTheDocument();
  });

  it("CTRL-204: the rights filter lives in the URL and recomputes the rows and denominator", async () => {
    const user = userEvent.setup();
    const router = open("/analytics/paid-media");
    await user.click(await screen.findByRole("button", { name: "Rights: all states" }));
    const filter = await openDialog();
    await user.click(within(filter).getByRole("radio", { name: "not granted", hidden: true }));
    await user.click(within(filter).getByRole("button", { name: "Done", hidden: true }));
    await waitFor(() => expect(router.state.location.search).toBe("?rights=notGranted"));
    expect(await screen.findByText(/Showing 1 of 4 assets/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Top assets by click-through rate" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("AD-04 · TikTok")).toBeInTheDocument();
  });

  it("a rights filter with no matches says so and is not zero assets", async () => {
    open("/analytics/paid-media?rights=unknown");
    expect(await screen.findByText(/No assets match these filters\. That is not zero assets/)).toBeInTheDocument();
  });

  it("an unrecognised filter value falls back to all", async () => {
    open("/analytics/paid-media?rights=bogus");
    expect(await screen.findByRole("button", { name: "Rights: all states" })).toBeInTheDocument();
  });

  it("CTRL-205: Metrics as of is a disclosure that changes nothing", async () => {
    const user = userEvent.setup();
    open("/analytics/paid-media");
    await user.click(await screen.findByRole("button", { name: "Metrics as of" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/can't make an old snapshot current/)).toBeInTheDocument();
  });

  it("CTRL-206: reviewing rights blocks only the asset's own reuse", async () => {
    const user = userEvent.setup();
    open("/analytics/paid-media");
    await user.click(await screen.findByRole("button", { name: "Open rights for AD-04 · TikTok" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/block paid reuse of this asset only/)).toBeInTheDocument();
  });

  it("shows an unknown rights state as Unknown, not as granted", async () => {
    open("/analytics/paid-media", "FX-04-missing-metric");
    const table = await screen.findByRole("table", { name: "Top assets by click-through rate" });
    const row = within(table).getByText("AD-04 · TikTok").closest("tr")!;
    expect(within(row).getByText("Unknown")).toBeInTheDocument();
  });
});

describe("campaign funnel (30:550)", () => {
  it("derives the KPIs from the campaign rows", async () => {
    open("/campaigns/demo-campaign-first-wave?tab=funnel");
    expect(await metric("contacts")).toHaveTextContent("980");
    expect(await metric("reply-conversion")).toHaveTextContent("7.8%");
    expect(await metric("gift")).toHaveTextContent("38 / 46");
    expect(await metric("no-post")).toHaveTextContent("07");
    expect(screen.getByText("All three cohorts are below historical contact assumptions")).toBeInTheDocument();
    expect(screen.getByText("73.1% · 19 / 26")).toBeInTheDocument();
  });

  it("CTRL-207: choosing the other named cohort is URL state and shows its own empty state, not zeros", async () => {
    const user = userEvent.setup();
    const router = open("/campaigns/demo-campaign-first-wave?tab=funnel");
    await user.click(await screen.findByRole("button", { name: "First-wave cohort" }));
    const choice = await openDialog();
    await user.click(within(choice).getByRole("radio", { name: "Launch A monitoring", hidden: true }));
    await user.click(within(choice).getByRole("button", { name: "Done", hidden: true }));
    await waitFor(() => expect(router.state.location.search).toContain("cohort=launch-a"));
    expect(await screen.findByText("No campaign progression for this cohort")).toBeInTheDocument();
    expect(screen.getByText(/not zero contacts/)).toBeInTheDocument();
    expect(screen.queryByTestId("metric-contacts")).not.toBeInTheDocument();
  });

  it("CTRL-208: reservations hold capacity and are not shipments", async () => {
    const user = userEvent.setup();
    open("/campaigns/demo-campaign-first-wave?tab=funnel");
    await user.click(await screen.findByRole("button", { name: "Review reservations" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/isn't physical depletion or a shipment/)).toBeInTheDocument();
    expect(within(dialog).getByText("18 shipped + 2 reserved of 23")).toBeInTheDocument();
  });

  it("does not invent other campaign tabs", async () => {
    open("/campaigns/demo-campaign-first-wave?tab=settings");
    expect(await screen.findByText("This tab is not built")).toBeInTheDocument();
  });
});

describe("commerce, support and reviews (30:721)", () => {
  it("keeps each metric's own cohort and denominator", async () => {
    open("/analytics/customer-journey");
    expect(await metric("sessions")).toHaveTextContent("16,000");
    expect(await metric("conversion")).toHaveTextContent("1.63%");
    expect(await metric("support-load")).toHaveTextContent("15.0 / 100");
    expect(await metric("rating")).toHaveTextContent("4.6 / 5");
    expect(screen.getByText("260 Shopify orders ÷ 16,000 sessions")).toBeInTheDocument();
    expect(screen.getByText("45 tickets ÷ 300 delivered units × 100")).toBeInTheDocument();
    expect(await metric("return-rate")).toHaveTextContent("6.0%");
    expect(screen.getByText("Setup accounts for 40% of tickets")).toBeInTheDocument();
  });

  it("unknown is not zero: missing sessions, cohort and ratings all read N/A", async () => {
    open("/analytics/customer-journey", "FX-04-missing-metric");
    expect(await metric("conversion")).toHaveTextContent("N/A");
    expect(await metric("support-load")).toHaveTextContent("N/A");
    expect(await metric("rating")).toHaveTextContent("N/A");
    expect(await metric("return-rate")).toHaveTextContent("N/A");
    expect(screen.queryByText("0.00%")).not.toBeInTheDocument();
  });

  it("CTRL-209: cohort definitions list the grain, window and denominator, and keep all-time apart", async () => {
    const user = userEvent.setup();
    open("/analytics/customer-journey");
    await screen.findByTestId("metric-sessions");
    await user.click(screen.getByRole("button", { name: "Cohort definitions" }));
    const dialog = await openDialog();
    expect(within(dialog).getAllByText(/Denominator: 300 delivered units/)).toHaveLength(2);
    expect(within(dialog).getByText(/All-time counts and cohort counts stay separate/)).toBeInTheDocument();
  });
});

describe("states shared by every analytics screen", () => {
  it.each(["/launch?view=snapshot", "/launch?view=control", "/analytics/attribution", "/analytics/paid-media", "/campaigns/demo-campaign-first-wave?tab=funnel", "/analytics/customer-journey"])("%s labels stale and partial data and shows an empty answer as empty", async (path) => {
    const stale = open(path, "FX-06-stale-source");
    expect(await screen.findByText("Source data is stale")).toBeInTheDocument();
    stale.dispose();
  });

  it.each(["/launch?view=snapshot", "/analytics/attribution", "/analytics/paid-media"])("%s shows the empty state for an empty source answer", async (path) => {
    open(path, "FX-03-empty-filter");
    expect(await screen.findByRole("heading", { name: /^No / })).toBeInTheDocument();
  });

  it("an expired session clears the data and says to sign in", async () => {
    open("/analytics/attribution", "FX-09-expired-session");
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in again");
    expect(screen.queryByTestId("metric-net-receipts")).not.toBeInTheDocument();
  });
});

describe("FE01-03 the $12,596 / 400-order example is never mixed with the pilot figures", () => {
  const PILOT = { orders: 270, net: 180_000 };
  it("every dataset that states the original example is keyed overview-original or derives from it", () => {
    expect(overviewOriginal.datasetKey).toBe("overview-original");
    expect(attributionDemo.datasetKey).toBe("overview-original");
    expect(overviewOriginal.netReceipts.value!.minorUnits).toBe(1_259_600);
    expect(overviewOriginal.orders.value).toBe(400);
    for (const other of [paidMediaDemo.datasetKey, campaignFunnelDemo.datasetKey, customerJourneyDemo.datasetKey, launchControlDemo.datasetKey] as string[]) expect(other).not.toBe("overview-original");
  });

  it("no figure of the original example equals a pilot figure, and the pilot is a separate cohort", () => {
    expect(overviewOriginal.orders.value).not.toBe(PILOT.orders);
    expect(overviewOriginal.netReceipts.value!.minorUnits).not.toBe(PILOT.net);
    expect(socialCatDashboardDemo.pilot.netEligibleSales.minorUnits).toBe(PILOT.net);
    expect(attributionDemo.orders.value).toBe(400);
  });

  it("the Overview and Performance attribution pages show 400 orders and $12,596 and none of the pilot's $1,800 / 270", async () => {
    open("/analytics/attribution");
    await metric("net-receipts");
    const main = screen.getByRole("main");
    expect(within(main).getAllByText(/\$12,596/).length).toBeGreaterThan(0);
    expect(within(main).queryByText(/270 (retained )?orders|\$1,800 (net|pilot)/)).not.toBeInTheDocument();
  });
});

describe("FE01-05 no new upfront fee, and paid media is not a creator fee", () => {
  it("the campaign funnel says no upfront creator fee is created", async () => {
    open("/campaigns/demo-campaign-first-wave?tab=funnel");
    expect(await screen.findByText(/commission-only; no upfront creator fee is created here/)).toBeInTheDocument();
  });

  it("the paid media page says paid media is not a creator fee, and keeps media apart from creator and sample economics", async () => {
    open("/analytics/paid-media");
    expect(await screen.findByText(/Paid media is not a creator fee/)).toBeInTheDocument();
    expect(screen.getByText("Creator / sample economics")).toBeInTheDocument();
    expect(screen.getByText("Media total")).toBeInTheDocument();
  });

  it("the attribution page labels commission, historical accepted fees and sample cost separately", async () => {
    open("/analytics/attribution");
    expect(await screen.findByText(/commission, historical accepted fees and sample landed cost, labeled separately/)).toBeInTheDocument();
  });
});
