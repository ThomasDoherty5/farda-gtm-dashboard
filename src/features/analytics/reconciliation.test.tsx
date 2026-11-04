import { screen, within } from "@testing-library/react";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { attributionDemo, campaignFunnelDemo, customerJourneyDemo, launchControlDemo, launchSnapshotDemo, paidMediaDemo, sourceFreshnessDemo } from "@/fixtures/analytics";
import { monitorPosts } from "@/fixtures/monitor";
import { DEMO_NOW, overviewOriginal } from "@/fixtures/overview";
import { renderRoute } from "@/test/renderWithAdapter";
import { FRESHNESS_WORDS, classifyFreshness, type FreshnessState } from "./freshness";
import { buildMatrix } from "./reconciliation";

const inputs = { overview: overviewOriginal, attribution: attributionDemo, paidMedia: paidMediaDemo, journey: customerJourneyDemo, posts: monitorPosts };
const row = (metric: string, matrix = buildMatrix(inputs)) => matrix.find((r) => r.metric === metric)!;

describe("GTM275-07 source-specific freshness", () => {
  const hours = (h: number) => new Date(Date.parse(DEMO_NOW) - h * 3_600_000).toISOString();
  it.each<[string, { lastSourceSuccessAt: string | null; staleReasonCode: string | null }, FreshnessState]>([
    ["a recent success", { lastSourceSuccessAt: hours(1), staleReasonCode: null }, "fresh"],
    ["a success older than the window", { lastSourceSuccessAt: hours(30), staleReasonCode: "SOURCE_SYNC_DELAYED" }, "stale"],
    ["a successful sync that found nothing new", { lastSourceSuccessAt: hours(5), staleReasonCode: "NO_CHANGE" }, "noChange"],
    ["no successful sync ever", { lastSourceSuccessAt: null, staleReasonCode: null }, "neverSynced"],
    ["missing rows", { lastSourceSuccessAt: hours(2), staleReasonCode: "PARTIAL_ROWS" }, "partial"],
    ["deferred rows", { lastSourceSuccessAt: hours(2), staleReasonCode: "SOURCE_ROWS_DEFERRED" }, "partial"],
    ["a failed sync, even after an earlier success", { lastSourceSuccessAt: hours(2), staleReasonCode: "SOURCE_ERROR_AUTH" }, "error"],
    ["a failed sync that never succeeded", { lastSourceSuccessAt: null, staleReasonCode: "SYNC_FAILED" }, "error"],
  ])("%s is %s", (_name, input, expected) => {
    expect(classifyFreshness(input, DEMO_NOW)).toBe(expected);
  });

  it("no change is current, not stale, and an old no-change sync is still no change", () => {
    expect(FRESHNESS_WORDS.noChange.valuesAreCurrent).toBe(true);
    expect(FRESHNESS_WORDS.stale.valuesAreCurrent).toBe(false);
    expect(classifyFreshness({ lastSourceSuccessAt: hours(100), staleReasonCode: "NO_CHANGE" }, DEMO_NOW)).toBe("noChange");
  });

  it("never-synced values are N/A, not zero, in the words shown to the reader", () => {
    expect(FRESHNESS_WORDS.neverSynced.meaning).toMatch(/N\/A, not zero/);
  });

  it("the demo gives every state to a different source, so one source's state can't stand for another's", () => {
    const states = sourceFreshnessDemo.map((f) => classifyFreshness(f, DEMO_NOW));
    expect([...states].sort()).toEqual(["error", "fresh", "neverSynced", "noChange", "partial", "stale"]);
  });
});

