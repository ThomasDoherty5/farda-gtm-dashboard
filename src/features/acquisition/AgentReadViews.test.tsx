import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReadRequest, ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { viewSchemas } from "@/adapter/viewSchemas";
import type { AgentAssessmentRecord, AgentModelSummary, AgentSourcingData } from "@/creator-agent/readViews";
import { syntheticAgentEvidence, syntheticQualification } from "@/test/creatorQualification";
import { renderRoute, scriptedAdapter, testClient } from "@/test/renderWithAdapter";
import { discoveryDemo } from "@/fixtures/discovery";

const creatorId = "saved creator";
const runId = "saved run";
const assessmentPath = "/creators/saved%20creator/assessments/saved%20run";
const evidencePath = "/creators/saved%20creator/evidence/synthetic-post-1";

function assessment(stale = false): AgentAssessmentRecord {
  const original = syntheticQualification({
    creatorId, state: "hold", contentQualification: "hold",
    config: { status: "bound", version: "synthetic-saved-v1", hash: "synthetic-config-hash", baselineHash: "synthetic-baseline-hash", numericHash: "synthetic-numeric-hash" },
    configuration: {
      criteria: [{ id: "synthetic-routine", label: "Synthetic routine", weight: 43, rating: 0 }, { id: "synthetic-demo", label: "Synthetic demonstration", weight: 57, rating: null }],
      bands: [{ id: "synthetic-review", min: 0 }], arithmetic: "weight*rating/5;round-complete-total;no-rescaling",
    },
    criteria: { routine: 0, demo: null },
  });
  return {
    kind: "creator-v3", creatorId, assessmentId: runId, runId,
    evidenceId: stale ? null : "synthetic-post-1",
    qualification: stale ? { ...original, state: "reviewNeeded", reasonCodes: ["SUPERSEDED"] } : original,
    assessedQualification: original, agentEvidence: syntheticAgentEvidence({ creatorId }),
    recordedAt: "2026-11-04T12:00:00.000Z", revision: 1, stale, superseded: stale,
  };
}

function sourcing({ empty = false, noEvidence = false } = {}): AgentSourcingData {
  const saved = assessment();
  const website: AgentModelSummary = {
    modelId: "WEBSITE-AFFILIATE-v3", status: "bound", configVersion: "synthetic-current-v2", configHash: "synthetic-current-hash",
    baselineHash: "synthetic-baseline-hash", numericHash: "synthetic-numeric-hash",
    criteria: saved.qualification.configuration!.criteria.map(({ id, label, weight }) => ({ id, label, weight })),
    bands: saved.qualification.configuration!.bands, arithmetic: saved.qualification.configuration!.arithmetic,
    decisionRules: { invitationMinScore: null, activationMinScore: 80, minCoveragePct: 0 },
  };
  return {
    kind: "agent-sourcing", policyVersion: "2026-11-04", agentVersion: "1.0.0", agentSchemaVersion: "creator-agent.v1",
    records: empty ? [] : [{ creatorId, runId, evidenceId: noEvidence ? null : saved.evidenceId, briefId: saved.qualification.briefId, checkoutRoute: "website", state: "hold", recordedAt: saved.recordedAt, revision: 1, stale: false, superseded: false }],
    models: [website, { modelId: "TIKTOK-SHOP-AFFILIATE-v3", status: "unbound", configVersion: null, configHash: null, baselineHash: null, numericHash: null, criteria: null, bands: null, arithmetic: null, decisionRules: null }],
    total: empty ? 0 : 1, partial: false,
  };
}

const adapterFor = (data: AgentSourcingData | AgentAssessmentRecord | typeof discoveryDemo) => {
  return scriptedAdapter(async (request): Promise<ReadResponse<unknown>> => ({
    schemaVersion: request.schemaVersion,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "synthetic-read-scope-v1" },
    dataVersion: "synthetic-read-v1",
    dataState: "ready",
    data,
    sourceFreshness: [],
    coverage: { expectedCount: 1, observedCount: 1, missingCount: 0, complete: true, reasonCodes: [] },
    capabilities: [],
    page: { nextCursor: null, hasMore: false },
    refresh: { nextPollAfterMs: null },
  }), "live");
};

const page = (id: string) => document.querySelector(`section[aria-labelledby="${id}"]`)! as HTMLElement;
const expectNoFixtureLinks = (element: HTMLElement) => {
  expect([...element.querySelectorAll("a")].map((link) => link.getAttribute("href")).filter((href) => /demo-/i.test(href ?? ""))).toEqual([]);
};

