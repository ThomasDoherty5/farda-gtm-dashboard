import { z } from "zod";
import { analyticsCountSchema as count, analyticsRefSchema as ref, analyticsScopeSchema } from "../analytics/contract.ts";
import { instantSchema as instant, ordersSnapshotSchema, ticketCategories } from "../analytics/sources.ts";
import { alertKinds } from "../operationalAlerts/catalog.ts";
import { pulseSlotSchema } from "./schedule.ts";

const coverage = z.object({
  state: z.enum(["complete", "partial", "unavailable"]),
  sourceAsOf: instant.nullable(), version: ref, receiptRef: ref,
  maximumAgeMs: count.positive().max(31 * 86_400_000),
}).strict().refine(value => value.state !== "complete" || value.sourceAsOf !== null);
const amount = z.object({ minorUnits: count, currency: z.string().regex(/^[A-Z]{3}$/), decimals: count.max(4) }).strict();
const code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,23}$/);
const adStage = z.object({
  platform: z.enum(["meta", "tiktok", "gmvMax"]), stage: z.enum(["test", "validation", "scale"]),
  spentToday: amount, stageSpend: amount, stageCap: amount, capVersion: ref, capApprovalRef: ref,
}).strict().refine(({ spentToday, stageSpend, stageCap }) => stageCap.minorUnits > 0 &&
  spentToday.currency === stageSpend.currency && stageSpend.currency === stageCap.currency &&
  spentToday.decimals === stageSpend.decimals && stageSpend.decimals === stageCap.decimals &&
  spentToday.minorUnits <= stageSpend.minorUnits);
const support = z.object({ category: z.enum(ticketCategories), count }).strict();
const red = z.object({ kind: z.enum(alertKinds), count }).strict();
const range = z.object({ start: instant, end: instant }).strict().refine(value => Date.parse(value.start) < Date.parse(value.end));

export const launchPulseSourceSchema = z.object({
  scope: analyticsScopeSchema, requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: instant, validUntil: instant, receiptRef: ref,
  orders: z.object({
    coverage, through: range, definition: z.literal("headline-metrics.v1"), snapshot: ordersSnapshotSchema,
    creatorCodes: z.array(z.object({ canonicalOrderId: ref, code }).strict()).max(50_000),
  }).strict().nullable(),
  media: z.object({ coverage, through: range, stages: z.array(adStage).max(9) }).strict().nullable(),
  stock: z.object({ coverage, availableUnits: count.nullable() }).strict().nullable(),
  support: z.object({ coverage, categories: z.array(support).max(ticketCategories.length) }).strict().nullable(),
  alerts: z.object({ coverage, through: range, conditions: z.array(red).max(alertKinds.length) }).strict().nullable(),
}).strict();
export type LaunchPulseSourceSnapshot = z.infer<typeof launchPulseSourceSchema>;

const rollup = z.object({ orders: count, retainedUnits: count.nullable(), netReceiptsMinor: count.nullable() }).strict();
const attributionCounts = z.object({ code: count, utm: count, platform: count, unattributed: count, unknown: count }).strict();
function observed<T extends z.ZodTypeAny>(value: T) {
  return z.object({ sourceAsOf: instant.nullable(), reason: z.enum(["missing", "partial", "stale", "mismatch"]).nullable(),
    value: value.nullable() }).strict().refine(item => (item.value === null) === (item.reason !== null) &&
    (item.value === null || item.sourceAsOf !== null));
}
export const launchDashboardLinkSchema = z.string().url().max(300).refine(value => {
  try {
    const link = new URL(value);
    return link.protocol === "https:" && !link.username && !link.password && !link.search && !link.hash && !/[<>|\s]/.test(value);
  } catch { return false; }
});
export const launchPulseContextSchema = z.object({
  slot: pulseSlotSchema, dashboardLink: launchDashboardLinkSchema, coverage: z.enum(["complete", "partial"]),
  commerce: observed(z.object({
    hour: rollup, today: rollup, launch: rollup, attribution: attributionCounts,
    topCodes: z.array(z.object({ code, orders: count.positive() }).strict()).max(3).nullable(),
  }).strict()),
  media: observed(z.array(adStage).max(9)),
  stock: observed(z.object({ availableUnits: count, hoursOfCover: z.number().finite().nonnegative().nullable() }).strict()),
  support: observed(z.array(support).max(ticketCategories.length)),
  alerts: observed(z.array(red).max(alertKinds.length)),
}).strict();
export type LaunchPulseContext = z.infer<typeof launchPulseContextSchema>;
