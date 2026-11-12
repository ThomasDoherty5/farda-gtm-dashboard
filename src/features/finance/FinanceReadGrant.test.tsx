import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { AdapterError } from "@/adapter/errors";
import { financeRecord } from "@/creator-agent/finance/fixtures.testkit";
import type { FinanceViewKey } from "@/creator-agent/finance/contract";
import { renderRoute, testClient } from "@/test/renderWithAdapter";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const cases = [
  ["/finance", "financeDashboard", "pnl", "View metric definitions"],
  ["/analytics/finance", "financeDashboard", "trajectory", "Reporting period"],
  ["/finance/close/2026-10", "periodClose", "checklist", "Open QuickBooks"],
  ["/finance/close/2026-10?view=package", "closePackage", "receipts", null],
  ["/finance/close/2026-10?view=months", "monthsHistory", "months", null],
  ["/finance/close/2026-10?view=manifest", "reportManifest", "manifest", null],
] as const;
function setup(path: string, key: FinanceViewKey) {
  let time = Date.parse("2026-11-06T12:00:00Z"), deadline = time + 60_000;
  let errorCode: string | null = null, reads = 0;
  vi.spyOn(Date, "now").mockImplementation(() => time);
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read" || request.envelope.viewKey !== key) throw new Error("Unexpected finance operation");
    reads++;
    if (errorCode) throw new AdapterError({ code: errorCode, message: "Synthetic current read refused.",
      requestId: request.envelope.requestId, correlationId: null, retryable: false, retryAfterMs: null });
    const data = { ...financeRecord(key), readAccess: { validUntil: new Date(deadline).toISOString() } };
    return respondWith(request.envelope, data, { dataVersion: "synthetic-lease-" + deadline });
  } } });
  const client = testClient();
  renderRoute(path, adapter, client);
  return { client, reads: () => reads, expire: () => { time = deadline; }, renew: () => { deadline = time + 60_000; }, deny: (code: string) => { errorCode = code; } };
}
describe("all legacy finance consumers use the independent native access grant", () => {
  it.each(cases)("%s clears source facts and open dialogs on resume at expiry, then requires a fresh read", async (path, key, marker, dialogButton) => {
    const state = setup(path, key);
    expect(await screen.findByTestId(marker)).toBeInTheDocument();
    if (dialogButton) {
      fireEvent.click(screen.getByRole("button", { name: dialogButton }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    }
    act(() => { state.expire(); window.dispatchEvent(new Event("focus")); });
    expect(screen.queryByTestId(marker)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Source access has expired");
    const before = state.reads();
    state.renew();
    fireEvent.click(screen.getByRole("button", { name: "Refresh source evidence" }));
    expect(await screen.findByTestId(marker)).toBeInTheDocument();
    expect(state.reads()).toBeGreaterThan(before);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it.each(cases)("%s clears retained facts and dialogs after a current read failure", async (path, key, marker, dialogButton) => {
    const state = setup(path, key);
    expect(await screen.findByTestId(marker)).toBeInTheDocument();
    if (dialogButton) fireEvent.click(screen.getByRole("button", { name: dialogButton }));
    state.deny("SOURCE_UNAVAILABLE");
    await act(async () => { await state.client.invalidateQueries(); });
    await waitFor(() => expect(screen.queryByTestId(marker)).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
  it.each(["UNAUTHENTICATED", "FORBIDDEN"])("clears protected finance and its dialog after %s", async code => {
    const state = setup("/finance", "financeDashboard");
    expect(await screen.findByTestId("pnl")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View metric definitions" }));
    state.deny(code);
    await act(async () => { await state.client.invalidateQueries(); });
    await waitFor(() => expect(screen.queryByTestId("pnl")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
