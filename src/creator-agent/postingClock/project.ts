import { digest } from "../config.ts";
import { postingClockProjectionSchema, type PostingClockProjection, type PostingClockSource } from "./contract.ts";

function dateInTimezone(at: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(at));
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}
const plusDays = (day: string, days: number) => new Date(Date.parse(day + "T00:00:00.000Z") + days * 86_400_000)
  .toISOString().slice(0, 10);

type Shipping = NonNullable<PostingClockSource["shipping"]>;
type Delivery = NonNullable<PostingClockProjection["delivery"]>;
type Reason = NonNullable<PostingClockProjection["reason"]>;
type Sample = { delivery: Delivery | null; reason: Reason | null };
type Observation = Shipping["shipments"][number]["observations"][number];
const nativeFact = (row: Observation) => [row.state, Date.parse(row.occurredAt), row.receiptRef, row.correctsEventRef];

function sampleDelivery(source: Shipping | null, collaborationId: string, asOf: number): Sample {
  if (!source) return { delivery: null, reason: null };
  const hold = (reason: Reason): Sample => ({ delivery: null, reason });
  const observed = Date.parse(source.observedAt);
  if (source.coverage !== "complete" || observed > asOf) return hold("SHIPPING_PARTIAL");
  const references = new Set(source.shipments.map(row => row.shipmentRef));
  const primary = source.shipments.find(row => row.shipmentRef === source.primaryRef);
  const effective = source.shipments.find(row => row.shipmentRef === source.effectiveRef);
  if (references.size !== source.shipments.length || !primary || !effective ||
      [primary, effective].some(row => row.kind !== "creatorSample" || row.collaborationId !== collaborationId)) {
    return hold("SHIPMENT_IDENTITY_UNVERIFIED");
  }
  const byEvent = new Map<string, Observation>();
  for (const event of effective.observations) {
    const prior = byEvent.get(event.eventRef);
    if (Date.parse(event.observedAt) > observed || prior && digest(nativeFact(prior)) !== digest(nativeFact(event))) {
      return hold("SHIPMENT_EVENT_CONFLICT");
    }
    if (!prior || Date.parse(event.observedAt) < Date.parse(prior.observedAt)) byEvent.set(event.eventRef, event);
  }
  const events = [...byEvent.values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
    Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.eventRef.localeCompare(b.eventRef, "en"));
  const deliveries = events.filter(event => event.state === "delivered");
  const first = deliveries[0];
  if (first && deliveries.some(event => Date.parse(event.occurredAt) !== Date.parse(first.occurredAt))) return hold("SHIPMENT_EVENT_CONFLICT");
  const delivery = first ? { shipmentRef: effective.shipmentRef, eventRef: first.eventRef, receiptRef: first.receiptRef,
    at: new Date(first.occurredAt).toISOString() } : null;
  const corrections = events.filter(event => event.state === "deliveryCorrection");
  if (corrections.some(event => byEvent.get(event.correctsEventRef!)?.state !== "delivered")) return hold("SHIPMENT_EVENT_CONFLICT");
  if (corrections.length) return { delivery, reason: "DELIVERY_CORRECTION" };
  if (events.some(event => (event.state === "returned" || event.state === "lost") &&
      (!first || Date.parse(event.occurredAt) >= Date.parse(first.occurredAt)))) return { delivery, reason: "DELIVERY_EXCEPTION" };
  return { delivery, reason: null };
}

