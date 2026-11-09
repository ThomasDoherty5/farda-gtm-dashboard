import { ReportError } from "./slackReporting/contract.ts";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { evidencePacketSchema } from "./evidence.ts";
import { digest, type ConfigBinding } from "./config.ts";
import { AGENT_SCHEMA_VERSION, POLICY_VERSION, AGENT_VERSION } from "./assessmentSchema.ts";
import { assessCreator, MODEL_FOR_ROUTE } from "./policy.ts";
import { ratingPolicy } from "./ratingPolicy.ts";
import { AgentStore, AgentConflict } from "./store.ts";
import type { StoredAssessment } from "./store.ts";
import { PortfolioRepository, type PortfolioDecisionAuthority } from "./portfolioStore.ts";
import { handlePortfolioRoute } from "./portfolioRoutes.ts";
import { AssetRepository } from "./assetStore.ts";
import { handleAssetRoute } from "./assetRoutes.ts";
import type { AssetAuthority } from "./assets.ts";
import { agentAssessmentRecordSchema, agentSourcingSchema, nativeRecruitmentViewSchema } from "./readViews.ts";
import { createOperations, operationsErrorStatus, safeOperationsProjection, OPERATIONS_SCHEMA_VERSION, type OperationsOptions } from "./operations.ts";
import { createCollaborationEvidenceReader } from "./collaborationEvidenceReader.ts";
import { AssetRegistryReadError, type NotionDriveAssetConfig, type AssetRegistryQuery, type AssetRegistryPage } from "./notionDriveAssetSource.ts";
import { readOperationsView, operationsViewFiltersSchema, OperationsCursorError } from "./operationsViewReader.ts";
import { ScheduleDraftRepository, ScheduleDraftError } from "./scheduleDrafts.ts";
import { loadOperationsSecret } from "./operationsSecret.ts";
import { createProviderHealth, type HealthOptions } from "./providerHealth.ts";
import { EvidenceReviewRepository, EvidenceReviewError } from "./evidenceReviewStore.ts";
import { createCollaborationWorkflow, CollaborationWorkflowError } from "./collaborationWorkflow.ts";
import type { CollaborationSourceReader } from "./collaborationWorkflowSchema.ts";
import { openCollaborationRef } from "./creatorPlatformReferences.ts";
import { creatorPlatformKeys, creatorPlatformFilterSchema, readCreatorPlatformView } from "./creatorPlatformReader.ts";
import { protectCommentAuthors } from "./evidencePrivacy.ts";

import { OfferRepository, type OfferAuthority } from "./offers/repository.ts";
import { handleOfferRoute } from "./offers/routes.ts";
import { OfferPolicyError } from "./offers/policy.ts";
import type { CommercialPolicySource } from "./commercialPolicy/contract.ts";
import { withCommercialOffers } from "./commercialPolicy/approvalGuard.ts";
import { createCommercialProjection, CommercialProjectionError, type CommercialProjection } from "./commercialPolicy/projection.ts";
import { createRecruitmentSourceReader, recruitmentFiltersSchema, RecruitmentSourceError, type RecruitmentSource } from "./commercialPolicy/recruitment.ts";
import { IntakeRepository, type IntakeAuthority } from "./intake/repository.ts";
import { handleIntakeRoute } from "./intake/routes.ts";
import { RewardRedemptionRepository, type RewardAuthority } from "./rewards/repository.ts";
import { handleRewardRoute } from "./rewards/routes.ts";
import { createRewardDomainBridge, type RewardRegistration } from "./rewards/approvalBridge.ts";
import type { RewardDomainSource } from "./rewards/canonicalContract.ts";
import { routeId as offerIdSchema, type AssessmentBasis } from "./offers/contract.ts";
import { FunnelRepository, FunnelError, type FunnelAuthority } from "./funnelStore.ts";
import { funnelFilterSchema } from "./funnelContract.ts";
import { readScorecardPreview, scorecardPreviewFilters } from "./scorecardPreview.ts";
import { createMediaComposition, type MediaComposition, type MediaDomainBindings } from "./mediaComposition.ts";
import { createMediaResources } from "./mediaResources.ts";
import { isScorecardProofExpired, resolveScorecardEvidence, type ScorecardAuthority } from "./routeEvidence.ts";
import { createStockSupportWorkflow, StockSupportError, type StockSupportSource } from "./stockSupport.ts";
import { inventoryFilters, supportFilters, transferIntent, handoffIntent } from "./stockSupportSchema.ts";
import { createMonitorReader, MonitorError, monitorViewKeys, monitorFilters, type MonitorSourceReader } from "./monitor/reader.ts";
import { createShippingHubReader, ShippingHubReadError, type ShippingHubSource } from "./shippingHubRead.ts";
import { createLifecycleService } from "./lifecycle/repository.ts";
import { lifecycleViewKeys, lifecycleFilters, flowResourceSchema } from "./lifecycle/contract.ts";
import { LifecycleError, type LifecycleSourceReader } from "./lifecycle/source.ts";
import { createFulfillmentDomain } from "./fulfillmentDomain/service.ts";
import { fulfillmentFilters, fulfillmentPreviewAction, FulfillmentError } from "./fulfillmentDomain/contract.ts";
import type { FulfillmentBindings } from "./fulfillmentDomain/source.ts";
import { createSettlementReader } from "./settlements/reader.ts";
import { settlementViews, settlementFilters, SettlementError } from "./settlements/contract.ts";
import type { SettlementBindings } from "./settlements/source.ts";
import { createSettlementActionDomain, settlementLedgerSource } from "./settlements/proposalBridge.ts";
import { boundedSourceRead } from "./actions/readBoundary.ts";
import { ledgerExportRequestFilters, ledgerExportArtifactFilters, ledgerExportArtifactViewSchema } from "./actions/exportViews.ts";
import { createFinanceReader, FinanceError } from "./finance/reader.ts";
import { financeViewKeys, financeFilters, isFinanceViewKey } from "./finance/contract.ts";
import type { FinanceSourceReader } from "./finance/source.ts";
import { createOperationsReadReader, OperationsReadError } from "./operationsReads/reader.ts";
import { operationsReadViewKeys, operationsReadFilters, isOperationsReadViewKey } from "./operationsReads/contract.ts";
import type { OperationsReadSourceReader } from "./operationsReads/source.ts";
import { createTeamInvitationReadReader, TeamInvitationReadError } from "./teamInvitationReads/reader.ts";
import { teamInvitationReadViewKeys, teamInvitationReadFilters, isTeamInvitationReadViewKey } from "./teamInvitationReads/contract.ts";
import type { TeamInvitationReadSourceReader } from "./teamInvitationReads/source.ts";
import { createOperationsControls, OperationsControlError, type OperationsControlSource } from "./operationsControls.ts";
import { operationsControlAction, operationsControlFilters, operationsHealthAction, operationsCanonicalAction } from "./operationsControlsSchema.ts";
import { createOperationsControlAuthority, OperationsAuthorityError, type OperationsControlAuthoritySource } from "./operationsControlAuthority.ts";
import { createOperationsControlBridge, type OperationsCanonicalSource, type OperationsCanonicalKind, type OperationsOwnerRegistration } from "./operationsControlBridge.ts";
import { createOperationsControlServiceReaders } from "./operationsControlServices.ts";
import { createActionFoundation, assertMachineTokens, type ActionFoundationBindings } from "./actionFoundation.ts";
import { foundationActionSchema, domainActionSchema } from "./actions/wire.ts";
import { ActionServiceError } from "./actions/contract.ts";
import { ApprovalError } from "./approvals/contract.ts";
import { DispatchError } from "./jobs/dispatchSchema.ts";
import { apiRequestKind } from "./apiRequestLimits.ts";
import { apiErrorEnvelope } from "./apiErrorEnvelope.ts";
import { composeActionDomains } from "./actionDomains.ts";
import { createBulkService, type BulkServiceOptions } from "./bulk/service.ts";
import { BulkError, bulkReadFiltersSchema } from "./bulk/contract.ts";
import { createSiteTrafficService, type SiteTrafficServiceOptions } from "./siteTraffic/service.ts";
import { trafficFiltersSchema } from "./siteTraffic/contract.ts";
import { SiteTrafficError } from "./siteTraffic/source.ts";
import { createSiteTrafficImportApi, SiteTrafficApiError, type SiteTrafficImportMachine } from "./siteTrafficApi.ts";
import { assertBulkRuntimeRegistration, findBulkGroupManifest } from "./bulkRuntime.ts";
import { createRecruitmentService, type RecruitmentServiceOptions } from "./recruitment/service.ts";
import { InvitationDraftRepository } from "./recruitment/drafts.ts";
import { RecruitmentError } from "./recruitment/source.ts";
import { invitationFiltersSchema, invitationSaveSchema, recruitmentBatchFiltersSchema } from "./recruitment/contract.ts";
import { JobRuntime } from "./jobs/runtime.ts";
import { RuntimeError, type RuntimeAuthority, type RuntimeRegistry } from "./jobs/runtimeSchema.ts";
import { createRuntimeApi, RuntimeApiError, runtimeApiCommandSchema, type RuntimeMachineBinding } from "./jobs/runtimeApi.ts";
import { createNativeSourcingReader, NativeSourcingError } from "./sourcing/nativeReader.ts";
import { SOURCING_PLAN_VIEW, sourcingPlanFilters } from "./sourcing/contract.ts";
import type { NativeSourcingSource } from "./sourcing/nativeSource.ts";
import { nativeAnalyticsFilters, analyticsPeriodSchemaNative, nativeAnalyticsViewKeys } from "./analytics/contract.ts";
import { createNativeAnalyticsReader, NativeAnalyticsError } from "./analytics/nativeReader.ts";
import type { NativeAnalyticsSource } from "./analytics/nativeSource.ts";

const ADAPTER_SCHEMA = "2026-11-02.proposed";
const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const versionOfData = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const CURSOR_TTL_MS = 15 * 60_000;
class InvalidCursor extends Error {}
const cursorPayloadSchema = z.object({
  version: z.literal(1), workspaceId: z.string(), accountId: z.string(), environment: z.literal("sandbox"), contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotId: z.string().uuid(), asOf: z.string().datetime({ offset: true }), expiresAt: z.number().int().nonnegative().safe(),
  rowId: z.number().int().positive().safe(), anchorRunId: z.string().min(1), total: z.number().int().positive().safe(),
  offset: z.number().int().positive().safe(), limit: z.number().int().min(1).max(100),
  after: z.object({ recordedAt: z.string().datetime({ offset: true }), runId: z.string().min(1) }).strict(),
}).strict();
type Role = "reader" | "reviewer";
type Session = { role: Role; csrf: string; expiresAt: number };
export type AgentServerOptions = { databasePath: string; readToken: string; reviewToken: string; workspaceId: string; accountId: string; bindings?: ConfigBinding[]; secureCookies?: boolean; publicOrigin?: string; assetAuthority?: AssetAuthority; portfolioAuthority?: PortfolioDecisionAuthority; operations?: OperationsOptions; providerHealth?: HealthOptions;
  scorecardAuthority?: ScorecardAuthority; funnelAuthority?: FunnelAuthority; offerAuthority?: Omit<OfferAuthority, "assessment">;
  collaborationSourceReader?: CollaborationSourceReader; intakeAuthority?: IntakeAuthority; rewardAuthority?: RewardAuthority;
  stockSupportSource?: StockSupportSource;
  monitorSource?: MonitorSourceReader;
  lifecycleSource?: LifecycleSourceReader;
  shippingHubSource?: ShippingHubSource;
  /** Source-owned fulfillment plans and canonical owners; unset grants no proposal or provider authority. */
  fulfillment?: Omit<FulfillmentBindings,"authority">;
  /** Server-only accounting/provider readers. Unset means finance reads remain unavailable, never fixture-backed. */
  settlements?: Omit<SettlementBindings,"authority">;
  financeSource?: FinanceSourceReader;
  /** Server-only order, shipping and returns reader for the THO-301 operations views. Unset means every such read is INTEGRATION_PENDING. */
  operationsReadSource?: OperationsReadSourceReader;
  operationsReadPermittedLinkOrigins?: readonly string[];
  /** Server-only provider role register and TikTok invitation draft reader for teamPermissions and invitationDraft. Unset means both are INTEGRATION_PENDING. */
  teamInvitationReadSource?: TeamInvitationReadSourceReader;
  operationsControlSource?: OperationsControlSource;
  operationsControlAuthority?: OperationsControlAuthoritySource;
  operationsCanonical?: {source:OperationsCanonicalSource;owners:ReadonlyMap<OperationsCanonicalKind,OperationsOwnerRegistration>};
  sourcingPlanSource?: NativeSourcingSource;
  /** Exact principal/window-bound aggregate owners; customerJourney remains owned by siteTraffic. */
  analyticsSource?: NativeAnalyticsSource;
  /** One source supplies current acquisition policy and historical earned reward terms. No request body can adopt it. */
  commercialPolicy?: CommercialPolicySource;
  recruitmentSource?: RecruitmentSource;
  /** Current source-owned recruitment catalog; absence never supplies demo data or send authority. */
  recruitmentWorkspace?: Pick<RecruitmentServiceOptions, "source" | "invitationOwner" | "permittedLinkOrigins">;
  /** Finite source-owned J13 sets and exact compiled domain owners. No default source or activation. */
  bulkWorkspace?: Pick<BulkServiceOptions, "source" | "owners">;
  /** Qualified aggregate owners and a separate machine importer. Unset keeps the actual import pending. */
  siteTraffic?: Pick<SiteTrafficServiceOptions, "source" | "orders" | "clicks"> & { machine?: SiteTrafficImportMachine };
  rewardDomain?: { source: RewardDomainSource; registration: RewardRegistration };
  mediaDomain?: MediaDomainBindings;
  actionFoundation?: ActionFoundationBindings;
  runtime?: { registry: RuntimeRegistry; authority?: RuntimeAuthority; machine?: RuntimeMachineBinding };
  assetRegistryReader?: (scope: NotionDriveAssetConfig["scope"], query: AssetRegistryQuery) => Promise<AssetRegistryPage> };
const writeSchema = z.object({ expectedVersion: z.number().int().nonnegative(), policyVersion: z.literal(POLICY_VERSION), configHash: z.string().nullable(), packet: evidencePacketSchema }).strict();

