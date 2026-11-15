/**
 * Finance unit-economics dictionary and hand-calculated cases. SYNTHETIC. The `finance-unit-economics-cases` dataset is kept apart
 * from `finance-demo`, the headline-metric cases and the commission pilot; no case reads another dataset. Amounts are USD cents at
 * source precision, and every expected value was worked by hand before the code ran.
 *
 * The entries reuse the headline dictionary's fields (`DictionaryEntry`) so the two read the same way. Every definition here is
 * PROPOSED: no adopted finance policy exists in this repository, and nothing here was reviewed by a CPA.
 */
import { UNIT_ECONOMICS_VERSION, type CostComponent, type CostObservation, type SubscriptionSource, type UnitEconomicsInput } from "@/features/finance/unitEconomics";
import type { DictionaryEntry } from "./headlineMetrics";
import { known, unknown } from "./values";

export type FinanceMetricKey = "grossMargin" | "contributionPerOrder" | "acquisitionCost" | "cac" | "cacPaybackOrders" | "mrr" | "arr";
export type FinanceDictionaryEntry = Omit<DictionaryEntry, "key"> & { key: FinanceMetricKey; unit: string; whenUnavailable: string };

const WINDOW_TEXT = "The dashboard's 30-day management window";
export const financeMetricDictionary = {
  datasetKey: "finance-unit-economics-cases" as const,
  version: UNIT_ECONOMICS_VERSION,
  policy: "No adopted finance policy exists in this repository, and these definitions have not been reviewed by a CPA.",
  entries: [
    {
      key: "grossMargin", label: "Gross margin", unit: "Percent", numerator: "Net revenue − landed COGS (gross profit)", denominator: "Net revenue",
      source: "Management P&L (QuickBooks)", currency: "USD", window: WINDOW_TEXT,
      costBuckets: "Landed COGS of sold units only. A sample's landed cost is acquisition, not COGS.",
      refundTreatment: "Net revenue is after refunds posted to date.",
      whenUnavailable: "N/A with no net revenue. Provisional while any SKU has no landed cost.",
    },
    {
      key: "contributionPerOrder", label: "Pre-marketing contribution / order", unit: "USD per order",
      numerator: "Net revenue − landed COGS − customer shipping − provider fees − fulfillment", denominator: "Valid orders in the cohort",
      source: "Management P&L and the cohort's cost rows", currency: "USD", window: WINDOW_TEXT,
      costBuckets: "Contribution components only. No paid media, samples, content fees or commission. Each obligation once; landed COGS must tie to the P&L.",
      refundTreatment: "Net revenue is after refunds. A provider fee the provider keeps on a refund stays a cost.",
      whenUnavailable: "N/A with zero orders, an unknown or unreported component, or rows that don't tie to the P&L. Provisional while landed cost is incomplete.",
    },
    {
      key: "acquisitionCost", label: "Acquisition cost", unit: "USD",
      numerator: "Paid media + sample landed cost + sample shipping + historical content fees + accrued commission net of reversals", denominator: "None",
      source: "The cohort's cost rows: provider and platform bills, sample shipments, accepted fees, commission accruals", currency: "USD", window: WINDOW_TEXT,
      costBuckets: "Each obligation once. A commission accrual and the provider's cash settlement of it are one cost, as are a content fee and its payment. Cash settlement is never a second cost. Commission belongs to the affiliate pilot; the original dashboard cohort has none.",
      refundTreatment: "Not reduced by customer refunds. Commission reversals reduce the accrual.",
      whenUnavailable: "N/A when a component is unknown or unreported, a row belongs to another cohort, or creator-cost coverage is unknown. Provisional while creator costs are partly allocated.",
    },
    {
      key: "cac", label: "CAC", unit: "USD per new customer", numerator: "Acquisition cost", denominator: "New customers in the cohort",
      source: "As acquisition cost; anonymous new-customer counts", currency: "USD", window: WINDOW_TEXT,
      costBuckets: "As acquisition cost", refundTreatment: "As acquisition cost",
      whenUnavailable: "N/A with no new customers. Provisional while attribution coverage is incomplete or unknown.",
    },
    {
      key: "cacPaybackOrders", label: "CAC payback", unit: "Orders", numerator: "CAC", denominator: "Pre-marketing contribution per order",
      source: "As CAC and contribution", currency: "USD", window: WINDOW_TEXT,
      costBuckets: "Acquisition and contribution components are disjoint, so no cost is in both.", refundTreatment: "As CAC and contribution",
      whenUnavailable: "N/A when CAC or contribution per order is N/A, or contribution per order is not positive. Provisional when either input is.",
    },
    {
      key: "mrr", label: "MRR", unit: "USD per month", numerator: "Recurring subscription revenue in the month", denominator: "None",
      source: "A verified subscription product in the order source", currency: "USD", window: "One calendar month",
      costBuckets: "None", refundTreatment: "Set by the recurring-revenue definition once adopted",
      whenUnavailable: "Unknown when the subscription source isn't read. \"No subscription revenue\" only when verified. N/A until a recurring-revenue definition is adopted. One-time orders never count.",
    },
    {
      key: "arr", label: "ARR", unit: "USD per year", numerator: "MRR × 12", denominator: "None",
      source: "As MRR", currency: "USD", window: "As MRR", costBuckets: "None", refundTreatment: "As MRR",
      whenUnavailable: "Shown only when MRR is. One-time orders are never annualized.",
    },
  ] satisfies FinanceDictionaryEntry[],
};

