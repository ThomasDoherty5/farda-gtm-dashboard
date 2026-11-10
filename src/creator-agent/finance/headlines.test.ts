// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { overviewOwnersFixture } from "../analytics/overviewOwners.testkit.ts";
import { financeHeadlines, type FinanceSummaryContext } from "./headlines.ts";
import { financeDashboardSchema } from "../../adapter/viewSchemas/finance.ts";
const open: Awaited<ReturnType<typeof overviewOwnersFixture>>[] = [];
async function fixture() { const f = await overviewOwnersFixture(); open.push(f); return f; }
afterEach(() => { for (const f of open.splice(0)) f.close(); });
async function read(f: Awaited<ReturnType<typeof fixture>>) {
  return financeDashboardSchema.omit({ datasetKey: true }).parse((await f.readers.finance.read("financeDashboard", {
    startAt: f.period.startAt, endAt: f.period.endAt, timezone: f.period.timezone }, f.principal)).data);
}
describe("approved finance headlines retain exact accounting identity", () => {
  it("requires adopted definitions while separating actuals from an absent forecast", async () => {
    const f = await fixture(), context = f.finance.record.summaryContext as FinanceSummaryContext;
    context.policy.state = "pending";
    expect(financeHeadlines(await read(f))).toMatchObject({ grossMargin: null, cash: null, runwayMonths: null, actualRevenue: null, forecastRevenue: null });
    context.policy.state = "adopted"; context.forecastState = "missing";
    expect(financeHeadlines(await read(f))).toMatchObject({ actualRevenue: 10000, forecastRevenue: null, cash: 120000, runwayMonths: 3 });
  });
  it("does not divide unknown/incomplete/zero burn, and known zero cash remains zero", async () => {
    const f = await fixture(); f.finance.record.burnHistoryMonths = 2;
    expect(financeHeadlines(await read(f))).toMatchObject({ cash: 120000, runwayMonths: null, runwayReason: "Burn history is incomplete" });
    f.finance.record.burnHistoryMonths = 3;
    (f.finance.record.burn as { value: number }).value = 0;
    expect(financeHeadlines(await read(f))).toMatchObject({ runwayMonths: null, runwayReason: "No positive net cash burn" });
    (f.finance.record.burn as { value: number }).value = 40000; (f.finance.record.cash as { value: number }).value = 0;
    expect(financeHeadlines(await read(f))).toMatchObject({ cash: 0, runwayMonths: 0, runwayReason: null });
  });
  it("rejects a foreign report period or future cash observation at the actual reader", async () => {
    const f = await fixture(), context = f.finance.record.summaryContext as FinanceSummaryContext;
    context.period = { ...f.period, timezone: "America/Los_Angeles" };
    await expect(read(f)).rejects.toMatchObject({ status: 502, reasonCodes: ["FINANCE_REPORTING_PERIOD_MISMATCH"] });
    context.period = f.period; context.cashAsOf = new Date(f.now() + 1000).toISOString();
    await expect(read(f)).rejects.toMatchObject({ status: 502, reasonCodes: ["FINANCE_CASH_TIME_INVALID"] });
  });
});
