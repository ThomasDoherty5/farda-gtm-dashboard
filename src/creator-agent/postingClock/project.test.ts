// @vitest-environment node
import { describe, expect, it } from "vitest";
import { postingClockSourceSchema, type PostingClockSource } from "./contract.ts";
import { projectPostingClock } from "./project.ts";

const observedAt = "2026-11-06T18:00:00.000Z", now = Date.parse(observedAt);
const actualDelivery = "2026-11-01T06:30:00.000Z";
const transit = { eventRef: "TEST-TRANSIT", receiptRef: "TEST-TRANSIT-RECEIPT",
  state: "inTransit", occurredAt: "2026-10-31T14:00:00.000Z", observedAt, correctsEventRef: null } as const;
const delivered = { ...transit, eventRef: "TEST-DELIVERED", receiptRef: "TEST-DELIVERY-RECEIPT",
  state: "delivered", occurredAt: actualDelivery } as const;
const source = () => postingClockSourceSchema.parse({
  scope: { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" },
  collaborationId: "TEST-COLLAB", sourceVersion: "TEST-SOURCE-v1", targetRevision: "TEST-ROW-v1",
  observedAt, validUntil: "2026-11-06T18:10:00.000Z",
  terms: { state: "accepted", agreementRef: "TEST-TERMS", version: "TEST-TERMS-v1",
    acceptedAt: "2026-10-29T18:00:00.000Z", timezone: "America/Los_Angeles",
    deliverables: [{ deliverableId: "TEST-A", schedule: { basis: "delivery", daysAfter: 2, graceDays: 1 } },
      { deliverableId: "TEST-B", schedule: { basis: "fixed", due: "2026-11-04", graceDays: 0 } }] },
  shipping: { source: "shippingLog", coverage: "complete", observedAt, primaryRef: "TEST-SHIPMENT",
    effectiveRef: "TEST-SHIPMENT", replacementDecisionRef: null,
    shipments: [{ shipmentRef: "TEST-SHIPMENT", collaborationId: "TEST-COLLAB", kind: "creatorSample",
      sourceVersion: "TEST-SHIP-v2", observations: [delivered, transit, { ...delivered, observedAt: "2026-11-05T18:00:00.000Z" }] }] },
  possession: null, previous: null,
});
function record(source: PostingClockSource) {
  const ready = projectPostingClock(source, now);
  source.previous = { receiptRef: "TEST-NOTION-APPLIED", agreementVersion: ready.agreementVersion!,
    clockKey: ready.clockKey!, termsHash: ready.termsHash!, delivery: ready.delivery, appliedAt: observedAt };
  return ready;
}

describe("source-qualified creator posting clock", () => {
  it("uses actual delivery event time across DST and keeps each accepted deliverable's own deadline", () => {
    const input = source(), ready = record(input);
    expect(ready).toMatchObject({ state: "ready", delivery: { at: actualDelivery }, deadlines: [
      { state: "dated", deliverableId: "TEST-A", basis: "delivery", due: "2026-11-02", reviewAfter: "2026-11-03" },
      { state: "dated", deliverableId: "TEST-B", basis: "fixed", due: "2026-11-04", reviewAfter: "2026-11-04" },
    ] });
    input.shipping!.shipments[0]!.observations.reverse();
    input.sourceVersion = "TEST-SOURCE-v2";
    input.targetRevision = "TEST-ROW-v2";
    if (input.terms.state !== "accepted") throw new Error("Fixture terms missing");
    input.terms.acceptedAt = "2026-10-29T11:00:00-07:00";
    input.shipping!.shipments[0]!.observations.push({ ...delivered, occurredAt: "2026-10-31T23:30:00-07:00" });
    expect(projectPostingClock(input, now)).toMatchObject({ state: "alreadyApplied", clockKey: ready.clockKey });
  });

  it("rejects customer, mismatched collaboration, label-only and partial observations", () => {
    const input = source(), sample = input.shipping!.shipments[0]!;
    sample.kind = "customerReplacement";
    expect(projectPostingClock(input, now)).toMatchObject({ state: "review", reason: "SHIPMENT_IDENTITY_UNVERIFIED", clockKey: null });
    sample.kind = "creatorSample"; sample.collaborationId = "OTHER";
    expect(projectPostingClock(input, now).reason).toBe("SHIPMENT_IDENTITY_UNVERIFIED");
    sample.collaborationId = input.collaborationId;
    sample.observations = [{ ...transit, state: "labelCreated" }, transit];
    // Two different native facts cannot reuse a source event identity.
    expect(projectPostingClock(input, now).reason).toBe("SHIPMENT_EVENT_CONFLICT");
    sample.observations = [{ ...transit, eventRef: "TEST-LABEL", state: "labelCreated" }, transit];
    expect(projectPostingClock(input, now)).toMatchObject({ state: "pending", reason: "ANCHOR_UNVERIFIED", delivery: null });
    input.shipping!.coverage = "partial";
    expect(projectPostingClock(input, now).reason).toBe("SHIPPING_PARTIAL");
    expect(projectPostingClock(input, Date.parse(input.validUntil))).toMatchObject({ state: "pending", reason: "SOURCE_STALE" });
  });

  it("keeps prior confirmed proof after returned, corrected or changed replacement evidence", () => {
    const input = source(), ready = record(input), selected = input.shipping!.shipments[0]!;
    selected.observations.push({ ...transit, eventRef: "TEST-RETURN", receiptRef: "TEST-RETURN-RECEIPT",
      occurredAt: "2026-11-03T18:00:00.000Z", state: "returned" });
    expect(projectPostingClock(input, now)).toMatchObject({ state: "review", reason: "DELIVERY_EXCEPTION",
      previous: { clockKey: ready.clockKey }, clockKey: null });
    selected.observations.pop();
    selected.observations.push({ ...transit, eventRef: "TEST-CORRECTION", receiptRef: "TEST-CORRECTION-RECEIPT",
      occurredAt: "2026-11-03T18:00:00.000Z", state: "deliveryCorrection", correctsEventRef: delivered.eventRef });
    expect(projectPostingClock(input, now).reason).toBe("DELIVERY_CORRECTION");
    selected.observations.pop();
    input.shipping!.effectiveRef = "TEST-REPLACEMENT";
    input.shipping!.replacementDecisionRef = "TEST-APPROVED-REPLACEMENT";
    input.shipping!.shipments.push({ ...selected, shipmentRef: "TEST-REPLACEMENT", observations: [delivered] });
    expect(projectPostingClock(input, now)).toMatchObject({ state: "review", reason: "DELIVERY_ALREADY_RECORDED",
      previous: { clockKey: ready.clockKey } });
    input.previous = null;
    expect(projectPostingClock(input, now)).toMatchObject({ state: "ready", delivery: { shipmentRef: "TEST-REPLACEMENT" } });
  });

  it("honors fixed and verified-possession terms without making voluntary work due", () => {
    const input = source();
    if (input.terms.state !== "accepted") throw new Error("Fixture terms missing");
    input.shipping = null;
    input.terms.deliverables = [
      { deliverableId: "TEST-A", schedule: { basis: "possession", daysAfter: 2, graceDays: 1 } },
      { deliverableId: "TEST-B", schedule: { basis: "fixed", due: "2026-11-04", graceDays: 0 } },
      { deliverableId: "TEST-C", schedule: { basis: "voluntary", observationUntil: "2026-11-20" } },
    ];
    expect(projectPostingClock(input, now).deadlines[0]).toMatchObject({ state: "pending", reason: "POSSESSION_UNVERIFIED" });
    input.possession = { collaborationId: input.collaborationId, receiptRef: "TEST-POSSESSION", confirmedAt: actualDelivery };
    const ready = record(input);
    expect(ready.deadlines).toMatchObject([
      { state: "dated", basis: "possession", due: "2026-11-02", reviewAfter: "2026-11-03" },
      { state: "dated", basis: "fixed", due: "2026-11-04", reviewAfter: "2026-11-04" },
      { state: "voluntary", observationUntil: "2026-11-20" },
    ]);
    input.terms.deliverables[1]!.schedule = { basis: "fixed", due: "2026-11-05", graceDays: 0 };
    expect(projectPostingClock(input, now)).toMatchObject({ state: "review", reason: "TERMS_VERSION_REUSED" });
    input.terms.version = "TEST-TERMS-v2";
    expect(projectPostingClock(input, now)).toMatchObject({ state: "ready" });
  });
});
