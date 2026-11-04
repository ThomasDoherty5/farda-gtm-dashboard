/** A rate to fixed places, from a part and a whole. A zero whole is unknown, never 0. */
export function rate(part: number, whole: number, digits: number): string | null {
  if (!(whole > 0)) return null;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format((part * 100) / whole);
}

/** Average of 1 to 5 star counts, to one place. No rated reviews means no average, not 0. */
export function averageRating(stars: { star: number; count: number }[]): string | null {
  const n = stars.reduce((s, r) => s + r.count, 0);
  if (n === 0) return null;
  return (stars.reduce((s, r) => s + r.star * r.count, 0) / n).toFixed(1);
}

/** The next multiple of 5 at or above the largest count, so bars share one stated zero-baseline scale. */
export const niceScale = (max: number) => Math.max(5, Math.ceil(max / 5) * 5);
