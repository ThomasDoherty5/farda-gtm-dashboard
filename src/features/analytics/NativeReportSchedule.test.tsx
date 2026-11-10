import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NativeReportSchedule } from "./NativeReportSchedule";

const state = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock("@/adapter/useView", () => ({ useView: () => state.value }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("removes a current report claim at source expiry while its independent read grant is still valid", () => {
  vi.useFakeTimers(); const now = Date.parse("2026-11-09T12:00:00Z"); vi.setSystemTime(now);
  state.value = { isPending: false, isError: false, refetch: vi.fn(), data: { dataState: "ready", data: {
    sourceState: "current", sourceObservedAt: new Date(now - 14 * 60_000).toISOString(),
    readAccess: { validUntil: new Date(now + 10 * 60_000).toISOString() },
    records: [{ id: "fictional-report", title: "Reporting", details: [["Configuration", "draft"], ["Timezone", "UTC"]] }],
  } } };
  render(<MemoryRouter><NativeReportSchedule /></MemoryRouter>);
  expect(screen.getByText(/Source current/)).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(60_002); });
  expect(screen.getByText(/Source stale/)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Report evidence is stale");
  expect(screen.getByRole("table", { name: "Reporting" })).toHaveTextContent("draft");
  expect(screen.queryByText(/Source access has expired/)).not.toBeInTheDocument();
});
