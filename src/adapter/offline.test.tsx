import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { scriptedAdapter, testClient } from "@/test/renderWithAdapter";
import type { ActionResponse, ReadRequest, ReadResponse, RequestedScope } from "./contract";
import { AdapterError } from "./errors";
import { scopeKey, ScopeProvider } from "./scope";
import { useAction } from "./useAction";
import { useSave } from "./useSave";
import { useView } from "./useView";

const scope: RequestedScope = { workspaceId: "w", accountIds: ["a"], environment: "demo" };

const response = (request: ReadRequest<unknown>, data: unknown): ReadResponse<unknown> => ({
  schemaVersion: request.schemaVersion,
  requestId: request.requestId,
  scope: { ...request.requestedScope, authorizationScopeVersion: "1" },
  dataVersion: "1",
  dataState: "ready",
  data,
  sourceFreshness: [],
  coverage: { expectedCount: null, observedCount: null, missingCount: null, complete: null, reasonCodes: [] },
  capabilities: [],
  page: { nextCursor: null, hasMore: false },
  refresh: { nextPollAfterMs: null },
});

/** The browser's own events, which is what TanStack's online manager listens to. */
const goOffline = () => act(() => void window.dispatchEvent(new Event("offline")));
const goOnline = () => act(() => void window.dispatchEvent(new Event("online")));

function View() {
  const q = useView<object, number>("view", {});
  return <p data-testid="data">{q.data ? String(q.data.data) : q.isPending ? "pending" : "none"}</p>;
}

function Writes() {
  const action = useAction<{ n: number }>();
  const save = useSave<{ n: number }, unknown>();
  return (
    <>
      <button onClick={() => action.mutate({ operation: "decideApproval", actionKind: "decideApproval", entityRefs: [], expectedVersion: "1", approvalRef: "ap", manifestRef: null, payload: { n: 1 } })}>act</button>
      <button onClick={() => save.mutate({ resourceKind: "actionDraft", resourceRef: null, expectedVersion: null, payload: { n: 1 } })}>save</button>
      <p data-testid="action">{action.isSuccess ? "success" : action.error ? `${(action.error as AdapterError).body.code}/${(action.error as AdapterError).body.executionCertainty}` : "idle"}</p>
      <p data-testid="save">{save.isSuccess ? "success" : save.error ? (save.error as AdapterError).body.code : "idle"}</p>
    </>
  );
}

function mount(adapter: ReturnType<typeof scriptedAdapter>, ui: React.ReactNode, client = testClient()) {
  render(
    <QueryClientProvider client={client}>
      <ScopeProvider adapter={adapter} scope={scope} principal="p"><MemoryRouter>{ui}</MemoryRouter></ScopeProvider>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe("browser offline state", () => {
  it("states the figures are as of the last read, keeps them (zero stays zero), then clears and refetches on reconnect", async () => {
    let value = 0;
    const adapter = scriptedAdapter(async (request) => response(request, value));
    mount(adapter, <><ConnectionStatus /><View /></>);
    const status = screen.getByTestId("connection-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toBeEmptyDOMElement();
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("0"));

    await goOffline();
    expect(status).toHaveTextContent("You're offline");
    expect(status).toHaveTextContent("as of the last successful read");
    expect(status).toHaveTextContent("may be stale");
    expect(screen.getByTestId("data")).toHaveTextContent("0"); // a known zero is still a zero, and nothing was reread
    expect(adapter.calls).toHaveLength(1);

    value = 7;
    await goOnline();
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("7"));
    expect(adapter.calls).toHaveLength(2);
    expect(status).toBeEmptyDOMElement();
  });

  it("does not present unread data as current, and does not invent a zero, when nothing was read yet", async () => {
    onlineManager.setOnline(false);
    const adapter = scriptedAdapter(async (request) => response(request, 5));
    mount(adapter, <><ConnectionStatus /><View /></>);
    expect(screen.getByTestId("connection-status")).toHaveTextContent("No figures have loaded yet");
    expect(screen.getByTestId("data")).toHaveTextContent("pending");
    expect(adapter.calls).toHaveLength(0);
    await goOnline();
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("5"));
  });

  it("fails an action and a save as not sent while offline, never as success, and never reaches the adapter", async () => {
    const adapter = scriptedAdapter(async (request) => response(request, 1));
    const submit = vi.spyOn(adapter, "submitAction");
    const saveSpy = vi.spyOn(adapter, "saveResource");
    mount(adapter, <Writes />);
    await goOffline();
    await act(async () => screen.getByText("act").click());
    await act(async () => screen.getByText("save").click());
    await waitFor(() => expect(screen.getByTestId("action")).toHaveTextContent("OFFLINE_NOT_SENT/notApplied"));
    expect(screen.getByTestId("save")).toHaveTextContent("OFFLINE_NOT_SENT");
    expect(submit).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("reuses the idempotency key when the same action is retried after reconnecting", async () => {
    const uuid = vi.spyOn(crypto, "randomUUID");
    const keys: string[] = [];
    const adapter = scriptedAdapter(async (request) => response(request, 1));
    adapter.submitAction = async (request) => {
      keys.push(request.idempotencyKey);
      return { state: "accepted" } as unknown as ActionResponse;
    };
    mount(adapter, <Writes />);
    await goOffline();
    await act(async () => screen.getByText("act").click());
    await waitFor(() => expect(screen.getByTestId("action")).toHaveTextContent("OFFLINE_NOT_SENT"));
    expect(uuid).toHaveBeenCalledTimes(1);
    const offlineKey = uuid.mock.results[0]!.value as string;
    await goOnline();
    await act(async () => screen.getByText("act").click());
    await waitFor(() => expect(keys).toHaveLength(1));
    expect(keys[0]).toBe(offlineKey);
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it.each(["FORBIDDEN", "SESSION_EXPIRED"])("clears protected data on %s when the reconnect refetch is denied", async (code) => {
    const adapter = scriptedAdapter(async (request, call) => {
      if (call === 1) return response(request, "secret" as unknown as number);
      throw new AdapterError({ code, message: code, requestId: null, correlationId: null, retryable: false, retryAfterMs: null });
    });
    const client = mount(adapter, <View />);
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("secret"));
    await goOffline();
    expect(screen.getByTestId("data")).toHaveTextContent("secret"); // offline alone does not clear or deny anything
    await goOnline();
    await waitFor(() => expect(screen.getByTestId("data")).not.toHaveTextContent("secret"));
    expect(JSON.stringify(client.getQueryCache().findAll().map((q) => q.state.data))).not.toContain("secret");
  });

  it("keeps the full scope in every query key while offline and after reconnecting", async () => {
    const adapter = scriptedAdapter(async (request) => response(request, 1));
    const client = mount(adapter, <View />);
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("1"));
    await goOffline();
    await goOnline();
    const root = scopeKey({ principal: "p", scope });
    await waitFor(() => expect(adapter.calls).toHaveLength(2));
    for (const q of client.getQueryCache().findAll()) expect(q.queryKey.slice(0, root.length)).toEqual([...root]);
  });
});
