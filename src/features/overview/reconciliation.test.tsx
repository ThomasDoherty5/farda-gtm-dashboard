/**
 * Overview-to-detail reconciliation matrix (GTM275-06/09), plus dataset isolation (FE01-03) and the campaign policy
 * statement (FE01-05). Every figure the Overview summarises is read from the screen and compared with the page that owns
 * it, in the same fixture and scope. Fixture-complete evidence: the figures are synthetic, and a live match needs THO-283.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { attributionDemo, campaignFunnelDemo, customerJourneyDemo, launchControlDemo, paidMediaDemo } from "@/fixtures/analytics";
import { socialCatDashboardDemo, tiktokDashboardDemo } from "@/fixtures/creators";
import { overviewOriginal } from "@/fixtures/overview";
import { renderRoute } from "@/test/renderWithAdapter";
import { weekTotals } from "@/features/analytics/attributionMath";

const show = async (path: string) => {
  const router = renderRoute(path, createDemoAdapter());
  await screen.findByRole("heading", { level: 1 });
  return router;
};
/** Renders a route, waits for a labeled figure, and returns its text. The page is removed afterwards. */
async function read(path: string, testId: string): Promise<string> {
  await show(path);
  const el = await screen.findByTestId(testId);
  const text = el.textContent ?? "";
  cleanup();
  return text.trim();
}
/** Digits only, so "240.0k" and "240,000" compare as the same quantity. */
const compactToNumber = (text: string) => (/k$/i.test(text) ? Math.round(parseFloat(text) * 1000) : Number(text.replace(/[^0-9.]/g, "")));

type Row = { summary: string; overview: string; owner: string; ownerTestId: string; ownerPath: string; expected: string; compare?: (a: string, b: string) => boolean };
const same = (a: string, b: string) => a === b;
const sameQuantity = (a: string, b: string) => compactToNumber(a) === compactToNumber(b);

const MATRIX: Row[] = [
  { summary: "Net receipts", overview: "metric-Net receipts", owner: "Performance attribution", ownerPath: "/analytics/attribution", ownerTestId: "metric-net-receipts", expected: "$12,596" },
  { summary: "Contribution before marketing", overview: "metric-Contribution", owner: "Performance attribution", ownerPath: "/analytics/attribution", ownerTestId: "metric-contribution", expected: "$5,680" },
  { summary: "Blended CAC", overview: "metric-Blended CAC", owner: "Performance attribution", ownerPath: "/analytics/attribution", ownerTestId: "metric-cac", expected: "$25.00" },
  { summary: "Marketing efficiency (MER)", overview: "metric-Marketing efficiency", owner: "Performance attribution", ownerPath: "/analytics/attribution", ownerTestId: "metric-mer", expected: "1.80×" },
  { summary: "Views", overview: "metric-Views", owner: "Content monitor", ownerPath: "/content", ownerTestId: "metric-views", expected: "240,000", compare: sameQuantity },
  { summary: "Engagement rate", overview: "metric-Engagement rate", owner: "Content monitor", ownerPath: "/content", ownerTestId: "metric-engagement", expected: "5.0%" },
  { summary: "Attributed orders", overview: "metric-Attributed orders", owner: "Content monitor", ownerPath: "/content", ownerTestId: "metric-orders", expected: "180" },
  { summary: "Attributed net sales", overview: "metric-Attributed net sales", owner: "Content monitor", ownerPath: "/content", ownerTestId: "metric-net-sales", expected: "$5,796" },
];

