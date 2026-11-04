import type { FardaAdapter, ReadOptions } from "./adapter";
import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse, type SaveResourceRequest, type SaveResourceResponse } from "./contract";
import { createDemoEvidence } from "./demoEvidence";
import { createDemoApprovals } from "./demoApprovals";
import { createDemoPolicy } from "./demoPolicy";
import { guardTermsOf } from "./commissionPolicy";
import { createDemoLifecycle } from "./demoLifecycle";
import { createDemoFinance } from "./demoFinance";
import { createDemoOps } from "./demoOps";
import { createDemoDiscovery } from "./demoDiscovery";
import { createDemoReconciliation } from "./demoReconciliation";
import { isAnalyticsView, readAnalyticsView } from "./demoAnalytics";
import { isMonitorView, readMonitorView, retryMonitorProfile } from "./demoMonitor";
import { createDemoOffers, readAssessment, readRewards } from "./demoScorecards";
import { createDemoBatch } from "./demoBatch";
import { COMMANDS, createDemoCollaboration } from "./demoCollaboration";
import { readCreatorsView } from "./demoCreators";
import { createDemoSettings } from "./demoSettings";
import { respondWith } from "./demoViews";
import { branchesDemo } from "@/fixtures/pipelineBranches";
import { discoveryDemo } from "@/fixtures/discovery";
import { filterRecruitment, invitationDemo, RECRUITMENT_DEFAULT, type RecruitmentData } from "@/fixtures/recruitment";
import { DEFAULT_PIPELINE_FILTERS, filterPipeline, type PipelineFilters } from "@/fixtures/pipeline";
import { AdapterError } from "./errors";
import { DEMO_NOW, overviewOriginal, type OverviewData, type OverviewFixtureKey } from "@/fixtures/overview";

/**
 * Deterministic demo adapter. Frozen clock, environment "demo", no network, no provider dispatch.
 * Approvals run on an in-memory state machine with labeled synthetic receipts (see demoApprovals).
 * Overview capabilities report "unverified" so nothing can look sent or paid.
 */
