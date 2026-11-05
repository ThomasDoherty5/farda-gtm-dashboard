// @vitest-environment jsdom
import { transferableAbortController } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runAdapterConformance, type ConformanceTarget } from "@/adapter/conformance";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { createHttpTransport } from "@/adapter/httpTransport";
import { startReferenceServer, type ReferenceServer } from "./server";
import { defaultUsers } from "./users";
import { cookieFetch, freshState, liveOverHttp } from "./testKit";

/**
 * The conformance suite from PR #44, run against createLiveAdapter + createHttpTransport over real HTTP to the reference
 * server on an ephemeral port. This proves the front end's HTTP path against a TEST DOUBLE, distinct from the actual
 * creator-agent service's integration checks.
 */
let server: ReferenceServer;
let narrow: ReferenceServer;
const browserAbortController = globalThis.AbortController;
// React needs jsdom, but HTTP uses Node's native fetch. Node 24 rejects a jsdom AbortSignal by brand.
// Use its native controller in this suite so real cancellation is retained, rather than dropping the signal.
const nodeAbortController = transferableAbortController().constructor as typeof AbortController;
beforeAll(async () => {
  vi.stubGlobal("AbortController", nodeAbortController);
  // Grants wide enough for the scope-switching rules, which ask for other workspaces and accounts a real grant would name.
  const wide = defaultUsers().map((u) => ({ ...u, grants: [{ workspaceId: "demo-workspace", accountIds: ["demo-account-farda", "acct-1", "acct-2", "acct-other", "extra"] }, { workspaceId: "workspace-other", accountIds: ["demo-account-farda"] }] }));
  server = await startReferenceServer({ users: wide });
  // A second server whose users hold no grant for the demo account: the forbidden-account scenario.
  narrow = await startReferenceServer({ users: [{ id: "ref-founder", displayName: "Reference Founder", role: "founder", grants: [{ workspaceId: "someone-elses-workspace", accountIds: ["theirs"] }] }] });
});
afterAll(async () => {
  try { await Promise.all([server.close(), narrow.close()]); }
  finally { vi.stubGlobal("AbortController", browserAbortController); }
});

it("native HTTP accepts the suite's abort signal and still rejects an aborted request", async () => {
  const request = cookieFetch(server.url, { user: "founder", state: freshState("abort") });
  expect((await request(`${server.url}/v1/session`, { signal: new AbortController().signal })).status).toBe(200);
  const controller = new AbortController();
  controller.abort();
  await expect(request(`${server.url}/v1/session`, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
});

const scope = { workspaceId: "demo-workspace", accountIds: ["demo-account-farda"], environment: "sandbox" as const };
const as = (user: string, fixture?: string) => () => liveOverHttp(server, { user, state: freshState("c"), ...(fixture ? { fixture } : {}) });

const target: ConformanceTarget = {
  name: "live adapter over HTTP to the reference server (a test double)",
  kind: "live",
  environment: "sandbox",
  create: as("founder"),
  scope,
  read: { viewKey: "overviewSummary" },
  canServeData: true,
  // No cookie: the server answers 401 and the adapter clears protected data.
  unauthenticated: () => createLiveAdapter("sandbox", { transport: createHttpTransport(server.url, { fetch: cookieFetch(server.url, {}) }), retryDelayMs: 0 }),
  forbidden: () => liveOverHttp(narrow, { user: "founder", state: freshState("n") }),
  // Nothing listens on port 1, so the connection is refused before anything is sent.
  unavailable: () => createLiveAdapter("sandbox", { transport: createHttpTransport("http://127.0.0.1:1"), retryDelayMs: 0 }),
  unavailableWrites: () => createLiveAdapter("sandbox", { transport: createHttpTransport("http://127.0.0.1:1"), retryDelayMs: 0 }),
  valueStates: {
    knownZero: { create: as("founder", "FX-02-known-zero"), read: { viewKey: "overviewSummary" } },
    unknown: { create: as("founder", "FX-04-missing-metric"), read: { viewKey: "customerJourney" } },
    notApplicable: { create: as("founder"), read: { viewKey: "orderDetail", filters: { orderId: "TEST-SC-0081" } } },
  },
  actions: {
    approvalRef: "demo-approval-exact",
    version: "v1",
    approvePayload: { decision: "approved" },
    altPayload: { decision: "rejected", reason: "conformance" },
    uncertainApprovalRef: "demo-approval-uncertain",
  },
  saves: { resourceKind: "evidenceDraft", resourceRef: "demo-evidence-1", version: "v1", changedPayload: { mediaUrl: null, checkoutRoute: "tiktok-shop", observations: [] } },
  knownFailures: {
    "SENT-4": "D-12: an uncertain write is never a 2xx. The server answers 502 OUTCOME_UNCERTAIN, so the adapter rejects instead of resolving a response with state outcomeUncertain. SENT-5 checks the decided behavior.",
  },
};

runAdapterConformance(target);
