import type { FunnelCampaign } from "@/fixtures/analytics";

export const STEPS = ["contacted", "replied", "agreed", "shipped", "delivered", "posted"] as const;
export type Step = (typeof STEPS)[number];

export function totals(campaigns: FunnelCampaign[]): Record<Step, number> {
  const out = Object.fromEntries(STEPS.map((s) => [s, 0])) as Record<Step, number>;
  for (const c of campaigns) for (const s of STEPS) out[s] += c.steps[s];
  return out;
}

/** Gift capacity counts shipped and reserved units together; a reservation isn't physical depletion, but it uses the cap. */
export function capacityUse(c: FunnelCampaign) {
  const used = c.steps.shipped + c.reserved;
  return { used, cap: c.giftCap, over: used > c.giftCap };
}

/**
 * Mature posting health. Only delivered units past their review-after date count, so early posts and recipients who
 * aren't due yet never inflate the denominator. A zero mature group has no rate, which is not 0%.
 */
export function maturePosting(delivered: number, notYetMature: number, posted: number) {
  const mature = Math.max(0, delivered - notYetMature);
  return { mature, noPost: Math.max(0, mature - posted), rate: mature > 0 ? (100 * posted) / mature : null };
}
