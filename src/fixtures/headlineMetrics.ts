/**
 * Versioned dictionary and hand-checked cases for the headline metrics. Synthetic. The `headline-metrics-cases` dataset is kept
 * apart from `overview-original` and the pilot commission data; the normal case repeats the original's figures on purpose so a
 * test can prove they reconcile, and no other case reads from any other dataset.
 */
export type DictionaryEntry = {
  key: "aov" | "blendedCac" | "mer" | "platformRoas";
  label: string;
  numerator: string;
  denominator: string;
  source: string;
  currency: string;
  window: string;
  costBuckets: string;
  refundTreatment: string;
};

export type DictionaryRelated = { label: string; basis: string };

export type CostBucketRow = { key: string; label: string; basis: "paid" | "accrued" | "estimated"; minorUnits: number; alsoInCash: boolean; note: string };

export type CaseInput = { netReceiptsMinor: number | null; validOrders: number | null; acquisitionCostMinor: number | null; newRetainedCustomers: number | null; marketingSpendMinor: number | null; caveat: "LANDED_COST_INCOMPLETE" | "RETENTION_IMMATURE" | null };
export type MetricCase = { id: string; label: string; input: CaseInput; /** Hand-calculated before the code, as display text. */ expected: { aov: string; cac: string; mer: string }; handCalculation: string };

export type MetricDictionaryData = {
  datasetKey: "headline-metrics-cases";
  version: string;
  effective: string;
  stage: "fixture-complete";
  entries: DictionaryEntry[];
  related: DictionaryRelated[];
  buckets: CostBucketRow[];
  cases: MetricCase[];
  sourceNote: string;
};

const SCOPE = "Valid orders, 30 Sep–29 Oct 2026 (demo period)";

export const metricDictionaryDemo: MetricDictionaryData = {
  datasetKey: "headline-metrics-cases",
  version: "headline-metrics@1",
  effective: "2026-10-30",
  stage: "fixture-complete",
  entries: [
    {
      key: "aov", label: "AOV", numerator: "Net receipts", denominator: "Valid orders in the cohort",
      source: "Reconciled orders and receipts (Shopify and TikTok Shop)", currency: "USD", window: SCOPE,
      costBuckets: "None", refundTreatment: "Refunds are deducted from net receipts. A late refund revises the figure and creates a correction record.",
    },
    {
      key: "blendedCac", label: "Blended CAC", numerator: "Included acquisition cost", denominator: "New retained customers",
      source: "Cost buckets below; anonymous retained-customer counts", currency: "USD", window: `${SCOPE}; retention window must be mature, otherwise provisional`,
      costBuckets: "Media, creator fees, sample shipping, gifted-product economic cost, applicable commissions. Each counted once.",
      refundTreatment: "Customers whose only order is fully refunded are not retained. Cost is not reduced by refunds.",
    },
    {
      key: "mer", label: "MER", numerator: "Net receipts", denominator: "Total marketing spend in the same scope as CAC cost",
      source: "Reconciled receipts; cost buckets below", currency: "USD", window: SCOPE,
      costBuckets: "Same buckets as blended CAC", refundTreatment: "Net receipts are after refunds, so a refund lowers MER.",
    },
    {
      key: "platformRoas", label: "Platform ROAS", numerator: "That platform's reported purchase value", denominator: "That platform's spend",
      source: "The platform's own report, labeled platform-reported", currency: "USD", window: "The platform's attribution window and source. The demo does not supply one",
      costBuckets: "That platform's spend only", refundTreatment: "Whatever the platform reports; not adjusted. Never added across platforms, never relabeled as Farda net sales, never compared with MER.",
    },
  ],
  related: [
    { label: "Cost per retained order", basis: "Acquisition cost ÷ retained orders. One order per customer purchase event." },
    { label: "Cost per retained unit", basis: "Acquisition cost ÷ retained units. A two-bottle order is one order and two units." },
  ],
  buckets: [
    { key: "media", label: "Media (Meta and TikTok)", basis: "paid", minorUnits: 500_000, alsoInCash: true, note: "Cash paid to the platforms" },
    { key: "creator-sample", label: "Creator fees, sample shipping and gifted product", basis: "estimated", minorUnits: 200_000, alsoInCash: false, note: "Gifted product is counted once, as economic cost, and not added again as cash" },
  ],
  cases: [
    {
      id: "normal", label: "Normal (original fixture)",
      input: { netReceiptsMinor: 1_259_600, validOrders: 400, acquisitionCostMinor: 700_000, newRetainedCustomers: 280, marketingSpendMinor: 700_000, caveat: null },
      expected: { aov: "$31.49", cac: "$25.00", mer: "1.80×" },
      handCalculation: "$12,596 ÷ 400 = $31.49 · $7,000 ÷ 280 = $25.00 · $12,596 ÷ $7,000 = 1.7994",
    },
    {
      id: "refund", label: "Refund revision",
      input: { netReceiptsMinor: 1_250_000, validOrders: 400, acquisitionCostMinor: 700_000, newRetainedCustomers: 280, marketingSpendMinor: 700_000, caveat: null },
      expected: { aov: "$31.25", cac: "$25.00", mer: "1.79×" },
      handCalculation: "A late $96 refund revises net receipts to $12,500 · $12,500 ÷ 400 = $31.25 · $12,500 ÷ $7,000 = 1.7857 · CAC is unchanged",
    },
    {
      id: "known-zero-spend", label: "Known zero spend",
      input: { netReceiptsMinor: 100_000, validOrders: 40, acquisitionCostMinor: 0, newRetainedCustomers: 20, marketingSpendMinor: 0, caveat: null },
      expected: { aov: "$25.00", cac: "$0.00", mer: "N/A · zero denominator" },
      handCalculation: "$0 ÷ 20 = $0.00, a known zero · $1,000 ÷ $0 has no value, so N/A · $1,000 ÷ 40 = $25.00",
    },
    {
      id: "zero-customers", label: "Zero new customers and orders",
      input: { netReceiptsMinor: 0, validOrders: 0, acquisitionCostMinor: 100_000, newRetainedCustomers: 0, marketingSpendMinor: 100_000, caveat: null },
      expected: { aov: "N/A · zero denominator", cac: "N/A · zero denominator", mer: "0.00×" },
      handCalculation: "$0 ÷ 0 orders and $1,000 ÷ 0 customers have no value · $0 ÷ $1,000 = 0.00, a known zero",
    },
    {
      id: "unknown-spend", label: "Unknown spend",
      input: { netReceiptsMinor: 1_259_600, validOrders: 400, acquisitionCostMinor: null, newRetainedCustomers: 280, marketingSpendMinor: null, caveat: null },
      expected: { aov: "$31.49", cac: "N/A · an input is unknown", mer: "N/A · an input is unknown" },
      handCalculation: "Spend is not known, so CAC and MER are N/A and never 0 · AOV needs no spend",
    },
    {
      id: "immature", label: "Immature retention",
      input: { netReceiptsMinor: 1_259_600, validOrders: 400, acquisitionCostMinor: 700_000, newRetainedCustomers: 280, marketingSpendMinor: 700_000, caveat: "RETENTION_IMMATURE" },
      expected: { aov: "$31.49", cac: "$25.00 · Provisional · retention window not yet mature", mer: "1.80×" },
      handCalculation: "Same arithmetic as the normal case; CAC carries a provisional label until the retention window closes",
    },
  ],
  sourceNote: "Synthetic fixture. Real inputs wait for the reconciled order source and cost buckets (THO-283, THO-285, THO-166, THO-195).",
};
