import { describe, expect, it } from "vitest";
import { financeDashboardDemo, ledgerDemo } from "@/fixtures/finance";
import { caseAEvents, financeMetricDictionary, subscriptionCases, unitEconomicsCases } from "@/fixtures/financeUnitEconomics";
import { known, unknown } from "@/fixtures/values";
import { ACQUISITION_COMPONENTS, CONTRIBUTION_COMPONENTS, PER_ORDER_TIE_TOLERANCE_MINOR, cacPaybackOf, componentTotal, contributionOf, figureText, grossMarginOf, recurringRevenueOf, recurringText, ueFormat, type UnitEconomicsInput } from "./unitEconomics";

const texts = (pnl: { revenue: number; cogs: number }, input: UnitEconomicsInput) => {
  const { acquisition, cac, paybackOrders } = cacPaybackOf(pnl, input);
  return {
    grossMargin: figureText(grossMarginOf(pnl, input), ueFormat.percent),
    contributionPerOrder: figureText(contributionOf(pnl, input).perOrder, ueFormat.money),
    acquisitionCost: figureText(acquisition, ueFormat.money),
    cac: figureText(cac, ueFormat.money),
    paybackOrders: figureText(paybackOrders, ueFormat.orders),
  };
};
const caseA = unitEconomicsCases[0]!;

describe("hand-calculated synthetic cases", () => {
  it("are labeled synthetic and kept in their own dataset", () => {
    expect(financeMetricDictionary.datasetKey).toBe("finance-unit-economics-cases");
    for (const c of unitEconomicsCases) expect(c.input.cohort.id).not.toBe(financeDashboardDemo().unitEconomics!.cohort.id);
  });

  it("source events sum to the case's revenue and COGS rows tie to its P&L, at source precision", () => {
    expect(caseAEvents.reduce((n, e) => n + e.minorUnits, 0)).toBe(caseA.pnl.revenue);
    expect(caseA.input.costs.filter((c) => c.component === "landedCogs").reduce((n, c) => n + c.minorUnits!, 0)).toBe(caseA.pnl.cogs);
    expect(caseA.input.costs.every((c) => Number.isSafeInteger(c.minorUnits))).toBe(true);
  });

  it.each(unitEconomicsCases.map((c) => [c.id, c] as const))("%s matches its hand calculation", (_id, c) => {
    expect(texts(c.pnl, c.input)).toEqual(c.expected);
  });

  it("counts a commission accrual and its cash settlement once, never twice", () => {
    const commission = caseA.input.costs.filter((c) => c.component === "commission");
    expect(commission).toHaveLength(2);
    expect(new Set(commission.map((c) => c.obligationId)).size).toBe(1);
    expect(componentTotal(caseA.input, ["commission"]).value).toBe(1395);
    expect(cacPaybackOf(caseA.pnl, caseA.input).acquisition.value).toBe(7324);
  });

  it("keeps contribution and acquisition components disjoint, so no cost is in both", () => {
    expect(CONTRIBUTION_COMPONENTS.filter((c) => (ACQUISITION_COMPONENTS as readonly string[]).includes(c))).toEqual([]);
  });

  it("is N/A when a component is neither observed nor declared: missing is not zero", () => {
    const input = { ...caseA.input, declared: [] };
    expect(texts(caseA.pnl, input).paybackOrders).toBe("N/A · Historical content fees not reported");
  });

  it("is N/A when creator-cost coverage is unknown, because the missing costs could be any size", () => {
    const input = { ...caseA.input, creatorCosts: { state: "unknown" as const, expected: null, observed: null, reasonCodes: ["NOT_READ"] } };
    expect(texts(caseA.pnl, input).cac).toBe("N/A · Creator-cost coverage is unknown");
  });

  it("is N/A when contribution per order is not positive, never a negative payback", () => {
    expect(texts({ revenue: 4933, cogs: 3286 }, caseA.input).paybackOrders).toBe("N/A · Contribution per order is not positive, so acquisition cost is never paid back");
  });

  it("is N/A when the unknown order count or a mismatched source per-order figure would fabricate a ratio", () => {
    expect(texts(caseA.pnl, { ...caseA.input, validOrders: unknown("ORDERS_NOT_READ") }).paybackOrders).toBe("N/A · Valid orders are not reported");
    expect(figureText(contributionOf(caseA.pnl, caseA.input, 1500).perOrder, ueFormat.money)).toBe("N/A · Source per-order contribution does not tie to its components");
    expect(figureText(contributionOf({ ...caseA.pnl, cogs: 3000 }, caseA.input).perOrder, ueFormat.money)).toBe("N/A · Landed COGS does not tie to the P&L");
  });
});

