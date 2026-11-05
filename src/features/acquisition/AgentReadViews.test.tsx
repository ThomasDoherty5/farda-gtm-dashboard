import { screen, within } from "@testing-library/react";
import type { ReadResponse } from "@/adapter/contract";
import { viewSchemas } from "@/adapter/viewSchemas";
import type { AgentAssessmentRecord, AgentModelSummary, AgentSourcingData } from "@/creator-agent/readViews";
import { syntheticAgentEvidence, syntheticQualification } from "@/test/creatorQualification";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";
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
    records: empty ? [] : [{ creatorId, runId, evidenceId: noEvidence ? null : saved.evidenceId, briefId: saved.qualification.briefId, checkoutRoute: "website", state: "hold", recordedAt: saved.recordedAt, revision: 1, stale: false }],
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
    await screen.findByRole("heading", { name: "Saved creator sourcing" });
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
});