export function createDemoAdapter(opts: { fixture?: OverviewFixtureKey; latencyMs?: number; actorRole?: string } = {}): FardaAdapter {
  const fixture = opts.fixture ?? "FX-01-happy-read";
  const latencyMs = opts.latencyMs ?? 0;
  /**
   * The policy guard runs inside the approval service, after its stored-result replay, so a retry of a dispatch that
   * already succeeded gets its original receipt even when the policy has since changed.
   */
  const approvals = createDemoApprovals({
    actorRole: opts.actorRole,
    beforeDispatch: (request) => policy.guardApprovedDispatch(request),
    onApproved: (ref) => policy.recordApproval(ref),
  });
  /** Terms of an approval for the policy guard. Throws when it can't be read, and the guard then refuses. */
  const approvalTerms = (ref: string) => {
    const v = approvals.peekApproval(ref, "policy-guard");
    const latest = v.versions.at(-1)!;
    return guardTermsOf({ policyVersion: latest.policyVersion, requiredRole: v.requiredRole, terms: latest.payload.terms });
  };
  const policy = createDemoPolicy({ termsOf: approvalTerms, actorRole: opts.actorRole });
  const evidence = createDemoEvidence();
  const ops = createDemoOps({ actorRole: opts.actorRole });
  const finance = createDemoFinance();
  const offers = createDemoOffers();
  const batch = createDemoBatch();
  const discovery = createDemoDiscovery();
  const collaboration = createDemoCollaboration();
  const settings = createDemoSettings();
  const lifecycle = createDemoLifecycle();
  const reconciliation = createDemoReconciliation();

  return {
    environment: "demo",
    kind: "demo",
    async readView<F, T>(request: ReadRequest<F>, options?: ReadOptions): Promise<ReadResponse<T>> {
      if (request.requestedScope.environment !== "demo")
        throw new AdapterError({ code: "FORBIDDEN", message: "Demo adapter only serves the demo environment.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
      await wait(latencyMs, options?.signal);
      if (request.viewKey === "nightlyReconciliation") return reconciliation.read(request) as ReadResponse<T>;
      const settingsView = settings.read(request);
      if (settingsView) return settingsView as ReadResponse<T>;
      const lifecycleView = lifecycle.read(request);
      if (lifecycleView) return lifecycleView as ReadResponse<T>;
      if (request.viewKey === "approvalDetail") return approvals.readApproval(request as ReadRequest<{ approvalId: string }>) as ReadResponse<T>;
      if (request.viewKey === "runDetail") return approvals.readRun(request as ReadRequest<{ runId: string }>) as ReadResponse<T>;
      if (request.viewKey === "evidenceRecord") return evidence.read(request as ReadRequest<{ creatorId: string; evidenceId: string }>) as ReadResponse<T>;
      const opsView = ops.read(request);
      if (opsView) return opsView as ReadResponse<T>;
      const financeView = finance.read(request);
      if (financeView) return financeView as ReadResponse<T>;
      if (request.viewKey === "discoverySummary")
        return respondWith(request, discoveryDemo, { dataVersion: "discovery-demo@1", capabilities: [{ actionKind: "startLiveDiscovery", state: "unverified", reasonCodes: ["SOURCE_ACCESS_UNVERIFIED"] }, { actionKind: "requestBatchApproval", state: "available", reasonCodes: [] }] }) as ReadResponse<T>;
      if (isMonitorView(request.viewKey)) return readMonitorView<T>(request, fixture);
      if (request.viewKey === "assessmentRecord") return readAssessment<T>(request as ReadRequest<{ creatorId: string; assessmentId: string }>, fixture);
      if (request.viewKey === "offerRewards") return readRewards<T>(request as ReadRequest<{ offerId: string; scenario?: string }>, fixture);
      if (request.viewKey === "offerDraft") return offers.read<T>(request as ReadRequest<{ offerId: string }>, fixture);
      if (isAnalyticsView(request.viewKey)) return readAnalyticsView<T>(request, fixture);
      if (request.viewKey === "pipelineSummary") {
        const data = filterPipeline(pipelineFilters(request.filters, request.requestId));
        return respondWith(request, data, { dataVersion: "pipeline-demo@2", dataState: data.sources.length ? "ready" : "empty" }) as ReadResponse<T>;
      }
      if (request.viewKey === "pipelineBranches") {
        const source = (request.filters as { source?: string } | null)?.source ?? "both";
        if (!["both", "social-cat", "tiktok-shop"].includes(source)) err("VALIDATION_FAILED", "source must be one of both, social-cat, tiktok-shop.", request.requestId);
        return respondWith(request, { ...branchesDemo, sources: branchesDemo.sources.filter((s) => source === "both" || s.source === source) }, { dataVersion: "pipeline-branches-demo@1" }) as ReadResponse<T>;
      }
      if (request.viewKey === "collaborationDetail") return collaboration.read(request) as ReadResponse<T>;
      if (request.viewKey === "batchDetail") return batch.read(request) as ReadResponse<T>;
      if (request.viewKey === "recruitmentQueue") return respondWith(request, filterRecruitment(recruitmentFilters(request.filters, request.requestId)), { dataVersion: "recruitment-demo@1" }) as ReadResponse<T>;
      if (request.viewKey === "invitationDraft") return respondWith(request, invitationDemo, { dataVersion: "invitation-demo@1", capabilities: [{ actionKind: "sendInvitation", state: "unverified", reasonCodes: ["SOURCE_ACCESS_UNVERIFIED"] }] }) as ReadResponse<T>;
      const creators = readCreatorsView(request);
      if (creators) return creators as ReadResponse<T>;
      if (request.viewKey !== "overviewSummary")
        throw new AdapterError({ code: "INTEGRATION_PENDING", message: `No demo fixture for view ${request.viewKey}.`, requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
      return overviewResponse(request, fixture) as ReadResponse<T>;
    },
    async submitAction<P>(request: ActionRequest<P>, options?: ReadOptions): Promise<ActionResponse> {
      if (request.requestedScope.environment !== "demo")
        throw new AdapterError({ code: "FORBIDDEN", message: "Demo adapter only serves the demo environment.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
      requireIdempotencyKey(request);
      await wait(latencyMs, options?.signal);
      if (reconciliation.handles(request)) return reconciliation.submit(request as ActionRequest<never>);
      const settingsAction = settings.submit(request);
      if (settingsAction) return settingsAction;
      const opsResult = ops.submit(request);
      if (opsResult) return opsResult;
      const financeResult = finance.submit(request);
      if (financeResult) return financeResult;
      if (discovery.handles(request)) return discovery.submit(request as ActionRequest<never>);
      if (policy.handles(request)) return policy.submit(request);
      if (request.actionKind === "retryMonitorProfile") return retryMonitorProfile(request as ActionRequest<{ profile: string }>);
      if (COMMANDS.includes(request.actionKind)) return collaboration.submit(request);
      if (request.actionKind === "pauseBatch" || request.actionKind === "cancelUnsent" || request.actionKind === "decideTikTokSample") return batch.submit(request);
      return approvals.submit(request);
    },
    async saveResource<P, T>(request: SaveResourceRequest<P>, options?: ReadOptions): Promise<SaveResourceResponse<T>> {
      if (request.requestedScope.environment !== "demo")
        throw new AdapterError({ code: "FORBIDDEN", message: "Demo adapter only serves the demo environment.", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
      requireIdempotencyKey(request);
      await wait(latencyMs, options?.signal);
      if (settings.handlesSave(request)) return settings.save(request) as Promise<SaveResourceResponse<T>>;
      if (lifecycle.handlesSave(request)) return lifecycle.save(request) as Promise<SaveResourceResponse<T>>;
      if (request.resourceKind === "actionDraft") return offers.save(request as unknown as SaveResourceRequest<never>) as unknown as Promise<SaveResourceResponse<T>>;
      return evidence.save(request as unknown as SaveResourceRequest<never>) as unknown as Promise<SaveResourceResponse<T>>;
    },
  };
}

/** A write with no idempotency key can't be retried safely, so it is refused before anything is applied. */
function requireIdempotencyKey(request: { idempotencyKey: string; requestId: string }) {
  if (typeof request.idempotencyKey === "string" && request.idempotencyKey.trim() !== "") return;
  throw new AdapterError({ code: "VALIDATION_FAILED", message: "A write needs an idempotency key. Nothing was applied.", requestId: request.requestId, correlationId: `demo-${request.requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", fieldErrors: { idempotencyKey: "An idempotency key is required." } });
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

const RECRUITMENT_FACETS = { networks: ["both", "instagram", "tiktok"], route: ["queue", "inbound", "outbound"] } as const;

/** Only allowed facet values are accepted; an unknown one is a validation error, not a silent default. */
function recruitmentFilters(raw: unknown, requestId: string): RecruitmentData["filters"] {
  const given = (raw ?? {}) as Partial<Record<keyof RecruitmentData["filters"], string>>;
  const out = { ...RECRUITMENT_DEFAULT } as Record<string, string>;
  for (const key of Object.keys(RECRUITMENT_FACETS) as (keyof typeof RECRUITMENT_FACETS)[]) {
    const value = given[key] ?? out[key]!;
    if (!(RECRUITMENT_FACETS[key] as readonly string[]).includes(value)) err("VALIDATION_FAILED", `${key} must be one of ${RECRUITMENT_FACETS[key].join(", ")}.`, requestId);
    out[key] = value;
  }
  return out as RecruitmentData["filters"];
}

const PIPELINE_FACETS: { [K in keyof PipelineFilters]: readonly string[] } = {
  source: ["both", "social-cat", "tiktok-shop"],
  route: ["outbound", "inbound"],
  network: ["all", "instagram", "tiktok"],
  checkout: ["all", "website", "tiktok-shop"],
  window: ["sep-oct", "sep", "oct"],
  policy: ["all", "policy-2026-09", "policy-2026-10"],
};

/** Only allowed facet values are accepted; an unknown one is a validation error, not a silent default. */
function pipelineFilters(raw: unknown, requestId: string): PipelineFilters {
  const given = (raw ?? {}) as Partial<Record<keyof PipelineFilters, string>>;
  const filters = { ...DEFAULT_PIPELINE_FILTERS } as Record<keyof PipelineFilters, string>;
  for (const key of Object.keys(PIPELINE_FACETS) as (keyof PipelineFilters)[]) {
    const value = given[key] ?? filters[key];
    if (!PIPELINE_FACETS[key].includes(value)) err("VALIDATION_FAILED", `${key} must be one of ${PIPELINE_FACETS[key].join(", ")}.`, requestId);
    filters[key] = value;
  }
  return filters as PipelineFilters;
}

function err(code: string, message: string, requestId: string): never {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: code === "SOURCE_UNAVAILABLE", retryAfterMs: null });
}

function overviewResponse<F>(request: ReadRequest<F>, fixture: OverviewFixtureKey): ReadResponse<OverviewData> {
  const base: ReadResponse<OverviewData> = {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    dataVersion: "overview-original@1",
    dataState: "ready",
    data: overviewOriginal,
    sourceFreshness: [
      {
        sourceRef: overviewOriginal.orders.sourceRef!,
        lastSourceSuccessAt: DEMO_NOW,
        observedAt: DEMO_NOW,
        mirroredAt: DEMO_NOW,
        staleReasonCode: null,
      },
    ],
    coverage: { expectedCount: 5, observedCount: 5, missingCount: 0, complete: true, reasonCodes: [] },
    capabilities: [{ actionKind: "requestReport", state: "unverified", reasonCodes: ["DEMO_NO_DISPATCH"] }],
    page: { nextCursor: null, hasMore: false },
    refresh: { nextPollAfterMs: null },
  };
  const d = overviewOriginal;
  switch (fixture) {
    case "FX-01-happy-read":
      return base;
    case "FX-02-known-zero":
      return { ...base, data: { ...d, attributedOrders: { ...d.attributedOrders, value: 0 }, attributedNetSales: { ...d.attributedNetSales, value: { minorUnits: 0, currency: "USD" } } } };
    case "FX-03-empty-filter":
      return { ...base, dataState: "empty", data: null, coverage: { ...base.coverage, expectedCount: 0, observedCount: 0 } };
    case "FX-04-missing-metric":
      return { ...base, data: { ...d, posts: d.posts.map((p) => ({ ...p, shares: null })) } };
    case "FX-05-partial-coverage":
      return { ...base, dataState: "partial", data: { ...d, posts: d.posts.slice(0, 3) }, coverage: { expectedCount: 5, observedCount: 3, missingCount: 2, complete: false, reasonCodes: ["SOURCE_ROWS_DEFERRED"] } };
    case "FX-06-stale-source":
      return { ...base, dataState: "stale", sourceFreshness: base.sourceFreshness.map((f) => ({ ...f, lastSourceSuccessAt: "2026-10-30T09:00:00.000Z", staleReasonCode: "SOURCE_SYNC_DELAYED" })) };
    case "FX-07-offline-read":
      return err("SOURCE_UNAVAILABLE", "The data service could not be reached.", request.requestId);
    case "FX-08-forbidden-account":
      return err("FORBIDDEN", "You do not have access to this account.", request.requestId);
    case "FX-09-expired-session":
      return err("SESSION_EXPIRED", "Your session expired. Sign in again.", request.requestId);
  }
}
