import { z } from "zod";
import { capabilityStateSchema } from "../contract.ts";

// Proposed front-end read model; no label executor or provider endpoint is implied.
const ref = z.string().trim().min(1);
const iso = z.string().datetime({ offset: true });
const money = z.object({ minorUnits: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) });
const freshness = z.object({ field: z.enum(["tracking", "inventory", "address", "quote", "terms"]), state: z.enum(["current", "stale", "unknown", "error"]), observedAt: iso.nullable(), sourceRef: ref });
const recipient = z.discriminatedUnion("type", [
  z.object({ type: z.literal("customer"), ref, display: ref }).strict(),
  z.object({ type: z.literal("creator"), ref, display: ref, collaborationRef: ref }).strict(),
]);
const origin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("order"), ref, channel: z.enum(["website", "tiktok-shop"]) }).strict(),
  z.object({ kind: z.literal("allocation"), ref, collaborationRef: ref, acceptedTermsVersion: ref.nullable() }).strict(),
  z.object({ kind: z.literal("replacement"), ref, parentOriginRef: ref, parentShipmentId: ref, approvalRef: ref.nullable() }).strict(),
  z.object({ kind: z.literal("reward"), ref, entitlementRef: ref, approvalRef: ref.nullable() }).strict(),
]);
export const hubShipmentSchema = z.object({
  id: ref, parcelId: ref, version: ref, requestedAt: iso, recipient, origin,
  purpose: z.enum(["sale", "sample", "replacement", "reward"]), sku: ref, quantity: z.number().int().positive(),
  location: ref, owner: ref, parcelIndex: z.number().int().positive(), parcelCount: z.number().int().positive(), remainingUnits: z.number().int().nonnegative(),
  readiness: z.enum(["ready", "address-pending", "stock-unavailable", "unapproved", "reservation-conflict", "dispatched", "return-hold"]),
  reservationRef: ref.nullable(), addressRef: ref.nullable(), addressVerified: z.boolean(),
  package: z.object({ weightGrams: z.number().positive(), lengthCm: z.number().positive(), widthCm: z.number().positive(), heightCm: z.number().positive(), measuredAt: iso }).nullable(),
  pipeline: z.enum(["ready", "label", "transit", "delivered", "returns"]),
  carrierState: z.enum(["unknown", "pre-transit", "accepted", "in-transit", "delivered", "returning"]),
  carrier: ref.nullable(), trackingRef: ref.nullable(), trackingUrl: z.string().url().nullable(),
  shipBy: iso.nullable(), eta: iso.nullable(), etaSource: ref.nullable(), deliveredAt: iso.nullable(), lastEventAt: iso.nullable(),
  label: z.object({ state: z.enum(["none", "purchased", "failed", "uncertain", "voided"]), transactionRef: ref.nullable(), receiptRef: ref.nullable(), cost: money.nullable() }).strict(),
  quote: z.object({ ref, service: ref, cost: money, maxCost: money, expiresAt: iso, observedAt: iso }).nullable(),
  exception: z.object({ kind: ref, message: ref }).nullable(), nextAction: ref,
  reviewCapability: z.object({ state: capabilityStateSchema, reason: ref.nullable() }),
  approval: z.object({ state: z.enum(["pending", "approved", "expired"]), actionVersion: ref, slackDecisionRef: ref.nullable(), linearReceiptRef: ref.nullable() }).nullable(),
  freshness: z.array(freshness),
  postingClock: z.object({ dueAt: iso, timezone: ref, recordRef: ref, observedAt: iso, acceptedTermsVersion: ref, brief: ref }).nullable(),
  timeline: z.array(z.object({ id: ref, occurredAt: iso, title: ref, evidenceRef: ref })),
}).strict().superRefine((s, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (s.parcelIndex > s.parcelCount) fail("Parcel index exceeds parcel count");
  if (s.origin.kind === "allocation" && s.recipient.type !== "creator") fail("A creator allocation needs a creator recipient");
  if (s.origin.kind === "order" && s.purpose !== "sale") fail("A sale keeps its native order origin");
  if (s.origin.kind === "replacement" && s.purpose !== "replacement") fail("Replacement origin and purpose must agree");
  if (s.origin.kind === "reward" && s.purpose !== "reward") fail("Reward origin and purpose must agree");
  if (s.postingClock && (s.recipient.type !== "creator" || s.carrierState !== "delivered" || !s.deliveredAt)) fail("Posting clock needs verified creator delivery");
  if (s.pipeline === "delivered" && (s.carrierState !== "delivered" || !s.deliveredAt)) fail("Delivered requires carrier delivery evidence");
  if (s.label.state === "purchased" && (!s.label.transactionRef || !s.label.receiptRef || !s.label.cost)) fail("Purchased label needs a transaction, receipt and actual cost");
  if (s.quote && (s.quote.cost.currency !== s.quote.maxCost.currency || s.quote.cost.minorUnits > s.quote.maxCost.minorUnits)) fail("Quote exceeds its same-currency bound");
  if (new Set(s.freshness.map(f => f.field)).size !== s.freshness.length) fail("Freshness fields must be unique");
});

