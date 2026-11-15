import { z } from "zod";
import { alertCatalog, alertKinds } from "./catalog.ts";

export const thresholdReportContextSchema = z.object({
  kind: z.enum(alertKinds), observed: z.number().finite().nonnegative().nullable(), threshold: z.number().int().safe().nonnegative(),
  unit: z.enum(["basisPoints", "minorUnits", "units", "hours", "stars", "count"]),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), decimals: z.number().int().min(0).max(4).nullable(),
  sourceAsOf: z.string().datetime({ offset: true }).nullable(),
  state: z.enum(["breached", "clear", "incomplete"]),
}).strict().superRefine((value, ctx) => {
  if ((value.unit === "minorUnits") !== (value.currency !== null) || (value.currency === null) !== (value.decimals === null) ||
      (value.state === "breached" && (value.observed === null || value.sourceAsOf === null)) ||
      (value.state === "incomplete" && value.observed !== null)) {
    ctx.addIssue({ code: "custom", message: "Alert values require consistent source and units." });
  }
});
export type ThresholdReportContext = z.infer<typeof thresholdReportContextSchema>;

export const thresholdDigestSchema = z.object({
  sourceLink: z.string().regex(/^https:\/\/linear\.app\/[a-z0-9-]+\/issue\/[A-Z]{2,8}-[1-9]\d{0,8}$/),
  state: z.enum(["complete", "partial", "unavailable"]),
  active: z.number().int().safe().nonnegative(), activeRed: z.number().int().safe().nonnegative(),
  incomplete: z.number().int().safe().nonnegative(),
  conditions: z.array(z.string().regex(/^threshold-[a-f0-9]{32}-[1-9]\d*$/)).max(600),
  details: z.array(thresholdReportContextSchema).max(8),
}).strict().refine(value => (value.state !== "complete" || value.incomplete === 0) &&
  value.conditions.length === value.active && new Set(value.conditions).size === value.active);
export type ThresholdDigest = z.infer<typeof thresholdDigestSchema>;

function formatThreshold(value: number | null, item: ThresholdReportContext) {
  if (value === null) return "Unknown";
  if (item.unit === "minorUnits") {
    const precision = item.decimals ?? 0;
    const digits = value.toString().padStart(precision + 1, "0");
    return `${item.currency} ${precision ? digits.slice(0, -precision) + "." + digits.slice(-precision) : digits}`;
  }
  if (item.unit === "basisPoints") return `${(value / 100).toFixed(2)}%`;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${item.unit}`;
}

export function thresholdText(item: ThresholdReportContext) {
  const label = alertCatalog[item.kind][1];
  const value = formatThreshold(item.observed, item), limit = formatThreshold(item.threshold, item);
  return `${label} · ${value} · threshold ${limit} · as of ${item.sourceAsOf ?? "Unknown"}`;
}
