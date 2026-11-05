import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReadOptions } from "@/adapter/adapter";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import type { ReadRequest, ReadResponse } from "@/adapter/contract";
import { renderRoute } from "@/test/renderWithAdapter";
import type { ShippingHubData } from "./types";

const path = "/operations?view=hub";
describe("unified shipping hub", () => {
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
  it("a stale source envelope blocks review even when individual fields claim current", async () => {
    const user = userEvent.setup(); const adapter = createDemoAdapter(); const read = adapter.readView.bind(adapter);
    adapter.readView = (async (request: ReadRequest<unknown>, options?: ReadOptions) => { const result = await read(request, options); return request.viewKey === "shippingHub" ? { ...result, dataState: "stale" } : result; }) as typeof adapter.readView;
    renderRoute(path, adapter);
    await user.click(await screen.findByRole("button", { name: "Review 2 selected" }));
    expect(screen.getByText("2 selected · 0 reviewable · 2 blocked", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview approval draft", hidden: true })).toHaveAttribute("aria-disabled", "true");
  });
});
