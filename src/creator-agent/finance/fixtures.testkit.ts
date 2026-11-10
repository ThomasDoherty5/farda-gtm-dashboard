/** Independently authored synthetic native source answers. No provider or demo fallback is configured by this test kit. */
import type { FinanceViewKey } from "./contract.ts";
import type { FinanceSourceReader } from "./source.ts";
export const financeTestScope = { workspaceId: "synthetic-finance-workspace", accountId: "synthetic-finance-account", environment: "sandbox" as const };
export const financeTestTime = "2026-11-06T12:00:00.000Z";
const observedAt = "2026-11-06T11:00:00.000Z";
export const financeTestFilters: Record<FinanceViewKey, Record<string, string>> = {
  financeDashboard: {}, commissionLedger: {}, monthsHistory: {}, reportManifest: {},
  periodClose: { period: "2026-10" }, closePackage: { period: "2026-10" },
  settlementDetail: { settlementId: "COMM-DEMO-D" }, payableDetail: { payableId: "PAY-0012" },
};
const money = (minorUnits: number) => ({ minorUnits, currency: "USD" });
const unknown = (reasonCode: string) => ({ state: "unknown", value: null, reasonCode, evidenceRefs: [], sourceRef: null,
  occurredAt: null, sourceUpdatedAt: observedAt, observedAt });
const known = (value: unknown) => ({ ...unknown(""), state: "known", value, reasonCode: null });
const provenance = { kind: "source", evidenceStage: "synthetic", observedAt, eventAt: null,
  sourceId: "synthetic-finance-record", canonicalId: null, provenanceRef: "synthetic-finance-evidence" };
/** Explicit synthetic permission observation supplied by the fixture clock, not a production grant. */
export function financeTestReadAccess(at = Date.parse(financeTestTime)) {
  return { observedAt: new Date(at).toISOString(), validUntil: new Date(at + 15 * 60_000).toISOString() };
}
const group = { id: "synthetic-group", grossSales: 10000, netBase: 9000, earned: 900, reversed: 0, state: "paid", evidence: { receipt: "synthetic-paid-receipt", note: "Synthetic immutable receipt" } };

