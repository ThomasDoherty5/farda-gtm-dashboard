import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReadOptions } from "@/adapter/adapter";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { readShippingHub } from "@/adapter/demoShippingHub";
import type { ReadRequest, ReadResponse } from "@/adapter/contract";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";
import type { ShippingHubData } from "./types";

const path = "/operations?view=hub";
describe("unified shipping hub", () => {
  it("keeps assistive-technology focus on the addressed cell without adding static cells to the Tab order", async () => {
    const user = userEvent.setup(); renderRoute(path, createDemoAdapter());
    const table = await screen.findByRole("table", { name: "Shared shipment queue" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers).toHaveLength(8);
    for (const cell of [...headers, ...within(table).getAllByRole("rowheader"), ...within(table).getAllByRole("cell")]) {
      expect(cell).toHaveAttribute("tabindex", "-1");
      cell.focus(); expect(cell).toHaveFocus();
    }
    const selectAll = within(table).getByRole("checkbox", { name: "Select visible shipments" });
    selectAll.focus(); await user.tab();
    expect(within(table).getAllByRole("checkbox")[1]).toHaveFocus();
  });
  it("renders the shared queue, filters creators and preserves selection across filtering", async () => {
    const user = userEvent.setup(); renderRoute(path, createDemoAdapter());
    const table = await screen.findByRole("table", { name: "Shared shipment queue" }, { timeout: 5000 });
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(await screen.findByRole("button", { name: "Review 2 selected" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Creators · 3" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Review 2 selected" })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search shipments" }), "C020");
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  });
  it("applies the shipping shell variant only to the new hub route", async () => {
    const router = renderRoute(path, createDemoAdapter());
    await screen.findByRole("table", { name: "Shared shipment queue" });
    expect(document.querySelector('[data-shell-variant="shipping-hub"]')).toBeInTheDocument();
    await act(() => router.navigate("/operations?view=shipping"));
    await waitFor(() => expect(document.querySelector('[data-shell-variant="shipping-hub"]')).not.toBeInTheDocument());
    expect(screen.getByTestId("demo-banner")).toHaveTextContent("Demo workspace");
  });
  it("reviews a mixed batch with one unknown cost, and never submits a purchase or approval", async () => {
    const user = userEvent.setup(); const adapter = createDemoAdapter(); const submit = vi.spyOn(adapter, "submitAction"); renderRoute(path, adapter);
    await user.click(await screen.findByRole("button", { name: "Review 2 selected" }));
    expect(await screen.findByText("2 selected · 1 reviewable · 1 blocked", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByText(/\$6\.85 · maximum \$7\.00/)).toBeInTheDocument();
    const purchase = screen.getByRole("button", { name: "Purchase unavailable", hidden: true });
    expect(purchase).toHaveAttribute("aria-disabled", "true"); await user.click(purchase);
    await user.click(screen.getByRole("button", { name: "Preview approval draft", hidden: true }));
    expect(await screen.findByRole("region", { name: "Approval draft preview", hidden: true })).toHaveTextContent("Draft preview · not submitted");
    expect(submit).not.toHaveBeenCalled();
  });
  it("keeps duplicate tracking holds when the sibling parcel is filtered out", async () => {
    const user = userEvent.setup();
    renderRoute(`${path}&scenario=edge&ship-query=DEMO-SHIP-1043-P1`, createDemoAdapter());
    const table = await screen.findByRole("table", { name: "Shared shipment queue" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByTestId("hub-ready").closest("dl")).toHaveTextContent("0 reviewable · 1 held");
    await user.click(within(table).getByRole("checkbox", { name: "Select DEMO-SHIP-1043-P1" }));
    await user.click(screen.getByRole("button", { name: "Review 1 selected" }));
    expect(screen.getByText("1 selected · 0 reviewable · 1 blocked", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByText(/Tracking identity is shared by multiple parcels/)).toBeInTheDocument();
  });
  it("advances live ETA and quote displays, details and filters without another source read", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-04T18:42:00.000Z"));
    try {
      const user = userEvent.setup();
      const scripted = scriptedAdapter(async request => {
        const result = readShippingHub(request) as ReadResponse<ShippingHubData> | null;
        if (!result?.data) throw new Error("Expected a scripted shipping read");
        result.data.shipments.find(s => s.id === "DEMO-SHIP-1041")!.eta = "2026-11-04T18:42:10.000Z";
        result.data.shipments.find(s => s.id === "DEMO-SHIP-1042")!.quote!.expiresAt = "2026-11-04T18:42:10.000Z";
        return result;
      }, "live");
      const adapter = { ...scripted, environment: "sandbox" as const };
      const router = renderRoute(path, adapter);
      await screen.findByRole("table", { name: "Shared shipment queue" });
      expect(within(screen.getByTestId("hub-late")).getByText("0", { exact: true })).toBeInTheDocument();
      const ready = screen.getByTestId("shipment-DEMO-SHIP-1042");
      expect(ready).toHaveTextContent("Valid until 10:42 PT");
      await user.click(within(ready).getByRole("button", { name: "Review label proposal" }));
      const detail = screen.getByText("Shipment details", { selector: "h2" }).closest("dialog")!;
      expect(detail).toHaveTextContent("Valid until 10:42 PT");
      await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
      expect(within(screen.getByTestId("hub-late")).getByText("1", { exact: true })).toBeInTheDocument();
      expect(screen.getByTestId("shipment-DEMO-SHIP-1041")).toHaveTextContent("ETA Nov 4 · late");
      expect(ready).toHaveTextContent("Expired");
      expect(detail).toHaveTextContent("Expired");
      await user.click(within(detail).getByRole("button", { name: "Close Shipment details", hidden: true }));
      await act(() => router.navigate(`${path}&ship-date=late`));
      const filtered = screen.getByRole("table", { name: "Shared shipment queue" });
      expect(within(filtered).getAllByRole("row")).toHaveLength(2);
      expect(within(filtered).getByText("Customer · C-1041")).toBeInTheDocument();
      expect(adapter.calls.filter(r => r.viewKey === "shippingHub")).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("refresh invalidates the selected proposal when source capability changes", async () => {
    const user = userEvent.setup(); const adapter = createDemoAdapter(); const original = adapter.readView.bind(adapter); let changed = false;
    adapter.readView = (async (request: ReadRequest<unknown>, options?: ReadOptions) => {
      const result = await original(request, options);
      if (changed && request.viewKey === "shippingHub") {
        const copy = structuredClone(result) as ReadResponse<ShippingHubData>;
        copy.data!.shipments.find(s => s.id === "DEMO-SHIP-1042")!.reviewCapability = { state: "denied", reason: "Permission changed" };
        return copy as typeof result;
      }
      return result;
    }) as typeof adapter.readView;
    renderRoute(path, adapter); await screen.findByRole("button", { name: "Review 2 selected" }); changed = true;
    await user.click(screen.getByRole("button", { name: "Refresh source read" }));
    await screen.findByText(/A selected record changed/);
    await user.click(screen.getByRole("button", { name: "Review 2 selected" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview approval draft", hidden: true })).toHaveAttribute("aria-disabled", "true"));
  });
  it("shows the delivered sample clock and accepted terms without starting a second clock", async () => {
    const user = userEvent.setup(); renderRoute(path, createDemoAdapter());
    await user.click(await screen.findByRole("button", { name: "Open creator details" }));
    expect(await screen.findByText("Posting deadline · read-only")).toBeInTheDocument();
    expect(screen.getByText(/DEMO-CLOCK-C020/)).toBeInTheDocument();
    expect(screen.getByText(/no commerce order/)).toBeInTheDocument();
  });
  it.each([
    { timezone: "America/New_York", dueAt: "2026-11-12T01:00:00.000Z", expected: "Nov 11, 8:00 PM · America/New_York", day: "Nov 11" },
    { timezone: "America/New_York", dueAt: "2026-11-12T05:30:00.000Z", expected: "Nov 12, 12:30 AM · America/New_York", day: "Nov 12" },
    { timezone: "Mars/Olympus", dueAt: "2026-11-12T01:00:00.000Z", expected: "Nov 12, 1:00 AM · UTC (unrecognized source timezone: Mars/Olympus)", day: "Nov 12 · UTC" },
  ])("labels the posting deadline truthfully for $timezone", async ({ timezone, dueAt, expected, day }) => {
    const user = userEvent.setup();
    const adapter = scriptedAdapter(async request => {
      const result = readShippingHub(request) as ReadResponse<ShippingHubData> | null;
      if (!result?.data) throw new Error("Expected a scripted shipping read");
      const posting = result.data.shipments.find(s => s.postingClock)!.postingClock!;
      posting.timezone = timezone;
      posting.dueAt = dueAt;
      return result;
    });
    renderRoute(path, adapter);
    await user.click(await screen.findByRole("button", { name: "Open creator details" }));
    expect(screen.getByText(/DEMO-CLOCK-C020/)).toHaveTextContent(expected);
    expect(screen.getByTestId("shipment-DEMO-SHIP-C020")).toHaveTextContent(`Posting due ${day}`);
  });
  it("an unknown label outcome exposes reconciliation rather than another purchase", async () => {
    const user = userEvent.setup(); renderRoute(`${path}&scenario=edge`, createDemoAdapter());
    await user.click(await screen.findByRole("button", { name: "Reconcile label outcome" }));
    const detail = screen.getByText("Creator shipment", { selector: "h2" }).closest("dialog")!;
    expect(detail).toHaveTextContent("Provider outcome unknown. Reconcile before retrying.");
    expect(within(detail).getByRole("button", { name: "Reconcile label outcome", hidden: true })).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Review label proposal", hidden: true })).not.toBeInTheDocument();
  });
  it.each(["unavailable", "forbidden"])("%s source does not fall back to demo rows", async scenario => {
    renderRoute(`${path}&scenario=${scenario}`, createDemoAdapter());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Shared shipment queue" })).not.toBeInTheDocument();
    expect(screen.queryByText("@demo.river")).not.toBeInTheDocument();
  });
  it("a pending live adapter displays no synthetic shipments", async () => {
    renderRoute(path, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not connected|not available|pending/i);
    expect(screen.queryByRole("table", { name: "Shared shipment queue" })).not.toBeInTheDocument();
  });
  it.each(["stale-envelope", "expired-window"])("%s blocks review even when individual fields claim current", async scenario => {
    const user = userEvent.setup(); const adapter = createDemoAdapter(); const read = adapter.readView.bind(adapter);
    adapter.readView = (async (request: ReadRequest<unknown>, options?: ReadOptions) => {
      const result = await read(request, options);
      if (request.viewKey !== "shippingHub") return result;
      if (scenario === "stale-envelope") return { ...result, dataState: "stale" };
      const copy = structuredClone(result) as ReadResponse<ShippingHubData>;
      copy.data!.reviewValidUntil = "2026-11-04T18:41:00.000Z";
      return copy;
    }) as typeof adapter.readView;
    renderRoute(path, adapter);
    await user.click(await screen.findByRole("button", { name: "Review 2 selected" }));
    expect(screen.getByText("2 selected · 0 reviewable · 2 blocked", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview approval draft", hidden: true })).toHaveAttribute("aria-disabled", "true");
  });
});
