import type { Money, ProvenanceValue } from "@/adapter/contract";

const REASONS: Record<string, string> = {
  NO_COMPLETE_POSTS: "No post has complete likes, comments, shares and views.",
  ZERO_VIEWS: "Views are zero, so a rate cannot be calculated.",
  SHARES_UNAVAILABLE: "Shares are unavailable from the source.",
};

export const formatMoney = (m: Money) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency, minimumFractionDigits: m.minorUnits % 100 === 0 ? 0 : 2 }).format(m.minorUnits / 100);
export const formatCount = (n: number) => new Intl.NumberFormat("en-US").format(n);

/** Renders a provenance value. Known zero shows 0; unknown or not applicable shows N/A with its reason. */
export function MetricValue<T>({ value, format }: { value: ProvenanceValue<T>; format: (v: T) => string }) {
  if (value.state === "known" && value.value !== null) return <span data-state="known">{format(value.value)}</span>;
  const reason = (value.reasonCode && REASONS[value.reasonCode]) ?? "Not available from the source.";
  return (
    <span data-state={value.state}>
      N/A <span style={{ font: "var(--text-small)", color: "var(--color-text-muted)" }}>— {reason}</span>
    </span>
  );
}