/** A source-qualified clock proposal. Actual application is owned by the version-checked Notion writer. */
export function projectPostingClock(source: PostingClockSource, now: number): PostingClockProjection {
  const asOf = Date.parse(source.observedAt), expires = Date.parse(source.validUntil);
  const base = {
    sourceVersion: source.sourceVersion, observedAt: source.observedAt, targetRevision: source.targetRevision,
    previous: source.previous, delivery: null, agreementVersion: null, termsHash: null, timezone: null, deadlines: [], clockKey: null,
  };
  const pending = (reason: Reason) => postingClockProjectionSchema.parse({ ...base, state: "pending", reason });
  if (!Number.isFinite(now) || asOf > now || expires <= now || expires <= asOf) return pending("SOURCE_STALE");
  const terms = source.terms;
  if (terms.state !== "accepted" || Date.parse(terms.acceptedAt) > asOf) return pending("TERMS_UNVERIFIED");
  const termsHash = digest([terms.agreementRef, terms.version, Date.parse(terms.acceptedAt), terms.timezone,
    [...terms.deliverables].sort((a, b) => a.deliverableId.localeCompare(b.deliverableId, "en"))]);
  if (source.previous && Date.parse(source.previous.appliedAt) > asOf) return pending("SOURCE_STALE");
  const sample = sampleDelivery(source.shipping, source.collaborationId, asOf);
  const prior = source.previous?.delivery;
  const sameDelivery = prior && sample.delivery && prior.shipmentRef === sample.delivery.shipmentRef &&
    Date.parse(prior.at) === Date.parse(sample.delivery.at);
  const delivery = sameDelivery ? prior : sample.delivery;
  const scoped = { ...base, delivery, agreementVersion: terms.version, termsHash, timezone: terms.timezone };
  if (source.previous?.agreementVersion === terms.version && source.previous.termsHash !== termsHash) {
    return postingClockProjectionSchema.parse({ ...scoped, state: "review", reason: "TERMS_VERSION_REUSED" });
  }
  if (sample.reason || prior && source.previous?.agreementVersion === terms.version && !sameDelivery) {
    return postingClockProjectionSchema.parse({ ...scoped, state: "review",
      reason: sample.reason ?? "DELIVERY_ALREADY_RECORDED" });
  }
  const possession = source.possession?.collaborationId === source.collaborationId &&
    Date.parse(source.possession.confirmedAt) <= asOf ? source.possession : null;
  const deadlines = terms.deliverables.map(({ deliverableId, schedule }): PostingClockProjection["deadlines"][number] => {
    if (schedule.basis === "voluntary") return { state: "voluntary", deliverableId, observationUntil: schedule.observationUntil };
    if (schedule.basis === "fixed") return { state: "dated", deliverableId, basis: schedule.basis,
      due: schedule.due, reviewAfter: plusDays(schedule.due, schedule.graceDays) };
    const anchor = schedule.basis === "delivery" ? delivery?.at : possession?.confirmedAt;
    if (!anchor) return { state: "pending", deliverableId,
      reason: schedule.basis === "delivery" ? "DELIVERY_UNVERIFIED" : "POSSESSION_UNVERIFIED" };
    const due = plusDays(dateInTimezone(anchor, terms.timezone), schedule.daysAfter);
    return { state: "dated", deliverableId, basis: schedule.basis, due, reviewAfter: plusDays(due, schedule.graceDays) };
  }).sort((a, b) => a.deliverableId.localeCompare(b.deliverableId, "en"));
  if (deadlines.some(row => row.state === "pending")) return postingClockProjectionSchema.parse({ ...scoped, deadlines, state: "pending", reason: "ANCHOR_UNVERIFIED" });
  if (deadlines.every(row => row.state === "voluntary") && !delivery) return postingClockProjectionSchema.parse({
    ...scoped, deadlines, state: "notApplicable", reason: "NO_REQUIRED_POST",
  });
  const clockKey = digest([source.scope, source.collaborationId, termsHash, delivery,
    possession && deadlines.some(row => row.state === "dated" && row.basis === "possession")
      ? [possession.receiptRef, Date.parse(possession.confirmedAt)] : null, deadlines]);
  return postingClockProjectionSchema.parse({ ...scoped, deadlines, clockKey, reason: null,
    state: source.previous?.clockKey === clockKey ? "alreadyApplied" : "ready" });
}
