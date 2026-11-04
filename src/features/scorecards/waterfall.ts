import { signed, usdAuto } from "./scorecardMath";

/**
 * The contribution waterfall's geometry, from Figma 65:634: net sales is drawn 244px tall from a baseline 278px down the
 * chart, so every bar uses one scale. Each cost hangs from where the previous step ended, and a nonzero amount is at
 * least 1px tall so it can't vanish.
 */
export const WATERFALL = { baseline: 278, netHeight: 244, lines: [34, 156, 278], labelTop: 290 };

type Scenario = { netSales: number; commerceCosts: number; commission: number; providerFee: number; upfrontFee: number; sample: number; contribution: number };

export function waterfallBars(s: Scenario) {
  const k = s.netSales > 0 ? WATERFALL.netHeight / s.netSales : 0;
  const h = (v: number) => Math.max(1, Math.round(v * k));
  const top0 = WATERFALL.baseline - WATERFALL.netHeight;
  let level = s.netSales;
  const hang = (label: string, v: number) => {
    const top = WATERFALL.baseline - level * k;
    const bar = { label, value: v === 0 ? usdAuto(0) : signed(-v), top, height: h(v), valueTop: top - 27, strong: false };
    level -= v;
    return bar;
  };
  return [
    { label: "Net sales", value: usdAuto(s.netSales), top: top0, height: WATERFALL.netHeight, valueTop: top0 - 27, strong: true },
    hang("Commerce costs", s.commerceCosts),
    hang("Commission", s.commission),
    hang("Provider fee", s.providerFee),
    hang("Upfront fee", s.upfrontFee),
    hang("Sample", s.sample),
    { label: "Contribution", value: usdAuto(s.contribution), top: WATERFALL.baseline - h(s.contribution), height: h(s.contribution), valueTop: WATERFALL.baseline - h(s.contribution) - 27, strong: true },
  ];
}
