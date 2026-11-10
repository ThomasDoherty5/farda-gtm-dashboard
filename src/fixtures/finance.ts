/**
 * Finance fixtures (Figma sources 65:1037, 66:252, 66:447, 9:551) — SYNTHETIC and ILLUSTRATIVE.
 * "COMM-DEMO-*" are local fixture groups, not API identifiers. Amounts are minor units (USD cents). Everything the screens
 * total is derived from the group rows. A paid receipt is immutable: a later reversal is an adjustment, never a rewrite.
 * New acquisition is commission-only; the $150 fee is a historical, accepted obligation. Do not mix with other datasets.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import type { CostObservation, SubscriptionSource, UnitEconomicsInput } from "@/features/finance/unitEconomics";
import type { PeriodStatus } from "./financeClose";
import { known, unknown, usd } from "./values";

export type CommissionState = "held" | "disputed" | "awaitingProvider" | "paid";

export type CommissionGroup = {
  id: string;
  grossSales: number;
  netBase: number;
  earned: number;
  reversed: number;
  state: CommissionState;
  /** Provider-side facts for the read-only evidence panel. */
  evidence: { receipt: string | null; note: string };
  adjustments?: Adjustment[];
};

/** A change after payout. It is appended beside the receipt and never edits it. */
export type Adjustment = { id: string; kind: "reversal"; amountMinor: number; at: string; reason: string; receiptRef: string };

/** Returns a new group with the adjustment added. The receipt and every earlier adjustment are carried over untouched. Only a paid group can be adjusted. */
export function appendAdjustment(g: CommissionGroup, adj: Adjustment): CommissionGroup {
  if (g.state !== "paid" || !g.evidence.receipt) throw new Error("Only a paid group with a receipt can take an adjustment.");
  if (adj.amountMinor >= 0) throw new Error("A reversal is a negative amount.");
  if (adj.receiptRef !== g.evidence.receipt) throw new Error("An adjustment must name the receipt it adjusts.");
  const prior = g.adjustments ?? [];
  if (prior.some((a) => a.id === adj.id)) throw new Error("An adjustment id is never reused.");
  return { ...g, evidence: { ...g.evidence }, adjustments: [...prior, adj] };
}
/** What was paid, after the appended adjustments. The paid amount itself is the receipt's and does not change. */
export const netOfAdjustments = (paidMinor: number, g: CommissionGroup) => paidMinor + (g.adjustments ?? []).reduce((a, x) => a + x.amountMinor, 0);

export const netAccrued = (g: CommissionGroup) => g.earned - g.reversed;
export const STATE_LABEL: Record<CommissionState, string> = { held: "Held", disputed: "Disputed", awaitingProvider: "Awaiting provider", paid: "Paid" };

export type CommissionLedger = {
  datasetKey: "finance-demo";
  version: string;
  cohortLabel: string;
  groups: CommissionGroup[];
  economics: { commerceCosts: number; historicalFixedFee: number; samples: number; processingFeePct: number };
  orders: { initial: number; retained: number; refundedBeforeFulfillment: number };
  currency: "USD";
  observedAt: string;
};

export const ledgerDemo = (): CommissionLedger => ({
  datasetKey: "finance-demo",
  version: "led1",
  cohortLabel: "Affiliate pilot · synthetic cohort B",
  groups: [
    { id: "COMM-DEMO-A", grossSales: 80000, netBase: 60000, earned: 12000, reversed: 3000, state: "held", evidence: { receipt: null, note: "A $200 refund reversed $30 of earned commission. The provider holds the balance until its review deadline." } },
    { id: "COMM-DEMO-B", grossSales: 20000, netBase: 20000, earned: 3000, reversed: 0, state: "disputed", evidence: { receipt: null, note: "The provider records a dispute on this group. The amount stays in the accrual until the source resolves it." } },
    { id: "COMM-DEMO-C", grossSales: 40000, netBase: 40000, earned: 6000, reversed: 0, state: "awaitingProvider", evidence: { receipt: null, note: "Eligibility is recorded in the provider. Payout waits for the provider's own schedule." } },
    { id: "COMM-DEMO-D", grossSales: 60000, netBase: 60000, earned: 9000, reversed: 0, state: "paid", evidence: { receipt: "TEST-RCPT-0090", note: "Paid by the provider. The receipt is immutable; any later reversal is recorded as an adjustment." }, adjustments: [{ id: "ADJ-0001", kind: "reversal", amountMinor: -500, at: "2026-10-28T17:00:00.000Z", reason: "A customer refund after payout reversed $5 of commission", receiptRef: "TEST-RCPT-0090" }] },
  ],
  economics: { commerceCosts: 81000, historicalFixedFee: 15000, samples: 10000, processingFeePct: 2.9 },
  orders: { initial: 50, retained: 45, refundedBeforeFulfillment: 5 },
  currency: "USD",
  observedAt: "2026-11-02T17:00:00.000Z",
});