/** First real agent service; independent of all demo adapters and reference-server fixtures. */
export function createAgentServer(options: AgentServerOptions) {
  if (options.readToken.length < 32 || options.reviewToken.length < 32 || safeEqual(options.readToken, options.reviewToken)) throw new Error("Two distinct server-only tokens of at least 32 characters are required");
  if (!options.workspaceId || !options.accountId) throw new Error("Explicit workspace and account scope are required");
  assertMachineTokens(options.actionFoundation, options.readToken, options.reviewToken);
  if (options.siteTraffic?.machine) {
    const token = options.siteTraffic.machine.token;
    if (token.length < 32 || [options.readToken, options.reviewToken, options.runtime?.machine?.token, options.actionFoundation?.worker?.token,
      options.actionFoundation?.decisionRelay?.token, options.actionFoundation?.reporting?.token].some(other => other !== undefined && safeEqual(token, other)))
      throw new Error("Traffic import authority requires its own distinct server-only credential.");
  }
  if (options.runtime?.machine) {
    const token = options.runtime.machine.token;
    if (token.length < 32 || [options.readToken, options.reviewToken, options.actionFoundation?.worker?.token,
      options.actionFoundation?.decisionRelay?.token, options.actionFoundation?.reporting?.token].some(other => other !== undefined && safeEqual(token, other)))
      throw new Error("Runtime machine authority requires its own distinct server-only credential.");
  }
  if (options.commercialPolicy && options.offerAuthority?.commercialPolicy && options.commercialPolicy !== options.offerAuthority.commercialPolicy)
    throw new Error("One shared commercial policy source is required");
  const commercialPolicy = options.commercialPolicy ?? options.offerAuthority?.commercialPolicy;
  if (commercialPolicy && options.rewardAuthority?.commercialPolicy && commercialPolicy !== options.rewardAuthority.commercialPolicy)
    throw new Error("Reward consumers require one shared commercial policy source");
  if (options.rewardDomain && !commercialPolicy) throw new Error("Reward domain requires the shared commercial policy source");
  const store = new AgentStore(options.databasePath, { workspaceId: options.workspaceId, accountId: options.accountId });
  let operations: ReturnType<typeof createOperations>;
  let providerHealth: ReturnType<typeof createProviderHealth>;
  let portfolio: PortfolioRepository;
  let assets: AssetRepository;
  let funnel: FunnelRepository;
  let offers: OfferRepository;
  let intake: IntakeRepository;
  let rewards: RewardRedemptionRepository;
  let schedules: ScheduleDraftRepository;
  let operationsSecret: string;
  let evidenceReviews: EvidenceReviewRepository;
  let collaborationWorkflow: ReturnType<typeof createCollaborationWorkflow>;
  let stockSupport: ReturnType<typeof createStockSupportWorkflow>;
  let monitor: ReturnType<typeof createMonitorReader>;
  let lifecycle: ReturnType<typeof createLifecycleService>;
  let shippingHub: ReturnType<typeof createShippingHubReader>;
  let fulfillment: ReturnType<typeof createFulfillmentDomain>;
  let settlements: ReturnType<typeof createSettlementReader>;
  let finance: ReturnType<typeof createFinanceReader>;
  let operationsReads: ReturnType<typeof createOperationsReadReader>;
  let teamInvitationReads: ReturnType<typeof createTeamInvitationReadReader>;
  let recruitmentWorkspace: ReturnType<typeof createRecruitmentService>;
  let bulkWorkspace: ReturnType<typeof createBulkService>;
  let siteTraffic: ReturnType<typeof createSiteTrafficService>;
  let siteTrafficApi: ReturnType<typeof createSiteTrafficImportApi>;
  let controls: ReturnType<typeof createOperationsControls>;
  let operationsBridge: ReturnType<typeof createOperationsControlBridge> | undefined;
  let sourcingPlan: ReturnType<typeof createNativeSourcingReader>;
  let analytics: ReturnType<typeof createNativeAnalyticsReader>;
  let actionFoundation: ReturnType<typeof createActionFoundation>;
  let rewardDomain: ReturnType<typeof createRewardDomainBridge> | undefined;
  let mediaDomain: MediaComposition | undefined;
  let runtime: JobRuntime;
  let runtimeApi: ReturnType<typeof createRuntimeApi>;
  let commercialProjection: ReturnType<typeof createCommercialProjection>;
  let recruitment: ReturnType<typeof createRecruitmentSourceReader>;
  try {
    offers = new OfferRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId }, {
      ...options.offerAuthority,
      commercialPolicy,
      assessment: creatorId => {
        const record = store.latest(creatorId);
        if (!record) return null;
        const { stale, assessment } = current(record);
        return { runId: record.runId, creatorId, route: record.packet.checkoutRoute, modelId: assessment.modelId, configHash: assessment.config.hash,
          policyVersion: assessment.policyVersion, state: assessment.state, termsRevision: record.packet.termsRevision, stale };
      },
    }, { now: options.operations?.now });
    intake = new IntakeRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId }, options.intakeAuthority);
    rewards = new RewardRedemptionRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId },
      { ...options.rewardAuthority, commercialPolicy: commercialPolicy ?? options.rewardAuthority?.commercialPolicy },
      () => new Date((options.operations?.now ?? Date.now)()));
    funnel = new FunnelRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId }, options.funnelAuthority);
    portfolio = new PortfolioRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId }, options.portfolioAuthority);
    assets = new AssetRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId }, options.assetAuthority);
    operations = createOperations(store.database, { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, options.operations);
    operationsSecret = loadOperationsSecret(store.database, { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" });
    siteTraffic = createSiteTrafficService({ db: store.database, scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      referenceKey: operationsSecret, source: options.siteTraffic?.source, orders: options.siteTraffic?.orders, clicks: options.siteTraffic?.clicks, now: options.operations?.now });
    commercialProjection = createCommercialProjection({ offers, db: store.database,
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, secret: operationsSecret, now: options.operations?.now });
    recruitment = createRecruitmentSourceReader({ scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      source: options.recruitmentSource, secret: operationsSecret, now: options.operations?.now });
    schedules = new ScheduleDraftRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, operationsSecret, options.operations?.now);
    stockSupport = createStockSupportWorkflow(store.database,
      { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, options.stockSupportSource, options.operations?.now);
    monitor = createMonitorReader({ db: store.database,
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, secret: operationsSecret,
      funnel, intake, source: options.monitorSource, now: options.operations?.now });
    providerHealth = createProviderHealth(store.database, { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      operations.ledger, operations.jobs, options.providerHealth);
    shippingHub = createShippingHubReader({ scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      referenceKey: operationsSecret, source: options.shippingHubSource, now: options.operations?.now });
    lifecycle = createLifecycleService({ db: store.database,
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, secret: operationsSecret,
      source: options.lifecycleSource, now: options.operations?.now });
    const actorSources=options.actionFoundation?.approvals?.sources;
    fulfillment=createFulfillmentDomain({db:store.database,scope:{workspaceId:options.workspaceId,accountId:options.accountId,environment:"sandbox"},secret:operationsSecret,
      bindings:{...options.fulfillment,authority:actorSources},now:options.operations?.now,actions:()=>actionFoundation.service,approvals:()=>actionFoundation.approvals});
    const settlementBindings: SettlementBindings={...options.settlements,
      authority:actorSources?.resolveActor&&actorSources.assertCurrent?{resolve:actorSources.resolveActor,assertCurrent:actorSources.assertCurrent}:undefined};
    settlements=createSettlementReader({db:store.database,scope:{workspaceId:options.workspaceId,accountId:options.accountId,environment:"sandbox"},secret:operationsSecret,bindings:settlementBindings,now:options.operations?.now});
    const settlementDomain=createSettlementActionDomain(settlements,settlementBindings),settlementLedger=settlementLedgerSource(settlements,settlementBindings);
    if(settlementLedger && options.actionFoundation?.ledger)throw new Error("Settlement exports must use one canonical ledger source.");
    finance = createFinanceReader({ scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      secret: operationsSecret, source: options.financeSource, now: options.operations?.now });
    operationsReads = createOperationsReadReader({ scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      secret: operationsSecret, source: options.operationsReadSource, permittedLinkOrigins:options.operationsReadPermittedLinkOrigins, now: options.operations?.now });
    teamInvitationReads = createTeamInvitationReadReader({ scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      secret: operationsSecret, source: options.teamInvitationReadSource, now: options.operations?.now });
    const controlAuthority=options.operationsControlAuthority?createOperationsControlAuthority({
      scope:{workspaceId:options.workspaceId,accountId:options.accountId,environment:"sandbox"},
      sources:options.actionFoundation?.approvals?.sources??{},source:options.operationsControlAuthority,now:options.operations?.now}):undefined;
    if(options.operationsCanonical&&!controlAuthority)throw new Error("Canonical operations require named source authority.");
    controls = createOperationsControls({ db: store.database,
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, secret: operationsSecret,
      ledger: operations.ledger, jobs: operations.jobs, health: providerHealth, source: options.operationsControlSource, now: options.operations?.now,
      authority:controlAuthority,canonical:()=>operationsBridge,
      serviceReaders:controlAuthority?createOperationsControlServiceReaders({authority:controlAuthority,
        runtime:()=>options.runtime?runtimeApi:undefined,reporting:()=>actionFoundation.reporting}):undefined });
    if(options.operationsCanonical&&controlAuthority)operationsBridge=createOperationsControlBridge({
      scope:{workspaceId:options.workspaceId,accountId:options.accountId,environment:"sandbox"},authority:controlAuthority,
      source:options.operationsCanonical.source,owners:options.operationsCanonical.owners,intents:controls.canonicalIntents,
      actions:()=>actionFoundation.service,approvals:()=>actionFoundation.approvals,now:options.operations?.now});
    sourcingPlan = createNativeSourcingReader({ db: store.database,
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, referenceKey: operationsSecret,
      source: options.sourcingPlanSource, now: options.operations?.now });
    analytics = createNativeAnalyticsReader({ scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, referenceKey: operationsSecret,
      source: options.analyticsSource, now: options.operations?.now });
    if (options.rewardDomain) rewardDomain = createRewardDomainBridge({
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      repository: rewards, commercialPolicy: commercialPolicy!, source: options.rewardDomain.source,
      registration: options.rewardDomain.registration, now: options.operations?.now,
    });
    if (options.mediaDomain) mediaDomain = createMediaComposition({ db: store.database,
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      bindings: options.mediaDomain, now: options.operations?.now,
      stageApprovals: { resolveCurrentProof: binding => actionFoundation.approvals.resolveCurrentProof(binding),
        assertCurrentProof: (proof, timestamp) => actionFoundation.approvals.assertCurrentProof(proof, timestamp) } });
    recruitmentWorkspace = createRecruitmentService({
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      referenceKey: operationsSecret, now: options.operations?.now, ...options.recruitmentWorkspace,
      authority: options.actionFoundation?.approvals?.sources ?? {}, offers, commercial: commercialProjection,
      drafts: new InvitationDraftRepository(store.database, { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, options.operations?.now),
      actions: { readApproval: (ref, principal) => actionFoundation.service.readApproval(ref, principal), readRun: (ref, principal) => actionFoundation.service.readRun(ref, principal) },
      records: { readApproval: ref => actionFoundation.approvals.readApproval(ref), readRun: ref => actionFoundation.dispatch.read(ref, false),
        readPreview: (command, principal, key) => actionFoundation.approvals.readCommand("propose", command, principal, key) },
    });
    const bulkScope = {workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" as const};
    bulkWorkspace = createBulkService({ scope: bulkScope, referenceKey: operationsSecret, now: options.operations?.now,
      source: options.bulkWorkspace?.source, owners: options.bulkWorkspace?.owners ?? new Map(), records: {
        readApproval: (ref, version) => actionFoundation.approvals.readApproval(ref, version),
        readRun: ref => actionFoundation.dispatch.read(ref, false),
        readRuns: (ref, version) => actionFoundation.dispatch.readApprovalRuns(ref, version),
        findGroupManifest: (sourceRef, basisHash, kind, payloadRef) => findBulkGroupManifest(store.database, bulkScope, sourceRef, basisHash, kind, payloadRef),
        assertRegistration: descriptor => assertBulkRuntimeRegistration(store.database, options.runtime?.registry, descriptor),
      } });
    let actionBindings = composeActionDomains(options.actionFoundation, [...(rewardDomain ? [rewardDomain] : []), ...(mediaDomain ? [mediaDomain] : []),...(operationsBridge?[operationsBridge.domain]:[]),...(settlementDomain?[settlementDomain]:[]),...(options.fulfillment?[fulfillment.domain]:[]),...(recruitmentWorkspace.domain?[recruitmentWorkspace.domain]:[]),...(options.bulkWorkspace?[bulkWorkspace.domain]:[])]);
    if(settlementLedger)actionBindings={...actionBindings,ledger:settlementLedger};
    if (mediaDomain && actionBindings) actionBindings = { ...actionBindings, resources: createMediaResources(actionBindings.resources, mediaDomain) };
    if (actionBindings?.approvals?.registry) actionBindings = { ...actionBindings, approvals: { ...actionBindings.approvals,
      registry: withCommercialOffers(actionBindings.approvals.registry, offers, options.operations?.now) } };
    if (actionBindings?.worker) {
      const worker = actionBindings.worker;
      actionBindings = { ...actionBindings, worker: { ...worker, assertCurrent: (proof, timestamp) => {
        // Ownership can change while machine/source proof is awaited. Recheck inside the
        // existing dispatch transaction and immediately before each effect as well.
        if (runtime?.ownsRun(proof.runRef)) throw new RuntimeApiError("RUNTIME_MACHINE_BOUNDARY_REQUIRED", 403, "uncertain");
        worker.assertCurrent(proof, timestamp);
        if (runtime?.ownsRun(proof.runRef)) throw new RuntimeApiError("RUNTIME_MACHINE_BOUNDARY_REQUIRED", 403, "uncertain");
      } } };
    }
    actionFoundation = createActionFoundation({ db: store.database,
      scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      secret: operationsSecret, jobs: operations.jobs, ledger: operations.ledger,
      bindings: actionBindings, now: options.operations?.now,
      commercialEligibility: manifest => {
        if (!["invitation", "activation", "shipment"].includes(manifest.draft.phase)) return new Map();
        const phase = manifest.draft.phase as "invitation" | "activation" | "shipment";
        return new Map(manifest.items.map(item => {
          const selected = manifest.draft.commercialOffers?.find(row => row.itemRef === item.itemRef);
          return [item.itemRef, commercialProjection.project({ creatorId: item.targetRef, offerId: selected?.offerRef,
            offerVersion: selected?.offerVersion, phase })];
        }));
      } });
    runtime = new JobRuntime(store.database, { scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      jobs: operations.jobs, ledger: operations.ledger, dispatch: actionFoundation.dispatch,
      registry: options.runtime?.registry ?? { registrations: new Map(), executors: new Map() },
      authority: options.runtime?.authority, now: options.operations?.now });
    runtimeApi = createRuntimeApi({ runtime, scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      secret: operationsSecret, machine: options.runtime?.machine, actorSources: actionBindings?.approvals?.sources,
      // Public reads already consume the shared transport admission below. Standalone
      // runtime gateways retain their default own admission; machine writes always do.
      readAdmission: "upstream", limits: actionFoundation.limits, now: options.operations?.now });
    siteTrafficApi = createSiteTrafficImportApi({ scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" },
      service: siteTraffic, machine: options.siteTraffic?.machine, limits: actionFoundation.limits, now: options.operations?.now });
    evidenceReviews = new EvidenceReviewRepository(store, { workspaceId: options.workspaceId, accountId: options.accountId },
      (record, superseded) => current(record, superseded, false));
    collaborationWorkflow = createCollaborationWorkflow(store.database,
      { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, operationsSecret, options.collaborationSourceReader, options.operations?.now,
      input => readCollaborationEvidence(input));
  }
  catch (error) { store.close(); throw error; }
  const readCollaborationEvidence = createCollaborationEvidenceReader(store.database,
    { workspaceId: options.workspaceId, accountId: options.accountId }, operationsSecret, options.assetAuthority);
  const sessions = new Map<string, Session>();
  const bindings = options.bindings ?? [];
  const modelBinding = (route: "website" | "tiktok-shop") => bindings.find((b) => b.current.modelId === MODEL_FOR_ROUTE[route]) ?? null;
  // Authentication credentials are never encryption/signing keys. Credential rotation
  // still invalidates continuations, while possession of a reader token cannot forge one.
  const cursorKey = createHmac("sha256", operationsSecret).update("farda.creator-sourcing.cursor.v2").update(options.readToken).digest();
  const cursorContext = () => versionOfData({ policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION, agentSchemaVersion: AGENT_SCHEMA_VERSION,
    models: (["website", "tiktok-shop"] as const).map((route) => ({ modelId: MODEL_FOR_ROUTE[route], hash: modelBinding(route)?.hash ?? null })) });
  const encodeCursor = (payload: z.infer<typeof cursorPayloadSchema>) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", cursorKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return `sc1.${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64url")}`;
  };
  const decodeCursor = (token: string, limit: number) => {
    let payload: z.infer<typeof cursorPayloadSchema>;
    try {
      if (!/^sc1\.[A-Za-z0-9_-]{40,4096}$/.test(token)) throw new InvalidCursor();
      const encoded = token.slice(4);
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded || bytes.length < 29) throw new InvalidCursor();
      const decipher = createDecipheriv("aes-256-gcm", cursorKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
      payload = cursorPayloadSchema.parse(JSON.parse(plaintext));
      if (payload.workspaceId !== options.workspaceId || payload.accountId !== options.accountId || payload.limit !== limit) throw new InvalidCursor();
    } catch { throw new InvalidCursor(); }
    if (payload.expiresAt <= Date.now()) throw new AgentConflict("CURSOR_EXPIRED");
    if (payload.contextHash !== cursorContext()) throw new AgentConflict("CURSOR_STALE");
    return payload;
  };
  const authorize = (req: IncomingMessage): { role: Role; session: Session | null } | null => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice(7);
      return safeEqual(token, options.reviewToken) ? { role: "reviewer", session: null } : safeEqual(token, options.readToken) ? { role: "reader", session: null } : null;
    }
    const cookie = req.headers.cookie?.split(";").map((x) => x.trim()).find((x) => x.startsWith("farda_agent="))?.slice(12);
    const session = cookie ? sessions.get(cookie) : null;
    if (session && session.expiresAt > Date.now()) return { role: session.role, session };
    return null;
  };
  const current = (record: StoredAssessment, superseded = false, includeReviewerDisputes = true) => {
    const binding = modelBinding(record.packet.checkoutRoute);
    const terms = record.assessment.routeEvidence?.acceptedTerms;
    const offerSuperseded = terms?.origin === "saved-offer" && !offers.matchesOfferVersion(terms.offerId, terms.version, terms.manifestHash);
    const contested = includeReviewerDisputes && evidenceReviews.contested(record);
    const stale = contested || superseded || offerSuperseded || isScorecardProofExpired(record.assessment) || record.assessment.policyVersion !== POLICY_VERSION || record.assessment.agentVersion !== AGENT_VERSION || record.assessment.config.hash !== (binding?.hash ?? null);
    return { ...record, packet: protectCommentAuthors(record.packet,
      { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, operationsSecret),
      stale, assessment: stale ? { ...record.assessment, state: "reviewNeeded" as const, reasonCodes: [...new Set([...record.assessment.reasonCodes, "STALE_ASSESSMENT", ...(contested ? ["EVIDENCE_DISPUTED"] : []), ...(superseded ? ["SUPERSEDED_ASSESSMENT"] : [])])] } : record.assessment };
  };
  const commercialBasis = (stored: StoredAssessment): AssessmentBasis => {
    const record = current(stored, store.latest(stored.packet.creatorId)?.runId !== stored.runId);
    return { creatorId: stored.packet.creatorId, runId: stored.runId, route: stored.packet.checkoutRoute, modelId: record.assessment.modelId,
      configHash: record.assessment.config.hash, policyVersion: record.assessment.policyVersion, termsRevision: stored.packet.termsRevision,
      state: record.assessment.state, stale: record.stale };
  };
  const assertCommercialBasis = (creatorId: string, runId: string, expected: AssessmentBasis | null) => {
    const stored = store.findRun(creatorId, runId);
    if (digest(stored ? commercialBasis(stored) : null) !== digest(expected))
      throw new CommercialProjectionError("COMMERCIAL_PROJECTION_CHANGED", 409);
  };
  const commercialSelection = { offerId: offerIdSchema.optional(), offerVersion: z.string().regex(/^v[1-9]\d*$/).optional(),
    phase: z.enum(["invitation", "activation", "shipment"]).optional() };
  const readBase = z.object({
    schemaVersion: z.literal(ADAPTER_SCHEMA), operation: z.literal("readView"), requestId: z.string().min(1),
    requestedScope: z.object({ workspaceId: z.literal(options.workspaceId), accountIds: z.array(z.literal(options.accountId)).length(1), environment: z.literal("sandbox") }).strict(),
    period: z.unknown(), sort: z.array(z.unknown()), page: z.object({ cursor: z.string().max(4100).nullable(), limit: z.number().int().min(1).max(100) }).strict(),
  }).strict();
  const saveOfferSchema = z.object({
    schemaVersion: z.literal(ADAPTER_SCHEMA), operation: z.literal("saveResource"), requestId: z.string().min(1).max(240),
    requestedScope: readBase.shape.requestedScope, resourceKind: z.literal("actionDraft"), resourceRef: offerIdSchema,
    expectedVersion: z.string().min(1).max(180).nullable(), idempotencyKey: z.string().trim().min(1).max(240), payload: z.unknown(),
  }).strict();
  const saveSchema = z.discriminatedUnion("resourceKind", [saveOfferSchema, saveOfferSchema.extend({
    resourceKind: z.literal("configurationDraft"), resourceRef: z.string().min(1).max(4100),
  }), saveOfferSchema.extend({ resourceKind: z.literal("reviewerAssessment"), resourceRef: z.string().min(1).max(240) }),
    saveOfferSchema.extend({ resourceKind: z.literal("evidenceDraft"), resourceRef: z.string().min(1).max(240) })]);
  const collaborationActionSchema = z.object({
    schemaVersion: z.literal(ADAPTER_SCHEMA), operation: z.literal("requestApproval"), requestId: z.string().min(1).max(240),
    requestedScope: readBase.shape.requestedScope, actionKind: z.literal("proposeCollaborationReview"), entityRefs: z.array(z.never()).max(0),
    expectedVersion: z.string().regex(/^cw1-[a-f0-9]{64}$/), approvalRef: z.null(), manifestRef: z.null(), runRef: z.null().optional(),
    idempotencyKey: z.string().trim().min(1).max(240), payload: z.unknown(),
  }).strict();
  const adapterActionSchema = z.discriminatedUnion("actionKind", [collaborationActionSchema,
    operationsCanonicalAction.extend({schemaVersion:z.literal(ADAPTER_SCHEMA),requestedScope:readBase.shape.requestedScope}),
    operationsControlAction.extend({ schemaVersion: z.literal(ADAPTER_SCHEMA), requestedScope: readBase.shape.requestedScope }),
    operationsHealthAction.extend({ schemaVersion: z.literal(ADAPTER_SCHEMA), requestedScope: readBase.shape.requestedScope }),
    collaborationActionSchema.extend({ actionKind: z.literal("requestStockTransfer"), expectedVersion: z.string().regex(/^ss1-[a-f0-9]{64}$/), payload: transferIntent }),
    collaborationActionSchema.extend({ actionKind: z.literal("requestSupportHandoff"), expectedVersion: z.string().regex(/^ss1-[a-f0-9]{64}$/), payload: handoffIntent }),
  ]);
  const readSchema = z.discriminatedUnion("viewKey", [
    readBase.extend({viewKey:z.literal("fulfillmentProposal"),filters:fulfillmentFilters,period:z.null(),sort:z.array(z.never()).max(0)}),
    readBase.extend({viewKey:z.literal("ledgerExportRequest"),filters:ledgerExportRequestFilters,period:z.null(),sort:z.array(z.never()).max(0)}),
    readBase.extend({viewKey:z.literal("ledgerExportArtifact"),filters:ledgerExportArtifactFilters,period:z.null(),sort:z.array(z.never()).max(0)}),
    readBase.extend({ viewKey: z.literal("launchControl"), filters: z.object({ requestKey: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).optional() }).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("approvalDetail"), filters: z.object({ approvalId: z.string().min(1).max(240), manifestVersion:z.number().int().positive().safe().optional(), history:z.boolean().optional(), beforeVersion:z.number().int().positive().safe().optional() }).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("runDetail"), filters: z.object({ runId: z.string().min(1).max(1400) }).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("batchDetail"), filters: z.union([scorecardPreviewFilters, recruitmentBatchFiltersSchema, bulkReadFiltersSchema.extend({context:z.literal("bulk")}).strict()]) }),
    readBase.extend({ viewKey: z.literal("customerJourney"), filters: trafficFiltersSchema, period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("recruitmentQueue"), filters: recruitmentFiltersSchema, period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("operationsControl"), filters: operationsControlFilters,
      period: z.null(), sort: z.array(z.never()).max(0) }),
    ...lifecycleViewKeys.map(viewKey => readBase.extend({ viewKey: z.literal(viewKey), filters: lifecycleFilters[viewKey],
      period: z.null(), sort: z.array(z.never()).max(0) })),
    ...financeViewKeys.map(viewKey => readBase.extend({ viewKey: z.literal(viewKey), filters: (settlementViews as readonly string[]).includes(viewKey) ? settlementFilters[viewKey as keyof typeof settlementFilters] : financeFilters[viewKey],
      period: z.null(), sort: z.array(z.never()).max(0) })),
    ...operationsReadViewKeys.map(viewKey => readBase.extend({ viewKey: z.literal(viewKey), filters: operationsReadFilters[viewKey],
      period: z.null(), sort: z.array(z.never()).max(0) })),
    ...teamInvitationReadViewKeys.map(viewKey => readBase.extend({ viewKey: z.literal(viewKey), filters: viewKey === "invitationDraft" ? z.union([teamInvitationReadFilters[viewKey], invitationFiltersSchema]) : teamInvitationReadFilters[viewKey],
      period: z.null(), sort: z.array(z.never()).max(0) })),
    ...monitorViewKeys.map(viewKey => readBase.extend({ viewKey: z.literal(viewKey), filters: monitorFilters[viewKey],
      period: z.null(), sort: z.array(z.never()).max(0) })),
    ...creatorPlatformKeys.map(viewKey => readBase.extend({ viewKey: z.literal(viewKey), filters: creatorPlatformFilterSchema,
      period: z.null(), sort: z.array(z.never()).max(0) })),
    readBase.extend({ viewKey: z.literal("offerDraft"), filters: z.object({ ...commercialSelection, offerId: offerIdSchema, saveRequest: z.object({requestKey:z.string().uuid(),expectedVersion:z.string().regex(/^v[1-9]\d*$/).nullable(),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional() }).strict() }),
    readBase.extend({ viewKey: z.literal("offerRewards"), filters: z.object({ offerId: offerIdSchema }).strict() }),
    readBase.extend({ viewKey: z.literal("pipelineSummary"), filters: funnelFilterSchema }),
    readBase.extend({ viewKey: z.literal("pipelineBranches"), filters: funnelFilterSchema }),
    readBase.extend({ viewKey: z.literal("evidenceRecord"), filters: z.object({ creatorId: z.string().min(1).max(240), evidenceId: z.string().min(1).max(240), runId: z.string().uuid().optional() }).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("connectionsOverview"), filters: operationsViewFiltersSchema, period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("channelCapabilities"), filters: operationsViewFiltersSchema, period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("automationRuns"), filters: operationsViewFiltersSchema, period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("scheduleDetail"), filters: z.object({ jobId: z.string().min(1).max(4096) }).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("assessmentRecord"), filters: z.object({ creatorId: z.string().min(1), assessmentId: z.string().min(1), ...commercialSelection }).strict() }),
    readBase.extend({ viewKey: z.literal("nightlyReconciliation"), filters: z.object({}).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("shippingHub"), filters: z.object({}).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("inventoryOverview"), filters: inventoryFilters, period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("supportWorkspace"), filters: supportFilters, period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("collaborationDetail"), filters: z.object({ collaborationId: z.string().min(1).max(500),
      proposalRequestKey: z.string().trim().min(1).max(240).optional() }).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("collaborationEvidence"), filters: z.object({ collaborationId: z.string().min(1).max(500) }).strict(), period: z.null(), sort: z.array(z.never()).max(0) }),
    readBase.extend({ viewKey: z.literal("discoverySummary"), filters: z.object({}).strict() }),
    readBase.extend({ viewKey: z.literal(SOURCING_PLAN_VIEW), filters: sourcingPlanFilters, period: z.null(), sort: z.array(z.never()).max(0) }),
    // THO-293 analytics reads: strict per-view filters and an event-time period or null, through the shared read path.
    ...nativeAnalyticsViewKeys.map(viewKey => readBase.extend({ viewKey: z.literal(viewKey), filters: nativeAnalyticsFilters[viewKey],
      period: analyticsPeriodSchemaNative.nullable(), sort: z.array(z.never()).max(0) })),
  ]);
  const responseRequests = new WeakMap<ServerResponse, IncomingMessage>();
  const requestIds = new WeakMap<IncomingMessage, string>();
  const readSaveRoles = new WeakMap<IncomingMessage, Role>();
  const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const req = responseRequests.get(res);
    const expectedRole = req ? readSaveRoles.get(req) : undefined;
    // Shared final caller fence for every dashboard family, including legacy
    // async owners. Owner assertions still govern source permissions separately.
    if (req && expectedRole && (status < 400 || status === 404)) {
      const currentAuth = authorize(req);
      if (!currentAuth || currentAuth.role !== expectedRole) {
        status = currentAuth ? 403 : 401;
        body = { code: "CALLER_AUTHORITY_CHANGED", executionCertainty: new URL(req.url ?? "/", "http://localhost").pathname === "/v1/save" ? "uncertain" : "notApplied" };
      }
    }
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(JSON.stringify(status >= 400 ? apiErrorEnvelope(status, body, req ? requestIds.get(req) ?? null : null) : body));
  };
  const bodyOf = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1_048_576) throw new Error("BODY_TOO_LARGE");
      chunks.push(buffer);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && "requestId" in body && typeof body.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/.test(body.requestId))
      requestIds.set(req, body.requestId);
    return body;
  };
  const server = createServer(async (req, res) => {
    responseRequests.set(res, req);
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/health" && req.method === "GET") return reply(res, 200, { service: "farda-creator-agent", schemaVersion: AGENT_SCHEMA_VERSION });
      if (path === "/v1/site-traffic/import") {
        siteTrafficApi.authenticate(req.headers.authorization);
        if (req.method !== "POST" || new URL(req.url!, "http://localhost").search) return reply(res, 400, { code: "INVALID_INPUT", executionCertainty: "uncertain" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "uncertain" });
        const cancel = new AbortController();
        res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
        const result = await siteTrafficApi.execute(await bodyOf(req), req.headers.authorization, cancel.signal);
        try { result.assertCurrent(); return reply(res, 200, result.receipt); }
        finally { result.dispose(); }
      }
      if (path === "/v1/runtime/machine") {
        const machine = options.runtime?.machine;
        if (!machine) throw new RuntimeApiError("RUNTIME_MACHINE_NOT_CONFIGURED", 503, "uncertain");
        if (!req.headers.authorization?.startsWith("Bearer ") || !safeEqual(req.headers.authorization.slice(7), machine.token))
          throw new RuntimeApiError("UNAUTHENTICATED", 401, "uncertain");
        if (req.method !== "POST" || new URL(req.url!, "http://localhost").search)
          return reply(res, 400, { code: "INVALID_INPUT", executionCertainty: "uncertain" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "uncertain" });
        const parsed = runtimeApiCommandSchema.safeParse(await bodyOf(req));
        if (!parsed.success) throw new RuntimeApiError("INVALID_INPUT", 422, "uncertain");
        return reply(res, 200, await runtimeApi.execute(parsed.data.operation, parsed.data.input, req.headers.authorization));
      }
      if (path === "/v1/worker/dispatch" || path === "/v1/approvals/observe") {
        // These are distinct machine-only authorities. Browser sessions and the shared reviewer/reader cannot execute them.
        const kind = path === "/v1/worker/dispatch" ? "worker" : "decisionRelay";
        actionFoundation.authenticateMachine(kind, req.headers.authorization);
        if (req.method !== "POST" || new URL(req.url!, "http://localhost").search) return reply(res, 400, { code: "INVALID_INPUT", executionCertainty: "notApplied" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const raw = await bodyOf(req);
        if (kind === "worker" && raw && typeof raw === "object" && "runRef" in raw && typeof raw.runRef === "string" && runtime.ownsRun(raw.runRef))
          throw new RuntimeApiError("RUNTIME_MACHINE_BOUNDARY_REQUIRED", 403, "uncertain");
        return reply(res, 200, await (kind === "worker" ? actionFoundation.executeWorker(raw, req.headers.authorization)
          : actionFoundation.observeDecision(raw, req.headers.authorization)));
      }
      if(path.startsWith("/v1/reports/")) {
        actionFoundation.authenticateReporting(req.headers.authorization);
        if(new URL(req.url!,"http://localhost").search) return reply(res,400,{code:"INVALID_INPUT",executionCertainty:"uncertain"});
        if(req.method==="POST" && ["/v1/reports/accept","/v1/reports/work","/v1/reports/reconcile"].includes(path)) {
          if(!req.headers["content-type"]?.startsWith("application/json")) return reply(res,415,{code:"JSON_REQUIRED",executionCertainty:"uncertain"});
          const operation=path.slice("/v1/reports/".length) as "accept"|"work"|"reconcile";
          return reply(res,200,await actionFoundation.executeReporting(operation,await bodyOf(req),req.headers.authorization));
        }
        const reportMatch=/^\/v1\/reports\/([^/]+)$/.exec(path);
        if(req.method==="GET" && reportMatch) return reply(res,200,await actionFoundation.executeReporting("read",{reportRef:decodeURIComponent(reportMatch[1]!)},req.headers.authorization));
        return reply(res,404,{code:"UNSUPPORTED_OPERATION",executionCertainty:"notApplied"});
      }
      if (path === "/v1/session" && req.method === "GET") {
        let authenticated = authorize(req);
        if (!authenticated && req.headers.authorization?.startsWith("Basic ")) {
          const [name, token] = Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":");
          if (name === "reader" && token && safeEqual(token, options.readToken)) authenticated = { role: "reader", session: null };
        }
        if (!authenticated) return reply(res, 401, { code: "AUTH_REQUIRED" }, req.headers.accept?.includes("text/html") ? { "www-authenticate": 'Basic realm="Farda agent reader", charset="UTF-8"' } : {});
        const admission = actionFoundation.limits.admit(`agent-${authenticated.role}`, "read");
        if (!admission.admitted) return reply(res, 429, { code: "RATE_LIMITED", retryAfterMs: admission.retryAfterMs }, { "retry-after": String(Math.ceil(admission.retryAfterMs / 1000)) });
        for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
        if (sessions.size >= 1000) return reply(res, 429, { code: "SESSION_CAPACITY" });
        const token = randomBytes(32).toString("hex");
        const session = { role: authenticated.role, csrf: randomBytes(32).toString("hex"), expiresAt: Date.now() + 60 * 60_000 };
        sessions.set(token, session);
        return reply(res, 200, { csrfToken: session.csrf, role: session.role, principal: `agent-${session.role}`, scope: { workspaceId: options.workspaceId, accountIds: [options.accountId], environment: "sandbox", authorizationScopeVersion: "creator-agent.scope.v1" } }, { "set-cookie": `farda_agent=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${options.secureCookies ? "; Secure" : ""}` });
      }
      const auth = authorize(req);
      if (!auth) return reply(res, 401, { code: "AUTH_REQUIRED",
        executionCertainty: apiRequestKind(req.method ?? "GET", path) === "read" ? "notApplied" : "uncertain" });
      if (path === "/v1/read" || path === "/v1/save") readSaveRoles.set(req, auth.role);
      const callerAbort = new AbortController();
      res.once("close", () => { if (!res.writableEnded) callerAbort.abort(); });
      const monitorCaller = { signal: callerAbort.signal, assertCurrent: () => { const current = authorize(req); if (!current || current.role !== auth.role) throw new MonitorError("MONITOR_CALLER_DENIED", current ? 403 : 401); } };
      const stockCaller = { signal: callerAbort.signal, assertCurrent: () => { const current = authorize(req); if (!current || current.role !== auth.role) throw new StockSupportError("STOCK_CALLER_DENIED", current ? 403 : 401); } };
      const collaborationCaller = { signal: callerAbort.signal, assertCurrent: () => { const current = authorize(req); if (!current || current.role !== auth.role) throw new CollaborationWorkflowError("COLLABORATION_CALLER_DENIED", current ? 403 : 401); } };
      const controlsCaller = { signal: callerAbort.signal, assertCurrent: () => { const current = authorize(req); if (!current || current.role !== auth.role) throw new OperationsControlError("OPERATIONS_CALLER_DENIED", current ? 403 : 401); } };
      // Cookie-authorized writes require both CSRF proof and exact same-origin. Machine bearer requests are separate.
      if (req.method !== "GET" && path !== "/v1/read" && auth.session) {
        const origin = options.publicOrigin ?? `http://${req.headers.host}`;
        if (req.headers.origin !== origin || req.headers["x-csrf-token"] !== auth.session.csrf)
          return reply(res, 403, { code: "CSRF_REJECTED", executionCertainty: "uncertain" });
      }
      const kind = apiRequestKind(req.method ?? "GET", path);
      const admission = actionFoundation.limits.admit(`agent-${auth.role}`, kind);
      if (!admission.admitted) return reply(res, 429, { code: "RATE_LIMITED", retryAfterMs: admission.retryAfterMs,
        // Admission refusal describes this transport attempt. It cannot prove the result of a previous lost acknowledgment.
        ...(kind === "write" ? { executionCertainty: "uncertain" } : {}) }, { "retry-after": String(Math.ceil(admission.retryAfterMs / 1000)) });
      const artifact = /^\/v1\/action-artifacts\/([A-Za-z0-9][A-Za-z0-9._:-]{0,239})$/.exec(path);
      if (artifact && req.method === "GET") {
        if (new URL(req.url!, "http://localhost").search) throw new SyntaxError("Unexpected artifact query");
        const cancel=new AbortController();res.once("close",()=>{if(!res.writableEnded)cancel.abort();});
        const exported = await boundedSourceRead(()=>actionFoundation.domains.downloadExport(artifact[1]!, { principalRef: `agent-${auth.role}` }),cancel.signal);
        const currentAuth=authorize(req);
        if(!currentAuth || currentAuth.role!==auth.role)return reply(res,currentAuth?403:401,{code:"ARTIFACT_AUTHORITY_CHANGED",executionCertainty:"notApplied"});
        exported.assertCurrent();
        res.writeHead(200, { "content-type": exported.receipt.contentType, "content-length": Buffer.byteLength(exported.body),
          "content-disposition": 'attachment; filename="ledger-export.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
        return res.end(exported.body);
      }
      if (path === "/v1/identity" && req.method === "GET") return reply(res, 200, {
        service: "farda-creator-agent", schemaVersion: AGENT_SCHEMA_VERSION, role: auth.role,
        scope: { workspaceId: options.workspaceId, accountIds: [options.accountId], environment: "sandbox", authorizationScopeVersion: "creator-agent.scope.v1" },
      });
      if (await operations.handle({ req, res, role: auth.role, reply, bodyOf })) return;
      if (path === "/v1/provider-health" || path.startsWith("/v1/provider-health/")) {
        const url = new URL(req.url!, "http://localhost");
        if ([...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) throw new SyntaxError("Duplicate health query");
        const respondHealth = (data: unknown) => reply(res, 200, { schemaVersion: OPERATIONS_SCHEMA_VERSION,
          scope: { workspaceId: options.workspaceId, accountIds: [options.accountId], environment: "sandbox", authorizationScopeVersion: "operations.scope.v1" },
          data: safeOperationsProjection(data), sourceEffect: "none" });
        if (req.method === "GET") {
          const match = /^\/v1\/provider-health\/([a-f0-9]{64})(?:\/(history|exceptions))?$/.exec(path);
          if (path === "/v1/provider-health" || match) {
            const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }).strict().parse(Object.fromEntries(url.searchParams));
            if (!match) return respondHealth(providerHealth.list(query.limit));
            const record = providerHealth.get(match[1]!);
            if (!record) return reply(res, 404, { code: "CAPABILITY_NOT_FOUND", executionCertainty: "notApplied" });
            return respondHealth(match[2] === "history" ? providerHealth.history(match[1]!, query.limit)
              : match[2] === "exceptions" ? providerHealth.exceptions(match[1]!, query.limit) : record);
          }
        }
        if (path === "/v1/provider-health/check" && req.method === "POST") {
          if (auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
          z.object({}).strict().parse(Object.fromEntries(url.searchParams));
          if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string" || !key.trim() || key.length > 180) return reply(res, 400, { code: "IDEMPOTENCY_KEY_REQUIRED", executionCertainty: "notApplied" });
          return respondHealth(await providerHealth.check(await bodyOf(req), key));
        }
        return reply(res, 404, { code: "UNSUPPORTED_OPERATION", executionCertainty: "notApplied" });
      }
      if (path === "/v1/portfolio" || path.startsWith("/v1/portfolio/")) {
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const key = req.headers["idempotency-key"];
        const result = await handlePortfolioRoute({ method: req.method ?? "GET", path: req.url ?? path,
          role: auth.role, body: req.method === "POST" ? await bodyOf(req) : undefined,
          idempotencyKey: typeof key === "string" ? key : undefined }, portfolio);
        if (result) return reply(res, result.status, result.body);
      }
      if (path === "/v1/assets" || path.startsWith("/v1/assets/")) {
        if (path === "/v1/assets/registry" && req.method === "GET") {
          if (!options.assetRegistryReader) return reply(res, 503, { code: "SOURCE_ACCESS_UNAVAILABLE", executionCertainty: "notApplied" });
          const url = new URL(req.url!, "http://localhost");
          if ([...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) throw new SyntaxError("Duplicate source query");
          const query = z.object({ registry: z.enum(["content", "collaborations"]), cursor: z.string().max(8192).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict().parse(Object.fromEntries(url.searchParams));
          const data = await options.assetRegistryReader({ workspaceId: options.workspaceId, accountId: options.accountId }, query);
          return reply(res, 200, { schemaVersion: "creator-registry.v1", data, sourceEffect: "none" });
        }
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const key = req.headers["idempotency-key"];
        const result = await handleAssetRoute({ method: req.method ?? "GET", path: req.url ?? path,
          role: auth.role, body: req.method === "POST" ? await bodyOf(req) : undefined,
          idempotencyKey: typeof key === "string" ? key : undefined }, assets);
        if (result) return reply(res, result.status, result.body);
      }
      if (path === "/v1/intake" || path.startsWith("/v1/intake/")) {
        if (req.method === "POST" && auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const key = req.headers["idempotency-key"];
        const result = await handleIntakeRoute({ method: req.method ?? "GET", path: req.url ?? path, role: auth.role,
          body: req.method === "POST" ? await bodyOf(req) : undefined, idempotencyKey: typeof key === "string" ? key : undefined }, intake);
        if (result) return reply(res, result.status, result.body);
      }
      if (path.startsWith("/v1/rewards/")) {
        if (req.method === "POST" && auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const key = req.headers["idempotency-key"];
        const result = await handleRewardRoute({ method: req.method ?? "GET", path: req.url ?? path, role: auth.role,
          body: req.method === "POST" ? await bodyOf(req) : undefined, idempotencyKey: typeof key === "string" ? key : undefined }, rewards);
        if (result) return reply(res, result.status, result.body);
      }
      if (path.startsWith("/v1/offers/")) {
        if (req.method === "POST" && auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const key = req.headers["idempotency-key"];
        const result = handleOfferRoute({ method: req.method ?? "GET", path: req.url ?? path, role: auth.role,
          body: req.method === "POST" ? await bodyOf(req) : undefined, idempotencyKey: typeof key === "string" ? key : undefined,
          actorRef: `agent-${auth.role}` }, offers);
        if (result) return reply(res, result.status, result.body);
      }
      if (path === "/v1/save" && req.method === "POST") {
        if (auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        const input = saveSchema.parse(await bodyOf(req));
        const admittedCaller = authorize(req);
        if (!admittedCaller || admittedCaller.role !== auth.role) return reply(res, admittedCaller ? 403 : 401, { code: "CALLER_AUTHORITY_CHANGED", executionCertainty: "notApplied" });
        if (input.resourceKind === "configurationDraft") {
          if (input.payload && typeof input.payload === "object" && "kind" in input.payload && input.payload.kind === "recruitmentInvitation") {
            const payload = invitationSaveSchema.parse(input.payload);
            if (payload.draftId !== input.resourceRef || payload.expectedVersion !== input.expectedVersion)
              throw new RecruitmentError("RECRUITMENT_SAVE_SCOPE_MISMATCH", 422);
            const result = await recruitmentWorkspace.saveInvitation(payload, { principalRef: `agent-${auth.role}` }, input.idempotencyKey, () => { const current = authorize(req); if (!current || current.role !== auth.role) throw new RecruitmentError("RECRUITMENT_CALLER_DENIED", current ? 403 : 401); });
            const currentAuth = authorize(req);
            if (!currentAuth || currentAuth.role !== auth.role) return reply(res, currentAuth ? 403 : 401, { code: "RECRUITMENT_AUTHORITY_CHANGED", executionCertainty: "uncertain" });
            result.assertCurrent();
            const saved = result.data;
            return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
              scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, resourceRef: saved.resourceRef,
              resourceVersion: saved.version, persistedAt: saved.updatedAt, persistedByRef: saved.actorRef,
              record: saved, reasonCodes: [], executionCertainty: "applied" });
          }
          if (flowResourceSchema.safeParse(input.resourceRef).success) {
            const cancel = new AbortController();
            res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
            const assertCaller = () => { const latest = authorize(req); if (!latest || latest.role !== auth.role)
              throw new LifecycleError("LIFECYCLE_CALLER_DENIED", latest ? 403 : 401); };
            const result = await lifecycle.saveDraft({ resourceKind: input.resourceKind, resourceRef: input.resourceRef,
              expectedVersion: input.expectedVersion, payload: input.payload, idempotencyKey: input.idempotencyKey }, `agent-${auth.role}`, { assertCurrent: assertCaller, signal: cancel.signal });
            result.assertCurrent();
            const saved = result.receipt;
            return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
              scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, resourceRef: saved.resourceRef,
              resourceVersion: saved.resourceVersion, persistedAt: saved.persistedAt, persistedByRef: saved.persistedByRef,
              record: saved, reasonCodes: saved.reasonCodes, executionCertainty: "applied" });
          }
          const saved = schedules.saveFromAdapter(input.resourceRef, input.expectedVersion, input.payload, input.idempotencyKey);
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, resourceRef: saved.resourceRef,
            resourceVersion: saved.version, persistedAt: saved.updatedAt, persistedByRef: "agent-reviewer", record: saved.resource,
            reasonCodes: saved.reasonCodes, executionCertainty: "applied" });
        }
        if (input.resourceKind === "reviewerAssessment" || input.resourceKind === "evidenceDraft") {
          const kind = z.object({ kind: z.enum(["observation", "disagree", "override"]) }).passthrough().parse(input.payload).kind;
          if ((kind === "observation") !== (input.resourceKind === "evidenceDraft"))
            return reply(res, 422, { code: "VALIDATION_FAILED", executionCertainty: "notApplied" });
          const saved = evidenceReviews.saveFromAdapter(input.resourceRef, input.expectedVersion, input.payload, input.idempotencyKey, "agent-reviewer", input.resourceKind);
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, resourceRef: saved.resourceRef,
            resourceVersion: saved.version, persistedAt: saved.updatedAt, persistedByRef: saved.persistedByRef, record: saved.resource,
            reasonCodes: saved.reasonCodes, executionCertainty: "applied" });
        }
        const record = offers.saveFromAdapter(input.resourceRef, input.expectedVersion, input.payload, input.idempotencyKey);
        return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
          scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, resourceRef: record.offerId,
          resourceVersion: record.version, persistedAt: record.recordedAt, persistedByRef: "agent-reviewer", record,
          reasonCodes: [], executionCertainty: "applied" });
      }
      if (path === "/v1/action" && req.method === "POST") {
        if (auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        if (new URL(req.url!, "http://localhost").search) throw new SyntaxError("Unexpected query");
        const raw = await bodyOf(req);
        if(raw && typeof raw === "object" && "actionKind" in raw && raw.actionKind === "previewFulfillmentDecision") {
          const input=fulfillmentPreviewAction.extend({requestedScope:readBase.shape.requestedScope}).parse(raw);
          const cancel=new AbortController();res.once("close",()=>{if(!res.writableEnded)cancel.abort();});
          const result=await fulfillment.preview(input,{principalRef:`agent-${auth.role}`},cancel.signal);
          const currentAuth=authorize(req);
          if(!currentAuth || currentAuth.role!==auth.role)return reply(res,currentAuth?403:401,{code:"FULFILLMENT_AUTHORITY_CHANGED",executionCertainty:"uncertain"});
          result.assertCurrent();return reply(res,200,result.response);
        }
        const native = foundationActionSchema.safeParse(raw), domain = domainActionSchema.safeParse(raw);
        // The controls command is an exact finite intent, not a caller-selected domain handler.
        if(raw&&typeof raw==="object"&&"actionKind"in raw&&raw.actionKind==="previewOperationsControl"){
          const input=adapterActionSchema.parse(raw);
          if(input.actionKind!=="previewOperationsControl")throw new SyntaxError("Unexpected operations action");
          return reply(res,200,await controls.previewCanonical(input,`agent-${auth.role}`,auth.role));
        }
        if (native.success || domain.success) return reply(res, 200, await actionFoundation.execute(raw, `agent-${auth.role}`));
        const input = adapterActionSchema.parse(raw);
        if (input.actionKind === "refreshOperationsHealth") {
          const result = await controls.refreshHealth(input, "agent-reviewer", auth.role, controlsCaller);
          result.assertCurrent();
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, ...result,
            approvalRef: null, manifestRef: null, modelVersion: null, offerVersion: null,
            nextAction: { kind: "Inspect the source observation and its recovery context", ownerRef: null, dueAt: null, available: false },
            nextPollAfterMs: null });
        }
        const result = input.actionKind === "proposeCollaborationReview"
          ? await collaborationWorkflow.propose(input, "agent-reviewer", collaborationCaller) : input.actionKind === "proposeOperationsReview"
            ? await controls.propose(input, "agent-reviewer", auth.role, controlsCaller) : await stockSupport.propose(input, "agent-reviewer", stockCaller);
        if ("assertCurrent" in result && typeof result.assertCurrent === "function") result.assertCurrent();
        return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
          scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, ...result,
          runRef: null, approvalRef: null, manifestRef: null, modelVersion: null, offerVersion: null,
          reasonCodes: ["LOCAL_PROPOSAL_ONLY", "J04_DECISION_AND_SOURCE_DISPATCH_NOT_CONNECTED"],
          nextAction: { kind: "Review the saved proposal in the decision workflow", ownerRef: null, dueAt: null, available: false },
          nextPollAfterMs: null, executionCertainty: "applied" });
      }
      if (path === "/v1/funnel/events" && req.method === "POST") {
        if (auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" });
        return reply(res, 200, await funnel.ingest(await bodyOf(req)));
      }
      if (path === "/v1/policy" && req.method === "GET") return reply(res, 200, ratingPolicy);
      if (path === "/v1/capabilities" && req.method === "GET") return reply(res, 200, {
        schemaVersion: AGENT_SCHEMA_VERSION, policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION,
        storageSchema: 1, environment: "sandbox", mode: "reviewedEvidence", sourceAutomation: "notConnected",
        portfolioReview: { storage: "durable", decisionAuthority: options.portfolioAuthority ? "injected" : "notConnected", providerExecution: "notConnected" },
        offers: { storage: "durable", providerExecution: "notConnected", decisionAuthority: options.offerAuthority?.decision ? "injected" : "notConnected" },
        acquisitionFunnel: { storage: "durable", sourceAuthority: options.funnelAuthority ? "injected" : "notConnected" },
        creatorPlatforms: { views: "saved-ledger-projections", providerCoverage: "unknown" },
        savedOperations: { pagination: "scoped-cursor-v1", scheduleDrafts: "durable-versioned", scheduleActivation: "notConnected" },
        reviewerEvidence: { annotations: "immutable-versioned", completionAuthority: "source-j20" },
        collaborationReview: { sourceAuthority: options.collaborationSourceReader ? "injected" : "notConnected", proposals: "durable", dispatch: "notConnected" },
        stockSupportReview: { sourceAuthority: options.stockSupportSource ? "injected" : "notConnected", proposals: "durable", inventoryExecution: "notConnected", supportExecution: "notConnected" },
        contentMonitor: { sourceAuthority: options.monitorSource ? "injected" : "notConnected", views: "read-only-projections", sourceExecution: "notConnected", retryAuthority: "notConnected" },
        financeReads: { sourceAuthority: options.financeSource ? "injected" : "notConnected", views: "read-only-projections", paymentExecution: "notConnected", closeExecution: "notConnected", exportExecution: "notConnected" },
        operationsReads: { sourceAuthority: options.operationsReadSource ? "injected" : "notConnected", views: "read-only-projections", shippingDecisionExecution: "notConnected", returnExecution: "notConnected", customerReveal: "notConnected" },
        teamInvitationReads: { sourceAuthority: options.teamInvitationReadSource ? "injected" : "notConnected", views: "read-only-projections", roleChangeExecution: "notConnected", ownerAssignmentExecution: "notConnected", invitationSendExecution: "notConnected" },
        shippingHub: { sourceAuthority: options.shippingHubSource ? "injected" : "notConnected", readOnly: true },
        lifecycleConfiguration: { sourceAuthority: options.lifecycleSource ? "injected" : "notConnected", drafts: "durable-versioned", publicationExecution: "notConnected", deliveryExecution: "notConnected" },
        operationsControls: { sourceAuthority: options.operationsControlAuthority||options.operationsControlSource ? "injected" : "notConnected", proposals: "durable", taskExecution: operationsBridge?.supports("task")?"canonical-source-guarded":"notConnected", repairExecution: operationsBridge?.supports("repair")?"canonical-source-guarded":"notConnected", assignmentAuthority: "source-owned" },
        siteTraffic: { aggregateStorage: "durable-versioned", sourceAuthority: options.siteTraffic?.source ? "injected" : "notConnected",
          importAuthority: options.siteTraffic?.machine ? "source-guarded-machine" : "notConnected", actualImportStatus: "read-from-source-evidence" },
        dailySourcingPlan: { sourceAuthority: options.sourcingPlanSource ? "injected" : "notConnected", views: "read-only-projections", discoveryExecution: "notConnected", dispatch: "notConnected" },
        analyticsReads: { sourceAuthority: options.analyticsSource ? "injected" : "notConnected", viewKeys: nativeAnalyticsViewKeys, readOnly: true },
        actionFoundation: { approvalStorage: "durable-versioned", approvalAuthority: options.actionFoundation?.approvals ? "injected" : "notConnected",
          dispatch: options.actionFoundation?.worker ? "source-guarded-worker" : "notConnected", appDecisionRelease: "held",
          ledgerExport: options.actionFoundation?.ledger || options.settlements?.ledger ? "injected" : "notConnected", readinessRelease: "notGranted" },
        scorecardEvidence: { routeAuthority: options.scorecardAuthority ? "injected" : "notConnected" },
        assetRegistry: { storage: "durable", sourceAuthority: options.assetAuthority ? "injected" : "notConnected", providerExecution: "notConnected" },
        models: (["website", "tiktok-shop"] as const).map((route) => ({ modelId: MODEL_FOR_ROUTE[route], configHash: modelBinding(route)?.hash ?? null })),
      });
      const match = /^\/v1\/creators\/([^/]+)$/.exec(path);
      if (match && req.method === "GET") {
        const record = store.latest(decodeURIComponent(match[1]!));
        return record ? reply(res, 200, current(record)) : reply(res, 404, { code: "RECORD_NOT_FOUND" });
      }
      if (match && req.method === "PUT") {
        if (auth.role !== "reviewer") return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { code: "JSON_REQUIRED" });
        const input = writeSchema.parse(await bodyOf(req));
        if (input.packet.creatorId !== decodeURIComponent(match[1]!)) return reply(res, 400, { code: "IDENTITY_MISMATCH" });
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !key.trim() || key.length > 240) return reply(res, 400, { code: "IDEMPOTENCY_KEY_REQUIRED" });
        const binding = modelBinding(input.packet.checkoutRoute);
        if (input.configHash !== (binding?.hash ?? null)) return reply(res, 409, { code: "CONFIG_VERSION_CONFLICT", executionCertainty: "notApplied" });
        const protect = (packet: z.infer<typeof evidencePacketSchema>) => protectCommentAuthors(packet,
          { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, operationsSecret);
        const packet = protect(input.packet);
        const proof = await resolveScorecardEvidence(options.scorecardAuthority, { workspaceId: options.workspaceId, accountId: options.accountId }, packet, Date.now(), id => offers.acceptedTerms(id));
        const assessment = assessCreator(packet, binding, proof);
        const saved = store.save(packet, assessment, input.expectedVersion, key, protect);
        return reply(res, 200, current(saved, store.latest(saved.packet.creatorId)?.runId !== saved.runId));
      }
      if (path === "/v1/read" && req.method === "POST") {
        const input = readSchema.parse(await bodyOf(req));
        const admittedCaller = authorize(req);
        if (!admittedCaller || admittedCaller.role !== auth.role) return reply(res, admittedCaller ? 403 : 401, { code: "CALLER_AUTHORITY_CHANGED", executionCertainty: "notApplied" });
        if (input.viewKey === "customerJourney") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const cancel = new AbortController();
          res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
          const result = await siteTraffic.read(input.filters, { principalRef: `agent-${auth.role}` }, cancel.signal);
          const data = result.data;
          const expected = data.coverage.expectedDays, observed = data.coverage.observedDays;
          const envelope = { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: data.freshness.state === "stale" ? "stale" : data.coverage.state === "complete" ? "ready" : "partial", data,
            sourceFreshness: [], coverage: { expectedCount: expected, observedCount: observed, missingCount: expected === null ? null : Math.max(0, expected - observed),
              complete: data.coverage.state === "complete", reasonCodes: data.coverage.reasonCodes },
            capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } };
          const assertSession = () => { const currentAuth = authorize(req); if (!currentAuth || currentAuth.role !== auth.role) throw new SiteTrafficError("TRAFFIC_PRINCIPAL_DENIED", currentAuth ? 403 : 401); };
          assertSession(); result.assertCurrent(); assertSession();
          return reply(res, 200, envelope);
        }
        if (input.viewKey === SOURCING_PLAN_VIEW) {
          const cancel = new AbortController(); res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
          const result = await sourcingPlan.read({ viewKey: input.viewKey, filters: input.filters, period: input.period, sort: input.sort, page: input.page },
            { principalRef: `agent-${auth.role}`, role: auth.role }, cancel.signal);
          const envelope = { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.dataState, data: result.data, sourceFreshness: [], coverage: result.coverage,
            capabilities: result.capabilities, page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } };
          result.assertCurrent(); return reply(res, 200, envelope);
        }
        if (input.viewKey === "launchControl") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const recovery = input.filters.requestKey === undefined ? null
            : await actionFoundation.domains.recoverReadinessRequest(input.filters.requestKey, { principalRef: `agent-${auth.role}` });
          const latest = await actionFoundation.readReadiness(`agent-${auth.role}`);
          if (recovery?.intent && recovery.intent.targetRef !== latest.targetRef) return reply(res, 403, { code: "FORBIDDEN", executionCertainty: "uncertain" });
          const data = { ...latest, requestRecovery: recovery };
          const incomplete = data.gates.some(gate => gate.state === "unknown");
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "actions.scope.v1" }, dataVersion: data.version,
            dataState: incomplete ? "partial" : "ready", data, sourceFreshness: [],
            coverage: { expectedCount: data.gates.length, observedCount: data.gates.filter(gate => gate.state !== "unknown").length,
              missingCount: data.gates.filter(gate => gate.state === "unknown").length, complete: !incomplete,
              reasonCodes: incomplete ? ["READINESS_GATES_UNOBSERVED"] : [] },
            capabilities: [{ actionKind: "recordLaunchReadiness", state: auth.role !== "reviewer" ? "denied" : data.phaseAllowed ? "available" : "held",
              reasonCodes: auth.role !== "reviewer" ? ["REVIEWER_REQUIRED"] : data.phaseAllowed ? [] : ["READINESS_PHASE_REQUIRED"] }],
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "approvalDetail" || input.viewKey === "runDetail") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          if (input.viewKey === "runDetail" && input.filters.runId.startsWith("rt-run-")) {
            const data = await runtimeApi.readRun(input.filters.runId, `agent-${auth.role}`);
            data.runRef = input.filters.runId;
            return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
              scope: { ...input.requestedScope, authorizationScopeVersion: "actions.scope.v1" }, dataVersion: versionOfData(data),
              dataState: data.sourceCoverage === "partial" ? "partial" : "ready", data, sourceFreshness: [],
              coverage: { expectedCount: data.sourceCoverage === "partial" ? null : data.counts.total, observedCount: data.counts.total,
                missingCount: data.sourceCoverage === "partial" ? null : 0, complete: data.sourceCoverage === "complete",
                reasonCodes: data.sourceCoverage === "partial" ? ["RUNTIME_WINDOW_PARTIAL"] : [] }, capabilities: [],
              page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
          }
          const principal = { principalRef: `agent-${auth.role}` };
          const data = input.viewKey === "approvalDetail" ? await actionFoundation.service.readApproval(input.filters.approvalId, principal, input.filters)
            : await actionFoundation.service.readRun(input.filters.runId, principal);
          const currentAuth = authorize(req);
          if (!currentAuth || currentAuth.role !== auth.role) return reply(res,currentAuth ? 403 : 401,{code:currentAuth ? "SOURCE_ROLE_CHANGED" : "UNAUTHENTICATED",executionCertainty:"notApplied"});
          const historical = data.kind === "native-approval" && data.history?.mode === "history";
          const capability = (actionKind: string, allowed: boolean, reason: string) => ({ actionKind,
            state: auth.role !== "reviewer" ? "denied" : historical ? "held" : allowed ? "available" : "held",
            reasonCodes: auth.role !== "reviewer" ? ["REVIEWER_REQUIRED"] : historical ? ["HISTORICAL_VIEW_READ_ONLY"] : allowed ? [] : [reason] });
          const capabilities = data.kind === "native-approval" ? [
            capability("requestApproval", data.requestState === "local" && !["canceled", "rejected", "editRequired"].includes(data.current.state), "APPROVAL_REQUEST_ALREADY_RECORDED"),
            capability("reconcileApproval", true, "APPROVAL_REQUEST_UNVERIFIED"),
            capability("dispatchApprovedAction", data.current.state === "approved" && !(data.execution?.coverage.total), data.execution?.coverage.total ? "EXISTING_CANONICAL_EXECUTION" : "APPROVAL_REQUIRED"),
            capability("decideApproval", false, "APPROVAL_CHANNEL_REQUIRED"),
          ] : [
            capability("pauseRun", data.control === "active" && !["completed", "cancelled"].includes(data.current.state), "NOTHING_TO_PAUSE"),
            capability("cancelUnsent", data.control !== "cancelled" && data.current.state !== "completed", "NOTHING_TO_CANCEL"),
            capability("resumeRun", data.control === "paused", "RUN_NOT_PAUSED"),
            capability("lookup", true, "SOURCE_RECONCILIATION_CAPABILITY_UNAVAILABLE"),
          ];
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "actions.scope.v1" }, dataVersion: versionOfData(data),
            dataState: "ready", data, sourceFreshness: [],
            coverage: { expectedCount: data.items.length, observedCount: data.items.length, missingCount: 0, complete: true,
              reasonCodes: [] }, capabilities, page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if ((nativeAnalyticsViewKeys as readonly string[]).includes(input.viewKey)) {
          const cancel = new AbortController(); res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
          const result = await analytics.read({ viewKey: input.viewKey, filters: input.filters, period: input.period, sort: input.sort, page: input.page },
            { principalRef: `agent-${auth.role}`, role: auth.role }, cancel.signal);
          const envelope = { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.dataState, data: result.data, sourceFreshness: [], coverage: result.coverage,
            capabilities: [], page: result.page, refresh: { nextPollAfterMs: null } };
          result.assertCurrent(); return reply(res, 200, envelope);
        }
        if (input.viewKey === "lifecycleOverview" || input.viewKey === "emailFlow" || input.viewKey === "consentEligibility" || input.viewKey === "activationRetention") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          if (input.viewKey === "emailFlow" && "draftRequestKey" in input.filters && input.filters.draftRequestKey !== undefined && auth.role !== "reviewer")
            return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
          const cancel = new AbortController();
          res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
          const assertCaller = () => { const latest = authorize(req); if (!latest || latest.role !== auth.role)
            throw new LifecycleError("LIFECYCLE_CALLER_DENIED", latest ? 403 : 401); };
          const result = await lifecycle.read(input.viewKey, input.filters, `agent-${auth.role}`, { assertCurrent: assertCaller, signal: cancel.signal });
          const held = result.stale || result.partial || result.empty;
          const envelope = { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.stale ? "stale" : result.partial ? "partial" : result.empty ? "empty" : "ready", data: result.data,
            sourceFreshness: [], coverage: { expectedCount: 1, observedCount: result.empty ? 0 : 1, missingCount: result.empty ? 1 : 0,
              complete: !held, reasonCodes: held ? ["LIFECYCLE_SOURCE_REVIEW_REQUIRED"] : [] },
            capabilities: (result.capabilities ?? []).map(capability => ({ ...capability,
              state: auth.role === "reviewer" ? capability.state : "denied",
              reasonCodes: auth.role === "reviewer" ? capability.reasonCodes : ["REVIEWER_REQUIRED"] })),
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } };
          result.assertCurrent();
          return reply(res, 200, envelope);
        }
        if (input.viewKey === "operationsControl" || input.viewKey === "nightlyReconciliation") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const filters = input.viewKey === "nightlyReconciliation" ? { section: "reconciliation" as const } : input.filters;
          if ("proposalRequestKey" in filters && filters.proposalRequestKey !== undefined && auth.role !== "reviewer")
            return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
          const result = await controls.read(filters, `agent-${auth.role}`, auth.role, controlsCaller);
          const held = result.stale || result.partial || result.empty;
          const envelope = { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.stale ? "stale" : result.partial ? "partial" : result.empty ? "empty" : "ready", data: result.data,
            sourceFreshness: [], coverage: { expectedCount: 1, observedCount: result.empty ? 0 : 1, missingCount: result.empty ? 1 : 0,
              complete: !held, reasonCodes: held ? ["OPERATIONS_CONTROL_SOURCE_REVIEW_REQUIRED"] : [] },
            capabilities: result.capabilities.map(capability => ({ ...capability,
              state: auth.role === "reviewer" ? capability.state : "denied",
              reasonCodes: auth.role === "reviewer" ? capability.reasonCodes : ["REVIEWER_REQUIRED"] })),
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } };
          result.assertCurrent();
          return reply(res, 200, envelope);
        }
        if (input.viewKey === "contentMonitor" || input.viewKey === "watchlist" || input.viewKey === "hourlyRun" || input.viewKey === "postPerformance") {
          const result = await monitor.read(input.viewKey, input.filters,
            { cursor: input.page.cursor, limit: input.page.limit, authorizationContext: auth.role }, monitorCaller);
          result.assertCurrent();
          if (result.data === null) return reply(res, 404, { code: "RECORD_NOT_FOUND", executionCertainty: "notApplied" });
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(result.data),
            dataState: result.stale ? "stale" : result.partial ? "partial" : result.total ? "ready" : "empty", data: result.data,
            sourceFreshness: [], coverage: { expectedCount: result.total, observedCount: result.returned,
              missingCount: result.total - result.returned, complete: !result.partial && !result.stale,
              reasonCodes: result.partial || result.stale ? ["MONITOR_SOURCE_COVERAGE_UNVERIFIED"] : [] },
            capabilities: result.capabilities.map(capability => ({ ...capability,
              state: auth.role === "reviewer" ? capability.state : "denied",
              reasonCodes: auth.role === "reviewer" ? capability.reasonCodes : ["REVIEWER_REQUIRED"] })),
            page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "inventoryOverview" || input.viewKey === "supportWorkspace") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          if (input.filters.proposalRequestKey !== undefined && auth.role !== "reviewer")
            return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
          const result = await stockSupport.read(input.viewKey, input.filters, `agent-${auth.role}`, stockCaller);
          result.assertCurrent();
          if (result.data === null) return reply(res, 404, { code: "RECORD_NOT_FOUND", executionCertainty: "notApplied" });
          const held = result.stale || result.partial || result.empty;
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.stale ? "stale" : result.partial ? "partial" : result.empty ? "empty" : "ready", data: result.data,
            sourceFreshness: [], coverage: { expectedCount: 1, observedCount: result.empty ? 0 : 1, missingCount: result.empty ? 1 : 0,
              complete: !held, reasonCodes: held ? ["SOURCE_STOCK_SUPPORT_REVIEW_REQUIRED"] : [] },
            capabilities: [{ actionKind: input.viewKey === "inventoryOverview" ? "requestStockTransfer" : "requestSupportHandoff",
              state: auth.role !== "reviewer" ? "denied" : held ? "held" : "available",
              reasonCodes: auth.role !== "reviewer" ? ["REVIEWER_REQUIRED"] : held ? ["SOURCE_STOCK_SUPPORT_REVIEW_REQUIRED"] : ["LOCAL_PROPOSAL_ONLY"] }],
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "socialCatBoard" || input.viewKey === "tiktokBoard" || input.viewKey === "socialCatDashboard" || input.viewKey === "tiktokDashboard") {
          const result = readCreatorPlatformView({ viewKey: input.viewKey, filters: input.filters, db: store.database, funnel,
            scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, secret: operationsSecret,
            role: auth.role, limit: input.page.limit, cursor: input.page.cursor, now: options.operations?.now });
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(result.data),
            dataState: result.nextCursor || result.data.sourceOutages || result.data.unknownStates ? "partial" : result.total ? "ready" : "empty", data: result.data,
            sourceFreshness: [], coverage: { expectedCount: result.total, observedCount: result.returned, missingCount: result.total - result.returned,
              complete: false, reasonCodes: ["SAVED_LEDGER_ONLY", "PROVIDER_UNIVERSE_UNKNOWN", ...(result.nextCursor ? ["SNAPSHOT_PAGE_PARTIAL"] : [])] },
            capabilities: [], page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "scheduleDetail") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const data = schedules.read(input.filters.jobId);
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data),
            dataState: data ? "ready" : "empty", data, sourceFreshness: [],
            coverage: { expectedCount: 1, observedCount: data ? 1 : 0, missingCount: data ? 0 : 1, complete: Boolean(data),
              reasonCodes: data ? [] : ["SCHEDULE_JOB_NOT_FOUND"] },
            capabilities: [{ actionKind: "saveScheduleDraft", state: auth.role === "reviewer" ? "available" : "denied",
              reasonCodes: auth.role === "reviewer" ? [] : ["REVIEWER_REQUIRED"] },
              { actionKind: "enableSchedule", state: "held", reasonCodes: ["SCHEDULE_ACTIVATION_NOT_CONNECTED"] }],
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if ((input.viewKey === "invitationDraft" || input.viewKey === "batchDetail") && "context" in input.filters && input.filters.context === "recruitment") {
          if (input.page.cursor !== null || input.period !== null || input.sort.length) return reply(res, 400, { code: "RECRUITMENT_READ_SCOPE_INVALID", executionCertainty: "notApplied" });
          const principal = { principalRef: `agent-${auth.role}` };
          const result = input.viewKey === "invitationDraft" ? await recruitmentWorkspace.readInvitation(input.filters, principal) : await recruitmentWorkspace.readBatch(input.filters, principal);
          const currentAuth = authorize(req);
          if (!currentAuth || currentAuth.role !== auth.role) return reply(res, currentAuth ? 403 : 401, { code: "RECRUITMENT_AUTHORITY_CHANGED", executionCertainty: "notApplied" });
          const data = result.data;
          const capability = (actionKind: string, allowed: boolean) => ({ actionKind, state: auth.role !== "reviewer" ? "denied" : allowed && data.sourceState === "current" ? "available" : "held", reasonCodes: auth.role !== "reviewer" ? ["REVIEWER_REQUIRED"] : allowed && data.sourceState === "current" ? [] : ["RECRUITMENT_CURRENT_EVIDENCE_REQUIRED"] });
          const capabilities = data.kind === "native-invitation" ? [capability("saveRecruitmentInvitation", data.canSaveDraft), capability("recruitment.invitation", data.canPreview)]
            : [capability("pauseRun", data.run.control === "active" && !["completed", "cancelled"].includes(data.run.current.state)), capability("cancelUnsent", data.run.control !== "cancelled" && data.run.current.state !== "completed")];
          const count = data.kind === "native-recruitment-batch" ? data.coverage : {returned: 1, total: 1, complete: data.sourceState === "current"};
          const envelope = { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data),
            dataState: data.sourceState === "current" ? "ready" : "partial", data, sourceFreshness: [],
            coverage: {expectedCount: count.total, observedCount: count.returned, missingCount: count.total - count.returned, complete: count.complete, reasonCodes: data.reasonCodes},
            capabilities, page: {nextCursor: null, hasMore: false}, refresh: {nextPollAfterMs: null} };
          const finalAuth = authorize(req);
          if (!finalAuth || finalAuth.role !== auth.role) return reply(res, finalAuth ? 403 : 401, {code: "RECRUITMENT_AUTHORITY_CHANGED", executionCertainty: "notApplied"});
          result.assertCurrent();
          return reply(res, 200, envelope);
        }
        if (input.viewKey === "batchDetail" && "context" in input.filters && input.filters.context === "bulk") {
          if (input.page.cursor !== null || input.period !== null || input.sort.length)
            return reply(res, 400, {code:"BULK_READ_SCOPE_INVALID",executionCertainty:"notApplied"});
          const result = await bulkWorkspace.read({batchRef:input.filters.batchRef,batchVersion:input.filters.batchVersion}, {principalRef:`agent-${auth.role}`});
          const data = result.data;
          const capabilities = [...new Set(data.groups.map(group => group.actionKind))].map(actionKind => {
            const available = data.groups.some(group => group.actionKind === actionKind && group.preview && !group.approval);
            return {actionKind,state:auth.role !== "reviewer" ? "denied" : available ? "available" : "held",
              reasonCodes:auth.role !== "reviewer" ? ["REVIEWER_REQUIRED"] : available ? [] : ["BULK_REVIEW_ORIGINAL_MANIFEST"]};
          });
          const envelope = {schemaVersion:ADAPTER_SCHEMA,requestId:input.requestId,
            scope:{...input.requestedScope,authorizationScopeVersion:"creator-agent.scope.v1"},dataVersion:versionOfData(data),
            dataState:"ready",data,sourceFreshness:[],coverage:{expectedCount:data.rows.length,observedCount:data.rows.length,missingCount:0,complete:true,reasonCodes:[]},
            capabilities,page:{nextCursor:null,hasMore:false},refresh:{nextPollAfterMs:null}};
          const finalAuth = authorize(req);
          if (!finalAuth || finalAuth.role !== auth.role) return reply(res, finalAuth ? 403 : 401, {code:"BULK_AUTHORITY_CHANGED",executionCertainty:"notApplied"});
          result.assertCurrent();
          return reply(res,200,envelope);
        }
        if (input.viewKey === "batchDetail") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const projections: CommercialProjection[] = [], basisFences: (() => void)[] = [];
          const data = readScorecardPreview(store, scorecardPreviewFilters.parse(input.filters).selection, current, (member, assessment) => {
            const captured = structuredClone(assessment);
            basisFences.push(() => assertCommercialBasis(member.creatorId, member.runId, captured));
            const projection = commercialProjection.project({ creatorId: member.creatorId, offerId: member.offerId,
              offerVersion: member.offerVersion, phase: member.phase ?? "invitation", assessment });
            projections.push(projection); return projection.data;
          });
          const unavailable = data.items.filter(item => item.status === "unavailable").length;
          const partial = unavailable > 0 || data.items.some(item => item.stale);
          for (const projection of projections) projection.assertCurrent();
          for (const assertBasis of basisFences) assertBasis();
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data),
            dataState: !data.items.length ? "empty" : partial ? "partial" : "ready", data,
            sourceFreshness: [], coverage: { expectedCount: data.items.length, observedCount: data.items.length - unavailable, missingCount: unavailable,
              complete: !partial, reasonCodes: partial ? ["REVIEW_EXACT_RUN_OR_CHANGED_PROOF"] : [] },
            capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "recruitmentQueue") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const source = await recruitment.read(input.filters, `agent-${auth.role}`, input.page.limit), projections: CommercialProjection[] = [];
          const snapshot = source.snapshot, basisFences: (() => void)[] = [];
          const rows = snapshot.rows.map(row => {
            const stored = row.runId === null ? null : store.findRun(row.creatorId, row.runId);
            const basis = stored ? commercialBasis(stored) : null;
            if (row.runId !== null) { const runId = row.runId, captured = structuredClone(basis); basisFences.push(() => assertCommercialBasis(row.creatorId, runId, captured)); }
            const projection = commercialProjection.project({ creatorId: row.creatorId, offerId: row.offerId ?? undefined,
              offerVersion: row.offerVersion ?? undefined, phase: row.phase, assessment: basis });
            projections.push(projection);
            return { opportunityRef: recruitment.alias("opportunity", row.opportunityRef), creatorId: row.creatorId, runId: row.runId,
              offerId: row.offerId, offerVersion: row.offerVersion, phase: row.phase, network: row.network, route: row.route,
              assessment: stored && basis ? { state: basis.state!, score: stored.assessment.score?.total ?? null, stale: basis.stale } : null,
              commercialEligibility: projection.data };
          });
          const data = nativeRecruitmentViewSchema.parse({ kind: "native-recruitment", filters: input.filters, observedAt: snapshot.observedAt,
            validUntil: snapshot.validUntil, sourceAlias: recruitment.alias("source", snapshot.sourceRef), rows,
            coverage: { returned: rows.length, total: snapshot.total, complete: snapshot.complete }, dispatchAuthorized: false });
          source.assertCurrent(); for (const projection of projections) projection.assertCurrent(); source.assertCurrent();
          for (const assertBasis of basisFences) assertBasis();
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data),
            dataState: !snapshot.complete ? "partial" : rows.length ? "ready" : "empty", data, sourceFreshness: [],
            coverage: { expectedCount: snapshot.total, observedCount: rows.length, missingCount: snapshot.total === null ? null : snapshot.total - rows.length,
              complete: snapshot.complete, reasonCodes: snapshot.complete ? [] : ["RECRUITMENT_SOURCE_PARTIAL"] },
            capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "offerDraft" || input.viewKey === "offerRewards") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const original = input.viewKey === "offerDraft" ? offers.readOffer(input.filters.offerId) : offers.readRewards(input.filters.offerId);
          const projection = input.viewKey === "offerDraft" && original?.kind === "agent-offer" ? commercialProjection.project({ creatorId: original.terms.creatorId,
            offerId: input.filters.offerId, offerVersion: input.filters.offerVersion, phase: input.filters.phase ?? "invitation" }) : null;
          const recovery = input.viewKey === "offerDraft" && input.filters.saveRequest ? offers.readSaveRequest(input.filters.offerId, input.filters.saveRequest.expectedVersion, input.filters.saveRequest.requestKey, input.filters.saveRequest.payloadDigest) : undefined;
          const data = original?.kind === "agent-offer" && projection ? { ...original, commercialEligibility: projection.data, ...(recovery ? {saveRecovery: recovery} : {}) } : original;
          const gaps = data?.kind === "agent-offer" ? data.blockers : data?.unknowns ?? [];
          const stale = data?.kind === "agent-offer" && data.assessment !== null && !data.assessmentCurrent;
          const recoveryHash = recovery ? digest(recovery) : null;
          projection?.assertCurrent();
          if (input.viewKey === "offerDraft" && input.filters.saveRequest && digest(offers.readSaveRequest(input.filters.offerId, input.filters.saveRequest.expectedVersion, input.filters.saveRequest.requestKey, input.filters.saveRequest.payloadDigest)) !== recoveryHash)
            throw new OfferPolicyError("OFFER_SAVE_RECOVERY_CHANGED", {status: 409, reasonCodes: ["OFFER_SAVE_RECOVERY_CHANGED"]});
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data),
            dataState: !data ? "empty" : stale ? "stale" : gaps.length ? "partial" : "ready", data,
            sourceFreshness: [], coverage: { expectedCount: 1, observedCount: data ? 1 : 0, missingCount: data ? 0 : 1,
              complete: Boolean(data) && !gaps.length && !stale, reasonCodes: [...(stale ? ["STALE_ASSESSMENT"] : []), ...gaps] },
            capabilities: [{ actionKind: "saveOfferDraft", state: auth.role === "reviewer" ? "available" : "denied",
              reasonCodes: auth.role === "reviewer" ? [] : ["REVIEWER_REQUIRED"] }],
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "pipelineSummary" || input.viewKey === "pipelineBranches") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const data = funnel.read(input.filters);
          const { opportunities, incomplete } = data.coverage;
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data),
            dataState: opportunities === 0 ? "empty" : incomplete ? "partial" : "ready", data,
            sourceFreshness: [], coverage: { expectedCount: null, observedCount: opportunities, missingCount: null, complete: false,
              reasonCodes: incomplete ? ["FUNNEL_COVERAGE_INCOMPLETE"] : opportunities === 0 ? ["NO_RECORDED_OPPORTUNITIES"] : [] },
            capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "connectionsOverview" || input.viewKey === "channelCapabilities" || input.viewKey === "automationRuns") {
          const result = readOperationsView({ viewKey: input.viewKey, db: store.database, ledger: operations.ledger, jobs: operations.jobs,
            scope: { workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, secret: operationsSecret,
            authorizationContext: `creator-agent.scope.v1:${auth.role}`, filters: input.filters,
            limit: input.page.limit, cursor: input.page.cursor, now: options.operations?.now, health: providerHealth });
          const expectedCount = result.total + (result.data.kind === "saved-runs" ? result.data.jobCoverage.total : 0);
          const observedCount = result.returned + (result.data.kind === "saved-runs" ? result.data.jobCoverage.returned : 0);
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(result.data),
            dataState: result.partial ? "partial" : "ready", data: result.data, sourceFreshness: [],
            coverage: { expectedCount, observedCount, missingCount: expectedCount - observedCount, complete: !result.partial,
              reasonCodes: result.partial ? ["SAVED_OPERATIONS_TRUNCATED"] : [] },
            capabilities: [], page: { nextCursor: result.nextCursor, hasMore: result.hasMore }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "collaborationEvidence") {
          let canonicalId = input.filters.collaborationId;
          if (canonicalId.startsWith("collab1-")) {
            try { canonicalId = openCollaborationRef({ workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox" }, operationsSecret, canonicalId); }
            catch { return reply(res, 400, { code: "INVALID_COLLABORATION_REFERENCE", executionCertainty: "notApplied" }); }
          }
          const result = await readCollaborationEvidence({ collaborationId: canonicalId, cursor: input.page.cursor, limit: input.page.limit });
          result.data.collaborationId = input.filters.collaborationId;
          const observed = result.data.records.length;
          const remaining = result.data.total - result.data.offset - observed;
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(result.data),
            dataState: result.data.offset > 0 || remaining > 0 ? "partial" : "ready", data: result.data, sourceFreshness: [],
            coverage: { expectedCount: result.data.total, observedCount: observed, missingCount: result.data.total - observed,
              complete: result.data.offset === 0 && remaining === 0, reasonCodes: result.data.offset > 0 || remaining > 0 ? ["SNAPSHOT_PAGE_PARTIAL"] : [] },
            capabilities: [], page: { nextCursor: result.nextCursor, hasMore: result.data.hasMore }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "collaborationDetail") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          if (input.filters.proposalRequestKey !== undefined && auth.role !== "reviewer")
            return reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" });
          const result = await collaborationWorkflow.read(input.filters.collaborationId,
            { requestKey: input.filters.proposalRequestKey, actorRef: `agent-${auth.role}`, ...collaborationCaller });
          result.assertCurrent();
          if (result.data === null) return reply(res, 404, { code: "RECORD_NOT_FOUND", executionCertainty: "notApplied" });
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.stale ? "stale" : result.partial ? "partial" : "ready", data: result.data, sourceFreshness: [],
            coverage: { expectedCount: 1, observedCount: 1, missingCount: 0, complete: !result.partial && !result.stale,
              reasonCodes: [...(result.stale ? ["SOURCE_OBSERVATION_STALE"] : []), ...(result.partial ? ["SOURCE_OR_PROPOSAL_COVERAGE_PARTIAL"] : [])] },
            capabilities: result.capabilities.map(capability => auth.role === "reviewer" ? capability : { ...capability, state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] }),
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if(input.viewKey==="fulfillmentProposal") {
          if(input.page.cursor!==null)return reply(res,400,{code:"INVALID_CURSOR",executionCertainty:"notApplied"});
          const cancel=new AbortController();res.once("close",()=>{if(!res.writableEnded)cancel.abort();});
          const result=await fulfillment.read(input.filters,{principalRef:`agent-${auth.role}`},cancel.signal);
          const currentAuth=authorize(req);
          if(!currentAuth || currentAuth.role!==auth.role)return reply(res,currentAuth?403:401,{code:"FULFILLMENT_AUTHORITY_CHANGED",executionCertainty:"notApplied"});
          result.assertCurrent();
          return reply(res,200,{schemaVersion:ADAPTER_SCHEMA,requestId:input.requestId,scope:{...input.requestedScope,authorizationScopeVersion:"creator-agent.scope.v1"},
            dataVersion:result.data.version,dataState:"ready",data:result.data,sourceFreshness:[],coverage:{complete:true,expectedCount:1,observedCount:1,missingCount:0,reasonCodes:[]},
            capabilities:[{actionKind:"previewFulfillmentDecision",state:auth.role==="reviewer"?result.data.capability.state:"denied",reasonCodes:auth.role==="reviewer"?result.data.capability.reasonCodes:["REVIEWER_REQUIRED"]}],
            page:{nextCursor:null,hasMore:false},refresh:{nextPollAfterMs:null}});
        }
        if(input.viewKey==="ledgerExportRequest" || input.viewKey==="ledgerExportArtifact") {
          if(input.page.cursor!==null)return reply(res,400,{code:"INVALID_CURSOR",executionCertainty:"notApplied"});
          const actor={principalRef:`agent-${auth.role}`};
          const cancel=new AbortController();res.once("close",()=>{if(!res.writableEnded)cancel.abort();});
          const result=await boundedSourceRead<{data:unknown;assertCurrent:()=>void}>(()=>input.viewKey==="ledgerExportRequest"?actionFoundation.domains.readExportRequest(input.filters,actor):(async()=>{
            const artifact=await actionFoundation.domains.downloadExport((input.filters as {artifactRef:string}).artifactRef,actor);
            return {data:ledgerExportArtifactViewSchema.parse({kind:"native-ledger-export-artifact",receipt:artifact.receipt,body:artifact.body}),assertCurrent:artifact.assertCurrent};
          })(),cancel.signal);
          const currentAuth=authorize(req);
          if(!currentAuth || currentAuth.role!==auth.role)return reply(res,currentAuth?403:401,{code:"EXPORT_AUTHORITY_CHANGED",executionCertainty:"notApplied"});
          result.assertCurrent();
          return reply(res,200,{schemaVersion:ADAPTER_SCHEMA,requestId:input.requestId,scope:{...input.requestedScope,authorizationScopeVersion:"creator-agent.scope.v1"},
            dataVersion:versionOfData(result.data),dataState:"ready",data:result.data,sourceFreshness:[],coverage:{expectedCount:1,observedCount:1,missingCount:0,complete:true,reasonCodes:[]},
            capabilities:[],page:{nextCursor:null,hasMore:false},refresh:{nextPollAfterMs:null}});
        }
        if((options.settlements || !options.financeSource) && (settlementViews as readonly string[]).includes(input.viewKey)) {
          if(!options.settlements?.source)return reply(res,503,{code:"INTEGRATION_PENDING",reasonCodes:["SETTLEMENT_SOURCE_UNCONFIGURED"],executionCertainty:"notApplied"});
          const cancel=new AbortController();res.once("close",()=>{if(!res.writableEnded)cancel.abort();});
          const result=await settlements.read(input.viewKey as typeof settlementViews[number],input.filters,{principalRef:`agent-${auth.role}`,role:auth.role},input.page,cancel.signal);
          const currentAuth=authorize(req);
          if(!currentAuth || currentAuth.role!==auth.role)return reply(res,currentAuth?403:401,{code:"SOURCE_ROLE_CHANGED",executionCertainty:"notApplied"});
          result.assertCurrent();
          if(input.viewKey!=="commissionLedger" && result.empty && !result.partial && !result.stale)return reply(res,404,{code:"RECORD_NOT_FOUND",executionCertainty:"notApplied"});
          const count=result.data.kind==="native-commission-ledger"?result.data.records.length:result.data.record?1:0;
          const complete=!result.partial&&!result.stale&&result.nextCursor===null&&count===result.total;
          return reply(res,200,{schemaVersion:ADAPTER_SCHEMA,requestId:input.requestId,scope:{...input.requestedScope,authorizationScopeVersion:"creator-agent.scope.v1"},dataVersion:result.version,
            dataState:result.data.source.state==="unconfigured"?"unavailable":result.stale?"stale":result.empty?"empty":!complete?"partial":"ready",data:result.data,sourceFreshness:[],
            coverage:{expectedCount:result.total,observedCount:count,missingCount:result.total===null?null:result.total-count,complete,reasonCodes:complete?[]:result.stale?["SOURCE_STALE"]:["SOURCE_PARTIAL"]},
            capabilities:[{actionKind:"exportLedger",state:result.data.capabilities.export?"available":"held",reasonCodes:result.data.capabilities.export?[]:["NAMED_SOURCE_AUTHORITY_REQUIRED"]},
              {actionKind:"settlement.matchStatement",state:result.data.capabilities.match?"available":"held",reasonCodes:result.data.capabilities.match?[]:["NAMED_SOURCE_AUTHORITY_REQUIRED"]}],
            page:{nextCursor:result.nextCursor,hasMore:result.nextCursor!==null},refresh:{nextPollAfterMs:null}});
        }
        if (isFinanceViewKey(input.viewKey)) {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const cancel = new AbortController();
          res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
          const result = await finance.read(input.viewKey, input.filters, {principalRef: `agent-${auth.role}`, role: auth.role}, cancel.signal);
          const currentAuth = authorize(req);
          if (!currentAuth || currentAuth.role !== auth.role) return reply(res, currentAuth ? 403 : 401, { code: currentAuth ? "SOURCE_ROLE_CHANGED" : "UNAUTHENTICATED", executionCertainty: "notApplied" });
          result.assertCurrent();
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.dataState, data: result.data, sourceFreshness: result.sourceFreshness, coverage: result.coverage,
            capabilities: result.capabilities, page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (isOperationsReadViewKey(input.viewKey)) {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const cancel = new AbortController();
          res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
          const result = await operationsReads.read(input.viewKey, input.filters, {principalRef: `agent-${auth.role}`, role: auth.role}, cancel.signal);
          const currentAuth = authorize(req);
          if (!currentAuth || currentAuth.role !== auth.role) return reply(res, currentAuth ? 403 : 401, { code: currentAuth ? "SOURCE_ROLE_CHANGED" : "UNAUTHENTICATED", executionCertainty: "notApplied" });
          result.assertCurrent();
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.dataState, data: result.data, sourceFreshness: result.sourceFreshness, coverage: result.coverage,
            capabilities: result.capabilities, page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (isTeamInvitationReadViewKey(input.viewKey)) {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const cancel = new AbortController();
          res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
          const result = await teamInvitationReads.read(input.viewKey, input.filters, {principalRef: `agent-${auth.role}`, role: auth.role}, cancel.signal);
          const currentAuth = authorize(req);
          if (!currentAuth || currentAuth.role !== auth.role) return reply(res, currentAuth ? 403 : 401, { code: currentAuth ? "SOURCE_ROLE_CHANGED" : "UNAUTHENTICATED", executionCertainty: "notApplied" });
          result.assertCurrent();
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: result.dataState, data: result.data, sourceFreshness: result.sourceFreshness, coverage: result.coverage,
            capabilities: result.capabilities, page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } });
        }
        if (input.viewKey === "shippingHub") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const cancel = new AbortController();
          res.once("close", () => { if (!res.writableEnded) cancel.abort(); });
          const result = await shippingHub.read({ principalRef: `agent-${auth.role}`, role: auth.role }, input.page.limit, cancel.signal);
          const coverage = result.data.provenance.coverage;
          const envelope = { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: result.version,
            dataState: coverage.state === "complete" ? result.data.shipments.length === 0 ? "empty" : "ready" : "partial", data: result.data,
            sourceFreshness: [], coverage: { expectedCount: coverage.expectedCount, observedCount: coverage.observedCount,
              missingCount: coverage.expectedCount === null ? null : coverage.expectedCount - coverage.observedCount,
              complete: coverage.state === "complete", reasonCodes: coverage.reasonCodes },
            capabilities: [{ actionKind: "purchaseLabel", state: "held", reasonCodes: ["FULFILLMENT_EXACT_ACTION_REQUIRED"] }],
            page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } };
          result.assertCurrent();
          return reply(res, 200, envelope);
        }
        if (input.viewKey === "discoverySummary") {
          const cursor = input.page.cursor === null ? null : decodeCursor(input.page.cursor, input.page.limit);
          const listing = store.listLatestPage({ limit: input.page.limit, snapshot: cursor ? { rowId: cursor.rowId, anchorRunId: cursor.anchorRunId } : undefined, after: cursor?.after });
          const offset = cursor?.offset ?? 0;
          if (cursor && (cursor.total !== listing.total || offset >= listing.total || offset + listing.records.length > listing.total || listing.hasMore !== (offset + listing.records.length < listing.total))) throw new AgentConflict("CURSOR_SNAPSHOT_UNAVAILABLE");
          const records = listing.records.map((stored) => ({ ...current(stored, stored.superseded), superseded: stored.superseded }));
          const now = Date.now();
          const snapshot = { id: cursor?.snapshotId ?? randomUUID(), asOf: cursor?.asOf ?? new Date(now).toISOString(), expiresAt: new Date(cursor?.expiresAt ?? now + CURSOR_TTL_MS).toISOString(), offset, limit: input.page.limit, returnedCount: records.length, total: listing.total };
          const nextCursor = listing.hasMore && listing.lastPosition ? encodeCursor({ version: 1, workspaceId: options.workspaceId, accountId: options.accountId, environment: "sandbox", contextHash: cursorContext(),
            snapshotId: snapshot.id, asOf: snapshot.asOf, expiresAt: Date.parse(snapshot.expiresAt), rowId: listing.snapshot.rowId, anchorRunId: listing.snapshot.anchorRunId!, total: listing.total,
            offset: offset + records.length, limit: input.page.limit, after: listing.lastPosition }) : null;
          const partial = listing.total > records.length;
          const models = (["website", "tiktok-shop"] as const).map((route) => {
            const binding = modelBinding(route);
            return {
              modelId: MODEL_FOR_ROUTE[route], status: binding ? "bound" as const : "unbound" as const,
              configVersion: binding?.current.version ?? null, configHash: binding?.hash ?? null,
              baselineHash: binding?.baselineHash ?? null, numericHash: binding?.numericHash ?? null,
              criteria: binding?.current.criteria ?? null, bands: binding?.current.bands ?? null,
              arithmetic: binding?.current.arithmetic ?? null, decisionRules: binding?.current.decisionRules ?? null,
            };
          });
          const data = agentSourcingSchema.parse({
            kind: "agent-sourcing", policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION, agentSchemaVersion: AGENT_SCHEMA_VERSION,
            records: records.map((record) => ({ creatorId: record.packet.creatorId, runId: record.runId, evidenceId: record.superseded ? null : record.packet.posts[0]?.postId ?? null,
              briefId: record.packet.briefId, checkoutRoute: record.packet.checkoutRoute, state: record.assessment.state, recordedAt: record.recordedAt, revision: record.revision, stale: record.stale, superseded: record.superseded })),
            models, total: listing.total, partial, snapshot,
          });
          const dataVersion = versionOfData(data);
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion, dataState: partial ? "partial" : records.some((record) => record.stale) ? "stale" : "ready", data,
            sourceFreshness: [], coverage: { expectedCount: listing.total, observedCount: records.length, missingCount: listing.total - records.length, complete: !partial, reasonCodes: partial ? ["SNAPSHOT_PAGE_PARTIAL"] : [] },
            capabilities: [{ actionKind: "startLiveDiscovery", state: "held", reasonCodes: ["SOURCE_AUTOMATION_NOT_CONNECTED"] }],
            page: { nextCursor, hasMore: listing.hasMore }, refresh: { nextPollAfterMs: null },
          });
        }
        if (input.viewKey === "assessmentRecord") {
          if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
          const stored = store.findRun(input.filters.creatorId, input.filters.assessmentId);
          if (!stored) return reply(res, 404, { code: "RECORD_NOT_FOUND" });
          const superseded = store.latest(input.filters.creatorId)?.runId !== stored.runId;
          const record = current(stored, superseded);
          const basis = commercialBasis(stored);
          const projection = commercialProjection.project({ creatorId: stored.packet.creatorId, offerId: input.filters.offerId,
            offerVersion: input.filters.offerVersion, phase: input.filters.phase ?? "invitation", assessment: basis });
          const data = agentAssessmentRecordSchema.parse({
            kind: "creator-v3", creatorId: stored.packet.creatorId, assessmentId: stored.runId, runId: stored.runId,
            evidenceId: superseded ? null : stored.packet.posts[0]?.postId ?? null,
            qualification: record.assessment, assessedQualification: stored.assessment, agentEvidence: record.packet,
            recordedAt: stored.recordedAt, revision: stored.revision, stale: record.stale, superseded,
            commercialEligibility: projection.data,
          });
          projection.assertCurrent();
          assertCommercialBasis(stored.packet.creatorId, stored.runId, basis);
          return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
            scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data), dataState: record.stale ? "stale" : "ready", data,
            sourceFreshness: [], coverage: { expectedCount: 3, observedCount: record.assessment.packet.qualifyingPosts, missingCount: Math.max(0, 3 - record.assessment.packet.qualifyingPosts), complete: record.assessment.contentQualification === "pass", reasonCodes: record.assessment.reasonCodes },
            capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null },
          });
        }
        if (input.viewKey !== "evidenceRecord") return reply(res, 400, { code: "UNSUPPORTED_OPERATION", executionCertainty: "notApplied" });
        if (input.page.cursor !== null) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
        const record = evidenceReviews.read(input.filters.creatorId, input.filters.evidenceId, input.filters.runId);
        if (!record) return reply(res, 404, { code: "RECORD_NOT_FOUND", executionCertainty: "notApplied" });
        const data = record.data;
        return reply(res, 200, { schemaVersion: ADAPTER_SCHEMA, requestId: input.requestId,
          scope: { ...input.requestedScope, authorizationScopeVersion: "creator-agent.scope.v1" }, dataVersion: versionOfData(data), dataState: record.stale ? "stale" : "ready", data,
          sourceFreshness: [], coverage: { expectedCount: 3, observedCount: data.qualification.packet.qualifyingPosts, missingCount: Math.max(0, 3 - data.qualification.packet.qualifyingPosts), complete: data.qualification.contentQualification === "pass", reasonCodes: data.qualification.reasonCodes },
          capabilities: ["saveEvidenceDraft", "recordDisagreement"].map(actionKind => ({ actionKind, state: auth.role !== "reviewer" ? "denied" : record.canAnnotate ? "available" : "held",
            reasonCodes: auth.role !== "reviewer" ? ["REVIEWER_REQUIRED"] : record.canAnnotate ? [] : ["REVIEW_CURRENT_EVIDENCE_OR_LIMIT"] })).concat([{ actionKind: "markWatched", state: "held", reasonCodes: ["J20_SOURCE_REVIEW_REQUIRED"] }]),
          page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null },
        });
      }
      return reply(res, 404, { code: "UNSUPPORTED_OPERATION", executionCertainty: "notApplied" });
    } catch (error) {
      if (error instanceof SiteTrafficApiError) return reply(res, error.status, { code: error.code, executionCertainty: error.executionCertainty,
        ...(error.retryAfterMs === null ? {} : { retryAfterMs: error.retryAfterMs }) });
      if (error instanceof SiteTrafficError) return reply(res, error.status, { code: error.code,
        executionCertainty: new URL(req.url ?? "/", "http://localhost").pathname === "/v1/site-traffic/import" ? "uncertain" : "notApplied" });
      if(error instanceof ReportError) return reply(res,error.status,{code:error.code,executionCertainty:error.executionCertainty,
        ...(error.retryAfterMs===null?{}:{retryAfterMs:error.retryAfterMs})});
      if (error instanceof CommercialProjectionError || error instanceof RecruitmentSourceError)
        return reply(res, error.status, { code: error.code, executionCertainty: error.executionCertainty });
      if (error instanceof RuntimeError) return reply(res, error.status, { code: error.code, executionCertainty: error.executionCertainty,
        ...(error instanceof RuntimeApiError && error.retryAfterMs !== null ? { retryAfterMs: error.retryAfterMs } : {}) });
      if (error instanceof ActionServiceError || error instanceof DispatchError) return reply(res,
        error.executionCertainty === "uncertain" && ![401, 403, 429].includes(error.status) ? 502 : error.status,
        { code: error.executionCertainty === "uncertain" && ![401, 403, 429].includes(error.status) ? "OUTCOME_UNCERTAIN" : error.code,
          executionCertainty: error.executionCertainty,
          ...(error instanceof ActionServiceError && error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
          ...(error instanceof DispatchError && error.retryAfterMs !== null ? { retryAfterMs: error.retryAfterMs } : {}) });
      if (error instanceof ApprovalError) {
        const denied = ["AUTHORITY_REQUIRED", "SLACK_ACTOR_MISMATCH", "APPROVAL_INGRESS_UNVERIFIED", "FOUNDER_REQUIRED", "SECOND_PERSON_REQUIRED"].includes(error.code);
        return reply(res, denied ? 403 : 502, { code: denied ? "FORBIDDEN" : "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" });
      }
      if (error instanceof OfferPolicyError) return reply(res, error.status, { code: error.code, reasonCodes: error.reasonCodes,
        rowIndex: error.rowIndex, executionCertainty: error.executionCertainty });
      if (error instanceof BulkError) return reply(res, error.status, {code:error.code,executionCertainty:error.executionCertainty});
      if (error instanceof RecruitmentError) return reply(res, error.status, {code: error.code, executionCertainty: error.executionCertainty, ...(error.currentVersion === undefined ? {} : {currentVersion: error.currentVersion})});
      if (error instanceof ShippingHubReadError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied" });
      if (error instanceof LifecycleError) return reply(res, error.status, { code: error.code, executionCertainty: error.executionCertainty,
        ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
        ...(error.fieldErrors === undefined ? {} : { fieldErrors: error.fieldErrors }) });
      if (error instanceof OperationsControlError) return reply(res, error.status, { code: error.code, executionCertainty: error.executionCertainty ?? "notApplied",
        ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
      if(error instanceof OperationsAuthorityError)return reply(res,error.status,{code:error.code,executionCertainty:error.executionCertainty});
      if (error instanceof FulfillmentError) return reply(res,error.status,{code:error.code,executionCertainty:error.executionCertainty});
      if (error instanceof SettlementError) return reply(res,error.status,{code:error.code,executionCertainty:error.executionCertainty});
      if (error instanceof FinanceError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied",
        ...(error.reasonCodes.length ? { reasonCodes: error.reasonCodes } : {}) });
      if (error instanceof OperationsReadError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied",
        ...(error.reasonCodes.length ? { reasonCodes: error.reasonCodes } : {}) });
      if (error instanceof TeamInvitationReadError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied",
        ...(error.reasonCodes.length ? { reasonCodes: error.reasonCodes } : {}) });
      if (error instanceof NativeSourcingError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied" });
      if (error instanceof MonitorError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied" });
      if (error instanceof NativeAnalyticsError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied" });
      if (error instanceof StockSupportError) return reply(res, error.status, { code: error.code, executionCertainty: error.executionCertainty,
        ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
      if (error instanceof CollaborationWorkflowError) return reply(res, error.status, { code: error.code, executionCertainty: error.executionCertainty,
        ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
      if (error instanceof EvidenceReviewError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied",
        ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
      if (error instanceof OperationsCursorError) return reply(res, error.code === "OPERATIONS_CURSOR_EXPIRED" ? 409 : 400, { code: error.code, executionCertainty: "notApplied" });
      if (error instanceof ScheduleDraftError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied",
        ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
        ...(error.fieldErrors === undefined ? {} : { fieldErrors: error.fieldErrors }) });
      const operationStatus = operationsErrorStatus(error);
      if (operationStatus !== null && error instanceof Error) return reply(res, operationStatus, { code: error.message, executionCertainty: "notApplied" });
      if (error instanceof FunnelError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied" });
      if (error instanceof AssetRegistryReadError) return reply(res, error.status, { code: error.code, executionCertainty: "notApplied" });
      if (error instanceof InvalidCursor) return reply(res, 400, { code: "INVALID_CURSOR", executionCertainty: "notApplied" });
      if (error instanceof AgentConflict) return reply(res, 409, { code: error.message, executionCertainty: "notApplied" });
      if (error instanceof z.ZodError || error instanceof SyntaxError) return reply(res, 400, { code: "INVALID_INPUT", executionCertainty: "notApplied" });
      if (error instanceof Error && error.message === "BODY_TOO_LARGE") return reply(res, 413, { code: "BODY_TOO_LARGE", executionCertainty: "notApplied" });
      return reply(res, 500, { code: "AGENT_ERROR", executionCertainty: "uncertain" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  let closing: Promise<void> | undefined;
  return { server, store, operations, providerHealth, actionFoundation, runtime, runtimeApi, mediaDomain, close: () => closing ??= new Promise<void>((resolve, reject) => server.close((error) => {
    let failure: Error | undefined = error;
    try { operations.close(); } catch (cause) { failure ??= cause instanceof Error ? cause : new Error("OPERATIONS_CLOSE_FAILED"); }
    try { store.close(); } catch (cause) { failure ??= cause instanceof Error ? cause : new Error("STORE_CLOSE_FAILED"); }
    if (failure) reject(failure); else resolve();
  })) };
}