describe("whole-input checks", () => {
  const sum = (input: UnitEconomicsInput, members: readonly (typeof CONTRIBUTION_COMPONENTS[number] | typeof ACQUISITION_COMPONENTS[number])[]) =>
    members.reduce((n, c) => n + componentTotal(input, [c]).value!, 0);

  it.each([["case A", caseA.input], ["dashboard demo", financeDashboardDemo().unitEconomics!]] as const)("per-component totals sum to their group total: %s", (_name, input) => {
    expect(sum(input, CONTRIBUTION_COMPONENTS)).toBe(componentTotal(input, CONTRIBUTION_COMPONENTS).value);
    expect(sum(input, ACQUISITION_COMPONENTS)).toBe(componentTotal(input, ACQUISITION_COMPONENTS).value);
  });

  it("refuses one obligation under two components in every figure, including each component on its own", () => {
    const input = unitEconomicsCases.find((c) => c.id === "obligation-under-two-components")!.input;
    for (const c of [...CONTRIBUTION_COMPONENTS, ...ACQUISITION_COMPONENTS]) expect(componentTotal(input, [c]).reasons).toEqual(["OBLIGATION_COMPONENT_CONFLICT"]);
  });

  it("refuses a component that is both declared and reported", () => {
    const input = { ...caseA.input, declared: [...caseA.input.declared, { component: "paidMedia" as const, state: "knownZero" as const, reasonCode: "NONE" }] };
    expect(texts(caseA.pnl, input).acquisitionCost).toBe("N/A · Paid media is both declared and reported");
  });

  it("refuses a cohort whose currency differs from the P&L's", () => {
    const input = { ...caseA.input, cohort: { ...caseA.input.cohort, currency: "EUR" } };
    expect(texts(caseA.pnl, input).contributionPerOrder).toBe("N/A · The cohort currency differs from the P&L currency");
  });

  it(`ties the source's per-order figure within ±${PER_ORDER_TIE_TOLERANCE_MINOR} minor unit of the exact $14.5533`, () => {
    const at = (source: number) => contributionOf(caseA.pnl, caseA.input, source).perOrder.state;
    expect([at(1455), at(1456)]).toEqual(["known", "known"]);
    expect([at(1454), at(1457)]).toEqual(["notApplicable", "notApplicable"]);
  });

  it("reads absent unit economics as N/A, and keeps the P&L margin with its completeness caveat", () => {
    expect(texts(caseA.pnl, undefined as unknown as UnitEconomicsInput)).toEqual({
      grossMargin: "64.7% · Provisional · Landed-cost completeness not reported",
      contributionPerOrder: "N/A · Unit-economics inputs are not reported", acquisitionCost: "N/A · Unit-economics inputs are not reported",
      cac: "N/A · Unit-economics inputs are not reported", paybackOrders: "N/A · Unit-economics inputs are not reported",
    });
    expect(recurringRevenueOf(undefined)).toEqual({ kind: "unavailable", reason: "Subscription source not reported. Unknown, not zero." });
  });
});