export function financeRecord(viewKey: FinanceViewKey): Record<string, unknown> {
  const common = { datasetKey: "finance-native", synthetic: true, provenance: { ...provenance },
    readAccess: { validUntil: financeTestReadAccess().validUntil }, version: "synthetic-record-v1" };
  switch (viewKey) {
    case "commissionLedger": return { ...common, cohortLabel: "Synthetic October cohort · USD", groups: [{ ...group }],
      economics: { commerceCosts: 1000, historicalFixedFee: 0, samples: 0, processingFeePct: 0 }, orders: { initial: 1, retained: 1, refundedBeforeFulfillment: 0 }, currency: "USD", observedAt };
    case "settlementDetail": return { ...common, settlementId: "COMM-DEMO-D", provider: "collabs", group: { ...group }, retainedOrders: 1,
      eligibleMerchandise: 9000, ratePct: 10, invoiceState: "unmatched", processingFeePct: 0,
      candidates: [{ statementRef: "synthetic-statement", groupId: group.id, amount: money(900), period: "2026-10", evidence: "Synthetic source receipt", problem: null }], submitted: null, rates: [] };
    case "payableDetail": return { ...common, payableId: "PAY-0012", amount: known(money(3000)), handle: "@routine.with.ella", collaboration: "Synthetic historical agreement",
      evidence: "Synthetic accepted obligation", invoiceRef: "synthetic-invoice", budgetCategory: "Historical obligations", stage: "requested", providerTransaction: null,
      settlementStatus: "Unpaid", quickbooksRef: null, reconciliation: "Pending", approvalRef: "synthetic-approval" };
    case "financeDashboard": return { ...common, period: { label: "Synthetic October", days: 30 }, pnl: { revenue: 10000, cogs: 1000, opex: 500, ytd: unknown("YTD_REPORT_NOT_RECEIVED") },
      cash: known(10000), cashAsOf: observedAt, historicalRaised: 0, burn: unknown("BURN_NOT_OBSERVED"), burnWindowMonths: 3, burnHistoryMonths: 1,
      inventoryValue: 1000, accountsPayable: 3000, salesTaxPayable: 0, forecastRevenue: 0, contributionPerOrder: 8500, samplesPlanned: 0,
      closeSummary: { period: "2026-10", label: "Synthetic October", unmatchedPayouts: 1, cpaSignOff: "Pending" }, cashHistory: [{ month: "Oct", minor: 10000 }],
      costBreakdown: [{ label: "Synthetic cost", minor: 1000 }], payouts: [{ channel: "Synthetic", matched: 0, needsReview: 1 }],
      // Only landed COGS is observed; every other component, both coverages and the subscription source are unread, so they stay unknown.
      unitEconomics: { definition: { version: "finance-unit-economics@1", state: "notConfigured", reference: null },
        cohort: { id: "synthetic-cohort", label: "Synthetic October cohort", currency: "USD", period: { start: "2026-10-01", end: "2026-10-31", timezone: "UTC" } },
        validOrders: known(1), newCustomers: unknown("CUSTOMERS_NOT_OBSERVED"), landedCost: { complete: false, missingSkus: [] },
        creatorCosts: { state: "unknown", expected: null, observed: null, reasonCodes: ["CREATOR_COSTS_NOT_OBSERVED"] },
        attribution: { state: "unknown", expected: null, observed: null, reasonCodes: ["ATTRIBUTION_NOT_OBSERVED"] },
        costs: [{ component: "landedCogs", basis: "accrued", minorUnits: 1000, cohortId: "synthetic-cohort", obligationId: "synthetic-cogs", evidenceId: "synthetic-cogs-evidence", cashId: null, currency: "USD", period: { start: "2026-10-01", end: "2026-10-31", timezone: "UTC" } }],
        declared: (["shipping", "providerFees", "fulfillment", "paidMedia", "sampleLanded", "sampleShipping", "historicalContentFee", "commission"] as const).map(component => ({ component, state: "unknown", reasonCode: "COST_NOT_OBSERVED" })) },
      subscriptions: { access: "unknown", reasonCode: "SUBSCRIPTION_SOURCE_NOT_READ", subscriptionProducts: null, definition: { version: "recurring-revenue@0", state: "notConfigured", reference: null }, monthlyRecurring: unknown("SUBSCRIPTION_SOURCE_NOT_READ") },
      forecastPlan: { version: "synthetic-forecast-v1", basis: "illustrative", assumptions: [] } };
    case "periodClose": return { ...common, period: "2026-10", label: "Synthetic October", checks: [], closeOwner: "Synthetic owner", cpaReview: "Pending", status: "open", exceptions: [], reports: [], exportFailed: false };
    case "closePackage": return { ...common, period: "2026-10", label: "Synthetic October", scenario: "source-read", status: "open", blockers: [],
      cpa: { state: "notRequested", signedAt: null }, exportState: "none", commissionCohort: { label: "Synthetic cohort", orders: 1, note: "Synthetic" }, landedCost: { complete: true, missingSkus: [] }, differences: [],
      versions: [{ version: "synthetic-v1", figures: { accrual: 900, reversals: 0, netCommissionExpense: 900, creatorPaid: 900, outstandingLiability: 0, pendingRecovery: 0 }, frozen: false, closedAt: null, cpaSignOff: null, reports: [] }],
      adjustment: null, paidReceipts: [{ receipt: "synthetic-paid-receipt", groupId: group.id, amount: money(900), immutable: true }], commissionSplit: [] };
    case "monthsHistory": return { datasetKey: common.datasetKey, synthetic: true, provenance: common.provenance, readAccess: common.readAccess, months: [{ period: "2026-10", label: "Synthetic October", status: "open", signedRevision: null, signedAt: null, reopenedAt: null, revisions: [], taxNote: "No tax rule asserted" }] };
    case "reportManifest": return { datasetKey: common.datasetKey, synthetic: true, provenance: common.provenance, readAccess: common.readAccess, manifestId: "synthetic-manifest", period: "2026-10", label: "Synthetic October", policy: { reference: null }, rows: [] };
  }
}
export function financeSnapshot(viewKey: FinanceViewKey, patch: Record<string, unknown> = {}, accessObservedAt = Date.parse(financeTestTime)) {
  return { scope: { ...financeTestScope }, viewKey, version: "synthetic-finance-v1", principalRef: "agent-reader", permissionVersion: "synthetic-permission-v1", observedAt,
    readAccess: financeTestReadAccess(accessObservedAt),
    validUntil: "2026-11-07T11:00:00.000Z", coverage: { state: "complete", expectedCount: 1, observedCount: 1, reasonCodes: [] },
    currency: "USD", period: viewKey === "periodClose" || viewKey === "closePackage" ? "2026-10" : null, record: financeRecord(viewKey), ...patch };
}
/** Fixed test authority; changing-authority regressions supply their own assertion. */
export function financeTestSource(read: FinanceSourceReader["read"]): FinanceSourceReader {
  return { async read(scope, request, options) {
    const answer = await read(scope, request, options);
    return answer && typeof answer === "object" ? { ...answer, principalRef: options.principal.principalRef } : answer;
  }, assertCurrent(snapshot, binding) {
    if (snapshot.principalRef !== binding.principal.principalRef || snapshot.permissionVersion !== "synthetic-permission-v1" ||
      JSON.stringify(snapshot.scope) !== JSON.stringify(binding.scope) || snapshot.viewKey !== binding.request.viewKey) throw new Error("Synthetic binding mismatch");
  } };
}
