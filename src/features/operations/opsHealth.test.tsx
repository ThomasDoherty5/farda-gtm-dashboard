import { screen, within } from "@testing-library/react";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { renderRoute } from "@/test/renderWithAdapter";

const PATH = "/analytics/fulfillment?view=health";

describe("issues and fulfillment health", () => {
  it("says it is synthetic and has no Figma source", async () => {
    renderRoute(PATH, createDemoAdapter());
    expect(await screen.findByTestId("health-notice")).toHaveTextContent(/Synthetic data · no Figma source/);
    expect(screen.getByTestId("health-notice")).toHaveTextContent(/no design fidelity is claimed/);
  });

  it("shows the averages by home and by carrier, tied to the Operations headline", async () => {
    renderRoute(PATH, createDemoAdapter());
    expect(await screen.findByTestId("metric-Order to shipped")).toHaveTextContent("1.2 days");
    expect(screen.getByTestId("metric-Shipped to delivered")).toHaveTextContent("3.4 days");
    expect(screen.getByTestId("metric-Shipping cost per order")).toHaveTextContent("$6.85");
    const home = within(screen.getByTestId("health-by-home"));
    expect(home.getByRole("row", { name: /Home H2 1\.4 days/ })).toBeInTheDocument();
    expect(within(screen.getByTestId("health-by-carrier")).getByRole("row", { name: /Carrier B .* 4 days/ })).toBeInTheDocument();
  });

  it("states the cost that was not read instead of folding it into the average as zero", async () => {
    renderRoute(PATH, createDemoAdapter());
    expect(await screen.findByText("1 shipped order excluded: cost not read")).toBeInTheDocument();
    expect(within(screen.getByTestId("health-by-home")).getByText("1 shipped without a cost")).toBeInTheDocument();
  });

  it("compares issue tags this week with last, refunds from receipts, and Fin against its cap", async () => {
    renderRoute(PATH, createDemoAdapter());
    const tags = within(await screen.findByTestId("issues-by-tag"));
    expect(tags.getByRole("row", { name: /Returns 2 4 −2/ })).toBeInTheDocument();
    expect(tags.getByRole("row", { name: /Setup \/ pairing 10 8 \+2/ })).toBeInTheDocument();
    expect(screen.getByTestId("metric-Refunds")).toHaveTextContent("$104.97");
    expect(screen.getByText("3 orders · 1 approved, no receipt yet")).toBeInTheDocument();
    expect(screen.getByTestId("fin-usage")).toHaveTextContent("48 resolutions · $48 of $150 cap (32%)");
  });

  it("lists lost, returned, partial, uncertain and canceled orders, none of them as success", async () => {
    renderRoute(PATH, createDemoAdapter());
    const table = within(await screen.findByTestId("order-exceptions-table"));
    const row = (ref: string) => table.getByRole("row", { name: new RegExp(ref) });
    expect(row("TEST-SH-1031")).toHaveTextContent(/Lost/);
    expect(row("TEST-SH-1027")).toHaveTextContent(/Returned/);
    expect(row("TEST-SH-1103")).toHaveTextContent(/Partially fulfilled.*2 of 3 units shipped/);
    expect(row("TEST-SH-1048")).toHaveTextContent(/Label uncertain.*not shipped/);
    expect(row("TEST-SH-1046")).toHaveTextContent(/Canceled.*No shipment/);
    expect(table.queryByText("Delivered")).not.toBeInTheDocument();
    expect(table.getByRole("link", { name: "TEST-SH-1031" })).toHaveAttribute("href", "/orders/TEST-SH-1031");
    expect(screen.getByTestId("ledger-integrity")).toHaveTextContent("2 duplicate events ignored");
  });

  it("never falls back to demo data on a live route", async () => {
    renderRoute(PATH, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not connected");
    expect(screen.queryByTestId("metric-Order to shipped")).not.toBeInTheDocument();
  });

  it("leaves the Figma-measured fulfillment overview unchanged without the health view", async () => {
    renderRoute("/analytics/fulfillment", createDemoAdapter());
    expect(await screen.findByTestId("metric-Orders shipped")).toHaveTextContent("329");
    expect(screen.queryByTestId("health-notice")).not.toBeInTheDocument();
  });
});
