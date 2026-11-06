import type { Criterion, OfferDraftPayload, OfferDraftRecord } from "@/fixtures/scorecards";

export const pointsOf = (c: Criterion) => (c.rating === null ? null : (c.weight * c.rating) / 5);

/**
 * Weighted score. Points = weight × rating ÷ 5. A criterion with no rating is unknown, not zero, and the others are
 * never rescaled to fill the gap, so an incomplete scorecard has no total.
 */
export function scoreOf(criteria: Criterion[]) {
  const known = criteria.filter((c) => c.rating !== null);
  const earned = known.reduce((s, c) => s + (pointsOf(c) ?? 0), 0);
  const max = criteria.reduce((s, c) => s + c.weight, 0);
  const complete = known.length === criteria.length;
  return { earned, max, complete, total: complete ? Math.round(earned) : null, unknownCount: criteria.length - known.length };
}

/** Proposed historical bands: 80 to 100 priority, 65 to 79 manual review, below 65 hold. The current bands are read from the agent. */
export const bandOf = (score: number | null) => (score === null ? "Needs data" : score >= 80 ? "Priority review" : score >= 65 ? "Manual review" : "Hold");

/* ---------- Offer economics ---------- */

export const usd2 = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
/** Whole dollars when there are no cents, otherwise two places. */
export const usdAuto = (n: number) => (Number.isInteger(n) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n) : usd2(n));
export const signed = (n: number) => (n < 0 ? `−${usdAuto(-n)}` : usdAuto(n));

/** Round to the cent, so displayed and summed figures agree. */
const cents = (n: number) => Math.round(n * 100) / 100;

export function economics(a: OfferDraftRecord["assumptions"], p: Pick<OfferDraftPayload, "commissionPct" | "sampleShippingMinor" | "upfrontFeeMinor">) {
  const net = a.netSaleMinor / 100;
  const cost = a.commerceCostMinor / 100;
  const commission = (net * p.commissionPct) / 100;
  const processing = (commission * a.processingPctOfCommission) / 100;
  const unit = net - cost - commission - processing;
  const sample = p.sampleShippingMinor / 100;
  const upfront = p.upfrontFeeMinor / 100;
  const scenario = (orders: number) => ({
    orders,
    netSales: net * orders,
    commerceCosts: cost * orders,
    commission: commission * orders,
    providerFee: processing * orders,
    upfrontFee: upfront,
    sample,
    contribution: cents(unit * orders - upfront - sample),
  });
  return {
    unit,
    base: scenario(a.baseOrders),
    downside: scenario(a.downsideOrders),
    /** Orders needed for unit contribution to cover the sample and any upfront fee. Null when each order loses money. */
    breakEven: unit > 0 ? Math.ceil((sample + upfront) / unit) : null,
  };
}

/** Parses "15% of eligible merchandise". The percentage must be above 0 and at most 100. */
export function parseCommission(text: string): { pct: number | null; error: string | null } {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%(?:\s+of\s+eligible\s+merchandise)?\s*$/i.exec(text);
  if (!m) return { pct: null, error: "Enter a percentage of eligible merchandise, such as 15%." };
  const pct = Number(m[1]);
  if (!(pct > 0 && pct <= 100)) return { pct: null, error: "The percentage must be above 0 and at most 100." };
  return { pct, error: null };
}

/** Parses a dollar amount such as "$25" or "25.50". Negative or non-numeric input is refused. */
export function parseDollars(text: string): { minor: number | null; error: string | null } {
  const m = /^\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(text);
  if (!m) return { minor: null, error: "Enter an amount in dollars, such as $25." };
  return { minor: Math.round(Number(m[1]) * 100), error: null };
}
