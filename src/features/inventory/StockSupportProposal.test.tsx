import { useState } from "react";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { respondWith } from "@/adapter/demoViews";
import { SCHEMA_VERSION, type ActionResponse } from "@/adapter/contract";
import { inventorySourceFixture } from "@/creator-agent/stockSupportFixtures";
import type { NativeStock } from "@/creator-agent/stockSupportSchema";
import { renderWithAdapter, scopeFor } from "@/test/renderWithAdapter";
import { StockSupportProposal } from "./StockSupportProposal";
import { ScopeProvider } from "@/adapter/scope";
import { SourceReadGrant } from "@/components/SourceReadGrant";

// Route-leave interception is outside this isolated validation-description regression.
vi.mock("@/components/LeaveGuard", () => ({ LeaveGuard: () => null }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

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

function preparationHarness(id: string) {
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  let release!: (value: ArrayBuffer) => void;
  const digest = vi.fn(() => new Promise<ArrayBuffer>(resolve => { release = resolve; }));
  vi.stubGlobal("crypto", { randomUUID: () => webcrypto.randomUUID(), subtle: { digest } });
  const fixture = inventorySourceFixture(), period = fixture.periods[0]!;
  const data: NativeStock = { kind: "source-stock", selected: { home: "H1", sku: "FARDA-GRAPHITE", windowRef: "current" },
    currentWindow: "current", windows: [period.window], skus: ["FARDA-GRAPHITE"], period, actorRef: "agent-reviewer",
    revision: fixture.revision, observedAt: fixture.observedAt, coverage: "complete", stale: false,
    reconciliation: null, pending: { total: 0, rows: [] }, readAccess: { validUntil: new Date(clock + 60_000).toISOString() } };
  const adapter = createDemoAdapter(), submit = vi.spyOn(adapter, "submitAction");
  const res = respondWith({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "inventoryOverview", requestedScope: scopeFor(),
    filters: data.selected, period: null, sort: [], page: { limit: 50, cursor: null }, requestId: id }, data,
    { dataVersion: data.revision, capabilities: [{ actionKind: "requestStockTransfer", state: "available", reasonCodes: [] }] });
  function Harness() {
    const [changed, change] = useState(false), [account, setAccount] = useState(id);
    return <><button onClick={() => change(true)}>Replace stock source</button><button onClick={() => setAccount(id + "-other")}>Change account</button>
      <ScopeProvider adapter={adapter} scope={scopeFor("demo", [account])} principal="tester">
        <SourceReadGrant validUntil={data.readAccess?.validUntil} title="Stock evidence" refresh={() => {}}>
          <StockSupportProposal data={changed ? { ...data, revision: "source-v2" } : data} res={changed ? { ...res, dataVersion: "source-v2" } : res} />
        </SourceReadGrant>
      </ScopeProvider></>;
  }
  const rendered = renderWithAdapter(<Harness />, adapter);
  return { ...rendered, digest, submit, release: () => release(new ArrayBuffer(32)), expire: () => {
    clock += 60_001; fireEvent(window, new Event("focus"));
  } };
}
async function prepareTransfer() {
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Request transfer" }));
  const form = within(screen.getByRole("dialog", { name: "Request transfer" }));
  await user.selectOptions(form.getByLabelText("To"), "H2"); await user.type(form.getByLabelText("Units"), "1");
  await user.selectOptions(form.getByLabelText("Reason"), "low-stock");
  await user.click(form.getByRole("button", { name: "Save proposal for review" }));
}
it.each(["expiry", "source", "scope"])("does not send an unsent transfer when %s changes during hashing", async change => {
  const h = preparationHarness("stock-digest-" + change); await prepareTransfer();
  expect(h.digest).toHaveBeenCalledOnce(); expect(h.submit).not.toHaveBeenCalled();
  if (change === "expiry") { act(h.expire); expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); }
  else fireEvent.click(screen.getByRole("button", { name: change === "source" ? "Replace stock source" : "Change account" }));
  await act(async () => { h.release(); });
  expect(h.submit).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
  h.client.clear();
});
it("keeps the original transfer marker when access expires after the request was sent", async () => {
  const h = preparationHarness("stock-sent-expiry"); let reject!: (error: Error) => void;
  h.submit.mockImplementation(() => new Promise<ActionResponse>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  await prepareTransfer(); await act(async () => { h.release(); });
  await waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
  const request = h.submit.mock.calls[0]![0], stored = sessionStorage.getItem(sessionStorage.key(0)!);
  expect(stored).toContain(request.idempotencyKey);
  act(h.expire); await act(async () => { reject(new Error("Fictional lost acknowledgment")); });
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(stored); expect(h.submit).toHaveBeenCalledOnce(); h.client.clear();
});