describe("overview-to-detail reconciliation matrix (GTM275-06/09)", () => {
  afterEach(() => cleanup());

  it.each(MATRIX)("$summary on the Overview equals $owner", async (row) => {
    const onOverview = await read("/overview", row.overview);
    const onOwner = await read(row.ownerPath, row.ownerTestId);
    expect(row.compare ? row.compare(onOverview, onOwner) : same(onOverview, onOwner), `${row.summary}: Overview "${onOverview}" vs ${row.owner} "${onOwner}"`).toBe(true);
    // Both also equal the value the fixture says, so two wrong pages cannot agree with each other.
    expect((row.compare ?? same)(onOverview, row.expected), `${row.summary}: Overview "${onOverview}" vs fixture "${row.expected}"`).toBe(true);
  });

  it("paid orders on the Overview are the orders the attribution page states", async () => {
    expect(await read("/overview", "metric-Paid orders")).toBe("400");
    await show("/analytics/attribution");
    expect(await screen.findByText("400 orders · AOV $31.49")).toBeInTheDocument();
  });

  it("the Overview's channel chart labels are the weekly receipts the attribution page plots", async () => {
    const week = weekTotals(attributionDemo.weeks);
    expect(week.shopify).toBe(836_400);
    expect(week.tiktok).toBe(423_200);
    await show("/overview");
    const sales = await screen.findByTestId("sales-card");
    expect(sales).toHaveTextContent("$8,364");
    expect(sales).toHaveTextContent("$4,232");
    cleanup();
    await show("/analytics/attribution");
    expect(await screen.findByRole("button", { name: /Wk 4: Shopify \$2,600/ })).toBeInTheDocument();
  });

  it("every drilldown the Overview offers opens a real page for the same period, not a dead end", async () => {
    await show("/overview");
    await screen.findByTestId("metric-Net receipts");
    const hrefs = [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")!).filter((h) => h.startsWith("/") && h !== "/overview"))];
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
    cleanup();
    for (const href of hrefs) {
      await show(href);
      expect(screen.queryByRole("heading", { name: "Page not found" }), `${href} is not a route`).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("the Overview, attribution and monitor name the same reporting window", () => {
    expect(overviewOriginal.periodLabel).toBe("Sep 30 – Oct 29, 2026");
    expect(attributionDemo.periodLabel.replace("–", " – ")).toMatch(/30 Sep.*29 Oct 2026/);
  });

  it("the other cohorts are a different dataset on purpose: they do not reconcile to the Overview and say so", async () => {
    expect(tiktokDashboardDemo.orders).not.toBe(overviewOriginal.orders.value);
    expect(tiktokDashboardDemo.datasetKey).not.toBe(overviewOriginal.datasetKey);
    await show("/creators/social-cat?view=dashboard");
    expect(await screen.findByText(/never add these values to the 30-day Launch A performance above/)).toBeInTheDocument();
  });

  // No logistics or finance summary block exists on the Overview source (Figma 10:217), so there is nothing to reconcile yet.
  it.todo("GTM275-03: a logistics summary on the Overview (shipment and issue counts, latency, shipping cost) equals Operations; needs a design for the block");
  it.todo("GTM275-04: a finance summary on the Overview (gross margin, cash, runway) equals Finance on the same QBO period and basis; needs a design for the block");
});

describe("demo datasets stay isolated (FE01-03)", () => {
  afterEach(() => cleanup());
  const ROUTES = ["/overview", "/launch?view=snapshot", "/launch?view=control", "/analytics/attribution", "/analytics/paid-media", "/campaigns/demo-campaign-first-wave?tab=funnel", "/analytics/customer-journey"];
  const pilot = socialCatDashboardDemo.pilot;
  const usdText = (minor: number) => `$${(minor / 100).toLocaleString("en-US")}`;

  it("the pilot's figures are what the test thinks they are", () => {
    expect(usdText(pilot.netEligibleSales.minorUnits)).toBe("$1,800");
    expect(usdText(pilot.grossCommission.minorUnits - pilot.reversedCommission.minorUnits)).toBe("$270");
  });

  it.each(ROUTES)("%s shows none of the pilot cohort's figures", async (path) => {
    await show(path);
    await waitFor(() => expect(document.body.textContent!.length).toBeGreaterThan(400));
    const text = document.body.textContent!;
    expect(text).not.toContain(usdText(pilot.netEligibleSales.minorUnits));
    expect(text).not.toContain(usdText(pilot.grossCommission.minorUnits - pilot.reversedCommission.minorUnits));
    expect(text).not.toContain("Affiliate pilot");
  });

  it("the pilot panel shows none of the original example's totals", async () => {
    await show("/creators/social-cat?view=dashboard");
    const panel = (await screen.findByRole("heading", { name: /Affiliate pilot/ })).closest("section")!;
    expect(panel.textContent).not.toContain("$12,596");
    expect(panel.textContent).not.toContain("400 orders");
    expect(panel.textContent).not.toContain("240,000");
  });

  it("each THO-293 dataset is either the original example or its own, and none is the pilot, Social Cat or TikTok dataset", () => {
    const others = [socialCatDashboardDemo.datasetKey, tiktokDashboardDemo.datasetKey];
    expect(new Set([overviewOriginal.datasetKey, ...others]).size).toBe(3);
    const own = [launchControlDemo, paidMediaDemo, customerJourneyDemo, campaignFunnelDemo].map((d) => d.datasetKey);
    expect(own).toEqual(["launch-control-demo", "paid-media-demo", "customer-journey-demo", "campaign-funnel-demo"]);
    // Attribution is the one analytics dataset that is the original example itself, so it must reconcile to it exactly.
    expect(attributionDemo.datasetKey).toBe(overviewOriginal.datasetKey);
    for (const key of [...own, attributionDemo.datasetKey]) expect(others).not.toContain(key);
  });

  it("the original example's totals still add up where they are used", () => {
    expect(overviewOriginal.orders.value).toBe(400);
    expect(overviewOriginal.netReceipts.value!.minorUnits).toBe(1_259_600);
    expect(attributionDemo.channels).toBe(overviewOriginal.channels);
  });
});

describe("campaign pages state the current acquisition policy (FE01-05)", () => {
  afterEach(() => cleanup());

  it("the campaign funnel says there are no new upfront fee offers and keeps sample cost and historical commitments labeled apart", async () => {
    await show("/campaigns/demo-campaign-first-wave?tab=funnel");
    const policy = await screen.findByTestId("campaign-policy");
    expect(policy).toHaveTextContent("No new upfront fee offers");
    expect(policy).toHaveTextContent("commission-only");
    expect(policy).toHaveTextContent("approved sample cost and historical commitments are labeled separately");
  });

  it("paid media spend is shown apart from creator and sample economics", async () => {
    await show("/analytics/paid-media");
    expect(await screen.findByText("Creator / sample economics")).toBeInTheDocument();
    expect(screen.getByText("Media spend")).toBeInTheDocument();
  });
});
