import { useState } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { respondWith } from "@/adapter/demoViews";
import { SCHEMA_VERSION } from "@/adapter/contract";
import { inventorySourceFixture } from "@/creator-agent/stockSupportFixtures";
import type { NativeStock } from "@/creator-agent/stockSupportSchema";
import { renderWithAdapter, scopeFor } from "@/test/renderWithAdapter";
import { StockSupportProposal } from "./StockSupportProposal";

// Route-leave interception is outside this isolated validation-description regression.
vi.mock("@/components/LeaveGuard", () => ({ LeaveGuard: () => null }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

it("describes Save with the current validation alert, clears on reopen, and prioritizes a later source hold", async () => {
  const fixture = inventorySourceFixture(), period = fixture.periods[0]!;
  const data: NativeStock = { kind: "source-stock", selected: { home: "H1", sku: "FARDA-GRAPHITE", windowRef: "current" },
    currentWindow: "current", windows: [period.window], skus: ["FARDA-GRAPHITE"], period,
    actorRef: "agent-reviewer", revision: fixture.revision, observedAt: fixture.observedAt, coverage: "complete", stale: false,
    reconciliation: null, pending: { total: 0, rows: [] } };
  const res = respondWith({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "inventoryOverview", requestedScope: scopeFor(),
    filters: data.selected, period: null, sort: [], page: { limit: 50, cursor: null }, requestId: "validation-description" }, data,
    { dataVersion: data.revision, capabilities: [{ actionKind: "requestStockTransfer", state: "available", reasonCodes: [] }] });
  const adapter = createDemoAdapter(), submit = vi.spyOn(adapter, "submitAction");
  function Harness() {
    const [held, setHeld] = useState(false);
    return <><button onClick={() => setHeld(true)}>Change source permission</button><StockSupportProposal data={data} res={held ? {
      ...res, capabilities: [{ actionKind: "requestStockTransfer", state: "held", reasonCodes: ["REVIEWER_REQUIRED"] }],
    } : res} /></>;
  }
  renderWithAdapter(<Harness />, adapter);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Request transfer" }));
  const dialog = screen.getByRole("dialog", { name: "Request transfer" });
  let save = within(dialog).getByRole("button", { name: "Save proposal for review" });
  expect(save).not.toHaveAttribute("aria-describedby");
  await user.click(save);
  const error = within(dialog).getByRole("alert");
  const text = "Choose valid proposal details. A transfer needs two different homes and a positive whole unit count.";
  expect(error).toHaveTextContent(text);
  expect(error.id).not.toBe("");
  expect(save).toHaveAttribute("aria-describedby", error.id);
  expect(save).toHaveAccessibleDescription(text);
  const stableId = error.id;
  await user.click(within(dialog).getByRole("button", { name: "Return to record" }));
  await user.click(screen.getByRole("button", { name: "Request transfer" }));
  save = within(dialog).getByRole("button", { name: "Save proposal for review" });
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  expect(save).not.toHaveAttribute("aria-describedby");
  await user.click(save);
  expect(within(dialog).getByRole("alert").id).toBe(stableId);
  await user.click(screen.getByRole("button", { name: "Change source permission" }));
  expect(save).toHaveAccessibleDescription("A reviewer role is required to record this change.");
  expect(save).toHaveAttribute("aria-disabled", "true");
  expect(submit).not.toHaveBeenCalled();
});