function sourcingPage(request: ReadRequest<unknown>, offset: number, count: number, total: number, nextCursor: string | null, id = "synthetic-snapshot", recordStart = offset): ReadResponse<AgentSourcingData> {
  const base = sourcing();
  const records = Array.from({ length: count }, (_, index) => ({ ...base.records[0]!, creatorId: `paged-creator-${recordStart + index}`, runId: `paged-run-${recordStart + index}`, evidenceId: `paged-post-${recordStart + index}` }));
  return {
    schemaVersion: request.schemaVersion, requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "synthetic-read-scope-v1" },
    dataVersion: `${id}-${offset}`, dataState: total > count ? "partial" : "ready",
    data: { ...base, records, total, partial: total > count, snapshot: { id, asOf: "2026-11-04T12:00:00.000Z", expiresAt: "2026-11-04T12:15:00.000Z", offset, limit: request.page.limit, returnedCount: count, total } },
    sourceFreshness: [], coverage: { expectedCount: total, observedCount: count, missingCount: total - count, complete: total === count, reasonCodes: [] },
    capabilities: [], page: { nextCursor, hasMore: nextCursor !== null }, refresh: { nextPollAfterMs: null },
  };
}

const readFailure = (code: string) => new AdapterError({ code, message: code, requestId: null, correlationId: null, retryable: false, retryAfterMs: null });

