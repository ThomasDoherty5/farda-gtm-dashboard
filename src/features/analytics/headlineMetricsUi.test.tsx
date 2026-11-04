import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within, waitFor } from "@testing-library/react";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { renderRoute } from "@/test/renderWithAdapter";

const open = (path: string) => renderRoute(path, createDemoAdapter({ fixture: "FX-01-happy-read" }));

describe("headline metrics on the attribution page", () => {
  it("shows AOV, CAC and MER, and compares CAC with contribution without implying profit per customer", async () => {
    open("/analytics/attribution");
    expect(await screen.findByTestId("metric-cac")).toHaveTextContent("$25.00");
    expect(screen.getByTestId("metric-mer")).toHaveTextContent("1.80×");
    expect(screen.getByText("400 orders · AOV $31.49")).toBeInTheDocument();
    expect(screen.getByText("Different bases")).toBeInTheDocument();
    expect(screen.queryByText(/\bgap\b|\bahead\b/)).not.toBeInTheDocument();
    expect(screen.getByTestId("cac-basis-note")).toHaveTextContent(/not a profit per customer/);
  });

  it("the definitions dialog carries the versioned dictionary, labeled cost buckets and the hand-checked cases", async () => {
    const user = userEvent.setup();
    open("/analytics/attribution");
    await user.click(await screen.findByRole("button", { name: "Metric definitions" }));
    const dict = await screen.findByTestId("metric-dictionary", {}, { timeout: 3000 });
    expect(dict).toHaveTextContent("headline-metrics@1");
    for (const k of ["aov", "blendedCac", "mer", "platformRoas"]) expect(within(dict).getByTestId(`definition-${k}`)).toHaveTextContent(/Source:.*Currency:.*Window:.*Cost buckets:.*Refunds:/);
    expect(within(dict).getByTestId("cost-buckets")).toHaveTextContent(/paid/);
    expect(within(dict).getByTestId("cost-buckets")).toHaveTextContent(/estimated/);
    expect(dict).toHaveTextContent("Cost per retained unit");
    const normal = within(dict).getByTestId("metric-cases").querySelector('[data-case="normal"]')!;
    expect(normal).toHaveTextContent("CAC $25.00");
    expect(normal).toHaveTextContent("MER 1.80×");
    const refund = within(dict).getByTestId("metric-cases").querySelector('[data-case="refund"]')!;
    expect(refund).toHaveTextContent("MER 1.79×");
    await waitFor(() => expect(within(dict).getByTestId("metric-cases").querySelector('[data-case="zero-customers"]')).toHaveTextContent("CAC N/A · zero denominator"));
  });
});
