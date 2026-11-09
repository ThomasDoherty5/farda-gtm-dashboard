import { createHmac } from "node:crypto";
import { z } from "zod";
import { shippingHubFields, shippingHubSchema, shippingHubCoverageSchema, nativeShippingHubSchema } from "../adapter/viewSchemas/shippingHub.ts";
import { digest } from "./config.ts";
import type { OperationsScope } from "./operations.ts";
import { boundedSourceRead } from "./actions/readBoundary.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";

const ref = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const instant = z.string().datetime({ offset: true });
const scopeSchema = z.object({ workspaceId: ref, accountId: ref, environment: z.literal("sandbox") }).strict();
const principalSchema = z.object({ principalRef: ref, role: z.enum(["reader", "reviewer"]) }).strict();
export const shippingHubBindingSchema = z.object({ scope: scopeSchema, principal: principalSchema,
  request: z.object({ viewKey: z.literal("shippingHub"), filters: z.object({}).strict(), limit: z.number().int().min(1).max(100) }).strict() }).strict();
export type ShippingHubBinding = z.infer<typeof shippingHubBindingSchema>;
const ownerSchema = z.object({ kind: z.enum(["shipping", "stock", "terms", "posting"]), sourceRef: ref, sourceVersion: ref,
  permissionVersion: ref, observedAt: instant, validUntil: instant, receiptRef: ref }).strict();

/** Read projection of existing shipment, reservation, terms and posting owners.
 * This boundary never stores facts or creates a shipment, reservation or label. */
