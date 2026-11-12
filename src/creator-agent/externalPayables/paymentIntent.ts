import { digest } from "../config.ts";
import type { LookupResult, PaymentAttempt, PaymentIntent } from "./contract.ts";

/** Everything founder approval binds: payee identity, currency, amount, obligation component, route and their versions. */
export function intentMaterial(intent: PaymentIntent) {
  return { intentRef: intent.intentRef, version: intent.version, liabilityRef: intent.liabilityRef, liabilityVersion: intent.liabilityVersion,
    payee: intent.payee, amount: intent.amount, componentKey: intent.componentKey, termsVersion: intent.termsVersion, route: intent.route,
    policyVersion: intent.policyVersion, providerKey: intent.providerKey };
}
export const intentPayloadHash = (intent: PaymentIntent) => digest({ kind: "external-payable-payment.v1", material: intentMaterial(intent) });
export const payeeTarget = (intent: Pick<PaymentIntent, "payee">) => `payee:${digest(intent.payee.ref)}`;

export type Resolution = "found" | "notApplied" | "pending";
/**
 * Deadline-bound uncertainty. A submission that timed out or lost its acknowledgement may still land until its deadline, so an empty lookup
 * proves nothing until the deadline plus the settle margin has passed, both on our clock and on the provider's observation.
 */
export function resolveUncertainty(attempt: Pick<PaymentAttempt, "deadlineAt">, lookup: LookupResult, now: number, settleMarginMs: number): Resolution {
  if (lookup.state === "found") return "found";
  if (lookup.state === "unknown") return "pending";
  const settled = Date.parse(attempt.deadlineAt) + settleMarginMs;
  return now >= settled && Date.parse(lookup.observedAt) >= settled ? "notApplied" : "pending";
}
