import type { AttributionData } from "@/fixtures/analytics";

/** The weekly chart's y axis: $3,500 sits 180px above the baseline, as drawn in the design. */
export const AXIS_MAX_MINOR = 350_000;
export const BAR_AXIS_PX = 180;

/** Bar height in pixels. Zero-baseline, so a bar is always proportional to its value. */
export const weekBarHeight = (minorUnits: number) => Math.round((minorUnits / AXIS_MAX_MINOR) * BAR_AXIS_PX);

export function weekTotals(weeks: AttributionData["weeks"]) {
  return {
    shopify: weeks.reduce((s, w) => s + w.shopify.minorUnits, 0),
    tiktok: weeks.reduce((s, w) => s + w.tiktok.minorUnits, 0),
  };
}
