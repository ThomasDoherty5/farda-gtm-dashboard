import { z } from "zod";
import { analyticsPeriodSchemaNative } from "../analytics/contract.ts";

/** Qualified QuickBooks report identity, supplied by the accounting owner.
 * A management estimate cannot silently become an adopted accounting definition. */
export const financeSummaryContextSchema = z.object({
  period: analyticsPeriodSchemaNative,
  source: z.literal("quickbooks"), currency: z.literal("USD"), accountingBasis: z.enum(["cash", "accrual"]),
  policy: z.object({ state: z.enum(["adopted", "pending"]), version: z.string().min(1).max(240), evidenceRef: z.string().min(1).max(240) }).strict(),
  cashAsOf: z.string().datetime({ offset: true }),
  forecastState: z.enum(["approved", "proposed", "missing"]),
}).strict();
export type FinanceSummaryContext = z.infer<typeof financeSummaryContextSchema>;
type Value = { state: "known" | "unknown" | "notApplicable"; value: number | null };
type Report = { pnl: { revenue: number; cogs: number }; cash: Value; burn: Value;
  burnWindowMonths: number; burnHistoryMonths: number; forecastRevenue: number; summaryContext?: FinanceSummaryContext | null };
export type FinanceHeadlines = { grossMargin: number | null; cash: number | null; runwayMonths: number | null;
  actualRevenue: number | null; forecastRevenue: number | null; reason: string | null; runwayReason: string | null };
/** One pure accounting-owner projection reused by its detail screen and the server overview.
 * This does not post, adopt a policy, or infer cash from funds raised. */
export function financeHeadlines(report: Report): FinanceHeadlines {
  if (report.summaryContext?.policy.state !== "adopted") return { grossMargin: null, cash: null, runwayMonths: null,
    actualRevenue: null, forecastRevenue: null, reason: "Approved accounting report definition unavailable", runwayReason: "Approved accounting report definition unavailable" };
  const gross = report.pnl.revenue - report.pnl.cogs;
  const cash = report.cash.state === "known" ? report.cash.value : null;
  const burn = report.burn.state === "known" ? report.burn.value : null;
  const runwayReason = cash === null ? "Current cash is unknown" : burn === null || report.burnWindowMonths < 1 || report.burnHistoryMonths < report.burnWindowMonths
    ? "Burn history is incomplete" : burn <= 0 ? "No positive net cash burn" : null;
  return { grossMargin: report.pnl.revenue > 0 && Number.isSafeInteger(gross) ? gross / report.pnl.revenue * 100 : null,
    cash, runwayMonths: runwayReason === null ? cash! / burn! : null, actualRevenue: report.pnl.revenue,
    forecastRevenue: report.summaryContext.forecastState === "missing" ? null : report.forecastRevenue, reason: null, runwayReason };
}
