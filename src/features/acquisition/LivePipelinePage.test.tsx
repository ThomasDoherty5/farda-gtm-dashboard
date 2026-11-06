import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { respondWith } from "@/adapter/demoViews";
import { AdapterError } from "@/adapter/errors";
import { funnelFilterSchema } from "@/creator-agent/funnelContract";
import { evt, jan } from "@/creator-agent/funnelFixtures.testkit";
import { projectFunnel } from "@/creator-agent/funnelProjection";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";

const events = [
  evt("application", "matched", "inbound-A", 6, { route: "inbound" }),
  evt("seed", "sampleDelivered", "inbound-A", 7, { route: "inbound", occurredAt: null }),
  evt("attempt", "attempt", "outbound-B", 5),
];
const live = () =>
  scriptedAdapter(async (request) => {
    const data = projectFunnel(events, funnelFilterSchema.parse(request.filters), jan(20));
    return respondWith(request, data, {
      dataVersion: "fixture revision",
      dataState: data.coverage.opportunities ? (data.coverage.incomplete ? "partial" : "ready") : "empty",
    });
  }, "live");
it("renders persisted counts and filtered account exposure, native receipt drilldown and the same cohort on branches", async () => {
  const user = userEvent.setup(),
    adapter = live();
  renderRoute("/creators/pipeline?route=inbound&account=external-account", adapter);
  await screen.findByRole("button", { name: "Inspect inbound-A" });
  expect(screen.queryByText("Inspect outbound-B")).not.toBeInTheDocument();
  expect(screen.getByText(/Partial coverage: 1 missing event time/)).toBeInTheDocument();
  expect(within(screen.getByTestId("funnel-confirmedSent")).getAllByText("N/A").length).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "Inspect inbound-A" }));
  const dialog = screen.getByRole("heading", { name: "Opportunity evidence", hidden: true }).closest("dialog")!;
  expect(within(dialog).getByRole("link", { name: "proof:application", hidden: true })).toHaveAttribute(
    "href",
    "https://example.invalid/receipt",
  );
  await user.click(within(dialog).getByRole("button", { name: "Close", hidden: true }));
  expect(screen.queryByRole("heading", { name: "Opportunity evidence", hidden: true })).not.toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Paths and branches" }));
  await screen.findByRole("region", { name: "Lifecycle and optional branches" });
  expect(adapter.calls.filter((c) => c.viewKey === "pipelineBranches").at(-1)?.filters).toEqual({
    route: "inbound",
    account: "external-account",
  });
  expect(screen.queryByText(/Sep–Oct 2026/)).not.toBeInTheDocument();
});
it("starts without fixture filters and lets a user recover an empty selection by clearing a filter", async () => {
  const user = userEvent.setup(),
    adapter = live();
  renderRoute("/creators/pipeline", adapter);
  await screen.findByRole("button", { name: "Inspect inbound-A" });
  expect(adapter.calls.find((c) => c.viewKey === "pipelineSummary")?.filters).toEqual({});
  await user.click(screen.getByRole("button", { name: "Filter cohort" }));
  await user.type(screen.getByLabelText("Offer version"), "missing-version");
  await user.click(screen.getByRole("button", { name: "Apply filters", hidden: true }));
  await screen.findByRole("heading", { name: "No acquisition events match" });
  expect(screen.queryByRole("button", { name: "Inspect inbound-A" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Filter cohort" }));
  await user.click(screen.getByRole("button", { name: "Clear filters", hidden: true }));
  await screen.findByRole("button", { name: "Inspect inbound-A" });
});
it("shows an access denial without exposing any protected rows", async () => {
  const adapter = scriptedAdapter(async (request) => {
    throw new AdapterError({
      code: "FORBIDDEN",
      message: "Access denied",
      requestId: request.requestId,
      correlationId: null,
      retryable: false,
      retryAfterMs: null,
    });
  }, "live");
  renderRoute("/creators/pipeline", adapter);
  await screen.findByRole("alert");
  expect(screen.queryByRole("table", { name: "Current opportunity work queue" })).not.toBeInTheDocument();
});
