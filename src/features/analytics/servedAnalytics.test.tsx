import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import type { ReadRequest } from "@/adapter/contract";
import { renderRoute } from "@/test/renderWithAdapter";
import { metricDictionaryDemo } from "@/fixtures/headlineMetrics";
import { createAnalyticsReader, type AnalyticsViewKey } from "@/creator-agent/analytics/reader";
import type { AnalyticsSources } from "@/creator-agent/analytics/sources";
import { adPlatformsFixture, analyticsTestScope, analyticsTestSecret, analyticsTestTime, analyticsTestTimezone, ordersFixture,
  syntheticAnalyticsSources } from "@/creator-agent/analytics/fixtures.testkit";

/** The pages fed by the actual server projection (THO-293), through the live adapter's schema checks. Fictional sources only. */
function served(sources: AnalyticsSources) {
  const reader = createAnalyticsReader({ scope: analyticsTestScope, secret: analyticsTestSecret, sources, now: () => analyticsTestTime, timezone: analyticsTestTimezone });
  return createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") throw new Error("Unexpected write");
    const envelope = request.envelope as ReadRequest<unknown>;
    if (envelope.viewKey === "metricDictionary") return respondWith(envelope, metricDictionaryDemo, { dataVersion: "synthetic-dictionary" });
    const result = await reader.read(envelope.viewKey as AnalyticsViewKey, envelope.filters, envelope.period);
    return { schemaVersion: envelope.schemaVersion, requestId: envelope.requestId, scope: { ...envelope.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" },
      dataVersion: result.version, dataState: result.dataState, data: result.data, sourceFreshness: result.sourceFreshness, coverage: result.coverage,
      capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } };
  } } });
}

describe("served analytics pages never derive a figure from an unknown input", () => {
  it("shows N/A, not a $0.00 average, when orders are known but net receipts are not", async () => {
    const sources = { ...syntheticAnalyticsSources(), orders: async (request: Parameters<typeof ordersFixture>[0]) => {
      const snapshot = ordersFixture(request); snapshot.feeds[0]!.orders[0]!.currency = "EUR"; return snapshot;
    } };
    renderRoute("/overview", served(sources));
    expect(await screen.findByTestId("metric-Paid orders")).toHaveTextContent("400");
    expect(screen.getByTestId("metric-Net receipts")).toHaveTextContent("N/A");
    expect(screen.getByText("Average net receipts N/A")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00 average/)).not.toBeInTheDocument();
    expect(screen.getByText(/Share N\/A/)).toBeInTheDocument();
  });

  it("renders every served page with no sources connected, naming each source's state and showing no zero figures", async () => {
    renderRoute("/overview", served({}));
    expect(await screen.findByTestId("source-states")).toHaveTextContent("Orders: not connected · Ad platforms: not connected");
    expect(screen.getByTestId("metric-Net receipts")).toHaveTextContent("N/A");
    expect(screen.getByTestId("metric-Paid orders")).toHaveTextContent("N/A");
    // The chart's $0 axis baseline is a scale label; no figure reads $0.
    expect(screen.getByTestId("metric-Attributed net sales")).toHaveTextContent("N/A");
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.getByText("Order total N/A", { exact: false })).toBeInTheDocument();
    for (const [path, heading] of [["/analytics/paid-media", "See what earns the click."], ["/analytics/customer-journey", "Watch the journey after the click."],
      ["/analytics/attribution", null]] as const) {
      document.body.innerHTML = "";
      renderRoute(path, served({}));
      expect(await screen.findByTestId("source-states")).toHaveTextContent("not connected");
      if (heading) expect(screen.getByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
    }
  });

  it("does not present one platform's spend as the paid media total", async () => {
    renderRoute("/analytics/paid-media", served({ adPlatforms: async request => { const s = adPlatformsFixture(request); s.feeds.shift(); return s; } }));
    expect(await screen.findByTestId("metric-media-spend")).toHaveTextContent("Unknown");
    expect(screen.getByTestId("metric-impressions")).toHaveTextContent("Unknown");
    expect(screen.getByTestId("metric-cpc")).toHaveTextContent("N/A");
  });
});