const COHORT = "synthetic-case-a";
const PERIOD = { start: "2026-10-01", end: "2026-10-31", timezone: "UTC" };
const row = (component: CostComponent, ref: string, minorUnits: number, basis: CostObservation["basis"] = "paid", obligationId = `${ref}/${component}`, cohortId = COHORT): CostObservation =>
  ({ component, basis, minorUnits, cohortId, obligationId, evidenceId: `${ref}/${component}/${basis}`, cashId: basis === "paid" ? `CASH-${ref}/${component}` : null, currency: "USD", period: PERIOD });

/** Source events of case A. Revenue is the sum of sales and refunds; each cost row names the event it came from. */
export const caseAEvents = [
  { ref: "TEST-SALE-1", kind: "sale", minorUnits: 3400 },
  { ref: "TEST-SALE-2", kind: "sale", minorUnits: 2999 },
  { ref: "TEST-SALE-3", kind: "sale", minorUnits: 3400 },
  { ref: "TEST-REFUND-1", kind: "refund", minorUnits: -500 },
] as const;

const caseACosts: CostObservation[] = [
  row("landedCogs", "TEST-SALE-1", 1137, "accrued"), row("landedCogs", "TEST-SALE-2", 1012, "accrued"), row("landedCogs", "TEST-SALE-3", 1137, "accrued"),
  row("shipping", "TEST-SALE-1", 291), row("shipping", "TEST-SALE-2", 291), row("shipping", "TEST-SALE-3", 291),
  row("providerFees", "TEST-SALE-1", 129), row("providerFees", "TEST-SALE-2", 117), row("providerFees", "TEST-SALE-3", 129),
  row("fulfillment", "TEST-SALE-1", 133), row("fulfillment", "TEST-SALE-2", 133), row("fulfillment", "TEST-SALE-3", 133),
  row("paidMedia", "TEST-MEDIA-1", 3000),
  row("sampleLanded", "TEST-SAMPLE-1", 2274, "accrued"), row("sampleShipping", "TEST-SAMPLE-1", 655),
  // One commission obligation, observed twice: the accrual (net of the $0.75 refund reversal) and the provider's cash settlement of it.
  row("commission", "TEST-COMM-1", 1395, "accrued", "TEST-COMM-1"), row("commission", "TEST-COMM-1", 1395, "paid", "TEST-COMM-1"),
];

const caseA: UnitEconomicsInput = {
  definition: { version: UNIT_ECONOMICS_VERSION, state: "proposed", reference: null },
  cohort: { id: COHORT, label: "Synthetic case A", currency: "USD", period: PERIOD },
  validOrders: known(3), newCustomers: known(2),
  landedCost: { complete: true, missingSkus: [] },
  creatorCosts: { state: "complete", expected: 1, observed: 1, reasonCodes: [] },
  attribution: { state: "complete", expected: 3, observed: 3, reasonCodes: [] },
  costs: caseACosts,
  declared: [{ component: "historicalContentFee", state: "notApplicable", reasonCode: "COMMISSION_ONLY_ACQUISITION" }],
};
const caseAPnl = { revenue: 9299, cogs: 3286 };

export type UnitEconomicsCase = {
  id: string; label: string; pnl: { revenue: number; cogs: number }; input: UnitEconomicsInput;
  expected: { grossMargin: string; contributionPerOrder: string; acquisitionCost: string; cac: string; paybackOrders: string };
  handCalculation: string;
};