export const shippingHubFields = z.object({
  datasetKey: ref, observedAt: iso, reviewValidUntil: iso, sourceLabel: ref,
  shipments: z.array(hubShipmentSchema),
  stock: z.array(z.object({ location: ref, sku: ref, onHand: z.number().int().nonnegative().nullable(), reserved: z.number().int().nonnegative().nullable() })),
  initialSelection: z.array(ref),
}).strict();
export const shippingHubSchema = shippingHubFields.superRefine((d, ctx) => {
  if (new Set(d.shipments.map(s => s.id)).size !== d.shipments.length) ctx.addIssue({ code: "custom", message: "Shipment IDs must be unique" });
  if (new Set(d.shipments.map(s => s.parcelId)).size !== d.shipments.length) ctx.addIssue({ code: "custom", message: "Parcel IDs must be unique" });
});
const safeRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/);
export const shippingHubCoverageSchema = z.object({ state: z.enum(["complete", "partial"]), expectedCount: z.number().int().nonnegative().safe().nullable(),
  observedCount: z.number().int().nonnegative().safe(), reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)).max(20) }).strict().superRefine((c, ctx) => {
  if (c.expectedCount !== null && c.observedCount > c.expectedCount || c.state === "complete" && (c.expectedCount === null || c.expectedCount !== c.observedCount) ||
    c.state === "partial" && c.reasonCodes.length === 0) ctx.addIssue({ code: "custom", message: "Coverage requires exact counts or an explicit partial reason." });
});
export const nativeShippingHubSchema = shippingHubFields.extend({
  datasetKey: z.literal("shipping-hub-native"), viewKey: z.literal("shippingHub"),
  provenance: z.object({ sourceRef: safeRef, sourceVersion: safeRef, permissionVersion: safeRef,
    evidenceStage: z.enum(["synthetic", "provider-observed"]), timezone: z.string().min(1).max(100),
    observedAt: iso, validUntil: iso, coverage: shippingHubCoverageSchema,
    ownerRefs: z.array(safeRef).min(1).max(4) }).strict(),
}).superRefine((d, ctx) => {
  if (!shippingHubSchema.safeParse(Object.fromEntries(Object.entries(d).filter(([key]) => key !== "viewKey" && key !== "provenance"))).success)
    ctx.addIssue({ code: "custom", message: "Invalid native shipment aggregate." });
  if (d.initialSelection.length !== 0 || d.shipments.some(s => s.reviewCapability.state === "available"))
    ctx.addIssue({ code: "custom", message: "A read projection cannot grant label execution or preselect an action." });
  if (d.provenance.coverage.observedCount !== d.shipments.length) ctx.addIssue({ code: "custom", message: "Observed coverage must reconcile to shipment rows." });
});
export type NativeShippingHubData = z.infer<typeof nativeShippingHubSchema>;
export const shippingHubViewSchemas = { shippingHub: z.union([nativeShippingHubSchema, shippingHubSchema.refine(d => d.datasetKey !== "shipping-hub-native", "Native data requires provenance.")]) };
export type HubShipment = z.infer<typeof hubShipmentSchema>;
export type ShippingHubData = z.infer<typeof shippingHubSchema>;
