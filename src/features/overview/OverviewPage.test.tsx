import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { AdapterError } from "@/adapter/errors";
import type { OverviewFixtureKey } from "@/fixtures/overview";
import { overviewOriginal } from "@/fixtures/overview";
import { renderWithAdapter, scriptedAdapter } from "@/test/renderWithAdapter";
import type { ReadRequest, ReadResponse } from "@/adapter/contract";
import { OverviewPage } from "./OverviewPage";

const renderFixture = (fixture: OverviewFixtureKey) => renderWithAdapter(<OverviewPage />, createDemoAdapter({ fixture }));
const metric = (label: string) => screen.findByTestId(`metric-${label}`);

const ok = (request: ReadRequest<unknown>): ReadResponse<unknown> => ({
  schemaVersion: request.schemaVersion,
  requestId: request.requestId,
  scope: { ...request.requestedScope, authorizationScopeVersion: "1" },
  dataVersion: "1",
  dataState: "ready",
  data: overviewOriginal,
  sourceFreshness: [],
  coverage: { expectedCount: 5, observedCount: 5, missingCount: 0, complete: true, reasonCodes: [] },
  capabilities: [],
  page: { nextCursor: null, hasMore: false },
  refresh: { nextPollAfterMs: null },
});

describe("OverviewPage", () => {
  it("FX-01 shows all six metrics from the overview-original dataset", async () => {
    renderFixture("FX-01-happy-read");
    expect(await metric("Orders")).toHaveTextContent("400");
    expect(await metric("Store sales")).toHaveTextContent("$12,596");
    expect(await metric("Post views")).toHaveTextContent("240,000");
    expect(await metric("Engagement rate")).toHaveTextContent("5.0%");
    expect(await metric("Attributed orders")).toHaveTextContent("180");
    expect(await metric("Attributed net sales")).toHaveTextContent("$5,796");
  });

  it("FX-02 shows a measured zero, not N/A", async () => {
    renderFixture("FX-02-known-zero");
    expect(await metric("Attributed orders")).toHaveTextContent(/^0$/);
    expect(await metric("Attributed net sales")).toHaveTextContent("$0");
    expect(screen.queryByText(/N\/A/)).not.toBeInTheDocument();
  });

  it("FX-03 shows an honest empty state instead of zeros or an error", async () => {
    renderFixture("FX-03-empty-filter");
    expect(await screen.findByRole("heading", { name: "No matching records" })).toBeInTheDocument();
    expect(screen.queryByTestId("metric-Orders")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("FX-04 shows engagement as N/A with a reason when shares are missing, and keeps the other metrics", async () => {
    renderFixture("FX-04-missing-metric");
    const engagement = await metric("Engagement rate");
    expect(engagement).toHaveTextContent("N/A");
    expect(engagement).toHaveTextContent("Shares are unavailable");
    expect(engagement).not.toHaveTextContent("%");
    expect(await metric("Post views")).toHaveTextContent("240,000");
  });

  it("FX-05 warns that totals cover only the available records", async () => {
    renderFixture("FX-05-partial-coverage");
    expect(await screen.findByRole("alert")).toHaveTextContent("3 of 5 source records");
    expect(await metric("Post views")).toHaveTextContent("180,000");
  });

  it("FX-06 labels stale values with the reason and the last successful sync", async () => {
    renderFixture("FX-06-stale-source");
    expect(await screen.findByRole("alert")).toHaveTextContent("SOURCE_SYNC_DELAYED");
    expect(screen.getByText(/Metrics as of Oct 30, 2026/)).toBeInTheDocument();
  });

  it("FX-08 shows a neutral denial with no retry and no values", async () => {
    renderFixture("FX-08-forbidden-account");
    expect(await screen.findByRole("heading", { name: "No access to this account" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("metric-Orders")).not.toBeInTheDocument();
  });

  it("FX-09 asks for a new sign-in and removes values read before the session expired", async () => {
    const adapter = scriptedAdapter(async (request, call) => {
      if (call === 1) return ok(request);
      throw new AdapterError({ code: "SESSION_EXPIRED", message: "expired", requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    });
    const { client } = renderWithAdapter(<OverviewPage />, adapter);
    expect(await metric("Orders")).toHaveTextContent("400");
    await client.refetchQueries();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in again" })).toBeInTheDocument());
    expect(screen.queryByTestId("metric-Orders")).not.toBeInTheDocument();
  });

  it("FX-07 offers a retry, and recovers when the source returns", async () => {
    const user = userEvent.setup();
    const adapter = scriptedAdapter(async (request, call) => {
      if (call === 1) throw new AdapterError({ code: "SOURCE_UNAVAILABLE", message: "The data service could not be reached.", requestId: null, correlationId: "corr-1", retryable: false, retryAfterMs: null });
      return ok(request);
    });
    renderWithAdapter(<OverviewPage />, adapter);
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Reference: corr-1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await metric("Orders")).toHaveTextContent("400");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("labels values kept through an outage as possibly out of date", async () => {
    const adapter = scriptedAdapter(async (request, call) => {
      if (call === 1) return ok(request);
      throw new AdapterError({ code: "SOURCE_UNAVAILABLE", message: "down", requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    });
    const { client } = renderWithAdapter(<OverviewPage />, adapter);
    expect(await metric("Orders")).toHaveTextContent("400");
    await client.refetchQueries();
    expect(await screen.findByRole("alert")).toHaveTextContent("last successful read");
    expect(screen.getByTestId("metric-Orders")).toHaveTextContent("400");
  });
});