describe("recurring revenue", () => {
  it.each(subscriptionCases.map((c) => [c.id, c] as const))("%s matches its hand calculation", (_id, c) => {
    const r = recurringRevenueOf(c.source);
    expect(r.kind).toBe(c.expected.kind);
    expect(recurringText(r)).toEqual({ mrr: c.expected.mrr, arr: c.expected.arr });
  });

  it("keeps an unread source distinct from a verified absence", () => {
    const [unread, none] = subscriptionCases;
    expect(recurringRevenueOf(unread!.source).kind).not.toBe(recurringRevenueOf(none!.source).kind);
    expect(recurringRevenueOf(unread!.source).reason).toMatch(/Unknown, not zero/);
  });

  it("never annualizes one-time orders: order revenue is not an input, and no product means no MRR", () => {
    const d = financeDashboardDemo();
    expect(d.pnl.revenue).toBe(1259600);
    expect(recurringRevenueOf(d.subscriptions).kind).toBe("none");
    expect(recurringRevenueOf({ ...d.subscriptions!, monthlyRecurring: known(d.pnl.revenue) }).kind).toBe("none");
    expect(recurringRevenueOf.length).toBe(1);
  });
});

describe("dashboard demo cohort", () => {
  const d = financeDashboardDemo();
  const ue = d.unitEconomics!;

  it("ties contribution to the existing figures: $12,596 − $6,916 = $5,680, $14.20 an order over 400 orders", () => {
    const { total, perOrder } = contributionOf(d.pnl, ue, d.contributionPerOrder);
    expect(total.value).toBe(568000);
    expect(total.value).toBe(d.costBreakdown.find((c) => c.label === "Contribution")!.minor);
    expect(perOrder).toEqual({ state: "known", value: 1420, reasons: [] });
    expect(grossMarginOf(d.pnl, ue).value!.toFixed(1)).toBe("65.0");
  });

  it("gives CAC payback in orders, provisional while creator costs and attribution are incomplete", () => {
    const { acquisition, cac, paybackOrders } = cacPaybackOf(d.pnl, ue, d.contributionPerOrder);
    expect(acquisition.value).toBe(700000); // $5,000 media + $840 sample landed + $260 sample shipping + $900 historical fees
    expect(cac.value).toBe(2500); // $7,000 ÷ 280 new customers
    expect(paybackOrders.value).toBeCloseTo(2500 / 1420, 10);
    expect(figureText(paybackOrders, ueFormat.orders)).toBe("1.76 orders · Provisional · Creator costs partly allocated · Attribution coverage incomplete");
  });

  it("isolates the commission pilot: no pilot row, and commission is declared not applicable", () => {
    expect(ue.costs.every((c) => c.cohortId === ue.cohort.id)).toBe(true);
    expect(ue.costs.some((c) => c.component === "commission")).toBe(false);
    expect(ue.declared).toContainEqual({ component: "commission", state: "notApplicable", reasonCode: "PILOT_COHORT_ONLY" });
    expect(ledgerDemo().cohortLabel).toMatch(/pilot/);
    expect(ue.cohort.label).not.toMatch(/pilot/i);
  });

  it("keeps the forecast's version and assumptions apart from the actuals", () => {
    expect(d.forecastPlan!.version).not.toBe(d.version);
    expect(d.forecastPlan!.basis).toBe("illustrative");
  });

  it("states the definitions as proposed, never adopted, and never as professionally validated", () => {
    expect(ue.definition).toEqual({ version: financeMetricDictionary.version, state: "proposed", reference: null });
    expect(financeMetricDictionary.policy).toMatch(/No adopted finance policy/);
    expect(financeMetricDictionary.policy).toMatch(/not been reviewed by a CPA/);
    expect(financeMetricDictionary.entries.map((e) => e.key)).toEqual(["grossMargin", "contributionPerOrder", "acquisitionCost", "cac", "cacPaybackOrders", "mrr", "arr"]);
    for (const e of financeMetricDictionary.entries) expect(e.whenUnavailable).not.toBe("");
  });

  it("gives N/A, not $0, for zero orders", () => {
    const z = financeDashboardDemo("zeroorders");
    expect(contributionOf(z.pnl, z.unitEconomics, z.contributionPerOrder).perOrder.state).toBe("notApplicable");
    expect(cacPaybackOf(z.pnl, z.unitEconomics, z.contributionPerOrder).paybackOrders.state).toBe("notApplicable");
    expect(grossMarginOf(z.pnl, z.unitEconomics).state).toBe("notApplicable");
  });
});