describe("GTM275-06/09 overview-to-detail reconciliation matrix", () => {
  it("every metric the Overview shares with a detail page matches, from the datasets themselves", () => {
    const matrix = buildMatrix(inputs);
    expect(matrix.map((r) => [r.metric, r.status])).toEqual([
      ["Net receipts", "matches"],
      ["Valid orders", "matches"],
      ["Shopify receipts", "matches"],
      ["TikTok Shop receipts", "matches"],
      ["Marketing spend", "matches"],
      ["Attributed orders", "matches"],
      ["Attributed net sales", "matches"],
      ["Post views", "matches"],
    ]);
    expect(row("Net receipts").cells.map((c) => c.value)).toEqual([1_259_600, 1_259_600, 1_259_600]);
    expect(row("Valid orders").cells.map((c) => c.value)).toEqual([400, 400, 400, 400, 400]);
  });

  it("a changed detail figure makes its row differ and says which page disagrees", () => {
    const matrix = buildMatrix({ ...inputs, journey: { ...customerJourneyDemo, globalOrders: 401 } });
    const orders = row("Valid orders", matrix);
    expect(orders.status).toBe("differs");
    expect(orders.reason).toMatch(/Commerce, support and reviews states 401, but Overview states 400/);
    expect(row("Net receipts", matrix).status).toBe("matches");
  });

  it("a missing figure is Not reconciled, never a silent match", () => {
    const matrix = buildMatrix({ ...inputs, posts: monitorPosts.map((p, i) => (i === 0 ? { ...p, orders: null } : p)) });
    expect(row("Attributed orders", matrix).status).toBe("unknown");
    expect(row("Attributed orders", matrix).reason).toMatch(/Content monitor posts has no value/);
  });

  it("the weekly buckets are compared to the channel totals exactly", () => {
    const weeks = attributionDemo.weeks.map((w, i) => (i === 0 ? { ...w, shopify: { ...w.shopify, minorUnits: w.shopify.minorUnits + 1 } } : w));
    const matrix = buildMatrix({ ...inputs, attribution: { ...attributionDemo, weeks } });
    expect(row("Shopify receipts", matrix).status).toBe("differs");
    expect(row("TikTok Shop receipts", matrix).status).toBe("matches");
  });

  it("covers the other launch and funnel datasets without stating a number that belongs to the pilot cohort", () => {
    expect(JSON.stringify(buildMatrix(inputs))).not.toContain("180000");
    expect(launchSnapshotDemo.datasetKey).not.toBe(attributionDemo.datasetKey);
    expect(launchControlDemo.datasetKey).not.toBe(attributionDemo.datasetKey);
    expect(campaignFunnelDemo.datasetKey).not.toBe(attributionDemo.datasetKey);
  });
});

describe("the reconciliation page", () => {
  const RECON = "/launch?view=reconciliation";
  it("shows each source's own state and a matching matrix", async () => {
    renderRoute(RECON, createDemoAdapter());
    const fresh = await screen.findByTestId("freshness");
    const rows = within(fresh).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.firstElementChild!.textContent)).toEqual(sourceFreshnessDemo.map((s) => s.label));
    expect(within(rows[1]!).getByText("No change")).toBeInTheDocument();
    expect(within(rows[5]!).getByText("Never synced")).toBeInTheDocument();
    expect(within(rows[5]!).getByText("Never")).toBeInTheDocument();
    expect(within(rows[4]!).getByText("Error")).toBeInTheDocument();
    const matrix = screen.getByTestId("matrix");
    expect(within(matrix).getByRole("heading", { name: "Every shared figure matches" })).toBeInTheDocument();
    expect(within(matrix).getAllByText("Matches")).toHaveLength(8);
    expect(within(matrix).getAllByRole("link", { name: "Overview" })[0]).toHaveAttribute("href", "/overview");
  });

  it("the snapshot links to it", async () => {
    renderRoute("/launch", createDemoAdapter());
    expect(await screen.findByRole("link", { name: "Source freshness and reconciliation" })).toHaveAttribute("href", "/launch?view=reconciliation");
  });

  it("shows a pending state and no figures on the live adapter", async () => {
    renderRoute(RECON, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId("matrix")).not.toBeInTheDocument();
  });
});