export const shippingHubSnapshotSchema = z.object({ binding: shippingHubBindingSchema,
  sourceRef: ref, sourceVersion: ref, permissionVersion: ref, observedAt: instant, validUntil: instant,
  evidenceStage: z.enum(["synthetic", "provider-observed"]),
  timezone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }),
  coverage: shippingHubCoverageSchema, owners: z.array(ownerSchema).min(1).max(4),
  shipments: shippingHubFields.shape.shipments.max(1000), stock: shippingHubFields.shape.stock.max(1000),
}).strict().superRefine((s, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (s.shipments.length > s.binding.request.limit) bad("The source exceeded the requested finite read bound.");
  if (s.coverage.observedCount !== s.shipments.length) bad("Coverage must reconcile to canonical shipment rows.");
  if (new Set(s.owners.map(o => o.kind)).size !== s.owners.length) bad("Each owner is bound once.");
  const owners = new Set(s.owners.map(o => o.kind));
  if (!owners.has("shipping") || s.stock.length > 0 && !owners.has("stock") || s.shipments.some(row => row.origin.kind === "allocation") && !owners.has("terms") ||
      s.shipments.some(row => row.postingClock !== null) && !owners.has("posting")) bad("Every displayed fact needs its canonical owner.");
  const observed = Date.parse(s.observedAt);
  for (const owner of s.owners) if (Date.parse(owner.observedAt) > observed || Date.parse(owner.validUntil) <= Date.parse(owner.observedAt)) bad("Invalid owner observation or access lease.");
  for (const row of s.shipments) {
    if (Date.parse(row.requestedAt) > observed || row.lastEventAt && Date.parse(row.lastEventAt) > observed || row.deliveredAt && Date.parse(row.deliveredAt) > observed ||
        row.package && Date.parse(row.package.measuredAt) > observed || row.quote && Date.parse(row.quote.observedAt) > observed ||
        row.timeline.some(e => Date.parse(e.occurredAt) > observed) || row.freshness.some(f => f.observedAt && Date.parse(f.observedAt) > observed) ||
        row.postingClock && Date.parse(row.postingClock.observedAt) > observed) bad("Shipment observations cannot be in the future.");
    if (row.postingClock) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: row.postingClock.timezone }); }
      catch { bad("Posting deadlines require a valid source timezone."); }
    }
    if (![row.quantity, row.parcelIndex, row.parcelCount, row.remainingUnits].every(Number.isSafeInteger)) bad("Shipment counts must be safe integers.");
    if (row.label.cost && !Number.isSafeInteger(row.label.cost.minorUnits) || row.quote && (!Number.isSafeInteger(row.quote.cost.minorUnits) || !Number.isSafeInteger(row.quote.maxCost.minorUnits))) bad("Money must use safe integer minor units.");
    if ([row.label.cost, row.quote?.cost, row.quote?.maxCost].some(value => value && value.currency !== "USD")) bad("Native shipping currently supports USD minor units only.");
    if (row.origin.kind === "allocation" && row.recipient.type === "creator" && row.origin.collaborationRef !== row.recipient.collaborationRef) bad("Allocation and recipient must share their exact collaboration.");
    if (row.postingClock && (row.origin.kind !== "allocation" || row.postingClock.acceptedTermsVersion !== row.origin.acceptedTermsVersion)) bad("Posting deadlines require exact accepted allocation terms.");
  }
  for (const stock of s.stock) if ([stock.onHand, stock.reserved].some(value => value !== null && !Number.isSafeInteger(value))) bad("Stock counts must be safe integers.");
  if (new Set(s.stock.map(row => JSON.stringify([row.location, row.sku]))).size !== s.stock.length) bad("Stock rows must not duplicate a canonical home and SKU.");
  if (!shippingHubSchema.safeParse({ datasetKey: "shipping-hub-source", observedAt: s.observedAt, reviewValidUntil: s.validUntil,
    sourceLabel: "Canonical owners", shipments: s.shipments, stock: s.stock, initialSelection: [] }).success) bad("Invalid shipment identity or evidence.");
});
export type ShippingHubSnapshot = z.infer<typeof shippingHubSnapshotSchema>;
export type ShippingHubSource = {
  read(binding: ShippingHubBinding, signal?: AbortSignal): Promise<unknown>;
  assertCurrent(snapshot: ShippingHubSnapshot, binding: ShippingHubBinding, now: number): void;
};
export class ShippingHubReadError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
const fail = (code: string, status: number): never => { throw new ShippingHubReadError(code, status); };
export function createShippingHubReader(options: { scope: OperationsScope; referenceKey: string; source?: ShippingHubSource; now?: () => number }) {
  const { scope, source } = options, now = options.now ?? Date.now;
  if (options.referenceKey.length < 32) throw new Error("A private shipping reference key is required.");
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", options.referenceKey).update(JSON.stringify([scope, kind, value])).digest("hex").slice(0, 20);
  const nullable = (kind: string, value: string | null) => value === null ? null : alias(kind, value);
  async function read(principal: ShippingHubBinding["principal"], limit: number, signal?: AbortSignal) {
    const binding = shippingHubBindingSchema.parse({ scope, principal, request: { viewKey: "shippingHub", filters: {}, limit } });
    if (principal.principalRef !== `agent-${principal.role}`) fail("SHIPPING_SCOPE_DENIED", 403);
    if (!source) fail("SHIPPING_SOURCE_UNCONFIGURED", 503);
    if (typeof source.read !== "function" || typeof source.assertCurrent !== "function") fail("SHIPPING_SOURCE_INVALID", 502);
    let raw: unknown;
    try { raw = await boundedSourceRead(() => source.read(structuredClone(binding), signal), signal); }
    catch (error) {
      if (error instanceof ShippingHubReadError && [401, 403].includes(error.status)) fail("SHIPPING_SOURCE_DENIED", error.status);
      if (signal?.aborted) fail("REQUEST_CANCELLED", 499);
      fail("SHIPPING_SOURCE_UNAVAILABLE", 503);
    }
    const parsed = shippingHubSnapshotSchema.safeParse(raw);
    if (!parsed.success) fail("SHIPPING_SOURCE_INVALID", 502);
    const snapshot = parsed.data;
    const assertCurrent = () => {
      if (signal?.aborted) fail("REQUEST_CANCELLED", 499);
      if (digest(snapshot.binding) !== digest(binding)) fail("SHIPPING_SCOPE_DENIED", 403);
      const time = now();
      for (const proof of [snapshot, ...snapshot.owners]) if (!Number.isFinite(time) || Date.parse(proof.observedAt) > time ||
        Math.min(Date.parse(proof.validUntil), Date.parse(proof.observedAt) + 15 * 60_000) <= time) fail("SHIPPING_SOURCE_STALE", 409);
      try { assertSynchronousVoid(() => source.assertCurrent(structuredClone(snapshot), structuredClone(binding), time)); }
      catch (error) {
        if (error instanceof ShippingHubReadError && [401, 403].includes(error.status)) fail("SHIPPING_SOURCE_DENIED", error.status);
        if (error instanceof ShippingHubReadError && error.status === 409) fail("SHIPPING_SOURCE_CHANGED", 409);
        fail("SHIPPING_SOURCE_INVALID", 502);
      }
      if (signal?.aborted) fail("REQUEST_CANCELLED", 499);
    };
    assertCurrent();
    const shipments = snapshot.shipments.map(s => ({ ...s,
      id: alias("shipment", s.id), parcelId: alias("parcel", s.parcelId), version: alias("version", s.version),
      recipient: s.recipient.type === "customer" ? { ...s.recipient, ref: alias("customer", s.recipient.ref), display: alias("customer", s.recipient.ref) }
        : { ...s.recipient, ref: alias("creator", s.recipient.ref), display: alias("creator", s.recipient.ref), collaborationRef: alias("collaboration", s.recipient.collaborationRef) },
      origin: s.origin.kind === "order" ? { ...s.origin, ref: alias("order", s.origin.ref) }
        : s.origin.kind === "allocation" ? { ...s.origin, ref: alias("allocation", s.origin.ref), collaborationRef: alias("collaboration", s.origin.collaborationRef), acceptedTermsVersion: nullable("terms", s.origin.acceptedTermsVersion) }
        : s.origin.kind === "replacement" ? { ...s.origin, ref: alias("replacement", s.origin.ref), parentOriginRef: alias("origin", s.origin.parentOriginRef), parentShipmentId: alias("shipment", s.origin.parentShipmentId), approvalRef: nullable("approval", s.origin.approvalRef) }
        : { ...s.origin, ref: alias("reward", s.origin.ref), entitlementRef: alias("entitlement", s.origin.entitlementRef), approvalRef: nullable("approval", s.origin.approvalRef) },
      sku: alias("sku", s.sku), location: alias("home", s.location), owner: alias("owner", s.owner),
      reservationRef: nullable("reservation", s.reservationRef), addressRef: nullable("address-proof", s.addressRef),
      carrier: s.carrier && ["UPS", "USPS", "FedEx", "DHL"].includes(s.carrier) ? s.carrier : s.carrier ? "Other carrier" : null,
      trackingRef: nullable("tracking", s.trackingRef), trackingUrl: null, etaSource: s.etaSource ? "Carrier estimate" : null,
      label: { ...s.label, transactionRef: nullable("transaction", s.label.transactionRef), receiptRef: nullable("receipt", s.label.receiptRef) },
      quote: s.quote ? { ...s.quote, ref: alias("quote", s.quote.ref), service: "Source-qualified service" } : null,
      exception: s.exception ? { kind: "source-exception", message: "Inspect the source-owned exception before any action." } : null,
      nextAction: "Inspect source evidence", reviewCapability: { state: "held" as const, reason: "Read-only source projection; exact label execution remains with the fulfillment owner." },
      approval: s.approval ? { ...s.approval, actionVersion: alias("action-version", s.approval.actionVersion), slackDecisionRef: nullable("decision", s.approval.slackDecisionRef), linearReceiptRef: nullable("receipt", s.approval.linearReceiptRef) } : null,
      freshness: s.freshness.map(f => ({ ...f, sourceRef: alias("source", f.sourceRef) })),
      postingClock: s.postingClock ? { ...s.postingClock, recordRef: alias("posting", s.postingClock.recordRef), acceptedTermsVersion: alias("terms", s.postingClock.acceptedTermsVersion), brief: "Source-owned accepted brief" } : null,
      timeline: s.timeline.map(event => ({ ...event, id: alias("event", event.id), title: "Source shipment event", evidenceRef: alias("evidence", event.evidenceRef) })),
    }));
    const deadline = new Date(Math.min(...[snapshot, ...snapshot.owners].map(proof => Math.min(Date.parse(proof.validUntil), Date.parse(proof.observedAt) + 15 * 60_000)))).toISOString();
    const data = nativeShippingHubSchema.parse({ datasetKey: "shipping-hub-native", viewKey: "shippingHub", observedAt: snapshot.observedAt,
      reviewValidUntil: deadline, sourceLabel: snapshot.evidenceStage === "synthetic" ? "Synthetic owner evidence · sandbox" : "Canonical shipping, stock and source evidence",
      shipments, stock: snapshot.stock.map(s => ({ ...s, location: alias("home", s.location), sku: alias("sku", s.sku) })), initialSelection: [],
      provenance: { sourceRef: alias("source", snapshot.sourceRef), sourceVersion: alias("version", snapshot.sourceVersion), permissionVersion: alias("permission", snapshot.permissionVersion),
        evidenceStage: snapshot.evidenceStage, timezone: snapshot.timezone, observedAt: snapshot.observedAt, validUntil: deadline, coverage: snapshot.coverage,
        ownerRefs: snapshot.owners.map(o => alias("owner-proof", JSON.stringify(o))) } });
    assertCurrent();
    return { data, version: "sh1-" + digest(data), assertCurrent };
  }
  return { read };
}
