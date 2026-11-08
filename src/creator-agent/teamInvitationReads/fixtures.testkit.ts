/**
 * Test-only injected source answers; the service never serves them by default. The invitation record is the existing labelled
 * synthetic recruitment fixture. The team record is a small synthetic one defined here, because the settings fixture imports a
 * component type that the node/e2e TypeScript project cannot resolve.
 */
import { invitationDemo } from "../../fixtures/recruitment.ts";
import type { TeamInvitationReadViewKey } from "./contract.ts";

export const teamInvitationTestScope = { workspaceId: "synthetic-team-workspace", accountId: "synthetic-team-account", environment: "sandbox" as const };
export const teamInvitationTestTime = "2026-11-06T12:00:00.000Z";

/** Synthetic team permissions record. Provider roles are "Not read", never a role; nothing here grants anything. */
export const syntheticTeamRecord = {
  matrix: [{ capability: "View safe dashboards", founder: "Yes", operator: "Yes", viewer: "Yes" },
    { capability: "Approve creator message", founder: "Yes", operator: "Assigned desk", viewer: "No" }],
  owners: [["Creator desk", "Assigned"], ["Support", "Needs assignment"]] as [string, string][],
  gaps: 1,
  steps: [{ n: "1", tone: "neutral", title: "Draft", note: "Synthetic step" }, { n: "2", tone: "violet", title: "Human approval", note: "Synthetic step" }],
  launch: [["Readiness test", "L - 7 days"]] as [string, string][],
  sourceRoles: [{ source: "Synthetic source", providerRole: "Not read" }],
};

export function teamInvitationRecord(viewKey: TeamInvitationReadViewKey): unknown {
  switch (viewKey) {
    case "teamPermissions": return structuredClone(syntheticTeamRecord);
    case "invitationDraft": return structuredClone(invitationDemo);
  }
}

export function teamInvitationSnapshot(viewKey: TeamInvitationReadViewKey, patch: Record<string, unknown> = {}) {
  return { scope: { ...teamInvitationTestScope }, viewKey, version: "synthetic-team-invitation-v1", observedAt: "2026-11-06T11:55:00.000Z",
    validUntil: "2026-11-06T12:10:00.000Z", coverage: { state: "complete", expectedCount: 1, observedCount: 1, reasonCodes: [] },
    record: teamInvitationRecord(viewKey), ...patch };
}
