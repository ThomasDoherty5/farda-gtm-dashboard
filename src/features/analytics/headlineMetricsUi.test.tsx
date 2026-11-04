import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within, waitFor } from "@testing-library/react";
import type { FardaAdapter } from "@/adapter/adapter";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import type { OverviewFixtureKey } from "@/fixtures/overview";
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

/** Attribution reads succeed; only the dictionary read behaves as `fixture` says. */
function dictionaryReadAs(fixture: OverviewFixtureKey): FardaAdapter {
  const ok = createDemoAdapter({ fixture: "FX-01-happy-read" });
  const odd = createDemoAdapter({ fixture });
  return { ...ok, readView: ((req: Parameters<FardaAdapter["readView"]>[0]) => (req.viewKey === "metricDictionary" ? odd.readView(req) : ok.readView(req))) as FardaAdapter["readView"] };
}

async function openDefinitions(adapter: FardaAdapter) {
  const user = userEvent.setup();
  renderRoute("/analytics/attribution", adapter);
  await screen.findByTestId("metric-cac");
  await user.click(screen.getByRole("button", { name: "Metric definitions" }));
  const dialog = (await screen.findByRole("heading", { name: "Metric definitions", hidden: true })).closest("dialog")!;
  return within(dialog);
}

describe("definitions dialog keeps its static definitions whatever the dictionary read does", () => {
  const staticTitles = ["Net receipts", "Blended CAC", "MER", "Platform ROAS", "Attribution"];
  const expectStatic = (d: ReturnType<typeof within>) => {
    const block = d.getByTestId("static-definitions");
    for (const t of staticTitles) expect(within(block).getByText(t)).toBeInTheDocument();
  };

  it.each([
    ["a read error", "FX-07-offline-read", /^Data unavailable$/],
    ["a forbidden answer", "FX-08-forbidden-account", /No access to this account/],
    ["an expired session", "FX-09-expired-session", /Sign in again/],
    ["an empty answer", "FX-03-empty-filter", /No metric dictionary/],
  ] as const)("%s", async (_name, fixture, text) => {
    const d = await openDefinitions(dictionaryReadAs(fixture));
    expectStatic(d);
    await waitFor(() => expect(d.getByText(text)).toBeInTheDocument());
    expect(d.queryByTestId("metric-dictionary")).not.toBeInTheDocument();
  });

  it("a stale answer says it is stale and still shows the dictionary", async () => {
    const d = await openDefinitions(dictionaryReadAs("FX-06-stale-source"));
    expectStatic(d);
    expect(await d.findByText("Source data is stale")).toBeInTheDocument();
    expect(d.getByTestId("metric-dictionary")).toBeInTheDocument();
  });

  it("a partial answer says it is partial and still shows the dictionary", async () => {
    const d = await openDefinitions(dictionaryReadAs("FX-05-partial-coverage"));
    expectStatic(d);
    expect(await d.findByText("Partial data")).toBeInTheDocument();
    expect(d.getByTestId("metric-dictionary")).toBeInTheDocument();
  });

  it("the live adapter's pending state says not connected, shows no dictionary and keeps the static definitions", async () => {
    const user = userEvent.setup();
    renderRoute("/analytics/attribution", createLiveAdapter("sandbox"));
    await screen.findAllByRole("alert");
    await user.click(screen.getByRole("button", { name: "Metric definitions" }));
    const d = within((await screen.findByRole("heading", { name: "Metric definitions", hidden: true })).closest("dialog")!);
    expectStatic(d);
    expect(await d.findByText(/not connected/)).toBeInTheDocument();
    expect(d.queryByTestId("metric-dictionary")).not.toBeInTheDocument();
  });
});

describe("acquisition cost wording", () => {
  it("labels historical accepted fees as historical, separate from commission, and says new acquisition has no upfront fee", async () => {
    const d = await openDefinitions(createDemoAdapter({ fixture: "FX-01-happy-read" }));
    const buckets = await d.findByTestId("cost-buckets");
    expect(buckets).toHaveTextContent(/historical accepted fees/i);
    expect(buckets).not.toHaveTextContent(/^Creator fees/);
    expect(d.getByTestId("definition-blendedCac")).toHaveTextContent(/commission-only: no upfront creator fee/);
    expect(d.getByTestId("definition-blendedCac")).not.toHaveTextContent(/creator fees,/i);
  });

  it("does not promise a correction record anywhere on the page", async () => {
    const d = await openDefinitions(createDemoAdapter({ fixture: "FX-01-happy-read" }));
    await d.findByTestId("metric-dictionary");
    expect(document.body).not.toHaveTextContent(/correction/i);
  });
});

describe("CAC versus contribution bars", () => {
  it("draws both bars when both values are known", async () => {
    open("/analytics/attribution");
    await screen.findByTestId("metric-cac");
    expect(screen.getByTestId("cac-bar")).toBeInTheDocument();
    expect(screen.getByTestId("contribution-bar")).toBeInTheDocument();
  });

  it("draws no contribution bar and says N/A when contribution is unknown", async () => {
    renderRoute("/analytics/attribution", createDemoAdapter({ fixture: "FX-04-missing-metric" }));
    await screen.findByTestId("metric-cac");
    expect(screen.queryByTestId("contribution-bar")).not.toBeInTheDocument();
    expect(screen.getByText(/Contribution \/ order/).closest("div")).toHaveTextContent("N/A");
  });
});
