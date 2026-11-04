import type { Interactions, MonitorPost } from "@/fixtures/monitor";

export const count = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const thousands = (n: number) => `${(n / 1000).toFixed(1)}k`;

/** Sum of a field over posts. If any post lacks it the total is unknown; a partial sum would pass as complete. */
export function sumKnown(posts: MonitorPost[], pick: (p: MonitorPost) => number | null): number | null {
  if (posts.length === 0) return null;
  let total = 0;
  for (const p of posts) {
    const v = pick(p);
    if (v === null) return null;
    total += v;
  }
  return total;
}

export const interactionsOf = (i: Interactions | null) => (i === null ? null : i.likes + i.comments + i.shares);

/** Engagement = (likes + comments + shares) / views, over posts that have both. Saves and unique reach aren't included. */
export function engagement(posts: MonitorPost[]) {
  const usable = posts.filter((p) => p.views !== null && p.views > 0 && p.interactions !== null);
  if (usable.length === 0) return null;
  const views = usable.reduce((s, p) => s + (p.views ?? 0), 0);
  const total = usable.reduce((s, p) => s + (interactionsOf(p.interactions) ?? 0), 0);
  return { ratePct: (100 * total) / views, interactions: total, views, included: usable.length, excluded: posts.length - usable.length };
}

export const ratePct = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "N/A");

/** The cumulative-views curve: x spans the plot, y is value over the axis maximum, zero at the bottom. */
export function curvePoints(thousandsSeries: number[], width: number, height: number) {
  const max = Math.max(1, Math.ceil(Math.max(...thousandsSeries) / 80) * 80);
  const n = thousandsSeries.length;
  const pts = thousandsSeries.map((v, i) => ({ x: n === 1 ? 0 : (i * width) / (n - 1), y: height - (v / max) * height }));
  return { max, pts };
}

/** A daily delta bar. The tallest bar is `tall` px, so every bar uses one zero-based scale. */
export const deltaHeight = (value: number, peak: number, tall = 180) => (peak > 0 ? Math.round((value / peak) * tall) : 0);
