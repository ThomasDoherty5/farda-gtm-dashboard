import type { ConsentData } from "@/fixtures/lifecycle";

/** A share as one-decimal percent text, or null when the denominator is zero, which is unknown and never "0%". */
export const percent = (part: number, whole: number): string | null => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : null);

export const formatCount = (n: number) => new Intl.NumberFormat("en-US").format(n);

/**
 * The four mutually exclusive consent categories, in Figma's order. Only a record the provider confirms as opted in counts
 * as eligible; unknown is held and never treated as opted in.
 */
export function consentSegments(c: ConsentData) {
  return [
    { key: "eligible", label: `${formatCount(c.eligible)} eligible`, count: c.eligible, tone: "violet" as const, color: "var(--color-violet)" },
    { key: "withdrawn", label: `${formatCount(c.withdrawn)} withdrawn`, count: c.withdrawn, tone: "warning" as const, color: "var(--color-warning)" },
    { key: "suppressed", label: `${formatCount(c.suppressed)} suppressed`, count: c.suppressed, tone: "danger" as const, color: "var(--color-danger)" },
    { key: "unknown", label: `${formatCount(c.unknown)} unknown`, count: c.unknown, tone: "neutral" as const, color: "var(--color-muted)" },
  ];
}

/** True when every record is in exactly one category. A snapshot that doesn't add up is shown as a data problem, not drawn. */
export const consentReconciles = (c: ConsentData) => c.eligible + c.withdrawn + c.suppressed + c.unknown === c.total;