/** Every figure the ledger screen shows, derived from the group rows so cards, bar, table and chart can't disagree. */
export function ledgerTotals(l: CommissionLedger) {
  const sum = (f: (g: CommissionGroup) => number) => l.groups.reduce((n, g) => n + f(g), 0);
  const grossSales = sum((g) => g.grossSales);
  const netSales = sum((g) => g.netBase);
  const earned = sum((g) => g.earned);
  const reversed = sum((g) => g.reversed);
  const accrued = earned - reversed;
  const byState = (s: CommissionState) => l.groups.filter((g) => g.state === s).reduce((n, g) => n + netAccrued(g), 0);
  const fee = Math.round((accrued * l.economics.processingFeePct) / 100);
  const contribution = netSales - l.economics.commerceCosts - l.economics.historicalFixedFee - l.economics.samples - accrued - fee;
  return { grossSales, netSales, refunds: grossSales - netSales, earned, reversed, accrued, held: byState("held"), disputed: byState("disputed"), awaiting: byState("awaitingProvider"), paid: byState("paid"), fee, contribution, contributionPct: netSales > 0 ? (100 * contribution) / netSales : null };
}

export type MatchCandidate = { statementRef: string; groupId: string; amount: Money; period: string; evidence: string; problem: "duplicate" | "conflict" | null };

export type SettlementProvider = "collabs" | "tiktok";
export type SettlementRecord = {
  datasetKey: "finance-demo";
  settlementId: string;
  provider: SettlementProvider;
  version: string;
  group: CommissionGroup;
  retainedOrders: number;
  eligibleMerchandise: number;
  ratePct: number;
  /** "Unmatched" until an authoritative statement is matched. Never inferred. */
  invoiceState: "unmatched" | "matched";
  processingFeePct: number;
  candidates: MatchCandidate[];
  submitted: { state: string; actionRef: string } | null;
  /** TikTok native rates. Unknown until read from the connected source. */
  rates: { lane: "standard" | "shopAds"; active: ProvenanceValue<number>; proposed: "Draft" }[];
};

export const settlementDemo = (settlementId: string): SettlementRecord | null => {
  if (settlementId !== "COMM-DEMO-D" && settlementId !== "TT-NATIVE-DEMO") return null;
  const group = ledgerDemo().groups.find((g) => g.id === "COMM-DEMO-D")!;
  return {
    datasetKey: "finance-demo",
    settlementId,
    provider: settlementId === "TT-NATIVE-DEMO" ? "tiktok" : "collabs",
    version: "st1",
    group,
    retainedOrders: 15,
    eligibleMerchandise: 4000,
    ratePct: 15,
    invoiceState: "unmatched",
    processingFeePct: 2.9,
    candidates: [
      { statementRef: "STMT-DEMO-0001", groupId: "COMM-DEMO-D", amount: usd(9000), period: "Oct 1–31, 2026", evidence: "Provider statement line, paid event TEST-RCPT-0090", problem: null },
      { statementRef: "STMT-DEMO-0002", groupId: "COMM-DEMO-D", amount: usd(9000), period: "Oct 1–31, 2026", evidence: "A second statement line with the same amount and period", problem: "duplicate" },
    ],
    submitted: null,
    rates: [
      { lane: "standard", active: unknown("RATE_NOT_READ"), proposed: "Draft" },
      { lane: "shopAds", active: unknown("RATE_NOT_READ"), proposed: "Draft" },
    ],
  };
};

export type PayableDetail = {
  datasetKey: "finance-demo";
  payableId: string;
  version: string;
  amount: ProvenanceValue<Money>;
  handle: string;
  collaboration: string;
  evidence: string;
  invoiceRef: string;
  budgetCategory: string;
  /** The first step not yet done. Approval, execution and reconciliation are separate steps. */
  stage: "requested" | "founderApproval" | "execution" | "settled" | "posted" | "reconciled";
  providerTransaction: string | null;
  settlementStatus: string;
  quickbooksRef: string | null;
  reconciliation: string;
  approvalRef: string;
};

export const payableDemo = (payableId: string): PayableDetail | null =>
  payableId === "PAY-0012"
    ? { datasetKey: "finance-demo", payableId, version: "pay1", amount: known(usd(15000)), handle: "@routine.with.ella", collaboration: "COL-SC-042", evidence: "Final content accepted", invoiceRef: "INV-0084", budgetCategory: "Creator / UGC", stage: "founderApproval", providerTransaction: null, settlementStatus: "Not paid", quickbooksRef: null, reconciliation: "Waiting for settlement", approvalRef: "demo-approval-042" }
    : null;

