import type { OperationsScope } from "../operations.ts";
import { flowKeys, type FlowCatalog } from "./contract.ts";
import type { LifecycleSnapshot } from "./source.ts";

/** Fictional server-injected evidence only. No real provider or recipient is contacted. */
export const lifecycleTestScope: OperationsScope = { workspaceId: "synthetic-lifecycle-workspace", accountId: "synthetic-lifecycle-account", environment: "sandbox" };
export const lifecycleTestTime = Date.parse("2026-11-07T03:00:00Z");
export const lifecycleTestSecret = "synthetic-lifecycle-private-key-000000000000000000";
const known = (value: number) => ({ value, missingReason: null });
export function lifecycleSourceFixture(scope: OperationsScope = lifecycleTestScope, timestamp = lifecycleTestTime): LifecycleSnapshot {
  const at = new Date(timestamp).toISOString(), until = new Date(timestamp + 3600_000).toISOString();
  const cohort = { ref: "synthetic-cohort", start: new Date(timestamp - 14 * 86400_000).toISOString(), end: at,
    timezone: "America/Los_Angeles", definition: "Synthetic matched 14-day source cohort", unit: "people" as const, receipt: "synthetic-cohort-receipt" };
  const flows = flowKeys.map((flow): FlowCatalog => {
    const purpose = flow === "setup" ? "transactional-support" : flow === "review-request" ? "review" : "marketing";
    const trigger = { setup: "setup-help-eligible", "early-access": "confirmed-subscription", "abandoned-checkout": "eligible-abandoned-checkout", "review-request": "confirmed-delivery" } as const;
    const entry = "synthetic-entry-" + flow, timing = "synthetic-timing-" + flow, template = "synthetic-template-" + flow;
    const basis = { catalogVersion: "synthetic-catalog-v1", policyVersion: "synthetic-policy-v1", entryEventRef: entry, timingRuleRef: timing, templateRef: template, templateVersion: "synthetic-template-v1" };
    return { flow, flowRef: "synthetic-flow-" + flow, catalogVersion: basis.catalogVersion, policyVersion: basis.policyVersion,
      purpose, draftAllowed: flow !== "setup", entryEvents: [{ ref: entry, version: "synthetic-event-v1", label: trigger[flow], purpose, trigger: trigger[flow] }],
      timingRules: [{ ref: timing, version: "synthetic-timing-v1", label: flow === "early-access" ? "Welcome on confirmed opt-in; launch notice held" : flow === "abandoned-checkout" ? "Proposed four-hour checkout delay" : flow === "review-request" ? "Fourteen days after confirmed delivery" : "Source-qualified setup assistance",
        entryEventRef: entry, timezone: "America/Los_Angeles", delayMinutes: flow === "abandoned-checkout" ? 240 : flow === "review-request" ? 20160 : null,
        launchAt: null, approval: "proposed", approvalRef: null }],
      templates: [{ ref: template, version: basis.templateVersion, label: "Synthetic " + flow + " template", claimPolicyVersion: "synthetic-claims-v1", allowedVariables: ["unsubscribe_link"],
        approval: "proposed", approvalRef: null, preview: { kind: "synthetic", subject: "Synthetic flow preview", lines: ["This is generic preview text without a recipient.", "Unsubscribe: {{unsubscribe_link}}"] } }],
      eligibilityRules: ["Source confirms the exact purpose and event.", "Unknown consent remains ineligible."],
      cancellationRules: ["Stop on withdrawal or suppression.", flow === "abandoned-checkout" ? "Stop on completed purchase." : flow === "review-request" ? "Hold unresolved return or support issues." : "Do not replay completed enrollment."],
      evidence: [{ kind: "suppression", state: "passed", receipt: "synthetic-suppression-test-" + flow, observedAt: at, validUntil: until, basis, missingReason: null }],
      outcomes: { cohort: { ...cohort, ref: "synthetic-outcome-" + flow }, rows: [{ state: "queued", count: known(2), receipt: "synthetic-queued-" + flow, reasonCode: null },
        { state: "suppressed", count: known(1), receipt: "synthetic-withdrawn-" + flow, reasonCode: "CONSENT_WITHDRAWN_AFTER_QUEUE" }] }, recoveryOwner: "synthetic-email-owner" };
  });
  return { scope, version: "synthetic-source-v1", observedAt: at, validUntil: until, coverage: "complete", flows,
    consent: { cohort, purpose: "marketing", categoryDefinitionVersion: "synthetic-exclusive-v1", total: known(100), eligible: known(70), withdrawn: known(10), suppressed: known(15), unknown: known(5),
      exclusions: [{ reason: "Source permission unknown", recovery: "Owner verifies the source; dashboard cannot grant consent." }] },
    activation: { cohort: { ...cohort, ref: "synthetic-device-cohort", unit: "devices" }, delivered: known(100), paired: known(86), weekOne: known(64), pairingFailureEvents: known(6),
      weekOneDefinition: "first-seven-days-after-delivery", privacyApproval: { state: "approved", receipt: "synthetic-privacy-proof" }, laterRetention: [30, 60, 90].map(day => ({ day, state: "proposed" as const })) },
    returnsAwaitingInspection: known(0) };
}
