import { AgentStore } from "../store.ts";
import { digest } from "../config.ts";
import { IntakeRepository, type IntakeAuthority, type IdentitySink } from "../intake/repository.ts";
import { intakeInputSchema, type SinkReceipt } from "../intake/contract.ts";
import { FunnelRepository } from "../funnelStore.ts";
import { PortfolioRepository, type StoredPortfolioReview } from "../portfolioStore.ts";
import { syntheticPortfolioPacket } from "../portfolioTestFixtures.ts";
import { createFinanceReader } from "../finance/reader.ts";
import { financeRecord, financeSnapshot } from "../finance/fixtures.testkit.ts";
import { FinanceError, type FinanceSourceReader } from "../finance/source.ts";
import { createOperationsReadReader } from "../operationsReads/reader.ts";
import { operationsRecord, operationsSnapshot } from "../operationsReads/fixtures.testkit.ts";
import { OperationsReadError, type OperationsReadSourceReader } from "../operationsReads/source.ts";
import { monitorFixture, monitorTestSource } from "../monitor/fixtures.testkit.ts";
import { createMonitorReader, MonitorError } from "../monitor/reader.ts";
import type { OperationsScope } from "../operations.ts";
import { nativeAnalyticsFixture } from "./nativeFixtures.testkit.ts";
import type { NativeAnalyticsSnapshot } from "./contract.ts";
import { composeOverviewOwners } from "./overviewOwners.ts";

/** Explicit fictional source owners; canonical intake and portfolio writes remain in
 * their existing repositories. No provider or reporting-policy qualification. */