export const PAYABLE_STAGES: { key: PayableDetail["stage"]; title: string; note: string }[] = [
  { key: "requested", title: "Requested", note: "Amount + basis captured" },
  { key: "founderApproval", title: "Founder approval", note: "Current step" },
  { key: "execution", title: "Execution", note: "Authorized payment action" },
  { key: "settled", title: "Settled", note: "Provider receipt verified" },
  { key: "posted", title: "Posted", note: "QuickBooks entry linked" },
  { key: "reconciled", title: "Reconciled", note: "Ledger matched" },
];

/**
 * Finance dashboard and close fixtures (Figma sources 7:510, 7:683, 12:1006) — SYNTHETIC management figures for a 30-day window.
 * Net revenue ties to the Overview dataset's $12,596. YTD and calendar-month figures are unknown ("Awaiting data"), never zero.
 * The historical $70,000 raised is context only; runway always uses verified current cash.
 */
export type FinanceDashboard = {
  datasetKey: "finance-demo";
  version: string;
  period: { label: string; days: 30 };
  /** Amounts are minor units. YTD is unknown until a source report arrives. */
  pnl: { revenue: number; cogs: number; opex: number; ytd: ProvenanceValue<number> };
  cash: ProvenanceValue<number>;
  cashAsOf: string;
  historicalRaised: number;
  /** Average net cash out over the observation window. Null months of history = insufficient history. */
  burn: ProvenanceValue<number>;
  burnWindowMonths: number;
  burnHistoryMonths: number;
  inventoryValue: number;
  accountsPayable: number;
  salesTaxPayable: number;
  forecastRevenue: number;
  contributionPerOrder: number;
  samplesPlanned: number;
  closeSummary: { period: string; label: string; unmatchedPayouts: number; cpaSignOff: string };
  /** Month-end cash for the months before now, oldest first (Jul to Oct). Observed, not forecast. */
  cashHistory: { month: string; minor: number }[];
  costBreakdown: { label: string; minor: number }[];
  payouts: { channel: string; matched: number; needsReview: number }[];
  /** Optional add-on: absent means N/A (UNIT_ECONOMICS_NOT_REPORTED). Unit-economics inputs for the original dashboard cohort only. The commission pilot keeps its own ledger and cost basis and is never mixed in. */
  unitEconomics?: UnitEconomicsInput;
  /** Subscription source access. Unread access is unknown, which is not the verified "no subscription revenue". */
  subscriptions?: SubscriptionSource;
  /** The forecast's own version and assumptions, kept apart from the actuals' source version. */
  forecastPlan?: { version: string; basis: "illustrative" | "rebaselined"; assumptions: string[] };
};

const DASHBOARD_COHORT = "dashboard-original";
const WINDOW = { start: "2026-09-30", end: "2026-10-29", timezone: "America/Los_Angeles" };
/** One synthetic cost row of the original dashboard cohort, in USD cents. */
const cost = (component: CostObservation["component"], basis: CostObservation["basis"], minorUnits: number, cashId: string | null = null): CostObservation =>
  ({ component, basis, minorUnits, cohortId: DASHBOARD_COHORT, obligationId: `TEST-OBL-${component}`, evidenceId: `TEST-EV-${component}`, cashId, currency: "USD", period: WINDOW });

/**
 * Synthetic cost rows for the 30-day window. Contribution rows tie to the P&L COGS and the cost breakdown ($12,596 − $6,916 = $5,680,
 * $14.20 per order over 400 orders). Acquisition rows total $7,000 for 280 new customers. Commission is not applicable here: it belongs
 * to the separate affiliate pilot and its ledger.
 */
function unitEconomicsDemo(scenario?: string): UnitEconomicsInput {
  const zero = scenario === "zeroorders";
  const contribution: CostObservation[] = zero ? [] : [cost("landedCogs", "accrued", 441000), cost("shipping", "paid", 116400, "TEST-CASH-shipping"), cost("providerFees", "paid", 81200, "TEST-CASH-fees"), cost("fulfillment", "paid", 53000, "TEST-CASH-fulfillment")];
  return {
    definition: { version: "finance-unit-economics@1", state: "proposed", reference: null },
    cohort: { id: DASHBOARD_COHORT, label: "Original dashboard cohort · 30 Sep–29 Oct 2026", currency: "USD", period: WINDOW },
    validOrders: known(zero ? 0 : 400),
    newCustomers: known(zero ? 0 : 280),
    landedCost: scenario === "landedincomplete" ? { complete: false, missingSkus: ["TEST-SKU-02"] } : { complete: true, missingSkus: [] },
    creatorCosts: { state: "partial", expected: 8, observed: 6, reasonCodes: ["CREATOR_COSTS_UNALLOCATED"] },
    attribution: { state: "partial", expected: 400, observed: 352, reasonCodes: ["ORDERS_UNATTRIBUTED"] },
    costs: [...contribution, cost("paidMedia", "paid", 500000, "TEST-CASH-media"), cost("sampleLanded", "accrued", 84000), cost("sampleShipping", "paid", 26000, "TEST-CASH-sample-shipping"), cost("historicalContentFee", "accrued", 90000)],
    declared: [
      { component: "commission", state: "notApplicable", reasonCode: "PILOT_COHORT_ONLY" },
      ...(zero ? (["landedCogs", "shipping", "providerFees", "fulfillment"] as const).map((component) => ({ component, state: "knownZero" as const, reasonCode: "NO_ORDERS" })) : []),
    ],
  };
}

