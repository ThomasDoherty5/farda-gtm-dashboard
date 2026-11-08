/** Test-only injected source answers. Records are the existing labelled synthetic finance fixtures; the service never serves them by default. */
import { financeDashboardDemo, ledgerDemo, payableDemo, settlementDemo } from "../../fixtures/finance.ts";
import { closePackageDemo, manifestDemo, monthsDemo, periodCloseDemo } from "../../fixtures/financeClose.ts";
import type { FinanceViewKey } from "./contract.ts";

export const financeTestScope = { workspaceId: "synthetic-finance-workspace", accountId: "synthetic-finance-account", environment: "sandbox" as const };
export const financeTestTime = "2026-11-06T12:00:00.000Z";
export const financeTestFilters: Record<FinanceViewKey, Record<string, string>> = {
  financeDashboard: {}, commissionLedger: {}, monthsHistory: {}, reportManifest: {},
  periodClose: { period: "2026-10" }, closePackage: { period: "2026-10" },
  settlementDetail: { settlementId: "COMM-DEMO-D" }, payableDetail: { payableId: "PAY-0012" },
};

export function financeRecord(viewKey: FinanceViewKey): unknown {
  switch (viewKey) {
    case "financeDashboard": return financeDashboardDemo();
    case "commissionLedger": return ledgerDemo();
    case "monthsHistory": return { datasetKey: "finance-months-demo", months: monthsDemo() };
    case "reportManifest": return manifestDemo();
    case "periodClose": return periodCloseDemo("2026-10");
    case "closePackage": return closePackageDemo("2026-10");
    case "settlementDetail": return settlementDemo("COMM-DEMO-D");
    case "payableDetail": return payableDemo("PAY-0012");
  }
}

export function financeSnapshot(viewKey: FinanceViewKey, patch: Record<string, unknown> = {}) {
  return { scope: { ...financeTestScope }, viewKey, version: "synthetic-finance-v1", observedAt: "2026-11-06T11:00:00.000Z",
    validUntil: "2026-11-07T11:00:00.000Z", coverage: { state: "complete", expectedCount: 1, observedCount: 1, reasonCodes: [] },
    currency: "USD", period: viewKey === "periodClose" || viewKey === "closePackage" ? "2026-10" : null, record: financeRecord(viewKey), ...patch };
}