const NORMAL = "Revenue 3,400 + 2,999 + 3,400 − 500 = 9,299 · COGS 1,137 + 1,012 + 1,137 = 3,286 · shipping 3 × 291 = 873 · provider fees 129 + 117 + 129 = 375 · fulfillment 3 × 133 = 399";
export const unitEconomicsCases: UnitEconomicsCase[] = [
  {
    id: "sale-refund-sample-commission", label: "Sales, a refund, a sample and a settled commission", pnl: caseAPnl, input: caseA,
    expected: { grossMargin: "64.7%", contributionPerOrder: "$14.55", acquisitionCost: "$73.24", cac: "$36.62", paybackOrders: "2.52 orders" },
    handCalculation: `${NORMAL} · gross margin 6,013 ÷ 9,299 = 64.66% · contribution 9,299 − 4,933 = 4,366, ÷ 3 orders = 1,455.33 · acquisition 3,000 + 2,274 + 655 + 1,395 = 7,324 (the 1,395 commission once, not 2,790) · CAC 7,324 ÷ 2 = 3,662 · payback 3,662 ÷ 1,455.33 = 2.516 orders`,
  },
  {
    id: "landed-cost-incomplete", label: "Incomplete landed cost", pnl: caseAPnl, input: { ...caseA, landedCost: { complete: false, missingSkus: ["TEST-SKU-02"] } },
    expected: { grossMargin: "64.7% · Provisional · Landed cost incomplete", contributionPerOrder: "$14.55 · Provisional · Landed cost incomplete", acquisitionCost: "$73.24", cac: "$36.62", paybackOrders: "2.52 orders · Provisional · Landed cost incomplete" },
    handCalculation: "Same arithmetic as case A. A SKU without landed cost understates COGS, so margin, contribution and payback are provisional",
  },
  {
    id: "creator-and-attribution-partial", label: "Creator costs and attribution incomplete", pnl: caseAPnl,
    input: { ...caseA, creatorCosts: { state: "partial", expected: 2, observed: 1, reasonCodes: ["CREATOR_COSTS_UNALLOCATED"] }, attribution: { state: "partial", expected: 3, observed: 2, reasonCodes: ["ORDERS_UNATTRIBUTED"] } },
    expected: { grossMargin: "64.7%", contributionPerOrder: "$14.55", acquisitionCost: "$73.24 · Provisional · Creator costs partly allocated", cac: "$36.62 · Provisional · Creator costs partly allocated · Attribution coverage incomplete", paybackOrders: "2.52 orders · Provisional · Creator costs partly allocated · Attribution coverage incomplete" },
    handCalculation: "Same arithmetic as case A. One creator's costs are not allocated, so the acquisition total is a floor; one order is unattributed",
  },
  {
    id: "zero-orders", label: "Zero orders", pnl: { revenue: 0, cogs: 0 },
    input: { ...caseA, validOrders: known(0), newCustomers: known(0), costs: [row("paidMedia", "TEST-MEDIA-1", 3000)],
      declared: [...(["landedCogs", "shipping", "providerFees", "fulfillment", "sampleLanded", "sampleShipping", "commission"] as const).map((component) => ({ component, state: "knownZero" as const, reasonCode: "NO_ORDERS" })), ...caseA.declared] },
    expected: { grossMargin: "N/A · No net revenue in the period", contributionPerOrder: "N/A · No valid orders in the cohort", acquisitionCost: "$30.00", cac: "N/A · No new customers in the cohort", paybackOrders: "N/A · No new customers in the cohort" },
    handCalculation: "0 ÷ 0 has no value, so margin, contribution per order, CAC and payback are N/A. Media spent with no orders is a known $30.00, not hidden",
  },
  {
    id: "unknown-sample-shipping", label: "Unknown sample shipping", pnl: caseAPnl,
    input: { ...caseA, costs: caseACosts.filter((c) => c.component !== "sampleShipping"), declared: [...caseA.declared, { component: "sampleShipping", state: "unknown", reasonCode: "SHIPMENT_COST_NOT_READ" }] },
    expected: { grossMargin: "64.7%", contributionPerOrder: "$14.55", acquisitionCost: "N/A · Sample shipping unknown", cac: "N/A · Sample shipping unknown", paybackOrders: "N/A · Sample shipping unknown" },
    handCalculation: "Sample shipping is unknown, so acquisition cost is not 6,669; it has no value, and neither do CAC and payback",
  },
  {
    id: "pilot-row-in-cohort", label: "Cohort isolation: a pilot row in this cohort", pnl: caseAPnl,
    input: { ...caseA, costs: [...caseACosts, row("commission", "TEST-PILOT-COMM-1", 900, "accrued", "TEST-PILOT-COMM-1", "pilot-cohort-b")] },
    expected: { grossMargin: "64.7%", contributionPerOrder: "N/A · A cost row belongs to another cohort", acquisitionCost: "N/A · A cost row belongs to another cohort", cac: "N/A · A cost row belongs to another cohort", paybackOrders: "N/A · A cost row belongs to another cohort" },
    handCalculation: "The 900 pilot commission is not added (7,324 + 900 = 8,224 would mix cohorts); every cost figure is N/A until the row is removed, because the input as a whole is not one cohort",
  },
  {
    id: "settlement-amount-conflict", label: "A settlement that disagrees with its accrual", pnl: caseAPnl,
    input: { ...caseA, costs: [...caseACosts.filter((c) => c.component !== "commission"), row("commission", "TEST-COMM-1", 1395, "accrued", "TEST-COMM-1"), row("commission", "TEST-COMM-1", 1300, "paid", "TEST-COMM-1")] },
    expected: { grossMargin: "64.7%", contributionPerOrder: "N/A · One obligation is reported with two amounts", acquisitionCost: "N/A · One obligation is reported with two amounts", cac: "N/A · One obligation is reported with two amounts", paybackOrders: "N/A · One obligation is reported with two amounts" },
    handCalculation: "Accrued 1,395 and settled 1,300 for one obligation: neither 1,395, 1,300 nor 2,695 is chosen; the difference needs reconciliation first, and every cost figure waits for it",
  },
  {
    id: "obligation-under-two-components", label: "One obligation under two components", pnl: caseAPnl,
    input: { ...caseA, costs: [...caseACosts, { ...row("sampleLanded", "TEST-SALE-1", 1137, "accrued"), obligationId: "TEST-SALE-1/landedCogs" }] },
    expected: { grossMargin: "64.7%", contributionPerOrder: "N/A · One obligation is reported under two cost components", acquisitionCost: "N/A · One obligation is reported under two cost components", cac: "N/A · One obligation is reported under two cost components", paybackOrders: "N/A · One obligation is reported under two cost components" },
    handCalculation: "Sale 1's 1,137 landed cost appears as COGS and as a sample. Counting it in both would add 1,137 twice (COGS 3,286 and acquisition 8,461), so every cost figure is N/A until the source assigns it once",
  },
];

