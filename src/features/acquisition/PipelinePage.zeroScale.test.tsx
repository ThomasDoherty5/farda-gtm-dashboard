import { screen, within } from "@testing-library/react";
import { respondWith } from "@/adapter/demoViews";
import { CURRENT_STAGES, PIPELINE_STAGES, pipelineDemo, pipelineSources, type PipelineData } from "@/fixtures/pipeline";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";

/** Fictional, internally consistent zero cohort; a returned source is distinct from an empty selection. */
function zeroCohort(): PipelineData {
  const source = structuredClone(pipelineSources[0]!);
  source.reached = PIPELINE_STAGES.map(() => 0);
  source.medianDays = PIPELINE_STAGES.map(() => null);
  for (const stage of CURRENT_STAGES) source.current[stage.key] = 0;
  source.dispatch = { queued: 0, toReconcile: 0 };
  source.closed = { waiting: 0, declined: 0, expired: 0 };
  source.sends = { approved: 0, confirmed: 0, uncertain: 0, queued: 0, replies: 0, attempts: 0, opportunities: 0 };
  source.outcomes = {
    posts: 0, comparablePosts: 0, views: 0, engagements: 0, orders: 0, fullyRefundedOrders: 0,
    merchandise: { minorUnits: 0, currency: "USD" }, refunds: { minorUnits: 0, currency: "USD" },
  };
  return { ...pipelineDemo, scaleMax: 0, sources: [source] };
}

async function open(data: PipelineData, partial = false) {
  const adapter = scriptedAdapter(async (request) => respondWith(request, data, {
    dataVersion: "zero-scale-regression", dataState: partial ? "partial" : "ready",
  }));
  renderRoute("/creators/pipeline", adapter);
  await screen.findByTestId("metric-Confirmed invitations");
}

describe("THO-345: funnel scale boundaries", () => {
  it.each([
    { label: "known-zero counts", unknownTracking: false },
    { label: "known-zero and unknown counts", unknownTracking: true },
  ])("renders $label on a zero scale without invalid CSS or invented conversions", async ({ unknownTracking }) => {
    const data = zeroCohort();
    if (unknownTracking) {
      data.sources[0]!.reached[7] = null;
      data.sources[0]!.current.trackingSetup = null;
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await open(data, unknownTracking);
      expect(screen.getByRole("region", { name: /counts on a shared 0 scale/ })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "No opportunities match" })).not.toBeInTheDocument();
      for (const [index, stage] of PIPELINE_STAGES.entries()) {
        const column = screen.getByTestId("funnel-" + stage.key);
        const count = column.querySelector("p")!;
        const bar = column.querySelector("span[aria-hidden='true']");
        const unknown = unknownTracking && index === 7;
        expect(count).toHaveTextContent(unknown ? /^N\/A$/ : /^0$/);
        expect(count).toHaveStyle({ top: "236px" });
        if (unknown) expect(bar).toBeNull();
        else expect(bar).toHaveStyle({ top: "272px", height: "0px" });
      }
      expect(within(screen.getByTestId("funnel-matched")).getByText("N/A")).toBeInTheDocument();
      expect(errors.mock.calls.flat().map(String).join(" ")).not.toMatch(/NaN|Infinity/);
    } finally {
      errors.mockRestore();
    }
  });

  it("preserves positive-scale geometry when reached counts mix positive values and known zero", async () => {
    const data = zeroCohort();
    data.scaleMax = 120;
    data.sources[0]!.reached[0] = 60;
    data.sources[0]!.current.videoReview = 60;
    await open(data);
    const discovered = screen.getByTestId("funnel-discovered");
    expect(discovered.querySelector("span[aria-hidden='true']")).toHaveStyle({ top: "162px", height: "110px" });
    expect(discovered.querySelector("p")).toHaveStyle({ top: "126px" });
    expect(within(discovered).getByText("60")).toBeInTheDocument();
    const reviewed = screen.getByTestId("funnel-videoReviewed");
    expect(reviewed.querySelector("span[aria-hidden='true']")).toHaveStyle({ top: "272px", height: "0px" });
    expect(within(reviewed).getByText("0")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /counts on a shared 120 scale/ })).toBeInTheDocument();
  });
});
