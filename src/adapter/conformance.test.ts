import { createDemoAdapter } from "./demoAdapter";
import { createLiveAdapter } from "./liveAdapter";
import { claimsSentWithoutReceipt, deepStrict, provenanceNodes, runAdapterConformance, runContractSchemaConformance, type ConformanceTarget } from "./conformance";
import { z } from "zod";
import { TransportFailure } from "./transport";
import { demoBackedTransport, failingTransport } from "./transportTestKit";

runContractSchemaConformance();

const demoScope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };

/** The demo adapter: every rule has a scenario except the one noted. */
const demo: ConformanceTarget = {
  name: "demo adapter",
  kind: "demo",
  environment: "demo",
  create: () => createDemoAdapter(),
  scope: demoScope,
  read: { viewKey: "overviewSummary" },
  canServeData: true,
  unauthenticated: () => createDemoAdapter({ fixture: "FX-09-expired-session" }),
  forbidden: () => createDemoAdapter({ fixture: "FX-08-forbidden-account" }),
  unavailable: () => createDemoAdapter({ fixture: "FX-07-offline-read" }),
  valueStates: {
    knownZero: { create: () => createDemoAdapter({ fixture: "FX-02-known-zero" }), read: { viewKey: "overviewSummary" } },
    unknown: { create: () => createDemoAdapter({ fixture: "FX-04-missing-metric" }), read: { viewKey: "customerJourney" } },
    notApplicable: { create: () => createDemoAdapter(), read: { viewKey: "orderDetail", filters: { orderId: "TEST-SC-0081" } } },
  },
  actions: {
    approvalRef: "demo-approval-exact",
    version: "v1",
    approvePayload: { decision: "approved" },
    altPayload: { decision: "rejected", reason: "conformance" },
    uncertainApprovalRef: "demo-approval-uncertain",
  },
  saves: { resourceKind: "evidenceDraft", resourceRef: "demo-evidence-1", version: "v1", changedPayload: { mediaUrl: null, checkoutRoute: "tiktok-shop", observations: [] } },
  gaps: {
    "PENDING-4": "FX-07 only fails reads. The demo adapter has no unavailable-backend scenario for actions or saves.",
  },
};

/**
 * The live adapter stub (THO-283). Its transport is not published, so every call fails with INTEGRATION_PENDING. The rules
 * that need an answer from a backend are pending until the real adapter plugs in. Nothing here is a weakened assertion.
 */
const noTransport = "THO-283 has not published a transport. The stub rejects every call with INTEGRATION_PENDING, so there is no response to check.";
const noSessionScenario = "No transport, so the stub cannot produce a 401 or 403 to check.";
const liveScope = { workspaceId: "w", accountIds: ["a"], environment: "sandbox" as const };
const live: ConformanceTarget = {
  name: "live adapter, default (pending) transport (sandbox)",
  kind: "live",
  environment: "sandbox",
  create: () => createLiveAdapter("sandbox"),
  scope: liveScope,
  read: { viewKey: "overviewSummary" },
  canServeData: false,
  unavailable: () => createLiveAdapter("sandbox"),
  unavailableWrites: () => createLiveAdapter("sandbox"),
  gaps: {
    "IDENT-2": noTransport,
    "SCOPE-READ-1": noTransport,
    "SCOPE-READ-2": noTransport,
    "SCOPE-READ-3": "The stub rejects before it checks scope. The real adapter must refuse a foreign environment as forbidden.",
    "SCOPE-READ-5": noTransport,
    "SCOPE-ACTION-1": noTransport,
    "SCOPE-ACTION-2": "The stub rejects before it checks scope. The real adapter must refuse a foreign environment as forbidden.",
    "SCOPE-SAVE-1": noTransport,
    ...Object.fromEntries(["accounts", "workspace", "principal"].flatMap((k) => [`KEY-2:${k}`, `KEY-2:${k}:keepPrevious`]).map((id) => [id, "The stub never returns data, so there is no earlier scope's data to leak."])),
    ...Object.fromEntries(["UNAUTHENTICATED", "SESSION_EXPIRED", "FORBIDDEN", "SOURCE_AUTHORITY_DENIED"].map((c) => [`AUTH-1:${c}`, "The stub never returns data, so there is nothing cached to clear."])),
    "AUTH-2": "The stub never returns data, so there is nothing cached to clear.",
    "AUTH-3": noSessionScenario,
    "VALUE-5": noTransport,
    "VALUE-6": noTransport,
    "VALUE-7": noTransport,
    "IDEM-1": noTransport,
    "IDEM-2": noTransport,
    "IDEM-3": noTransport,
    "IDEM-4": noTransport,
    "IDEM-5": noTransport,
    "VER-1": noTransport,
    "VER-2": noTransport,
    "SENT-1": noTransport,
    "SENT-2": noTransport,
    "SENT-3": noTransport,
    "SENT-4": noTransport,
  },
};