export async function overviewOwnersFixture(options: { now?: () => number; scope?: OperationsScope } = {}) {
  const state = { now: Date.parse("2026-11-09T12:00:00Z"), allowed: true };
  const now = options.now ?? (() => state.now), at = now(), iso = (n: number) => new Date(n).toISOString();
  const scope = options.scope ?? { workspaceId: "fictional-overview-workspace", accountId: "fictional-overview-account", environment: "sandbox" as const };
  const principal = { principalRef: "agent-reader", role: "reader" as const };
  const end = Date.parse(iso(at).slice(0, 10)), period = { startAt: iso(end - 30 * 86_400_000), endAt: iso(end), timezone: "UTC", basis: "eventTime" as const };
  const cohortRef = "fictional-qualified-cohort", observedAt = iso(at), validUntil = iso(at + 10 * 60_000);
  const analytics = nativeAnalyticsFixture({ now, scope, principalRef: principal.principalRef });
  let portfolioReview: StoredPortfolioReview | null = null;
  const portfolioPacket = syntheticPortfolioPacket();
  portfolioPacket.campaignId = cohortRef;
  portfolioPacket.reviewWindow = { start: period.startAt, end: period.endAt };
  for (const creator of portfolioPacket.creators) {
    creator.next.dueAt = iso(at + 14 * 86_400_000); creator.next.nextReviewAt = iso(at + 21 * 86_400_000);
    for (const collaboration of creator.collaborations) {
      collaboration.campaignId = cohortRef;
      collaboration.posts[0]!.publishedAt = iso(end - 20 * 86_400_000);
      collaboration.retainedContribution.cents.value = 0;
    }
  }
  const monitor = { allowed: true, snapshot: monitorFixture(at) };
  monitor.snapshot.scope = scope;
  monitor.snapshot.posts = [monitor.snapshot.posts[0]!]; monitor.snapshot.runs = [];
  const post = monitor.snapshot.posts[0]!;
  post.campaign = cohortRef; post.publishedAt = iso(end - 20 * 86_400_000);
  post.measurements[0] = { ...post.measurements[0]!, at: observedAt, definition: "Fictional interval views", window: "Fictional exact reporting interval",
    semantics: "interval", reportingPeriod: period, views: 500, likes: 12, comments: 3, shares: 0 };
  post.attribution = { ...post.attribution!, reportingPeriod: period, orders: 0, net: { minorUnits: 0, currency: "USD" } };
  const monitorSource = monitorTestSource(() => { if (!monitor.allowed) throw new MonitorError("MONITOR_SOURCE_DENIED", 403); return monitor.snapshot; }, now);
  const sink = (name: string): IdentitySink => {
    const receipts = new Map<string, SinkReceipt>();
    return { upsert(key, _record, binding) { const receipt: SinkReceipt = { ...binding, state: "applied", receiptRef: `fictional-${name}:${key}`, observedAt, validUntil };
      receipts.set(key, receipt); return receipt; }, read(key, binding) { return receipts.get(key) ?? { ...binding, state: "notApplied", terminal: true,
        receiptRef: `fictional-${name}-absence:${binding.attemptId}`, observedAt }; } };
  };
  const intakeAuthority: IntakeAuthority = { route: () => "Ready", crosswalk: () => ({ version: "map-v1", entries: [] }),
    suppression: () => ({ version: "suppression-v1", entries: [] }), sinks: { "notion-creator-crm": sink("notion"), "sheets-watchlist": sink("sheets") } };
  async function seed(store: AgentStore) {
    const intake = new IntakeRepository(store.database, scope, intakeAuthority, () => new Date(now()));
    const ref = { source: "notion", accountId: scope.accountId, sourceId: cohortRef, url: null, canonicalId: cohortRef, identityState: "resolved", provenanceRef: "fictional-campaign-proof" };
    const input = intakeInputSchema.parse({ campaignRef: ref, briefRef: { ref: "fictional-brief", version: "v1" }, recruitmentSource: "social-cat", trigger: "signup", eventId: "fictional-overview-signup",
      sourceCandidate: { ...ref, source: "social-cat", accountId: "fictional-recruit-account", sourceId: "candidate-a", canonicalId: null, identityState: "unresolved", provenanceRef: "fictional-signup-receipt" },
      profileRefs: [{ source: "instagram", accountId: "publishing-a", sourceId: "profile-a", url: null, canonicalId: null, identityState: "unresolved", provenanceRef: "fictional-native-profile", handle: "fictional.maker", sourceUpdatedAt: observedAt }],
      occurredAt: observedAt, observedAt, publishingNetworks: ["instagram"], identityMapVersion: "map-v1", suppressionVersion: "suppression-v1", cursor: null });
    const key = "fictional-overview-intake";
    const result = await intake.ingest({ input, envelope: { jobId: "J01", jobVersion: "creator-intake.v1", mode: "observe", actor: { id: "fictional-reviewer", role: "reviewer" }, accountRef: { workspaceId: scope.workspaceId, accountId: scope.accountId },
      policyVersion: "commission-only-v1", inputHash: digest(input), idempotencyKey: key, correlationId: "fictional-overview", requestedAt: observedAt, deadline: null, checkpoint: null } }, key);
    const creator = result.creatorRef.canonicalId ?? result.creatorRef.sourceId!;
    const member = monitor.snapshot.members[0]!;
    member.creatorId = creator; member.revision = intake.creator(creator)!.revision; member.cohort = cohortRef; post.creatorId = creator;
    member.notionReceipt = result.handoffs.find(h => h.target === "notion-creator-crm")!.receiptRef!;
    member.sheetsReceipt = result.handoffs.find(h => h.target === "sheets-watchlist")!.receiptRef!;
    member.verification!.sheetsCanonicalReceipt = member.notionReceipt;
    const portfolio = new PortfolioRepository(store.database, { workspaceId: scope.workspaceId, accountId: scope.accountId });
    portfolioReview = await portfolio.review({ scope: { workspaceId: scope.workspaceId, accountId: scope.accountId }, expectedVersion: 0, packet: portfolioPacket }, "fictional-overview-review");
    return { intake, portfolio };
  }
  const store = new AgentStore(":memory:", scope), seeded = await seed(store);
  const initialMutate = (snapshot: NativeAnalyticsSnapshot) => {
    snapshot.validUntil = validUntil;
    for (const owner of snapshot.owners) owner.validUntil = validUntil;
    if (snapshot.viewKey === "overviewSummary") {
      snapshot.owners.push({ ...snapshot.owners[0]!, owner: "creatorPortfolio", proofRef: "fictional-proof-portfolio", sourceAsOf: observedAt, maxAgeMs: 15 * 60_000 });
      snapshot.facts.portfolio = { proofRef: "fictional-proof-portfolio", reviewKey: portfolioReview!.reviewKey, reviewHash: portfolioReview!.reviewHash };
      snapshot.facts.posts[0]!.shares = { value: 0, reason: null, proofRef: "fictional-proof-creatorActivity", evidenceRefs: ["fictional-interaction-evidence"] };
    }
    if (snapshot.viewKey === "attribution") snapshot.facts.creators[0]!.roi = { value: 1.2, reason: null, proofRef: "fictional-proof-economicCosts", evidenceRefs: ["fictional-creator-return-evidence"] };
  };
  analytics.state.mutate = initialMutate;
  const finance = { allowed: true, version: "fictional-finance-v1", record: financeRecord("financeDashboard"), validUntil, readAccessValidUntil: validUntil, afterRead: null as (() => void | Promise<void>) | null };
  const known = (value: unknown) => ({ state: "known", value, reasonCode: null, evidenceRefs: ["fictional-summary-evidence"], sourceRef: null, occurredAt: period.endAt, sourceUpdatedAt: observedAt, observedAt });
  finance.record = { ...finance.record, provenance: { ...(finance.record.provenance as object), observedAt }, cashAsOf: observedAt,
    cash: known(120000), burn: known(40000), burnWindowMonths: 3, burnHistoryMonths: 3, forecastRevenue: 15000,
    summaryContext: { period, source: "quickbooks", currency: "USD", accountingBasis: "accrual", policy: { state: "adopted", version: "fictional-policy-v1", evidenceRef: "fictional-policy-evidence" }, cashAsOf: observedAt, forecastState: "approved" } };
  const financePacket = (request: Parameters<FinanceSourceReader["read"]>[1], actor: Parameters<FinanceSourceReader["read"]>[2]["principal"]) => financeSnapshot(request.viewKey, {
    scope, version: `${finance.version}-${digest(request)}`, principalRef: actor.principalRef, observedAt, validUntil: finance.validUntil,
    readAccess: { observedAt, validUntil: finance.readAccessValidUntil }, record: finance.record,
  }, at);
  const financeSource: FinanceSourceReader = { async read(_scope, request, input) { const packet = structuredClone(financePacket(request, input.principal)); await finance.afterRead?.(); return packet; },
    assertCurrent(snapshot, binding) { if (!finance.allowed) throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403);
      if (digest(snapshot) !== digest(financePacket(binding.request, binding.principal))) throw new FinanceError("SOURCE_VERSION_CHANGED", 409); } };
  const opsScope = { ...period, basis: "requestedAt" as const, home: "all" as const };
  const operations = { allowed: true, version: "fictional-operations-v1", overview: operationsRecord("operationsOverview"), shipping: operationsRecord("operationsShipping"),
    overviewValidUntil: validUntil, shippingValidUntil: validUntil, afterRead: null as (() => void | Promise<void>) | null };
  const summaryBasis = { scope: opsScope, latency: { definition: "Fictional requested-order handoff days", denominator: 1, totalDays: 2, precision: 1, evidenceRef: "fictional-handoff-evidence", version: "fictional-latency-v1" },
    shippingCost: { definition: "Fictional shipping cost per handed-off order", denominator: 1, totalMinorUnits: 500, currency: "USD", evidenceRef: "fictional-label-evidence", version: "fictional-cost-v1" } };
  operations.overview = { ...operations.overview, reportingScope: opsScope, summaryBasis,
    provenance: { ...(operations.overview.provenance as object), observedAt }, source: { label: "Fictional warehouse", lastSyncedAt: observedAt, observedAt },
    all: { toShip: known(0), waitingOverTwoDays: known(0), shippedToday: known(0), timeToShipDays: known(2) }, queue: { rows: [], total: 0 },
    health: { carrierTransitDays: known(1), shippingCostPerOrder: known({ minorUnits: 500, currency: "USD" }), onTimeHandoffPct: known(100) }, openIssues: known(1) };
  operations.overview.byHome = Object.fromEntries(["H1", "H2", "H3"].map(home => [home, { toShip: known(0), waitingOverTwoDays: known(0), shippedToday: known(0),
    timeToShipDays: { ...known(null), state: "unknown", reasonCode: "HOME_DENOMINATOR_NOT_SUPPLIED", evidenceRefs: [] } }]));
  const shipment = (operations.shipping.shipments as Record<string, unknown>[])[0]!;
  operations.shipping = { ...operations.shipping, reportingScope: opsScope, provenance: { ...(operations.shipping.provenance as object), observedAt },
    shipments: [{ ...shipment, requestedAt: iso(end - 3 * 86_400_000), eventAt: iso(end - 86_400_000), lastScan: iso(end - 86_400_000) }] };
  const operationsPacket = (request: Parameters<OperationsReadSourceReader["read"]>[1], actor: Parameters<OperationsReadSourceReader["read"]>[2]["principal"]) => operationsSnapshot(request.viewKey, {
    scope, version: `${operations.version}-${digest(request)}`, principalRef: actor.principalRef, observedAt,
    validUntil: request.viewKey === "operationsShipping" ? operations.shippingValidUntil : operations.overviewValidUntil,
    record: request.viewKey === "operationsShipping" ? operations.shipping : operations.overview });
  const operationsReadSource: OperationsReadSourceReader = { async read(_scope, request, input) { const packet = structuredClone(operationsPacket(request, input.principal)); await operations.afterRead?.(); return packet; },
    assertCurrent(snapshot, binding) { if (!operations.allowed) throw new OperationsReadError("SOURCE_AUTHORITY_DENIED", 403);
      if (digest(snapshot) !== digest(operationsPacket(binding.request, binding.principal))) throw new OperationsReadError("SOURCE_VERSION_CHANGED", 409); } };
  const secret = analytics.referenceKey;
  const readers = { analytics: analytics.reader, finance: createFinanceReader({ scope, secret, source: financeSource, now }),
    operations: createOperationsReadReader({ scope, secret, source: operationsReadSource, now }),
    monitor: createMonitorReader({ db: store.database, scope, secret, funnel: new FunnelRepository(store.database, scope), intake: seeded.intake, source: monitorSource, now }), portfolio: seeded.portfolio };
  const caller = { assertCurrent() { if (!state.allowed) throw new FinanceError("SOURCE_AUTHORITY_DENIED", 403); } };
  const read = async () => composeOverviewOwners(await analytics.reader.read({ ...analytics.request("overviewSummary"), period }, principal), readers, principal, caller);
  return { state, scope, principal, period, now, store, portfolioPacket, get portfolioReview() { return portfolioReview!; }, readers, read, seed, caller,
    analytics, finance, operations, monitor, initialMutate,
    serverOptions: { workspaceId: scope.workspaceId, accountId: scope.accountId, analyticsSource: analytics.source, financeSource, operationsReadSource, monitorSource, intakeAuthority, operations: { now } },
    close: () => store.close() };
}
