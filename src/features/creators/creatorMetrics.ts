import type { Money } from "@/adapter/contract";
import { CUMULATIVE_SHARE, OWNERS, type Network, type SocialCatBoardData, type SocialCatDashboardData } from "@/fixtures/creators";

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** A rate with a fixed number of decimals, or null when there is no denominator. Known zero stays "0.00%". */
export const rate = (numerator: number, denominator: number, digits = 1): string | null => (denominator === 0 ? null : `${((100 * numerator) / denominator).toFixed(digits)}%`);

export const stageTotal = (stage: SocialCatBoardData["stages"][number]) => OWNERS.reduce((a, o) => a + stage.byOwner[o], 0);
export const boardTotal = (data: SocialCatBoardData) => data.stages.reduce((a, s) => a + stageTotal(s), 0);
export const ownerSum = (r: Record<(typeof OWNERS)[number], number>) => OWNERS.reduce((a, o) => a + r[o], 0);

const NETWORKS: Network[] = ["instagram", "tiktok"];

/** Social Cat reads linked Instagram and TikTok posts. Views and rates exist only where a post is measurable. */
export function socialCatTotals(data: SocialCatDashboardData) {
  const picked = NETWORKS.filter((n) => data.network === "all" || data.network === n).map((n) => data.networks[n]);
  const add = (pick: (f: (typeof picked)[number]) => number) => picked.reduce((a, f) => a + pick(f), 0);
  const measurable = add((f) => f.measurablePosts);
  const views = add((f) => f.views);
  const net: Money = { minorUnits: picked.reduce((a, f) => a + f.net.minorUnits, 0), currency: "USD" };
  return { posts: add((f) => f.posts), measurable, views: measurable === 0 ? null : views, interactions: add((f) => f.interactions), engagementRate: measurable === 0 ? null : rate(add((f) => f.interactions), views, 2), orders: add((f) => f.orders), net };
}

/** Cumulative series for the chart: the demo curve scaled to a final total. */
export const cumulativeSeries = (total: number) => CUMULATIVE_SHARE.map((share) => Math.round(share * total));
