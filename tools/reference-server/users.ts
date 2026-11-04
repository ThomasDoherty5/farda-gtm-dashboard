/**
 * The fixed, fake users of the reference server: one per role in D-3 of docs/adapter-decisions.md.
 * Obviously fake, local only, and nothing in this file is a secret. There is no password: the dev sign-in names a user.
 */
export const ROLES = ["founder", "operator", "reviewer", "finance", "viewer", "runner"] as const;
export type Role = (typeof ROLES)[number];

export type Grant = { workspaceId: string; accountIds: string[] };
export type RefUser = { id: string; displayName: string; role: Role; grants: Grant[] };

export const DEFAULT_WORKSPACE = "demo-workspace";
export const DEFAULT_ACCOUNT = "demo-account-farda";

export const defaultUsers = (): RefUser[] =>
  ROLES.map((role) => ({
    id: `ref-${role}`,
    displayName: `Reference ${role[0]!.toUpperCase()}${role.slice(1)}`,
    role,
    grants: [{ workspaceId: DEFAULT_WORKSPACE, accountIds: [DEFAULT_ACCOUNT] }],
  }));

/** The `runner` role is the non-human job service. It may only touch runs and dispatch what a person already approved. */
export const WRITE_ROLES: readonly Role[] = ["founder", "operator", "reviewer", "finance"];
export const DECIDE_ROLES: readonly Role[] = ["founder", "reviewer"];
export const DISPATCH_ROLES: readonly Role[] = ["founder", "reviewer", "runner"];
export const RUN_OPERATIONS = ["dispatchApprovedAction", "reconcileRun", "controlRun"] as const;

/**
 * Action kinds only a founder may send (D-5): the acquisition policy, a historical fixed-fee liability, the launch Go
 * decision, enabling production for a source account, and a payment. A hidden button is never authorization, so the
 * server checks them whatever the screen shows.
 */
export const FOUNDER_ONLY_ACTION_KINDS: readonly string[] = [
  "changeAcquisitionPolicy",
  "settleHistoricalFee",
  "recordLaunchDecision",
  "enableProduction",
  "activateOffer",
  "executePayment",
];

/** Approvals that were requested by a person, for the requester-differs-from-approver rule (D-5). */
export const SEEDED_REQUESTERS: Record<string, string> = { "demo-approval-exact": "ref-reviewer" };
