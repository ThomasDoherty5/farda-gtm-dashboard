import { alertCatalog, type AlertObservation, type AlertRule } from "./contract.ts";

export type AlertEvaluation = {
  state: "breached" | "clear" | "incomplete";
  observed: number | null;
  reason: "missingSource" | "staleSource" | "sourceMismatch" | "unpricedBudget" | "missingMeasure" | null;
};
type Measure = { numerator: bigint; denominator: bigint; applicable: boolean };
const one = (value: number): Measure => ({ numerator: BigInt(value), denominator: 1n, applicable: true });
const notApplicable = (): Measure => ({ numerator: 0n, denominator: 1n, applicable: false });
const incomplete = (reason: NonNullable<AlertEvaluation["reason"]>): AlertEvaluation => ({ state: "incomplete", observed: null, reason });

function elapsed(asOf: number, start: string | null) {
  if (!start) return null;
  const milliseconds = asOf - Date.parse(start);
  return milliseconds < 0 ? null : { numerator: BigInt(milliseconds), denominator: 3_600_000n, applicable: true };
}

function measure(rule: AlertRule, observation: AlertObservation, asOf: number): Measure | null {
  switch (observation.family) {
    case "media":
      return observation.spent === null || observation.stageCap === null || !observation.capApprovalRef ? null
        : { numerator: BigInt(observation.spent) * 10_000n, denominator: BigInt(observation.stageCap), applicable: true };
    case "budget": {
      const { actual, committed, remainingForecast, disjointBasisRef, currency } = observation;
      if (actual === null || committed === null || remainingForecast === null || !disjointBasisRef ||
          currency !== rule.currency || observation.decimals !== rule.decimals) return null;
      return { numerator: BigInt(actual) + BigInt(committed) + BigInt(remainingForecast), denominator: 1n, applicable: true };
    }
    case "inventory": {
      const { onHand, activeReservations, sampleAvailable, waitingCollaborations, retainedUnitsPerDay } = observation;
      if (rule.kind === "sampleReserve") {
        if (waitingCollaborations === 0) return notApplicable();
        return waitingCollaborations === null || sampleAvailable === null ? null : one(sampleAvailable);
      }
      if (onHand === null || activeReservations === null) return null;
      const available = Math.max(0, onHand - activeReservations);
      if (rule.unit !== "hours") return one(available);
      return !retainedUnitsPerDay ? null : {
        numerator: BigInt(available) * 24n, denominator: BigInt(retainedUnitsPerDay), applicable: true,
      };
    }
    case "shipment":
      if (rule.kind === "shipmentException") return observation.deliveryException === null ? null : one(Number(observation.deliveryException));
      if (observation.tracking === "closed") return notApplicable();
      return observation.tracking === "unknown" ? null : elapsed(asOf, observation.lastTrackingAt);
    case "support":
      return observation.open === null ? null : observation.open ? elapsed(asOf, observation.openedAt) : notApplicable();
    case "review":
      return observation.stars === null ? null : one(observation.stars);
    case "orders":
      return observation.failedOrderCount === null ? null : one(observation.failedOrderCount);
  }
}

/** Compare the exact quantity before formatting or rounding. A missing source never clears an incident. */
export function evaluateThreshold(rule: AlertRule, observation: AlertObservation | undefined, observedAt: string): AlertEvaluation {
  if (!observation || observation.coverage !== "complete") return incomplete("missingSource");
  if (observation.family !== alertCatalog[rule.kind][0] || observation.sourceRef !== rule.sourceRef) return incomplete("sourceMismatch");
  const at = Date.parse(observedAt), asOf = Date.parse(observation.asOf);
  if (asOf > at || at - asOf > rule.maxAgeMs || asOf < Date.parse(rule.effectiveAt) ||
      (rule.endAt !== null && at >= Date.parse(rule.endAt))) return incomplete("staleSource");
  if (observation.family === "budget" && observation.unpricedCategories !== 0) return incomplete("unpricedBudget");
  const value = measure(rule, observation, at);
  if (!value) return incomplete("missingMeasure");
  if (!value.applicable) return { state: "clear", observed: null, reason: null };
  const threshold = BigInt(rule.threshold) * value.denominator;
  const breached = rule.comparison === "above" ? value.numerator > threshold
    : rule.comparison === "atOrAbove" ? value.numerator >= threshold : value.numerator <= threshold;
  const observed = Number(value.numerator) / Number(value.denominator);
  if (!Number.isFinite(observed) || observed > Number.MAX_SAFE_INTEGER) return incomplete("missingMeasure");
  return { state: breached ? "breached" : "clear", observed, reason: null };
}
