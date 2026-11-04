import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "./demoAdapter";
import { AdapterError } from "./errors";
import { BROWSER_OFFLINE, offlineError } from "./online";
import { useAction } from "./useAction";
import { useView } from "./useView";
import { renderRoute, renderWithAdapter } from "@/test/renderWithAdapter";

let online = true;
const setOnline = (value: boolean) => {
  online = value;
  act(() => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
};

beforeEach(() => {
  online = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
});
afterEach(() => {
  online = true;
});

function Probe() {
  const query = useView<Record<string, never>, unknown>("overviewSummary", {});
  return (
    <>
      <p data-testid="state">{query.isError ? `error:${(query.error as AdapterError).body.code}` : query.data ? "data" : "pending"}</p>
      <p data-testid="has-data">{query.data ? "yes" : "no"}</p>
    </>
  );
}

function Writer() {
  const action = useAction<object>();
  return (
    <>
      <button onClick={() => action.mutate({ operation: "controlRun", actionKind: "x", entityRefs: [], expectedVersion: "v", approvalRef: null, manifestRef: null, payload: {} })}>go</button>
      <p data-testid="write">{action.error instanceof AdapterError ? `${action.error.body.code}:${action.error.body.executionCertainty}` : action.isSuccess ? "ok" : "idle"}</p>
    </>
  );
}

describe("browser-offline state across the shared view layer (the -08 criteria)", () => {
  it("offlineError is an unavailable, retryable error that says nothing was sent", () => {
    const e = offlineError("r1");
    expect(e.category).toBe("unavailable");
    expect(e.body).toMatchObject({ code: BROWSER_OFFLINE, retryable: true, executionCertainty: "notApplied", requestId: "r1" });
    expect(e.message).toMatch(/offline/i);
  });

  it("a read made offline fails as offline without calling the adapter, and is not retried in a loop", async () => {
    setOnline(false);
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "readView");
    renderWithAdapter(<Probe />, adapter);
    expect(await screen.findByText(`error:${BROWSER_OFFLINE}`)).toBeInTheDocument();
    expect(screen.getByTestId("has-data")).toHaveTextContent("no");
    expect(spy).not.toHaveBeenCalled();
  });

  it("coming back online reloads the read", async () => {
    setOnline(false);
    const adapter = createDemoAdapter();
    renderWithAdapter(<Probe />, adapter);
    await screen.findByText(`error:${BROWSER_OFFLINE}`);
    setOnline(true);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("data"), { timeout: 4000 });
  });

  it("a write made offline is refused locally with 'not applied', and nothing reaches the adapter", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    renderWithAdapter(<Writer />, adapter);
    setOnline(false);
    await userEvent.setup().click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(screen.getByTestId("write")).toHaveTextContent(`${BROWSER_OFFLINE}:notApplied`));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the shell and pages say so when offline", () => {
  it("a page opened offline shows 'You're offline', the banner, and no demo data", async () => {
    setOnline(false);
    renderRoute("/overview", createDemoAdapter());
    expect(await screen.findByRole("heading", { name: "You're offline" })).toBeInTheDocument();
    expect(screen.getByTestId("offline-banner")).toHaveTextContent("nothing can be sent until you reconnect");
    expect(screen.queryByTestId("metric-orders")).not.toBeInTheDocument();
    expect(screen.queryByText(/\$12,596/)).not.toBeInTheDocument();
  });

  it("reconnecting removes the banner and loads the page", async () => {
    setOnline(false);
    renderRoute("/overview", createDemoAdapter());
    await screen.findByRole("heading", { name: "You're offline" });
    setOnline(true);
    await waitFor(() => expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("heading", { name: "You're offline" })).not.toBeInTheDocument(), { timeout: 4000 });
    expect(await screen.findByText(/\$12,596/, {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it("the offline banner is not shown while online", async () => {
    renderRoute("/overview", createDemoAdapter());
    await screen.findByRole("main");
    expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument();
  });

  it.each(["/orders/TEST-SH-1042", "/finance", "/creators/pipeline", "/inventory", "/automations", "/customers/lifecycle"])("%s says it's offline rather than loading forever", async (path) => {
    setOnline(false);
    renderRoute(path, createDemoAdapter());
    expect(await screen.findByRole("heading", { name: "You're offline" }, { timeout: 4000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/^Loading/)).not.toBeInTheDocument());
  });
});