const policy = { version: "recurring-revenue@0", state: "notConfigured" as const, reference: null };
export type SubscriptionCase = { id: string; label: string; source: SubscriptionSource; expected: { kind: string; mrr: string; arr: string }; handCalculation: string };
export const subscriptionCases: SubscriptionCase[] = [
  { id: "unavailable", label: "Subscription source not read", source: { access: "unknown", reasonCode: "SUBSCRIPTION_SOURCE_NOT_READ", subscriptionProducts: null, definition: policy, monthlyRecurring: unknown("SUBSCRIPTION_SOURCE_NOT_READ") },
    expected: { kind: "unavailable", mrr: "Unknown", arr: "Unknown" }, handCalculation: "Not read is unknown, never zero and never \"none\"" },
  { id: "verified-none", label: "Verified: no subscription product", source: { access: "verified", reasonCode: null, subscriptionProducts: 0, definition: policy, monthlyRecurring: unknown("NO_SUBSCRIPTION_PRODUCT") },
    expected: { kind: "none", mrr: "None", arr: "None" }, handCalculation: "The source lists 0 subscription products. $12,596 of one-time orders is not annualized" },
  { id: "definition-not-adopted", label: "Product verified, definition only proposed", source: { access: "verified", reasonCode: null, subscriptionProducts: 1, definition: { version: "recurring-revenue@1", state: "proposed", reference: null }, monthlyRecurring: known(45000) },
    expected: { kind: "notDefined", mrr: "N/A", arr: "N/A" }, handCalculation: "A proposed definition is not adopted, so even a reported $450.00 is not shown as MRR" },
  { id: "adopted", label: "Product verified, synthetic adopted definition", source: { access: "verified", reasonCode: null, subscriptionProducts: 1, definition: { version: "recurring-revenue@1", state: "adopted", reference: "TEST-POLICY-RR-1" }, monthlyRecurring: known(45000) },
    expected: { kind: "known", mrr: "$450.00", arr: "$5,400.00" }, handCalculation: "45,000 cents a month · ARR 45,000 × 12 = 540,000 cents. The policy reference is a synthetic test value, not an adopted policy" },
];
