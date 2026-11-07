import type { OperationsScope } from "../operations.ts";
import type { SourcingSnapshot } from "./source.ts";

/** Fictional server-injected J19 plan only. No real creator, account, provider or receipt is represented. */
export const sourcingTestScope: OperationsScope = { workspaceId: "synthetic-sourcing-workspace", accountId: "synthetic-sourcing-account", environment: "sandbox" };
export const sourcingTestTime = Date.parse("2026-11-07T16:00:00Z");
export const sourcingTestSecret = "synthetic-sourcing-private-key-00000000000000000000";
const known = (value: number) => ({ value, missingReason: null });
const unknown = (missingReason: string) => ({ value: null, missingReason });

export function sourcingSourceFixture(scope: OperationsScope = sourcingTestScope, timestamp = sourcingTestTime): SourcingSnapshot {
  const at = (offsetMs: number) => new Date(timestamp + offsetMs).toISOString();
  const lease = { observedAt: at(-5 * 60_000), validUntil: at(55 * 60_000) };
  return {
    scope, version: "synthetic-plan-source-v1", observedAt: at(0), validUntil: at(60 * 60_000), coverage: "complete",
    planRef: "synthetic-daily-plan", icpVersion: "synthetic-icp-v1", policyVersion: "synthetic-commission-only-v1",
    sources: [
      { source: "social-cat", accountRef: "synthetic-social-cat-account", access: "verified", session: "open", accessObservedAt: at(-10 * 60_000) },
      { source: "tiktok-shop", accountRef: "synthetic-tiktok-shop-account", access: "verified", session: "open", accessObservedAt: at(-10 * 60_000) },
    ],
    schedule: { state: "active", cadence: "daily", timezone: "America/Los_Angeles", lastRunAt: at(-8 * 3600_000), nextRunAt: at(16 * 3600_000), scheduleRef: "synthetic-daily-schedule" },
    steps: [
      { step: "discovery", count: known(40), owner: "creator-agent", evidenceRefs: ["synthetic-discovery-receipt"], nextAction: "Resolve identities" },
      { step: "identityResolution", count: known(31), owner: "creator-agent", evidenceRefs: ["synthetic-identity-receipt"], nextAction: "Queue direct video review" },
      { step: "videoReview", count: known(12), owner: "reviewer", evidenceRefs: ["synthetic-review-receipt"], nextAction: "Review the remaining clips" },
      { step: "qualification", count: unknown("J20_REVIEW_INCOMPLETE"), owner: "reviewer", evidenceRefs: [], nextAction: "Finish direct video review first" },
      { step: "invitationPlanning", count: known(0), owner: "operator", evidenceRefs: ["synthetic-planning-receipt"], nextAction: "Wait for qualified creators" },
    ],
    capacity: [
      { source: "social-cat", kind: "invitations", unit: "invitations", currency: null, limit: known(50), used: known(20), remaining: known(30), resetAt: at(8 * 3600_000), ...lease, receipt: "synthetic-sc-quota-receipt" },
      { source: "tiktok-shop", kind: "invitations", unit: "invitations", currency: null, limit: unknown("SOURCE_LIMIT_NOT_PUBLISHED"), used: known(4), remaining: unknown("SOURCE_LIMIT_NOT_PUBLISHED"), resetAt: null, ...lease, receipt: "synthetic-tt-usage-receipt" },
      { source: "shared", kind: "sampleUnits", unit: "units", currency: null, limit: known(12), used: known(0), remaining: known(12), resetAt: null, ...lease, receipt: "synthetic-stock-approval" },
      { source: "shared", kind: "authorizedCost", unit: "minorUnits", currency: "USD", limit: known(30_000), used: known(0), remaining: known(30_000), resetAt: null, ...lease, receipt: "synthetic-cost-approval" },
    ],
    identity: { surfaced: known(40), mergedDuplicates: known(6), suppressedOptedOut: known(1), suppressedDeclinedRecently: known(2), suppressedExistingRelationship: unknown("RELATIONSHIP_LEDGER_NOT_READ"),
      alreadyInvited: known(0), selected: known(12), evidenceRefs: ["synthetic-identity-receipt"] },
    latestRun: { runRef: "synthetic-run-1", startedAt: at(-8 * 3600_000), states: {
      queued: known(0), running: known(0), quotaDeferred: known(1), loginRequired: known(0), permissionDenied: known(0), paused: known(0), confirmed: known(2), failed: known(0), uncertain: unknown("RECEIPT_NOT_RECONCILED"),
    }, attempts: known(5), distinctOpportunities: known(3), confirmedInvitations: known(2), receiptRefs: ["synthetic-invite-receipt-1", "synthetic-invite-receipt-2"] },
  };
}
