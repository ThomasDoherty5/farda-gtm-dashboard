import type { NativeAnalyticsSnapshot } from "./contract.ts";
/** Fictional existing sample-owner packet, with no write/dispatch capability. */
export function addReservationFixture(snapshot: NativeAnalyticsSnapshot) {
  if (snapshot.viewKey !== "campaignFunnel" || !snapshot.period) return;
  const proofRef = snapshot.owners.find(owner => owner.owner === "sampleCapacity")!.proofRef;
  snapshot.facts.reservations = { proofRef, campaignRef: snapshot.facts.campaignRef, cohortRef: snapshot.facts.cohortRef,
    period: snapshot.period, coverage: "complete", total: 1, rows: [{
      reservationRef: "fictional-reservation-1", home: "H1", itemRef: "fictional-sample-item", itemLabel: "Fictional sample bottle", units: 2, state: "active",
      cost: { value: { minorUnits: 3000, currency: "USD" }, reason: null, proofRef, evidenceRefs: ["fictional-sample-cost"] },
      approval: { state: "approved", evidenceRef: "fictional-sample-approval", version: "fictional-approval-v1" },
      sourceVersion: "fictional-reservation-v1", evidenceRef: "fictional-reservation-proof", observedAt: snapshot.observedAt,
    }],
  };
}
