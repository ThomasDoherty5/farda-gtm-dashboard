import { z } from "zod";
import { analyticsCountSchema as count, analyticsRefSchema as ref, analyticsScopeSchema } from "../analytics/contract.ts";
import { instantSchema as instant, timezoneSchema } from "../analytics/sources.ts";

const day = z.string().date();
const graceDays = count.max(365);
const schedule = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("fixed"), due: day, graceDays }).strict(),
  z.object({ basis: z.literal("delivery"), daysAfter: count.max(365), graceDays }).strict(),
  z.object({ basis: z.literal("possession"), daysAfter: count.max(365), graceDays }).strict(),
  z.object({ basis: z.literal("voluntary"), observationUntil: day.nullable() }).strict(),
]);
const terms = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unverified") }).strict(),
  z.object({
    state: z.literal("accepted"), agreementRef: ref, version: ref, acceptedAt: instant, timezone: timezoneSchema,
    deliverables: z.array(z.object({ deliverableId: ref, schedule }).strict()).min(1).max(100)
      .refine(rows => new Set(rows.map(row => row.deliverableId)).size === rows.length),
  }).strict(),
]);
const observation = z.object({
  eventRef: ref, occurredAt: instant, observedAt: instant, receiptRef: ref,
  state: z.enum(["labelCreated", "inTransit", "delivered", "lost", "returned", "deliveryCorrection"]),
  correctsEventRef: ref.nullable(),
}).strict().refine(row => (row.state === "deliveryCorrection") === (row.correctsEventRef !== null) &&
  Date.parse(row.occurredAt) <= Date.parse(row.observedAt));
const shipment = z.object({
  shipmentRef: ref, collaborationId: ref.nullable(), kind: z.enum(["creatorSample", "customerOrder", "customerReplacement"]),
  sourceVersion: ref, observations: z.array(observation).max(500),
}).strict();
const shipping = z.object({
  source: z.literal("shippingLog"), coverage: z.enum(["complete", "partial"]), observedAt: instant, validUntil: instant,
  primaryRef: ref, effectiveRef: ref, replacementDecisionRef: ref.nullable(),
  shipments: z.array(shipment).max(50),
}).strict().refine(source => (source.primaryRef === source.effectiveRef) === (source.replacementDecisionRef === null) &&
  Date.parse(source.validUntil) > Date.parse(source.observedAt));

export const clockDeliverySchema = z.object({ shipmentRef: ref, eventRef: ref, receiptRef: ref, at: instant }).strict();
export const clockDeadlineSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("dated"), deliverableId: ref, basis: z.enum(["fixed", "delivery", "possession"]),
    due: day, reviewAfter: day }).strict(),
  z.object({ state: z.literal("voluntary"), deliverableId: ref, observationUntil: day.nullable() }).strict(),
  z.object({ state: z.literal("pending"), deliverableId: ref, reason: z.enum(["DELIVERY_UNVERIFIED", "POSSESSION_UNVERIFIED"]) }).strict(),
]);
const appliedClock = z.object({
  receiptRef: ref, agreementVersion: ref, clockKey: z.string().regex(/^[a-f0-9]{64}$/),
  termsHash: z.string().regex(/^[a-f0-9]{64}$/),
  delivery: clockDeliverySchema.nullable(), appliedAt: instant,
}).strict();
export const postingClockSourceSchema = z.object({
  scope: analyticsScopeSchema, collaborationId: ref, sourceVersion: ref, observedAt: instant, validUntil: instant,
  targetRevision: ref, terms, shipping: shipping.nullable(),
  possession: z.object({ receiptRef: ref, confirmedAt: instant, collaborationId: ref }).strict().nullable(),
  previous: appliedClock.nullable(),
}).strict();
export type PostingClockSource = z.infer<typeof postingClockSourceSchema>;

export const postingClockProjectionSchema = z.object({
  state: z.enum(["ready", "pending", "review", "alreadyApplied", "notApplicable"]),
  sourceVersion: ref, observedAt: instant, targetRevision: ref,
  agreementVersion: ref.nullable(), termsHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), timezone: timezoneSchema.nullable(),
  delivery: clockDeliverySchema.nullable(), previous: appliedClock.nullable(),
  deadlines: z.array(clockDeadlineSchema).max(100),
  clockKey: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  reason: z.enum(["SOURCE_STALE", "SOURCE_COVERAGE_PARTIAL", "TERMS_UNVERIFIED", "SHIPPING_PARTIAL", "SHIPPING_STALE", "SHIPMENT_IDENTITY_UNVERIFIED",
    "SHIPMENT_EVENT_CONFLICT", "DELIVERY_EXCEPTION", "DELIVERY_CORRECTION", "DELIVERY_ALREADY_RECORDED", "TERMS_VERSION_REUSED",
    "ANCHOR_UNVERIFIED", "POSSESSION_ALREADY_RECORDED", "NO_REQUIRED_POST"]).nullable(),
}).strict();
export type PostingClockProjection = z.infer<typeof postingClockProjectionSchema>;
export const postingClockReadSchema = postingClockProjectionSchema.pick({
  state: true, observedAt: true, timezone: true, deadlines: true, reason: true,
});