export const financeDashboardDemo = (scenario?: string): FinanceDashboard => ({
  datasetKey: "finance-demo",
  version: "fin1",
  period: { label: "30 Sep–29 Oct 2026", days: 30 },
  pnl: scenario === "zeroorders" ? { revenue: 0, cogs: 0, opex: 990600, ytd: unknown("YTD_REPORT_NOT_RECEIVED") } : { revenue: 1259600, cogs: 441000, opex: 990600, ytd: unknown("YTD_REPORT_NOT_RECEIVED") },
  cash: known(4620000),
  cashAsOf: "Oct 29",
  historicalRaised: 7000000,
  burn: scenario === "insufficient" ? unknown("INSUFFICIENT_HISTORY") : scenario === "zeroburn" ? known(0) : known(580000),
  burnWindowMonths: 3,
  burnHistoryMonths: scenario === "insufficient" ? 1 : 3,
  inventoryValue: 832000,
  accountsPayable: 480000,
  salesTaxPayable: 94200,
  forecastRevenue: 1400000,
  contributionPerOrder: 1420,
  samplesPlanned: 46,
  closeSummary: { period: "2026-10", label: "October", unmatchedPayouts: 2, cpaSignOff: "Pending" },
  cashHistory: [{ month: "Jul", minor: 6360000 }, { month: "Aug", minor: 5780000 }, { month: "Sep", minor: 5200000 }, { month: "Oct", minor: 4620000 }],
  // With no orders there is nothing to break down; an empty breakdown is drawn as such, never as the default $5,680 contribution.
  costBreakdown: scenario === "zeroorders" ? [] : [{ label: "Contribution", minor: 568000 }, { label: "Landed COGS", minor: 441000 }, { label: "Shipping", minor: 116400 }, { label: "Transaction fees", minor: 81200 }, { label: "Fulfillment", minor: 53000 }],
  payouts: [{ channel: "Shopify", matched: 18, needsReview: 1 }, { channel: "TikTok Shop", matched: 6, needsReview: 1 }],
  unitEconomics: unitEconomicsDemo(scenario),
  subscriptions: scenario === "subscriptionunread"
    ? { access: "unknown", reasonCode: "SUBSCRIPTION_SOURCE_NOT_READ", subscriptionProducts: null, definition: { version: "recurring-revenue@0", state: "notConfigured", reference: null }, monthlyRecurring: unknown("SUBSCRIPTION_SOURCE_NOT_READ") }
    : { access: "verified", reasonCode: null, subscriptionProducts: 0, definition: { version: "recurring-revenue@0", state: "notConfigured", reference: null }, monthlyRecurring: unknown("NO_SUBSCRIPTION_PRODUCT") },
  forecastPlan: { version: "forecast-illustrative@1", basis: "illustrative", assumptions: ["Revenue $14,000 for the 30-day window", "Not rebaselined against actuals"] },
});

/** Runway in months from verified cash and average burn. Null with a reason when it can't be computed honestly. */
export function runwayOf(d: FinanceDashboard): { months: number | null; reason: string | null } {
  if (d.burn.state !== "known" || d.burn.value === null || d.burnHistoryMonths < d.burnWindowMonths) return { months: null, reason: `Burn needs ${d.burnWindowMonths} months of history; ${d.burnHistoryMonths} available.` };
  if (d.cash.state !== "known" || d.cash.value === null) return { months: null, reason: "Current cash is unknown." };
  if (d.burn.value <= 0) return { months: null, reason: "Cash is not being spent, so there is no runway to count." };
  return { months: d.cash.value / d.burn.value, reason: null };
}

export type CloseState = "complete" | "unmatched" | "waiting" | "blocked";
export type CloseCheck = { check: string; owner: string; state: CloseState; label: string };
export type CloseExceptionRow = { payout: string; expected: number; difference: number };
export type PeriodClose = {
  datasetKey: "finance-demo";
  version: string;
  period: string;
  label: string;
  checks: CloseCheck[];
  closeOwner: string;
  cpaReview: string;
  status: PeriodStatus;
  exceptions: CloseExceptionRow[];
  /** Report package: each report is "not generated" until the close and export complete. */
  reports: { name: string; state: string }[];
  exportFailed: boolean;
};
