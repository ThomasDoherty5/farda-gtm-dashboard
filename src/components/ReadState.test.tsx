import { render, screen } from "@testing-library/react";
import type { ReadResponse } from "@/adapter/contract";
import { ReadState } from "./ReadState";

const base: ReadResponse<{ n: number }> = {
  schemaVersion: "1", requestId: "r", scope: { workspaceId: "w", accountIds: ["a"], environment: "demo", authorizationScopeVersion: "1" } as never,
  dataVersion: "v1", dataState: "ready", data: { n: 1 }, sourceFreshness: [], coverage: { expectedCount: null, observedCount: null, missingCount: null, complete: null, reasonCodes: [] },
  capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null },
};

describe("ReadState", () => {
  it("shows nothing for ready data or before a read", () => {
    const { container, rerender } = render(<ReadState res={base} subject="Orders" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ReadState res={undefined} subject="Orders" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("says stale data is the last successful read, with its time, and claims no fresh sync", () => {
    render(<ReadState res={{ ...base, dataState: "stale", sourceFreshness: [{ sourceRef: {} as never, lastSourceSuccessAt: "2026-10-01T08:00:00.000Z", observedAt: null, mirroredAt: null, staleReasonCode: "X" }] }} subject="Orders" />);
    expect(screen.getByTestId("view-stale")).toHaveTextContent(/last successful read, from Oct 1/);
    expect(screen.getByTestId("view-stale")).toHaveTextContent("not current");
  });
  it("says when the time of the last read is unknown instead of inventing one", () => {
    render(<ReadState res={{ ...base, dataState: "stale" }} subject="Orders" />);
    expect(screen.getByTestId("view-stale")).toHaveTextContent("when that was is unknown");
  });
  it("states partial coverage with its counts, or says coverage is unknown", () => {
    const { rerender } = render(<ReadState res={{ ...base, dataState: "partial", coverage: { expectedCount: 10, observedCount: 6, missingCount: 4, complete: false, reasonCodes: [] } }} subject="Orders" />);
    expect(screen.getByTestId("view-partial")).toHaveTextContent("covers 6 of 10 expected rows");
    expect(screen.getByTestId("view-partial")).toHaveTextContent("never zero");
    rerender(<ReadState res={{ ...base, dataState: "partial" }} subject="Orders" />);
    expect(screen.getByTestId("view-partial")).toHaveTextContent("is unknown");
  });
  it("says an empty read is a successful nothing, not an error or a zero", () => {
    render(<ReadState res={{ ...base, dataState: "empty", data: null }} subject="Orders" />);
    expect(screen.getByText("Nothing to show for orders")).toBeInTheDocument();
    expect(screen.getByText(/not an error, and it is not zero/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
