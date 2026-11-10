/**
 * Independently authored synthetic native source answers; the service never serves them by default. The invitation record is
 * synthetic test evidence. The team record is a small synthetic one defined here, because the settings fixture imports a
 * component type that the node/e2e TypeScript project cannot resolve.
 */
import type { TeamInvitationReadSourceReader } from "./source.ts";
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
  const metadata = { synthetic: true, provenance: { kind: "source", evidenceStage: "synthetic", observedAt: "2026-11-06T11:55:00.000Z", eventAt: null, sourceId: "synthetic-team-record", canonicalId: null, provenanceRef: "synthetic-team-evidence" } };
  switch (viewKey) {
    case "teamPermissions": return { ...structuredClone(syntheticTeamRecord), ...metadata, datasetKey: "team-permissions-native" };
    case "invitationDraft": return { ...metadata, datasetKey: "invitation-native", creators: [{ handle: "@synthetic.creator", suppression: "clear", identity: "resolved" }], products: [{ name: "Synthetic product", listing: "unverified" }],
      program: { maxCommissionPct: 10, maxValidityDays: 30, label: "Synthetic program" }, priorScore: { model: "Synthetic historical model", value: 70 }, quota: { state: "unknown", reasonCode: "QUOTA_NOT_READ" },
      plannedSamples: 1, draftVersion: "synthetic-draft-v1", automateInvitations: "off", sampleRequest: { id: "synthetic-sample", handle: "@synthetic.creator", nativeDeadline: "Not observed", lastRead: "Not observed" } };
  }
}

export function teamInvitationSnapshot(viewKey: TeamInvitationReadViewKey, patch: Record<string, unknown> = {}) {
  return { scope: { ...teamInvitationTestScope }, viewKey, version: "synthetic-team-invitation-v1", principalRef: "agent-reader", permissionVersion: "synthetic-permission-v1", observedAt: "2026-11-06T11:55:00.000Z",
    validUntil: "2026-11-06T12:10:00.000Z", coverage: { state: "complete", expectedCount: 1, observedCount: 1, reasonCodes: [] },
    record: teamInvitationRecord(viewKey), ...patch };
}

export function teamInvitationTestSource(read: TeamInvitationReadSourceReader["read"]): TeamInvitationReadSourceReader {
  return { async read(scope, request, options) {
    const answer = await read(scope, request, options);
    return answer && typeof answer === "object" ? { ...answer, principalRef: options.principal.principalRef } : answer;
  }, assertCurrent(snapshot, binding) {
    if (snapshot.principalRef !== binding.principal.principalRef || snapshot.permissionVersion !== "synthetic-permission-v1" ||
      JSON.stringify(snapshot.scope) !== JSON.stringify(binding.scope) || snapshot.viewKey !== binding.request.viewKey) throw new Error("Synthetic binding mismatch");
  } };
}
