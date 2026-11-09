import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { SCHEMA_VERSION } from "@/adapter/contract";
import type { FulfillmentProposal } from "@/creator-agent/fulfillmentDomain/contract";
import { renderWithAdapter } from "@/test/renderWithAdapter";
import { NativeFulfillmentControl } from "./NativeFulfillmentControl";
const key = JSON.stringify(["native-fulfillment-preview-v1", "farda", "tester", "sandbox", "w", "a", "returnTask", "return-source"]);
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); sessionStorage.clear(); });
function setup(inline = false) {
  const writes: unknown[] = [], reads: unknown[] = [];
  const view: FulfillmentProposal = { kind: "native-fulfillment-proposal", target: { kind: "returnTask", ref: "return-source" }, version: "source-v1", source: { synthetic: true, observedAt: "2026-11-08T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" }, capability: { state: "available", reasonCodes: [] }, recovery: null,
    plans: [{ planRef: "plan-refund-one", summary: "Quarantine one inspected unit; refund USD 35.00", disposition: "quarantine", inspectedQuantity: 1, inspectionEvidenceRef: "inspection-one", capability: { state: "available", reasonCodes: [] }, remedy: { kind: "refund", orderRef: "order-source", lineRefs: ["line-one"], amount: { minorUnits: 3500, currency: "USD" }, remainingRefundable: { minorUnits: 3500, currency: "USD" }, balanceVersion: "balance-v1" } }] };
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind === "read") {
      reads.push(request.envelope.filters);
      const filters = request.envelope.filters as { requestKey?: string };
      return respondWith(request.envelope, { ...view, recovery: filters.requestKey ? { requestKey: filters.requestKey, state: "pending", approvalRef: null, manifestRef: null, version: null } : null }, { dataVersion: view.version });
    }
    writes.push(request.envelope);
    return { schemaVersion: SCHEMA_VERSION, requestId: request.envelope.requestId, scope: { ...request.envelope.requestedScope, authorizationScopeVersion: "auth-v1" }, actionRef: "preview-one", state: "draft", runRef: null, approvalRef: "approval-one", manifestRef: "manifest-one", payloadVersion: "source-v1", policyVersion: "policy-v1", modelVersion: null, offerVersion: null, reasonCodes: [], receiptRefs: [], nextAction: null, nextPollAfterMs: null, executionCertainty: "notApplied" };
  } } });
  renderWithAdapter(<NativeFulfillmentControl inline={inline} kind="returnTask" targetRef="return-source" label="Prepare browser task" />, adapter);
  return { writes, reads, user: userEvent.setup() };
}
it("previews an exact source plan without retaining the operational reason in browser storage", async () => {
  const h = setup(); await h.user.click(screen.getByRole("button", { name: "Prepare browser task" }));
  await h.user.selectOptions(await screen.findByRole("combobox", { name: "Exact source plan" }), "plan-refund-one");
  await h.user.type(screen.getByRole("textbox", { name: "Reason" }), "Inspect original received goods");
  await h.user.click(screen.getByRole("button", { name: "Preview exact source plan" }));
  await waitFor(() => expect(h.writes).toHaveLength(1));
  expect(h.writes[0]).toMatchObject({ operation: "previewAction", actionKind: "previewFulfillmentDecision", expectedVersion: "source-v1", payload: { kind: "returnTask", targetRef: "return-source", planRef: "plan-refund-one", reason: "Inspect original received goods" } });
  const stored = sessionStorage.getItem(key)!;
  expect(stored).toContain("plan-refund-one"); expect(stored).not.toContain("Inspect original received goods"); expect(stored).not.toContain("reason");
});
it("looks up a pending original key after remount without replaying its preview", async () => {
  sessionStorage.setItem(key, JSON.stringify({ requestKey: "original-key", kind: "returnTask", targetRef: "return-source", planRef: "plan-refund-one", version: "source-v1" }));
  const h = setup(); await h.user.click(screen.getByRole("button", { name: "Prepare browser task" }));
  await screen.findByRole("button", { name: "Check original request" });
  expect(h.reads).toContainEqual({ kind: "returnTask", targetRef: "return-source", requestKey: "original-key" });
  expect(h.writes).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Retry original preview" })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("prepares inline with the same canonical plan selection and no dialog or automatic preview", async () => {
  const h = setup(true);
  await screen.findByLabelText("Exact source plan");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Disposition")).toBeVisible();
  expect(screen.getByLabelText("Resolution")).toBeVisible();
  expect(screen.getByLabelText("Reason")).toBeVisible();
  expect(screen.getByLabelText("Inspected quantity")).toBeVisible();
  expect(h.writes).toHaveLength(0);
  await h.user.selectOptions(screen.getByLabelText("Inspected quantity"), "1");
  await h.user.selectOptions(screen.getByLabelText("Disposition"), "quarantine");
  await h.user.selectOptions(screen.getByLabelText("Resolution"), "refund");
  await h.user.selectOptions(screen.getByLabelText("Exact source plan"), "plan-refund-one");
  await h.user.type(screen.getByLabelText("Reason"), "Inspected source return");
  await h.user.click(screen.getByRole("button", { name: "Preview exact source plan" }));
  await screen.findByRole("link", { name: "Review exact approval manifest" });
  expect(h.writes).toHaveLength(1);
  expect(JSON.stringify(sessionStorage)).not.toContain("Inspected source return");
});