/**
 * The live adapter over an injected transport that round-trips the demo adapter's answers as JSON (THO-283, front-end half).
 * The failure scenarios use failing transports under the adapter's own error mapping; nothing about it is stubbed.
 * This proves the front end only. It says nothing about a real backend, which does not exist yet.
 */
const sandboxScope = { workspaceId: "w", accountIds: ["a"], environment: "sandbox" as const };
const viaDemo = (fixture?: Parameters<typeof createDemoAdapter>[0] extends infer O ? (O extends { fixture?: infer F } ? F : never) : never) =>
  createLiveAdapter("sandbox", { transport: demoBackedTransport(createDemoAdapter({ fixture })), retryDelayMs: 0 });
const failing = (make: () => TransportFailure) => () => createLiveAdapter("sandbox", { transport: failingTransport(make), retryDelayMs: 0 });
const http = (status: number) => () => new TransportFailure("http", { status });
const liveOverTransport: ConformanceTarget = {
  name: "live adapter over an injected transport (sandbox)",
  kind: "live",
  environment: "sandbox",
  create: () => viaDemo(),
  scope: sandboxScope,
  read: { viewKey: "overviewSummary" },
  canServeData: true,
  unauthenticated: failing(http(401)),
  forbidden: failing(http(403)),
  unavailable: failing(() => new TransportFailure("network")),
  // A refused connection never put the request on the wire, so nothing was applied.
  unavailableWrites: failing(() => new TransportFailure("network", { requestSent: false })),
  valueStates: {
    knownZero: { create: () => viaDemo("FX-02-known-zero"), read: { viewKey: "overviewSummary" } },
    unknown: { create: () => viaDemo("FX-04-missing-metric"), read: { viewKey: "customerJourney" } },
    notApplicable: { create: () => viaDemo(), read: { viewKey: "orderDetail", filters: { orderId: "TEST-SC-0081" } } },
  },
  actions: demo.actions,
  saves: demo.saves,
};

runAdapterConformance(demo);
runAdapterConformance(live);
runAdapterConformance(liveOverTransport);

describe("conformance helpers", () => {
  it("claimsSentWithoutReceipt flags a success with no receipt only", () => {
    expect(claimsSentWithoutReceipt({ state: "succeeded", receiptRefs: [] })).toBe(true);
    expect(claimsSentWithoutReceipt({ state: "partiallySucceeded", receiptRefs: [] })).toBe(true);
    expect(claimsSentWithoutReceipt({ state: "succeeded", receiptRefs: ["r"] })).toBe(false);
    expect(claimsSentWithoutReceipt({ state: "blocked", receiptRefs: [] })).toBe(false);
    expect(claimsSentWithoutReceipt({ state: "queued", receiptRefs: [] })).toBe(false);
  });
  it("deepStrict rejects unknown keys in nested objects, arrays and refined schemas", () => {
    const schema = z.object({ a: z.object({ b: z.number() }), list: z.array(z.object({ c: z.string() })) }).superRefine(() => undefined);
    const strict = deepStrict(schema);
    expect(strict.safeParse({ a: { b: 1 }, list: [{ c: "x" }] }).success).toBe(true);
    expect(strict.safeParse({ a: { b: 1, z: 1 }, list: [] }).success).toBe(false);
    expect(strict.safeParse({ a: { b: 1 }, list: [{ c: "x", z: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ a: { b: 1, z: 1 }, list: [] }).success).toBe(true);
  });
  it("provenanceNodes finds value nodes at any depth and nothing else", () => {
    const n = { state: "known", value: 0, reasonCode: null, evidenceRefs: [], observedAt: "t" };
    expect(provenanceNodes({ a: [{ b: n }], c: { state: "ready" } })).toEqual([n]);
  });
});