describe("actual agent sourcing and saved assessments", () => {
  it("registers current read schemas without rejecting historical demo contracts", () => {
    expect(viewSchemas.discoverySummary!.safeParse(sourcing()).success).toBe(true);
    expect(viewSchemas.discoverySummary!.safeParse(discoveryDemo).success).toBe(true);
    expect(viewSchemas.assessmentRecord!.safeParse(assessment()).success).toBe(true);
    expect(viewSchemas.assessmentRecord!.safeParse({ ...assessment(), assessmentId: "another run" }).success).toBe(false);
    expect(viewSchemas.discoverySummary!.safeParse({ ...sourcing(), total: 2, partial: false }).success).toBe(false);
  });

  it("shows actual creator/run links and independent current models without synthetic batch or editable weights", async () => {
    renderRoute("/creators/discovery", adapterFor(sourcing()));
    // The first lazy route can need a cold module transform on a constrained worker.
    await screen.findByRole("heading", { name: "Saved creator sourcing" }, { timeout: 5_000 });
    const scope = within(page("discovery-title"));
    expect(scope.getByRole("link", { name: "View assessment" })).toHaveAttribute("href", assessmentPath);
    expect(scope.getByRole("link", { name: "Review source evidence" })).toHaveAttribute("href", evidencePath);
    expect(scope.getByRole("link", { name: "Video evidence" })).toHaveAttribute("href", evidencePath);
    expect(scope.getByRole("region", { name: "Current criterion weights WEBSITE-AFFILIATE-v3" })).toHaveTextContent("43%");
    expect(scope.getByRole("region", { name: "Current criterion weights WEBSITE-AFFILIATE-v3" }).querySelector("input,select,textarea,button")).toBeNull();
    expect(scope.getByText("synthetic-current-v2", { exact: false })).toBeInTheDocument();
    expect(scope.queryByText("Preview the boundaries before approving.")).not.toBeInTheDocument();
    expectNoFixtureLinks(page("discovery-title"));
  });

  it("does not invent an evidence link for an empty current sourcing result", async () => {
    renderRoute("/creators/discovery", adapterFor(sourcing({ empty: true })));
    await screen.findByRole("heading", { name: "No saved creators yet" });
    const scope = within(page("discovery-title"));
    expect(scope.getByRole("button", { name: "Review evidence" })).toHaveAttribute("aria-disabled", "true");
    expect(scope.getByRole("button", { name: "Video evidence" })).toHaveAccessibleDescription(/Choose a saved source/);
    expect(scope.queryByRole("link", { name: "View assessment" })).not.toBeInTheDocument();
    expectNoFixtureLinks(page("discovery-title"));
  });

  it("keeps the saved assessment link when a sourcing record has no current evidence address", async () => {
    renderRoute("/creators/discovery", adapterFor(sourcing({ noEvidence: true })));
    await screen.findByRole("heading", { name: "Saved creator sourcing" });
    const scope = within(page("discovery-title"));
    expect(scope.getByRole("link", { name: "View assessment" })).toHaveAttribute("href", assessmentPath);
    expect(scope.queryByRole("link", { name: "Review source evidence" })).not.toBeInTheDocument();
    expect(scope.getByRole("button", { name: "Video evidence" })).toHaveAttribute("aria-disabled", "true");
    expectNoFixtureLinks(page("discovery-title"));
  });

  it("keeps a saved assessment's weights and unknowns read-only and uses its exact run identity", async () => {
    const adapter = adapterFor(assessment());
    renderRoute(assessmentPath, adapter);
    await screen.findByRole("heading", { name: "Saved assessment" });
    const scope = within(page("assessment-title"));
    expect(adapter.calls.find((call) => call.viewKey === "assessmentRecord")?.filters).toEqual({ creatorId, assessmentId: runId });
    expect(scope.getByRole("link", { name: "Review source evidence" })).toHaveAttribute("href", evidencePath);
    expect(scope.getByRole("region", { name: "Saved criterion weights" })).toHaveTextContent("43%");
    expect(scope.getByRole("region", { name: "Saved criterion weights" })).toHaveTextContent("Unknown");
    expect(scope.getByRole("region", { name: "Saved criterion weights" }).querySelector("input,select,textarea,button")).toBeNull();
    expect(scope.getByRole("region", { name: "Critical content ratings" })).toHaveTextContent("0 / 5");
    expect(scope.getByText(/Comment questions, prompted replies/)).toBeInTheDocument();
    expectNoFixtureLinks(page("assessment-title"));
  });

  it("separates a superseded decision from effective review-needed readiness and never links it to a newer packet", async () => {
    renderRoute(assessmentPath, adapterFor(assessment(true)));
    await screen.findByRole("heading", { name: "Saved assessment" });
    const scope = within(page("assessment-title"));
    expect(scope.getByText("This run has been superseded")).toBeInTheDocument();
    expect(within(scope.getByTestId("agent-qualification")).getByText("Review needed", { exact: false })).toBeInTheDocument();
    expect(scope.getByText("Original as-assessed decision: Hold")).toBeInTheDocument();
    expect(scope.queryByRole("link", { name: "Review source evidence" })).not.toBeInTheDocument();
    expectNoFixtureLinks(page("assessment-title"));
  });

  it("does not expose synthetic batch or evidence links when a live source returns only the legacy plan shape", async () => {
    renderRoute("/creators/discovery", adapterFor(discoveryDemo));
    await screen.findByRole("heading", { name: "Saved sourcing records unavailable" });
    expect(screen.queryByRole("link", { name: "Open sample batch" })).not.toBeInTheDocument();
    expectNoFixtureLinks(page("discovery-title"));
  });

  it("loads all 201 creators through opaque cursors without duplicates and distinguishes page coverage from the accumulated snapshot", async () => {
    const adapter = scriptedAdapter(async (request) => {
      const offset = request.page.cursor === null ? 0 : Number(request.page.cursor.slice("opaque-".length));
      const count = Math.min(request.page.limit, 201 - offset);
      return sourcingPage(request, offset, count, 201, offset + count < 201 ? `opaque-${offset + count}` : null);
    }, "live");
    renderRoute("/creators/discovery", adapter);
    await screen.findByText("Showing 50 of 201 saved creators. This is a partial list.");
    const user = userEvent.setup();
    for (const count of [100, 150, 200, 201]) {
      await user.click(screen.getByRole("button", { name: "Load more creators" }));
      await screen.findByText(`Showing ${count} of 201 saved creators. ${count === 201 ? "All saved creators in this snapshot are loaded." : "This is a partial list."}`);
    }
    const scope = within(page("discovery-title"));
    expect(scope.getAllByRole("link", { name: "View assessment" })).toHaveLength(201);
    expect(new Set(scope.getAllByRole("link", { name: "View assessment" }).map((link) => link.getAttribute("href"))).size).toBe(201);
    expect(scope.getAllByRole("link", { name: "View assessment" }).at(-1)).toHaveAttribute("href", "/creators/paged-creator-200/assessments/paged-run-200");
    expect(scope.queryByRole("button", { name: "Load more creators" })).not.toBeInTheDocument();
    expect(adapter.calls.map((call) => call.page)).toEqual([null, "opaque-50", "opaque-100", "opaque-150", "opaque-200"].map((cursor) => ({ cursor, limit: 50 })));
    expectNoFixtureLinks(page("discovery-title"));
  });

  it("keeps loaded rows during a next-page error and retries the same opaque cursor without repeating rows", async () => {
    const adapter = scriptedAdapter(async (request, call) => {
      if (request.page.cursor === null) return sourcingPage(request, 0, 1, 2, "opaque-next");
      if (call === 2) throw readFailure("SOURCE_UNAVAILABLE");
      return sourcingPage(request, 1, 1, 2, null);
    }, "live");
    renderRoute("/creators/discovery", adapter);
    await screen.findByText("Showing 1 of 2 saved creators. This is a partial list.");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more creators" }));
    await screen.findByRole("heading", { name: "Data unavailable" });
    expect(screen.getByRole("link", { name: "View assessment" })).toHaveAttribute("href", "/creators/paged-creator-0/assessments/paged-run-0");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Showing 2 of 2 saved creators. All saved creators in this snapshot are loaded.");
    expect(screen.getAllByRole("link", { name: "View assessment" })).toHaveLength(2);
    expect(adapter.calls.map((call) => call.page.cursor)).toEqual([null, "opaque-next", "opaque-next"]);
  });

  it.each(["CURSOR_EXPIRED", "CURSOR_SNAPSHOT_UNAVAILABLE", "CURSOR_STALE", "INVALID_CURSOR"])("starts a fresh snapshot after %s instead of repeatedly replaying the rejected cursor", async (code) => {
    const adapter = scriptedAdapter(async (request, call) => {
      if (call === 1) return sourcingPage(request, 0, 1, 2, "opaque-expiring");
      if (request.page.cursor !== null) throw readFailure(code);
      return sourcingPage(request, 0, 1, 1, null, "synthetic-fresh-snapshot", 7);
    }, "live");
    renderRoute("/creators/discovery", adapter);
    await screen.findByRole("button", { name: "Load more creators" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more creators" }));
    await screen.findByText(/The saved queue snapshot is no longer available/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "View assessment" })).toHaveAttribute("href", "/creators/paged-creator-7/assessments/paged-run-7"));
    expect(screen.getAllByRole("link", { name: "View assessment" })).toHaveLength(1);
    expect(adapter.calls.map((call) => call.page.cursor)).toEqual([null, "opaque-expiring", null]);
  });

  it.each(["SESSION_EXPIRED", "FORBIDDEN"])("clears every loaded sourcing page after %s", async (code) => {
    const adapter = scriptedAdapter(async (request) => {
      if (request.page.cursor === null) return sourcingPage(request, 0, 1, 2, "opaque-next");
      throw readFailure(code);
    }, "live");
    const client = testClient();
    renderRoute("/creators/discovery", adapter, client);
    await screen.findByRole("button", { name: "Load more creators" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more creators" }));
    await screen.findByRole("heading", { name: code === "SESSION_EXPIRED" ? "Sign in again" : "No access to this account" });
    expect(screen.queryByRole("link", { name: "View assessment" })).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().findAll().map((query) => query.state.data))).not.toContain("paged-creator-");
  });

  it("does not silently combine pages from different snapshots", async () => {
    const adapter = scriptedAdapter(async (request) => request.page.cursor === null
      ? sourcingPage(request, 0, 1, 2, "opaque-next")
      : sourcingPage(request, 1, 1, 2, null, "synthetic-other-snapshot"), "live");
    renderRoute("/creators/discovery", adapter);
    await screen.findByRole("button", { name: "Load more creators" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more creators" }));
    await screen.findByRole("heading", { name: "Saved queue snapshot mismatch" });
    expect(screen.queryByRole("link", { name: "View assessment" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh queue" })).toBeInTheDocument();
  });

  it("shows a superseded snapshot run as review-needed and preserves its exact assessment link without newer evidence navigation", async () => {
    const adapter = scriptedAdapter(async (request) => {
      const response = sourcingPage(request, 0, 1, 1, null);
      response.data!.records[0] = { ...response.data!.records[0]!, state: "reviewNeeded", stale: true, superseded: true, evidenceId: null };
      return response;
    }, "live");
    renderRoute("/creators/discovery", adapter);
    await screen.findByText("Review needed · superseded");
    expect(screen.getByRole("link", { name: "View assessment" })).toHaveAttribute("href", "/creators/paged-creator-0/assessments/paged-run-0");
    expect(screen.queryByRole("link", { name: "Review source evidence" })).not.toBeInTheDocument();
  });

  it("blocks duplicate load-more clicks while the next page is pending", async () => {
    let finish: (() => void) | undefined;
    const adapter = scriptedAdapter(async (request) => {
      if (request.page.cursor === null) return sourcingPage(request, 0, 1, 2, "opaque-next");
      return new Promise((resolve) => { finish = () => resolve(sourcingPage(request, 1, 1, 2, null)); });
    }, "live");
    renderRoute("/creators/discovery", adapter);
    const button = await screen.findByRole("button", { name: "Load more creators" });
    const user = userEvent.setup();
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    await user.click(button);
    expect(adapter.calls).toHaveLength(2);
    await act(async () => finish?.());
    await screen.findByText("Showing 2 of 2 saved creators. All saved creators in this snapshot are loaded.");
  });
});
