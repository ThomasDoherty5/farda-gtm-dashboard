import type { ProvenanceValue } from "@/adapter/contract";

/** "2.4 days" from two days up, otherwise hours. Hours below 24 are whole numbers. */
export const waitingLabel = (hours: number) => (hours >= 24 ? `${(hours / 24).toFixed(1)} days` : `${Math.round(hours)} hours`);

export const minutesAgoLabel = (minutes: number) => (minutes < 1 ? "just now" : minutes < 60 ? `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"} ago` : `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"} ago`);

export const minutesBetween = (laterIso: string, earlierIso: string) => (new Date(laterIso).getTime() - new Date(earlierIso).getTime()) / 60_000;

/** The number for a provenance value, or "N/A" with the reason. Known zero shows 0; it is never merged with unknown. */
export function figure<T>(value: ProvenanceValue<T>, format: (v: T) => string): string {
  return value.state === "known" && value.value !== null ? format(value.value) : "N/A";
}

export const REASON_TEXT: Record<string, string> = {
  TIMING_NOT_READ: "The warehouse mirror has not provided timing yet.",
  COST_NOT_READ: "Carrier costs have not been read yet.",
  SAMPLE_NOT_SOLD: "A sample is not a sale.",
  ISSUES_NOT_BY_HOME: "Support issues are not assigned to a home.",
  PRIOR_PERIOD_NOT_IN_DEMO: "The previous period is not in the demo data.",
  NOT_MEASURED: "Not measured in this source.",
};

export const reasonText = (value: ProvenanceValue<unknown>) => (value.state === "known" ? null : (value.reasonCode && REASON_TEXT[value.reasonCode]) ?? "Not available from the source.");
