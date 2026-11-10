import { webcrypto } from "node:crypto";
import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ScopeProvider } from "@/adapter/scope";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { newOfferTerms, offerRecordSchema } from "@/creator-agent/offers/contract";
import { offerScenario } from "@/creator-agent/offers/economics";
import { RecruitmentOfferTerms } from "./RecruitmentOfferTerms";

// This isolated async-boundary regression exercises the real query, scope and save hooks.
// Navigation confirmation is covered separately; these explicitly fictional DTOs grant no provider authority.
vi.mock("./RecruitmentLeaveGuard", () => ({ RecruitmentLeaveGuard: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const terms = newOfferTerms("fictional-creator", "website", "fictional-brief");
  return offerRecordSchema.parse({ kind: "agent-offer", offerId: "fictional-offer", version: "v1", revision: 1,
    recordedAt: "2026-11-09T00:00:00Z", manifestHash: "a".repeat(64), terms, assessment: null, assessmentCurrent: false,
    scenarios: [offerScenario(terms, "base"), offerScenario(terms, "downside")], provider: null, blockers: ["SOURCE_NOT_CONNECTED"],
    state: "proposed", ownerApprovalRef: null, acceptedRef: null, history: [], historyTotal: 0 });
}
function setup() {
  let release!: () => void;
  const digest = vi.fn(() => new Promise<ArrayBuffer>(resolve => { release = () => resolve(new Uint8Array(32).buffer); }));
  vi.stubGlobal("crypto", { randomUUID: () => webcrypto.randomUUID(), subtle: { digest } });
  const record = fixture(), writes: unknown[] = [];
  const adapter = createLiveAdapter("sandbox", { transport: { async send(request) {
    if (request.kind !== "read") { writes.push(request); throw new Error("No source effects in this boundary regression."); }
    return respondWith(request.envelope, record, { dataVersion: record.version, dataState: "partial",
      capabilities: [{ actionKind: "saveOfferDraft", state: "available", reasonCodes: [] }] });
  } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Harness() {
    const [sourceCurrent, setSourceCurrent] = useState(true), [accountId, setAccountId] = useState("fictional-account-a");
    return <QueryClientProvider client={client}><ScopeProvider adapter={adapter} principal="fictional-reviewer"
      scope={{ workspaceId: "fictional-workspace", accountIds: [accountId], environment: "sandbox" }}><MemoryRouter>
      <button onClick={() => setSourceCurrent(false)}>Withdraw source permission</button>
      <button onClick={() => setAccountId("fictional-account-b")}>Switch account</button>
      <RecruitmentOfferTerms offerId={record.offerId} creatorId={record.terms.creatorId} sourceCurrent={sourceCurrent} onVersion={() => undefined}/>
    </MemoryRouter></ScopeProvider></QueryClientProvider>;
  }
  render(<Harness/>);
  return { digest, writes, release: () => release() };
}
it.each(["Withdraw source permission", "Switch account"])("does not start an old save after %s during the digest await", async transition => {
  const w = setup(), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Save proposed terms" }));
  await waitFor(() => expect(w.digest).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: transition }));
  await act(async () => { w.release(); await Promise.resolve(); });
  expect(w.writes).toEqual([]);
  if (transition === "Withdraw source permission") expect(screen.getByRole("alert")).toHaveTextContent("No request was sent.");
  expect(screen.queryByText("Keep the original offer request. No terminal outcome has been verified.")).not.toBeInTheDocument();
});
it("starts exactly one local draft save after an unchanged digest, without dispatch", async () => {
  const w = setup(), user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Save proposed terms" }));
  await waitFor(() => expect(w.digest).toHaveBeenCalledOnce());
  await act(async () => { w.release(); await Promise.resolve(); });
  await waitFor(() => expect(w.writes).toHaveLength(1));
  expect(w.writes[0]).toMatchObject({ kind: "save", envelope: { operation: "saveResource", resourceKind: "actionDraft",
    resourceRef: "fictional-offer", expectedVersion: "v1" } });
});
