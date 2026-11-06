import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { postPerformanceDemo } from "@/fixtures/monitor";
import { renderRoute } from "@/test/renderWithAdapter";

function openPost(overrides: Record<string, unknown>) {
  const data = { ...structuredClone(postPerformanceDemo), datasetKey: "post-performance", ...overrides };
  const adapter = createLiveAdapter("sandbox", {
    transport: { async send(request) {
      if (request.kind !== "read" || request.envelope.viewKey !== "postPerformance") throw new Error("Unexpected operation");
      return respondWith(request.envelope, data, { dataVersion: "synthetic-post-v1" });
    } },
  });
  renderRoute("/content/P-001", adapter);
}

describe("post detail through the validated live adapter", () => {
  it("retains a reported zero GMV, independent net sales and the sourced attribution period", async () => {
    const user = userEvent.setup();
    openPost({
      orders: 0, netSales: { minorUnits: 1750, currency: "USD" },
      gmv: { state: "reported", amount: { minorUnits: 0, currency: "USD" }, window: "Spring test", definition: "platform order value" },
      attributionWindow: { startDate: "2026-03-01", endDate: "2026-03-31", sourceRef: "synthetic-order-window" },
    });
    expect(await screen.findByTestId("gmv-note")).toHaveTextContent("TikTok-reported GMV $0");
    expect(screen.getByTestId("metric-net-sales")).toHaveTextContent("$17.50");
    expect(screen.getByTestId("metric-orders")).toHaveTextContent("0");
    await user.click(screen.getByRole("button", { name: "View attribution evidence" }));
    const dialog = screen.getByText("Attribution evidence", { selector: "h2" }).closest("dialog")!;
    expect(dialog).toHaveTextContent(/Mar 1.*31, 2026/);
    expect(dialog).toHaveTextContent("synthetic-order-window");
    expect(dialog).not.toHaveTextContent("Sep 30");
  });

  it("shows an older response with no GMV, native proof or window", async () => {
    const user = userEvent.setup();
    openPost({ gmv: undefined, publicationProof: undefined, attributionWindow: undefined, orders: null, netSales: null });
    expect(await screen.findByTestId("gmv-note")).toHaveTextContent("GMV is unknown");
    expect(screen.getByText("Publication unverified", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/The attribution window is unknown/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View attribution evidence" }));
    const dialog = screen.getByText("Attribution evidence", { selector: "h2" }).closest("dialog")!;
    expect(within(dialog).getByText("Unknown · no attribution window supplied")).toBeInTheDocument();
  });

  it("keeps an unavailable platform observation distinct from zero and retained sales", async () => {
    openPost({ gmv: { state: "unavailable", reason: "Metric permission was denied." }, netSales: { minorUnits: 0, currency: "USD" } });
    expect(await screen.findByTestId("gmv-note")).toHaveTextContent("unavailable. Metric permission was denied");
    expect(screen.getByTestId("metric-net-sales")).toHaveTextContent("$0");
  });

  it("rejects a verified receipt attributed to another post", async () => {
    openPost({ publicationProof: { ...postPerformanceDemo.publicationProof, postId: "another-post" } });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("gmv-note")).not.toBeInTheDocument();
  });
});
