import { z } from "zod";
import { digestScopeSchema } from "../dailyDigest/contract.ts";
import { alertKinds } from "./catalog.ts";
export { alertCatalog, alertKinds, type AlertKind } from "./catalog.ts";

const ref = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(value => !value.includes("://"));
const instant = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const quantity = z.number().int().safe().nonnegative();
const currency = z.string().regex(/^[A-Z]{3}$/);
const rule = z.object({
  kind: z.enum(alertKinds), version: ref, ownerRef: ref, approvalRef: ref, sourceRef: ref,
  effectiveAt: instant, endAt: instant.nullable(), maxAgeMs: quantity.positive().max(31 * 86_400_000),
  severity: z.enum(["red", "orange"]), comparison: z.enum(["atOrAbove", "above", "atOrBelow"]),
  unit: z.enum(["basisPoints", "minorUnits", "units", "hours", "stars", "count"]),
  threshold: quantity, currency: currency.nullable(), decimals: z.number().int().min(0).max(4).nullable(),
}).strict().superRefine((value, ctx) => {
  const expected = {
    mediaNearCap: ["basisPoints", "atOrAbove", 9000],
    mediaAtCap: ["basisPoints", "atOrAbove", 10_000],
    budgetOverrun: ["minorUnits", "above", value.threshold],
    budgetCeiling: ["minorUnits", value.comparison === "above" ? "above" : "atOrAbove", value.threshold],
    lowStock: [value.unit === "hours" ? "hours" : "units", "atOrBelow", value.threshold],
    zeroStock: ["units", "atOrBelow", 0],
    sampleReserve: ["units", "atOrBelow", 0],
    shipmentStale: ["hours", "above", value.threshold],
    shipmentException: ["count", "atOrAbove", 1],
    supportAge: ["hours", "above", value.threshold],
    lowRating: ["stars", "atOrBelow", value.threshold],
    orderChecks: ["count", "atOrAbove", 1],
  }[value.kind];
  if ([value.unit, value.comparison, value.threshold].some((item, index) => item !== expected[index]) ||
      (value.unit === "minorUnits") !== (value.currency !== null) || (value.currency === null) !== (value.decimals === null) ||
      (value.kind === "lowRating" && (value.threshold < 1 || value.threshold > 5)) ||
      (value.endAt && Date.parse(value.endAt) <= Date.parse(value.effectiveAt))) {
    ctx.addIssue({ code: "custom", message: "An approved threshold must match its operational condition and units." });
  }
});
export type AlertRule = z.infer<typeof rule>;
export const alertPolicySchema = z.object({
  scope: digestScopeSchema, version: ref, timezone: z.literal("America/Los_Angeles"),
  recoveryOwnerRef: ref, rules: z.array(rule).max(alertKinds.length),
}).strict().refine(policy => new Set(policy.rules.map(value => value.kind)).size === policy.rules.length);
export type AlertPolicy = z.infer<typeof alertPolicySchema>;

const observation = z.object({
  entityRef: ref, sourceRef: ref, sourceVersion: ref, asOf: instant,
  coverage: z.enum(["complete", "partial", "unavailable"]),
  periodRef: ref,
});
const media = observation.extend({ family: z.literal("media"), currency, spent: quantity.nullable(),
  stageCap: quantity.positive().nullable(), capApprovalRef: ref.nullable() }).strict();
const budget = observation.extend({ family: z.literal("budget"), currency, decimals: z.number().int().min(0).max(4),
  actual: quantity.nullable(), committed: quantity.nullable(),
  remainingForecast: quantity.nullable(), unpricedCategories: quantity.nullable(), disjointBasisRef: ref.nullable() }).strict();
const inventory = observation.extend({ family: z.literal("inventory"), onHand: quantity.nullable(), activeReservations: quantity.nullable(),
  sampleAvailable: quantity.nullable(), waitingCollaborations: quantity.nullable(), retainedUnitsPerDay: quantity.nullable() }).strict();
const shipment = observation.extend({ family: z.literal("shipment"), tracking: z.enum(["active", "closed", "unknown"]),
  lastTrackingAt: instant.nullable(), deliveryException: z.boolean().nullable() }).strict();
const support = observation.extend({ family: z.literal("support"), open: z.boolean().nullable(), openedAt: instant.nullable() }).strict();
const review = observation.extend({ family: z.literal("review"), stars: z.number().int().min(1).max(5).nullable() }).strict();
const orders = observation.extend({ family: z.literal("orders"), failedOrderCount: quantity.nullable() }).strict();
export const alertObservationSchema = z.discriminatedUnion("family", [media, budget, inventory, shipment, support, review, orders]);
export type AlertObservation = z.infer<typeof alertObservationSchema>;
export const alertFamilies = ["media", "budget", "inventory", "shipment", "support", "review", "orders"] as const;
export const alertSweepSchema = z.object({
  scope: digestScopeSchema, policyVersion: ref, runRef: ref, sourceReceipt: ref, observedAt: instant,
  completeFamilies: z.array(z.enum(alertFamilies)).max(alertFamilies.length),
  expected: z.array(z.object({ family: z.enum(alertFamilies),
    entityRef: ref, periodRef: ref }).strict()).max(300),
  observations: z.array(alertObservationSchema).max(300),
}).strict();
export type AlertSweep = z.infer<typeof alertSweepSchema>;
