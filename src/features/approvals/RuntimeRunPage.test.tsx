import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FardaAdapter } from "@/adapter/adapter";
import { SCHEMA_VERSION, type ReadRequest } from "@/adapter/contract";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { AdapterError } from "@/adapter/errors";
import { safeRuntimeRunSchema } from "@/creator-agent/jobs/runtimeViews";
import { renderRoute } from "@/test/renderWithAdapter";

const runRef = "rt-run-syntheticOpaqueRun";
function fixture() {
  const data = safeRuntimeRunSchema.parse({ kind: "registered-runtime-run", source: "native-runtime", environment: "sandbox", runRef,
    registrationRef: "rt-registration-syntheticOpaqueRegistration", registrationVersion: 3, family: "J08", mode: "observe", state: "partial", control: "active",
    intendedAt: "2026-11-07T11:00:00Z", windowStart: "2026-11-07T11:00:00Z", windowEnd: "2026-11-07T12:00:00Z", observedAt: "2026-11-07T12:00:00Z",
    delayMs: 3_600_000, sourceCoverage: "partial", sourceObservedAt: "2026-11-07T12:00:00Z", sourceFresh: true, sourceReceiptAlias: "evidence-" + "a".repeat(64),
    counts: { total: 1, due: 0, deferred: 0, leased: 0, held: 0, completed: 1, cancelled: 0, failed: 0, reconcile: 0, reused: 0 }, hasContinuation: true,
    executionCertainty: "applied", blockers: [], nextAction: "Complete the current page, then continue this source window.",
    items: [{ itemRef: "rt-item-syntheticOpaqueItem", state: "completed", attempts: 1, steps: 1, dueAt: "2026-11-07T12:00:00Z", checkpointVersion: 1,
      hasCursor: true, retainedEvidenceRefs: 1, result: "observationRecorded", reasonCode: null }], takeovers: [],
    usage: { invocations: { directApi: 0, mcp: 0, model: 0, browser: 1 }, pendingInvocations: 0, measuredRuntimeMs: 124,
      ordinaryZapTasks: null, mcpTasks: null, modelTokens: null, observedCostMinor: null, currency: null, costCoverage: "unknown", runtimeCost: "unknown",
      receiptAliases: [], coverage: "instrumented-invocations-only" } });
  let denied = false, actions = 0;
  const adapter: FardaAdapter = { ...createDemoAdapter(), environment: "sandbox", kind: "live",
    readView: (async (request: ReadRequest<unknown>) => {
      if (denied) throw new AdapterError({ code: "FORBIDDEN", message: "Access is not currently permitted.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
      return { schemaVersion: SCHEMA_VERSION, requestId: request.requestId, scope: { workspaceId: "w", accountIds: ["a"], environment: "sandbox", authorizationScopeVersion: "synthetic-ui-scope" },
        dataVersion: "synthetic-run-v3", dataState: "partial", data, sourceFreshness: [], coverage: { expectedCount: null, observedCount: 1, missingCount: null, complete: false, reasonCodes: ["RUNTIME_WINDOW_PARTIAL"] },
        capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } };
    }) as FardaAdapter["readView"], submitAction: async () => { actions++; throw new Error("Read-only evidence cannot dispatch"); } };
  return { data, adapter, deny: () => { denied = true; }, actions: () => actions };
}
afterEach(cleanup);
describe("registered runtime run evidence", () => {
  it("routes an opaque registered run without a demo monitor fallback and separates measured zero from unknown billing", async () => {
    const f = fixture(); renderRoute(`/runs/${runRef}`, f.adapter);
    expect(await screen.findByRole("heading", { name: "Registered source run" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Registered work items" })).toHaveTextContent("Observation recorded");
    expect(screen.getByText("Partial · total unknown")).toBeInTheDocument();
    expect(screen.getByText("Continuation remains")).toBeInTheDocument();
    const pairs = (label: string) => screen.getByText(label).parentElement!;
    expect(pairs("Direct API invocations")).toHaveTextContent("0");
    expect(pairs("Browser invocations")).toHaveTextContent("1");
    expect(pairs("Ordinary Zapier tasks")).toHaveTextContent("Unknown");
    expect(pairs("Model tokens")).toHaveTextContent("Unknown");
    expect(pairs("Total runtime cost")).toHaveTextContent("Unknown");
    expect(f.actions()).toBe(0);
  });
  it("keeps source takeover owned and recovery cannot click into fresh dispatch", async () => {
    const f = fixture(); f.data.takeovers = [{ itemRef: f.data.items[0]!.itemRef, version: 2, kind: "mfa", ownerAlias: "owner-" + "b".repeat(64), resolved: false }];
    renderRoute(`/runs/${runRef}?tab=recovery`, f.adapter);
    await screen.findByRole("heading", { name: "Resume from verified evidence." });
    expect(screen.getByText("mfa")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Resume source work" });
    expect(button).toHaveAccessibleDescription(/source owner must supply the current authority receipt/);
    await userEvent.click(button); expect(f.actions()).toBe(0);
    expect(screen.queryByRole("button", { name: /fresh attempt|approve|publish|purchase/i })).not.toBeInTheDocument();
  });
  it("clears protected runtime evidence when current named-person authority is denied", async () => {
    const f = fixture(); renderRoute(`/runs/${runRef}?tab=approval`, f.adapter);
    await screen.findByRole("heading", { name: "Measured usage and unknown costs" });
    f.deny(); await userEvent.click(screen.getByRole("button", { name: "Refresh run evidence" }));
    await waitFor(() => expect(screen.queryByRole("table", { name: "Registered work items" })).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Measured usage and unknown costs" })).not.toBeInTheDocument();
    expect(f.actions()).toBe(0);
  });
});
