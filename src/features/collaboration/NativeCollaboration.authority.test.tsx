import { webcrypto } from "node:crypto";
import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { respondWith } from "@/adapter/demoViews";
import { SCHEMA_VERSION, type ActionResponse } from "@/adapter/contract";
import { ScopeProvider } from "@/adapter/scope";
import { SourceReadGrant } from "@/components/SourceReadGrant";
import { collaborationSnapshot } from "@/creator-agent/collaborationWorkflowFixtures";
import { nativeCollaborationSchema } from "@/creator-agent/collaborationWorkflowSchema";
import { renderWithAdapter, scopeFor } from "@/test/renderWithAdapter";
import { NativeCollaboration } from "./NativeCollaboration";

vi.mock("@/components/LeaveGuard", () => ({ LeaveGuard: () => null }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });
function harness(id: string) {
  let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
  let release!: (value: ArrayBuffer) => void;
  const digest = vi.fn(() => new Promise<ArrayBuffer>(resolve => { release = resolve; }));
  vi.stubGlobal("crypto", { randomUUID: () => webcrypto.randomUUID(), subtle: { digest } });
  const fixture = collaborationSnapshot();
  const data = nativeCollaborationSchema.parse({
    ...Object.fromEntries(Object.entries(fixture).filter(([key]) => !["scope", "id", "assetBindings"].includes(key))),
    kind: "source-collaboration", collaborationRef: fixture.id, actorRef: "agent-reviewer", stale: false,
    proposalReconciliation: null, proposals: [], proposalTotal: 0, readAccess: { validUntil: new Date(clock + 60_000).toISOString() },
  });
  const adapter = createDemoAdapter(), submit = vi.spyOn(adapter, "submitAction");
  const res = respondWith({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "collaborationDetail", requestedScope: scopeFor(),
    filters: { collaborationId: data.collaborationRef }, period: null, sort: [], page: { limit: 50, cursor: null }, requestId: id }, data,
    { dataVersion: "collaboration-v1", capabilities: [{ actionKind: "proposeCollaborationReview", state: "available", reasonCodes: [] }] });
  function Harness() {
    const [changed, change] = useState(false), [account, setAccount] = useState(id);
    return <><button onClick={() => change(true)}>Replace collaboration source</button><button onClick={() => setAccount(id + "-other")}>Change account</button>
      <ScopeProvider adapter={adapter} scope={scopeFor("demo", [account])} principal="tester">
        <SourceReadGrant validUntil={data.readAccess?.validUntil} title="Collaboration evidence" refresh={() => {}}>
          <NativeCollaboration data={changed ? { ...data, sourceRevision: "source-v2" } : data} res={changed ? { ...res, dataVersion: "collaboration-v2" } : res}
            tab="content" openEvidence={() => {}} reload={async () => ({ isSuccess: true, data: res })} />
        </SourceReadGrant>
      </ScopeProvider></>;
  }
  const rendered = renderWithAdapter(<Harness />, adapter);
  return { ...rendered, digest, submit, release: () => release(new ArrayBuffer(32)), expire: () => {
    clock += 60_001; fireEvent(window, new Event("focus"));
  } };
}
async function prepareRevision() {
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Request revision" }));
  const form = within(screen.getByRole("dialog", { name: "Request revision" }));
  await user.type(form.getByLabelText("Reason"), "Fictional revision rationale");
  await user.click(form.getByRole("button", { name: "Save proposal for approval" }));
}
it.each(["expiry", "source", "scope"])("does not send an unsent collaboration proposal when %s changes during hashing", async change => {
  const h = harness("collaboration-digest-" + change); await prepareRevision();
  expect(h.digest).toHaveBeenCalledOnce(); expect(h.submit).not.toHaveBeenCalled();
  if (change === "expiry") { act(h.expire); expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); }
  else fireEvent.click(screen.getByRole("button", { name: change === "source" ? "Replace collaboration source" : "Change account" }));
  await act(async () => { h.release(); });
  expect(h.submit).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0); h.client.clear();
});
it("preserves the original collaboration marker after a sent request outlives its grant", async () => {
  const h = harness("collaboration-sent-expiry"); let reject!: (error: Error) => void;
  h.submit.mockImplementation(() => new Promise<ActionResponse>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  await prepareRevision(); await act(async () => { h.release(); });
  await waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
  const request = h.submit.mock.calls[0]![0], stored = sessionStorage.getItem(sessionStorage.key(0)!);
  expect(stored).toContain(request.idempotencyKey); expect(stored).not.toContain("Fictional revision rationale");
  act(h.expire); await act(async () => { reject(new Error("Fictional lost acknowledgment")); });
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(stored); expect(h.submit).toHaveBeenCalledOnce(); h.client.clear();
});
